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
  STANDARD_ALIAS,
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

export const STANDARD_TARGET = "standard";
export const AGENT_TARGET_PREFIX = "agent:";

/** Builds the runtime/UI target id of a spawned agent from its durable UUID. */
export function agentTarget(agentId: string): string {
  return `${AGENT_TARGET_PREFIX}${agentId}`;
}

export type TargetRoute =
  | { kind: "standard" }
  | { kind: "agent"; agentId: string };

/**
 * Decides how a UI/runtime target id routes. Only the exact id "standard" reaches
 * the Standard supervisor; every spawned agent is addressed as "agent:<uuid>" with
 * its durable runtime UUID. Anything else is malformed and rejected rather than
 * silently falling back to Standard.
 */
export function routeTarget(target: string): TargetRoute {
  if (target === STANDARD_TARGET) {
    return { kind: "standard" };
  }
  if (target.startsWith(AGENT_TARGET_PREFIX)) {
    const agentId = target.slice(AGENT_TARGET_PREFIX.length);
    if (agentId.length > 0) {
      return { kind: "agent", agentId };
    }
  }
  throw new Error(`Target "${target}" is neither "standard" nor an "agent:<uuid>" target.`);
}

/** One live SDK session: the Standard supervisor or exactly one standalone agent. */
interface LiveSession {
  session: CopilotSession;
  runId: string;
  // Runtime/UI identity: "standard" or "agent:<uuid>".
  target: string;
  // Durable agent UUID, or undefined for the Standard supervisor session.
  agentId: string | undefined;
  // Tool-safe alias; "standard" for the supervisor session.
  alias: string;
  // Deterministic signature of everything this session's SessionConfig was built
  // from — the complete agent definition plus its resolved outgoing peer targets.
  // Any difference means the live session must be reconnected with a rebuilt config
  // while preserving its session id and history.
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
 * One standalone durable agent. Every agent owns its own DB run, SDK session, and
 * mailbox; agents are never grouped, so this is the complete runtime identity.
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
  /** MCP server ceiling captured from the Standard session when the agent started. */
  mcpServers: Set<string>;
}

