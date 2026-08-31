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

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export class ScriptedRuntime implements RuntimeAdapter {
  private standardRunId: string | undefined;
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
          command: "mock wait",
          description: "Mock background wait",
          mode: "async",
          detach: true,
        },
      },
    }, this.fields(target));
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
        description: "Mock background wait",
      }],
    }, { memberId: target, target: "status", done: true });
    this.emit("conversation.delta", {
      messageId,
      content: "STREAM-BEGIN The response remains",
    }, this.fields(target));
    await delay(30);
    this.emit("tasks.changed", {
      tasks: [{
        id: "e2e-task",
        type: "shell",
        status: "completed",
        description: "Mock background wait",
        result: "mock task completed",
      }],
    }, { memberId: target, target: "status", done: true });
    await delay(30);
    this.emit("conversation.delta", {
      messageId,
      content: " uninterrupted through STREAM-END",
    }, this.fields(target));
    this.emitMessage(
      target,
      messageId,
      "STREAM-BEGIN The response remains uninterrupted through STREAM-END",
    );
    this.emitIdle(target);
  }

  private async toolAuthorship(target: string): Promise<void> {
    this.emit("tasks.changed", {
      tasks: [{
        id: "e2e-prior-task",
        type: "shell",
        status: "completed",
        description: "Prior background task",
        result: "completed",
      }],
    }, { memberId: target, target: "status", done: true });
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
        result: { output: "done", exitCode: 0 },
      },
    }, this.fields(target, true));
    this.emitBusy(target, "e2e-tool-authorship-turn");
    this.emitMessage(target, "e2e-tool-authorship-message", "TOOL-AUTHOR-OK");
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
        fullCommandText: "Write-Output E2E_PERMISSION",
        managedApprovalRequired: false,
      },
    }, { memberId: target, target: "status", done: false });
  }

  async openStandard(): Promise<void> {
    if (this.standardRunId) return;
    this.standardRunId = randomUUID();
    this.db.createRun(this.standardRunId, "standard", null, this.workspace, process.pid);
    const target = "standard";
    this.emit("environment.progress", {
      component: "Copilot environment",
      message: "Starting scripted runtime",
    }, { memberId: target, target: "status" });
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
    this.emit("environment.status", {
      component: "Copilot environment",
      status: "ready",
    }, { memberId: target, target: "status", done: true });
    this.emit("member.state", { state: "idle" }, {
      memberId: target,
      target: "status",
      done: true,
    });
  }

  async sendUserPrompt(target: string, content: string): Promise<string> {
    const id = randomUUID();
    if (content.includes("E2E_TASK_DEFERRAL")) {
      void this.taskDeferral(target);
    } else if (content.includes("E2E_TOOL_AUTHORSHIP")) {
      void this.toolAuthorship(target);
    } else if (content.includes("E2E_PERMISSION")) {
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
    setTimeout(() => {
      this.emitMessage(
        pending.target,
        "e2e-permission-message",
        approved ? "PERMISSION-APPROVED" : "PERMISSION-DENIED",
      );
      this.emitIdle(pending.target);
    }, 20);
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
    return [];
  }

  async listModels(): Promise<unknown[]> {
    return [{ id: "scripted-model", name: "Scripted Model" }];
  }

  async listSessions(): Promise<unknown[]> {
    return [];
  }

  async resumeStandardSession(_sessionId: string): Promise<void> {
    await this.openStandard();
  }

  async listCommands(_target: string): Promise<unknown[]> {
    return [{ name: "context", description: "Scripted context command" }];
  }

  async invokeCommand(_target: string, name: string, input?: string): Promise<unknown> {
    return { kind: "text", content: `${name}${input ? ` ${input}` : ""}` };
  }

  async modelState(_target: string): Promise<unknown> {
    return {
      current: { modelId: "scripted-model", name: "Scripted Model" },
      models: [{ modelId: "scripted-model", name: "Scripted Model" }],
    };
  }

  async switchModel(_target: string, modelId: string): Promise<unknown> {
    return { modelId, name: "Scripted Model" };
  }

  async listMcp(_target: string): Promise<unknown[]> {
    if (this.profile === "allow-all") return [];
    return this.profile === "allow-all-mcp"
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
    return [];
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

  async resumeFleet(_runId: string): Promise<void> {}

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
