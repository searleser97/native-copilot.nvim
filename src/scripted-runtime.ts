import { randomUUID } from "node:crypto";
import type {
  AgentDatabase,
  PrimaryStartupClaim,
  StoredAgentRun,
} from "./database.js";
import type { AgentUpdate, RuntimeAdapter } from "./runtime-adapter.js";
import type { SpawnAgentsRequest } from "./types.js";

interface RuntimeEmitter {
  (
    type: string,
    payload?: unknown,
    fields?: {
      requestId?: string;
      runId?: string;
      memberId?: string;
      target?: string;
      sequence?: number;
      done?: boolean;
    },
  ): void;
}

interface PendingPermission {
  target: string;
  agentId: string;
  generation: number;
}

interface ScriptedTransition {
  generation: number;
  reason: string;
}

/** One scripted standalone agent, mirroring the runtime's durable agent identity. */
interface ScriptedAgent {
  agentId: string;
  target: string;
  alias: string;
  displayName: string;
  description: string;
  task: string;
  recipients: string[];
  observes: string[];
  runId: string;
  sessionId: string;
  primary?: boolean;
  primaryClaim?: PrimaryStartupClaim;
}

const PRIMARY_AGENT_ID = "e2e0aaaa-0000-4000-8000-00000000e2e0";
const PRIMARY_TARGET = `agent:${PRIMARY_AGENT_ID}`;
// A single deterministic recoverable agent so the UI end-to-end suite can exercise
// per-agent recovery without a live Copilot runtime.
const RECOVERABLE_AGENT_ID = "e2e0aaaa-0000-4000-8000-00000000e2e1";
const RECOVERABLE_AGENT_RUN_ID = "e2e-recoverable-agent-run";

const observationMode = process.env.NATIVE_COPILOT_E2E_OBSERVE === "1";
const delayMultiplier = observationMode ? 8 : 1;
const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds * delayMultiplier));
const observationPause = (milliseconds = 350): Promise<void> =>
  observationMode ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();

export class ScriptedRuntime implements RuntimeAdapter {
  private primaryRunId: string | undefined;
  private primaryAgentId: string | undefined;
  private resumedCliSession = false;
  private sessionListCount = 0;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly agents = new Map<string, ScriptedAgent>();
  private readonly generations = new Map<string, number>();
  private readonly transitions = new Map<string, ScriptedTransition>();
  private recoveredAgentRun = false;
  private stopped = false;

  constructor(
    private readonly workspace: string,
    private readonly db: AgentDatabase,
    private readonly emit: RuntimeEmitter,
    private readonly profile: string,
  ) {}

  private storedAgentJson(agent: ScriptedAgent): string {
    return JSON.stringify({
      definition: {
        id: agent.alias,
        displayName: agent.displayName,
        description: agent.description,
        task: agent.task,
        prompt: `Scripted operating instructions for ${agent.alias}.`,
        canTalkTo: agent.recipients.map((agentId) => `agent:${agentId}`),
        canObserve: agent.observes.map((agentId) => `agent:${agentId}`),
      },
      mcpServers: [],
      canTalkToAgentIds: agent.recipients,
      canObserveAgentIds: agent.observes,
    });
  }

  private primaryAgent(): ScriptedAgent {
    const primary =
      this.primaryAgentId === undefined
        ? undefined
        : this.agents.get(this.primaryAgentId);
    if (!primary) {
      throw new Error("The scripted primary agent is not running.");
    }
    return primary;
  }

