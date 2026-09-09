import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, isAbsolute, relative, resolve } from "node:path";
import {
  CopilotClient,
  RuntimeConnection,
  approveAll,
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
import { AgentDatabase } from "./database.js";
import {
  CALLER_SELECTOR,
  LEGACY_PRIMARY_SELECTOR,
  PRIMARY_ALIAS,
  dynamicAgentSchema,
  spawnAgentsSchema,
  validateAgentDefinition,
  validateSpawnRequest,
} from "./config.js";
import type { AgentUpdate, RuntimeAdapter } from "./runtime-adapter.js";
import type {
  DynamicAgentDefinition,
  DynamicPermission,
  PermissionProfile,
  ResolvedAgent,
  SpawnAgentsRequest,
} from "./types.js";

const TOOL_PREFIX = "native_copilot_";

function nativeCopilotTool(name: string): string {
  return `${TOOL_PREFIX}${name}`;
}

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

export function resolveRuntimeCommand(
  resolver: string | undefined,
  workspace: string,
  platform = process.platform,
  shell = process.env.SHELL,
  powershell = findExecutable("pwsh.exe"),
): Promise<string | undefined> {
  if (!resolver?.trim()) {
    return Promise.resolve(undefined);
  }

  let path: string;
  let args: string[];
  if (platform === "win32") {
    if (!powershell) {
      return Promise.reject(
        new Error("pwsh.exe is required to invoke NVIM_COPILOT_CMD_RESOLVER."),
      );
    }
    path = powershell;
    args = ["-NoLogo", "-NoProfile", "-Command", `& { ${resolver} }`];
  } else {
    path = shell || "/bin/sh";
    args = ["-lc", resolver];
  }

  return new Promise((resolveCommand, rejectCommand) => {
    execFile(
      path,
      args,
      {
        cwd: workspace,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim();
          rejectCommand(
            new Error(
              `Copilot command resolver failed${detail ? `: ${detail}` : `: ${error.message}`}`,
            ),
          );
          return;
        }
        const command = stdout.trim();
        if (!command) {
          rejectCommand(new Error("Copilot command resolver returned an empty command."));
          return;
        }
        resolveCommand(command);
      },
    );
  });
}

export const AGENT_TARGET_PREFIX = "agent:";

/** Builds any participant's runtime/UI target id from its durable UUID. */
export function agentTarget(agentId: string): string {
  return `${AGENT_TARGET_PREFIX}${agentId}`;
}

export type TargetRoute = { kind: "agent"; agentId: string };

/**
 * Decides how a UI/runtime target id routes. Every participant is addressed as
 * `agent:<uuid>`; aliases are never protocol routing identities.
 */
export function routeTarget(target: string): TargetRoute {
  if (target.startsWith(AGENT_TARGET_PREFIX)) {
    const agentId = target.slice(AGENT_TARGET_PREFIX.length);
    if (agentId.length > 0) {
      return { kind: "agent", agentId };
    }
  }
  throw new Error(`Target "${target}" is not an "agent:<uuid>" target.`);
}

/** One live SDK session owned by exactly one durable agent. */
interface LiveSession {
  session: CopilotSession;
  runId: string;
  // Runtime/UI identity: always "agent:<uuid>".
  target: string;
  // Durable agent UUID.
  agentId: string;
  // Tool-safe alias used only as a current human/tool selector.
  alias: string;
  // Deterministic signature of everything this session's SessionConfig was built
  // from. Any difference means the live session must be reconnected with a rebuilt
  // config while preserving its session id and history.
  configSignature: string;
  modelId: string | undefined;
  aicUsed: number;
  busy: boolean;
  foregroundBusy: boolean;
  foregroundTurnId: string | undefined;
  foregroundTurnSequence: number;
  foregroundCompleteTurnId: string | undefined;
  foregroundTurnHasToolRequests: boolean;
  foregroundAbortSequence: number | undefined;
  sequence: number;
  taskRefresh: number;
  seenEventIds: Set<string>;
  lastEventAt: number;
  lastRecoveryAt: number;
  recoveringEvents: boolean;
  approveAll: boolean;
  unsubscribe: () => void;
}

interface EnvironmentProbe {
  component: string;
  load: (session: CopilotSession) => Promise<unknown[]>;
}

type McpAuthHandler = NonNullable<SessionConfig["onMcpAuthRequest"]>;

/**
 * One durable agent. Every participant, including the primary user-facing one,
 * owns the same UUID, run, SDK session, mailbox, ACL, and activity-cursor model.
 */
interface AgentContext {
  /** Durable internal UUID assigned by the runtime. */
  agentId: string;
  /** Runtime/UI target id, always "agent:<agentId>". */
  target: string;
  /** Tool-safe alias, unique among active and recoverable agents. */
  alias: string;
  runId: string;
  definition: DynamicAgentDefinition;
  agent: ResolvedAgent;
  /** UUID-backed outgoing messaging grants. */
  canTalkTo: Set<string>;
  /** UUID-backed outgoing passive-observation grants. */
  canObserve: Set<string>;
  /** MCP server ceiling captured from the primary session when the agent started. */
  mcpServers: Set<string>;
}

interface PrimaryContextClaim {
  context: AgentContext;
  recovered: boolean;
  sessionId: string | undefined;
  adoptedMessages: number;
}

/**
 * Deterministic JSON for signature comparison: object keys are emitted in sorted
 * order so two structurally identical definitions always produce the same string
 * regardless of the key order they were parsed or persisted with.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
    return `{${entries.join(",")}}`;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  return "null";
}

interface MailboxRecipient {
  runId: string;
  target: string;
  alias: string;
}

export interface RuntimeSessionOptions {
  allowAll: boolean;
  availableTools: string[];
  excludedTools: string[];
  disabledMcpServers: string[];
  additionalMcpConfigs: string[];
  model?: string;
  reasoningEffort?: string;
}

/**
 * The canonical, typed native configuration parsed once from the resolved main
 * Copilot command. This is the single source of truth every session inherits:
 * the primary user-facing agent and every spawned agent build from it through
 * {@link applyNativePolicy}. Agent-specific settings are only ever overlays or
 * restrictions on this object — nothing re-parses the command or re-declares
 * these defaults elsewhere. `mcpServers` is the merged native MCP-server record
 * resolved from every `--additional-mcp-config` source.
 */
export interface NativePolicy {
  workingDirectory: string;
  allowAll: boolean;
  availableTools: string[];
  excludedTools: string[];
  disabledMcpServers: string[];
  mcpServers: Record<string, unknown>;
  model?: string;
  reasoningEffort?: string;
}

/** The durable per-agent record persisted on the agent's own run. */
interface StoredAgentRecord {
  definition: DynamicAgentDefinition;
  mcpServers: string[];
  canTalkToAgentIds: string[];
  canObserveAgentIds: string[];
}

function storedAgentRecord(value: string): StoredAgentRecord {
  const parsed = JSON.parse(value) as Partial<StoredAgentRecord>;
  if (
    !parsed.definition ||
    typeof parsed.definition !== "object" ||
    !Array.isArray(parsed.mcpServers)
  ) {
    throw new Error("The stored agent definition is invalid.");
  }
  const definition = parsed.definition as DynamicAgentDefinition;
  return {
    definition: {
      ...definition,
      canObserve: Array.isArray(definition.canObserve) ? definition.canObserve : [],
    },
    mcpServers: parsed.mcpServers.filter((server): server is string => typeof server === "string"),
    canTalkToAgentIds: Array.isArray(parsed.canTalkToAgentIds)
      ? parsed.canTalkToAgentIds.filter((agentId): agentId is string => typeof agentId === "string")
      : [],
    canObserveAgentIds: Array.isArray(parsed.canObserveAgentIds)
      ? parsed.canObserveAgentIds.filter((agentId): agentId is string => typeof agentId === "string")
      : [],
  };
}

function primaryAgentDefinition(): DynamicAgentDefinition {
  return {
    id: PRIMARY_ALIAS,
    displayName: "Copilot",
    description: "Primary user-facing Copilot agent",
    task: "Assist the user in the primary Neovim conversation.",
    prompt:
      "You are the Copilot agent attached to the primary user-facing Neovim buffer. " +
      "Use the agent-management tools only when additional independent agents materially help.",
    canTalkTo: [],
    canObserve: [],
  };
}

const ACTIVITY_MAX_BYTES = 30 * 1024;
const ACTIVITY_MAX_EVENTS = 100;
const ACTIVITY_MAX_READS = 32;
const omittedActivityEventTypes = new Set<SessionEvent["type"]>([
  "assistant.message_delta",
  "assistant.reasoning_delta",
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
    load: async (session) =>
      (await session.rpc.instructions.getSources()).sources.map(() => ({})),
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

function commandTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote) {
      if (character === quote) {
        if (quote === "'" && command[index + 1] === "'") {
          current += "'";
          index += 1;
        } else {
          quote = undefined;
        }
      } else if (quote === '"' && character === "`" && index + 1 < command.length) {
        current += command[index + 1];
        index += 1;
      } else {
        current += character;
      }
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (current !== "") tokens.push(current);
  return tokens.filter((token) => token !== "&");
}

export function runtimeSessionOptions(command: string | undefined): RuntimeSessionOptions {
  const result: RuntimeSessionOptions = {
    allowAll: false,
    availableTools: [],
    excludedTools: [],
    disabledMcpServers: [],
    additionalMcpConfigs: [],
  };
  const tokens = commandTokens(command ?? "");
  const value = (index: number, prefix: string): [string | undefined, number] => {
    const token = tokens[index]!;
    const inline = token.startsWith(`${prefix}=`) ? token.slice(prefix.length + 1) : undefined;
    return inline !== undefined ? [inline, index] : [tokens[index + 1], index + 1];
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--allow-all") {
      result.allowAll = true;
    } else if (token === "--available-tools" || token.startsWith("--available-tools=")) {
      const [tools, consumed] = value(index, "--available-tools");
      if (tools) result.availableTools.push(...tools.split(",").filter(Boolean));
      index = consumed;
    } else if (token === "--excluded-tools" || token.startsWith("--excluded-tools=")) {
      const [tools, consumed] = value(index, "--excluded-tools");
      if (tools) result.excludedTools.push(...tools.split(",").filter(Boolean));
      index = consumed;
    } else if (token === "--disable-mcp-server" || token.startsWith("--disable-mcp-server=")) {
      const [server, consumed] = value(index, "--disable-mcp-server");
      if (server) result.disabledMcpServers.push(server);
      index = consumed;
    } else if (
      token === "--additional-mcp-config" || token.startsWith("--additional-mcp-config=")
    ) {
      const [config, consumed] = value(index, "--additional-mcp-config");
      if (config) result.additionalMcpConfigs.push(config);
      index = consumed;
    } else if (token === "--model" || token.startsWith("--model=")) {
      const [model, consumed] = value(index, "--model");
      if (model) result.model = model;
      index = consumed;
    } else if (token === "--reasoning-effort" || token.startsWith("--reasoning-effort=")) {
      const [effort, consumed] = value(index, "--reasoning-effort");
      if (effort) result.reasoningEffort = effort;
      index = consumed;
    }
  }
  result.availableTools = [...new Set(result.availableTools)];
  result.excludedTools = [...new Set(result.excludedTools)];
  result.disabledMcpServers = [...new Set(result.disabledMcpServers)];
  result.additionalMcpConfigs = [...new Set(result.additionalMcpConfigs)];
  return result;
}

/**
 * Reads the MCP server definitions named by every `--additional-mcp-config` value
 * (inline JSON or a `.mcp.json`-style file path) into one merged record. This is
 * the single native MCP-server source that both the primary session and every
 * agent inherit. Because these values come directly from the user's main Copilot
 * command, a broken source is surfaced as an error rather than silently dropped:
 * a missing/unreadable file, invalid JSON, a non-object root, a missing
 * `mcpServers`/`servers` group, or a non-object server entry all throw. Silently
 * discarding them would hide the misconfiguration and quietly shrink the native
 * MCP ceiling that agents inherit.
 */
export function additionalMcpServers(
  values: string[],
  workspace: string,
): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
  for (const value of values) {
    const trimmed = value.trim();
    let raw: string;
    let sourceLabel: string;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      raw = trimmed;
      sourceLabel = "inline JSON";
    } else {
      const fileValue = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
      const path = isAbsolute(fileValue) ? fileValue : resolve(workspace, fileValue);
      sourceLabel = path;
      if (!existsSync(path)) {
        throw new Error(`--additional-mcp-config file not found: ${path}`);
      }
      try {
        raw = readFileSync(path, "utf8");
      } catch (error) {
        throw new Error(
          `--additional-mcp-config file could not be read (${path}): ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `--additional-mcp-config contains invalid JSON (${sourceLabel}): ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        `--additional-mcp-config must be a JSON object with an "mcpServers" map (${sourceLabel}).`,
      );
    }
    const record = parsed as Record<string, unknown>;
    const group = record.mcpServers ?? record.servers;
    if (typeof group !== "object" || group === null || Array.isArray(group)) {
      throw new Error(
        `--additional-mcp-config must define an "mcpServers" (or "servers") object (${sourceLabel}).`,
      );
    }
    for (const [name, definition] of Object.entries(group as Record<string, unknown>)) {
      if (typeof definition !== "object" || definition === null || Array.isArray(definition)) {
        throw new Error(
          `--additional-mcp-config server "${name}" must be an object (${sourceLabel}).`,
        );
      }
      servers[name] = definition;
    }
  }
  return servers;
}

