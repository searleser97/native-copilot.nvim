import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import {
  CopilotClient,
  defineTool,
  type CopilotSession,
  type PermissionHandler,
  type PermissionRequest,
  type PermissionRequestResult,
  type SessionConfig,
  type SessionEvent,
  type Tool,
} from "@github/copilot-sdk";
import { z } from "zod";
import { FleetDatabase } from "./database.js";
import { validateFleet } from "./config.js";
import type {
  FleetConfig,
  PermissionProfile,
  ResolvedFleet,
  ResolvedMember,
  StandardConfig,
} from "./types.js";

export interface RuntimeEmitter {
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

interface LiveSession {
  session: CopilotSession;
  runId: string;
  memberId: string;
  busy: boolean;
  sequence: number;
  unsubscribe: () => void;
}

type ActiveMode =
  | { kind: "standard"; runId: string }
  | { kind: "fleet"; runId: string; fleet: ResolvedFleet }
  | undefined;

const persistEventTypes = new Set<SessionEvent["type"]>([
  "assistant.message",
  "assistant.reasoning",
  "assistant.intent",
  "assistant.turn_start",
  "assistant.turn_end",
  "tool.execution_start",
  "tool.execution_complete",
  "session.error",
  "session.shutdown",
]);

function projectKey(workspace: string): string {
  return createHash("sha256").update(resolve(workspace).toLowerCase()).digest("hex").slice(0, 12);
}

function stableSessionId(workspace: string, scope: string, memberId: string): string {
  return `fleet-${projectKey(workspace)}-${scope}-${memberId}`;
}

function expandPath(value: string, workspace: string): string {
  return resolve(workspace, value.replaceAll("${workspace}", workspace));
}

function isWithin(candidate: string, roots: string[], workspace: string): boolean {
  const target = resolve(workspace, candidate);
  return roots.some((root) => {
    const rootPath = expandPath(root, workspace);
    const child = relative(rootPath, target);
    return child === "" || (!child.startsWith("..") && !isAbsolute(child));
  });
}

function toolMatches(pattern: string, tool: string): boolean {
  if (pattern === "*" || pattern === "builtin:*" || pattern === "custom:*" || pattern === "mcp:*") {
    return true;
  }
  const separator = pattern.indexOf(":");
  return (separator >= 0 ? pattern.slice(separator + 1) : pattern) === tool;
}

function toolAllowed(profile: PermissionProfile, tool: string): boolean {
  return (
    profile.tools.allow.some((pattern) => toolMatches(pattern, tool)) &&
    !profile.tools.deny.some((pattern) => toolMatches(pattern, tool))
  );
}

function reject(feedback: string): PermissionRequestResult {
  return { kind: "reject", feedback };
}

function permissionHandler(profile: PermissionProfile, workspace: string): PermissionHandler {
  return (request: PermissionRequest): PermissionRequestResult => {
    if (request.managedApprovalRequired) {
      return reject("Managed policy requires an explicit user decision in an interactive surface.");
    }
    switch (request.kind) {
      case "read":
        return isWithin(request.path, profile.paths.read, workspace)
          ? { kind: "approved" }
          : reject(`Read access is outside the configured path ceiling: ${request.path}`);
      case "write":
        return isWithin(request.fileName, profile.paths.write, workspace)
          ? { kind: "approved" }
          : reject(`Write access is outside the configured path ceiling: ${request.fileName}`);
      case "shell": {
        if (!profile.commands) {
          return reject("Shell commands are disabled for this member.");
        }
        if (!profile.network && request.possibleUrls.length > 0) {
          return reject("Network access is disabled for this member.");
        }
        const readOnly = request.commands.every((command) => command.readOnly);
        const roots = readOnly ? profile.paths.read : profile.paths.write;
        const outside = request.possiblePaths.find((path) => !isWithin(path, roots, workspace));
        if (outside) {
          return reject(`Command path is outside the configured ceiling: ${outside}`);
        }
        if (
          !profile.gitWrite &&
          request.commands.some((command) => command.identifier.toLowerCase() === "git") &&
          /\bgit\s+(?:add|am|apply|branch|checkout|cherry-pick|clean|commit|merge|mv|push|rebase|reset|restore|revert|rm|switch|tag)\b/i.test(
            request.fullCommandText,
          )
        ) {
          return reject("Git write operations are disabled for this member.");
        }
        return { kind: "approved" };
      }
      case "url":
        return profile.network
          ? { kind: "approved" }
          : reject("Network access is disabled for this member.");
      case "mcp":
        return profile.externalActions && toolAllowed(profile, request.toolName)
          ? { kind: "approved" }
          : reject(`MCP tool "${request.toolName}" is not permitted for this member.`);
      case "custom-tool":
        return toolAllowed(profile, request.toolName)
          ? { kind: "approved" }
          : reject(`Custom tool "${request.toolName}" is not permitted for this member.`);
      case "memory":
      case "hook":
      case "extension-management":
      case "extension-permission-access":
      case "factory":
        return profile.externalActions
          ? { kind: "approved" }
          : reject(`${request.kind} operations are disabled for this member.`);
    }
  };
}

function sdkToolPatterns(patterns: string[]): string[] {
  const result = new Set<string>();
  for (const pattern of patterns) {
    if (pattern === "*") {
      result.add("builtin:*");
      result.add("custom:*");
      result.add("mcp:*");
    } else {
      result.add(pattern);
    }
  }
  return [...result];
}

export class CopilotRuntime {
  private client: CopilotClient | undefined;
  private knownSessionIds = new Set<string>();
  private readonly live = new Map<string, LiveSession>();
  private active: ActiveMode;
  private shuttingDown = false;
  private pendingFleetStart: string | undefined;

