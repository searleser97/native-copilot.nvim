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
import { FleetDatabase, type SettledMessage } from "./database.js";
import { dynamicAgentSchema, dynamicFleetSchema, validateFleet } from "./config.js";
import type {
  DynamicAgentDefinition,
  DynamicFleetDefinition,
  DynamicPermission,
  PermissionProfile,
  ResolvedFleet,
  ResolvedMember,
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

interface LiveSession {
  session: CopilotSession;
  runId: string;
  // Raw agent identifier, unique within a Fleet definition and used for
  // DB run-scoped records, session IDs, and peer send_to_<agent> tool names.
  memberId: string;
  // Fleet-qualified UI/runtime identity (e.g. "fleet_a/planner"); "standard"
  // for the supervisor session. Unique across all concurrently active Fleets.
  target: string;
  // Owning Fleet id, or undefined for the Standard supervisor session.
  fleetId: string | undefined;
  // Peer recipient set the live session's custom tools were built from; used to
  // detect when a mutation requires reconnecting the session with new peer tools.
  recipients: Set<string>;
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

// A concurrently running Fleet. The Standard supervisor session is tracked
// separately and always stays connected while any number of these are active.
interface FleetContext {
  runId: string;
  fleet: ResolvedFleet;
  mcpServers: Set<string>;
}

// Minimal shape of an active Fleet needed to plan a cross-Fleet agent move.
export interface FleetMoveParticipant {
  fleet: ResolvedFleet;
  mcpServers: Set<string>;
}

export interface FleetMoveOptions {
  replacementEntryAgentId?: string;
  destinationAgent?: DynamicAgentDefinition;
}

// A snapshot of a live Fleet member captured before a fallible mutation so the exact
// pre-mutation connectivity (session id and peer recipients) can be restored on
// rollback, even for members whose live entry was removed during the failed attempt.
interface LiveMemberSnapshot {
  target: string;
  memberId: string;
  sessionId: string;
  recipients: Set<string>;
}

// The pure outcome of validating and computing a cross-Fleet move. It contains the
// two rewritten (and re-validated) definitions plus the metadata the runtime needs
// to apply, persist, and roll the move back. Producing it has no side effects, so
// every move rule can be unit-tested without the SDK.
export interface FleetMovePlan {
  sourceDefinition: DynamicFleetDefinition;
  destinationDefinition: DynamicFleetDefinition;
  sourceFleet: ResolvedFleet;
  destinationFleet: ResolvedFleet;
  destinationAgent: DynamicAgentDefinition;
  isEntry: boolean;
  affectedSourcePeers: string[];
}

/**
 * Validates a cross-Fleet agent move and computes the rewritten source and
 * destination definitions. Throws on any rule violation (unknown/duplicate agent,
 * emptying the source, moving the entry agent without a replacement, an out-of-
 * ceiling destination agent, or a resulting definition that fails validation).
 * Pure: it never mutates its inputs or touches sessions/DB.
 */
export function planFleetMove(
  source: FleetMoveParticipant,
  destination: FleetMoveParticipant,
  agentId: string,
  options: FleetMoveOptions,
  allowAll: boolean,
  nativeToolCeiling: string[] = [],
): FleetMovePlan {
  if (source.fleet.id === destination.fleet.id) {
    throw new Error("The source and destination Fleets must be different.");
  }
  if (!source.fleet.members.has(agentId)) {
    throw new Error(`Fleet "${source.fleet.id}" has no agent "${agentId}".`);
  }
  if (destination.fleet.members.has(agentId)) {
    throw new Error(
      `Fleet "${destination.fleet.id}" already has an agent "${agentId}"; ids must be unique per Fleet.`,
    );
  }
  if (source.fleet.members.size <= 1) {
    throw new Error(`Cannot move the final member of fleet "${source.fleet.id}".`);
  }

  const sourceAgent = source.fleet.definition.agents.find((agent) => agent.id === agentId)!;
  const destinationMemberIds = new Set(
    destination.fleet.definition.agents.map((agent) => agent.id),
  );
  let destinationAgent: DynamicAgentDefinition;
  if (options.destinationAgent) {
    if (options.destinationAgent.id !== agentId) {
      throw new Error(
        `destinationAgent.id "${options.destinationAgent.id}" must equal the moved agent id "${agentId}".`,
      );
    }
    destinationAgent = options.destinationAgent;
  } else {
    destinationAgent = {
      ...structuredClone(sourceAgent),
      canTalkTo: sourceAgent.canTalkTo.filter(
        (id) => id !== agentId && destinationMemberIds.has(id),
      ),
    };
  }

  if (
    !allowAll &&
    destinationAgent.permissions &&
    "mode" in destinationAgent.permissions &&
    destinationAgent.permissions.mode === "approveAll"
  ) {
    throw new Error(
      "approveAll child permissions require the main Copilot command to include --allow-all.",
    );
  }
  if (
    destinationAgent.permissions &&
    !("mode" in destinationAgent.permissions) &&
    !memberToolsWithinCeiling(nativeToolCeiling, destinationAgent.permissions.tools.allow)
  ) {
    throw new Error(
      `Fleet agent "${agentId}" requests tools outside the main session allowlist ` +
        `(${nativeToolCeiling.join(", ") || "unrestricted"}). Child allowlists may only narrow ` +
        "the native tool ceiling.",
    );
  }
  for (const server of destinationAgent.mcpServers ?? []) {
    if (!destination.mcpServers.has(server)) {
      throw new Error(
        `Fleet agent "${agentId}" requested MCP server "${server}" unavailable in "${destination.fleet.id}".`,
      );
    }
  }

  const sourceDefinition = structuredClone(source.fleet.definition) as DynamicFleetDefinition;
  const isEntry = sourceDefinition.entryAgent === agentId;
  if (isEntry) {
    const replacement = options.replacementEntryAgentId;
    if (!replacement) {
      throw new Error(
        `Cannot move entry agent "${agentId}" without naming a replacementEntryAgentId.`,
      );
    }
    if (replacement === agentId) {
      throw new Error("replacementEntryAgentId must name a different agent than the one moving.");
    }
    if (!sourceDefinition.agents.some((agent) => agent.id === replacement)) {
      throw new Error(
        `replacementEntryAgentId "${replacement}" is not a member of fleet "${source.fleet.id}".`,
      );
    }
    sourceDefinition.entryAgent = replacement;
  }
  sourceDefinition.agents = sourceDefinition.agents
    .filter((agent) => agent.id !== agentId)
    .map((agent) => ({ ...agent, canTalkTo: agent.canTalkTo.filter((id) => id !== agentId) }));
  const validatedSource = validateFleet(sourceDefinition);
  if (!validatedSource.valid || !validatedSource.fleet) {
    throw new Error(
      `Source fleet "${source.fleet.id}" move is invalid: ${validatedSource.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  const destinationDefinition = structuredClone(
    destination.fleet.definition,
  ) as DynamicFleetDefinition;
  destinationDefinition.agents.push(destinationAgent);
  const validatedDestination = validateFleet(destinationDefinition);
  if (!validatedDestination.valid || !validatedDestination.fleet) {
    throw new Error(
      `Destination fleet "${destination.fleet.id}" move is invalid: ${validatedDestination.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  const affectedSourcePeers = [...source.fleet.members.entries()]
    .filter(([id, member]) => id !== agentId && member.recipients.has(agentId))
    .map(([id]) => id);

  return {
    sourceDefinition,
    destinationDefinition,
    sourceFleet: validatedSource.fleet,
    destinationFleet: validatedDestination.fleet,
    destinationAgent,
    isEntry,
    affectedSourcePeers,
  };
}

export const STANDARD_TARGET = "standard";

/** Builds the Fleet-qualified UI/runtime target id for a raw member id. */
export function qualifiedTarget(fleetId: string, memberId: string): string {
  return `${fleetId}/${memberId}`;
}

/** Splits a qualified target id back into its Fleet id and raw member id. */
export function parseTarget(target: string): { fleetId?: string; memberId: string } {
  const separator = target.indexOf("/");
  if (separator < 0) {
    return { memberId: target };
  }
  return { fleetId: target.slice(0, separator), memberId: target.slice(separator + 1) };
}

export type TargetRoute =
  | { kind: "standard" }
  | { kind: "fleet"; fleetId: string; memberId: string };

/**
 * Decides how a UI/runtime target id routes. Only the exact unqualified id
 * "standard" reaches the Standard supervisor; a qualified id such as
 * "fleet_a/standard" routes the Fleet member named "standard". Any other
 * unqualified id, or a qualified id missing its Fleet id or member id, is
 * malformed and rejected rather than silently falling back to Standard.
 */
export function routeTarget(target: string): TargetRoute {
  if (target === STANDARD_TARGET) {
    return { kind: "standard" };
  }
  const { fleetId, memberId } = parseTarget(target);
  if (fleetId === undefined || fleetId.length === 0 || memberId.length === 0) {
    throw new Error(`Target "${target}" is not a valid Fleet-qualified member id.`);
  }
  return { kind: "fleet", fleetId, memberId };
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
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
 * the Standard supervisor and every Fleet member build from it through
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

interface StoredDynamicFleet {
  definition: DynamicFleetDefinition;
  mcpServers: string[];
}

function storedDynamicFleet(value: string): StoredDynamicFleet {
  const parsed = JSON.parse(value) as Partial<StoredDynamicFleet>;
  if (!parsed.definition || !Array.isArray(parsed.mcpServers)) {
    throw new Error("Stored fleet definition is invalid.");
  }
  return {
    definition: parsed.definition,
    mcpServers: parsed.mcpServers.filter((server): server is string => typeof server === "string"),
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
 * Fleet member inherit. Because these values come directly from the user's main
 * Copilot command, a broken source is surfaced as an error rather than silently
 * dropped: a missing/unreadable file, invalid JSON, a non-object root, a missing
 * `mcpServers`/`servers` group, or a non-object server entry all throw. Silently
 * discarding them would hide the misconfiguration and quietly shrink the native
 * MCP ceiling that Fleet members inherit.
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
 * single typed object that drives both the Standard session and every Fleet
 * member. This is the only place these defaults are assembled.
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
 * session — Standard and Fleet members alike — passes through here so children
 * inherit the same native working directory policy by default. A config that has
 * already narrowed a dimension (e.g. a member's own `availableTools` allowlist,
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
 * supervisor and every Fleet member start from this exact object; the instance
 * only attaches per-session permission/MCP-auth handlers and then narrows or
 * overrides individual fields. Handlers are intentionally omitted here so this
 * remains a pure, testable definition of the inherited base.
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
        return approve(request);
      }
      case "url":
        return profile.network
          ? approve(request)
          : reject("Network access is disabled for this member.");
      case "mcp":
        return profile.externalActions && toolAllowed(profile, request.toolName)
          ? approve(request)
          : reject(`MCP tool "${request.toolName}" is not permitted for this member.`);
      case "custom-tool":
        return toolAllowed(profile, request.toolName)
          ? approve(request)
          : reject(`Custom tool "${request.toolName}" is not permitted for this member.`);
      case "memory":
      case "hook":
      case "extension-management":
      case "extension-permission-access":
      case "factory":
        return profile.externalActions
          ? approve(request)
          : reject(`${request.kind} operations are disabled for this member.`);
  }
}

export function usesApproveAll(
  permission: DynamicPermission | PermissionProfile | undefined,
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
 * Returns true when a Fleet member's requested tool allowlist is semantically a
 * subset of the canonical native ceiling. An empty native allowlist means the main
 * session is unrestricted, so any member allowlist is permitted. Both sides are
 * normalized through {@link sdkToolPatterns}, so a bare "*" and source wildcards
 * (e.g. "builtin:*") are expanded and matched. This is enforced instead of silently
 * intersecting, so an invalid (widening) member definition is rejected rather than
 * quietly narrowed in a way that hides the mistake.
 */
export function memberToolsWithinCeiling(nativeAllow: string[], memberAllow: string[]): boolean {
  const ceilingList = sdkToolPatterns(nativeAllow);
  if (ceilingList.length === 0) {
    return true;
  }
  const ceiling = new Set(ceilingList);
  return sdkToolPatterns(memberAllow).every((pattern) => toolCeilingCovers(ceiling, pattern));
}

export class CopilotRuntime {
  private client: CopilotClient | undefined;
  private knownSessionIds = new Set<string>();
  private readonly live = new Map<string, LiveSession>();
  // The single canonical native policy parsed once from the resolved main Copilot
  // command. Both the Standard supervisor and every Fleet member inherit it; agent
  // settings only overlay or restrict it, so there is one source of truth.
  private readonly policy: NativePolicy;
  // The Standard supervisor session's run. It stays connected for the lifetime
  // of the host while any number of Fleets run concurrently.
  private standard: { runId: string } | undefined;
  // Active Fleets keyed by Fleet id. Each context owns its own run, resolved
  // definition, and MCP server ceiling, and its members are tracked in `live`
  // under Fleet-qualified target ids so equal raw member ids never collide.
  private readonly fleets = new Map<string, FleetContext>();
  private shuttingDown = false;
  // Fleets requested via create_fleet while Standard is busy. They start once
  // Standard becomes idle; multiple requests may queue.
  private readonly pendingFleets: DynamicFleetDefinition[] = [];
  private readonly pendingPermissions = new Map<
    string,
    { target: string; respond: (result: PermissionRequestResult) => void }
  >();
  private readonly fleetLocks = new Map<string, Promise<void>>();
  private readonly recoveryTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly workspace: string,
    private readonly db: FleetDatabase,
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
    return this.ensureFleetMember(route.fleetId, route.memberId);
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
    this.db.enqueueMessage(id, live.runId, "user", live.memberId, "user", display);
    this.emit(
      "prompt.queued",
      { id, source: "command", target: live.memberId, content: display },
      { runId: live.runId, memberId: live.target, target: "activity", done: false },
    );
    try {
      const sdkMessageId = await live.session.send({ prompt: result.prompt, mode: "immediate" });
      this.db.completeMessage(id);
      this.emit(
        "prompt.accepted",
        { id, sdkMessageId, source: "user", target: live.memberId, content: display },
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

  // Attaches per-session permission and MCP-auth handlers to the shared native
  // base (nativeSessionScaffold). Standard and Fleet members both build from that
  // identical base and then only narrow or deliberately override individual fields,
  // so there is one source of truth for inherited defaults. The uiTarget is the
  // Fleet-qualified routing id used for control-plane events; raw member ids are
  // reserved for run-scoped DB and peer semantics.
  private baseSessionConfig(
    uiTarget: string,
    permission: DynamicPermission | undefined,
  ): SessionConfig {
    // The shared, canonical native base both Standard and every Fleet member build
    // from. The instance only attaches per-session handlers; native tool/MCP/model
    // policy is already layered by nativeSessionScaffold.
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

  private memberConfig(
    member: ResolvedMember,
    tools: Tool<any>[],
    fleetMcpServers: Set<string>,
    uiTarget: string,
  ): SessionConfig {
    // Start from the identical native base the Standard session uses. The base has
    // already layered the canonical native policy, so everything below only narrows
    // or deliberately overrides individual inherited fields.
    const config = this.baseSessionConfig(uiTarget, member.permission);
    config.includeSubAgentStreamingEvents = false;
    config.reasoningSummary = member.reasoningSummary;
    config.systemMessage = { mode: "append", content: member.initialPrompt };
    config.tools = tools;
    if (member.permission && !("mode" in member.permission)) {
      // Narrow: the member allowlist replaces the inherited native allowlist.
      config.availableTools = sdkToolPatterns(member.permission.tools.allow);
      // Restrict: member denies merge on top of the inherited native excluded ceiling.
      const nativeExcluded = Array.isArray(config.excludedTools) ? config.excludedTools : [];
      config.excludedTools = [
        ...new Set([...nativeExcluded, ...sdkToolPatterns(member.permission.tools.deny)]),
      ];
    }
    if (member.model !== undefined) {
      config.model = member.model;
    }
    if (member.reasoningEffort !== undefined) {
      config.reasoningEffort = member.reasoningEffort;
    }
    if (member.mcpServers) {
      config.disabledMcpServers = [
        ...new Set([
          ...(config.disabledMcpServers ?? []),
          ...[...fleetMcpServers].filter((server) => !member.mcpServers!.has(server)),
        ]),
      ];
    }
    return config;
  }

  private standardSessionConfig(): SessionConfig {
    // The Standard supervisor uses the native base unchanged — native tool/MCP and
    // model/reasoning policy are already layered by baseSessionConfig — adding only
    // its Fleet-management tools.
    const config = this.baseSessionConfig("standard", undefined);
    config.reasoningSummary = "detailed";
    config.tools = [
      this.createFleetTool(),
      this.addAgentToFleetTool(),
      this.removeAgentFromFleetTool(),
      this.moveAgentToFleetTool(),
    ];
    return config;
  }

  private createFleetTool(): Tool<any> {
    return defineTool("create_fleet", {
      description:
        "Create and start a task-specific Fleet when the user asks for multiple collaborating " +
        "agents or when independent planning, implementation, testing, or review would materially " +
        "improve the result. Define every agent completely at runtime. Give each agent a focused " +
        "prompt, least-privilege permissions, only the MCP servers it needs, and directional " +
        "canTalkTo peers; each peer becomes a send_to_<agent> tool. The objective is delivered to " +
        "entryAgent after startup. Omitted permissions and mcpServers inherit the main session. " +
        "The Fleet runs alongside the Standard session and any other active Fleets; Standard " +
        "stays connected as supervisor. The Fleet starts once this Standard turn becomes idle.",
      parameters: dynamicFleetSchema,
      skipPermission: true,
      defer: "never",
      handler: (definition) => {
        const fleetDefinition = definition as DynamicFleetDefinition;
        const result = validateFleet(fleetDefinition);
        if (!result.valid) {
          throw new Error(
            `Fleet "${fleetDefinition.id}" is invalid: ${result.issues
              .map((issue) => `${issue.path}: ${issue.message}`)
              .join("; ")}`,
          );
        }
        if (this.fleets.has(fleetDefinition.id)) {
          throw new Error(`Fleet "${fleetDefinition.id}" is already active.`);
        }
        if (this.pendingFleets.some((pending) => pending.id === fleetDefinition.id)) {
          throw new Error(`Fleet "${fleetDefinition.id}" is already pending startup.`);
        }
        this.assertPermissionCeiling(fleetDefinition.agents);
        this.pendingFleets.push(fleetDefinition);
        this.emit(
          "fleet.requested",
          { fleetId: fleetDefinition.id, definition: fleetDefinition, startsWhen: "session.idle" },
        );
        return {
          accepted: true,
          fleetId: fleetDefinition.id,
          message:
            "The Fleet will start alongside Standard after this Standard Copilot turn becomes idle.",
        };
      },
    });
  }

  private assertPermissionCeiling(agents: DynamicAgentDefinition[]): void {
    for (const agent of agents) {
      const permissions = agent.permissions;
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
      if (!memberToolsWithinCeiling(this.policy.availableTools, permissions.tools.allow)) {
        throw new Error(
          `Fleet agent "${agent.id}" requests tools outside the main session allowlist ` +
            `(${this.policy.availableTools.join(", ") || "unrestricted"}). Child allowlists may ` +
            "only narrow the native tool ceiling.",
        );
      }
    }
  }

  private assertMcpCeiling(
    agents: DynamicAgentDefinition[],
    availableServers: ReadonlySet<string>,
  ): void {
    for (const agent of agents) {
      for (const server of agent.mcpServers ?? []) {
        if (!availableServers.has(server)) {
          throw new Error(
            `Fleet agent "${agent.id}" requested unavailable MCP server "${server}".`,
          );
        }
      }
    }
  }

  private addAgentToFleetTool(): Tool<any> {
    return defineTool("add_agent_to_fleet", {
      description:
        "Add an agent to an active Fleet, or update an existing agent in place, without disturbing " +
        "the Standard session or other Fleets. This is an explicit upsert keyed by agent id: if no " +
        "agent with the given id exists it is added, and if one already exists its complete " +
        "definition is replaced (updated). Provide the target fleetId and a complete agent " +
        "definition. The resulting Fleet is validated and must respect the permission and MCP " +
        "ceilings. Sessions whose peer send_to_<agent> tools change are reconnected while preserving " +
        "their history.",
      parameters: z.object({
        fleetId: z.string().min(1).describe("Id of the active Fleet to mutate."),
        agent: dynamicAgentSchema.describe(
          "Complete definition of the agent to add, or to replace an existing agent with the same id.",
        ),
      }),
      skipPermission: true,
      defer: "never",
      handler: async ({ fleetId, agent }) => {
        const summary = await this.mutateFleetAddOrUpdate(
          fleetId,
          agent as DynamicAgentDefinition,
        );
        return { accepted: true, fleetId, ...summary };
      },
    });
  }

  private removeAgentFromFleetTool(): Tool<any> {
    return defineTool("remove_agent_from_fleet", {
      description:
        "Remove an agent from an active Fleet without disturbing the Standard session or other " +
        "Fleets. The removed agent is disconnected, references to it are pruned from every peer's " +
        "canTalkTo, and affected peers are reconnected with updated tools while preserving history. " +
        "The entry agent cannot be removed unless newEntryAgent names an atomic replacement, and " +
        "the final remaining member cannot be removed.",
      parameters: z.object({
        fleetId: z.string().min(1).describe("Id of the active Fleet to mutate."),
        agentId: z.string().min(1).describe("Raw id of the agent to remove."),
        newEntryAgent: z
          .string()
          .min(1)
          .optional()
          .describe("Required only when removing the current entry agent: its replacement."),
      }),
      skipPermission: true,
      defer: "never",
      handler: async ({ fleetId, agentId, newEntryAgent }) => {
        const summary = await this.mutateFleetRemove(fleetId, agentId, newEntryAgent);
        return { accepted: true, fleetId, agentId, ...summary };
      },
    });
  }

  private moveAgentToFleetTool(): Tool<any> {
    return defineTool("move_agent_to_fleet", {
      description:
        "Atomically move one active agent from a source Fleet to a destination Fleet without " +
        "disturbing the Standard session or any other Fleet. Both Fleets must be active and the " +
        "destination must not already contain an agent with the same id. The source may not become " +
        "empty. Moving the source entry agent is rejected unless replacementEntryAgentId names " +
        "another current source agent, which is promoted to entry atomically. References to the " +
        "moved agent are pruned from every source peer's canTalkTo and affected source peers are " +
        "reconnected. The moved agent's canTalkTo must be valid in the destination: provide a " +
        "complete destinationAgent definition to override it, otherwise the agent keeps its " +
        "definition with canTalkTo filtered to destination members. The moved agent is resumed " +
        "under the destination Fleet's native config overlay and peer tools, preserving the same " +
        "SDK session and conversation history when possible. Both definitions are persisted " +
        "atomically; if anything fails the move is rolled back with no partial state.",
      parameters: z.object({
        sourceFleetId: z.string().min(1).describe("Id of the active Fleet the agent is moving from."),
        destinationFleetId: z
          .string()
          .min(1)
          .describe("Id of the active Fleet the agent is moving to."),
        agentId: z.string().min(1).describe("Raw id of the agent to move; unchanged by the move."),
        replacementEntryAgentId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Required only when moving the source entry agent: the current source agent promoted " +
              "to entry in its place.",
          ),
        destinationAgent: dynamicAgentSchema
          .optional()
          .describe(
            "Optional complete replacement definition for the moved agent in the destination (its " +
              "id must equal agentId). Omit to reuse the current definition with canTalkTo filtered " +
              "to destination members.",
          ),
      }),
      skipPermission: true,
      defer: "never",
      handler: async ({ sourceFleetId, destinationFleetId, agentId, replacementEntryAgentId, destinationAgent }) => {
        const summary = await this.mutateFleetMove(
          sourceFleetId,
          destinationFleetId,
          agentId,
          {
            ...(replacementEntryAgentId ? { replacementEntryAgentId } : {}),
            ...(destinationAgent
              ? { destinationAgent: destinationAgent as DynamicAgentDefinition }
              : {}),
          },
        );
        return { accepted: true, ...summary };
      },
    });
  }

  private createPeerMessageTools(fleetId: string, source: ResolvedMember): Tool<any>[] {
    return [...source.recipients].map((target) =>
      defineTool(`send_to_${target}`, {
        description: `Send a durable asynchronous message to the ${target} fleet agent.`,
        parameters: z.object({
          subject: z.string().min(1).optional(),
          message: z.string().min(1),
        }),
        skipPermission: true,
        defer: "never",
        handler: async ({ subject, message }) => {
          const context = this.fleets.get(fleetId);
          if (!context) {
            throw new Error(`Fleet "${fleetId}" is not active.`);
          }
          const id = randomUUID();
          const content = subject ? `Subject: ${subject}\n\n${message}` : message;
          this.db.enqueueMessage(id, context.runId, source.id, target, "agent", content);
          this.emit(
            "mailbox.queued",
            { id, source: source.id, target, content },
            {
              runId: context.runId,
              memberId: qualifiedTarget(fleetId, source.id),
              target: qualifiedTarget(fleetId, target),
            },
          );
          queueMicrotask(() => void this.drainMailbox(fleetId, target));
          return { deliveredToMailbox: target, messageId: id };
        },
      })
    );
  }

  private async connectSession(
    runId: string,
    target: string,
    memberId: string,
    fleetId: string | undefined,
    sessionId: string | undefined,
    config: SessionConfig,
    recipients: Set<string>,
    resumeExisting = false,
    suppressHistory = false,
  ): Promise<LiveSession> {
    const existing = this.live.get(target);
    if (existing) {
      return existing;
    }
    this.emit(
      "environment.progress",
      { component: "Copilot environment", message: "Starting runtime and discovering configuration" },
      { runId, memberId: target, target: "activity" },
    );
    const client = await this.ensureClient();
    let session: CopilotSession;
    if (sessionId && (resumeExisting || this.knownSessionIds.has(sessionId))) {
      try {
        session = await client.resumeSession(sessionId, { ...config, suppressResumeEvent: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const missing = message.includes("Session not found:");
        if (!resumeExisting || !missing || this.db.hasConversationActivity(runId, memberId)) {
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
      memberId,
      target,
      fleetId,
      recipients: new Set(recipients),
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
    this.db.upsertSession(runId, memberId, actualSessionId, "connected");
    const history = await session.getEvents();
    for (const event of history) {
      live.seenEventIds.add(event.id);
    }
    // Skip the history replay for an in-process reconnect: the UI buffer for this
    // target is retained across the reconnect (peer/mutation changes never reset a
    // buffer), so re-emitting the full transcript would duplicate it. A fresh
    // connect, a host-restart recovery, or a move into a new destination buffer
    // still needs the history to render.
    if (!suppressHistory) {
      this.emit(
        "session.history",
        {
          events: history.map((event) => ({
            ...event,
            replayTimestamp: Date.parse(event.timestamp),
          })),
        },
        { runId, memberId: target, target: "conversation", done: true },
      );
    }
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

  private async ensureFleetMember(fleetId: string, memberId: string): Promise<LiveSession> {
    const context = this.fleets.get(fleetId);
    if (!context) {
      throw new Error(`Fleet "${fleetId}" is not active.`);
    }
    const member = context.fleet.members.get(memberId);
    if (!member) {
      throw new Error(`Unknown fleet member "${memberId}" in fleet "${fleetId}".`);
    }
    const tools = this.createPeerMessageTools(fleetId, member);
    const storedSessionId = this.db
      .fleetRun(context.runId, this.workspace)
      ?.sessions.find((session) => session.memberId === memberId)
      ?.sessionId;
    return this.connectSession(
      context.runId,
      qualifiedTarget(fleetId, memberId),
      memberId,
      fleetId,
      storedSessionId,
      this.memberConfig(member, tools, context.mcpServers, qualifiedTarget(fleetId, memberId)),
      member.recipients,
    );
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
        live.memberId,
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
      case "session.idle":
        live.busy = false;
        live.foregroundBusy = false;
        live.foregroundTurnId = undefined;
        live.foregroundCompleteTurnId = undefined;
        live.foregroundTurnHasToolRequests = false;
        live.foregroundAbortSequence = undefined;
        this.emit("member.state", { state: "idle", ...event.data }, { ...fields, target: "status" });
        if (live.fleetId === undefined) {
          queueMicrotask(() => void this.drainPendingFleets());
        } else {
          const fleetId = live.fleetId;
          queueMicrotask(() => void this.drainMailbox(fleetId, live.memberId));
        }
        break;
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
            // The live map is keyed by the Fleet-qualified target, not the raw
            // member id; a raw-id lookup would miss Fleet members entirely (and could
            // collide with another Fleet's same-named member).
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
    this.db.createRun(runId, "standard", null, this.workspace, process.pid);
    this.standard = { runId };
    try {
      await this.connectSession(
        runId,
        STANDARD_TARGET,
        STANDARD_TARGET,
        undefined,
        undefined,
        this.standardSessionConfig(),
        new Set(),
      );
      this.emit("standard.ready", { mode: "standard" }, { runId });
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
      this.db.upsertSession(runId, live.memberId, live.session.sessionId, "disconnected");
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
    this.db.createRun(runId, "standard", null, this.workspace, process.pid);
    this.standard = { runId };
    this.emit(
      "session.loading",
      { mode: "standard-loading", sessionId },
      { runId, memberId: STANDARD_TARGET, target: "status", done: false },
    );
    try {
      await this.connectSession(
        runId,
        STANDARD_TARGET,
        STANDARD_TARGET,
        undefined,
        sessionId,
        this.standardSessionConfig(),
        new Set(),
        true,
      );
      this.emit("standard.ready", { mode: "standard", recovered: true, sessionId }, { runId });
    } catch (error) {
      this.db.finishRun(runId, "interrupted", "Standard Copilot recovery failed");
      this.standard = undefined;
      await this.openStandard();
      throw error;
    }
  }

  private async drainPendingFleets(): Promise<void> {
    while (this.pendingFleets.length > 0) {
      const standard = this.live.get(STANDARD_TARGET);
      if (standard?.busy) {
        return;
      }
      const definition = this.pendingFleets.shift()!;
      if (this.fleets.has(definition.id)) {
        continue;
      }
      try {
        await this.startFleet(definition);
      } catch (error) {
        this.emit(
          "fleet.error",
          {
            fleetId: definition.id,
            message: error instanceof Error ? error.message : String(error),
          },
          { memberId: STANDARD_TARGET, target: "activity", done: true },
        );
      }
    }
  }

  async startFleet(definition: DynamicFleetDefinition): Promise<void> {
    return this.withFleetLocks([definition.id], () => this.startFleetUnlocked(definition));
  }

  private async startFleetUnlocked(definition: DynamicFleetDefinition): Promise<void> {
    const validated = validateFleet(definition);
    if (!validated.valid || !validated.fleet) {
      throw new Error(
        `Fleet "${definition.id}" is invalid:\n${validated.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("\n")}`,
      );
    }
    if (this.fleets.has(definition.id)) {
      throw new Error(`Fleet "${definition.id}" is already active.`);
    }
    this.assertPermissionCeiling(definition.agents);
    if (!this.standard || !this.live.has(STANDARD_TARGET)) {
      await this.openStandard();
    }
    const standard = this.live.get(STANDARD_TARGET);
    const mcpServers = new Set(
      standard ? (await standard.session.rpc.mcp.list()).servers.map((server) => server.name) : [],
    );
    this.assertMcpCeiling(definition.agents, mcpServers);
    const runId = randomUUID();
    this.db.createRun(
      runId,
      "fleet",
      definition.id,
      this.workspace,
      process.pid,
      JSON.stringify({ definition, mcpServers: [...mcpServers] }),
    );
    const context: FleetContext = { runId, fleet: validated.fleet, mcpServers };
    this.fleets.set(definition.id, context);
    this.emitFleetLoading(
      context,
      false,
      [...validated.fleet.members.values()]
        .filter((member) => member.autoStart)
        .map((member) => member.id),
    );
    try {
      for (const member of validated.fleet.members.values()) {
        if (member.autoStart) {
          await this.ensureFleetMember(definition.id, member.id);
        }
      }
      this.emit("fleet.ready", this.fleetPayload(context, false), { runId });
      await this.sendUserPrompt(
        qualifiedTarget(definition.id, validated.fleet.entryMember),
        definition.objective,
      );
    } catch (error) {
      await this.disconnectFleetSessions(definition.id, runId);
      this.fleets.delete(definition.id);
      this.db.finishRun(runId, "interrupted", "Fleet startup failed");
      this.emit(
        "fleet.stopped",
        {
          fleetId: definition.id,
          reason: "Fleet startup failed",
          members: [...validated.fleet.members.keys()].map((id) =>
            qualifiedTarget(definition.id, id)),
        },
        { runId },
      );
      throw error;
    }
  }

  async resumeFleet(runId: string): Promise<void> {
    const stored = this.db.fleetRun(runId, this.workspace);
    if (!stored) {
      throw new Error(`Fleet run "${runId}" was not found for this workspace.`);
    }
    return this.withFleetLocks([stored.fleetId], () => this.resumeFleetUnlocked(runId));
  }

  private async resumeFleetUnlocked(runId: string): Promise<void> {
    const stored = this.db.fleetRun(runId, this.workspace);
    if (!stored) {
      throw new Error(`Fleet run "${runId}" was not found for this workspace.`);
    }
    if (stored.status === "active") {
      throw new Error(`Fleet run "${runId}" is owned by another active Neovim instance.`);
    }
    if (!stored.fleetDefinition) {
      throw new Error(`Fleet run "${runId}" predates dynamic fleet persistence and cannot resume.`);
    }
    if (this.fleets.has(stored.fleetId)) {
      throw new Error(`Fleet "${stored.fleetId}" is already active.`);
    }
    const recovered = storedDynamicFleet(stored.fleetDefinition);
    const definition = recovered.definition;
    const validated = validateFleet(definition);
    if (!validated.valid || !validated.fleet) {
      throw new Error(`Fleet "${stored.fleetId}" can no longer be resumed with this configuration.`);
    }
    this.assertPermissionCeiling(definition.agents);
    if (!this.standard || !this.live.has(STANDARD_TARGET)) {
      await this.openStandard();
    }
    const standard = this.live.get(STANDARD_TARGET);
    const mcpServers = new Set(
      standard ? (await standard.session.rpc.mcp.list()).servers.map((server) => server.name) : [],
    );
    this.assertMcpCeiling(definition.agents, mcpServers);
    this.db.resumeRun(runId, process.pid);
    const context: FleetContext = {
      runId,
      fleet: validated.fleet,
      mcpServers,
    };
    this.db.updateFleetDefinition(
      runId,
      JSON.stringify({ definition, mcpServers: [...mcpServers] }),
    );
    this.fleets.set(stored.fleetId, context);
    const storedSessions = new Map(
      stored.sessions.map((session) => [session.memberId, session.sessionId]),
    );
    this.emitFleetLoading(
      context,
      true,
      [...validated.fleet.members.values()]
        .filter((member) => storedSessions.has(member.id) || member.autoStart)
        .map((member) => member.id),
    );
    const started: LiveSession[] = [];
    try {
      for (const member of validated.fleet.members.values()) {
        const sessionId = storedSessions.get(member.id);
        if (sessionId) {
          started.push(
            await this.connectSession(
              runId,
              qualifiedTarget(stored.fleetId, member.id),
              member.id,
              stored.fleetId,
              sessionId,
              this.memberConfig(
                member,
                this.createPeerMessageTools(stored.fleetId, member),
                context.mcpServers,
                qualifiedTarget(stored.fleetId, member.id),
              ),
              member.recipients,
              true,
            ),
          );
        } else if (member.autoStart) {
          started.push(await this.ensureFleetMember(stored.fleetId, member.id));
        }
      }
      this.emit("fleet.ready", this.fleetPayload(context, true), { runId });
      for (const member of started) {
        const fleetId = stored.fleetId;
        queueMicrotask(() => void this.drainMailbox(fleetId, member.memberId));
      }
    } catch (error) {
      await this.disconnectFleetSessions(stored.fleetId, runId);
      this.fleets.delete(stored.fleetId);
      this.db.finishRun(runId, "interrupted", "Fleet recovery failed");
      this.emit(
        "fleet.stopped",
        {
          fleetId: stored.fleetId,
          reason: "Fleet recovery failed",
          members: [...validated.fleet.members.keys()].map((id) =>
            qualifiedTarget(stored.fleetId, id)),
        },
        { runId },
      );
      throw error;
    }
  }

  private resolveFleet(
    fleetIdOrRunId: string,
  ): { fleetId: string; context: FleetContext } | undefined {
    const direct = this.fleets.get(fleetIdOrRunId);
    if (direct) {
      return { fleetId: fleetIdOrRunId, context: direct };
    }
    for (const [fleetId, context] of this.fleets) {
      if (context.runId === fleetIdOrRunId) {
        return { fleetId, context };
      }
    }
    return undefined;
  }

  private async acquireFleetLock(fleetId: string): Promise<() => void> {
    const previous = this.fleetLocks.get(fleetId) ?? Promise.resolve();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      releaseGate = resolveGate;
    });
    const tail = previous.then(() => gate);
    this.fleetLocks.set(fleetId, tail);
    await previous;
    return () => {
      releaseGate();
      if (this.fleetLocks.get(fleetId) === tail) {
        this.fleetLocks.delete(fleetId);
      }
    };
  }

  private async withFleetLocks<T>(
    fleetIds: string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const releases: Array<() => void> = [];
    for (const fleetId of [...new Set(fleetIds)].sort()) {
      releases.push(await this.acquireFleetLock(fleetId));
    }
    try {
      return await operation();
    } finally {
      for (const release of releases.reverse()) {
        release();
      }
    }
  }

  private async disconnectFleetSessions(fleetId: string, runId: string): Promise<string[]> {
    const members = [...this.live.values()].filter((live) => live.fleetId === fleetId);
    for (const live of members) {
      this.live.delete(live.target);
    }
    await Promise.allSettled(
      members.map(async (live) => {
        live.unsubscribe();
        await live.session.disconnect().catch(() => undefined);
        this.db.upsertSession(runId, live.memberId, live.session.sessionId, "disconnected");
      }),
    );
    return members.map((live) => live.target);
  }

  async stopFleet(fleetIdOrRunId: string, reason = "Fleet stopped by user"): Promise<void> {
    const found = this.resolveFleet(fleetIdOrRunId);
    if (!found) {
      throw new Error(`Fleet "${fleetIdOrRunId}" is not active.`);
    }
    return this.withFleetLocks([found.fleetId], () =>
      this.stopFleetUnlocked(fleetIdOrRunId, reason),
    );
  }

  private async stopFleetUnlocked(
    fleetIdOrRunId: string,
    reason: string,
  ): Promise<void> {
    const found = this.resolveFleet(fleetIdOrRunId);
    if (!found) {
      throw new Error(`Fleet "${fleetIdOrRunId}" is not active.`);
    }
    const { fleetId, context } = found;
    this.fleets.delete(fleetId);
    await this.disconnectFleetSessions(fleetId, context.runId);
    this.db.finishRun(context.runId, "stopped", reason);
    this.emit(
      "fleet.stopped",
      {
        fleetId,
        reason,
        members: [...context.fleet.members.keys()].map((id) => qualifiedTarget(fleetId, id)),
      },
      { runId: context.runId },
    );
  }

  async mutateFleetAddOrUpdate(
    fleetId: string,
    agentDefinition: DynamicAgentDefinition,
  ): Promise<Record<string, unknown>> {
    return this.withFleetLocks([fleetId], () =>
      this.mutateFleetAddOrUpdateUnlocked(fleetId, agentDefinition),
    );
  }

  private async mutateFleetAddOrUpdateUnlocked(
    fleetId: string,
    agentDefinition: DynamicAgentDefinition,
  ): Promise<Record<string, unknown>> {
    const context = this.fleets.get(fleetId);
    if (!context) {
      throw new Error(`Fleet "${fleetId}" is not active.`);
    }
    this.assertPermissionCeiling([agentDefinition]);
    for (const server of agentDefinition.mcpServers ?? []) {
      if (!context.mcpServers.has(server)) {
        throw new Error(
          `Fleet agent "${agentDefinition.id}" requested unavailable MCP server "${server}".`,
        );
      }
    }
    const definition = structuredClone(context.fleet.definition) as DynamicFleetDefinition;
    const index = definition.agents.findIndex((agent) => agent.id === agentDefinition.id);
    const isUpdate = index >= 0;
    if (isUpdate) {
      definition.agents[index] = agentDefinition;
    } else {
      definition.agents.push(agentDefinition);
    }
    const validated = validateFleet(definition);
    if (!validated.valid || !validated.fleet) {
      throw new Error(
        `Fleet "${fleetId}" mutation is invalid: ${validated.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    const fleetBefore = context.fleet;
    const jsonBefore = this.fleetDefinitionJson(context);
    // Capture the exact live membership before mutating so a failed reconnect can
    // restore every previously-live member, including any whose live entry vanishes.
    const liveSnapshot = this.captureLiveMembers(context, [...fleetBefore.members.keys()]);
    this.applyFleetMutation(context, validated.fleet, definition);
    const target = qualifiedTarget(fleetId, agentDefinition.id);
    const force = new Set<string>();
    const member = validated.fleet.members.get(agentDefinition.id)!;
    let startedNewMember = false;
    try {
      if (this.live.has(target)) {
        force.add(agentDefinition.id);
      } else if (member.autoStart) {
        await this.ensureFleetMember(fleetId, agentDefinition.id);
        startedNewMember = true;
      }
      const reconnected = await this.reconnectChangedPeers(context, force);
      this.emitFleetUpdated(context, {
        added: isUpdate ? [] : [agentDefinition.id],
        updated: isUpdate ? [agentDefinition.id] : [],
        removed: [],
      });
      return {
        action: isUpdate ? "updated" : "added",
        agentId: agentDefinition.id,
        reconnectedAgents: reconnected,
      };
    } catch (error) {
      // Roll back both durable and in-memory state, then realign any peers that were
      // already reconnected under the rejected definition. No reported failure may
      // leave a partially committed mutation.
      this.rollbackFleetMutation(context, fleetBefore, jsonBefore);
      if (startedNewMember) {
        const orphan = this.live.get(target);
        if (orphan) {
          orphan.unsubscribe();
          this.live.delete(target);
          await orphan.session.disconnect().catch(() => undefined);
          this.db.deleteSession(context.runId, agentDefinition.id);
        }
      }
      // Restore every previously-live member that lost its live entry, then realign
      // any that are still live but were reconnected under the rejected definition.
      await this.restoreLiveMembers(context, liveSnapshot);
      try {
        await this.reconnectChangedPeers(context, new Set(force));
      } catch {
        // Peer realignment is best-effort.
      }
      throw error;
    }
  }

  async mutateFleetRemove(
    fleetId: string,
    agentId: string,
    newEntryAgent?: string,
  ): Promise<Record<string, unknown>> {
    return this.withFleetLocks([fleetId], () =>
      this.mutateFleetRemoveUnlocked(fleetId, agentId, newEntryAgent),
    );
  }

  private async mutateFleetRemoveUnlocked(
    fleetId: string,
    agentId: string,
    newEntryAgent?: string,
  ): Promise<Record<string, unknown>> {
    const context = this.fleets.get(fleetId);
    if (!context) {
      throw new Error(`Fleet "${fleetId}" is not active.`);
    }
    if (!context.fleet.members.has(agentId)) {
      throw new Error(`Fleet "${fleetId}" has no agent "${agentId}".`);
    }
    if (context.fleet.members.size <= 1) {
      throw new Error(`Cannot remove the final member of fleet "${fleetId}".`);
    }
    const definition = structuredClone(context.fleet.definition) as DynamicFleetDefinition;
    const isEntry = definition.entryAgent === agentId;
    if (isEntry) {
      if (!newEntryAgent) {
        throw new Error(
          `Cannot remove entry agent "${agentId}" without naming a replacement newEntryAgent.`,
        );
      }
      if (newEntryAgent === agentId) {
        throw new Error("newEntryAgent must name a different agent than the one being removed.");
      }
      if (!definition.agents.some((agent) => agent.id === newEntryAgent)) {
        throw new Error(`newEntryAgent "${newEntryAgent}" is not a member of fleet "${fleetId}".`);
      }
      definition.entryAgent = newEntryAgent;
    }
    definition.agents = definition.agents
      .filter((agent) => agent.id !== agentId)
      .map((agent) => ({ ...agent, canTalkTo: agent.canTalkTo.filter((id) => id !== agentId) }));
    const validated = validateFleet(definition);
    if (!validated.valid || !validated.fleet) {
      throw new Error(
        `Fleet "${fleetId}" mutation is invalid: ${validated.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    const affectedPeers = [...context.fleet.members.entries()]
      .filter(([id, member]) => id !== agentId && member.recipients.has(agentId))
      .map(([id]) => id);
    const fleetBefore = context.fleet;
    const jsonBefore = this.fleetDefinitionJson(context);
    // Capture the exact live membership before mutating (including the agent being
    // removed) so a failed reconnect can restore every previously-live member.
    const liveSnapshot = this.captureLiveMembers(context, [...fleetBefore.members.keys()]);
    this.applyFleetMutation(context, validated.fleet, definition);
    const removedTarget = qualifiedTarget(fleetId, agentId);
    const removedLive = this.live.get(removedTarget);
    try {
      if (removedLive) {
        removedLive.unsubscribe();
        this.live.delete(removedTarget);
        await removedLive.session.disconnect().catch(() => undefined);
        this.db.upsertSession(context.runId, agentId, removedLive.session.sessionId, "removed");
      }
      const reconnected = await this.reconnectChangedPeers(context, new Set(affectedPeers));
      this.emitFleetUpdated(context, { added: [], updated: [], removed: [agentId] });
      return {
        action: "removed",
        agentId,
        ...(isEntry ? { newEntryAgent } : {}),
        reconnectedAgents: reconnected,
      };
    } catch (error) {
      // Roll back durable and in-memory state, then restore every previously-live
      // member (including the just-removed agent and any peer whose reconnect failed)
      // and realign the peers still live under the restored definition.
      this.rollbackFleetMutation(context, fleetBefore, jsonBefore);
      await this.restoreLiveMembers(context, liveSnapshot);
      try {
        await this.reconnectChangedPeers(context, new Set(affectedPeers));
      } catch {
        // Peer realignment is best-effort.
      }
      throw error;
    }
  }

  // Atomically moves one active agent from a source Fleet to a destination Fleet.
  // Every validation runs before any state changes; the source and destination
  // definitions are then persisted together in one DB transaction, in-memory
  // contexts are updated, and the moved agent's SDK session/history is preserved by
  // resuming the same session id under the destination-qualified target. Any failure
  // rolls the in-memory contexts and persisted definitions back so no partial state
  // survives.
  async mutateFleetMove(
    sourceFleetId: string,
    destinationFleetId: string,
    agentId: string,
    options: FleetMoveOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.withFleetLocks([sourceFleetId, destinationFleetId], () =>
      this.mutateFleetMoveUnlocked(sourceFleetId, destinationFleetId, agentId, options),
    );
  }

  private async mutateFleetMoveUnlocked(
    sourceFleetId: string,
    destinationFleetId: string,
    agentId: string,
    options: FleetMoveOptions,
  ): Promise<Record<string, unknown>> {
    const source = this.fleets.get(sourceFleetId);
    if (!source) {
      throw new Error(`Fleet "${sourceFleetId}" is not active.`);
    }
    const destination = this.fleets.get(destinationFleetId);
    if (!destination) {
      throw new Error(`Fleet "${destinationFleetId}" is not active.`);
    }

    // Validate and compute both rewritten definitions purely, before any state
    // change. planFleetMove throws on any rule violation so nothing is mutated on
    // an invalid request. The native tool ceiling is threaded in so a destination
    // agent override cannot widen the main allowlist.
    const plan = planFleetMove(
      source,
      destination,
      agentId,
      options,
      this.policy.allowAll,
      this.policy.availableTools,
    );
    const { sourceDefinition, destinationDefinition, isEntry, affectedSourcePeers } = plan;

    // Capture rollback state before any change.
    const sourceFleetBefore = source.fleet;
    const destinationFleetBefore = destination.fleet;
    const sourceJsonBefore = JSON.stringify({
      definition: source.fleet.definition,
      mcpServers: [...source.mcpServers],
    });
    const destinationJsonBefore = JSON.stringify({
      definition: destination.fleet.definition,
      mcpServers: [...destination.mcpServers],
    });
    const sourceJsonAfter = JSON.stringify({
      definition: sourceDefinition,
      mcpServers: [...source.mcpServers],
    });
    const destinationJsonAfter = JSON.stringify({
      definition: destinationDefinition,
      mcpServers: [...destination.mcpServers],
    });
    const movedTarget = qualifiedTarget(sourceFleetId, agentId);
    const destinationTarget = qualifiedTarget(destinationFleetId, agentId);
    const movedLive = this.live.get(movedTarget);
    const preservedSessionId = movedLive?.session.sessionId;
    const preservePath = Boolean(movedLive && preservedSessionId);
    // Snapshot the source peers' pre-move connectivity so a failed move restores
    // any whose live entry vanished during reconnection.
    const sourcePeerSnapshot = this.captureLiveMembers(source, affectedSourcePeers);

    // Explicit stage flags let the rollback reason precisely about which SDK/DB
    // state exists, so it never leaves an orphan or duplicate session.
    let movedDetached = false;
    let originalDisconnected = false;
    let messagesSettled: SettledMessage[] = [];

    // Persist both definitions atomically first; nothing else has changed yet.
    this.db.updateFleetDefinitions([
      { runId: source.runId, fleetDefinition: sourceJsonAfter },
      { runId: destination.runId, fleetDefinition: destinationJsonAfter },
    ]);

    try {
      // Update in-memory contexts.
      source.fleet = plan.sourceFleet;
      destination.fleet = plan.destinationFleet;

      // Reconnect source peers that referenced the moved agent so their tools update.
      // The moved agent's live entry is intentionally left registered here: if this
      // step fails the original session is untouched and needs no restoration.
      const sourceReconnected = await this.reconnectChangedPeers(
        source,
        new Set(affectedSourcePeers),
      );

      // Bring the moved agent up in the destination.
      const destinationMember = plan.destinationFleet.members.get(agentId)!;
      if (movedLive && preservedSessionId) {
        // Detach and disconnect the source session only now, immediately before the
        // destination resume reuses its session id.
        movedLive.unsubscribe();
        this.live.delete(movedTarget);
        movedDetached = true;
        await movedLive.session.disconnect().catch(() => undefined);
        originalDisconnected = true;
        await this.connectSession(
          destination.runId,
          destinationTarget,
          agentId,
          destinationFleetId,
          preservedSessionId,
          this.memberConfig(
            destinationMember,
            this.createPeerMessageTools(destinationFleetId, destinationMember),
            destination.mcpServers,
            destinationTarget,
          ),
          destinationMember.recipients,
          true,
        );
        // Move the persisted session record to the destination run.
        this.db.reassociateSession(
          source.runId,
          destination.runId,
          agentId,
          preservedSessionId,
          "connected",
        );
      } else {
        // No live session to preserve: drop any stale source record and, if the
        // destination member auto-starts, connect a fresh destination session.
        this.db.deleteSession(source.runId, agentId);
        if (destinationMember.autoStart) {
          await this.ensureFleetMember(destinationFleetId, agentId);
        }
      }

      // The moved agent no longer drains the source run, so its still-in-flight
      // source mailbox must NOT migrate: settle it terminally in the source run with
      // an explicit reason. Captured so a later failure can restore it on rollback.
      messagesSettled = this.db.settleMovedMessages(
        source.runId,
        agentId,
        `Agent "${agentId}" moved to fleet "${destinationFleetId}".`,
      );

      // Refresh any destination peers whose recipient set changed (usually none).
      const destinationReconnected = await this.reconnectChangedPeers(destination, new Set());

      // Emit incremental UI lifecycle events for both Fleets so the moved agent's
      // buffer/history follows it to the destination without touching other Fleets.
      this.emitFleetUpdated(source, { added: [], updated: [], removed: [agentId] });
      this.emitFleetUpdated(destination, { added: [agentId], updated: [], removed: [] });

      return {
        action: "moved",
        agentId,
        sourceFleetId,
        destinationFleetId,
        sessionPreserved: preservePath,
        settledMessages: messagesSettled.length,
        ...(isEntry ? { replacementEntryAgentId: options.replacementEntryAgentId } : {}),
        sourceReconnectedAgents: sourceReconnected,
        destinationReconnectedAgents: destinationReconnected,
      };
    } catch (error) {
      // Roll back in-memory contexts and persisted definitions so no partial state
      // survives, tracking each stage so no orphan or duplicate SDK session remains.
      source.fleet = sourceFleetBefore;
      destination.fleet = destinationFleetBefore;
      try {
        this.db.updateFleetDefinitions([
          { runId: source.runId, fleetDefinition: sourceJsonBefore },
          { runId: destination.runId, fleetDefinition: destinationJsonBefore },
        ]);
      } catch {
        // Definition rollback is best-effort; the in-memory truth is already restored.
      }

      // Restore any source mailbox we settled so the messages remain deliverable.
      if (messagesSettled.length > 0) {
        try {
          this.db.restoreMovedMessages(messagesSettled);
        } catch {
          // Mailbox restoration is best-effort.
        }
      }

      // Remove any destination live session created during the attempt so no orphan
      // SDK session survives, and move its persisted record back to the source.
      const destinationLive = this.live.get(destinationTarget);
      if (destinationLive) {
        destinationLive.unsubscribe();
        this.live.delete(destinationTarget);
        await destinationLive.session.disconnect().catch(() => undefined);
      }
      if (preservePath) {
        // Normalize the DB record back to the source run whether or not the forward
        // reassociate ran (it deletes any destination row and restores the source row).
        try {
          this.db.reassociateSession(
            destination.runId,
            source.runId,
            agentId,
            preservedSessionId!,
            "connected",
          );
        } catch {
          // Best-effort; in-memory state is authoritative.
        }
      } else if (destinationLive) {
        // The fresh destination session had its own persisted record; drop it.
        this.db.deleteSession(destination.runId, agentId);
      }

      // Restore the moved agent under the source.
      if (preservePath) {
        if (originalDisconnected) {
          // The original session was disconnected; resume it exactly once (only if it
          // is not somehow already live) to avoid a duplicate SDK session.
          if (!this.live.has(movedTarget)) {
            const restoreMember = sourceFleetBefore.members.get(agentId);
            if (restoreMember) {
              this.db.upsertSession(source.runId, agentId, preservedSessionId!, "connected");
              try {
                await this.connectSession(
                  source.runId,
                  movedTarget,
                  agentId,
                  sourceFleetId,
                  preservedSessionId!,
                  this.memberConfig(
                    restoreMember,
                    this.createPeerMessageTools(sourceFleetId, restoreMember),
                    source.mcpServers,
                    movedTarget,
                  ),
                  restoreMember.recipients,
                  true,
                  true,
                );
              } catch {
                // The source session could not be resumed; leave it disconnected
                // rather than risking a duplicate.
              }
            }
          }
        } else if (movedDetached && movedLive && !this.live.has(movedTarget)) {
          // The original was detached but never disconnected: re-register the same
          // still-connected handle directly instead of resuming a new session.
          movedLive.unsubscribe = movedLive.session.on((event) =>
            this.handleSessionEvent(movedLive, event));
          this.live.set(movedTarget, movedLive);
          this.db.upsertSession(source.runId, agentId, movedLive.session.sessionId, "connected");
        }
        // If the original was never detached, its live entry is still registered and
        // needs no restoration.
      }

      // Restore source peers robustly, then realign any still-live peers.
      await this.restoreLiveMembers(source, sourcePeerSnapshot);
      try {
        await this.reconnectChangedPeers(source, new Set(affectedSourcePeers));
      } catch {
        // Peer restoration is best-effort.
      }
      throw error;
    }
  }

  private applyFleetMutation(
    context: FleetContext,
    fleet: ResolvedFleet,
    definition: DynamicFleetDefinition,
  ): void {
    context.fleet = fleet;
    this.db.updateFleetDefinition(
      context.runId,
      JSON.stringify({ definition, mcpServers: [...context.mcpServers] }),
    );
  }

  // Serializes a Fleet context's current definition exactly as applyFleetMutation
  // persists it, so a failed mutation can restore the previous durable state.
  private fleetDefinitionJson(context: FleetContext): string {
    return JSON.stringify({
      definition: context.fleet.definition,
      mcpServers: [...context.mcpServers],
    });
  }

  // Restores in-memory and durable Fleet state after a failed mutation so no
  // partial state survives. The DB restore is best-effort; the in-memory truth is
  // authoritative and always restored first.
  private rollbackFleetMutation(
    context: FleetContext,
    fleetBefore: ResolvedFleet,
    jsonBefore: string,
  ): void {
    context.fleet = fleetBefore;
    try {
      this.db.updateFleetDefinition(context.runId, jsonBefore);
    } catch {
      // Durable rollback is best-effort; in-memory state already reflects the truth.
    }
  }

  private async reconnectFleetMember(context: FleetContext, memberId: string): Promise<void> {
    const fleetId = context.fleet.id;
    const target = qualifiedTarget(fleetId, memberId);
    const existing = this.live.get(target);
    const sessionId =
      existing?.session.sessionId ??
      this.db
        .fleetRun(context.runId, this.workspace)
        ?.sessions.find((session) => session.memberId === memberId)
        ?.sessionId;
    if (existing) {
      existing.unsubscribe();
      this.live.delete(target);
      await existing.session.disconnect().catch(() => undefined);
    }
    const member = context.fleet.members.get(memberId);
    if (!member) {
      return;
    }
    await this.connectSession(
      context.runId,
      target,
      memberId,
      fleetId,
      sessionId,
      this.memberConfig(
        member,
        this.createPeerMessageTools(fleetId, member),
        context.mcpServers,
        target,
      ),
      member.recipients,
      true,
      true,
    );
  }

  private async reconnectChangedPeers(
    context: FleetContext,
    force: Set<string>,
  ): Promise<string[]> {
    const reconnected: string[] = [];
    for (const [memberId, member] of context.fleet.members) {
      const live = this.live.get(qualifiedTarget(context.fleet.id, memberId));
      if (!live) {
        continue;
      }
      if (force.has(memberId) || !setsEqual(live.recipients, member.recipients)) {
        await this.reconnectFleetMember(context, memberId);
        reconnected.push(memberId);
      }
    }
    return reconnected;
  }

  // Captures the exact live membership (session id + recipients) of the named
  // members before a fallible mutation. Used together with restoreLiveMembers so a
  // rollback can rebuild members whose live entry vanished mid-failure, not only
  // those still present in the live map.
  private captureLiveMembers(
    context: FleetContext,
    memberIds: Iterable<string>,
  ): LiveMemberSnapshot[] {
    const snapshot: LiveMemberSnapshot[] = [];
    for (const memberId of memberIds) {
      const target = qualifiedTarget(context.fleet.id, memberId);
      const live = this.live.get(target);
      if (live) {
        snapshot.push({
          target,
          memberId,
          sessionId: live.session.sessionId,
          recipients: new Set(live.recipients),
        });
      }
    }
    return snapshot;
  }

  // Restores any snapshotted member missing from the live map by resuming its exact
  // captured session id (history suppressed, buffer retained). Members still present
  // are left untouched; reconnectChangedPeers realigns those whose recipients differ.
  private async restoreLiveMembers(
    context: FleetContext,
    snapshot: LiveMemberSnapshot[],
  ): Promise<void> {
    for (const entry of snapshot) {
      if (this.live.has(entry.target)) {
        continue;
      }
      const member = context.fleet.members.get(entry.memberId);
      if (!member) {
        continue;
      }
      this.db.upsertSession(context.runId, entry.memberId, entry.sessionId, "connected");
      try {
        await this.connectSession(
          context.runId,
          entry.target,
          entry.memberId,
          context.fleet.id,
          entry.sessionId,
          this.memberConfig(
            member,
            this.createPeerMessageTools(context.fleet.id, member),
            context.mcpServers,
            entry.target,
          ),
          member.recipients,
          true,
          true,
        );
      } catch {
        // Best-effort restoration; a member that cannot be restored is left disconnected.
      }
    }
  }

  recoverableFleetRuns(): Array<Record<string, unknown>> {
    return this.db
      .resumableFleetRuns(this.workspace)
      .flatMap((run) => {
        if (!run.fleetDefinition) return [];
        const { definition } = storedDynamicFleet(run.fleetDefinition);
        const validation = validateFleet(definition);
        if (!validation.valid) return [];
        return [{
          id: run.id,
          fleetId: run.fleetId,
          name: definition.name,
          status: run.status,
          startedAt: run.startedAt,
          endedAt: run.endedAt,
          members: run.sessions.map((session) => session.memberId),
        }];
      });
  }

  private memberPayload(fleetId: string, member: ResolvedMember): Record<string, unknown> {
    return {
      id: qualifiedTarget(fleetId, member.id),
      memberId: member.id,
      fleetId,
      displayName: member.displayName,
      description: member.description,
      recipients: [...member.recipients],
      autoStart: member.autoStart,
      ui: member.ui,
    };
  }

  private fleetPayload(context: FleetContext, recovered: boolean): Record<string, unknown> {
    const fleet = context.fleet;
    return {
      mode: "fleet",
      fleetId: fleet.id,
      name: fleet.name,
      recovered,
      entryMember: qualifiedTarget(fleet.id, fleet.entryMember),
      entryMemberId: fleet.entryMember,
      members: [...fleet.members.values()].map((member) => this.memberPayload(fleet.id, member)),
    };
  }

  private emitFleetLoading(
    context: FleetContext,
    recovered: boolean,
    connectingMembers: string[],
  ): void {
    this.emit(
      "fleet.loading",
      {
        ...this.fleetPayload(context, recovered),
        mode: "fleet-loading",
        connectingMembers: connectingMembers.map((id) =>
          qualifiedTarget(context.fleet.id, id)),
      },
      { runId: context.runId, target: "status", done: false },
    );
  }

  private emitFleetUpdated(
    context: FleetContext,
    changes: { added: string[]; updated: string[]; removed: string[] },
  ): void {
    const fleetId = context.fleet.id;
    const info = (id: string): Record<string, unknown> => {
      const member = context.fleet.members.get(id);
      return member
        ? this.memberPayload(fleetId, member)
        : { id: qualifiedTarget(fleetId, id), memberId: id, fleetId };
    };
    this.emit(
      "fleet.updated",
      {
        fleetId,
        entryMember: qualifiedTarget(fleetId, context.fleet.entryMember),
        entryMemberId: context.fleet.entryMember,
        added: changes.added.map(info),
        updated: changes.updated.map(info),
        removed: changes.removed.map((id) => qualifiedTarget(fleetId, id)),
        members: [...context.fleet.members.values()].map((member) =>
          this.memberPayload(fleetId, member)),
      },
      { runId: context.runId, target: "status", done: true },
    );
  }

  async sendUserPrompt(target: string, content: string): Promise<string> {
    const live = await this.activeSession(target);
    const runId = live.runId;
    const id = randomUUID();
    this.db.enqueueMessage(id, runId, "user", live.memberId, "user", content);
    try {
      const sdkMessageId = await live.session.send({ prompt: content, mode: "immediate" });
      this.db.completeMessage(id);
      this.emit(
        "prompt.accepted",
        { id, sdkMessageId, source: "user", target: live.memberId, content },
        { runId, memberId: live.target, target: "conversation" },
      );
      return sdkMessageId;
    } catch (error) {
      this.db.failMessage(id, error instanceof Error ? error.message : String(error), true);
      throw error;
    }
  }

  private async drainMailbox(fleetId: string, memberId: string): Promise<void> {
    const context = this.fleets.get(fleetId);
    if (!context) {
      return;
    }
    const live = await this.ensureFleetMember(fleetId, memberId);
    if (live.busy) {
      return;
    }
    const pending = this.db.claimMessages(context.runId, memberId);
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
        "and use the relevant send_to_<agent> tool if another member needs a direct answer.";
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
    return {
      standard: this.standard ? { runId: this.standard.runId } : undefined,
      fleets: [...this.fleets.entries()].map(([fleetId, context]) => ({
        fleetId,
        runId: context.runId,
        name: context.fleet.name,
        entryMember: qualifiedTarget(fleetId, context.fleet.entryMember),
        members: [...context.fleet.members.values()].map((member) => ({
          id: qualifiedTarget(fleetId, member.id),
          memberId: member.id,
          fleetId,
          displayName: member.displayName ?? member.id,
        })),
      })),
      members: [...this.live.values()].map((live) => ({
        id: live.target,
        memberId: live.memberId,
        fleetId: live.fleetId,
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
    for (const context of this.fleets.values()) {
      runIds.add(context.runId);
    }
    for (const live of this.live.values()) {
      live.unsubscribe();
    }
    this.live.clear();
    this.fleets.clear();
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