/**
 * Builds the canonical {@link NativePolicy} once from the resolved main Copilot
 * command and workspace. It composes the two native parsers —
 * {@link runtimeSessionOptions} (CLI session flags) and
 * {@link additionalMcpServers} (`--additional-mcp-config` sources) — into the
 * single typed object that drives both the primary session and every agent.
 * This is the only place these defaults are assembled.
 */
export function nativePolicy(
  command: string | undefined,
  workspace: string,
): NativePolicy {
  const options = runtimeSessionOptions(command);
  const policy: NativePolicy = {
    workingDirectory: workspace,
    allowAll: options.allowAll,
    // Normalize the raw CLI tool patterns into SDK-valid, source-qualified patterns
    // once, here in the canonical policy. The main CLI accepts a bare "*" but SDK
    // 1.0.11 rejects it, so expand "*" to builtin/custom/mcp wildcards before any
    // SessionConfig is derived from this policy.
    availableTools: sdkToolPatterns(options.availableTools),
    excludedTools: sdkToolPatterns(options.excludedTools),
    disabledMcpServers: options.disabledMcpServers,
    mcpServers: additionalMcpServers(options.additionalMcpConfigs, workspace),
  };
  if (options.model !== undefined) {
    policy.model = options.model;
  }
  if (options.reasoningEffort !== undefined) {
    policy.reasoningEffort = options.reasoningEffort;
  }
  return policy;
}

/**
 * Layers the single canonical {@link NativePolicy} onto a session config. Every
 * session — primary and spawned agents alike — passes through here so children
 * inherit the same native working directory policy by default. A config that has
 * already narrowed a dimension (e.g. an agent's own `availableTools` allowlist,
 * an explicit `mcpServers` entry, or its own `model`) is treated as a deliberate
 * override and preserved; native denies (`excludedTools`, `disabledMcpServers`)
 * always merge as a ceiling.
 */
export function applyNativePolicy(config: SessionConfig, policy: NativePolicy): void {
  if (policy.availableTools.length > 0 && config.availableTools === undefined) {
    config.availableTools = [...policy.availableTools];
  }
  if (policy.excludedTools.length > 0) {
    const configured = Array.isArray(config.excludedTools) ? config.excludedTools : [];
    config.excludedTools = [...new Set([...configured, ...policy.excludedTools])];
  }
  config.disabledMcpServers = [
    ...new Set([...(config.disabledMcpServers ?? []), ...policy.disabledMcpServers]),
  ];
  if (Object.keys(policy.mcpServers).length > 0) {
    config.mcpServers = {
      ...(policy.mcpServers as NonNullable<SessionConfig["mcpServers"]>),
      ...(config.mcpServers ?? {}),
    };
  }
  if (policy.model !== undefined && config.model === undefined) {
    config.model = policy.model;
  }
  if (policy.reasoningEffort !== undefined && config.reasoningEffort === undefined) {
    config.reasoningEffort = policy.reasoningEffort as NonNullable<SessionConfig["reasoningEffort"]>;
  }
}

/**
 * The single shared base every session is built from. It combines the invariant
 * session scaffold (client name, streaming, session store, schedule support, and
 * config/instruction discovery rooted at the native working directory) with the
 * canonical native policy layered by {@link applyNativePolicy}. Both the primary
 * primary agent and every additional agent start from this exact object; the instance only
 * attaches per-session permission/MCP-auth handlers and then narrows or overrides
 * individual fields. Handlers are intentionally omitted here so this remains a
 * pure, testable definition of the inherited base.
 */