  constructor(
    private readonly config: FleetConfig,
    private readonly workspace: string,
    private readonly db: FleetDatabase,
    private readonly emit: RuntimeEmitter,
  ) {}

  private async ensureClient(): Promise<CopilotClient> {
    if (this.client) {
      return this.client;
    }
    const client = new CopilotClient({
      workingDirectory: this.workspace,
      logLevel: "error",
    });
    await client.start();
    this.knownSessionIds = new Set((await client.listSessions()).map((session) => session.sessionId));
    this.client = client;
    const status = await client.getStatus();
    this.emit("runtime.ready", status);
    return client;
  }

  async listModels(): Promise<unknown[]> {
    return (await this.ensureClient()).listModels();
  }

  private standardPermission(): PermissionProfile {
    const profile = this.config.permissionProfiles[this.config.standard.permissionProfile];
    if (!profile) {
      throw new Error(
        `Unknown standard permission profile "${this.config.standard.permissionProfile}"`,
      );
    }
    return profile;
  }

  private memberConfig(member: ResolvedMember, tools: Tool<any>[]): SessionConfig {
    const config: SessionConfig = {
      clientName: "copilot-fleet.nvim",
      workingDirectory: this.workspace,
      streaming: true,
      includeSubAgentStreamingEvents: false,
      enableConfigDiscovery: true,
      systemMessage: { mode: "append", content: member.initialPrompt },
      onPermissionRequest: permissionHandler(member.permission, this.workspace),
      tools,
      availableTools: sdkToolPatterns(member.permission.tools.allow),
      excludedTools: sdkToolPatterns(member.permission.tools.deny),
    };
    if (member.model !== undefined) {
      config.model = member.model;
    }
    if (member.reasoningEffort !== undefined) {
      config.reasoningEffort = member.reasoningEffort;
    }
    return config;
  }

  private standardSessionConfig(standard: StandardConfig): SessionConfig {
    const permission = this.standardPermission();
    const config: SessionConfig = {
      clientName: "copilot-fleet.nvim",
      workingDirectory: this.workspace,
      streaming: true,
      enableConfigDiscovery: true,
      systemMessage: { mode: "append", content: standard.initialPrompt },
      onPermissionRequest: permissionHandler(permission, this.workspace),
      tools: [this.createStartFleetTool()],
      availableTools: sdkToolPatterns(permission.tools.allow),
      excludedTools: sdkToolPatterns(permission.tools.deny),
    };
    if (standard.model !== undefined) {
      config.model = standard.model;
    }
    if (standard.reasoningEffort !== undefined) {
      config.reasoningEffort = standard.reasoningEffort;
    }
    return config;
  }