  private primaryDefinitionForClaim(
    stagedDefinition: string | undefined,
    alias: string,
  ): string {
    if (stagedDefinition === undefined) {
      return this.storedAgentJson({
        agentId: PRIMARY_AGENT_ID,
        target: PRIMARY_TARGET,
        alias,
        displayName: "Copilot",
        description: "Primary user-facing Copilot agent",
        task: "Assist the user in the primary Neovim conversation.",
        recipients: [],
        observes: [],
        runId: "pending-primary-claim",
        sessionId: "e2e-primary-session",
        primary: true,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stagedDefinition);
    } catch (error) {
      throw new Error("The staged scripted primary definition is invalid JSON.", {
        cause: error,
      });
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof (parsed as Record<string, unknown>).definition !== "object" ||
      (parsed as Record<string, unknown>).definition === null ||
      Array.isArray((parsed as Record<string, unknown>).definition)
    ) {
      throw new Error("The staged scripted primary definition is invalid.");
    }
    const record = { ...(parsed as Record<string, unknown>) };
    const definition = record.definition as Record<string, unknown>;
    const canTalkToAgentIds = record.canTalkToAgentIds ?? [];
    const canObserveAgentIds = record.canObserveAgentIds ?? [];
    if (
      typeof definition.displayName !== "string" ||
      typeof definition.description !== "string" ||
      typeof definition.task !== "string" ||
      !Array.isArray(canTalkToAgentIds) ||
      canTalkToAgentIds.some((agentId) => typeof agentId !== "string") ||
      !Array.isArray(canObserveAgentIds) ||
      canObserveAgentIds.some((agentId) => typeof agentId !== "string")
    ) {
      throw new Error("The staged scripted primary definition is incomplete.");
    }
    record.definition = {
      ...definition,
      id: alias,
    };
    record.canTalkToAgentIds = canTalkToAgentIds;
    record.canObserveAgentIds = canObserveAgentIds;
    return JSON.stringify(record);
  }

  private primaryFromClaim(
    run: StoredAgentRun,
    claim: PrimaryStartupClaim | undefined,
  ): ScriptedAgent {
    if (!run.definition) {
      throw new Error(`Claimed scripted primary run "${run.id}" has no definition.`);
    }
    const parsed = JSON.parse(run.definition) as {
      definition?: Record<string, unknown>;
      canTalkToAgentIds?: unknown;
      canObserveAgentIds?: unknown;
    };
    const definition = parsed.definition;
    if (
      !definition ||
      typeof definition.displayName !== "string" ||
      typeof definition.description !== "string" ||
      typeof definition.task !== "string" ||
      !Array.isArray(parsed.canTalkToAgentIds) ||
      parsed.canTalkToAgentIds.some((agentId) => typeof agentId !== "string") ||
      !Array.isArray(parsed.canObserveAgentIds) ||
      parsed.canObserveAgentIds.some((agentId) => typeof agentId !== "string")
    ) {
      throw new Error(`Claimed scripted primary run "${run.id}" has an invalid definition.`);
    }
    return {
      agentId: run.agentId,
      target: `agent:${run.agentId}`,
      alias: run.alias,
      displayName: definition.displayName as string,
      description: definition.description as string,
      task: definition.task as string,
      recipients: [...parsed.canTalkToAgentIds] as string[],
      observes: [...parsed.canObserveAgentIds] as string[],
      runId: run.id,
      sessionId: "e2e-primary-session",
      primary: true,
      ...(claim ? { primaryClaim: claim } : {}),
    };
  }

  private beginTransition(agent: ScriptedAgent, reason: string): ScriptedTransition {
    const existing = this.transitions.get(agent.agentId);
    if (existing) {
      throw new Error(
        `Agent "${agent.alias}" is temporarily unavailable while ${existing.reason}.`,
      );
    }
    const transition = {
      generation: (this.generations.get(agent.agentId) ?? 0) + 1,
      reason,
    };
    this.generations.set(agent.agentId, transition.generation);
    this.transitions.set(agent.agentId, transition);
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.agentId === agent.agentId) {
        this.pendingPermissions.delete(requestId);
      }
    }
    return transition;
  }

  private endTransition(agent: ScriptedAgent, transition: ScriptedTransition): void {
    if (this.transitions.get(agent.agentId) === transition) {
      this.transitions.delete(agent.agentId);
    }
  }

  private requireAvailableAgent(agentRef: string): ScriptedAgent {
    const agent = this.requireAgent(agentRef);
    const transition = this.transitions.get(agent.agentId);
    if (transition) {
      throw new Error(
        `Agent "${agent.alias}" is temporarily unavailable while ${transition.reason}. ` +
          "Retry after the transition completes.",
      );
    }
    return agent;
  }

  private fields(target: string, done = false) {
    return { memberId: target, target: "conversation", done };
  }

  private emitBusy(target: string, turnId: string): void {
    this.emit("member.state", { state: "busy", turnId }, {
      memberId: target,
      target: "status",
      done: false,
    });
  }

  private emitIdle(target: string): void {
    this.emit("member.foreground_idle", {}, {
      memberId: target,
      target: "status",
      done: true,
    });
  }

  private emitMessage(target: string, messageId: string, content: string): void {
    this.emit("conversation.message", { messageId, content }, this.fields(target, true));
  }

  private async taskDeferral(target: string): Promise<void> {
    const messageId = "e2e-task-deferral-message";
    this.emitBusy(target, "e2e-task-deferral-turn");
    this.emit("activity.event", {
      eventType: "tool.execution_start",
      data: {
        toolCallId: "e2e-async-shell",
        toolName: "powershell",
        shellToolInfo: {
          possiblePaths: [],
          hasWriteFileRedirection: false,
        },
        arguments: {
          command: "Write-Output 'workspace valid'",
          description: "Validate workspace in background",
          mode: "async",
        },
      },
    }, this.fields(target));
    await observationPause();
    this.emit("activity.event", {
      eventType: "tool.execution_complete",
      data: {
        toolCallId: "e2e-async-shell",
        success: true,
        result: { shellId: "e2e-task" },
      },
    }, this.fields(target, true));
    for (const [toolCallId, toolName, path] of [
      ["e2e-create", "create", "src/generated.ts"],
      ["e2e-edit", "edit", "src/existing.ts"],
    ] as const) {
      this.emit("activity.event", {
        eventType: "tool.execution_start",
        data: {
          toolCallId,
          toolName,
          arguments: { path },
        },
      }, this.fields(target));
      this.emit("activity.event", {
        eventType: "tool.execution_complete",
        data: {
          toolCallId,
          success: true,
          result: { path },
        },
      }, this.fields(target, true));
    }
    this.emit("tasks.changed", {
      tasks: [{
        id: "e2e-task",
        type: "shell",
        status: "running",
        description: "Validate workspace in background",
        startedAt: new Date().toISOString(),
        command: "Write-Output 'workspace valid'",
        attachmentMode: "attached",
        executionMode: "background",
        canPromoteToBackground: false,
      }],
    }, { memberId: target, target: "status", done: true });
    this.emit("conversation.delta", {
      messageId,
      content:
        "I started the workspace validation in the background. While it runs, " +
        "I'll explain how the foreground response remains uninterrupted",
    }, this.fields(target));
    await delay(30);
    this.emit("tasks.changed", {
      tasks: [{
        id: "e2e-task",
        type: "shell",
        status: "completed",
        description: "Validate workspace in background",
        result: "workspace validation passed",
      }],
    }, { memberId: target, target: "status", done: true });
    await delay(30);
    this.emit("conversation.delta", {
      messageId,
      content:
        ". Once the response is complete, the background result can appear " +
        "without splitting this message.",
    }, this.fields(target));
    this.emitMessage(
      target,
      messageId,
      "I started the workspace validation in the background. While it runs, " +
        "I'll explain how the foreground response remains uninterrupted. " +
        "Once the response is complete, the background result can appear " +
        "without splitting this message.",
    );
    this.emitIdle(target);
  }

  private async toolAuthorship(target: string): Promise<void> {
    await observationPause();
    this.emit("activity.event", {
      eventType: "tool.execution_start",
      data: {
        toolCallId: "e2e-read",
        toolName: "powershell",
        shellToolInfo: {
          possiblePaths: ["validation-result.txt"],
          hasWriteFileRedirection: false,
        },
        arguments: {
          command: "Get-Content validation-result.txt",
          description:
            "Read completed validation output and summarize only the final status without " +
            "including the verbose command transcript or unrelated diagnostic details",
        },
      },
    }, this.fields(target));
    this.emit("activity.event", {
      eventType: "tool.execution_complete",
      data: {
        toolCallId: "e2e-read",
        success: true,
        result: {
          output: "workspace valid",
          exitCode: 0,
          shellId: "e2e-sync-shell",
        },
      },
    }, this.fields(target, true));
    this.emit("tasks.changed", {
      tasks: [{
        id: "e2e-sync-shell",
        type: "shell",
        status: "running",
        description:
          "Read completed validation output and summarize only the final status",
        command: "Get-Content validation-result.txt",
        executionMode: "sync",
        attachmentMode: "attached",
        canPromoteToBackground: true,
      }],
    }, { memberId: target, target: "status", done: true });
    await observationPause();
    this.emitBusy(target, "e2e-tool-authorship-turn");
    await observationPause();
    this.emitMessage(
      target,
      "e2e-tool-authorship-message",
      "The background validation completed successfully with exit code 0.",
    );
    this.emitIdle(target);
  }

  private async reasoningFolds(target: string): Promise<void> {
    this.emitBusy(target, "e2e-reasoning-turn");
    this.emit("activity.event", {
      eventType: "tool.execution_start",
      data: {
        toolCallId: "e2e-reasoning-background",
        toolName: "powershell",
        shellToolInfo: {
          possiblePaths: [],
          hasWriteFileRedirection: false,
        },
        arguments: {
          command: "Write-Output 'metadata refreshed'",
          description: "Refresh validation metadata",
          mode: "sync",
        },
      },
    }, this.fields(target));
    this.emit("activity.event", {
      eventType: "tool.execution_complete",
      data: {
        toolCallId: "e2e-reasoning-background",
        success: true,
        result: { shellId: "e2e-reasoning-task" },
      },
    }, this.fields(target, true));
    this.emit("tasks.changed", {
      tasks: [{
        id: "e2e-reasoning-task",
        type: "shell",
        status: "running",
        description: "Refresh validation metadata",
        startedAt: new Date().toISOString(),
        command: "Write-Output 'metadata refreshed'",
        attachmentMode: "attached",
        executionMode: "sync",
        canPromoteToBackground: true,
      }],
    }, { memberId: target, target: "status", done: true });
    await observationPause();
    this.emit("tasks.changed", {
      tasks: [{
        id: "e2e-reasoning-task",
        type: "shell",
        status: "running",
        description: "Refresh validation metadata",
        startedAt: new Date().toISOString(),
        command: "Write-Output 'metadata refreshed'",
        attachmentMode: "attached",
        executionMode: "background",
        canPromoteToBackground: false,
      }],
    }, { memberId: target, target: "status", done: true });
    await observationPause();
    this.emit("activity.delta", {
      reasoningId: "e2e-reasoning-one",
      content:
        "The completion event arrived while the foreground response was still active.\n" +
        "I should keep the response contiguous and queue the background update.",
    }, this.fields(target));
    await delay(120);
    this.emit("activity.reasoning", {
      reasoningId: "e2e-reasoning-one",
      content:
        "The completion event arrived while the foreground response was still active.\n" +
        "I should keep the response contiguous and queue the background update.",
    }, this.fields(target, true));
    this.emit("activity.delta", {
      reasoningId: "e2e-reasoning-two",
      content:
        "Next, I need to inspect the completed command before composing the final answer.\n" +
        "The tool result confirms that the workspace validation succeeded.\n\n" +
        "I should preserve this second paragraph inside the same reasoning fold.\n\n" +
        "Closing the fold from this third paragraph must collapse the complete reasoning block.",
    }, this.fields(target));
    await delay(40);
    this.emit("activity.event", {
      eventType: "tool.execution_start",
      data: {
        toolCallId: "e2e-reasoning-tool",
        toolName: "read_powershell",
        arguments: { shellId: "e2e-task" },
      },
    }, this.fields(target));
    this.emit("activity.event", {
      eventType: "tool.execution_complete",
      data: {
        toolCallId: "e2e-reasoning-tool",
        success: true,
        result: {
          output: "workspace valid",
          exitCode: 0,
          shellId: "e2e-reasoning-task",
        },
      },
    }, this.fields(target, true));
    this.emit("tasks.changed", {
      tasks: [{
        id: "e2e-reasoning-task",
        type: "shell",
        status: "completed",
        description: "Refresh validation metadata",
        result: "metadata refresh completed",
      }],
    }, { memberId: target, target: "status", done: true });
    await delay(40);
    this.emit("activity.reasoning", {
      reasoningId: "e2e-reasoning-two",
      content:
        "Next, I need to inspect the completed command before composing the final answer.\n" +
        "The tool result confirms that the workspace validation succeeded.\n\n" +
        "I should preserve this second paragraph inside the same reasoning fold.\n\n" +
        "Closing the fold from this third paragraph must collapse the complete reasoning block.",
    }, this.fields(target, true));
    this.emitMessage(
      target,
      "e2e-reasoning-message",
      "The event order is correct: reasoning stays together, the tool remains visible, " +
        "and the background update follows the final answer.",
    );
    this.emitIdle(target);
  }

  private permission(target: string): void {
    const agent = this.requireAvailableAgent(target);
    const requestId = "e2e-permission-request";
    this.pendingPermissions.set(requestId, {
      target,
      agentId: agent.agentId,
      generation: this.generations.get(agent.agentId) ?? 0,
    });
    this.emitBusy(target, "e2e-permission-turn");
    this.emit("permission.requested", {
      requestId,
      request: {
        kind: "shell",
        fullCommandText: "Write-Output 'observation approved'",
        managedApprovalRequired: false,
      },
    }, { memberId: target, target: "status", done: false });
  }

  private async loadEnvironment(target: string): Promise<void> {
    this.emit("environment.progress", {
      component: "Copilot environment",
      message: "Starting scripted runtime",
    }, { memberId: target, target: "status" });
    await observationPause(250);
    for (const [component, count] of [
      ["Tools", 4],
      ["Instructions", 1],
      ["Skills", 0],
      ["Plugins", 0],
      ["Agents", 0],
    ] as const) {
      this.emit("environment.loaded", {
        component,
        items: Array.from({ length: count }, (_, index) => ({ name: `${component}-${index}` })),
      }, { memberId: target, target: "status", done: true });
      await observationPause(250);
    }
    const mcpItems = this.profile === "allow-all"
      ? []
      : this.profile === "allow-all-mcp"
        ? [
            { name: "mock-files", status: "connected" },
            { name: "mock-broken", status: "failed" },
          ]
        : [{ name: "mock-permissions", status: "connected" }];
    this.emit("environment.loaded", {
      component: "MCP servers",
      items: mcpItems,
    }, { memberId: target, target: "status", done: true });
    await observationPause(250);
    this.emit("system.notification", {
      eventId: `e2e-live-instruction-${randomUUID()}`,
      eventTimestamp: Date.now(),
      kind: {
        type: "instruction_discovered",
        description: "Live repository instructions",
        sourcePath: ".github/copilot-instructions.md",
        triggerFile: "src/main.ts",
        triggerTool: "view",
      },
    }, { memberId: target, target: "activity", done: true });
    this.emit("environment.status", {
      component: "Copilot environment",
      status: "ready",
    }, { memberId: target, target: "status", done: true });
  }

  async openPrimary(): Promise<void> {
    if (this.primaryRunId) {
      this.requireAvailableAgent(this.primaryAgentId ?? PRIMARY_AGENT_ID);
      return;
    }
    const claimed = this.db.claimPrimaryRun(
      randomUUID(),
      PRIMARY_AGENT_ID,
      this.workspace,
      process.pid,
      (stagedDefinition, alias) =>
        this.primaryDefinitionForClaim(stagedDefinition, alias),
    );
    const primary = this.primaryFromClaim(claimed.run, claimed.claim);
    this.primaryRunId = primary.runId;
    this.primaryAgentId = primary.agentId;
    this.agents.set(primary.agentId, primary);
    const transition = this.beginTransition(primary, "starting its scripted session");
    try {
      this.db.upsertSession(primary.runId, primary.sessionId, "connected");
      const target = primary.target;
      this.emit("agent.loading", { ...this.agentPayload(primary), recovered: false }, {
        runId: primary.runId,
        memberId: target,
        target: "status",
        done: false,
      });
      this.emit("session.identity", {
        sessionId: primary.sessionId,
      }, { runId: primary.runId, memberId: target, target: "activity", done: true });
      await this.loadEnvironment(target);
      this.emit("member.state", { state: "idle" }, {
        memberId: target,
        target: "status",
        done: true,
      });
      this.db.completePrimaryStartup(
        primary.runId,
        this.workspace,
        primary.agentId,
        primary.target,
        primary.primaryClaim,
      );
      delete primary.primaryClaim;
      this.emit("agent.ready", {
        ...this.agentPayload(primary),
        recovered: false,
        sessionId: primary.sessionId,
      }, {
        runId: primary.runId,
        memberId: target,
        target: "status",
        done: true,
      });
      this.emit("primary.ready", {
        ...this.agentPayload(primary),
        mode: "primary",
        recovered: false,
        sessionId: primary.sessionId,
        runId: primary.runId,
      }, { runId: primary.runId, memberId: target, target: "status", done: true });
    } catch (error) {
      this.agents.delete(primary.agentId);
      this.primaryRunId = undefined;
      this.primaryAgentId = undefined;
      this.db.finishRun(primary.runId, "interrupted", "Scripted primary startup failed");
      throw error;
    } finally {
      this.endTransition(primary, transition);
    }
  }

  async sendUserPrompt(target: string, content: string): Promise<string> {
    this.requireAvailableAgent(target);
    const id = randomUUID();
    if (content.includes("Start a foreground turn that waits for steering")) {
      this.emitBusy(target, `turn-${id}`);
      this.emit("conversation.delta", {
        messageId: "e2e-steerable-message",
        content: "The foreground turn is waiting for steering.",
      }, this.fields(target));
    } else if (content.includes("Run a background workspace validation")) {
      void this.taskDeferral(target);
    } else if (content.includes("Read the completed validation output")) {
      void this.toolAuthorship(target);
    } else if (content.includes("Investigate the event-ordering issue")) {
      void this.reasoningFolds(target);
    } else if (content.includes("Run a harmless PowerShell command")) {
      this.permission(target);
    } else if (content.includes("Delay the assistant turn start")) {
      void delay(150).then(() => {
        this.emitBusy(target, `turn-${id}`);
        this.emitMessage(target, `message-${id}`, "The delayed assistant turn started normally.");
        this.emitIdle(target);
      });
    } else {
      this.emitBusy(target, `turn-${id}`);
      this.emitMessage(target, `message-${id}`, `SCRIPTED-REPLY: ${content}`);
      this.emitIdle(target);
    }
    return id;
  }

  respondPermission(requestId: string, approved: boolean): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    this.pendingPermissions.delete(requestId);
    if (
      this.generations.get(pending.agentId) !== pending.generation ||
      this.transitions.has(pending.agentId)
    ) {
      return false;
    }
    void delay(20).then(() => {
      if (
        this.generations.get(pending.agentId) !== pending.generation ||
        this.transitions.has(pending.agentId)
      ) {
        return;
      }
      this.emitMessage(
        pending.target,
        "e2e-permission-message",
        approved
          ? "The approved PowerShell command completed successfully."
          : "The PowerShell command was not approved.",
      );
      this.emitIdle(pending.target);
    });
    return true;
  }

  status(): unknown {
    const primary =
      this.primaryAgentId === undefined
        ? undefined
        : this.agents.get(this.primaryAgentId);
    return {
      scripted: true,
      profile: this.profile,
      primaryAgentId: primary?.agentId,
      primaryTarget: primary?.target,
      primary: primary
        ? {
            ...this.agentPayload(primary),
            sessionId: primary.sessionId,
            state: this.transitions.has(primary.agentId) ? "loading" : "idle",
          }
        : undefined,
      agents: [...this.agents.values()].map((agent) => ({
        ...this.agentPayload(agent),
        sessionId: agent.sessionId,
        state: this.transitions.has(agent.agentId) ? "loading" : "idle",
      })),
      sessions: [...this.agents.values()].map((agent) => ({
        target: agent.target,
        agentId: agent.agentId,
        alias: agent.alias,
        sessionId: agent.sessionId,
        state: this.transitions.has(agent.agentId) ? "loading" : "idle",
      })).filter((session) => session.state !== "loading"),
    };
  }

  recoverableAgentRuns(): Array<Record<string, unknown>> {
    if (this.profile !== "telescope" || this.recoveredAgentRun) {
      return [];
    }
    return [{
      id: RECOVERABLE_AGENT_RUN_ID,
      runId: RECOVERABLE_AGENT_RUN_ID,
      target: `agent:${RECOVERABLE_AGENT_ID}`,
      agentId: RECOVERABLE_AGENT_ID,
      alias: "planner",
      displayName: "Planner",
      description: "Plan the workspace validation",
      task: "Plan the workspace validation and report the plan.",
      recipients: [
        this.primaryAgentId === undefined
          ? PRIMARY_TARGET
          : `agent:${this.primaryAgentId}`,
      ],
      observes: [],
      status: "interrupted",
      startedAt: "2026-08-31T14:00:00.000Z",
      endedAt: "2026-08-31T14:30:00.000Z",
      sessionId: "e2e-recovered-agent-session",
    }];
  }

  async listModels(): Promise<unknown[]> {
    return this.profile === "telescope"
      ? [
          { id: "scripted-fast", name: "Scripted Fast" },
          { id: "scripted-model", name: "Scripted Model" },
          { id: "scripted-deep", name: "Scripted Deep" },
        ]
      : [{ id: "scripted-model", name: "Scripted Model" }];
  }

  async listSessions(): Promise<unknown[]> {
    if (this.resumedCliSession) return [];
    this.sessionListCount += 1;
    const current = {
          sessionId: "e2e-cli-session",
          startTime: new Date("2026-08-31T15:00:00.000Z"),
          modifiedTime: new Date("2026-08-31T15:30:00.000Z"),
          modifiedAgoSeconds: 60,
          summary: "CLI workspace validation",
          isRemote: false,
          inUse: false,
          context: { workingDirectory: this.workspace },
        };
    if (this.profile !== "telescope") return [current];
    const older = Array.from({ length: 320 }, (_, index) => ({
        sessionId: `e2e-older-session-${String(index + 1).padStart(3, "0")}`,
        startTime: new Date(Date.UTC(2025, 9, 16 + index, 12, 0, 0)),
        modifiedTime: new Date(Date.UTC(2025, 9, 16 + index, 12, 30, 0)),
        modifiedAgoSeconds: (321 - index) * 86_400,
        summary: `Older workspace session ${String(index + 1).padStart(3, "0")}`,
        isRemote: false,
        inUse: index === 22,
        context: { workingDirectory: this.workspace },
      }));
    if (this.sessionListCount === 1) {
      return [current, older[22]];
    }
    return [current, ...older.reverse()];
  }

  async resumePrimarySession(sessionId: string): Promise<void> {
    if (this.profile === "telescope" && sessionId === "e2e-older-session-023") {
      throw new Error(`Session "${sessionId}" is active in another process.`);
    }
    if (sessionId !== "e2e-cli-session") {
      throw new Error(`Session "${sessionId}" was not found for this workspace.`);
    }
    await this.openPrimary();
    const primary = this.primaryAgent();
    const transition = this.beginTransition(primary, `replacing its session with "${sessionId}"`);
    const oldRunId = primary.runId;
    const oldSessionId = primary.sessionId;
    let newRunCreated = false;
    let replacementActivated = false;
    try {
      const runId = randomUUID();
      this.primaryRunId = runId;
      primary.runId = runId;
      primary.sessionId = sessionId;
      this.db.createAgentRun(
        primary.runId,
        primary.agentId,
        primary.alias,
        this.storedAgentJson(primary),
        this.workspace,
        process.pid,
        true,
      );
      newRunCreated = true;
      this.db.upsertSession(primary.runId, primary.sessionId, "connected");
      const target = primary.target;
      this.emit("session.loading", {
      mode: "primary-loading",
      sessionId,
      target,
      agentId: primary.agentId,
      }, { runId: primary.runId, memberId: target, target: "status", done: false });
      const historyEvents = [
        {
          id: "cli-user-1",
          parentId: null,
          timestamp: "2026-08-31T15:00:00.000Z",
          type: "user.message",
          data: {
            content: "Inspect this workspace and validate it without blocking the conversation.",
            source: "user",
            delivery: "idle",
          },
        },
        {
          id: "cli-turn-start-1",
          parentId: "cli-user-1",
          timestamp: "2026-08-31T15:00:00.500Z",
          type: "assistant.turn_start",
          data: { turnId: "cli-turn-1" },
        },
        {
          id: "cli-reasoning-1",
          parentId: "cli-turn-start-1",
          timestamp: "2026-08-31T15:00:01.000Z",
          type: "assistant.reasoning",
          data: {
            reasoningId: "cli-reasoning",
            content:
              "I should inspect the project structure first.\n\n" +
              "Then I can start validation in the background and continue explaining.",
          },
        },
        {
          id: "cli-tool-start-1",
          parentId: "cli-reasoning-1",
          timestamp: "2026-08-31T15:00:02.000Z",
          type: "tool.execution_start",
          data: {
            toolCallId: "cli-list-files",
            toolName: "glob",
            arguments: { pattern: "**/*.{ts,lua}" },
          },
        },
        {
          id: "cli-tool-complete-1",
          parentId: "cli-tool-start-1",
          timestamp: "2026-08-31T15:00:03.000Z",
          type: "tool.execution_complete",
          data: {
            toolCallId: "cli-list-files",
            toolName: "glob",
            success: true,
            result: { files: ["src/main.ts", "lua/native_copilot/init.lua"] },
          },
        },
        {
          id: "cli-instruction-notification",
          parentId: "cli-tool-complete-1",
          timestamp: "2026-08-31T15:00:03.100Z",
          type: "system.notification",
          data: {
            content: "<system_notification>Repository instructions discovered.</system_notification>",
            kind: {
              type: "instruction_discovered",
              description: "Repository instructions",
              sourcePath: ".github/copilot-instructions.md",
              triggerFile: "src/main.ts",
              triggerTool: "view",
            },
          },
        },
        {
          id: "cli-permission-request",
          parentId: "cli-instruction-notification",
          timestamp: "2026-08-31T15:00:03.250Z",
          type: "permission.requested",
          data: {
            requestId: "cli-permission",
            permissionRequest: {
              kind: "shell",
              fullCommandText: "npm run check",
            },
          },
        },
        {
          id: "cli-permission-complete",
          parentId: "cli-permission-request",
          timestamp: "2026-08-31T15:00:03.400Z",
          type: "permission.completed",
          data: {
            requestId: "cli-permission",
            result: { kind: "approved" },
          },
        },
        {
          id: "cli-message-delta-1",
          parentId: "cli-permission-complete",
          timestamp: "2026-08-31T15:00:03.500Z",
          type: "assistant.message_delta",
          ephemeral: true,
          data: {
            messageId: "cli-message-1",
            deltaContent: "DUPLICATE EPHEMERAL CONTENT",
          },
        },
        {
          id: "cli-message-1",
          parentId: "cli-message-delta-1",
          timestamp: "2026-08-31T15:00:04.000Z",
          type: "assistant.message",
          data: {
            messageId: "cli-message-1",
            content: "The workspace contains both the TypeScript host and the Neovim Lua client.",
          },
        },
        {
          id: "cli-shell-start",
          parentId: "cli-message-1",
          timestamp: "2026-08-31T15:00:05.000Z",
          type: "tool.execution_start",
          data: {
            toolCallId: "cli-shell",
            toolName: "powershell",
            shellToolInfo: {
              possiblePaths: [],
              hasWriteFileRedirection: false,
            },
            arguments: {
              command: "npm run check",
              description: "Validate the workspace",
              mode: "async",
              detach: true,
            },
          },
        },
        {
          id: "cli-shell-detached",
          parentId: "cli-shell-start",
          timestamp: "2026-08-31T15:00:06.000Z",
          type: "tool.execution_complete",
          data: {
            toolCallId: "cli-shell",
            toolName: "powershell",
            success: true,
            result: { shellId: "cli-shell-7" },
          },
        },
        {
          id: "cli-turn-end-1",
          parentId: "cli-shell-detached",
          timestamp: "2026-08-31T15:00:07.000Z",
          type: "assistant.turn_end",
          data: { turnId: "cli-turn-1" },
        },
        {
          id: "cli-shell-notification",
          parentId: "cli-turn-end-1",
          timestamp: "2026-08-31T15:00:08.000Z",
          type: "system.notification",
          data: {
            content: "<system_notification>Workspace validation completed.</system_notification>",
            kind: {
              type: "shell_completed",
              shellId: "cli-shell-7",
              description: "Validate the workspace",
              exitCode: 0,
            },
          },
        },
        {
          id: "cli-user-2",
          parentId: "cli-shell-notification",
          timestamp: "2026-08-31T15:00:09.000Z",
          type: "user.message",
          data: {
            content: "Schedule an hourly workspace recheck, then cancel it.",
            source: "user",
            delivery: "idle",
          },
        },
        {
          id: "cli-turn-start-2",
          parentId: "cli-user-2",
          timestamp: "2026-08-31T15:00:10.000Z",
          type: "assistant.turn_start",
          data: { turnId: "cli-turn-2" },
        },
        {
          id: "cli-schedule-created",
          parentId: "cli-turn-start-2",
          timestamp: "2026-08-31T15:00:11.000Z",
          type: "session.schedule_created",
          data: {
            id: 1,
            intervalMs: 3600000,
            prompt: "Recheck the workspace",
            recurring: true,
          },
        },
        {
          id: "cli-schedule-cancelled",
          parentId: "cli-schedule-created",
          timestamp: "2026-08-31T15:00:12.000Z",
          type: "session.schedule_cancelled",
          data: { id: 1 },
        },
        {
          id: "cli-subagent-tool-start",
          parentId: "cli-schedule-cancelled",
          timestamp: "2026-08-31T15:00:12.050Z",
          type: "tool.execution_start",
          data: {
            toolCallId: "cli-review-tool",
            toolName: "task",
            arguments: {
              description: "Review workspace validation",
              prompt: "Review the workspace validation and report only actionable findings.",
              agent_type: "explore",
              mode: "background",
            },
          },
        },
        {
          id: "cli-subagent-start",
          agentId: "cli-reviewer",
          parentId: "cli-subagent-tool-start",
          timestamp: "2026-08-31T15:00:12.125Z",
          type: "subagent.started",
          data: {
            toolCallId: "cli-review-tool",
            agentName: "reviewer",
            agentDisplayName: "Workspace reviewer",
            agentDescription: "Review the validation result",
          },
        },
        {
          id: "cli-subagent-prompt",
          agentId: "cli-reviewer",
          parentId: "cli-subagent-start",
          timestamp: "2026-08-31T15:00:12.200Z",
          type: "user.message",
          data: {
            content: "Review the workspace validation and report only actionable findings.",
            source: "agent-primary",
            delivery: "idle",
          },
        },
        {
          id: "cli-subagent-tool-complete",
          parentId: "cli-subagent-prompt",
          timestamp: "2026-08-31T15:00:12.250Z",
          type: "tool.execution_complete",
          data: {
            toolCallId: "cli-review-tool",
            toolName: "task",
            success: true,
            result: { agent_id: "cli-reviewer", status: "running" },
          },
        },
        {
          id: "cli-subagent-internal-message",
          agentId: "cli-reviewer",
          parentId: "cli-subagent-tool-complete",
          timestamp: "2026-08-31T15:00:12.375Z",
          type: "assistant.message",
          data: {
            messageId: "cli-subagent-internal-message",
            content: "SUBAGENT INTERNAL RESPONSE MUST NOT RENDER AS PRIMARY COPILOT",
          },
        },
        {
          id: "cli-write-agent-start",
          parentId: "cli-subagent-internal-message",
          timestamp: "2026-08-31T15:00:12.400Z",
          type: "tool.execution_start",
          data: {
            toolCallId: "cli-write-reviewer",
            toolName: "write_agent",
            arguments: {
              agent_id: "cli-reviewer",
              message: "Also verify that the validation result includes the constrained layout.",
            },
          },
        },
        {
          id: "cli-write-agent-complete",
          parentId: "cli-write-agent-start",
          timestamp: "2026-08-31T15:00:12.425Z",
          type: "tool.execution_complete",
          data: {
            toolCallId: "cli-write-reviewer",
            toolName: "write_agent",
            success: true,
            result: { delivered: true },
          },
        },
        {
          id: "cli-subagent-followup-prompt",
          agentId: "cli-reviewer",
          parentId: "cli-write-agent-complete",
          timestamp: "2026-08-31T15:00:12.450Z",
          type: "user.message",
          data: {
            content: "Also verify that the validation result includes the constrained layout.",
            source: "agent-primary",
            delivery: "steering",
          },
        },
        {
          id: "cli-subagent-complete",
          agentId: "cli-reviewer",
          parentId: "cli-subagent-followup-prompt",
          timestamp: "2026-08-31T15:00:12.500Z",
          type: "subagent.completed",
          data: {
            toolCallId: "cli-review-tool",
            agentName: "reviewer",
            agentDisplayName: "Workspace reviewer",
            totalToolCalls: 1,
          },
        },
        {
          id: "cli-message-2",
          parentId: "cli-subagent-complete",
          timestamp: "2026-08-31T15:00:13.000Z",
          type: "assistant.message",
          data: {
            messageId: "cli-message-2",
            content: "Validation completed successfully, and the temporary recurring check was cancelled.",
          },
        },
        {
          id: "cli-turn-end-2",
          parentId: "cli-message-2",
          timestamp: "2026-08-31T15:00:14.000Z",
          type: "assistant.turn_end",
          data: { turnId: "cli-turn-2" },
        },
        {
          id: "cli-orphan-tool-start",
          parentId: "cli-turn-end-2",
          timestamp: "2026-08-31T15:00:15.000Z",
          type: "tool.execution_start",
          data: {
            toolCallId: "cli-history-timestamp",
            toolName: "view",
            arguments: { path: "history-timestamp-probe.txt" },
          },
        },
        {
          id: "cli-orphan-tool-complete",
          parentId: "cli-orphan-tool-start",
          timestamp: "2026-08-31T15:00:16.000Z",
          type: "tool.execution_complete",
          data: {
            toolCallId: "cli-history-timestamp",
            toolName: "view",
            success: true,
            result: { content: "timestamp probe complete" },
          },
        },
      ].map((event) => ({
        ...event,
        replayTimestamp: Date.parse(event.timestamp),
      }));
      const replayId = "e2e-cli-history-replay";
      const chunkSize = Math.ceil(historyEvents.length / 3);
      const historyChunks = [
        historyEvents.slice(0, chunkSize),
        historyEvents.slice(chunkSize, chunkSize * 2),
        historyEvents.slice(chunkSize * 2),
      ];
      let loadedEvents = 0;
      for (const [chunkIndex, events] of historyChunks.entries()) {
        loadedEvents += events.length;
        this.emit("session.history", {
          events,
          replayId,
          chunkIndex,
          chunkCount: historyChunks.length,
          loadedEvents,
          totalEvents: historyEvents.length,
          first: chunkIndex === 0,
          last: chunkIndex === historyChunks.length - 1,
        }, { runId: primary.runId, memberId: target, target: "conversation", done: true });
      }
    this.emit("session.identity", {
      sessionId,
    }, { runId: primary.runId, memberId: target, target: "activity", done: true });
    await this.loadEnvironment(target);
    this.emit("member.state", {
      state: "idle",
      sessionId,
    }, { runId: primary.runId, memberId: target, target: "status", done: true });
    this.db.completePrimaryReplacementStartup(
      primary.runId,
      oldRunId,
      this.workspace,
      primary.agentId,
      primary.target,
      `Resuming session ${sessionId}`,
    );
    replacementActivated = true;
    this.resumedCliSession = true;
    this.emit("primary.ready", {
      ...this.agentPayload(primary),
      mode: "primary",
      recovered: true,
      sessionId,
      runId: primary.runId,
    }, { runId: primary.runId, memberId: target, target: "status", done: true });
    } catch (error) {
      const failedRunId = primary.runId;
      this.resumedCliSession = false;
      primary.runId = oldRunId;
      primary.sessionId = oldSessionId;
      this.primaryRunId = oldRunId;
      if (newRunCreated) {
        if (replacementActivated) {
          this.db.rollbackPrimaryReplacement(
            failedRunId,
            oldRunId,
            this.workspace,
            primary.agentId,
            primary.target,
            process.pid,
            `Scripted primary replacement with "${sessionId}" failed`,
          );
        } else {
          this.db.disqualifyPrimaryRun(
            failedRunId,
            this.workspace,
            primary.agentId,
            `Scripted primary replacement with "${sessionId}" failed`,
          );
        }
      }
      throw error;
    } finally {
      this.endTransition(primary, transition);
    }
  }

  async listCommands(target: string): Promise<unknown[]> {
    this.requireAvailableAgent(target);
    return [{ name: "context", description: "Scripted context command" }];
  }

  async invokeCommand(target: string, name: string, input?: string): Promise<unknown> {
    this.requireAvailableAgent(target);
    return { kind: "text", text: `${name}${input ? ` ${input}` : ""}` };
  }

  async modelState(target: string): Promise<unknown> {
    this.requireAvailableAgent(target);
    return {
      current: {
        modelId: "scripted-model",
        name: "Scripted Model",
        reasoningEffort: "medium",
      },
      models: this.profile === "telescope"
        ? [
            {
              modelId: "scripted-fast",
              name: "Scripted Fast",
              supportedReasoningEfforts: ["low", "medium"],
            },
            {
              modelId: "scripted-model",
              name: "Scripted Model",
              supportedReasoningEfforts: ["low", "medium", "high"],
            },
            {
              modelId: "scripted-deep",
              name: "Scripted Deep",
              supportedReasoningEfforts: ["medium", "high", "xhigh"],
            },
          ]
        : [{
            modelId: "scripted-model",
            name: "Scripted Model",
            supportedReasoningEfforts: ["low", "medium", "high"],
          }],
    };
  }

  async switchModel(target: string, modelId: string): Promise<unknown> {
    this.requireAvailableAgent(target);
    return { modelId, name: "Scripted Model" };
  }

  async reasoningState(target: string): Promise<unknown> {
    this.requireAvailableAgent(target);
    return {
      modelId: "scripted-model",
      current: "medium",
      supportedReasoningEfforts: ["low", "medium", "high"],
    };
  }

  async setReasoningEffort(target: string, reasoningEffort: string): Promise<unknown> {
    this.requireAvailableAgent(target);
    return { reasoningEffort };
  }

  async listMcp(target: string): Promise<unknown[]> {
    this.requireAvailableAgent(target);
    if (this.profile === "allow-all") return [];
    return this.profile === "allow-all-mcp" || this.profile === "telescope"
      ? [
          { name: "mock-files", status: "connected" },
          { name: "mock-broken", status: "failed" },
        ]
      : [{ name: "mock-permissions", status: "connected" }];
  }

  async setMcpEnabled(target: string, serverName: string, enabled: boolean): Promise<unknown> {
    this.requireAvailableAgent(target);
    return { name: serverName, enabled };
  }

  async listMcpTools(target: string, serverName: string): Promise<unknown[]> {
    this.requireAvailableAgent(target);
    return [{ name: `${serverName}.mock_tool`, description: "Scripted MCP tool" }];
  }

  async reloadMcp(target: string): Promise<number> {
    const servers = await this.listMcp(target);
    return servers.length;
  }

  async listTasks(target: string): Promise<unknown[]> {
    this.requireAvailableAgent(target);
    return this.profile === "telescope"
      ? [
          {
            id: "e2e-picker-task-completed",
            type: "shell",
            status: "completed",
            description: "Validate picker command coverage",
            command: "npm test",
            output: "All picker checks completed.",
          },
          {
            id: "e2e-picker-task-running",
            type: "agent",
            status: "running",
            description: "Review picker behavior",
          },
        ]
      : [];
  }

  async taskProgress(target: string, _taskId: string): Promise<unknown> {
    this.requireAvailableAgent(target);
    return null;
  }

  async cancelTask(target: string, _taskId: string): Promise<boolean> {
    this.requireAvailableAgent(target);
    return true;
  }

  async cancelAllBackgroundAgents(target: string): Promise<number> {
    this.requireAvailableAgent(target);
    return 0;
  }

  async abort(target: string): Promise<void> {
    this.requireAvailableAgent(target);
    this.emitIdle(target);
  }

  private agentPayload(agent: ScriptedAgent): Record<string, unknown> {
    return {
      target: agent.target,
      agentId: agent.agentId,
      alias: agent.alias,
      displayName: agent.displayName,
      description: agent.description,
      task: agent.task,
      recipients: agent.recipients.map((agentId) => `agent:${agentId}`),
      observes: agent.observes.map((agentId) => `agent:${agentId}`),
      ...(agent.primary ? { primary: true } : {}),
      runId: agent.runId,
    };
  }

  private requireAgent(agentRef: string): ScriptedAgent {
    const direct = this.agents.get(agentRef);
    if (direct) return direct;
    for (const agent of this.agents.values()) {
      if (
        agent.target === agentRef ||
        agent.alias === agentRef ||
        agent.runId === agentRef
      ) {
        return agent;
      }
    }
    throw new Error(`No active agent matches "${agentRef}".`);
  }

  async spawnAgents(request: SpawnAgentsRequest): Promise<Array<Record<string, unknown>>> {
    await this.openPrimary();
    const caller = this.primaryAgent();
    const batchAliases = new Map<string, string>();
    for (const definition of request.agents) {
      batchAliases.set(definition.id, randomUUID());
    }
    const resolveSelectors = (selectors: string[], sourceAgentId: string): string[] => {
      const resolved: string[] = [];
      for (const selector of selectors) {
        if (selector === "caller") {
          resolved.push(caller.agentId);
          continue;
        }
        const batch = batchAliases.get(selector);
        if (batch) {
          resolved.push(batch);
          continue;
        }
        if (selector.startsWith("agent:")) {
          const agentId = selector.slice("agent:".length);
          if (agentId !== sourceAgentId && this.agents.has(agentId)) {
            resolved.push(agentId);
            continue;
          }
        }
        const existing = [...this.agents.values()].find((agent) => agent.alias === selector);
        if (!existing || existing.agentId === sourceAgentId) {
          throw new Error(`Scripted agent selector "${selector}" does not resolve.`);
        }
        resolved.push(existing.agentId);
      }
      return resolved;
    };
    const agents = request.agents.map((definition) => {
      const agentId = batchAliases.get(definition.id)!;
      return {
        agentId,
        target: `agent:${agentId}`,
        alias: definition.id,
        displayName: definition.displayName,
        description: definition.description,
        task: definition.task,
        recipients: resolveSelectors(definition.canTalkTo, agentId),
        observes: resolveSelectors(definition.canObserve, agentId),
        runId: randomUUID(),
        sessionId: `e2e-agent-session-${definition.id}`,
      } satisfies ScriptedAgent;
    });
    const nextCaller: ScriptedAgent = {
      ...caller,
      recipients: [
        ...new Set([
          ...caller.recipients,
          ...request.callerCanTalkTo.map((alias) => batchAliases.get(alias)!),
        ]),
      ],
      observes: [
        ...new Set([
          ...caller.observes,
          ...request.callerCanObserve.map((alias) => batchAliases.get(alias)!),
        ]),
      ],
    };
    this.db.createAgentRunsWithCallerUpdate(
      agents.map((agent) => ({
        id: agent.runId,
        agentId: agent.agentId,
        alias: agent.alias,
        definition: this.storedAgentJson(agent),
        workspace: this.workspace,
        ownerPid: process.pid,
      })),
      {
        id: caller.runId,
        alias: caller.alias,
        definition: this.storedAgentJson(nextCaller),
      },
    );
    caller.recipients = nextCaller.recipients;
    caller.observes = nextCaller.observes;

    const results: Array<Record<string, unknown>> = [];
    for (const agent of agents) {
      this.agents.set(agent.agentId, agent);
      const transition = this.beginTransition(agent, "starting its scripted task");
      try {
        this.db.upsertSession(agent.runId, agent.sessionId, "connected");
        this.emit("agent.loading", { ...this.agentPayload(agent), recovered: false }, {
          runId: agent.runId,
          memberId: agent.target,
          target: "status",
          done: false,
        });
        const taskMessageId = randomUUID();
        this.db.enqueueMessage(
          taskMessageId,
          agent.runId,
          "user",
          agent.target,
          "user",
          agent.task,
        );
        this.emitBusy(agent.target, `turn-${agent.agentId}`);
        this.emitMessage(
          agent.target,
          `message-${agent.agentId}`,
          `SCRIPTED-AGENT-TASK: ${agent.task}`,
        );
        this.emitIdle(agent.target);
        const claimedTask = this.db.claimMessage(
          taskMessageId,
          agent.runId,
          agent.target,
        );
        if (
          !claimedTask ||
          !this.db.completeInitialTask(
            claimedTask.id,
            claimedTask.runId,
            claimedTask.target,
            claimedTask.leaseToken,
          )
        ) {
          throw new Error("The scripted initial task lost its delivery lease.");
        }
        this.emit(
          "agent.ready",
          { ...this.agentPayload(agent), recovered: false, sessionId: agent.sessionId },
          { runId: agent.runId, memberId: agent.target, target: "status", done: true },
        );
        results.push({ ...this.agentPayload(agent), sessionId: agent.sessionId, started: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.agents.delete(agent.agentId);
        const permanentlyDisqualified = this.db.failAgentStartup(
          agent.runId,
          this.workspace,
          agent.agentId,
          message,
        );
        if (permanentlyDisqualified) {
          for (const related of [caller, ...agents]) {
            related.recipients = related.recipients.filter(
              (agentId) => agentId !== agent.agentId,
            );
            related.observes = related.observes.filter(
              (agentId) => agentId !== agent.agentId,
            );
          }
        }
        results.push({
          ...this.agentPayload(agent),
          started: false,
          error: message,
        });
      } finally {
        this.endTransition(agent, transition);
      }
    }
    return results;
  }

  async resumeAgent(runId: string): Promise<void> {
    if (this.profile !== "telescope" || runId !== RECOVERABLE_AGENT_RUN_ID) {
      throw new Error(`Agent run "${runId}" was not found for this workspace.`);
    }
    await this.openPrimary();
    const caller = this.primaryAgent();
    const agent: ScriptedAgent = {
      agentId: RECOVERABLE_AGENT_ID,
      target: `agent:${RECOVERABLE_AGENT_ID}`,
      alias: "planner",
      displayName: "Planner",
      description: "Plan the workspace validation",
      task: "Plan the workspace validation and report the plan.",
      recipients: [caller.agentId],
      observes: [],
      runId: RECOVERABLE_AGENT_RUN_ID,
      sessionId: "e2e-recovered-agent-session",
    };
    this.agents.set(agent.agentId, agent);
    const transition = this.beginTransition(agent, "recovering its scripted session");
    try {
      caller.recipients = [...new Set([...caller.recipients, agent.agentId])];
      caller.observes = [...new Set([...caller.observes, agent.agentId])];
      this.db.updateAgentRun(caller.runId, caller.alias, this.storedAgentJson(caller));
      this.recoveredAgentRun = true;
      this.emit(
        "agent.loading",
        { ...this.agentPayload(agent), recovered: true, sessionId: agent.sessionId },
        { runId: agent.runId, memberId: agent.target, target: "status", done: false },
      );
      this.emit("session.identity", { sessionId: agent.sessionId }, {
        runId: agent.runId,
        memberId: agent.target,
        target: "activity",
        done: true,
      });
      this.emit(
        "agent.ready",
        { ...this.agentPayload(agent), recovered: true, sessionId: agent.sessionId },
        { runId: agent.runId, memberId: agent.target, target: "status", done: true },
      );
      this.emit("member.state", { state: "idle" }, {
        runId: agent.runId,
        memberId: agent.target,
        target: "status",
        done: true,
      });
    } finally {
      this.endTransition(agent, transition);
    }
  }

  async stopAgent(agentRef: string, reason = "Agent stopped by scripted runtime"): Promise<void> {
    const agent = this.requireAgent(agentRef);
    if (agent.primary) {
      throw new Error("The scripted primary agent cannot be stopped independently.");
    }
    const transition = this.beginTransition(agent, "stopping");
    try {
      this.agents.delete(agent.agentId);
      this.db.finishRun(agent.runId, "stopped", reason);
      this.emit("agent.stopped", { ...this.agentPayload(agent), reason }, {
        runId: agent.runId,
        memberId: agent.target,
        target: "status",
        done: true,
      });
    } finally {
      this.endTransition(agent, transition);
    }
  }

  async updateAgent(agentRef: string, update: AgentUpdate): Promise<Record<string, unknown>> {
    await this.openPrimary();
    const caller = this.primaryAgent();
    const agent = this.requireAgent(agentRef);
    if (agent.primary) {
      throw new Error("The scripted primary definition is managed by the host.");
    }
    const transition = this.beginTransition(agent, "updating its definition");
    try {
      const resolveSelectors = (selectors: string[]): string[] =>
        selectors.map((selector) => {
          if (selector === "caller") return caller.agentId;
          if (selector.startsWith("agent:")) {
            const agentId = selector.slice("agent:".length);
            if (agentId !== agent.agentId && this.agents.has(agentId)) return agentId;
          }
          const recipient = [...this.agents.values()].find(
            (candidate) => candidate.alias === selector && candidate.agentId !== agent.agentId,
          );
          if (!recipient) {
            throw new Error(`Scripted agent selector "${selector}" does not resolve.`);
          }
          return recipient.agentId;
        });
      const nextAgent: ScriptedAgent = {
        ...agent,
        alias: update.definition.id,
        displayName: update.definition.displayName,
        description: update.definition.description,
        task: update.definition.task,
        recipients: resolveSelectors(update.definition.canTalkTo),
        observes: resolveSelectors(update.definition.canObserve),
      };
      let nextCallerRecipients = [...caller.recipients];
      let nextCallerObserves = [...caller.observes];
      if (update.callerCanTalk === true) {
        nextCallerRecipients = [...new Set([...nextCallerRecipients, agent.agentId])];
      } else if (update.callerCanTalk === false) {
        nextCallerRecipients = nextCallerRecipients.filter(
          (agentId) => agentId !== agent.agentId,
        );
      }
      if (update.callerCanObserve === true) {
        nextCallerObserves = [...new Set([...nextCallerObserves, agent.agentId])];
      } else if (update.callerCanObserve === false) {
        nextCallerObserves = nextCallerObserves.filter(
          (agentId) => agentId !== agent.agentId,
        );
      }
      const nextCaller: ScriptedAgent = {
        ...caller,
        recipients: nextCallerRecipients,
        observes: nextCallerObserves,
      };
      this.db.updateAgentRuns([
        {
          id: nextAgent.runId,
          alias: nextAgent.alias,
          definition: this.storedAgentJson(nextAgent),
        },
        {
          id: nextCaller.runId,
          alias: nextCaller.alias,
          definition: this.storedAgentJson(nextCaller),
        },
      ]);
      Object.assign(agent, nextAgent);
      caller.recipients = nextCallerRecipients;
      caller.observes = nextCallerObserves;
      this.emit("agent.updated", { ...this.agentPayload(agent), reconnected: true }, {
        runId: agent.runId,
        memberId: agent.target,
        target: "status",
        done: true,
      });
      return { action: "updated", ...this.agentPayload(agent), reconnected: true };
    } finally {
      this.endTransition(agent, transition);
    }
  }

  async shutdown(reason: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const agent of this.agents.values()) {
      this.db.finishRun(agent.runId, "stopped", reason);
    }
    this.agents.clear();
    this.pendingPermissions.clear();
    this.transitions.clear();
    this.generations.clear();
    this.primaryRunId = undefined;
    this.primaryAgentId = undefined;
  }
}