export function nativeSessionScaffold(policy: NativePolicy): SessionConfig {
  const config: SessionConfig = {
    clientName: "native-copilot.nvim",
    workingDirectory: policy.workingDirectory,
    streaming: true,
    manageScheduleEnabled: true,
    enableSessionStore: true,
    enableConfigDiscovery: true,
  };
  applyNativePolicy(config, policy);
  return config;
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

function approve(request: PermissionRequest): PermissionRequestResult {
  return "managedApprovalRequired" in request && request.managedApprovalRequired === true
    ? { kind: "no-result" }
    : { kind: "approve-once" };
}

export function permissionDecision(
  profile: PermissionProfile,
  workspace: string,
  request: PermissionRequest,
): PermissionRequestResult {
  switch (request.kind) {
      case "read":
        return isWithin(request.path, profile.paths.read, workspace)
          ? approve(request)
          : reject(`Read access is outside the configured path ceiling: ${request.path}`);
      case "write":
        return isWithin(request.fileName, profile.paths.write, workspace)
          ? approve(request)
          : reject(`Write access is outside the configured path ceiling: ${request.fileName}`);
      case "shell": {
        if (!profile.commands) {
          return reject("Shell commands are disabled for this agent.");
        }
        if (!profile.network && request.possibleUrls.length > 0) {
          return reject("Network access is disabled for this agent.");
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
          return reject("Git write operations are disabled for this agent.");
        }
        return approve(request);
      }
      case "url":
        return profile.network
          ? approve(request)
          : reject("Network access is disabled for this agent.");
      case "mcp":
        return profile.externalActions && toolAllowed(profile, request.toolName)
          ? approve(request)
          : reject(`MCP tool "${request.toolName}" is not permitted for this agent.`);
      case "custom-tool":
        return toolAllowed(profile, request.toolName)
          ? approve(request)
          : reject(`Custom tool "${request.toolName}" is not permitted for this agent.`);
      case "memory":
      case "hook":
      case "extension-management":
      case "extension-permission-access":
      case "factory":
        return profile.externalActions
          ? approve(request)
          : reject(`${request.kind} operations are disabled for this agent.`);
  }
}

export function usesApproveAll(
  permission: DynamicPermission | undefined,
  mainAllowsAll: boolean,
): boolean {
  if (permission && "mode" in permission) {
    return permission.mode === "approveAll" ||
      (permission.mode === "inherit" && mainAllowsAll);
  }
  return permission === undefined && mainAllowsAll;
}

export function sdkToolPatterns(patterns: string[]): string[] {
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

/** Does a normalized SDK tool-pattern ceiling cover a single normalized pattern? */
function toolCeilingCovers(ceiling: Set<string>, pattern: string): boolean {
  if (ceiling.has(pattern)) {
    return true;
  }
  const colon = pattern.indexOf(":");
  if (colon > 0) {
    const source = pattern.slice(0, colon);
    if (ceiling.has(`${source}:*`)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true when an agent's requested tool allowlist is semantically a subset of
 * the canonical native ceiling. An empty native allowlist means the main session is
 * unrestricted, so any agent allowlist is permitted. Both sides are normalized
 * through {@link sdkToolPatterns}, so a bare "*" and source wildcards (e.g.
 * "builtin:*") are expanded and matched. This is enforced instead of silently
 * intersecting, so an invalid (widening) agent definition is rejected rather than
 * quietly narrowed in a way that hides the mistake.
 */
export function agentToolsWithinCeiling(nativeAllow: string[], agentAllow: string[]): boolean {
  const ceilingList = sdkToolPatterns(nativeAllow);
  if (ceilingList.length === 0) {
    return true;
  }
  const ceiling = new Set(ceilingList);
  return sdkToolPatterns(agentAllow).every((pattern) => toolCeilingCovers(ceiling, pattern));
}

export class CopilotRuntime implements RuntimeAdapter {
  private client: CopilotClient | undefined;
  private knownSessionIds = new Set<string>();
  private readonly live = new Map<string, LiveSession>();
  // In-flight SDK connections keyed by target. Every connect path goes through this
  // guard so one durable agent can never end up with two concurrent SDK sessions.
  private readonly connecting = new Map<string, Promise<LiveSession>>();
  // The single canonical native policy parsed once from the resolved main Copilot
  // command. The primary agent and every spawned agent inherit it; agent
  // settings only overlay or restrict it, so there is one source of truth.
  private readonly policy: NativePolicy;
  // UUID of the generic agent attached to the primary user-facing buffer.
  private primaryAgentId: string | undefined;
  // Every active participant, including the primary agent, keyed by durable UUID.
  private readonly agents = new Map<string, AgentContext>();
  // Alias index over active agents. Durable ACLs never depend on this index.
  private readonly aliasIndex = new Map<string, string>();
  private shuttingDown = false;
  // Spawn requests accepted while their primary caller is busy.
  private readonly pendingSpawns: Array<{
    callerAgentId: string;
    request: SpawnAgentsRequest;
  }> = [];
  private readonly pendingPermissions = new Map<
    string,
    { target: string; respond: (result: PermissionRequestResult) => void }
  >();
  // Serializes lifecycle operations per agent UUID so concurrent update/stop
  // requests cannot interleave on the same agent.
  private readonly agentLocks = new Map<string, Promise<void>>();
  private readonly recoveryTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly workspace: string,
    private readonly db: AgentDatabase,
    private readonly emit: RuntimeEmitter,
    private readonly runtimeCommand?: string,
  ) {
    this.policy = nativePolicy(runtimeCommand, workspace);
    this.recoveryTimer = setInterval(() => {
      if (!this.shuttingDown) {
        void this.recoverSilentSessions();
      }
    }, 3_000);
    this.recoveryTimer.unref?.();
  }

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
    const existing = this.live.get(target);
    if (existing) {
      return existing;
    }
    const route = routeTarget(target);
    return this.ensureAgentSession(route.agentId);
  }

  async listCommands(target: string): Promise<unknown[]> {
    const live = await this.activeSession(target);
    return (await live.session.rpc.commands.list()).commands;
  }

  async modelState(target: string): Promise<unknown> {
    const live = await this.activeSession(target);
    const [models, current] = await Promise.all([
      live.session.rpc.model.list(),
      live.session.rpc.model.getCurrent(),
    ]);
    const defaultModel = models.list.find(
      (model) =>
        typeof model === "object" &&
        model !== null &&
        !Array.isArray(model) &&
        model.is_chat_default === true &&
        typeof model.id === "string",
    );
    const defaultModelId =
      typeof defaultModel === "object" &&
      defaultModel !== null &&
      !Array.isArray(defaultModel) &&
      typeof defaultModel.id === "string"
        ? defaultModel.id
        : undefined;
    const modelId = current.modelId ?? live.modelId ?? defaultModelId;
    live.modelId = modelId;
    return {
      models: models.list,
      current: {
        ...current,
        ...(modelId === undefined ? {} : { modelId }),
      },
    };
  }

  async switchModel(target: string, modelId: string): Promise<unknown> {
    const live = await this.activeSession(target);
    const result = await live.session.rpc.model.switchTo({ modelId });
    if (result.modelId !== undefined) {
      live.modelId = result.modelId;
    }
    return result;
  }

  async reasoningState(target: string): Promise<unknown> {
    const state = await this.modelState(target) as {
      models?: Array<Record<string, unknown>>;
      current?: Record<string, unknown>;
    };
    const current = state.current ?? {};
    const currentModelId =
      typeof current.modelId === "string" ? current.modelId : undefined;
    const model = (state.models ?? []).find((candidate) => {
      const id = typeof candidate.id === "string"
        ? candidate.id
        : typeof candidate.modelId === "string"
          ? candidate.modelId
          : undefined;
      return id === currentModelId;
    });
    const supportedReasoningEfforts = Array.isArray(model?.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.filter(
          (effort): effort is string => typeof effort === "string",
        )
      : [];
    return {
      modelId: currentModelId,
      current: typeof current.reasoningEffort === "string"
        ? current.reasoningEffort
        : undefined,
      supportedReasoningEfforts,
    };
  }

  async setReasoningEffort(target: string, reasoningEffort: string): Promise<unknown> {
    const live = await this.activeSession(target);
    const state = await this.reasoningState(target) as {
      modelId?: string;
      supportedReasoningEfforts?: string[];
    };
    const supported = state.supportedReasoningEfforts ?? [];
    if (supported.length === 0) {
      throw new Error(`Model "${state.modelId ?? "unknown"}" does not support reasoning effort.`);
    }
    if (!supported.includes(reasoningEffort)) {
      throw new Error(
        `Reasoning effort "${reasoningEffort}" is not supported by model ` +
          `"${state.modelId ?? "unknown"}". Choose one of: ${supported.join(", ")}.`,
      );
    }
    return live.session.rpc.model.setReasoningEffort({ reasoningEffort });
  }

  async listMcp(target: string): Promise<unknown[]> {
    const live = await this.activeSession(target);
    return (await live.session.rpc.mcp.list()).servers;
  }

  async setMcpEnabled(target: string, serverName: string, enabled: boolean): Promise<unknown> {
    const live = await this.activeSession(target);
    const result = enabled
      ? await live.session.rpc.mcp.enable({ serverName })
      : await live.session.rpc.mcp.disable({ serverName });
    return { result, servers: (await live.session.rpc.mcp.list()).servers };
  }

  async listMcpTools(target: string, serverName: string): Promise<unknown[]> {
    const live = await this.activeSession(target);
    return (await live.session.rpc.mcp.listTools({ serverName })).tools;
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
    this.db.enqueueMessage(id, live.runId, "user", live.target, "user", display);
    this.emit(
      "prompt.queued",
      { id, source: "command", target: live.target, content: display },
      { runId: live.runId, memberId: live.target, target: "activity", done: false },
    );
    try {
      const sdkMessageId = await live.session.send({ prompt: result.prompt, mode: "immediate" });
      this.db.completeMessage(id);
      this.emit(
        "prompt.accepted",
        { id, sdkMessageId, source: "user", target: live.target, content: display },
        { runId: live.runId, memberId: live.target, target: "conversation" },
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
        { runId: live.runId, memberId: live.target, target: "activity", done: true },
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
      { runId: live.runId, memberId: live.target, target: "activity", done: false },
    );
    await live.session.rpc.mcp.reload();
    const { servers } = await live.session.rpc.mcp.list();
    this.emit(
      "environment.loaded",
      { component: "MCP servers", items: servers },
      { runId: live.runId, memberId: live.target, target: "activity", done: true },
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
    pending.respond(
      approved
        ? { kind: "approve-once", approvedInteractively: true }
        : reject("Permission rejected by the user in Neovim."),
    );
    return true;
  }

  private permissionHandler(
    permission: DynamicPermission | PermissionProfile | undefined,
    uiTarget: string,
  ): PermissionHandler {
    if (usesApproveAll(permission, this.policy.allowAll)) {
      return approveAll;
    }
    const ceiling = permission && !("mode" in permission) ? permission : undefined;
    return (request: PermissionRequest): PermissionRequestResult | Promise<PermissionRequestResult> => {
      if (ceiling) {
        const decision = permissionDecision(ceiling, this.workspace, request);
        if (decision.kind !== "no-result") {
          return decision;
        }
      }
      const requestId = randomUUID();
      this.emit(
        "permission.requested",
        { requestId, request },
        { memberId: uiTarget, target: "status", done: false },
      );
      return new Promise((resolve) => {
        this.pendingPermissions.set(requestId, { target: uiTarget, respond: resolve });
      });
    };
  }

  private async recoverSilentSessions(): Promise<void> {
    const now = Date.now();
    const recoveries: Promise<void>[] = [];
    for (const live of this.live.values()) {
      if (
        live.busy
        && !live.recoveringEvents
        && now - live.lastEventAt >= 10_000
        && now - live.lastRecoveryAt >= 10_000
      ) {
        live.lastRecoveryAt = now;
        recoveries.push(this.recoverSilentSession(live));
      }
    }
    await Promise.allSettled(recoveries);
  }

  private async recoverSilentSession(live: LiveSession): Promise<void> {
    live.recoveringEvents = true;
    try {
      const events = await live.session.getEvents();
      if (this.live.get(live.target) !== live) {
        return;
      }
      for (const event of events) {
        if (!live.seenEventIds.has(event.id)) {
          this.handleSessionEvent(live, event);
        }
      }

      const { items } = await live.session.rpc.permissions.pendingRequests();
      for (const pending of items) {
        if (live.approveAll) {
          await live.session.rpc.permissions.setApproveAll({ enabled: true });
          await live.session.rpc.permissions.handlePendingPermissionRequest({
            requestId: pending.requestId,
            result: { kind: "approve-once" },
          });
          continue;
        }
        if (
          this.pendingPermissions.has(pending.requestId)
          || [...this.pendingPermissions.values()].some(
            (request) => request.target === live.target,
          )
        ) {
          continue;
        }
        this.pendingPermissions.set(pending.requestId, {
          target: live.target,
          respond: (result) => {
            if (result.kind === "no-result") {
              return;
            }
            void live.session.rpc.permissions
              .handlePendingPermissionRequest({ requestId: pending.requestId, result })
              .catch((error: unknown) => {
                this.emit(
                  "member.error",
                  {
                    message:
                      error instanceof Error
                        ? error.message
                        : String(error),
                  },
                  {
                    runId: live.runId,
                    memberId: live.target,
                    target: "activity",
                    done: true,
                  },
                );
              });
          },
        });
        this.emit(
          "permission.requested",
          { requestId: pending.requestId, request: pending.request },
          {
            runId: live.runId,
            memberId: live.target,
            target: "status",
            done: false,
          },
        );
      }
    } catch (error) {
      this.emit(
        "tasks.error",
        {
          message: `Session recovery failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
        { runId: live.runId, memberId: live.target, target: "status", done: true },
      );
    } finally {
      live.recoveringEvents = false;
    }
  }

  // Attaches per-session permission and MCP-auth handlers to the shared native base
  // (nativeSessionScaffold). Every agent builds from that identical base
  // and then only narrow or deliberately override individual fields, so there is one
  // source of truth for inherited defaults. The uiTarget is `agent:<uuid>`.
  private baseSessionConfig(
    uiTarget: string,
    permission: DynamicPermission | undefined,
  ): SessionConfig {
    const config = nativeSessionScaffold(this.policy);
    config.onPermissionRequest = this.permissionHandler(permission, uiTarget);
    config.onMcpAuthRequest = this.mcpAuthHandler(uiTarget);
    return config;
  }

  private mcpAuthHandler(uiTarget: string): McpAuthHandler {
    return async (request) => {
      if (request.serverName !== "github-mcp-server") {
        this.emit(
          "environment.error",
          {
            component: `${request.serverName} authentication`,
            message: "This MCP server requires a host authentication provider.",
          },
          { memberId: uiTarget, target: "activity", done: true },
        );
        return { kind: "cancelled" };
      }

      const component = "GitHub MCP authentication";
      this.emit(
        "environment.progress",
        { component, message: "Reading credentials from the authenticated GitHub CLI" },
        { memberId: uiTarget, target: "activity", done: false },
      );
      try {
        const accessToken = await githubCliAuthToken();
        this.emit(
          "environment.loaded",
          { component, items: [{ status: "authenticated" }] },
          { memberId: uiTarget, target: "activity", done: true },
        );
        return { kind: "token", accessToken };
      } catch {
        this.emit(
          "environment.error",
          {
            component,
            message: "Run `gh auth login` and restart the Copilot session.",
          },
          { memberId: uiTarget, target: "activity", done: true },
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
          { runId: live.runId, memberId: live.target, target: "status", done: true },
        );
      })
      .catch((error: unknown) => {
        if (refresh !== live.taskRefresh) {
          return;
        }
        this.emit(
          "tasks.error",
          { message: error instanceof Error ? error.message : String(error) },
          { runId: live.runId, memberId: live.target, target: "status", done: true },
        );
      });
  }

  private agentConfig(context: AgentContext): SessionConfig {
    // Start from the identical native base the primary session uses. The base has
    // already layered the canonical native policy, so everything below only narrows
    // or deliberately overrides individual inherited fields.
    const agent = context.agent;
    const config = this.baseSessionConfig(context.target, agent.permission);
    config.includeSubAgentStreamingEvents = false;
    config.reasoningSummary = agent.reasoningSummary;
    config.systemMessage = { mode: "append", content: agent.initialPrompt };
    const tools = [
      ...this.createAgentMessagingTools(context),
      this.readAgentActivityTool(context),
    ];
    if (context.agentId === this.primaryAgentId) {
      tools.push(
        this.spawnAgentsTool(context),
        this.updateAgentTool(context),
        this.removeAgentTool(context),
        this.sendToAgentTool(context),
        this.listAgentsTool(context),
      );
    }
    config.tools = tools;
    if (agent.permission && !("mode" in agent.permission)) {
      // Narrow: the agent allowlist replaces the inherited native allowlist.
      config.availableTools = sdkToolPatterns(agent.permission.tools.allow);
      // Restrict: agent denies merge on top of the inherited native excluded ceiling.
      const nativeExcluded = Array.isArray(config.excludedTools) ? config.excludedTools : [];
      config.excludedTools = [
        ...new Set([...nativeExcluded, ...sdkToolPatterns(agent.permission.tools.deny)]),
      ];
    }
    if (agent.model !== undefined) {
      config.model = agent.model;
    }
    if (agent.reasoningEffort !== undefined) {
      config.reasoningEffort = agent.reasoningEffort;
    }
    if (agent.mcpServers) {
      config.disabledMcpServers = [
        ...new Set([
          ...(config.disabledMcpServers ?? []),
          ...[...context.mcpServers].filter((server) => !agent.mcpServers!.has(server)),
        ]),
      ];
    }
    return config;
  }

  private spawnAgentsTool(caller: AgentContext): Tool<any> {
    return defineTool(nativeCopilotTool("spawn_agents"), {
      description:
        "Spawn one or more standalone durable Copilot agents when the user asks for additional " +
        "agents or when independent planning, implementation, testing, or review would materially " +
        "improve the result. Define every agent completely at runtime: a focused prompt, a concrete " +
        "initial task, least-privilege permissions, only the MCP servers it needs, and directional " +
        "canTalkTo recipients. Every agent receives stable native_copilot_list_recipients and " +
        "native_copilot_send_message tools; the host resolves their authorized aliases, agent " +
        "ids, and SDK session ids. canObserve independently grants passive access through " +
        `native_copilot_read_agent_activity. The request-local selector "${CALLER_SELECTOR}" lets ` +
        "a child address this calling agent without relying on its alias. Communication is denied " +
        "by default in both directions: callerCanTalkTo/callerCanObserve grant this caller outgoing " +
        "access to selected children. This request is not a group — every agent gets its own durable " +
        "session, run, and mailbox, and each starts and can be recovered independently once this " +
        "primary turn becomes idle.",
      parameters: spawnAgentsSchema,
      skipPermission: true,
      defer: "never",
      handler: (request) => {
        const source = this.requireCallingPrimary(caller.agentId);
        const spawn = request as SpawnAgentsRequest;
        const resolved = this.resolveSpawnRequest(source, spawn);
        this.pendingSpawns.push({ callerAgentId: source.agentId, request: spawn });
        this.emit(
          "agents.requested",
          {
            count: resolved.length,
            agents: resolved.map((agent) => ({
              alias: agent.alias,
              displayName: agent.displayName,
              description: agent.description,
              task: agent.task,
              canTalkTo: [...agent.recipientSelectors],
              canObserve: [...agent.observeSelectors],
            })),
            callerCanTalkTo: [...spawn.callerCanTalkTo],
            callerCanObserve: [...spawn.callerCanObserve],
            startsWhen: "session.idle",
          },
          { memberId: source.target, target: "activity", done: true },
        );
        return {
          accepted: true,
          agents: resolved.map((agent) => agent.alias),
          message:
            "Each agent starts independently after this primary Copilot turn becomes idle.",
        };
      },
    });
  }

  private updateAgentTool(caller: AgentContext): Tool<any> {
    return defineTool(nativeCopilotTool("update_agent"), {
      description:
        "Replace the complete definition of one active agent in place, without disturbing this " +
        "session or any other agent. Identify the agent by alias or by its agent id; the alias is " +
        "a mutable selector, while durable ACLs use UUIDs. Provide a complete definition — prompt, " +
        "task, permissions, MCP servers, canTalkTo, and canObserve — which must respect the " +
        "permission and MCP ceilings. Set callerCanTalk/callerCanObserve to change this calling " +
        "agent's outgoing grants to the target. If the " +
        "agent's configuration changes, its live session is reconnected while preserving its " +
        "session id and history.",
      parameters: z.object({
        agent: z.string().min(1).describe("Alias or agent id of the active agent to update."),
        definition: dynamicAgentSchema.describe(
          `Complete replacement definition. "${CALLER_SELECTOR}" resolves to this calling agent.`,
        ),
        callerCanTalk: z
          .boolean()
          .optional()
          .describe(
            "Whether this calling agent may message the target; omit to keep the current grant.",
          ),
        callerCanObserve: z
          .boolean()
          .optional()
          .describe(
            "Whether this calling agent may inspect the target's SDK event history; omit to " +
              "keep the current grant.",
          ),
      }),
      skipPermission: true,
      defer: "never",
      handler: async ({ agent, definition, callerCanTalk, callerCanObserve }) => {
        const source = this.requireCallingPrimary(caller.agentId);
        const summary = await this.updateAgentForCaller(source, agent, {
          definition: definition as DynamicAgentDefinition,
          ...(callerCanTalk === undefined ? {} : { callerCanTalk }),
          ...(callerCanObserve === undefined ? {} : { callerCanObserve }),
        });
        return { accepted: true, ...summary };
      },
    });
  }

  private removeAgentTool(caller: AgentContext): Tool<any> {
    return defineTool(nativeCopilotTool("remove_agent"), {
      description:
        "Stop and remove one active agent, identified by alias or agent id, without disturbing " +
        "this session or any other agent. The agent is disconnected and its run is closed. " +
        "UUID-backed ACL links remain durable so they become usable again if that run is recovered.",
      parameters: z.object({
        agent: z.string().min(1).describe("Alias or agent id of the active agent to remove."),
        reason: z.string().min(1).optional().describe("Optional reason recorded on the run."),
      }),
      skipPermission: true,
      defer: "never",
      handler: async ({ agent, reason }) => {
        this.requireCallingPrimary(caller.agentId);
        const context = this.requireAgent(agent);
        await this.stopAgent(context.agentId, reason ?? "Agent removed by primary Copilot");
        return {
          accepted: true,
          action: "removed",
          target: context.target,
          agentId: context.agentId,
          alias: context.alias,
        };
      },
    });
  }

  private sendToAgentTool(caller: AgentContext): Tool<any> {
    return defineTool(nativeCopilotTool("send_to_agent"), {
      description:
        "Deprecated compatibility wrapper over native_copilot_send_message. It uses the calling " +
        "agent's ordinary canTalkTo ACL and grants no privileged routing.",
      parameters: z.object({
        agent: z.string().min(1).describe("Alias or agent id of the recipient agent."),
        subject: z.string().min(1).optional(),
        message: z.string().min(1),
      }),
      skipPermission: true,
      defer: "never",
      handler: ({ agent, subject, message }) => {
        const source = this.requireCallingPrimary(caller.agentId);
        const resolved = this.allowedRecipient(source, agent);
        const id = this.enqueueDurableMessage(
          source.alias,
          resolved.recipient,
          subject,
          message,
          source.target,
        );
        return {
          deprecated: true,
          deliveredToMailbox: resolved.recipient.alias,
          ...(resolved.sessionId === undefined ? {} : { sessionId: resolved.sessionId }),
          messageId: id,
        };
      },
    });
  }

  private listAgentsTool(caller: AgentContext): Tool<any> {
    return defineTool(nativeCopilotTool("list_agents"), {
      description:
        "List every currently active UUID-backed agent, including the primary caller, with its " +
        "alias, agent id, task, outgoing grants, and runtime state.",
      parameters: z.object({}),
      skipPermission: true,
      defer: "never",
      handler: () => {
        this.requireCallingPrimary(caller.agentId);
        return {
          agents: [...this.agents.values()].map((context) => {
            const sessionId = this.agentSessionId(context);
            return {
              ...this.agentPayload(context),
              ...(sessionId === undefined ? {} : { sessionId }),
              state: this.agentState(context),
            };
          }),
        };
      },
    });
  }

  private readAgentActivityTool(observer: AgentContext): Tool<any> {
    const observerAgentId = observer.agentId;
    return defineTool(nativeCopilotTool("read_agent_activity"), {
      description:
        "Read the target agent's raw SDK events since this caller last checked, without sending " +
        "the target a prompt. The caller may inspect itself or a target in its explicit canObserve " +
        "ACL. Use native_copilot_list_recipients to discover observable UUID-backed targets. " +
        "Results preserve " +
        "unknown future event types and omit streaming message/reasoning deltas. Pass the previous " +
        "result's nextCursor as acknowledgeCursor on the next call; only that acknowledgement " +
        "durably advances the per-caller position, so a result lost in transit is replayed.",
      parameters: z.object({
        agent: z
          .string()
          .min(1)
          .describe("Active target agent alias, durable agent id, target id, run id, or session id."),
        acknowledgeCursor: z
          .string()
          .min(1)
          .optional()
          .describe("The exact nextCursor received from the previous successful page."),
      }),
      skipPermission: true,
      defer: "never",
      handler: async ({ agent, acknowledgeCursor }) => {
        const source = this.agents.get(observerAgentId);
        if (!source) {
          throw new Error(`Agent "${observer.alias}" is no longer active.`);
        }
        const targetAgent = this.requireAgent(agent);
        if (
          source.agentId !== targetAgent.agentId &&
          !source.canObserve.has(targetAgent.agentId)
        ) {
          throw new Error(
            `Agent "${source.alias}" is not allowed to inspect "${targetAgent.alias}" under the current ` +
              "observation rules.",
          );
        }

        const live = await this.activeSession(targetAgent.target);
        const observerId = source.agentId;
        const targetId = targetAgent.agentId;
        const storedCursor = this.db.activityCursor(observerId, targetId);
        let readCursor =
          acknowledgeCursor ??
          (storedCursor?.sessionId === live.session.sessionId
            ? storedCursor.cursor
            : undefined);
        let acknowledgedCursor =
          storedCursor?.sessionId === live.session.sessionId
            ? storedCursor.cursor
            : undefined;
        let acknowledgementPending = acknowledgeCursor !== undefined;
        const events: SessionEvent[] = [];
        let serializedBytes = 0;
        let nextCursor = readCursor;
        let hasMore = false;
        let readCount = 0;
        let cursorReset = storedCursor !== undefined &&
          storedCursor.sessionId !== live.session.sessionId;
        while (events.length < ACTIVITY_MAX_EVENTS) {
          if (readCount >= ACTIVITY_MAX_READS) {
            hasMore = true;
            break;
          }
          const remaining = ACTIVITY_MAX_EVENTS - events.length;
          const requested = Math.min(20, remaining);
          const requestCursor = readCursor;
          let page = await live.session.rpc.eventLog.read({
            ...(readCursor === undefined ? {} : { cursor: readCursor }),
            max: requested,
            includeEphemeral: false,
          });
          readCount += 1;
          if (page.cursorStatus === "expired") {
            cursorReset = true;
            events.length = 0;
            serializedBytes = 0;
            acknowledgedCursor = undefined;
          }
          if (acknowledgementPending) {
            if (page.cursorStatus === "ok") {
              this.db.advanceActivityCursor(
                observerId,
                targetId,
                live.session.sessionId,
                acknowledgeCursor!,
              );
              acknowledgedCursor = acknowledgeCursor;
            }
            acknowledgementPending = false;
          }
          let pageEvents = page.events.filter(
            (event) => !omittedActivityEventTypes.has(event.type),
          );
          let pageBytes = Buffer.byteLength(JSON.stringify(pageEvents), "utf8");

          if (
            pageEvents.length > 1 &&
            serializedBytes + pageBytes > ACTIVITY_MAX_BYTES
          ) {
            if (readCount >= ACTIVITY_MAX_READS) {
              hasMore = true;
              break;
            }
            page = await live.session.rpc.eventLog.read({
              ...(readCursor === undefined ? {} : { cursor: readCursor }),
              max: 1,
              includeEphemeral: false,
            });
            readCount += 1;
            if (page.cursorStatus === "expired") {
              cursorReset = true;
              events.length = 0;
              serializedBytes = 0;
              acknowledgedCursor = undefined;
            }
            pageEvents = page.events.filter(
              (event) => !omittedActivityEventTypes.has(event.type),
            );
            pageBytes = Buffer.byteLength(JSON.stringify(pageEvents), "utf8");
          }

          if (
            pageEvents.length > 0 &&
            events.length > 0 &&
            serializedBytes + pageBytes > ACTIVITY_MAX_BYTES
          ) {
            hasMore = true;
            break;
          }

          events.push(...pageEvents);
          serializedBytes += pageBytes;
          readCursor = page.cursor;
          nextCursor = page.cursor;
          hasMore = page.hasMore;
          if (page.hasMore && page.cursor === requestCursor) {
            hasMore = true;
            break;
          }

          if (!page.hasMore) {
            break;
          }
          if (page.events.length === 0) {
            break;
          }
          if (serializedBytes >= ACTIVITY_MAX_BYTES) {
            hasMore = true;
            break;
          }
          if (pageEvents.length === 0) {
            continue;
          }
        }
        return {
          agent: {
            alias: targetAgent.alias,
            agentId: targetAgent.agentId,
            target: targetAgent.target,
            sessionId: live.session.sessionId,
          },
          targetAgentId: targetAgent.agentId,
          currentState: this.agentState(targetAgent),
          events,
          eventCount: events.length,
          serializedBytes,
          hasMore,
          ...(acknowledgedCursor === undefined ? {} : { acknowledgedThrough: acknowledgedCursor }),
          ...(nextCursor === undefined ? {} : { nextCursor }),
          ...(cursorReset ? { cursorReset: true } : {}),
          ...(serializedBytes > ACTIVITY_MAX_BYTES ? { oversizedSingleEvent: true } : {}),
          limits: {
            maxEvents: ACTIVITY_MAX_EVENTS,
            maxBytes: ACTIVITY_MAX_BYTES,
            maxReads: ACTIVITY_MAX_READS,
          },
        };
      },
    });
  }

  /** Validates a spawn request and every uniqueness/ceiling rule it must satisfy. */
  private resolveSpawnRequest(
    caller: AgentContext,
    request: SpawnAgentsRequest,
  ): ResolvedAgent[] {
    const existingAliases = new Set(this.aliasIndex.keys());
    existingAliases.delete(caller.alias);
    for (const reserved of this.db.reservedAgentAliases(this.workspace)) {
      existingAliases.add(reserved.alias);
    }
    const validated = validateSpawnRequest(request, "spawn", existingAliases);
    if (!validated.valid || !validated.agents) {
      throw new Error(
        `The agent spawn request is invalid:\n${validated.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("\n")}`,
      );
    }
    this.assertPermissionCeiling(request.agents);
    this.assertAliasesAvailable(validated.agents.map((agent) => agent.alias));
    return validated.agents;
  }

  private assertPermissionCeiling(definitions: DynamicAgentDefinition[]): void {
    for (const definition of definitions) {
      const permissions = definition.permissions;
      if (permissions === undefined) {
        continue;
      }
      if ("mode" in permissions) {
        if (!this.policy.allowAll && permissions.mode === "approveAll") {
          throw new Error(
            "approveAll child permissions require the main Copilot command to include --allow-all.",
          );
        }
        continue;
      }
      // A concrete permission profile: its tool allowlist may only narrow the
      // canonical native ceiling, never widen it. Rejecting (rather than silently
      // intersecting) surfaces an invalid LLM-authored definition instead of hiding it.
      if (!agentToolsWithinCeiling(this.policy.availableTools, permissions.tools.allow)) {
        throw new Error(
          `Agent "${definition.id}" requests tools outside the main session allowlist ` +
            `(${this.policy.availableTools.join(", ") || "unrestricted"}). Child allowlists may ` +
            "only narrow the native tool ceiling.",
        );
      }
    }
  }

  private assertMcpCeiling(
    definitions: DynamicAgentDefinition[],
    availableServers: ReadonlySet<string>,
  ): void {
    for (const definition of definitions) {
      for (const server of definition.mcpServers ?? []) {
        if (!availableServers.has(server)) {
          throw new Error(
            `Agent "${definition.id}" requested unavailable MCP server "${server}".`,
          );
        }
      }
    }
  }

  /**
   * Aliases are the user-facing, tool-safe handle for an agent, so they must be
   * unique among active agents, agents queued to start, and every recoverable agent
   * definition persisted in this workspace; otherwise an agent could not be
   * addressed unambiguously.
   */
  private assertAliasesAvailable(aliases: string[], ignoreAgentId?: string): void {
    const reserved = this.db.reservedAgentAliases(this.workspace);
    for (const alias of aliases) {
      if (alias === LEGACY_PRIMARY_SELECTOR) {
        throw new Error(
          `Alias "${alias}" is reserved for primary-agent compatibility and cannot be assigned ` +
            "to an agent.",
        );
      }
      const activeAgentId = this.aliasIndex.get(alias);
      if (activeAgentId !== undefined && activeAgentId !== ignoreAgentId) {
        throw new Error(`Alias "${alias}" is already used by an active agent.`);
      }
      if (
        this.pendingSpawns.some((pending) =>
          pending.request.agents.some((definition) => definition.id === alias))
      ) {
        throw new Error(`Alias "${alias}" is already queued to start.`);
      }
      const run = reserved.find(
        (candidate) => candidate.alias === alias && candidate.agentId !== ignoreAgentId,
      );
      if (run) {
        throw new Error(
          `Alias "${alias}" belongs to agent run "${run.runId}" (${run.status}) in this ` +
            "workspace; recover or reuse that agent, or choose a different alias.",
        );
      }
    }
  }

  private resolveAgentRef(agentRef: string): AgentContext | undefined {
    if (agentRef === LEGACY_PRIMARY_SELECTOR) {
      return this.primaryAgentId === undefined
        ? undefined
        : this.agents.get(this.primaryAgentId);
    }
    if (agentRef.startsWith(AGENT_TARGET_PREFIX)) {
      return this.agents.get(agentRef.slice(AGENT_TARGET_PREFIX.length));
    }
    const byAgentId = this.agents.get(agentRef);
    if (byAgentId) {
      return byAgentId;
    }
    const aliasAgentId = this.aliasIndex.get(agentRef);
    if (aliasAgentId !== undefined) {
      return this.agents.get(aliasAgentId);
    }
    for (const context of this.agents.values()) {
      if (context.runId === agentRef || this.agentSessionId(context) === agentRef) {
        return context;
      }
    }
    return undefined;
  }

  private requireAgent(agentRef: string): AgentContext {
    const context = this.resolveAgentRef(agentRef);
    if (!context) {
      throw new Error(`No active agent matches "${agentRef}".`);
    }
    return context;
  }

  private requirePrimary(): AgentContext {
    const context =
      this.primaryAgentId === undefined ? undefined : this.agents.get(this.primaryAgentId);
    if (!context) {
      throw new Error("The primary Copilot agent is not running.");
    }
    return context;
  }

  private requireCallingPrimary(agentId: string): AgentContext {
    const context = this.agents.get(agentId);
    if (!context || context.agentId !== this.primaryAgentId) {
      throw new Error("Agent-management tools are only available to the active primary agent.");
    }
    return context;
  }

  private agentState(context: AgentContext): string {
    const live = this.live.get(context.target);
    if (!live) {
      return "loading";
    }
    return live.foregroundBusy ? "busy" : "idle";
  }

  private storedAgentJson(context: AgentContext): string {
    const record: StoredAgentRecord = {
      definition: context.definition,
      mcpServers: [...context.mcpServers],
      canTalkToAgentIds: [...context.canTalkTo],
      canObserveAgentIds: [...context.canObserve],
    };
    return JSON.stringify(record);
  }

  private async availableMcpServers(): Promise<Set<string>> {
    const primary = this.primaryAgentId === undefined
      ? undefined
      : this.live.get(agentTarget(this.primaryAgentId));
    if (!primary) {
      return new Set();
    }
    return new Set((await primary.session.rpc.mcp.list()).servers.map((server) => server.name));
  }

  /**
   * The complete signature of the SessionConfig an agent would be connected with:
   * its full definition plus its original MCP ceiling.
   */
  private sessionSignature(context: AgentContext): string {
    return stableStringify({
      definition: context.definition,
      mcpCeiling: [...context.mcpServers].sort(),
    });
  }

  private agentRecipient(agentId: string): MailboxRecipient {
    const context = this.agents.get(agentId);
    if (!context) {
      throw new Error(`Agent "${agentId}" is not active; the message was not delivered.`);
    }
    return { runId: context.runId, target: context.target, alias: context.alias };
  }

  private agentSessionId(context: AgentContext): string | undefined {
    return (
      this.live.get(context.target)?.session.sessionId ??
      this.db.session(context.runId)?.sessionId
    );
  }

  private registerAgent(context: AgentContext): void {
    this.agents.set(context.agentId, context);
    this.aliasIndex.set(context.alias, context.agentId);
  }

  private unregisterAgent(context: AgentContext): void {
    this.agents.delete(context.agentId);
    if (this.aliasIndex.get(context.alias) === context.agentId) {
      this.aliasIndex.delete(context.alias);
    }
  }

  private resolveGrantSelectors(
    selectors: ReadonlySet<string>,
    caller: AgentContext,
    batchAliases: ReadonlyMap<string, string>,
    sourceAgentId: string,
  ): Set<string> {
    const resolved = new Set<string>();
    for (const selector of selectors) {
      let agentId: string | undefined;
      if (selector === CALLER_SELECTOR) {
        agentId = caller.agentId;
      } else if (selector === LEGACY_PRIMARY_SELECTOR) {
        agentId = this.primaryAgentId;
      } else {
        agentId = batchAliases.get(selector) ?? this.aliasIndex.get(selector);
        if (agentId === undefined && selector.startsWith(AGENT_TARGET_PREFIX)) {
          agentId = selector.slice(AGENT_TARGET_PREFIX.length);
        } else if (agentId === undefined && this.agents.has(selector)) {
          agentId = selector;
        } else if (agentId === undefined) {
          agentId = this.db.latestAgentRunByAlias(selector, this.workspace)?.agentId;
        }
      }
      if (agentId === undefined) {
        throw new Error(`Agent selector "${selector}" no longer resolves.`);
      }
      if (
        !batchAliases.has(selector) &&
        !this.agents.has(agentId) &&
        !this.db.latestAgentRun(agentId, this.workspace)
      ) {
        throw new Error(`Agent selector "${selector}" does not identify a managed agent.`);
      }
      if (agentId === sourceAgentId) {
        throw new Error(`Agent "${sourceAgentId}" cannot grant access to itself.`);
      }
      resolved.add(agentId);
    }
    return resolved;
  }

  private grantDetails(agentIds: ReadonlySet<string>): string[] {
    return [...agentIds].map((agentId) => agentTarget(agentId)).sort();
  }

  private allowedRecipient(
    source: AgentContext,
    selector: string,
  ): { recipient: MailboxRecipient; sessionId: string | undefined } {
    const current = this.agents.get(source.agentId);
    if (!current) {
      throw new Error(`Agent "${source.alias}" is no longer active.`);
    }

    const matched = this.resolveAgentRef(selector);
    if (!matched) {
      throw new Error(
        `Recipient "${selector}" is not a known active agent. Call ` +
          "native_copilot_list_recipients to refresh the authorized mapping.",
      );
    }
    if (!current.canTalkTo.has(matched.agentId)) {
      throw new Error(
        `Agent "${current.alias}" is not allowed to send messages to "${matched.alias}" under ` +
          `the current communication rules. "${matched.agentId}" is not in this agent's canTalkTo ` +
          "ACL.",
      );
    }
    return {
      recipient: this.agentRecipient(matched.agentId),
      sessionId: this.agentSessionId(matched),
    };
  }

  /**
   * Stores a durable message against the recipient's own run and schedules an
   * independent drain of that recipient's mailbox.
   */
  private enqueueDurableMessage(
    sourceAlias: string,
    recipient: MailboxRecipient,
    subject: string | undefined,
    message: string,
    sourceTarget: string,
  ): string {
    const id = randomUUID();
    const content = subject ? `Subject: ${subject}\n\n${message}` : message;
    this.db.enqueueMessage(
      id,
      recipient.runId,
      sourceTarget,
      recipient.target,
      "agent",
      content,
    );
    this.emit(
      "mailbox.queued",
      { id, source: sourceAlias, target: recipient.alias, content },
      { runId: recipient.runId, memberId: sourceTarget, target: "messages" },
    );
    queueMicrotask(() => void this.drainMailbox(recipient.target));
    return id;
  }

  /** Builds stable messaging tools whose handlers enforce the agent's current ACL. */
  private createAgentMessagingTools(context: AgentContext): Tool<any>[] {
    const agentId = context.agentId;
    return [
      defineTool(nativeCopilotTool("list_recipients"), {
        description:
          "List the agents this caller is currently authorized to message or observe, including " +
          "their current alias, durable agent id, current SDK session id, runtime state, and " +
          "directional canTalk/canObserve flags.",
        parameters: z.object({}),
        skipPermission: true,
        defer: "never",
        handler: () => {
          const source = this.agents.get(agentId);
          if (!source) {
            throw new Error(`Agent "${context.alias}" is no longer active.`);
          }
          const grantedAgentIds = new Set([...source.canTalkTo, ...source.canObserve]);
          const recipients = [...grantedAgentIds].map((recipientId) => {
            const recipient = this.agents.get(recipientId);
            const stored =
              recipient === undefined
                ? this.db.latestAgentRun(recipientId, this.workspace)
                : undefined;
            const sessionId = recipient === undefined ? undefined : this.agentSessionId(recipient);
            return {
              alias: recipient?.alias ?? stored?.alias ?? recipientId,
              agentId: recipientId,
              target: agentTarget(recipientId),
              ...(sessionId === undefined
                ? stored?.session
                  ? { sessionId: stored.session.sessionId }
                  : {}
                : { sessionId }),
              canTalk: source.canTalkTo.has(recipientId),
              canObserve: source.canObserve.has(recipientId),
              state: recipient === undefined ? "inactive" : this.agentState(recipient),
            };
          });
          recipients.sort((left, right) => left.alias.localeCompare(right.alias));
          return { recipients };
        },
      }),
      defineTool(nativeCopilotTool("send_message"), {
        description:
          "Send a durable asynchronous message to one authorized recipient. Identify it with an " +
          "alias, durable agent id, or current SDK session id returned by " +
          "native_copilot_list_recipients. The host revalidates the current ACL; knowing a session " +
          "id never grants permission.",
        parameters: z.object({
          recipient: z
            .string()
            .min(1)
            .describe("Authorized recipient alias, durable agent id, or current SDK session id."),
          subject: z.string().min(1).optional(),
          message: z.string().min(1),
        }),
        skipPermission: true,
        defer: "never",
        handler: ({ recipient: selector, subject, message }) => {
          const source = this.agents.get(agentId);
          if (!source) {
            throw new Error(`Agent "${context.alias}" is no longer active.`);
          }
          const resolved = this.allowedRecipient(source, selector);
          const id = this.enqueueDurableMessage(
            source.alias,
            resolved.recipient,
            subject,
            message,
            source.target,
          );
          return {
            deliveredToMailbox: resolved.recipient.alias,
            ...(resolved.sessionId === undefined ? {} : { sessionId: resolved.sessionId }),
            messageId: id,
          };
        },
      }),
    ];
  }

  private async connectSession(options: {
    runId: string;
    target: string;
    agentId: string;
    alias: string;
    sessionId: string | undefined;
    config: SessionConfig;
    configSignature: string;
    resumeExisting?: boolean;
    suppressHistory?: boolean;
  }): Promise<LiveSession> {
    const existing = this.live.get(options.target);
    if (existing) {
      return existing;
    }
    // Every connect goes through the same guard: spawn, mailbox draining, recovery,
    // and reconnect can all race for one agent, and a second SDK connect would
    // otherwise create a duplicate session for one durable agent.
    return this.trackConnection(options.target, () => this.establishSession(options));
  }

  /**
   * The single guarded connection primitive. It atomically joins the connection
   * already in flight for a target instead of starting a second one, so any caller
   * — including one that resumes after awaiting an earlier connection — is guarded.
   * The registration is removed on both success and failure.
   */
  private async trackConnection(
    target: string,
    connect: () => Promise<LiveSession>,
  ): Promise<LiveSession> {
    const inFlight = this.connecting.get(target);
    if (inFlight) {
      return inFlight;
    }
    const attempt = connect();
    this.connecting.set(target, attempt);
    try {
      return await attempt;
    } finally {
      if (this.connecting.get(target) === attempt) {
        this.connecting.delete(target);
      }
    }
  }

  private async establishSession(options: {
    runId: string;
    target: string;
    agentId: string;
    alias: string;
    sessionId: string | undefined;
    config: SessionConfig;
    configSignature: string;
    resumeExisting?: boolean;
    suppressHistory?: boolean;
  }): Promise<LiveSession> {
    const { runId, target, agentId, alias, sessionId, config } = options;
    const resumeExisting = options.resumeExisting === true;
    const client = await this.ensureClient();
    let session: CopilotSession;
    if (sessionId && (resumeExisting || this.knownSessionIds.has(sessionId))) {
      // Managed sessions are never silently recreated: a missing SDK conversation
      // would discard schedules and state that SQLite intentionally does not copy.
      session = await client.resumeSession(sessionId, { ...config, suppressResumeEvent: true });
    } else {
      session = await client.createSession(config);
    }
    const actualSessionId = session.sessionId;
    this.knownSessionIds.add(actualSessionId);
    const live: LiveSession = {
      session,
      runId,
      target,
      agentId,
      alias,
      configSignature: options.configSignature,
      modelId: config.model,
      aicUsed: 0,
      busy: false,
      foregroundBusy: false,
      foregroundTurnId: undefined,
      foregroundTurnSequence: 0,
      foregroundCompleteTurnId: undefined,
      foregroundTurnHasToolRequests: false,
      foregroundAbortSequence: undefined,
      sequence: 0,
      taskRefresh: 0,
      seenEventIds: new Set<string>(),
      lastEventAt: Date.now(),
      lastRecoveryAt: 0,
      recoveringEvents: false,
      approveAll: config.onPermissionRequest === approveAll,
      unsubscribe: () => undefined,
    };
    live.unsubscribe = session.on((event) => this.handleSessionEvent(live, event));
    this.live.set(target, live);
    this.db.upsertSession(runId, actualSessionId, "connected");
    const history = await session.getEvents();
    const replayEvents = history.filter((event) => !live.seenEventIds.has(event.id));
    for (const event of history) {
      live.seenEventIds.add(event.id);
    }
    // Skip the history replay for an in-process reconnect: the UI buffer for this
    // target is retained across the reconnect (an ACL change never resets a buffer),
    // so re-emitting the full transcript would duplicate it. A fresh connect or a
    // host-restart recovery still needs the history to render.
    if (options.suppressHistory !== true) {
      this.emit(
        "session.history",
        {
          events: replayEvents.map((event) => ({
            ...event,
            replayTimestamp: Date.parse(event.timestamp),
          })),
        },
        { runId, memberId: target, target: "conversation", done: true },
      );
      this.emit(
        "session.identity",
        { sessionId: actualSessionId },
        { runId, memberId: target, target: "activity", done: true },
      );
    }
    this.emit(
      "environment.progress",
      { component: "Copilot environment", message: "Starting runtime and discovering configuration" },
      { runId, memberId: target, target: "activity" },
    );
    for (const probe of environmentProbes) {
      this.emit(
        "environment.progress",
        { component: probe.component, message: `Loading ${probe.component.toLowerCase()}` },
        { runId, memberId: target, target: "activity" },
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
          memberId: target,
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
          { runId, memberId: target, target: "activity", done: true },
        );
      }
    }
    this.emit(
      "member.state",
      { state: "idle", sessionId: actualSessionId },
      { runId, memberId: target, target: "status" },
    );
    try {
      await this.modelState(target);
    } catch (error) {
      this.emit(
        "environment.error",
        {
          component: "Model",
          message: error instanceof Error ? error.message : String(error),
        },
        { runId, memberId: target, target: "activity", done: true },
      );
    }
    this.emit(
      "session.metrics",
      { modelId: live.modelId, aicUsed: live.aicUsed },
      { runId, memberId: target, target: "status", done: true },
    );
    this.refreshTasks(live);
    return live;
  }

  private async ensureAgentSession(agentId: string): Promise<LiveSession> {
    const context = this.agents.get(agentId);
    if (!context) {
      throw new Error(`Agent "${agentId}" is not active.`);
    }
    const existing = this.live.get(context.target);
    if (existing) {
      return existing;
    }
    const storedSessionId = this.db.session(context.runId)?.sessionId;
    return this.connectSession({
      runId: context.runId,
      target: context.target,
      agentId: context.agentId,
      alias: context.alias,
      sessionId: storedSessionId,
      config: this.agentConfig(context),
      configSignature: this.sessionSignature(context),
      resumeExisting: storedSessionId !== undefined,
    });
  }

  private handleSessionEvent(live: LiveSession, event: SessionEvent): void {
    if (live.seenEventIds.has(event.id)) {
      return;
    }
    live.seenEventIds.add(event.id);
    live.lastEventAt = Date.now();
    live.sequence += 1;
    const fields = {
      runId: live.runId,
      memberId: live.target,
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
        if (event.agentId === undefined) {
          const turnId = event.data.turnId ?? live.foregroundTurnId;
          if (turnId === live.foregroundTurnId) {
            if ((event.data.toolRequests?.length ?? 0) > 0) {
              live.foregroundTurnHasToolRequests = true;
              live.foregroundCompleteTurnId = undefined;
            } else if (turnId !== undefined && !live.foregroundTurnHasToolRequests) {
              live.foregroundCompleteTurnId = turnId;
            }
          }
        }
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
      case "assistant.usage":
        live.modelId = event.data.model || live.modelId;
        live.aicUsed += (event.data.copilotUsage?.totalNanoAiu ?? 0) / 1_000_000_000;
        this.emit(
          "session.metrics",
          { modelId: live.modelId, aicUsed: live.aicUsed },
          { ...fields, target: "status", done: true },
        );
        break;
      case "assistant.turn_start":
        if (event.agentId !== undefined) {
          break;
        }
        live.busy = true;
        live.foregroundBusy = true;
        live.foregroundTurnId = event.data.turnId;
        live.foregroundTurnSequence += 1;
        if (live.foregroundAbortSequence !== live.foregroundTurnSequence) {
          live.foregroundAbortSequence = undefined;
        }
        live.foregroundCompleteTurnId = undefined;
        live.foregroundTurnHasToolRequests = false;
        this.emit("member.state", { state: "busy", ...event.data }, { ...fields, target: "status" });
        break;
      case "assistant.turn_end":
        if (event.agentId !== undefined) {
          break;
        }
        if (event.data.turnId !== live.foregroundTurnId) {
          this.emit(
            "member.turn_end",
            { state: "finishing", ...event.data },
            { ...fields, target: "status", done: true },
          );
          break;
        }
        {
          const foregroundComplete = live.foregroundCompleteTurnId === event.data.turnId;
          live.foregroundTurnId = undefined;
          live.foregroundCompleteTurnId = undefined;
          live.foregroundTurnHasToolRequests = false;
          this.emit(
            "member.turn_end",
            { state: "finishing", ...event.data },
            { ...fields, target: "status", done: true },
          );
          if (foregroundComplete) {
            live.foregroundBusy = false;
            live.foregroundAbortSequence = undefined;
            this.emit(
              "member.foreground_idle",
              { state: "idle", turnId: event.data.turnId },
              { ...fields, target: "status", done: true },
            );
          }
        }
        break;
      case "assistant.idle":
        if (
          event.agentId === undefined
          && event.data.aborted === true
          && live.foregroundAbortSequence === live.foregroundTurnSequence
        ) {
          live.foregroundBusy = false;
          live.foregroundTurnId = undefined;
          live.foregroundCompleteTurnId = undefined;
          live.foregroundTurnHasToolRequests = false;
          live.foregroundAbortSequence = undefined;
          this.emit(
            "member.foreground_idle",
            { state: "idle", aborted: true },
            { ...fields, target: "status", done: true },
          );
        }
        break;
      case "session.idle": {
        live.busy = false;
        live.foregroundBusy = false;
        live.foregroundTurnId = undefined;
        live.foregroundCompleteTurnId = undefined;
        live.foregroundTurnHasToolRequests = false;
        live.foregroundAbortSequence = undefined;
        this.emit("member.state", { state: "idle", ...event.data }, { ...fields, target: "status" });
        if (live.agentId === this.primaryAgentId) {
          queueMicrotask(() => void this.drainPendingSpawns(live.agentId));
        }
        const target = live.target;
        queueMicrotask(() => void this.drainMailbox(target));
        break;
      }
      case "session.error":
        this.emit("member.error", event.data, { ...fields, target: "activity", done: true });
        break;
      case "system.notification":
        this.emit(
          "system.notification",
          {
            ...event.data,
            eventId: event.id,
            eventTimestamp: Date.parse(event.timestamp),
          },
          { ...fields, target: "activity", done: true },
        );
        break;
      case "tool.execution_start":
      case "tool.execution_complete":
      case "assistant.intent":
        this.emit("activity.event", { eventType: event.type, data: event.data }, {
          ...fields,
          target: "activity",
          done: event.type === "tool.execution_complete",
        });
        if (event.type === "tool.execution_complete") {
          this.refreshTasks(live);
          setTimeout(() => {
            if (this.live.get(live.target) === live) {
              this.refreshTasks(live);
            }
          }, 500);
        }
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

  private resolveStoredDefinition(
    definition: DynamicAgentDefinition,
  ): ResolvedAgent {
    const validated = validateAgentDefinition(definition, {
      availableAliases: new Set([...definition.canTalkTo, ...definition.canObserve]),
      allowCallerAlias: true,
    });
    if (!validated.valid || !validated.agent) {
      throw new Error(
        `Stored agent definition is invalid: ${validated.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    return validated.agent;
  }

  private claimPrimaryContext(createIfMissing: boolean): PrimaryContextClaim | undefined {
    const stored = this.db.resumablePrimaryRun(this.workspace);
    let context: AgentContext;
    let recovered = false;
    let sessionId: string | undefined;
    if (stored) {
      if (!stored.definition) {
        throw new Error(`Primary agent run "${stored.id}" has no stored definition.`);
      }
      const record = storedAgentRecord(stored.definition);
      context = {
        agentId: stored.agentId,
        target: agentTarget(stored.agentId),
        alias: stored.alias,
        runId: stored.id,
        definition: record.definition,
        agent: this.resolveStoredDefinition(record.definition),
        canTalkTo: new Set(record.canTalkToAgentIds),
        canObserve: new Set(record.canObserveAgentIds),
        mcpServers: new Set(record.mcpServers),
      };
      this.db.resumeRun(stored.id, process.pid);
      recovered = true;
      sessionId = stored.session?.sessionId;
    } else {
      if (!createIfMissing) {
        return undefined;
      }
      const definition = primaryAgentDefinition();
      const agentId = randomUUID();
      context = {
        agentId,
        target: agentTarget(agentId),
        alias: definition.id,
        runId: randomUUID(),
        definition,
        agent: this.resolveStoredDefinition(definition),
        canTalkTo: new Set(),
        canObserve: new Set(),
        mcpServers: new Set(),
      };
      this.db.createAgentRun(
        context.runId,
        context.agentId,
        context.alias,
        this.storedAgentJson(context),
        this.workspace,
        process.pid,
        true,
      );
    }

    this.primaryAgentId = context.agentId;
    this.registerAgent(context);
    try {
      const adoptedMessages = this.db.adoptPrimaryMessages(
        context.runId,
        this.workspace,
        context.agentId,
        context.target,
      );
      return { context, recovered, sessionId, adoptedMessages };
    } catch (error) {
      this.unregisterAgent(context);
      this.primaryAgentId = undefined;
      this.db.finishRun(context.runId, "interrupted", "Primary mailbox recovery failed");
      throw error;
    }
  }

  private async discardLiveRun(target: string, runId: string): Promise<void> {
    const live = this.live.get(target);
    if (!live || live.runId !== runId) {
      return;
    }
    this.live.delete(target);
    live.unsubscribe();
    await live.session.disconnect().catch(() => undefined);
    this.db.upsertSession(runId, live.session.sessionId, "disconnected");
  }

  async openPrimary(): Promise<void> {
    if (this.primaryAgentId !== undefined) {
      const existing = this.agents.get(this.primaryAgentId);
      if (existing) {
        await this.ensureAgentSession(existing.agentId);
        return;
      }
    }

    const claimed = this.claimPrimaryContext(true)!;
    const { context, recovered, sessionId, adoptedMessages } = claimed;
    this.emitAgentLifecycle("agent.loading", context, { recovered });
    try {
      if (recovered && sessionId === undefined) {
        throw new Error(
          `Primary agent run "${context.runId}" has no managed SDK session and cannot resume ` +
            "safely. Use /resume to select an existing Copilot session.",
        );
      }
      const live = await this.connectSession({
        runId: context.runId,
        target: context.target,
        agentId: context.agentId,
        alias: context.alias,
        sessionId,
        config: this.agentConfig(context),
        configSignature: this.sessionSignature(context),
        resumeExisting: recovered,
      });
      this.emitAgentLifecycle("agent.ready", context, {
        recovered,
        sessionId: live.session.sessionId,
      });
      this.emit(
        "primary.ready",
        {
          ...this.agentPayload(context),
          mode: "primary",
          recovered,
          adoptedMessages,
          sessionId: live.session.sessionId,
          runId: context.runId,
        },
        { runId: context.runId, memberId: context.target, target: "status", done: true },
      );
      queueMicrotask(() => void this.drainMailbox(context.target));
    } catch (error) {
      await this.discardLiveRun(context.target, context.runId);
      const message = error instanceof Error ? error.message : String(error);
      this.emit(
        "agent.error",
        {
          ...this.agentPayload(context),
          primary: true,
          runId: context.runId,
          message,
        },
        { runId: context.runId, memberId: context.target, target: "activity", done: true },
      );
      this.unregisterAgent(context);
      this.primaryAgentId = undefined;
      this.db.finishRun(context.runId, "interrupted", "Primary Copilot agent failed to start");
      throw error;
    }
  }

  async resumePrimarySession(sessionId: string): Promise<void> {
    const client = await this.ensureClient();
    const active = [...this.live.entries()].find(([, live]) => live.session.sessionId === sessionId);
    if (active) {
      throw new Error(`Session "${sessionId}" is already active as "${active[0]}".`);
    }
    const available = await client.listSessions({ workingDirectory: this.workspace });
    if (!available.some((session) => session.sessionId === sessionId)) {
      throw new Error(`Session "${sessionId}" was not found for this workspace.`);
    }
    const { inUse } = await client.rpc.sessions.checkInUse({ sessionIds: [sessionId] });
    if (inUse.includes(sessionId)) {
      throw new Error(`Session "${sessionId}" is active in another process.`);
    }

    let context =
      this.primaryAgentId === undefined
        ? undefined
        : this.agents.get(this.primaryAgentId);
    let claimed: PrimaryContextClaim | undefined;
    if (!context) {
      claimed = this.claimPrimaryContext(false);
      if (claimed) {
        context = claimed.context;
        this.emitAgentLifecycle("agent.loading", context, { recovered: true });
      } else {
        await this.openPrimary();
        context = this.requirePrimary();
      }
    }
    const claimedContext = claimed !== undefined;
    const primaryContext = context!;
    await this.withAgentLock(primaryContext.agentId, async () => {
      const oldLive = this.live.get(primaryContext.target);
      const oldRunId = primaryContext.runId;
      const oldSessionId =
        oldLive?.session.sessionId ?? this.db.session(oldRunId)?.sessionId;
      const runId = randomUUID();
      this.emit(
        "session.loading",
        {
          mode: "primary-loading",
          sessionId,
          target: primaryContext.target,
          agentId: primaryContext.agentId,
        },
        { runId, memberId: primaryContext.target, target: "status", done: false },
      );
      let oldRunStopped = false;
      let newRunCreated = false;
      try {
        if (oldLive) {
          oldLive.unsubscribe();
          this.live.delete(primaryContext.target);
          await oldLive.session.disconnect().catch(() => undefined);
          this.db.upsertSession(oldRunId, oldLive.session.sessionId, "disconnected");
        }
        this.db.finishRun(oldRunId, "stopped", `Resuming session ${sessionId}`);
        oldRunStopped = true;
        primaryContext.runId = runId;
        this.db.createAgentRun(
          runId,
          primaryContext.agentId,
          primaryContext.alias,
          this.storedAgentJson(primaryContext),
          this.workspace,
          process.pid,
          true,
        );
        newRunCreated = true;
        const adoptedMessages = this.db.adoptAgentMessages(
          runId,
          this.workspace,
          primaryContext.agentId,
          primaryContext.target,
        );
        const live = await this.connectSession({
          runId,
          target: primaryContext.target,
          agentId: primaryContext.agentId,
          alias: primaryContext.alias,
          sessionId,
          config: this.agentConfig(primaryContext),
          configSignature: this.sessionSignature(primaryContext),
          resumeExisting: true,
        });
        if (claimedContext) {
          this.emitAgentLifecycle("agent.ready", primaryContext, {
            recovered: true,
            sessionId: live.session.sessionId,
          });
        }
        this.emit(
          "primary.ready",
          {
            ...this.agentPayload(primaryContext),
            mode: "primary",
            recovered: true,
            sessionId,
            adoptedMessages,
            runId,
          },
          { runId, memberId: primaryContext.target, target: "status", done: true },
        );
        queueMicrotask(() => void this.drainMailbox(primaryContext.target));
      } catch (error) {
        await this.discardLiveRun(primaryContext.target, runId);
        const replacementMessage = error instanceof Error ? error.message : String(error);
        const failureReason =
          `Primary session replacement with "${sessionId}" failed: ${replacementMessage}`;
        primaryContext.runId = oldRunId;
        let durableRollbackCompleted = false;
        try {
          if (oldRunStopped) {
            this.db.resumeRun(oldRunId, process.pid);
          }
          let restoredMessages = 0;
          if (newRunCreated) {
            restoredMessages = this.db.rollbackPrimaryReplacement(
              runId,
              oldRunId,
              this.workspace,
              primaryContext.agentId,
              primaryContext.target,
              failureReason,
            );
            durableRollbackCompleted = true;
          }
          if (oldSessionId === undefined) {
            throw new Error(
              `Previous primary agent run "${oldRunId}" has no managed SDK session and cannot ` +
                "be restored safely.",
            );
          }
          const restored = await this.connectSession({
            runId: oldRunId,
            target: primaryContext.target,
            agentId: primaryContext.agentId,
            alias: primaryContext.alias,
            sessionId: oldSessionId,
            config: this.agentConfig(primaryContext),
            configSignature: this.sessionSignature(primaryContext),
            resumeExisting: true,
          });
          if (claimedContext) {
            this.emitAgentLifecycle("agent.ready", primaryContext, {
              recovered: true,
              sessionId: restored.session.sessionId,
            });
          }
          this.emit(
            "primary.ready",
            {
              ...this.agentPayload(primaryContext),
              mode: "primary",
              recovered: true,
              sessionId: restored.session.sessionId,
              runId: oldRunId,
              replacementFailed: true,
              failedRunId: newRunCreated ? runId : undefined,
              restoredMessages,
            },
            { runId: oldRunId, memberId: primaryContext.target, target: "status", done: true },
          );
          queueMicrotask(() => void this.drainMailbox(primaryContext.target));
        } catch (recoveryError) {
          await this.discardLiveRun(primaryContext.target, oldRunId);
          let disqualificationError: unknown;
          if (newRunCreated && !durableRollbackCompleted) {
            try {
              this.db.disqualifyPrimaryRun(
                runId,
                this.workspace,
                primaryContext.agentId,
                failureReason,
              );
            } catch (rollbackError) {
              disqualificationError = rollbackError;
            }
          }
          let oldRunFinalizationError: unknown;
          try {
            this.db.finishRun(
              oldRunId,
              "interrupted",
              "Previous primary session could not be restored after replacement failure",
            );
          } catch (finalizationError) {
            oldRunFinalizationError = finalizationError;
          }
          this.unregisterAgent(primaryContext);
          this.primaryAgentId = undefined;
          const recoveryMessage =
            recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
          const durableDetails = [
            disqualificationError === undefined
              ? undefined
              : `failed replacement disqualification failed: ${
                  disqualificationError instanceof Error
                    ? disqualificationError.message
                    : String(disqualificationError)
                }`,
            oldRunFinalizationError === undefined
              ? undefined
              : `old run finalization failed: ${
                  oldRunFinalizationError instanceof Error
                    ? oldRunFinalizationError.message
                    : String(oldRunFinalizationError)
                }`,
          ].filter((detail): detail is string => detail !== undefined);
          const combinedMessage =
            `${failureReason}. Restoring the previous primary session also failed: ` +
            `${recoveryMessage}` +
            (durableDetails.length === 0 ? "" : `. ${durableDetails.join("; ")}`);
          this.emit(
            "agent.error",
            {
              ...this.agentPayload(primaryContext),
              primary: true,
              runId: oldRunId,
              message: combinedMessage,
              replacementFailed: true,
              recoveryFailed: true,
              failedRunId: newRunCreated ? runId : undefined,
              failedReplacementDisqualified:
                newRunCreated && (durableRollbackCompleted || disqualificationError === undefined),
            },
            { runId: oldRunId, memberId: primaryContext.target, target: "activity", done: true },
          );
          throw new Error(combinedMessage, { cause: error });
        }
        throw error;
      }
    });
  }

  private async withAgentLock<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.agentLocks.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = previous.then(() => gate);
    this.agentLocks.set(agentId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.agentLocks.get(agentId) === tail) {
        this.agentLocks.delete(agentId);
      }
    }
  }

  private async drainPendingSpawns(callerAgentId: string): Promise<void> {
    while (this.pendingSpawns.length > 0) {
      const pending = this.pendingSpawns[0]!;
      if (pending.callerAgentId !== callerAgentId) {
        return;
      }
      const caller = this.agents.get(callerAgentId);
      const live = caller && this.live.get(caller.target);
      if (!caller || live?.busy) {
        return;
      }
      this.pendingSpawns.shift();
      try {
        await this.spawnAgentsForCaller(caller, pending.request);
      } catch (error) {
        this.emit(
          "agent.error",
          {
            message: error instanceof Error ? error.message : String(error),
            aliases: pending.request.agents.map((definition) => definition.id),
          },
          { memberId: caller.target, target: "activity", done: true },
        );
      }
    }
  }

  /**
   * Starts every agent named by an ephemeral spawn request. Each agent gets its own
   * durable UUID, run, SDK session, and mailbox and starts independently: one
   * failure never prevents the others from starting.
   */
  async spawnAgents(request: SpawnAgentsRequest): Promise<Array<Record<string, unknown>>> {
    await this.openPrimary();
    return this.spawnAgentsForCaller(this.requirePrimary(), request);
  }

  private async spawnAgentsForCaller(
    caller: AgentContext,
    request: SpawnAgentsRequest,
  ): Promise<Array<Record<string, unknown>>> {
    this.requireCallingPrimary(caller.agentId);
    const resolved = this.resolveSpawnRequest(caller, request);
    const mcpServers = await this.availableMcpServers();
    this.assertMcpCeiling(request.agents, mcpServers);

    const batchAliases = new Map<string, string>();
    for (const agent of resolved) {
      batchAliases.set(agent.alias, randomUUID());
    }
    const contexts: AgentContext[] = [];
    for (const [index, agent] of resolved.entries()) {
      const agentId = batchAliases.get(agent.alias)!;
      const canTalkTo = this.resolveGrantSelectors(
        agent.recipientSelectors,
        caller,
        batchAliases,
        agentId,
      );
      const canObserve = this.resolveGrantSelectors(
        agent.observeSelectors,
        caller,
        batchAliases,
        agentId,
      );
      const context: AgentContext = {
        agentId,
        target: agentTarget(agentId),
        alias: agent.alias,
        runId: randomUUID(),
        definition: {
          ...request.agents[index]!,
          canTalkTo: this.grantDetails(canTalkTo),
          canObserve: this.grantDetails(canObserve),
        },
        agent,
        canTalkTo,
        canObserve,
        mcpServers: new Set(mcpServers),
      };
      this.registerAgent(context);
      try {
        this.db.createAgentRun(
          context.runId,
          agentId,
          context.alias,
          this.storedAgentJson(context),
          this.workspace,
          process.pid,
        );
      } catch (error) {
        this.unregisterAgent(context);
        for (const created of contexts) {
          this.unregisterAgent(created);
          this.db.finishRun(created.runId, "interrupted", "Agent batch registration failed");
        }
        throw error;
      }
      contexts.push(context);
      this.emitAgentLifecycle("agent.loading", context, { recovered: false });
    }

    const previousCallerTalk = caller.canTalkTo;
    const previousCallerObserve = caller.canObserve;
    caller.canTalkTo = new Set(caller.canTalkTo);
    caller.canObserve = new Set(caller.canObserve);
    for (const alias of request.callerCanTalkTo) {
      caller.canTalkTo.add(batchAliases.get(alias)!);
    }
    for (const alias of request.callerCanObserve) {
      caller.canObserve.add(batchAliases.get(alias)!);
    }
    try {
      this.db.updateAgentRun(caller.runId, caller.alias, this.storedAgentJson(caller));
    } catch (error) {
      caller.canTalkTo = previousCallerTalk;
      caller.canObserve = previousCallerObserve;
      for (const context of contexts) {
        this.unregisterAgent(context);
        this.db.finishRun(
          context.runId,
          "interrupted",
          "Could not persist the spawning caller's ACL grants",
        );
      }
      throw error;
    }

    const results: Array<Record<string, unknown>> = [];
    for (const context of contexts) {
      try {
        const live = await this.ensureAgentSession(context.agentId);
        this.emitAgentLifecycle("agent.ready", context, {
          recovered: false,
          sessionId: live.session.sessionId,
        });
        await this.sendUserPrompt(context.target, context.agent.task);
        results.push({
          ...this.agentPayload(context),
          runId: context.runId,
          sessionId: live.session.sessionId,
          started: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.failAgent(context, message);
        results.push({
          ...this.agentPayload(context),
          runId: context.runId,
          started: false,
          error: message,
        });
      }
    }
    return results;
  }

  /** Resumes exactly one durable agent run; there is no group recovery. */
  async resumeAgent(runId: string): Promise<void> {
    const stored = this.db.agentRun(runId, this.workspace);
    if (!stored) {
      throw new Error(`Agent run "${runId}" was not found for this workspace.`);
    }
    if (stored.isPrimary) {
      throw new Error("The primary agent is resumed through the main Copilot buffer.");
    }
    return this.withAgentLock(stored.agentId, () => this.resumeAgentUnlocked(runId));
  }

  private async resumeAgentUnlocked(runId: string): Promise<void> {
    const stored = this.db.agentRun(runId, this.workspace);
    if (!stored) {
      throw new Error(`Agent run "${runId}" was not found for this workspace.`);
    }
    if (stored.status === "active") {
      throw new Error(`Agent run "${runId}" is owned by another active Neovim instance.`);
    }
    if (!stored.definition) {
      throw new Error(`Agent run "${runId}" has no stored definition and cannot resume.`);
    }
    if (!stored.session) {
      throw new Error(`Agent run "${runId}" has no managed SDK session and cannot resume safely.`);
    }
    if (this.agents.has(stored.agentId)) {
      throw new Error(`Agent "${stored.alias}" is already active.`);
    }
    const record = storedAgentRecord(stored.definition);
    const definition = record.definition;
    const resolved = this.resolveStoredDefinition(definition);
    this.assertPermissionCeiling([definition]);
    this.assertAliasesAvailable([definition.id], stored.agentId);
    await this.openPrimary();
    // Recovery must not widen the agent's environment: its ceiling is the MCP server
    // set captured when it was created, narrowed to what the primary currently exposes.
    // Servers added to the workspace since then stay out of reach, and a server the
    // definition still requests but that is gone fails the recovery explicitly.
    const available = await this.availableMcpServers();
    const mcpServers = new Set(record.mcpServers.filter((server) => available.has(server)));
    this.assertMcpCeiling([definition], mcpServers);

    this.db.resumeRun(runId, process.pid);
    const context: AgentContext = {
      agentId: stored.agentId,
      target: agentTarget(stored.agentId),
      alias: definition.id,
      runId,
      definition,
      agent: resolved,
      canTalkTo: new Set(record.canTalkToAgentIds),
      canObserve: new Set(record.canObserveAgentIds),
      mcpServers,
    };
    this.registerAgent(context);
    this.db.updateAgentRun(runId, context.alias, this.storedAgentJson(context));
    this.emitAgentLifecycle("agent.loading", context, {
      recovered: true,
      ...(stored.session ? { sessionId: stored.session.sessionId } : {}),
    });
    try {
      const live = await this.connectSession({
        runId,
        target: context.target,
        agentId: context.agentId,
        alias: context.alias,
        sessionId: stored.session.sessionId,
        config: this.agentConfig(context),
        configSignature: this.sessionSignature(context),
        resumeExisting: true,
      });
      this.emitAgentLifecycle("agent.ready", context, {
        recovered: true,
        sessionId: live.session.sessionId,
      });
      const target = context.target;
      queueMicrotask(() => void this.drainMailbox(target));
    } catch (error) {
      await this.failAgent(context, "Agent recovery failed");
      throw error;
    }
  }

  /** Stops one agent; accepts an alias, agent UUID, "agent:<uuid>" target, or run id. */
  async stopAgent(agentRef: string, reason = "Agent stopped by user"): Promise<void> {
    const context = this.requireAgent(agentRef);
    if (context.agentId === this.primaryAgentId) {
      throw new Error("The primary agent cannot be stopped independently of the host.");
    }
    return this.withAgentLock(context.agentId, () => this.stopAgentUnlocked(context, reason));
  }

  private async stopAgentUnlocked(context: AgentContext, reason: string): Promise<void> {
    if (this.agents.get(context.agentId) !== context) {
      throw new Error(`Agent "${context.alias}" is no longer active.`);
    }
    const live = this.live.get(context.target);
    this.live.delete(context.target);
    if (live) {
      live.unsubscribe();
      await live.session.disconnect().catch(() => undefined);
      this.db.upsertSession(context.runId, live.session.sessionId, "disconnected");
    }
    this.unregisterAgent(context);
    this.db.finishRun(context.runId, "stopped", reason);
    this.emit(
      "agent.stopped",
      { ...this.agentPayload(context), runId: context.runId, reason },
      { runId: context.runId, memberId: context.target, target: "status", done: true },
    );
  }

  async updateAgent(agentRef: string, update: AgentUpdate): Promise<Record<string, unknown>> {
    await this.openPrimary();
    return this.updateAgentForCaller(this.requirePrimary(), agentRef, update);
  }

  private async updateAgentForCaller(
    caller: AgentContext,
    agentRef: string,
    update: AgentUpdate,
  ): Promise<Record<string, unknown>> {
    this.requireCallingPrimary(caller.agentId);
    const context = this.requireAgent(agentRef);
    if (context.agentId === caller.agentId) {
      throw new Error("The primary agent definition is managed by the host bootstrap.");
    }
    return this.withAgentLock(
      context.agentId,
      () => this.updateAgentUnlocked(caller, context, update),
    );
  }

  private async updateAgentUnlocked(
    caller: AgentContext,
    context: AgentContext,
    update: AgentUpdate,
  ): Promise<Record<string, unknown>> {
    if (this.agents.get(context.agentId) !== context) {
      throw new Error(`Agent "${context.alias}" is no longer active.`);
    }
    const definition = update.definition;
    if (definition.id !== context.alias) {
      this.assertAliasesAvailable([definition.id], context.agentId);
    }
    this.assertPermissionCeiling([definition]);
    this.assertMcpCeiling([definition], context.mcpServers);
    const availableAliases = new Set(
      [...this.aliasIndex.keys()].filter((alias) => alias !== context.alias),
    );
    availableAliases.delete(caller.alias);
    for (const reserved of this.db.reservedAgentAliases(this.workspace)) {
      if (reserved.agentId !== context.agentId) {
        availableAliases.add(reserved.alias);
      }
    }
    const validated = validateAgentDefinition(definition, {
      availableAliases,
    });
    if (!validated.valid || !validated.agent) {
      throw new Error(
        `Agent "${context.alias}" update is invalid: ${validated.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("; ")}`,
      );
    }

    const nextCanTalkTo = this.resolveGrantSelectors(
      validated.agent.recipientSelectors,
      caller,
      new Map<string, string>(),
      context.agentId,
    );
    const nextCanObserve = this.resolveGrantSelectors(
      validated.agent.observeSelectors,
      caller,
      new Map<string, string>(),
      context.agentId,
    );
    const previousDefinition = context.definition;
    const previousAgent = context.agent;
    const previousAlias = context.alias;
    const previousCanTalkTo = context.canTalkTo;
    const previousCanObserve = context.canObserve;
    const previousCallerCanTalkTo = caller.canTalkTo;
    const previousCallerCanObserve = caller.canObserve;
    caller.canTalkTo = new Set(caller.canTalkTo);
    caller.canObserve = new Set(caller.canObserve);
    if (update.callerCanTalk === true) {
      caller.canTalkTo.add(context.agentId);
    } else if (update.callerCanTalk === false) {
      caller.canTalkTo.delete(context.agentId);
    }
    if (update.callerCanObserve === true) {
      caller.canObserve.add(context.agentId);
    } else if (update.callerCanObserve === false) {
      caller.canObserve.delete(context.agentId);
    }
    if (this.aliasIndex.get(previousAlias) === context.agentId) {
      this.aliasIndex.delete(previousAlias);
    }
    const normalizedDefinition = {
      ...definition,
      canTalkTo: this.grantDetails(nextCanTalkTo),
      canObserve: this.grantDetails(nextCanObserve),
    };
    context.alias = definition.id;
    this.aliasIndex.set(context.alias, context.agentId);
    context.definition = normalizedDefinition;
    context.agent = validated.agent;
    context.canTalkTo = nextCanTalkTo;
    context.canObserve = nextCanObserve;
    const live = this.live.get(context.target);
    if (live) {
      live.alias = context.alias;
    }
    try {
      this.db.updateAgentRun(context.runId, context.alias, this.storedAgentJson(context));
      this.db.updateAgentRun(caller.runId, caller.alias, this.storedAgentJson(caller));
    } catch (error) {
      this.aliasIndex.delete(context.alias);
      context.alias = previousAlias;
      this.aliasIndex.set(previousAlias, context.agentId);
      context.definition = previousDefinition;
      context.agent = previousAgent;
      context.canTalkTo = previousCanTalkTo;
      context.canObserve = previousCanObserve;
      caller.canTalkTo = previousCallerCanTalkTo;
      caller.canObserve = previousCallerCanObserve;
      if (live) live.alias = previousAlias;
      this.db.updateAgentRun(context.runId, context.alias, this.storedAgentJson(context));
      this.db.updateAgentRun(caller.runId, caller.alias, this.storedAgentJson(caller));
      throw error;
    }

    let reconnected = false;
    try {
      reconnected = await this.reconnectIfConfigChanged(context);
    } catch (error) {
      // The reconnect failed, so restore the previous definition durably and in
      // memory rather than leaving a committed update the live session never
      // received, then surface the failure.
      this.aliasIndex.delete(context.alias);
      context.alias = previousAlias;
      this.aliasIndex.set(previousAlias, context.agentId);
      context.definition = previousDefinition;
      context.agent = previousAgent;
      context.canTalkTo = previousCanTalkTo;
      context.canObserve = previousCanObserve;
      caller.canTalkTo = previousCallerCanTalkTo;
      caller.canObserve = previousCallerCanObserve;
      if (live) live.alias = previousAlias;
      this.db.updateAgentRun(context.runId, context.alias, this.storedAgentJson(context));
      this.db.updateAgentRun(caller.runId, caller.alias, this.storedAgentJson(caller));
      throw error;
    }
    this.emitAgentLifecycle("agent.updated", context, { reconnected });
    return {
      action: "updated",
      ...this.agentPayload(context),
      runId: context.runId,
      reconnected,
    };
  }

  /**
   * Reconnects an agent whenever anything its SessionConfig is derived from changed:
   * prompt, task, model, reasoning, permissions, MCP subset, or ACL. The session id
   * and conversation history are preserved.
   */
  private async reconnectIfConfigChanged(context: AgentContext): Promise<boolean> {
    const live = this.live.get(context.target);
    if (!live) {
      return false;
    }
    if (this.sessionSignature(context) === live.configSignature) {
      return false;
    }
    await this.reconnectAgent(context);
    return true;
  }

  // Reconnects one agent in place, preserving its SDK session id and history while
  // rebuilding its complete session config from the current definition. Several
  // callers can be waiting on the same in-flight connection, so each pass re-enters
  // the shared guard (which joins rather than duplicates) and then verifies the
  // resulting session really was built from the current config; a session joined
  // from an older connect is replaced on the next pass.
  private async reconnectAgent(context: AgentContext): Promise<void> {
    const target = context.target;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const pending = this.connecting.get(target);
      if (pending) {
        // Wait for the connection already in progress before replacing it; its own
        // caller reports any failure, so only its completion matters here.
        await pending.then(
          () => undefined,
          () => undefined,
        );
      }
      const desired = this.sessionSignature(context);
      const live = this.live.get(target);
      if (live && live.configSignature === desired) {
        return;
      }
      const connected = await this.trackConnection(target, async () => {
        const existing = this.live.get(target);
        const sessionId = existing?.session.sessionId ?? this.db.session(context.runId)?.sessionId;
        if (existing) {
          existing.unsubscribe();
          this.live.delete(target);
          await existing.session.disconnect().catch(() => undefined);
        }
        return this.establishSession({
          runId: context.runId,
          target,
          agentId: context.agentId,
          alias: context.alias,
          sessionId,
          config: this.agentConfig(context),
          configSignature: this.sessionSignature(context),
          resumeExisting: true,
          suppressHistory: true,
        });
      });
      if (connected.configSignature === this.sessionSignature(context)) {
        return;
      }
    }
    throw new Error(
      `Agent "${context.alias}" could not be reconnected with its current configuration.`,
    );
  }

  // Tears down an agent that could not start or recover, closing its run so no
  // half-started agent stays addressable. The failure is reported as an error and
  // then as a terminal agent.stopped, so the UI always sees the same lifecycle
  // ending for a failed agent as for one that was stopped deliberately.
  private async failAgent(context: AgentContext, message: string): Promise<void> {
    const live = this.live.get(context.target);
    if (live) {
      live.unsubscribe();
      this.live.delete(context.target);
      await live.session.disconnect().catch(() => undefined);
    }
    this.unregisterAgent(context);
    this.db.finishRun(context.runId, "interrupted", message);
    const primaryTarget =
      this.primaryAgentId === undefined
        ? context.target
        : this.agents.get(this.primaryAgentId)?.target ?? context.target;
    this.emit(
      "agent.error",
      { ...this.agentPayload(context), runId: context.runId, message },
      { runId: context.runId, memberId: primaryTarget, target: "activity", done: true },
    );
    this.emit(
      "agent.stopped",
      { ...this.agentPayload(context), runId: context.runId, reason: message, failed: true },
      { runId: context.runId, memberId: context.target, target: "status", done: true },
    );
  }

  private agentPayload(context: AgentContext): Record<string, unknown> {
    return {
      target: context.target,
      agentId: context.agentId,
      alias: context.alias,
      displayName: context.agent.displayName,
      description: context.agent.description,
      task: context.agent.task,
      recipients: this.grantDetails(context.canTalkTo),
      observes: this.grantDetails(context.canObserve),
      ...(context.agentId === this.primaryAgentId ? { primary: true } : {}),
      ...(context.agent.ui === undefined ? {} : { ui: context.agent.ui }),
    };
  }

  private emitAgentLifecycle(
    type: string,
    context: AgentContext,
    extra: { recovered?: boolean; sessionId?: string; reconnected?: boolean },
  ): void {
    this.emit(
      type,
      { ...this.agentPayload(context), runId: context.runId, ...extra },
      {
        runId: context.runId,
        memberId: context.target,
        target: "status",
        done: type !== "agent.loading",
      },
    );
  }

  recoverableAgentRuns(): Array<Record<string, unknown>> {
    return this.db.resumableAgentRuns(this.workspace).flatMap((run) => {
      if (!run.definition) {
        return [];
      }
      // A row whose persisted definition cannot be parsed can no longer be resumed,
      // so it is not offered as a recovery candidate.
      let record: StoredAgentRecord;
      try {
        record = storedAgentRecord(run.definition);
      } catch {
        return [];
      }
      return [{
        id: run.id,
        runId: run.id,
        target: agentTarget(run.agentId),
        agentId: run.agentId,
        alias: run.alias,
        displayName: record.definition.displayName,
        description: record.definition.description,
        task: record.definition.task,
        recipients: record.canTalkToAgentIds.map(agentTarget),
        observes: record.canObserveAgentIds.map(agentTarget),
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        ...(run.session ? { sessionId: run.session.sessionId } : {}),
      }];
    });
  }

  async sendUserPrompt(target: string, content: string): Promise<string> {
    const live = await this.activeSession(target);
    const runId = live.runId;
    const id = randomUUID();
    this.db.enqueueMessage(id, runId, "user", live.target, "user", content);
    try {
      const sdkMessageId = await live.session.send({ prompt: content, mode: "immediate" });
      this.db.completeMessage(id);
      this.emit(
        "prompt.accepted",
        { id, sdkMessageId, source: "user", target: live.target, content },
        { runId, memberId: live.target, target: "conversation" },
      );
      return sdkMessageId;
    } catch (error) {
      this.db.failMessage(id, error instanceof Error ? error.message : String(error), true);
      throw error;
    }
  }

  /** Drains one recipient's own durable mailbox; every mailbox drains independently. */
  private async drainMailbox(target: string): Promise<void> {
    let live = this.live.get(target);
    if (!live && target.startsWith(AGENT_TARGET_PREFIX)) {
      const agentId = target.slice(AGENT_TARGET_PREFIX.length);
      if (!this.agents.has(agentId)) {
        return;
      }
      try {
        live = await this.ensureAgentSession(agentId);
      } catch (error) {
        this.emit(
          "mailbox.failed",
          {
            message: `The recipient session could not be started: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          { memberId: target, target: "messages" },
        );
        return;
      }
    }
    if (!live || live.busy) {
      return;
    }
    const pending = this.db.claimMessages(live.runId, target);
    for (const message of pending) {
      if (message.kind === "user") {
        this.db.completeMessage(message.id);
        continue;
      }
      const prompt =
        `<agent_message id="${message.id}" source="${message.source}">\n` +
        `${message.content}\n` +
        "</agent_message>\n\n" +
        "Process this durable message from another Copilot agent. Respond or act as appropriate, " +
        "and use the relevant send tool if the sender needs a direct answer.";
      try {
        await live.session.send({ prompt, mode: "immediate" });
        this.db.completeMessage(message.id);
        const source = this.resolveAgentRef(message.source);
        this.emit(
          "mailbox.delivered",
          {
            ...message,
            source: source?.alias ?? message.source,
            ...(source ? { sourceAgentId: source.agentId } : {}),
            status: "delivered",
          },
          { runId: live.runId, memberId: live.target, target: "messages" },
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
          { runId: live.runId, memberId: live.target, target: "messages" },
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
    live.foregroundAbortSequence = live.foregroundTurnSequence;
    try {
      await live.session.abort();
    } catch (error) {
      live.foregroundAbortSequence = undefined;
      throw error;
    }
  }

  status(): unknown {
    const primary =
      this.primaryAgentId === undefined ? undefined : this.agents.get(this.primaryAgentId);
    const primaryLive = primary === undefined ? undefined : this.live.get(primary.target);
    return {
      primaryAgentId: primary?.agentId,
      primaryTarget: primary?.target,
      primary:
        primary === undefined
          ? undefined
          : {
              ...this.agentPayload(primary),
              runId: primary.runId,
              ...(primaryLive ? { sessionId: primaryLive.session.sessionId } : {}),
              state: this.agentState(primary),
            },
      agents: [...this.agents.values()].map((context) => {
        const live = this.live.get(context.target);
        return {
          ...this.agentPayload(context),
          runId: context.runId,
          ...(live ? { sessionId: live.session.sessionId } : {}),
          state: this.agentState(context),
        };
      }),
      sessions: [...this.live.values()].map((live) => ({
        target: live.target,
        agentId: live.agentId,
        alias: live.alias,
        sessionId: live.session.sessionId,
        state: live.foregroundBusy ? "busy" : "idle",
      })),
    };
  }

  async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    clearInterval(this.recoveryTimer);
    for (const pending of this.pendingPermissions.values()) {
      pending.respond(reject(`Permission request cancelled: ${reason}`));
    }
    this.pendingPermissions.clear();
    const runIds = new Set<string>();
    // Every agent owns its own run, so each is interrupted independently.
    for (const context of this.agents.values()) {
      runIds.add(context.runId);
    }
    for (const live of this.live.values()) {
      live.unsubscribe();
    }
    this.live.clear();
    this.connecting.clear();
    this.agents.clear();
    this.aliasIndex.clear();
    this.pendingSpawns.length = 0;
    this.primaryAgentId = undefined;
    for (const runId of runIds) {
      this.db.finishRun(runId, "interrupted", reason);
    }
    if (this.client) {
      const client = this.client;
      this.client = undefined;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          client.stop(),
          new Promise<never>((_, rejectShutdown) => {
            timer = setTimeout(() => rejectShutdown(new Error("Copilot shutdown timed out")), 4_000);
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
