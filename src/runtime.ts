import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, relative, resolve } from "node:path";
import {
  CopilotClient,
  RuntimeConnection,
  defineTool,
  type CopilotSession,
  type PermissionHandler,
  type PermissionRequest,
  type PermissionRequestResult,
  type SessionConfig,
  type SessionEvent,
  type SessionMetadata,
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

function findExecutable(name: string, pathValue = process.env.PATH): string | undefined {
  for (const directory of pathValue?.split(delimiter) ?? []) {
    const candidate = resolve(directory.replace(/^"|"$/g, ""), name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function configuredRuntimeConnection(
  command: string | undefined,
  platform = process.platform,
  shell = process.env.SHELL,
  powershell = findExecutable("pwsh.exe"),
) {
  if (!command?.trim()) {
    return undefined;
  }
  if (platform === "win32") {
    if (!powershell) {
      throw new Error("pwsh.exe is required to launch the configured Copilot runtime command.");
    }
    return RuntimeConnection.forStdio({
      path: powershell,
      args: ["-NoLogo", "-NoProfile", "-Command", `& { ${command} @args }`],
    });
  }

  return RuntimeConnection.forStdio({
    path: shell || "/bin/sh",
    args: ["-lc", `exec ${command} "$@"`, "copilot-runtime"],
  });
}

interface LiveSession {
  session: CopilotSession;
  runId: string;
  memberId: string;
  busy: boolean;
  sequence: number;
  taskRefresh: number;
  unsubscribe: () => void;
}

interface EnvironmentProbe {
  component: string;
  load: (session: CopilotSession) => Promise<unknown[]>;
}

type McpAuthHandler = NonNullable<SessionConfig["onMcpAuthRequest"]>;

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

const environmentProbes: EnvironmentProbe[] = [
  {
    component: "Tools",
    load: async (session) => {
      await session.rpc.tools.initializeAndValidate();
      return (await session.rpc.tools.getCurrentMetadata()).tools ?? [];
    },
  },
  {
    component: "Instructions",
    load: async (session) => (await session.rpc.instructions.getSources()).sources,
  },
  {
    component: "Skills",
    load: async (session) => (await session.rpc.skills.list()).skills,
  },
  {
    component: "MCP servers",
    load: async (session) => (await session.rpc.mcp.list()).servers,
  },
  {
    component: "Plugins",
    load: async (session) => (await session.rpc.plugins.list()).plugins,
  },
  {
    component: "Agents",
    load: async (session) => (await session.rpc.agent.list()).agents,
  },
];

function projectKey(workspace: string): string {
  return createHash("sha256").update(resolve(workspace).toLowerCase()).digest("hex").slice(0, 12);
}

export function instanceSessionId(
  workspace: string,
  instanceId: string,
  scope: string,
  memberId: string,
): string {
  return `native-copilot-${projectKey(workspace)}-${instanceId}-${scope}-${memberId}`;
}

export function githubCliAuthToken(): Promise<string> {
  return new Promise((resolveToken, rejectToken) => {
    execFile(
      "gh",
      ["auth", "token"],
      { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          rejectToken(new Error("GitHub CLI authentication is unavailable.", { cause: error }));
          return;
        }
        const token = stdout.trim();
        if (token === "") {
          rejectToken(new Error("GitHub CLI returned an empty authentication token."));
          return;
        }
        resolveToken(token);
      },
    );
  });
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

export function permissionDecision(
  profile: PermissionProfile,
  workspace: string,
  request: PermissionRequest,
): PermissionRequestResult {
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
  private readonly instanceId = randomUUID();
  private active: ActiveMode;
  private shuttingDown = false;
  private pendingFleetStart: string | undefined;
  private readonly pendingPermissions = new Map<
    string,
    { resolve: (result: PermissionRequestResult) => void }
  >();

  constructor(
    private readonly config: FleetConfig,
    private readonly workspace: string,
    private readonly db: FleetDatabase,
    private readonly emit: RuntimeEmitter,
    private readonly runtimeCommand?: string,
  ) {}

  private async ensureClient(): Promise<CopilotClient> {
    if (this.client) {
      return this.client;
    }
    const connection = configuredRuntimeConnection(this.runtimeCommand);
    const client = new CopilotClient({
      ...(connection ? { connection } : {}),
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

  async listSessions(): Promise<
    Array<SessionMetadata & { inUse: boolean; modifiedAgoSeconds: number }>
  > {
    const client = await this.ensureClient();
    const activeSessionIds = new Set([...this.live.values()].map((live) => live.session.sessionId));
    const sessions = (await client.listSessions({ workingDirectory: this.workspace }))
      .filter((session) => !activeSessionIds.has(session.sessionId))
      .sort((left, right) => right.modifiedTime.getTime() - left.modifiedTime.getTime());
    const { inUse } =
      sessions.length === 0
        ? { inUse: [] }
        : await client.rpc.sessions.checkInUse({
            sessionIds: sessions.map((session) => session.sessionId),
          });
    const inUseIds = new Set(inUse);
    const now = Date.now();
    return sessions.map((session) => ({
      ...session,
      inUse: inUseIds.has(session.sessionId),
      modifiedAgoSeconds: Math.max(
        0,
        Math.floor((now - session.modifiedTime.getTime()) / 1_000),
      ),
    }));
  }

  private async activeSession(target: string): Promise<LiveSession> {
    if (!this.active) {
      await this.openStandard();
    }
    const live =
      this.active!.kind === "standard"
        ? this.live.get("standard")
        : await this.ensureFleetMember(target);
    if (!live) {
      throw new Error(`Target "${target}" is not active.`);
    }
    return live;
  }

  async listCommands(target: string): Promise<unknown[]> {
    const live = await this.activeSession(target);
    return (await live.session.rpc.commands.list()).commands;
  }

  async invokeCommand(target: string, name: string, input?: string): Promise<unknown> {
    const live = await this.activeSession(target);
    const result = await live.session.rpc.commands.invoke({
      name,
      ...(input === undefined ? {} : { input }),
    });
    if (result.kind !== "agent-prompt") {
      return result;
    }

    const id = randomUUID();
    const display = result.displayPrompt || `/${name}${input ? ` ${input}` : ""}`;
    this.db.enqueueMessage(id, live.runId, "user", live.memberId, "user", display);
    this.emit(
      "prompt.queued",
      { id, source: "command", target: live.memberId, content: display },
      { runId: live.runId, memberId: live.memberId, target: "activity", done: false },
    );
    try {
      const sdkMessageId = await live.session.send({ prompt: result.prompt, mode: "enqueue" });
      this.db.completeMessage(id);
      this.emit(
        "prompt.accepted",
        { id, sdkMessageId, source: "user", target: live.memberId, content: display },
        { runId: live.runId, memberId: live.memberId, target: "conversation" },
      );
      return {
        kind: result.kind,
        notice: result.notice,
        runtimeSettingsChanged: result.runtimeSettingsChanged,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.failMessage(id, message, true);
      this.emit(
        "prompt.failed",
        { id, source: "command", message },
        { runId: live.runId, memberId: live.memberId, target: "activity", done: true },
      );
      throw error;
    }
  }

  async listTasks(target: string): Promise<unknown[]> {
    const live = await this.activeSession(target);
    return (await live.session.rpc.tasks.list()).tasks;
  }

  async reloadMcp(target: string): Promise<number> {
    const live = await this.activeSession(target);
    this.emit(
      "environment.progress",
      { component: "MCP servers", message: "Reloading MCP server connections" },
      { runId: live.runId, memberId: live.memberId, target: "activity", done: false },
    );
    await live.session.rpc.mcp.reload();
    const { servers } = await live.session.rpc.mcp.list();
    this.emit(
      "environment.loaded",
      { component: "MCP servers", items: servers },
      { runId: live.runId, memberId: live.memberId, target: "activity", done: true },
    );
    return servers.length;
  }

  async cancelTask(target: string, taskId: string): Promise<boolean> {
    const live = await this.activeSession(target);
    return (await live.session.rpc.tasks.cancel({ id: taskId })).cancelled;
  }

  async taskProgress(target: string, taskId: string): Promise<unknown> {
    const live = await this.activeSession(target);
    return (await live.session.rpc.tasks.getProgress({ id: taskId })).progress ?? null;
  }

  async cancelAllBackgroundAgents(target: string): Promise<number> {
    const live = await this.activeSession(target);
    return live.session.rpc.cancelAllBackgroundAgents();
  }

  respondPermission(requestId: string, approved: boolean): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      return false;
    }
    this.pendingPermissions.delete(requestId);
    pending.resolve(
      approved ? { kind: "approved" } : reject("Permission rejected by the user in Neovim."),
    );
    return true;
  }

  private permissionHandler(profile: PermissionProfile, memberId: string): PermissionHandler {
    return (request: PermissionRequest): PermissionRequestResult | Promise<PermissionRequestResult> => {
      const decision = permissionDecision(profile, this.workspace, request);
      if (decision.kind !== "approved" || !request.managedApprovalRequired) {
        return decision;
      }
      const requestId = randomUUID();
      this.emit(
        "permission.requested",
        { requestId, request },
        { memberId, target: "status", done: false },
      );
      return new Promise((resolve) => {
        this.pendingPermissions.set(requestId, { resolve });
      });
    };
  }

  private mcpAuthHandler(memberId: string): McpAuthHandler {
    return async (request) => {
      if (request.serverName !== "github-mcp-server") {
        this.emit(
          "environment.error",
          {
            component: `${request.serverName} authentication`,
            message: "This MCP server requires a host authentication provider.",
          },
          { memberId, target: "activity", done: true },
        );
        return { kind: "cancelled" };
      }

      const component = "GitHub MCP authentication";
      this.emit(
        "environment.progress",
        { component, message: "Reading credentials from the authenticated GitHub CLI" },
        { memberId, target: "activity", done: false },
      );
      try {
        const accessToken = await githubCliAuthToken();
        this.emit(
          "environment.loaded",
          { component, items: [{ status: "authenticated" }] },
          { memberId, target: "activity", done: true },
        );
        return { kind: "token", accessToken };
      } catch {
        this.emit(
          "environment.error",
          {
            component,
            message: "Run `gh auth login` and restart the Copilot session.",
          },
          { memberId, target: "activity", done: true },
        );
        return { kind: "cancelled" };
      }
    };
  }

  private refreshTasks(live: LiveSession): void {
    const refresh = ++live.taskRefresh;
    void live.session.rpc.tasks
      .list()
      .then(({ tasks }) => {
        if (refresh !== live.taskRefresh) {
          return;
        }
        this.emit(
          "tasks.changed",
          { tasks },
          { runId: live.runId, memberId: live.memberId, target: "status", done: true },
        );
      })
      .catch((error: unknown) => {
        if (refresh !== live.taskRefresh) {
          return;
        }
        this.emit(
          "tasks.error",
          { message: error instanceof Error ? error.message : String(error) },
          { runId: live.runId, memberId: live.memberId, target: "status", done: true },
        );
      });
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
      clientName: "native-copilot.nvim",
      workingDirectory: this.workspace,
      streaming: true,
      includeSubAgentStreamingEvents: false,
      reasoningSummary: member.reasoningSummary,
      manageScheduleEnabled: true,
      enableSessionStore: true,
      enableConfigDiscovery: true,
      systemMessage: { mode: "append", content: member.initialPrompt },
      onPermissionRequest: this.permissionHandler(member.permission, member.id),
      onMcpAuthRequest: this.mcpAuthHandler(member.id),
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
      clientName: "native-copilot.nvim",
      workingDirectory: this.workspace,
      streaming: true,
      reasoningSummary: standard.reasoningSummary ?? "detailed",
      manageScheduleEnabled: true,
      enableSessionStore: true,
      enableConfigDiscovery: true,
      systemMessage: { mode: "append", content: standard.initialPrompt },
      onPermissionRequest: this.permissionHandler(permission, "standard"),
      onMcpAuthRequest: this.mcpAuthHandler("standard"),
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
    resumeExisting = false,
  ): Promise<LiveSession> {
    const existing = this.live.get(memberId);
    if (existing) {
      return existing;
    }
    this.emit(
      "environment.progress",
      { component: "Copilot environment", message: "Starting runtime and discovering configuration" },
      { runId, memberId, target: "activity" },
    );
    const client = await this.ensureClient();
    let session: CopilotSession;
    if (resumeExisting || this.knownSessionIds.has(sessionId)) {
      try {
        session = await client.resumeSession(sessionId, { ...config, suppressResumeEvent: true });
        this.knownSessionIds.add(sessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const missing = message.includes("Session not found:");
        if (!resumeExisting || !missing || this.db.hasConversationActivity(runId, memberId)) {
          throw error;
        }
        session = await client.createSession({ ...config, sessionId });
        this.knownSessionIds.add(sessionId);
        this.emit(
          "session.recreated",
          { message: "The previous session had no conversation and was recreated." },
          { runId, memberId, target: "activity", done: true },
        );
      }
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
      taskRefresh: 0,
      unsubscribe: () => undefined,
    };
    live.unsubscribe = session.on((event) => this.handleSessionEvent(live, event));
    this.live.set(memberId, live);
    this.db.upsertSession(runId, memberId, sessionId, "connected");
    for (const probe of environmentProbes) {
      this.emit(
        "environment.progress",
        { component: probe.component, message: `Loading ${probe.component.toLowerCase()}` },
        { runId, memberId, target: "activity" },
      );
    }
    const environment = await Promise.allSettled(
      environmentProbes.map(async (probe) => ({
        component: probe.component,
        items: await probe.load(session),
      })),
    );
    for (let index = 0; index < environment.length; index += 1) {
      const result = environment[index]!;
      const component = environmentProbes[index]!.component;
      if (result.status === "fulfilled") {
        this.emit("environment.loaded", result.value, {
          runId,
          memberId,
          target: "activity",
          done: true,
        });
      } else {
        this.emit(
          "environment.error",
          {
            component,
            message: result.reason instanceof Error ? result.reason.message : String(result.reason),
          },
          { runId, memberId, target: "activity", done: true },
        );
      }
    }
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
    this.refreshTasks(live);
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
      instanceSessionId(this.workspace, this.instanceId, this.active.fleet.id, memberId),
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
      case "user.message":
        if (event.data.source && /^schedule-\d+$/.test(event.data.source)) {
          this.emit(
            "scheduled.prompt",
            { ...event.data, eventId: event.id },
            { ...fields, target: "conversation", done: false },
          );
        }
        break;
      case "session.schedule_created":
        this.emit("schedule.created", event.data, {
          ...fields,
          target: "activity",
          done: true,
        });
        break;
      case "session.schedule_cancelled":
        this.emit("schedule.cancelled", event.data, {
          ...fields,
          target: "activity",
          done: true,
        });
        break;
      case "session.schedule_rearmed":
        this.emit("schedule.rearmed", event.data, {
          ...fields,
          target: "activity",
          done: true,
        });
        break;
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
      case "session.background_tasks_changed":
      case "subagent.started":
      case "subagent.completed":
      case "subagent.failed":
        this.refreshTasks(live);
        break;
      case "session.skills_loaded":
        this.emit(
          "environment.loaded",
          { component: "Skills", items: event.data.skills },
          { ...fields, target: "activity", done: true },
        );
        break;
      case "session.custom_agents_updated":
        this.emit(
          "environment.loaded",
          { component: "Agents", items: event.data.agents },
          { ...fields, target: "activity", done: true },
        );
        for (const error of event.data.errors) {
          this.emit(
            "environment.error",
            { component: "Agents", message: error },
            { ...fields, target: "activity", done: true },
          );
        }
        break;
      case "session.mcp_servers_loaded":
        this.emit(
          "environment.loaded",
          { component: "MCP servers", items: event.data.servers },
          { ...fields, target: "activity", done: true },
        );
        break;
      case "session.mcp_server_status_changed":
        this.emit(
          "environment.status",
          {
            component: `MCP ${event.data.serverName}`,
            status: event.data.status,
            error: event.data.error,
          },
          { ...fields, target: "activity", done: true },
        );
        break;
      case "session.extensions_loaded":
        this.emit(
          "environment.loaded",
          { component: "Extensions", items: event.data.extensions },
          { ...fields, target: "activity", done: true },
        );
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
    this.db.createRun(runId, "standard", null, this.workspace, process.pid);
    this.active = { kind: "standard", runId };
    try {
      await this.connectSession(
        runId,
        "standard",
        instanceSessionId(this.workspace, this.instanceId, "standard", this.config.standard.id),
        this.standardSessionConfig(this.config.standard),
      );
      this.emit("mode.changed", { mode: "standard" }, { runId });
    } catch (error) {
      this.db.finishRun(runId, "interrupted", "Standard Copilot failed to start");
      this.active = undefined;
      throw error;
    }
  }

  async resumeStandardSession(sessionId: string): Promise<void> {
    const client = await this.ensureClient();
    const available = await client.listSessions({ workingDirectory: this.workspace });
    if (!available.some((session) => session.sessionId === sessionId)) {
      throw new Error(`Session "${sessionId}" was not found for this workspace.`);
    }

    await this.stopActive(`Resuming session ${sessionId}`);
    const runId = randomUUID();
    this.db.createRun(runId, "standard", null, this.workspace, process.pid);
    this.active = { kind: "standard", runId };
    this.emit(
      "session.loading",
      { mode: "standard-loading", sessionId },
      { runId, memberId: "standard", target: "status", done: false },
    );
    try {
      await this.connectSession(
        runId,
        "standard",
        sessionId,
        this.standardSessionConfig(this.config.standard),
        true,
      );
      this.emit("mode.changed", { mode: "standard", recovered: true, sessionId }, { runId });
    } catch (error) {
      this.db.finishRun(runId, "interrupted", "Standard Copilot recovery failed");
      this.active = undefined;
      await this.openStandard();
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
    this.db.createRun(runId, "fleet", fleetId, this.workspace, process.pid);
    this.active = { kind: "fleet", runId, fleet: validated.fleet };
    this.emitFleetLoading(
      runId,
      validated.fleet,
      false,
      [...validated.fleet.members.values()]
        .filter((member) => member.autoStart)
        .map((member) => member.id),
    );
    const started: LiveSession[] = [];
    try {
      for (const member of validated.fleet.members.values()) {
        if (member.autoStart) {
          started.push(await this.ensureFleetMember(member.id));
        }
      }
      this.emit(
        "mode.changed",
        this.fleetModePayload(validated.fleet, false),
        { runId },
      );
    } catch (error) {
      await Promise.allSettled(started.map((live) => live.session.disconnect()));
      this.live.clear();
      this.db.finishRun(runId, "interrupted", "Fleet startup failed");
      this.active = undefined;
      await this.openStandard();
      throw error;
    }
  }

  recoverableFleetRuns(): Array<Record<string, unknown>> {
    return this.db
      .resumableFleetRuns(this.workspace)
      .filter((run) => {
        const validation = validateFleet(this.config, run.fleetId, this.workspace);
        return validation.valid;
      })
      .map((run) => ({
        id: run.id,
        fleetId: run.fleetId,
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        members: run.sessions.map((session) => session.memberId),
      }));
  }

  async resumeFleet(runId: string): Promise<void> {
    const stored = this.db.fleetRun(runId, this.workspace);
    if (!stored) {
      throw new Error(`Fleet run "${runId}" was not found for this workspace.`);
    }
    if (stored.status === "active") {
      throw new Error(`Fleet run "${runId}" is owned by another active Neovim instance.`);
    }
    const validated = validateFleet(this.config, stored.fleetId, this.workspace);
    if (!validated.valid || !validated.fleet) {
      throw new Error(`Fleet "${stored.fleetId}" can no longer be resumed with this configuration.`);
    }
    await this.stopActive(`Recovering fleet ${stored.fleetId}`);
    this.db.resumeRun(runId, process.pid);
    this.active = { kind: "fleet", runId, fleet: validated.fleet };
    const started: LiveSession[] = [];
    const storedSessions = new Map(
      stored.sessions.map((session) => [session.memberId, session.sessionId]),
    );
    this.emitFleetLoading(
      runId,
      validated.fleet,
      true,
      [...validated.fleet.members.values()]
        .filter((member) => storedSessions.has(member.id) || member.autoStart)
        .map((member) => member.id),
    );
    try {
      for (const member of validated.fleet.members.values()) {
        const sessionId = storedSessions.get(member.id);
        if (sessionId) {
          started.push(
            await this.connectSession(
              runId,
              member.id,
              sessionId,
              this.memberConfig(member, [
                this.createSendMessageTool(validated.fleet, member),
              ]),
              true,
            ),
          );
        } else if (member.autoStart) {
          started.push(await this.ensureFleetMember(member.id));
        }
      }
      this.emit("mode.changed", this.fleetModePayload(validated.fleet, true), { runId });
      for (const member of started) {
        queueMicrotask(() => void this.drainMailbox(member.memberId));
      }
    } catch (error) {
      await Promise.allSettled(started.map((live) => live.session.disconnect()));
      this.live.clear();
      this.db.finishRun(runId, "interrupted", "Fleet recovery failed");
      this.active = undefined;
      await this.openStandard();
      throw error;
    }
  }

  private fleetModePayload(fleet: ResolvedFleet, recovered: boolean): Record<string, unknown> {
    return {
      mode: "fleet",
      fleetId: fleet.id,
      name: fleet.name,
      recovered,
      entryMember: fleet.entryMember,
      coordinatorMember: fleet.coordinatorMember,
      members: [...fleet.members.values()].map((member) => ({
        id: member.id,
        displayName: member.displayName,
        description: member.description,
        recipients: [...member.recipients],
        canBroadcast: member.canBroadcast,
        autoStart: member.autoStart,
        ui: member.ui,
      })),
    };
  }

  private emitFleetLoading(
    runId: string,
    fleet: ResolvedFleet,
    recovered: boolean,
    connectingMembers: string[],
  ): void {
    this.emit(
      "fleet.loading",
      {
        ...this.fleetModePayload(fleet, recovered),
        mode: "fleet-loading",
        connectingMembers,
      },
      { runId, target: "status", done: false },
    );
  }

  async sendUserPrompt(target: string, content: string): Promise<string> {
    const live = await this.activeSession(target);
    const runId = live.runId;
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
    const pending = this.db.claimMessages(this.active.runId, memberId);
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
    for (const pending of this.pendingPermissions.values()) {
      pending.resolve(reject(`Permission request cancelled: ${reason}`));
    }
    this.pendingPermissions.clear();
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