  private createStartFleetTool(): Tool<any> {
    const fleetIds = Object.keys(this.config.fleets);
    return defineTool("start_fleet", {
      description:
        "Request activation of a configured Copilot Fleet after the current Standard Copilot " +
        `turn finishes. Available fleet IDs: ${fleetIds.join(", ") || "none"}.`,
      parameters: z.object({
        fleetId: z.string().min(1),
      }),
      skipPermission: true,
      defer: "never",
      handler: ({ fleetId }) => {
        const result = validateFleet(this.config, fleetId, this.workspace);
        if (!result.valid) {
          throw new Error(
            `Fleet "${fleetId}" is unavailable: ${result.issues
              .map((issue) => `${issue.path}: ${issue.message}`)
              .join("; ")}`,
          );
        }
        this.pendingFleetStart = fleetId;
        this.emit("fleet.requested", { fleetId, startsWhen: "session.idle" });
        return {
          accepted: true,
          fleetId,
          message: "The Fleet will start after this Standard Copilot turn becomes idle.",
        };
      },
    });
  }

  private createSendMessageTool(fleet: ResolvedFleet, source: ResolvedMember): Tool<any> {
    const targetDescription = [
      ...source.recipients,
      ...(source.canBroadcast ? ["broadcast"] : []),
    ].join(", ");
    return defineTool("send_message", {
      description:
        "Send a durable asynchronous message to another member of this fleet. " +
        `Allowed recipients: ${targetDescription || "none"}.`,
      parameters: z.object({
        recipient: z.string().min(1).describe("Fleet-local member ID, or broadcast when allowed"),
        subject: z.string().min(1).optional(),
        message: z.string().min(1),
      }),
      skipPermission: true,
      defer: "never",
      handler: async ({ recipient, subject, message }) => {
        const targets =
          recipient === "broadcast"
            ? source.canBroadcast
              ? [...fleet.members.keys()].filter((memberId) => memberId !== source.id)
              : []
            : source.recipients.has(recipient)
              ? [recipient]
              : [];
        if (targets.length === 0) {
          throw new Error(`Recipient "${recipient}" is not allowed for member "${source.id}".`);
        }
        const messageIds: string[] = [];
        for (const target of targets) {
          const id = randomUUID();
          const content = subject ? `Subject: ${subject}\n\n${message}` : message;
          this.db.enqueueMessage(id, this.requireFleetRunId(), source.id, target, "agent", content);
          messageIds.push(id);
          this.emit(
            "mailbox.queued",
            { id, source: source.id, target, content },
            { runId: this.requireFleetRunId(), memberId: source.id, target },
          );
          queueMicrotask(() => void this.drainMailbox(target));
        }
        return { deliveredToMailbox: targets, messageIds };
      },
    });
  }

  private requireFleetRunId(): string {
    if (this.active?.kind !== "fleet") {
      throw new Error("No fleet is active.");
    }
    return this.active.runId;
  }

  private async connectSession(
    runId: string,
    memberId: string,
    sessionId: string,
    config: SessionConfig,
  ): Promise<LiveSession> {
    const existing = this.live.get(memberId);
    if (existing) {
      return existing;
    }
    const client = await this.ensureClient();
    let session: CopilotSession;
    if (this.knownSessionIds.has(sessionId)) {
      session = await client.resumeSession(sessionId, { ...config, suppressResumeEvent: true });
    } else {
      session = await client.createSession({ ...config, sessionId });
      this.knownSessionIds.add(sessionId);
    }
    const live: LiveSession = {
      session,
      runId,
      memberId,
      busy: false,
      sequence: 0,
      unsubscribe: () => undefined,
    };
    live.unsubscribe = session.on((event) => this.handleSessionEvent(live, event));
    this.live.set(memberId, live);
    this.db.upsertSession(runId, memberId, sessionId, "connected");
    const history = await session.getEvents();
    this.emit(
      "session.history",
      { events: history },
      { runId, memberId, target: "conversation", done: true },
    );
    this.emit(
      "member.state",
      { state: "idle", sessionId },
      { runId, memberId, target: "status" },
    );
    return live;
  }

  private async ensureFleetMember(memberId: string): Promise<LiveSession> {
    if (this.active?.kind !== "fleet") {
      throw new Error("No fleet is active.");
    }
    const member = this.active.fleet.members.get(memberId);
    if (!member) {
      throw new Error(`Unknown fleet member "${memberId}".`);
    }
    const tools = [this.createSendMessageTool(this.active.fleet, member)];
    return this.connectSession(
      this.active.runId,
      memberId,
      stableSessionId(this.workspace, this.active.fleet.id, memberId),
      this.memberConfig(member, tools),
    );
  }

