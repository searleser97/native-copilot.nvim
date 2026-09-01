import { randomUUID } from "node:crypto";
import type { FleetDatabase } from "./database.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";
import type { FleetMoveOptions } from "./runtime.js";
import type { DynamicAgentDefinition, DynamicFleetDefinition } from "./types.js";

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
}

const observationMode = process.env.NATIVE_COPILOT_E2E_OBSERVE === "1";
const delayMultiplier = observationMode ? 8 : 1;
const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds * delayMultiplier));
const observationPause = (milliseconds = 350): Promise<void> =>
  observationMode ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();

export class ScriptedRuntime implements RuntimeAdapter {
  private standardRunId: string | undefined;
  private resumedCliSession = false;
  private sessionListCount = 0;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private stopped = false;

  constructor(
    private readonly workspace: string,
    private readonly db: FleetDatabase,
    private readonly emit: RuntimeEmitter,
    private readonly profile: string,
  ) {}

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
        arguments: {
          command: "Write-Output 'workspace valid'",
          description: "Validate workspace in background",
          mode: "async",
          detach: true,
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
    this.emit("tasks.changed", {
      tasks: [{
        id: "e2e-task",
        type: "shell",
        status: "running",
        description: "Validate workspace in background",
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
        toolName: "read_powershell",
        arguments: { shellId: "e2e-task" },
      },
    }, this.fields(target));
    this.emit("activity.event", {
      eventType: "tool.execution_complete",
      data: {
        toolCallId: "e2e-read",
        success: true,
        result: { output: "workspace valid", exitCode: 0 },
      },
    }, this.fields(target, true));
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
        arguments: {
          command: "Write-Output 'metadata refreshed'",
          description: "Refresh validation metadata",
          mode: "async",
          detach: true,
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
        "The tool result confirms that the workspace validation succeeded.",
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
        result: { output: "workspace valid", exitCode: 0 },
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
        "The tool result confirms that the workspace validation succeeded.",
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
    const requestId = "e2e-permission-request";
    this.pendingPermissions.set(requestId, { target });
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
    this.emit("environment.status", {
      component: "Copilot environment",
      status: "ready",
    }, { memberId: target, target: "status", done: true });
  }

  async openStandard(): Promise<void> {
    if (this.standardRunId) return;
    this.standardRunId = randomUUID();
    this.db.createRun(this.standardRunId, "standard", null, this.workspace, process.pid);
    const target = "standard";
    await this.loadEnvironment(target);
    this.emit("member.state", { state: "idle" }, {
      memberId: target,
      target: "status",
      done: true,
    });
  }

  async sendUserPrompt(target: string, content: string): Promise<string> {
    const id = randomUUID();
    if (content.includes("Run a background workspace validation")) {
      void this.taskDeferral(target);
    } else if (content.includes("Read the completed validation output")) {
      void this.toolAuthorship(target);
    } else if (content.includes("Investigate the event-ordering issue")) {
      void this.reasoningFolds(target);
    } else if (content.includes("Run a harmless PowerShell command")) {
      this.permission(target);
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
    void delay(20).then(() => {
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
    return {
      scripted: true,
      profile: this.profile,
      standard: this.standardRunId ? { runId: this.standardRunId } : undefined,
      fleets: [],
      sessions: this.standardRunId
        ? [{ target: "standard", memberId: "standard", state: "idle" }]
        : [],
    };
  }

  recoverableFleetRuns(): Array<Record<string, unknown>> {
    return this.profile === "telescope"
      ? [{
          id: "e2e-recoverable-fleet-run",
          fleetId: "e2e-recovered-fleet",
          name: "Recovered validation fleet",
          status: "stopped",
          startedAt: "2026-08-31T14:00:00.000Z",
          members: ["planner", "reviewer"],
        }]
      : [];
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
    const older = Array.from({ length: 24 }, (_, index) => ({
        sessionId: `e2e-older-session-${String(index + 1).padStart(2, "0")}`,
        startTime: new Date(Date.UTC(2026, 7, 1 + index, 12, 0, 0)),
        modifiedTime: new Date(Date.UTC(2026, 7, 1 + index, 12, 30, 0)),
        modifiedAgoSeconds: (25 - index) * 86_400,
        summary: `Older workspace session ${String(index + 1).padStart(2, "0")}`,
        isRemote: false,
        inUse: index === 22,
        context: { workingDirectory: this.workspace },
      }));
    if (this.sessionListCount === 1) {
      return [current, older[22]];
    }
    return [current, ...older.reverse()];
  }

  async resumeStandardSession(sessionId: string): Promise<void> {
    if (this.profile === "telescope" && sessionId === "e2e-older-session-23") {
      throw new Error(`Session "${sessionId}" is active in another process.`);
    }
    if (sessionId !== "e2e-cli-session") {
      throw new Error(`Session "${sessionId}" was not found for this workspace.`);
    }
    if (this.standardRunId) {
      this.db.finishRun(this.standardRunId, "stopped", `Resuming session ${sessionId}`);
    }
    this.standardRunId = randomUUID();
    this.db.createRun(this.standardRunId, "standard", null, this.workspace, process.pid);
    this.resumedCliSession = true;
    const target = "standard";
    this.emit("session.loading", {
      mode: "standard-loading",
      sessionId,
    }, { runId: this.standardRunId, memberId: target, target: "status", done: false });
    this.emit("session.history", {
      events: [
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
          id: "cli-subagent-start",
          agentId: "cli-reviewer",
          parentId: "cli-schedule-cancelled",
          timestamp: "2026-08-31T15:00:12.250Z",
          type: "subagent.started",
          data: {
            toolCallId: "cli-review-tool",
            agentName: "reviewer",
            agentDisplayName: "Workspace reviewer",
            agentDescription: "Review the validation result",
          },
        },
        {
          id: "cli-subagent-complete",
          agentId: "cli-reviewer",
          parentId: "cli-subagent-start",
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
      ].map((event) => ({
        ...event,
        replayTimestamp: Date.parse(event.timestamp),
      })),
    }, { runId: this.standardRunId, memberId: target, target: "conversation", done: true });
    await this.loadEnvironment(target);
    this.emit("member.state", {
      state: "idle",
      sessionId,
    }, { runId: this.standardRunId, memberId: target, target: "status", done: true });
    this.emit("standard.ready", {
      mode: "standard",
      recovered: true,
      sessionId,
    }, { runId: this.standardRunId, memberId: target, target: "status", done: true });
  }

  async listCommands(_target: string): Promise<unknown[]> {
    return [{ name: "context", description: "Scripted context command" }];
  }

  async invokeCommand(_target: string, name: string, input?: string): Promise<unknown> {
    return { kind: "text", text: `${name}${input ? ` ${input}` : ""}` };
  }

  async modelState(_target: string): Promise<unknown> {
    return {
      current: { modelId: "scripted-model", name: "Scripted Model" },
      models: this.profile === "telescope"
        ? [
            { modelId: "scripted-fast", name: "Scripted Fast" },
            { modelId: "scripted-model", name: "Scripted Model" },
            { modelId: "scripted-deep", name: "Scripted Deep" },
          ]
        : [{ modelId: "scripted-model", name: "Scripted Model" }],
    };
  }

  async switchModel(_target: string, modelId: string): Promise<unknown> {
    return { modelId, name: "Scripted Model" };
  }

  async listMcp(_target: string): Promise<unknown[]> {
    if (this.profile === "allow-all") return [];
    return this.profile === "allow-all-mcp" || this.profile === "telescope"
      ? [
          { name: "mock-files", status: "connected" },
          { name: "mock-broken", status: "failed" },
        ]
      : [{ name: "mock-permissions", status: "connected" }];
  }

  async setMcpEnabled(_target: string, serverName: string, enabled: boolean): Promise<unknown> {
    return { name: serverName, enabled };
  }

  async listMcpTools(_target: string, serverName: string): Promise<unknown[]> {
    return [{ name: `${serverName}.mock_tool`, description: "Scripted MCP tool" }];
  }

  async reloadMcp(target: string): Promise<number> {
    const servers = await this.listMcp(target);
    return servers.length;
  }

  async listTasks(_target: string): Promise<unknown[]> {
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

  async taskProgress(_target: string, _taskId: string): Promise<unknown> {
    return null;
  }

  async cancelTask(_target: string, _taskId: string): Promise<boolean> {
    return true;
  }

  async cancelAllBackgroundAgents(_target: string): Promise<number> {
    return 0;
  }

  async abort(target: string): Promise<void> {
    this.emitIdle(target);
  }

  async startFleet(definition: DynamicFleetDefinition): Promise<void> {
    const members = definition.agents.map((agent) => ({
      id: `${definition.id}/${agent.id}`,
      displayName: agent.displayName,
    }));
    this.emit("fleet.ready", {
      fleetId: definition.id,
      name: definition.name,
      entryMember: `${definition.id}/${definition.entryAgent}`,
      recovered: false,
      members,
    }, { target: "status", done: true });
  }

  async resumeFleet(runId: string): Promise<void> {
    if (this.profile !== "telescope" || runId !== "e2e-recoverable-fleet-run") return;
    this.emit("fleet.ready", {
      fleetId: "e2e-recovered-fleet",
      name: "Recovered validation fleet",
      entryMember: "e2e-recovered-fleet/planner",
      recovered: true,
      members: [
        { id: "e2e-recovered-fleet/planner", displayName: "Planner" },
        { id: "e2e-recovered-fleet/reviewer", displayName: "Reviewer" },
      ],
    }, { target: "status", done: true });
  }

  async stopFleet(fleetIdOrRunId: string, reason = "Fleet stopped by scripted runtime"): Promise<void> {
    this.emit("fleet.stopped", {
      fleetId: fleetIdOrRunId,
      reason,
      members: [],
    }, { target: "status", done: true });
  }

  async mutateFleetAddOrUpdate(
    _fleetId: string,
    agentDefinition: DynamicAgentDefinition,
  ): Promise<Record<string, unknown>> {
    return { action: "updated", agentId: agentDefinition.id, reconnectedAgents: [] };
  }

  async mutateFleetRemove(
    _fleetId: string,
    agentId: string,
    _newEntryAgent?: string,
  ): Promise<Record<string, unknown>> {
    return { action: "removed", agentId, reconnectedAgents: [] };
  }

  async mutateFleetMove(
    sourceFleetId: string,
    destinationFleetId: string,
    agentId: string,
    _options: FleetMoveOptions = {},
  ): Promise<Record<string, unknown>> {
    return { sourceFleetId, destinationFleetId, agentId, sessionPreserved: true };
  }

  async shutdown(reason: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.standardRunId) {
      this.db.finishRun(this.standardRunId, "stopped", reason);
    }
  }
}