/** One outgoing communication edge, resolved from an alias to a concrete target. */
interface PeerBinding {
  alias: string;
  agentId: string | undefined;
  target: string | undefined;
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
 * the Standard supervisor and every agent build from it through
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
  standardCanTalk: boolean;
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
  return {
    definition: parsed.definition,
    mcpServers: parsed.mcpServers.filter((server): server is string => typeof server === "string"),
    standardCanTalk: parsed.standardCanTalk === true,
  };
}

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
 * the single native MCP-server source that both the Standard session and every
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
 * single typed object that drives both the Standard session and every agent.
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
 * session — Standard and every agent alike — passes through here so children
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
 * canonical native policy layered by {@link applyNativePolicy}. Both the Standard
 * supervisor and every agent start from this exact object; the instance only
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
  // command. Both the Standard supervisor and every agent inherit it; agent
  // settings only overlay or restrict it, so there is one source of truth.
  private readonly policy: NativePolicy;
  // The Standard supervisor session's run. It stays connected for the lifetime of
  // the host and supervises agents without any implied permission to message them.
  private standard: { runId: string } | undefined;
  // Every active standalone agent, keyed by its durable runtime UUID.
  private readonly agents = new Map<string, AgentContext>();
  // Alias index over `agents`; aliases are unique among active agents and
  // recoverable agent runs, so an alias always resolves to at most one UUID.
  private readonly aliasIndex = new Map<string, string>();
  private shuttingDown = false;
  // Spawn requests accepted while Standard is busy. Each queued request starts its
  // agents independently once Standard becomes idle.
  private readonly pendingSpawns: SpawnAgentsRequest[] = [];
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
    if (route.kind === "standard") {
      if (!this.standard) {
        await this.openStandard();
      }
      const live = this.live.get(STANDARD_TARGET);
      if (!live) {
        throw new Error(`Target "${target}" is not active.`);
      }
      return live;
    }
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
  // (nativeSessionScaffold). Standard and every agent build from that identical base
  // and then only narrow or deliberately override individual fields, so there is one
  // source of truth for inherited defaults. The uiTarget is the runtime routing id
  // ("standard" or "agent:<uuid>").
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
    // Start from the identical native base the Standard session uses. The base has
    // already layered the canonical native policy, so everything below only narrows
    // or deliberately overrides individual inherited fields.
    const agent = context.agent;
    const config = this.baseSessionConfig(context.target, agent.permission);
    config.includeSubAgentStreamingEvents = false;
    config.reasoningSummary = agent.reasoningSummary;
    config.systemMessage = { mode: "append", content: agent.initialPrompt };
    config.tools = this.createPeerMessageTools(context);
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

  private standardSessionConfig(): SessionConfig {
    // The Standard supervisor uses the native base unchanged — native tool/MCP and
    // model/reasoning policy are already layered by baseSessionConfig — adding only
    // its agent-management tools.
    const config = this.baseSessionConfig(STANDARD_TARGET, undefined);
    config.reasoningSummary = "detailed";
    config.tools = [
      this.spawnAgentsTool(),
      this.updateAgentTool(),
      this.removeAgentTool(),
      this.sendToAgentTool(),
      this.listAgentsTool(),
    ];
    return config;
  }

  private spawnAgentsTool(): Tool<any> {
    return defineTool("spawn_agents", {
      description:
        "Spawn one or more standalone durable Copilot agents when the user asks for additional " +
        "agents or when independent planning, implementation, testing, or review would materially " +
        "improve the result. Define every agent completely at runtime: a focused prompt, a concrete " +
        "initial task, least-privilege permissions, only the MCP servers it needs, and directional " +
        "canTalkTo recipients. Each recipient becomes a dedicated send_to_<alias> tool, and the " +
        'reserved alias "standard" lets an agent message this session. Communication is denied by ' +
        "default in both directions: list an alias in standardCanTalkTo to allow this session to " +
        "message that agent. This request is not a group — every agent gets its own durable " +
        "session, run, and mailbox, and each starts and can be recovered independently once this " +
        "Standard turn becomes idle.",
      parameters: spawnAgentsSchema,
      skipPermission: true,
      defer: "never",
      handler: (request) => {
        const spawn = request as SpawnAgentsRequest;
        const resolved = this.resolveSpawnRequest(spawn);
        this.pendingSpawns.push(spawn);
        this.emit(
          "agents.requested",
          {
            count: resolved.length,
            agents: resolved.map((agent) => ({
              alias: agent.alias,
              displayName: agent.displayName,
              description: agent.description,
              task: agent.task,
              recipients: [...agent.recipients],
              standardCanTalk: agent.standardCanTalk,
            })),
            standardCanTalkTo: [...spawn.standardCanTalkTo],
            startsWhen: "session.idle",
          },
          { memberId: STANDARD_TARGET, target: "activity", done: true },
        );
        return {
          accepted: true,
          agents: resolved.map((agent) => agent.alias),
          message:
            "Each agent starts independently after this Standard Copilot turn becomes idle.",
        };
      },
    });
  }

  private updateAgentTool(): Tool<any> {
    return defineTool("update_agent", {
      description:
        "Replace the complete definition of one active agent in place, without disturbing this " +
        "session or any other agent. Identify the agent by alias or by its agent id; the alias is " +
        "durable and cannot be changed. Provide a complete definition — prompt, task, permissions, " +
        "MCP servers, and canTalkTo — which must respect the permission and MCP ceilings. Set " +
        "standardCanTalk to grant or revoke this session's permission to message the agent. If the " +
        "agent's outgoing recipients change, its live session is reconnected with updated " +
        "send_to_<alias> tools while preserving its session id and history.",
      parameters: z.object({
        agent: z.string().min(1).describe("Alias or agent id of the active agent to update."),
        definition: dynamicAgentSchema.describe(
          "Complete replacement definition; its id must equal the agent's current alias.",
        ),
        standardCanTalk: z
          .boolean()
          .optional()
          .describe(
            "Whether this Standard session may message the agent; omit to keep the current grant.",
          ),
      }),
      skipPermission: true,
      defer: "never",
      handler: async ({ agent, definition, standardCanTalk }) => {
        const summary = await this.updateAgent(agent, {
          definition: definition as DynamicAgentDefinition,
          ...(standardCanTalk === undefined ? {} : { standardCanTalk }),
        });
        return { accepted: true, ...summary };
      },
    });
  }

  private removeAgentTool(): Tool<any> {
    return defineTool("remove_agent", {
      description:
        "Stop and remove one active agent, identified by alias or agent id, without disturbing " +
        "this session or any other agent. The agent is disconnected, its run is closed, and every " +
        "remaining agent that could message it has that recipient pruned and is reconnected with " +
        "updated tools while preserving its history.",
      parameters: z.object({
        agent: z.string().min(1).describe("Alias or agent id of the active agent to remove."),
        reason: z.string().min(1).optional().describe("Optional reason recorded on the run."),
      }),
      skipPermission: true,
      defer: "never",
      handler: async ({ agent, reason }) => {
        const context = this.requireAgent(agent);
        await this.stopAgent(context.agentId, reason ?? "Agent removed by Standard Copilot");
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

  private sendToAgentTool(): Tool<any> {
    return defineTool("send_to_agent", {
      description:
        "Send a durable asynchronous message to one active agent, identified by alias or agent id. " +
        "This is only permitted for agents explicitly granted to this session through " +
        "standardCanTalkTo (or a later update_agent); messaging any other agent is rejected.",
      parameters: z.object({
        agent: z.string().min(1).describe("Alias or agent id of the recipient agent."),
        subject: z.string().min(1).optional(),
        message: z.string().min(1),
      }),
      skipPermission: true,
      defer: "never",
      handler: ({ agent, subject, message }) => {
        const context = this.requireAgent(agent);
        if (!context.agent.standardCanTalk) {
          throw new Error(
            `Standard Copilot is not permitted to message agent "${context.alias}". Grant it with ` +
              "standardCanTalkTo when spawning the agent, or with update_agent.",
          );
        }
        const id = this.enqueueDurableMessage(
          STANDARD_ALIAS,
          { runId: context.runId, target: context.target, alias: context.alias },
          subject,
          message,
          STANDARD_TARGET,
        );
        return { deliveredToMailbox: context.alias, messageId: id };
      },
    });
  }

  private listAgentsTool(): Tool<any> {
    return defineTool("list_agents", {
      description:
        "List every currently active standalone agent with its alias, agent id, task, outgoing " +
        "recipients, and whether this session is permitted to message it.",
      parameters: z.object({}),
      skipPermission: true,
      defer: "never",
      handler: () => ({
        agents: [...this.agents.values()].map((context) => ({
          ...this.agentPayload(context),
          state: this.agentState(context),
        })),
      }),
    });
  }

  /** Validates a spawn request and every uniqueness/ceiling rule it must satisfy. */
  private resolveSpawnRequest(request: SpawnAgentsRequest): ResolvedAgent[] {
    const validated = validateSpawnRequest(request);
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
      const activeAgentId = this.aliasIndex.get(alias);
      if (activeAgentId !== undefined && activeAgentId !== ignoreAgentId) {
        throw new Error(`Alias "${alias}" is already used by an active agent.`);
      }
      if (
        this.pendingSpawns.some((pending) =>
          pending.agents.some((definition) => definition.id === alias))
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
      if (context.runId === agentRef) {
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
      standardCanTalk: context.agent.standardCanTalk,
    };
    return JSON.stringify(record);
  }

  private async availableMcpServers(): Promise<Set<string>> {
    const standard = this.live.get(STANDARD_TARGET);
    if (!standard) {
      return new Set();
    }
    return new Set((await standard.session.rpc.mcp.list()).servers.map((server) => server.name));
  }

  /**
   * Resolves an agent's outgoing ACL aliases to concrete targets at configuration
   * time. An alias that is not currently active resolves to no target; its tool is
   * still created so the model gets an explicit "not active" error instead of a
   * silently dropped message.
   */
  private peerBindings(agent: ResolvedAgent): PeerBinding[] {
    return [...agent.recipients].sort().map((alias) => {
      if (alias === STANDARD_ALIAS) {
        return { alias, agentId: undefined, target: STANDARD_TARGET };
      }
      const agentId = this.aliasIndex.get(alias);
      return {
        alias,
        agentId,
        target: agentId === undefined ? undefined : agentTarget(agentId),
      };
    });
  }

  /**
   * The complete signature of the SessionConfig an agent would be connected with
   * right now: its full definition (prompt, task, model, reasoning, permissions, MCP
   * subset, ACL) and the concrete targets its peer aliases currently resolve to. Any
   * change here — not just a peer change — requires reconnecting the live session.
   */
  private sessionSignature(context: AgentContext): string {
    return stableStringify({
      definition: context.definition,
      mcpCeiling: [...context.mcpServers].sort(),
      peers: this.peerBindings(context.agent).map((binding) => [
        binding.alias,
        binding.target ?? null,
      ]),
    });
  }

  private standardRecipient(): MailboxRecipient {
    if (!this.standard || !this.live.has(STANDARD_TARGET)) {
      throw new Error("The Standard Copilot session is not running.");
    }
    return { runId: this.standard.runId, target: STANDARD_TARGET, alias: STANDARD_ALIAS };
  }

  private agentRecipient(alias: string, resolvedAgentId: string | undefined): MailboxRecipient {
    const agentId = resolvedAgentId ?? this.aliasIndex.get(alias);
    const context = agentId === undefined ? undefined : this.agents.get(agentId);
    if (!context || context.alias !== alias) {
      throw new Error(`Agent "${alias}" is not active; the message was not delivered.`);
    }
    return { runId: context.runId, target: context.target, alias: context.alias };
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
      sourceAlias,
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

  /**
   * Builds the dedicated outgoing send tools for one agent: exactly one
   * `send_to_<alias>` per entry in its explicit ACL, plus `send_to_standard` only
   * when its canTalkTo contains the reserved alias. The ACL is re-enforced inside
   * every handler so a stale tool can never widen permission.
   */
  private createPeerMessageTools(context: AgentContext): Tool<any>[] {
    const agentId = context.agentId;
    return this.peerBindings(context.agent).map((binding) =>
      defineTool(`send_to_${binding.alias}`, {
        description:
          binding.alias === STANDARD_ALIAS
            ? "Send a durable asynchronous message to the Standard Copilot session."
            : `Send a durable asynchronous message to the "${binding.alias}" agent.`,
        parameters: z.object({
          subject: z.string().min(1).optional(),
          message: z.string().min(1),
        }),
        skipPermission: true,
        defer: "never",
        handler: ({ subject, message }) => {
          const source = this.agents.get(agentId);
          if (!source) {
            throw new Error(`Agent "${context.alias}" is no longer active.`);
          }
          if (!source.agent.recipients.has(binding.alias)) {
            throw new Error(
              `Agent "${source.alias}" is not permitted to message "${binding.alias}".`,
            );
          }
          const recipient =
            binding.alias === STANDARD_ALIAS
              ? this.standardRecipient()
              : this.agentRecipient(binding.alias, binding.agentId);
          const id = this.enqueueDurableMessage(
            source.alias,
            recipient,
            subject,
            message,
            source.target,
          );
          return { deliveredToMailbox: recipient.alias, messageId: id };
        },
      })
    );
  }

  private async connectSession(options: {
    runId: string;
    target: string;
    agentId: string | undefined;
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
    agentId: string | undefined;
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
      try {
        session = await client.resumeSession(sessionId, { ...config, suppressResumeEvent: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const missing = message.includes("Session not found:");
        if (!resumeExisting || !missing || this.db.hasConversationActivity(runId)) {
          throw error;
        }
        session = await client.createSession(config);
        this.emit(
          "session.recreated",
          { message: "The previous session had no conversation and was recreated." },
          { runId, memberId: target, target: "activity", done: true },
        );
      }
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
    if (persistEventTypes.has(event.type)) {
      this.db.appendEvent(
        event.id,
        live.runId,
        live.target,
        event.type,
        event.data,
        live.sequence,
      );
    }
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
        if (live.target === STANDARD_TARGET) {
          queueMicrotask(() => void this.drainPendingSpawns());
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

  async openStandard(): Promise<void> {
    if (this.standard && this.live.has(STANDARD_TARGET)) {
      return;
    }
    const runId = randomUUID();
    this.db.createStandardRun(runId, this.workspace, process.pid);
    // Messages agents addressed to Standard outlive the session they were sent to,
    // so any still-undelivered ones are transferred into this new run.
    const adoptedMessages = this.db.adoptStandardMessages(runId, this.workspace, STANDARD_TARGET);
    this.standard = { runId };
    try {
      await this.connectSession({
        runId,
        target: STANDARD_TARGET,
        agentId: undefined,
        alias: STANDARD_ALIAS,
        sessionId: undefined,
        config: this.standardSessionConfig(),
        configSignature: "standard",
      });
      this.emit("standard.ready", { mode: "standard", adoptedMessages }, { runId });
      queueMicrotask(() => void this.drainMailbox(STANDARD_TARGET));
    } catch (error) {
      this.db.finishRun(runId, "interrupted", "Standard Copilot failed to start");
      this.standard = undefined;
      throw error;
    }
  }

  private async stopStandard(reason: string): Promise<void> {
    if (!this.standard) {
      return;
    }
    const runId = this.standard.runId;
    const live = this.live.get(STANDARD_TARGET);
    this.live.delete(STANDARD_TARGET);
    if (live) {
      live.unsubscribe();
      await live.session.disconnect().catch(() => undefined);
      this.db.upsertSession(runId, live.session.sessionId, "disconnected");
    }
    this.db.finishRun(runId, "stopped", reason);
    this.standard = undefined;
  }

  async resumeStandardSession(sessionId: string): Promise<void> {
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

    await this.stopStandard(`Resuming session ${sessionId}`);
    const runId = randomUUID();
    this.db.createStandardRun(runId, this.workspace, process.pid);
    // Carry any mailbox still addressed to Standard across the session replacement.
    const adoptedMessages = this.db.adoptStandardMessages(runId, this.workspace, STANDARD_TARGET);
    this.standard = { runId };
    this.emit(
      "session.loading",
      { mode: "standard-loading", sessionId },
      { runId, memberId: STANDARD_TARGET, target: "status", done: false },
    );
    try {
      await this.connectSession({
        runId,
        target: STANDARD_TARGET,
        agentId: undefined,
        alias: STANDARD_ALIAS,
        sessionId,
        config: this.standardSessionConfig(),
        configSignature: "standard",
        resumeExisting: true,
      });
      this.emit(
        "standard.ready",
        { mode: "standard", recovered: true, sessionId, adoptedMessages },
        { runId },
      );
      queueMicrotask(() => void this.drainMailbox(STANDARD_TARGET));
    } catch (error) {
      this.db.finishRun(runId, "interrupted", "Standard Copilot recovery failed");
      this.standard = undefined;
      await this.openStandard();
      throw error;
    }
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

  private async drainPendingSpawns(): Promise<void> {
    while (this.pendingSpawns.length > 0) {
      const standard = this.live.get(STANDARD_TARGET);
      if (standard?.busy) {
        return;
      }
      const request = this.pendingSpawns.shift()!;
      try {
        await this.spawnAgents(request);
      } catch (error) {
        this.emit(
          "agent.error",
          {
            message: error instanceof Error ? error.message : String(error),
            aliases: request.agents.map((definition) => definition.id),
          },
          { memberId: STANDARD_TARGET, target: "activity", done: true },
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
    const resolved = this.resolveSpawnRequest(request);
    if (!this.standard || !this.live.has(STANDARD_TARGET)) {
      await this.openStandard();
    }
    const mcpServers = await this.availableMcpServers();
    this.assertMcpCeiling(request.agents, mcpServers);

    // Register every agent identity first so aliases in the batch resolve to their
    // UUID targets while the sessions are being configured.
    const contexts: AgentContext[] = [];
    for (const [index, agent] of resolved.entries()) {
      const agentId = randomUUID();
      const context: AgentContext = {
        agentId,
        target: agentTarget(agentId),
        alias: agent.alias,
        runId: randomUUID(),
        definition: request.agents[index]!,
        agent,
        mcpServers: new Set(mcpServers),
      };
      this.agents.set(agentId, context);
      this.aliasIndex.set(context.alias, agentId);
      this.db.createAgentRun(
        context.runId,
        agentId,
        context.alias,
        this.storedAgentJson(context),
        agent.standardCanTalk,
        this.workspace,
        process.pid,
      );
      contexts.push(context);
      this.emitAgentLifecycle("agent.loading", context, { recovered: false });
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
    await this.reconnectStalePeers();
    return results;
  }

  /** Resumes exactly one durable agent run; there is no group recovery. */
  async resumeAgent(runId: string): Promise<void> {
    const stored = this.db.agentRun(runId, this.workspace);
    if (!stored) {
      throw new Error(`Agent run "${runId}" was not found for this workspace.`);
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
    if (this.agents.has(stored.agentId)) {
      throw new Error(`Agent "${stored.alias}" is already active.`);
    }
    const record = storedAgentRecord(stored.definition);
    const definition = record.definition;
    // A recovered agent keeps the exact ACL it was persisted with, so its recipients
    // are validated against themselves. A recipient that is not currently active
    // still gets its send tool; that tool reports the peer is not active instead of
    // silently delivering elsewhere.
    const validated = validateAgentDefinition(definition, {
      availableAliases: new Set(definition.canTalkTo),
      standardCanTalk: stored.standardCanTalk || record.standardCanTalk,
    });
    if (!validated.valid || !validated.agent) {
      throw new Error(
        `Agent "${stored.alias}" can no longer be resumed with this configuration: ${validated.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    this.assertPermissionCeiling([definition]);
    this.assertAliasesAvailable([definition.id], stored.agentId);
    if (!this.standard || !this.live.has(STANDARD_TARGET)) {
      await this.openStandard();
    }
    // Recovery must not widen the agent's environment: its ceiling is the MCP server
    // set captured when it was created, narrowed to what Standard currently exposes.
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
      agent: validated.agent,
      mcpServers,
    };
    this.agents.set(context.agentId, context);
    this.aliasIndex.set(context.alias, context.agentId);
    this.db.updateAgentRun(
      runId,
      context.alias,
      this.storedAgentJson(context),
      validated.agent.standardCanTalk,
    );
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
        sessionId: stored.session?.sessionId,
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
      await this.reconnectStalePeers();
    } catch (error) {
      await this.failAgent(context, "Agent recovery failed");
      throw error;
    }
  }

  /** Stops one agent; accepts an alias, agent UUID, "agent:<uuid>" target, or run id. */
  async stopAgent(agentRef: string, reason = "Agent stopped by user"): Promise<void> {
    const context = this.requireAgent(agentRef);
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
    this.agents.delete(context.agentId);
    if (this.aliasIndex.get(context.alias) === context.agentId) {
      this.aliasIndex.delete(context.alias);
    }
    this.db.finishRun(context.runId, "stopped", reason);
    this.emit(
      "agent.stopped",
      { ...this.agentPayload(context), runId: context.runId, reason },
      { runId: context.runId, memberId: context.target, target: "status", done: true },
    );
    await this.pruneRecipient(context.alias);
  }

  async updateAgent(agentRef: string, update: AgentUpdate): Promise<Record<string, unknown>> {
    const context = this.requireAgent(agentRef);
    return this.withAgentLock(context.agentId, () => this.updateAgentUnlocked(context, update));
  }

  private async updateAgentUnlocked(
    context: AgentContext,
    update: AgentUpdate,
  ): Promise<Record<string, unknown>> {
    if (this.agents.get(context.agentId) !== context) {
      throw new Error(`Agent "${context.alias}" is no longer active.`);
    }
    const definition = update.definition;
    if (definition.id !== context.alias) {
      throw new Error(
        `Agent "${context.alias}" cannot be renamed to "${definition.id}"; aliases are durable.`,
      );
    }
    this.assertPermissionCeiling([definition]);
    this.assertMcpCeiling([definition], context.mcpServers);
    const availableAliases = new Set(
      [...this.aliasIndex.keys()].filter((alias) => alias !== context.alias),
    );
    const standardCanTalk = update.standardCanTalk ?? context.agent.standardCanTalk;
    const validated = validateAgentDefinition(definition, { availableAliases, standardCanTalk });
    if (!validated.valid || !validated.agent) {
      throw new Error(
        `Agent "${context.alias}" update is invalid: ${validated.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("; ")}`,
      );
    }

    const previousDefinition = context.definition;
    const previousAgent = context.agent;
    context.definition = definition;
    context.agent = validated.agent;
    try {
      this.db.updateAgentRun(
        context.runId,
        context.alias,
        this.storedAgentJson(context),
        standardCanTalk,
      );
    } catch (error) {
      context.definition = previousDefinition;
      context.agent = previousAgent;
      throw error;
    }

    let reconnected = false;
    try {
      reconnected = await this.reconnectIfConfigChanged(context);
    } catch (error) {
      // The reconnect failed, so restore the previous definition durably and in
      // memory rather than leaving a committed update the live session never
      // received, then surface the failure.
      context.definition = previousDefinition;
      context.agent = previousAgent;
      this.db.updateAgentRun(
        context.runId,
        context.alias,
        this.storedAgentJson(context),
        previousAgent.standardCanTalk,
      );
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
   * Removes a departed alias from every remaining agent's outgoing ACL so no agent
   * keeps a send tool for an agent that no longer exists, and reconnects the ones
   * whose tools changed.
   */
  private async pruneRecipient(alias: string): Promise<string[]> {
    const pruned: string[] = [];
    for (const context of [...this.agents.values()]) {
      if (!context.agent.recipients.has(alias)) {
        continue;
      }
      const recipients = new Set(context.agent.recipients);
      recipients.delete(alias);
      context.definition = {
        ...context.definition,
        canTalkTo: context.definition.canTalkTo.filter((entry) => entry !== alias),
      };
      context.agent = { ...context.agent, recipients };
      this.db.updateAgentRun(
        context.runId,
        context.alias,
        this.storedAgentJson(context),
        context.agent.standardCanTalk,
      );
      pruned.push(context.alias);
      try {
        const reconnected = await this.reconnectIfConfigChanged(context);
        this.emitAgentLifecycle("agent.updated", context, { reconnected });
      } catch (error) {
        this.emit(
          "agent.error",
          {
            ...this.agentPayload(context),
            message: `Reconnect after removing recipient "${alias}" failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          { runId: context.runId, memberId: STANDARD_TARGET, target: "activity", done: true },
        );
      }
    }
    return pruned;
  }

  /**
   * Reconnects an agent whenever anything its SessionConfig is derived from changed:
   * prompt, task, model, reasoning, permissions, MCP subset, or the resolved peer
   * send tools. The session id and conversation history are preserved.
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
  // rebuilding its complete session config from the current definition and alias
  // resolution. Several callers can be waiting on the same in-flight connection, so
  // each pass re-enters the shared guard (which joins rather than duplicates) and
  // then verifies the resulting session really was built from the current config;
  // a session joined from an older connect is replaced on the next pass.
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

  // After agents start or are recovered, refreshes any live agent whose session
  // config no longer matches — most often because a peer alias now resolves to a
  // different UUID target.
  private async reconnectStalePeers(): Promise<void> {
    for (const context of [...this.agents.values()]) {
      try {
        await this.reconnectIfConfigChanged(context);
      } catch (error) {
        this.emit(
          "agent.error",
          {
            ...this.agentPayload(context),
            message: `Peer tool refresh failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          { runId: context.runId, memberId: STANDARD_TARGET, target: "activity", done: true },
        );
      }
    }
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
    this.agents.delete(context.agentId);
    if (this.aliasIndex.get(context.alias) === context.agentId) {
      this.aliasIndex.delete(context.alias);
    }
    this.db.finishRun(context.runId, "interrupted", message);
    this.emit(
      "agent.error",
      { ...this.agentPayload(context), runId: context.runId, message },
      { runId: context.runId, memberId: STANDARD_TARGET, target: "activity", done: true },
    );
    this.emit(
      "agent.stopped",
      { ...this.agentPayload(context), runId: context.runId, reason: message, failed: true },
      { runId: context.runId, memberId: context.target, target: "status", done: true },
    );
    await this.pruneRecipient(context.alias);
  }

  private agentPayload(context: AgentContext): Record<string, unknown> {
    return {
      target: context.target,
      agentId: context.agentId,
      alias: context.alias,
      displayName: context.agent.displayName,
      description: context.agent.description,
      task: context.agent.task,
      recipients: [...context.agent.recipients],
      standardCanTalk: context.agent.standardCanTalk,
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
        recipients: [...record.definition.canTalkTo],
        standardCanTalk: run.standardCanTalk,
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
        this.emit(
          "mailbox.delivered",
          { ...message, status: "delivered" },
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
    const standardLive = this.live.get(STANDARD_TARGET);
    return {
      standard: this.standard
        ? {
            runId: this.standard.runId,
            target: STANDARD_TARGET,
            ...(standardLive ? { sessionId: standardLive.session.sessionId } : {}),
            state: standardLive?.foregroundBusy ? "busy" : "idle",
          }
        : undefined,
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
    if (this.standard) {
      runIds.add(this.standard.runId);
    }
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
    this.standard = undefined;
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