  private handleSessionEvent(live: LiveSession, event: SessionEvent): void {
    live.sequence += 1;
    if (persistEventTypes.has(event.type)) {
      this.db.appendEvent(
        event.id,
        live.runId,
        live.memberId,
        event.type,
        event.data,
        live.sequence,
      );
    }
    const fields = {
      runId: live.runId,
      memberId: live.memberId,
      sequence: live.sequence,
    };
    switch (event.type) {
      case "assistant.message_delta":
        this.emit(
          "conversation.delta",
          { content: event.data.deltaContent, messageId: event.data.messageId },
          { ...fields, target: "conversation", done: false },
        );
        break;
      case "assistant.message":
        this.emit(
          "conversation.message",
          event.data,
          { ...fields, target: "conversation", done: true },
        );
        break;
      case "assistant.reasoning_delta":
        this.emit(
          "activity.delta",
          { content: event.data.deltaContent, reasoningId: event.data.reasoningId },
          { ...fields, target: "activity", done: false },
        );
        break;
      case "assistant.reasoning":
        this.emit("activity.reasoning", event.data, {
          ...fields,
          target: "activity",
          done: true,
        });
        break;
      case "assistant.turn_start":
        live.busy = true;
        this.emit("member.state", { state: "busy", ...event.data }, { ...fields, target: "status" });
        break;
      case "assistant.turn_end":
        this.emit(
          "member.turn_end",
          { state: "finishing", ...event.data },
          { ...fields, target: "status", done: true },
        );
        break;
      case "session.idle":
        live.busy = false;
        this.emit("member.state", { state: "idle", ...event.data }, { ...fields, target: "status" });
        if (live.memberId === "standard" && this.pendingFleetStart) {
          const fleetId = this.pendingFleetStart;
          this.pendingFleetStart = undefined;
          queueMicrotask(() => {
            void this.startFleet(fleetId).catch((error) => {
              this.emit(
                "member.error",
                { message: error instanceof Error ? error.message : String(error) },
                { ...fields, target: "activity", done: true },
              );
            });
          });
        } else {
          queueMicrotask(() => void this.drainMailbox(live.memberId));
        }
        break;
      case "session.error":
        this.emit("member.error", event.data, { ...fields, target: "activity", done: true });
        break;
      case "tool.execution_start":
      case "tool.execution_complete":
      case "assistant.intent":
        this.emit("activity.event", { eventType: event.type, data: event.data }, {
          ...fields,
          target: "activity",
          done: event.type === "tool.execution_complete",
        });
        break;
      default:
        break;
    }
  }

  async openStandard(): Promise<void> {
    if (this.active?.kind === "standard") {
      return;
    }
    await this.stopActive("Switching to Standard Copilot");
    const runId = randomUUID();
    this.db.createRun(runId, "standard", null, this.workspace);
    this.active = { kind: "standard", runId };
    try {
      await this.connectSession(
        runId,
        "standard",
        stableSessionId(this.workspace, "standard", this.config.standard.id),
        this.standardSessionConfig(this.config.standard),
      );
      this.emit("mode.changed", { mode: "standard" }, { runId });
    } catch (error) {
      this.db.finishRun(runId, "interrupted", "Standard Copilot failed to start");
      this.active = undefined;
      throw error;
    }
  }

  async startFleet(fleetId: string): Promise<void> {
    const validated = validateFleet(this.config, fleetId, this.workspace);
    if (!validated.valid || !validated.fleet) {
      throw new Error(
        `Fleet "${fleetId}" is invalid:\n${validated.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("\n")}`,
      );
    }
    await this.stopActive(`Switching to fleet ${fleetId}`);
    const runId = randomUUID();
    this.db.createRun(runId, "fleet", fleetId, this.workspace);
    this.active = { kind: "fleet", runId, fleet: validated.fleet };
    const started: LiveSession[] = [];
    try {
      for (const member of validated.fleet.members.values()) {
        if (member.autoStart) {
          started.push(await this.ensureFleetMember(member.id));
        }
      }
      this.emit(
        "mode.changed",
        {
          mode: "fleet",
          fleetId,
          name: validated.fleet.name,
          entryMember: validated.fleet.entryMember,
          coordinatorMember: validated.fleet.coordinatorMember,
          members: [...validated.fleet.members.values()].map((member) => ({
            id: member.id,
            displayName: member.displayName,
            description: member.description,
            recipients: [...member.recipients],
            canBroadcast: member.canBroadcast,
            ui: member.ui,
          })),
        },
        { runId },
      );
    } catch (error) {
      await Promise.allSettled(started.map((live) => live.session.disconnect()));
      this.live.clear();
      this.db.finishRun(runId, "interrupted", "Fleet startup failed");
      this.active = undefined;
      throw error;
    }
  }

  async sendUserPrompt(target: string, content: string): Promise<string> {
    if (!this.active) {
      await this.openStandard();
    }
    const runId = this.active!.runId;
    const live =
      this.active!.kind === "standard"
        ? this.live.get("standard")
        : await this.ensureFleetMember(target);
    if (!live) {
      throw new Error(`Target "${target}" is not active.`);
    }
    const id = randomUUID();
    this.db.enqueueMessage(id, runId, "user", live.memberId, "user", content);
    try {
      const sdkMessageId = await live.session.send({ prompt: content, mode: "enqueue" });
      this.db.completeMessage(id);
      this.emit(
        "prompt.accepted",
        { id, sdkMessageId, source: "user", target: live.memberId, content },
        { runId, memberId: live.memberId, target: "conversation" },
      );
      return sdkMessageId;
    } catch (error) {
      this.db.failMessage(id, error instanceof Error ? error.message : String(error), true);
      throw error;
    }
  }

  private async drainMailbox(memberId: string): Promise<void> {
    if (this.active?.kind !== "fleet") {
      return;
    }
    const live = await this.ensureFleetMember(memberId);
    if (live.busy) {
      return;
    }
    const pending = this.db.claimMessages(memberId);
    for (const message of pending) {
      if (message.kind === "user") {
        this.db.completeMessage(message.id);
        continue;
      }
      const prompt =
        `<fleet_message id="${message.id}" source="${message.source}">\n` +
        `${message.content}\n` +
        "</fleet_message>\n\n" +
        "Process this durable message from another fleet member. Respond or act as appropriate, " +
        "and use send_message if the sender or another member needs a direct answer.";
      try {
        await live.session.send({ prompt, mode: "enqueue" });
        this.db.completeMessage(message.id);
        this.emit(
          "mailbox.delivered",
          { ...message, status: "delivered" },
          { runId: live.runId, memberId, target: "messages" },
        );
      } catch (error) {
        this.db.failMessage(
          message.id,
          error instanceof Error ? error.message : String(error),
          true,
        );
        this.emit(
          "mailbox.failed",
          { id: message.id, message: error instanceof Error ? error.message : String(error) },
          { runId: live.runId, memberId, target: "messages" },
        );
        break;
      }
    }
  }

  async abort(target: string): Promise<void> {
    const live = this.live.get(target);
    if (!live) {
      throw new Error(`Target "${target}" has no live session.`);
    }
    await live.session.abort();
  }

  async stopActive(reason = "Stopped by user"): Promise<void> {
    if (!this.active) {
      return;
    }
    const runId = this.active.runId;
    const sessions = [...this.live.values()];
    this.live.clear();
    await Promise.allSettled(
      sessions.map(async (live) => {
        live.unsubscribe();
        await live.session.disconnect();
        this.db.upsertSession(runId, live.memberId, live.session.sessionId, "disconnected");
      }),
    );
    this.db.finishRun(runId, "stopped", reason);
    this.active = undefined;
    this.emit("mode.changed", { mode: "stopped", reason }, { runId });
  }

  status(): unknown {
    return {
      mode: this.active?.kind ?? "stopped",
      runId: this.active?.runId,
      fleetId: this.active?.kind === "fleet" ? this.active.fleet.id : undefined,
      members: [...this.live.values()].map((live) => ({
        id: live.memberId,
        sessionId: live.session.sessionId,
        state: live.busy ? "busy" : "idle",
      })),
    };
  }

  async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    if (this.active) {
      const runId = this.active.runId;
      for (const live of this.live.values()) {
        live.unsubscribe();
      }
      this.live.clear();
      this.db.finishRun(runId, "interrupted", reason);
      this.active = undefined;
    }
    if (this.client) {
      const client = this.client;
      this.client = undefined;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          client.stop(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Copilot shutdown timed out")), 4_000);
          }),
        ]);
      } catch {
        await client.forceStop();
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    }
  }
}
