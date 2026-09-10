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
import type { PrimaryStartupClaim } from "./database.js";
import {
  CALLER_SELECTOR,
  LEGACY_PRIMARY_SELECTOR,
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
const GITHUB_MCP_SERVER_NAME = "github-mcp-server";
const GITHUB_MCP_ENDPOINT_HOSTS = new Set([
  "api.githubcopilot.com",
  "api.individual.githubcopilot.com",
  "api.business.githubcopilot.com",
  "api.enterprise.githubcopilot.com",
]);
const GITHUB_MCP_ENDPOINT_PATHS = new Set(["/mcp", "/mcp/readonly"]);

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
  binding: SessionHandlerBinding;
  runId: string;
  // Runtime/UI identity: always "agent:<uuid>".
  target: string;
  // Durable agent UUID.
  agentId: string;
  // Tool-safe alias used only as a current human/tool selector.
  alias: string;
  // Lifecycle generation that established this SDK session. A transition bumps
  // the agent generation before any live session is removed, immediately making
  // callbacks and passive activation from the previous generation stale.
  generation: number;
  // Deterministic signature of everything this session's SessionConfig was built
  // from. Any difference means the live session must be reconnected with a rebuilt
  // config while preserving its session id and history.
  configSignature: string;
  /** Primary MCP server names used to build this connection's deny list. */
  availableMcpServers: Set<string>;
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
  historicalToolResults: Map<string, HistoricalToolResult>;
  lastEventAt: number;
  lastRecoveryAt: number;
  recoveringEvents: boolean;
  idleCycle: number;
  mailboxDrainCycle: number;
  approveAll: boolean;
  unsubscribe: () => void;
}

interface HistoricalToolResult {
  result?: unknown;
  error?: unknown;
}

interface AgentTransition {
  agentId: string;
  target: string;
  generation: number;
  reason: string;
}

interface SessionHandlerBinding {
  id: string;
  agentId: string;
  target: string;
  runId: string;
  generation: number;
  transition: AgentTransition | undefined;
  sessionId: string | undefined;
  resumeExisting: boolean;
  managedSettingsEnabled: boolean;
  active: boolean;
}

interface SessionContinuity {
  seenEventIds: Set<string>;
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
  idleCycle: number;
  mailboxDrainCycle: number;
}

interface SessionConnectionOptions {
  runId: string;
  target: string;
  agentId: string;
  alias: string;
  sessionId: string | undefined;
  config: SessionConfig;
  configSignature: string;
  availableMcpServers: Set<string>;
  resumeExisting?: boolean;
  continuity?: SessionContinuity;
  transition?: AgentTransition;
}

interface ConnectionRequest {
  runId: string;
  target: string;
  agentId: string;
  requestedSessionId: string | undefined;
  resumeExisting: boolean;
  configSignature: string;
  availableMcpServers: Set<string>;
  generation: number;
  transition: AgentTransition | undefined;
}

interface ConnectionAttempt {
  request: ConnectionRequest;
  promise: Promise<LiveSession>;
}

interface EnvironmentProbe {
  component: string;
  load: (session: CopilotSession) => Promise<unknown[]>;
}

type McpAuthHandler = NonNullable<SessionConfig["onMcpAuthRequest"]>;
type McpAuthRequest = Parameters<McpAuthHandler>[0];
type PermissionInvocation = Parameters<PermissionHandler>[1];
type PermissionHandlerResult = Awaited<ReturnType<PermissionHandler>>;
type PermissionDecision = Exclude<PermissionRequestResult, { kind: "no-result" }>;
type PermissionRejection = Extract<PermissionDecision, { kind: "reject" }>;
type PermissionNoResult = Extract<PermissionRequestResult, { kind: "no-result" }>;
type PermissionCeilingResult = PermissionRejection | PermissionNoResult;
type AttributedPermissionHandlerResult = Extract<
  PermissionHandlerResult,
  { kind: "attributed" }
>;
type ConcretePermissionHandlerResult =
  | PermissionDecision
  | (Omit<AttributedPermissionHandlerResult, "result"> & {
      result: PermissionDecision;
    });
type PermissionPolicyEvaluation =
  | { kind: "respond"; response: ConcretePermissionHandlerResult }
  | { kind: "prompt" };

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
  /** Durable staged-primary claim held until the new SDK session is connected. */
  primaryClaim?: PrimaryStartupClaim;
}

interface PrimaryContextClaim {
  context: AgentContext;
  recovered: boolean;
  sessionId: string | undefined;
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

function primaryAgentDefinition(alias: string): DynamicAgentDefinition {
  return {
    id: alias,
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
const HISTORY_CHUNK_MAX_BYTES = 512 * 1024;
const HISTORY_CHUNK_MAX_EVENTS = 500;
const MAILBOX_RETRY_BASE_MS = 250;
const MAILBOX_RETRY_MAX_MS = 5_000;
const omittedActivityEventTypes = new Set<SessionEvent["type"]>([
  "assistant.message_delta",
  "assistant.reasoning_delta",
]);

export interface HistorySourceEvent {
  id: string;
  type: string;
  timestamp: string;
  ephemeral?: boolean;
  agentId?: string;
  data: unknown;
}

export interface HistoryReplayEvent {
  id: string;
  type: string;
  timestamp: string;
  replayTimestamp: number;
  agentId?: string;
  data: Record<string, unknown>;
}

function historyShellId(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.match(/[Ss]hell[Ii]d[\s:=]+([\w-]+)/)?.[1];
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const direct = record.shellId ?? record.shell_id;
  if (direct !== undefined) {
    return String(direct);
  }
  for (const nested of Object.values(record)) {
    const found = historyShellId(nested);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function compactHistoryEvent(event: HistorySourceEvent): HistoryReplayEvent | undefined {
  if (event.ephemeral === true) {
    return undefined;
  }
  const data = event.data as unknown as Record<string, unknown>;
  let compactData: Record<string, unknown>;
  switch (event.type) {
    case "user.message":
      if (!data.content && !data.prompt) return undefined;
      compactData = {
        content: data.content,
        prompt: data.prompt,
        source: data.source,
      };
      break;
    case "assistant.message":
      if (event.agentId !== undefined || !data.content) return undefined;
      compactData = {
        content: data.content,
        messageId: data.messageId,
      };
      break;
    case "assistant.reasoning":
      if (event.agentId !== undefined || !data.content) return undefined;
      compactData = {
        content: data.content,
        reasoningId: data.reasoningId,
      };
      break;
    case "assistant.turn_start":
    case "assistant.turn_end":
      if (event.agentId !== undefined) return undefined;
      compactData = { turnId: data.turnId };
      break;
    case "tool.execution_start":
      if (event.agentId !== undefined) return undefined;
      compactData = {
        toolCallId: data.toolCallId,
        toolName: data.toolName,
        arguments: data.arguments,
        shellToolInfo: data.shellToolInfo,
      };
      break;
    case "tool.execution_complete":
      if (event.agentId !== undefined) return undefined;
      compactData = {
        toolCallId: data.toolCallId,
        toolName: data.toolName,
        success: data.success,
        error: data.error,
        resultDeferred: data.result !== undefined,
        shellId: historyShellId(data.result),
      };
      break;
    case "subagent.started":
    case "subagent.completed":
    case "subagent.failed":
    case "system.notification":
    case "session.schedule_created":
    case "session.schedule_cancelled":
    case "session.schedule_rearmed":
    case "session.error":
    case "session.warning":
    case "session.info":
      compactData = data;
      break;
    default:
      return undefined;
  }

  return {
    id: event.id,
    type: event.type,
    timestamp: event.timestamp,
    replayTimestamp: Date.parse(event.timestamp),
    ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
    data: compactData,
  };
}

function normalizedReasoningText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

function reasoningBlockSummary(data: Record<string, unknown>): string | undefined {
  const reasoningBlocks = data.reasoningBlocks;
  if (!reasoningBlocks || typeof reasoningBlocks !== "object") {
    return undefined;
  }
  const container = reasoningBlocks as Record<string, unknown>;
  if (container.provider !== "openai-responses" || !Array.isArray(container.blocks)) {
    return undefined;
  }
  const summaries: string[] = [];
  for (const block of container.blocks) {
    if (!block || typeof block !== "object") continue;
    const summary = (block as Record<string, unknown>).summary;
    if (!Array.isArray(summary)) continue;
    for (const item of summary) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      if (record.type !== "summary_text") continue;
      const text = normalizedReasoningText(record.text);
      if (text !== undefined) summaries.push(text);
    }
  }
  return summaries.length === 0 ? undefined : summaries.join("\n\n");
}

function readableMessageReasoning(data: Record<string, unknown>): string | undefined {
  return normalizedReasoningText(data.reasoningText) ?? reasoningBlockSummary(data);
}

function reasoningFingerprint(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

export function compactHistoryEvents(events: readonly HistorySourceEvent[]): HistoryReplayEvent[] {
  const turnsWithStandaloneReasoning = new Set<number>();
  let scannedTurn = 0;
  let scannedTurnSequence = 0;
  for (const event of events) {
    if (event.agentId === undefined && event.type === "assistant.turn_start") {
      scannedTurnSequence += 1;
      scannedTurn = scannedTurnSequence;
    } else if (event.agentId === undefined && event.type === "assistant.reasoning") {
      const data = event.data as unknown as Record<string, unknown>;
      if (normalizedReasoningText(data.content) !== undefined) {
        turnsWithStandaloneReasoning.add(scannedTurn);
      }
    } else if (event.agentId === undefined && event.type === "assistant.turn_end") {
      scannedTurn = 0;
    }
  }

  const compact: HistoryReplayEvent[] = [];
  let currentTurn = 0;
  let turnSequence = 0;
  const reasoningInTurn = new Set<string>();
  for (const event of events) {
    if (event.agentId === undefined && event.type === "assistant.turn_start") {
      turnSequence += 1;
      currentTurn = turnSequence;
      reasoningInTurn.clear();
    }
    const data = event.data as unknown as Record<string, unknown>;
    if (event.agentId === undefined && event.type === "assistant.reasoning") {
      const content = normalizedReasoningText(data.content);
      if (content !== undefined) {
        const fingerprint = reasoningFingerprint(content);
        if (reasoningInTurn.has(fingerprint)) continue;
        reasoningInTurn.add(fingerprint);
      }
    } else if (
      event.agentId === undefined &&
      event.type === "assistant.message" &&
      !turnsWithStandaloneReasoning.has(currentTurn)
    ) {
      const content = readableMessageReasoning(data);
      if (content !== undefined) {
        const fingerprint = reasoningFingerprint(content);
        if (!reasoningInTurn.has(fingerprint)) {
          reasoningInTurn.add(fingerprint);
          compact.push({
            id: `${event.id}:reasoning`,
            type: "assistant.reasoning",
            timestamp: event.timestamp,
            replayTimestamp: Date.parse(event.timestamp),
            data: {
              reasoningId: `${String(data.messageId ?? event.id)}:reasoning`,
              content,
            },
          });
        }
      }
    }
    const projected = compactHistoryEvent(event);
    if (projected !== undefined) compact.push(projected);
    if (event.agentId === undefined && event.type === "assistant.turn_end") {
      currentTurn = 0;
      reasoningInTurn.clear();
    }
  }
  return compact;
}

function historyChunks(events: HistoryReplayEvent[]): HistoryReplayEvent[][] {
  const chunks: HistoryReplayEvent[][] = [];
  let current: HistoryReplayEvent[] = [];
  let currentBytes = 2;
  for (const event of events) {
    const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8") + 1;
    if (
      current.length > 0 &&
      (
        current.length >= HISTORY_CHUNK_MAX_EVENTS ||
        currentBytes + eventBytes > HISTORY_CHUNK_MAX_BYTES
      )
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(event);
    currentBytes += eventBytes;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

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
      ["auth", "token", "--hostname", "github.com"],
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

export function isTrustedGitHubMcpEndpoint(serverUrl: string): boolean {
  try {
    const url = new URL(serverUrl);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.search === "" &&
      url.hash === "" &&
      GITHUB_MCP_ENDPOINT_HOSTS.has(url.hostname.toLowerCase()) &&
      GITHUB_MCP_ENDPOINT_PATHS.has(url.pathname)
    );
  } catch {
    return false;
  }
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

function reject(feedback: string): PermissionRejection {
  return { kind: "reject", feedback };
}

function withinPermissionCeiling(): PermissionNoResult {
  return { kind: "no-result" };
}

type ShellPermissionRequest = Extract<PermissionRequest, { kind: "shell" }>;

const RAW_READ_ONLY_GIT_COMMANDS = new Set([
  "annotate",
  "blame",
  "cat-file",
  "check-attr",
  "check-ignore",
  "check-mailmap",
  "check-ref-format",
  "count-objects",
  "describe",
  "diff",
  "diff-files",
  "diff-index",
  "diff-tree",
  "for-each-ref",
  "fsck",
  "grep",
  "help",
  "log",
  "ls-files",
  "ls-remote",
  "ls-tree",
  "merge-base",
  "name-rev",
  "rev-list",
  "rev-parse",
  "shortlog",
  "show",
  "show-branch",
  "show-index",
  "show-ref",
  "status",
  "verify-commit",
  "verify-pack",
  "verify-tag",
  "version",
  "whatchanged",
]);

function executableName(identifier: string): string {
  let normalized = identifier.trim();
  if (
    normalized.length >= 2 &&
    (
      (normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'"))
    )
  ) {
    normalized = normalized.slice(1, -1);
  }
  const segments = normalized.replaceAll("\\", "/").split("/");
  return segments[segments.length - 1]!.toLowerCase();
}

export function isGitExecutable(identifier: string): boolean {
  const name = executableName(identifier);
  return name === "git" || name === "git.exe" || name === "git.cmd" || name === "git.bat";
}

function tokenizeShellCommands(commandText: string): string[][] {
  const commands: string[][] = [];
  let tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  const pushToken = () => {
    if (token.length > 0) {
      tokens.push(token);
      token = "";
    }
  };
  const pushCommand = () => {
    pushToken();
    if (tokens.length > 0) {
      commands.push(tokens);
      tokens = [];
    }
  };

  for (let index = 0; index < commandText.length; index += 1) {
    const character = commandText[index]!;
    const nextCharacter = commandText[index + 1];
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else if (
        character === "\\" &&
        quote === '"' &&
        (nextCharacter === '"' || nextCharacter === "\\")
      ) {
        token += nextCharacter;
        index += 1;
      } else {
        token += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      pushToken();
      if (character === "\n" || character === "\r") {
        pushCommand();
      }
      continue;
    }
    if (character === ";" || character === "|" || character === "&") {
      pushCommand();
      while (commandText[index + 1] === character) {
        index += 1;
      }
      continue;
    }
    if (
      character === "\\" &&
      nextCharacter !== undefined &&
      /[\s'"\\;&|]/.test(nextCharacter)
    ) {
      token += nextCharacter;
      index += 1;
      continue;
    }
    token += character;
  }
  pushCommand();
  return commands;
}

function rawGitArguments(tokens: readonly string[]): string[] | undefined {
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) {
    index += 1;
  }
  let executable = executableName(tokens[index] ?? "");
  if (executable === "command" || executable === "exec" || executable === "nohup") {
    index += 1;
    while ((tokens[index] ?? "").startsWith("-")) {
      index += 1;
    }
    executable = executableName(tokens[index] ?? "");
  } else if (executable === "env" || executable === "env.exe") {
    index += 1;
    while (index < tokens.length) {
      const token = tokens[index]!;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        index += 1;
        continue;
      }
      if (token === "-u" || token === "--unset" || token === "-C" || token === "--chdir") {
        index += 2;
        continue;
      }
      if (token.startsWith("-")) {
        index += 1;
        continue;
      }
      break;
    }
    executable = executableName(tokens[index] ?? "");
  }
  return isGitExecutable(executable) ? [...tokens.slice(index + 1)] : undefined;
}

function rawGitInvocationIsWrite(arguments_: readonly string[]): boolean {
  const optionsWithValues = new Set([
    "-C",
    "-c",
    "--config-env",
    "--exec-path",
    "--git-dir",
    "--namespace",
    "--super-prefix",
    "--work-tree",
  ]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--help" || argument === "-h" || argument === "--version") {
      return false;
    }
    if (optionsWithValues.has(argument)) {
      index += 1;
      continue;
    }
    if (
      /^-(?:C|c).+/.test(argument) ||
      /^--(?:config-env|exec-path|git-dir|namespace|super-prefix|work-tree)=/.test(argument)
    ) {
      continue;
    }
    if (argument.startsWith("-")) {
      continue;
    }
    return !RAW_READ_ONLY_GIT_COMMANDS.has(argument.toLowerCase());
  }
  return false;
}

function rawTokensContainGitWrite(tokens: readonly string[]): boolean {
  const arguments_ = rawGitArguments(tokens);
  if (arguments_ !== undefined) {
    return rawGitInvocationIsWrite(arguments_);
  }

  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) {
    index += 1;
  }
  const executable = executableName(tokens[index] ?? "");
  if (executable === "sudo" || executable === "sudo.exe") {
    index += 1;
    const optionsWithValues = new Set([
      "-C",
      "-D",
      "-g",
      "-h",
      "-p",
      "-R",
      "-T",
      "-u",
      "--chdir",
      "--close-from",
      "--group",
      "--host",
      "--prompt",
      "--role",
      "--type",
      "--user",
    ]);
    while (index < tokens.length && tokens[index]!.startsWith("-")) {
      if (optionsWithValues.has(tokens[index]!)) {
        index += 2;
      } else {
        index += 1;
      }
    }
    return rawTokensContainGitWrite(tokens.slice(index));
  }

  let shellCommandOptions: ReadonlySet<string> | undefined;
  if (executable === "cmd" || executable === "cmd.exe") {
    shellCommandOptions = new Set(["/c", "/k"]);
  } else if (
    executable === "bash" ||
    executable === "bash.exe" ||
    executable === "dash" ||
    executable === "ksh" ||
    executable === "sh" ||
    executable === "sh.exe" ||
    executable === "zsh"
  ) {
    shellCommandOptions = new Set(["-c"]);
  } else if (
    executable === "powershell" ||
    executable === "powershell.exe" ||
    executable === "pwsh" ||
    executable === "pwsh.exe"
  ) {
    shellCommandOptions = new Set(["-c", "-command"]);
  }
  if (shellCommandOptions) {
    const commandOptions = shellCommandOptions;
    const commandIndex = tokens.findIndex(
      (token, tokenIndex) =>
        tokenIndex > index && commandOptions.has(token.toLowerCase()),
    );
    if (commandIndex >= 0 && commandIndex + 1 < tokens.length) {
      return rawCommandContainsGitWrite(tokens.slice(commandIndex + 1).join(" "));
    }
  }
  return false;
}

function rawCommandContainsGitWrite(commandText: string): boolean {
  return tokenizeShellCommands(commandText).some(rawTokensContainGitWrite);
}

/**
 * Uses the SDK's parsed executable and side-effect classification whenever it
 * is present. Raw command parsing is only a compatibility fallback.
 */
export function shellRequestContainsGitWrite(request: ShellPermissionRequest): boolean {
  const commands = request.commands as
    | Array<{ identifier?: unknown; readOnly?: unknown }>
    | undefined;
  if (
    Array.isArray(commands) &&
    commands.length > 0 &&
    commands.every(
      (command) =>
        typeof command.identifier === "string" &&
        typeof command.readOnly === "boolean",
    )
  ) {
    return commands.some(
      (command) =>
        command.readOnly === false &&
        isGitExecutable(command.identifier as string),
    );
  }
  return rawCommandContainsGitWrite(request.fullCommandText);
}

/**
 * Applies a concrete agent profile only as a narrowing ceiling. `no-result`
 * means the request passed that ceiling and still needs the parent policy.
 */
export function permissionDecision(
  profile: PermissionProfile,
  workspace: string,
  request: PermissionRequest,
): PermissionCeilingResult {
  switch (request.kind) {
      case "read":
        return isWithin(request.path, profile.paths.read, workspace)
          ? withinPermissionCeiling()
          : reject(`Read access is outside the configured path ceiling: ${request.path}`);
      case "write":
        return isWithin(request.fileName, profile.paths.write, workspace)
          ? withinPermissionCeiling()
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
        if (!profile.gitWrite && shellRequestContainsGitWrite(request)) {
          return reject("Git write operations are disabled for this agent.");
        }
        return withinPermissionCeiling();
      }
      case "url":
        return profile.network
          ? withinPermissionCeiling()
          : reject("Network access is disabled for this agent.");
      case "mcp":
        return profile.externalActions && toolAllowed(profile, request.toolName)
          ? withinPermissionCeiling()
          : reject(`MCP tool "${request.toolName}" is not permitted for this agent.`);
      case "custom-tool":
        return toolAllowed(profile, request.toolName)
          ? withinPermissionCeiling()
          : reject(`Custom tool "${request.toolName}" is not permitted for this agent.`);
      case "memory":
      case "hook":
      case "extension-management":
      case "extension-permission-access":
      case "factory":
        return profile.externalActions
          ? withinPermissionCeiling()
          : reject(`${request.kind} operations are disabled for this agent.`);
  }
}

/** Whether the parent grants non-interactive authority under this child posture. */
export function usesApproveAll(
  permission: DynamicPermission | undefined,
  mainAllowsAll: boolean,
): boolean {
  if (!mainAllowsAll) {
    return false;
  }
  if (permission && "mode" in permission) {
    return permission.mode !== "prompt";
  }
  return true;
}

function concretePermissionResponse(
  response: PermissionHandlerResult,
): ConcretePermissionHandlerResult | undefined {
  if (response.kind === "attributed") {
    if (response.result.kind === "no-result") {
      return undefined;
    }
    return {
      kind: "attributed",
      result: response.result,
      decisionContext: response.decisionContext,
    };
  }
  return response.kind === "no-result" ? undefined : response;
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
  // In-flight SDK connections keyed by target and the exact lifecycle request they
  // serve. Callers may only join an attempt for the same run/session/config.
  private readonly connecting = new Map<string, ConnectionAttempt>();
  private readonly agentGenerations = new Map<string, number>();
  private readonly transitions = new Map<string, AgentTransition>();
  private readonly sessionBindings = new Map<string, SessionHandlerBinding>();
  private readonly drainingMailboxes = new Set<string>();
  private readonly mailboxDrainRequested = new Set<string>();
  private readonly mailboxRetryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly mailboxRetryAttempts = new Map<string, number>();
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
  private readonly disqualifiedAgentIds = new Set<string>();
  private shuttingDown = false;
  // Spawn requests accepted while their primary caller is busy.
  private readonly pendingSpawns: Array<{
    callerAgentId: string;
    request: SpawnAgentsRequest;
  }> = [];
  private readonly pendingPermissions = new Map<
    string,
    {
      target: string;
      binding: SessionHandlerBinding;
      sessionId: string;
      requestKey: string;
      respond: (result: PermissionDecision) => void;
    }
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
    const ownedSessionIds = new Set(this.db.ownedSessionIds());
    const sessions = (await client.listSessions({ workingDirectory: this.workspace }))
      .filter(
        (session) =>
          !activeSessionIds.has(session.sessionId) &&
          !ownedSessionIds.has(session.sessionId),
      )
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

  private transitionUnavailable(
    context: AgentContext,
    transition = this.transitions.get(context.agentId),
  ): Error {
    return new Error(
      `Agent "${context.alias}" is temporarily unavailable while ${
        transition?.reason ?? "its lifecycle changes"
      }. Retry after the transition completes.`,
    );
  }

  private sessionBindingCurrent(
    binding: SessionHandlerBinding,
    sessionId?: string,
  ): boolean {
    if (
      !binding.active ||
      this.shuttingDown ||
      this.sessionBindings.get(binding.agentId) !== binding
    ) {
      return false;
    }
    const context = this.agents.get(binding.agentId);
    const transition = this.transitions.get(binding.agentId);
    if (
      !context ||
      context.target !== binding.target ||
      context.runId !== binding.runId ||
      this.agentGenerations.get(binding.agentId) !== binding.generation ||
      (
        binding.transition === undefined
          ? transition !== undefined
          : transition !== binding.transition
      )
    ) {
      return false;
    }
    if (sessionId !== undefined) {
      if (binding.sessionId !== undefined && binding.sessionId !== sessionId) {
        return false;
      }
      binding.sessionId = sessionId;
    }
    return true;
  }

  private invalidateSessionBinding(binding: SessionHandlerBinding, reason: string): void {
    if (!binding.active) {
      return;
    }
    binding.active = false;
    if (this.sessionBindings.get(binding.agentId) === binding) {
      this.sessionBindings.delete(binding.agentId);
    }
    const live = this.live.get(binding.target);
    if (live?.binding === binding && live.approveAll) {
      void live.session.rpc.permissions.setApproveAll({ enabled: false }).catch(() => undefined);
    }
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.binding !== binding) {
        continue;
      }
      this.pendingPermissions.delete(requestId);
      pending.respond(reject(`Permission request cancelled: ${reason}`));
    }
  }

  private activateSessionBinding(request: ConnectionRequest): SessionHandlerBinding {
    this.assertConnectionCurrent(request);
    const previous = this.sessionBindings.get(request.agentId);
    if (previous) {
      this.invalidateSessionBinding(previous, "the SDK session connection was replaced");
    }
    const binding: SessionHandlerBinding = {
      id: randomUUID(),
      agentId: request.agentId,
      target: request.target,
      runId: request.runId,
      generation: request.generation,
      transition: request.transition,
      sessionId: undefined,
      resumeExisting: request.resumeExisting,
      managedSettingsEnabled: false,
      active: true,
    };
    this.sessionBindings.set(request.agentId, binding);
    return binding;
  }

  private captureContinuity(live: LiveSession): SessionContinuity {
    return {
      seenEventIds: new Set(live.seenEventIds),
      modelId: live.modelId,
      aicUsed: live.aicUsed,
      busy: live.busy,
      foregroundBusy: live.foregroundBusy,
      foregroundTurnId: live.foregroundTurnId,
      foregroundTurnSequence: live.foregroundTurnSequence,
      foregroundCompleteTurnId: live.foregroundCompleteTurnId,
      foregroundTurnHasToolRequests: live.foregroundTurnHasToolRequests,
      foregroundAbortSequence: live.foregroundAbortSequence,
      sequence: live.sequence,
      idleCycle: live.idleCycle,
      mailboxDrainCycle: live.mailboxDrainCycle,
    };
  }

  private liveConnectionCurrent(live: LiveSession, allowTransition: boolean): boolean {
    const context = this.agents.get(live.agentId);
    if (
      this.live.get(live.target) !== live ||
      !context ||
      context.runId !== live.runId ||
      this.agentGenerations.get(live.agentId) !== live.generation ||
      !this.sessionBindingCurrent(live.binding, live.session.sessionId)
    ) {
      return false;
    }
    return allowTransition || !this.transitions.has(live.agentId);
  }

  private beginAgentTransition(context: AgentContext, reason: string): AgentTransition {
    if (this.shuttingDown) {
      throw new Error("The Copilot runtime is shutting down.");
    }
    const existing = this.transitions.get(context.agentId);
    if (existing) {
      throw this.transitionUnavailable(context, existing);
    }
    const transition: AgentTransition = {
      agentId: context.agentId,
      target: context.target,
      generation: (this.agentGenerations.get(context.agentId) ?? 0) + 1,
      reason,
    };
    this.agentGenerations.set(context.agentId, transition.generation);
    this.transitions.set(context.agentId, transition);
    const binding = this.sessionBindings.get(context.agentId);
    if (binding) {
      this.invalidateSessionBinding(binding, reason);
    }
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.target !== context.target) {
        continue;
      }
      this.pendingPermissions.delete(requestId);
      pending.respond(reject(`Permission request cancelled while ${reason}.`));
    }
    return transition;
  }

  private endAgentTransition(transition: AgentTransition, resumeMailbox: boolean): void {
    if (this.transitions.get(transition.agentId) !== transition) {
      return;
    }
    const context = this.agents.get(transition.agentId);
    const live = this.live.get(transition.target);
    if (
      context &&
      live &&
      live.agentId === context.agentId &&
      live.runId === context.runId &&
      live.configSignature === this.sessionSignature(context, live.availableMcpServers) &&
      live.binding.transition === transition &&
      this.sessionBindings.get(context.agentId) === live.binding &&
      live.binding.active
    ) {
      live.generation = transition.generation;
      live.binding.transition = undefined;
    } else {
      const binding = this.sessionBindings.get(transition.agentId);
      if (binding?.transition === transition) {
        this.invalidateSessionBinding(binding, "the lifecycle transition ended without a session");
      }
    }
    this.transitions.delete(transition.agentId);
    if (resumeMailbox && context && this.currentLive(context)) {
      this.scheduleMailboxDrain(context.target);
      if (context.agentId === this.primaryAgentId) {
        queueMicrotask(() => void this.drainPendingSpawns(context.agentId));
      }
    }
  }

  private assertTransitionAccess(
    context: AgentContext,
    transition?: AgentTransition,
  ): number {
    if (this.shuttingDown) {
      throw new Error("The Copilot runtime is shutting down.");
    }
    const active = this.transitions.get(context.agentId);
    if (transition === undefined) {
      if (active) {
        throw this.transitionUnavailable(context, active);
      }
      return this.agentGenerations.get(context.agentId) ?? 0;
    }
    if (
      active !== transition ||
      transition.agentId !== context.agentId ||
      transition.target !== context.target ||
      this.agentGenerations.get(context.agentId) !== transition.generation
    ) {
      throw new Error(
        `The lifecycle transition for agent "${context.alias}" is no longer current.`,
      );
    }
    return transition.generation;
  }

  private currentLive(context: AgentContext): LiveSession | undefined {
    if (this.transitions.has(context.agentId)) {
      return undefined;
    }
    const live = this.live.get(context.target);
    if (
      !live ||
      live.agentId !== context.agentId ||
      live.runId !== context.runId ||
      live.generation !== (this.agentGenerations.get(context.agentId) ?? 0) ||
      live.configSignature !== this.sessionSignature(context, live.availableMcpServers) ||
      !this.sessionBindingCurrent(live.binding, live.session.sessionId)
    ) {
      return undefined;
    }
    return live;
  }

  private liveSessionById(sessionId: string): LiveSession | undefined {
    return [...this.live.values()].find((live) => live.session.sessionId === sessionId);
  }

  private assertDurableSessionOwnership(sessionId: string, agentId: string): void {
    const owner = this.db.sessionOwner(sessionId);
    if (
      owner &&
      (owner.agentId !== agentId || owner.workspace !== this.workspace)
    ) {
      throw new Error(
        `SDK session "${sessionId}" belongs to durable agent "${owner.agentId}" in workspace ` +
          `"${owner.workspace}", not agent "${agentId}".`,
      );
    }
  }

  private assertLiveAvailable(live: LiveSession): AgentContext {
    const context = this.agents.get(live.agentId);
    if (!context) {
      throw new Error(`Agent "${live.agentId}" is no longer active.`);
    }
    this.assertTransitionAccess(context);
    if (this.currentLive(context) !== live) {
      throw new Error(
        `Agent "${context.alias}" no longer has the SDK session used by this operation.`,
      );
    }
    return context;
  }

  private async activeSession(target: string): Promise<LiveSession> {
    const route = routeTarget(target);
    const context = this.agents.get(route.agentId);
    if (!context) {
      throw new Error(`Agent "${route.agentId}" is not active.`);
    }
    this.assertTransitionAccess(context);
    return this.ensureAgentSession(route.agentId);
  }

  async listCommands(target: string): Promise<unknown[]> {
    const live = await this.activeSession(target);
    return (await live.session.rpc.commands.list()).commands;
  }

  async modelState(target: string): Promise<unknown> {
    const live = await this.activeSession(target);
    return this.modelStateForLive(live);
  }

  private async modelStateForLive(live: LiveSession): Promise<unknown> {
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
    const context = this.assertLiveAvailable(live);
    if (
      enabled &&
      !this.childMcpServerAllowed(context, serverName)
    ) {
      throw new Error(
        `MCP server "${serverName}" is outside agent "${context.alias}"'s effective allowlist.`,
      );
    }
    const result = enabled
      ? await live.session.rpc.mcp.enable({ serverName })
      : await live.session.rpc.mcp.disable({ serverName });
    return { result, servers: (await live.session.rpc.mcp.list()).servers };
  }

  async listMcpTools(target: string, serverName: string): Promise<unknown[]> {
    const live = await this.activeSession(target);
    const context = this.assertLiveAvailable(live);
    if (!this.childMcpServerAllowed(context, serverName)) {
      throw new Error(
        `MCP server "${serverName}" is outside agent "${context.alias}"'s effective allowlist.`,
      );
    }
    return (await live.session.rpc.mcp.listTools({ serverName })).tools;
  }

  async invokeCommand(target: string, name: string, input?: string): Promise<unknown> {
    const live = await this.activeSession(target);
    const result = await live.session.rpc.commands.invoke({
      name,
      ...(input === undefined ? {} : { input }),
    });
    if (!this.liveConnectionCurrent(live, false)) {
      throw new Error(
        `Command "/${name}" returned from an SDK session that is no longer current.`,
      );
    }
    if (result.kind !== "agent-prompt") {
      return result;
    }

    const id = randomUUID();
    const display = result.displayPrompt || `/${name}${input ? ` ${input}` : ""}`;
    this.db.enqueueMessage(id, live.runId, "user", live.target, "user", display);
    const claim = this.db.claimMessage(id, live.runId, live.target);
    if (!claim) {
      throw new Error(`Command message "${id}" could not be claimed for delivery.`);
    }
    this.emit(
      "prompt.queued",
      { id, source: "command", target: live.target, content: display },
      { runId: live.runId, memberId: live.target, target: "activity", done: false },
    );
    let sdkMessageId: string;
    try {
      sdkMessageId = await live.session.send({ prompt: result.prompt, mode: "immediate" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The durable row contains the user-facing slash command, while the SDK
      // prompt may be expanded or rewritten. Do not retry the display text as if
      // it were the authoritative command prompt.
      const failed = this.db.failMessage(
        claim.id,
        claim.runId,
        claim.target,
        claim.leaseToken,
        message,
        false,
      );
      if (failed) {
        this.emit(
          "prompt.failed",
          { id, source: "command", message },
          { runId: live.runId, memberId: live.target, target: "activity", done: true },
        );
      }
      throw error;
    }
    if (!this.liveConnectionCurrent(live, false)) {
      this.db.failMessage(
        claim.id,
        claim.runId,
        claim.target,
        claim.leaseToken,
        "The command was accepted by a superseded SDK session.",
        false,
      );
      throw new Error(
        `Command "/${name}" was accepted by an SDK session that is no longer current.`,
      );
    }
    if (!this.db.completeMessage(claim.id, claim.runId, claim.target, claim.leaseToken)) {
      throw new Error(
        `Command message "${id}" lost its delivery lease before completion.`,
      );
    }
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
    const context = this.assertLiveAvailable(live);
    let { servers } = await live.session.rpc.mcp.list();
    if (context.agentId !== this.primaryAgentId) {
      const disallowed = servers.filter(
        (server) => !this.childMcpServerAllowed(context, server.name),
      );
      for (const server of disallowed) {
        this.assertLiveAvailable(live);
        await live.session.rpc.mcp.disable({ serverName: server.name });
      }
      if (disallowed.length > 0) {
        ({ servers } = await live.session.rpc.mcp.list());
      }
    }
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
    if (!this.sessionBindingCurrent(pending.binding, pending.sessionId)) {
      pending.respond(
        reject("Permission request denied because its SDK session is no longer current."),
      );
      return false;
    }
    pending.respond(
      approved
        ? { kind: "approve-once", approvedInteractively: true }
        : reject("Permission rejected by the user in Neovim."),
    );
    return true;
  }

  private async evaluatePermissionRequest(
    permission: DynamicPermission | PermissionProfile | undefined,
    binding: SessionHandlerBinding,
    request: PermissionRequest,
    invocation: PermissionInvocation,
  ): Promise<PermissionPolicyEvaluation> {
    if (!this.sessionBindingCurrent(binding, invocation.sessionId)) {
      return {
        kind: "respond",
        response: reject(
          "Permission request denied because its agent lifecycle generation is no longer current.",
        ),
      };
    }
    if (invocation.managedSettingsEnabled !== undefined) {
      binding.managedSettingsEnabled = invocation.managedSettingsEnabled;
    }
    const context = this.agents.get(binding.agentId);
    if (!context) {
      return {
        kind: "respond",
        response: reject("Permission request denied because its agent is no longer active."),
      };
    }
    if (
      request.kind === "mcp" &&
      !this.childMcpServerAllowed(context, request.serverName)
    ) {
      return {
        kind: "respond",
        response: reject(
          `MCP server "${request.serverName}" is outside agent ` +
            `"${context.alias}"'s effective allowlist.`,
        ),
      };
    }
    const ceiling = permission && !("mode" in permission) ? permission : undefined;
    if (ceiling) {
      // A concrete child profile can veto the request, but an allowed match does
      // not itself grant authority; approval still follows the main policy below.
      const response = permissionDecision(ceiling, this.workspace, request);
      if (response.kind === "reject") {
        return { kind: "respond", response };
      }
    }
    if (usesApproveAll(permission, this.policy.allowAll)) {
      if (
        binding.managedSettingsEnabled ||
        request.managedApprovalRequired === true
      ) {
        return { kind: "prompt" };
      }
      const response = await approveAll(request, invocation);
      if (!this.sessionBindingCurrent(binding, invocation.sessionId)) {
        return {
          kind: "respond",
          response: reject(
            "Permission request denied because its SDK session is no longer current.",
          ),
        };
      }
      const concreteResponse = concretePermissionResponse(response);
      return concreteResponse === undefined
        ? { kind: "prompt" }
        : { kind: "respond", response: concreteResponse };
    }
    return { kind: "prompt" };
  }

  private promptPermission(
    requestId: string,
    request: PermissionRequest,
    binding: SessionHandlerBinding,
    sessionId: string,
    respond: (result: PermissionDecision) => void,
  ): void {
    if (!this.sessionBindingCurrent(binding, sessionId)) {
      respond(
        reject("Permission request denied because its SDK session is no longer current."),
      );
      return;
    }
    this.pendingPermissions.set(requestId, {
      target: binding.target,
      binding,
      sessionId,
      requestKey: stableStringify(request),
      respond,
    });
    this.emit(
      "permission.requested",
      { requestId, request },
      {
        runId: binding.runId,
        memberId: binding.target,
        target: "status",
        done: false,
      },
    );
  }

  private permissionHandler(
    permission: DynamicPermission | PermissionProfile | undefined,
    binding: SessionHandlerBinding,
  ): PermissionHandler {
    return async (
      request,
      invocation,
    ): Promise<PermissionHandlerResult> => {
      const evaluation = await this.evaluatePermissionRequest(
        permission,
        binding,
        request,
        invocation,
      );
      if (evaluation.kind === "respond") {
        return evaluation.response;
      }
      const requestId = randomUUID();
      return new Promise<PermissionDecision>((resolve) => {
        this.promptPermission(
          requestId,
          request,
          binding,
          invocation.sessionId,
          resolve,
        );
      });
    };
  }

  private async recoverSilentSessions(): Promise<void> {
    const now = Date.now();
    const recoveries: Promise<void>[] = [];
    for (const live of this.live.values()) {
      if (
        this.agentGenerations.get(live.agentId) === live.generation
        && !this.transitions.has(live.agentId)
        && live.busy
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
      if (!this.liveConnectionCurrent(live, false)) {
        return;
      }
      for (const event of events) {
        if (!live.seenEventIds.has(event.id)) {
          this.handleSessionEvent(live, event);
        }
      }
      const permissionRequests = new Map<string, PermissionRequest>();
      for (const event of events) {
        if (
          event.type === "permission.requested" &&
          event.data.resolvedByHook !== true
        ) {
          permissionRequests.set(event.data.requestId, event.data.permissionRequest);
        }
      }

      const { items } = await live.session.rpc.permissions.pendingRequests();
      if (!this.liveConnectionCurrent(live, false)) {
        return;
      }
      for (const pending of items) {
        if (!this.liveConnectionCurrent(live, false)) {
          return;
        }
        if (this.pendingPermissions.has(pending.requestId)) {
          continue;
        }
        const request = permissionRequests.get(pending.requestId);
        if (!request) {
          await live.session.rpc.permissions.handlePendingPermissionRequest({
            requestId: pending.requestId,
            result: reject(
              "Permission request denied because its original policy inputs could not be " +
                "reconstructed safely.",
            ),
          });
          continue;
        }
        const requestKey = stableStringify(request);
        if (
          [...this.pendingPermissions.values()].some(
            (active) =>
              active.binding === live.binding &&
              active.sessionId === live.session.sessionId &&
              active.requestKey === requestKey,
          )
        ) {
          continue;
        }
        const context = this.agents.get(live.agentId);
        if (!context) {
          return;
        }
        let evaluation: PermissionPolicyEvaluation;
        try {
          evaluation = await this.evaluatePermissionRequest(
            context.agent.permission,
            live.binding,
            request,
            {
              sessionId: live.session.sessionId,
              managedSettingsEnabled: live.binding.managedSettingsEnabled,
            },
          );
        } catch {
          if (!this.liveConnectionCurrent(live, false)) {
            return;
          }
          await live.session.rpc.permissions.handlePendingPermissionRequest({
            requestId: pending.requestId,
            result: { kind: "user-not-available" },
          });
          continue;
        }
        if (!this.liveConnectionCurrent(live, false)) {
          return;
        }
        if (evaluation.kind === "respond") {
          if (evaluation.response.kind === "attributed") {
            await live.session.rpc.permissions.handlePendingPermissionRequest({
              requestId: pending.requestId,
              result: evaluation.response.result,
              decisionContext: evaluation.response.decisionContext,
            });
          } else {
            await live.session.rpc.permissions.handlePendingPermissionRequest({
              requestId: pending.requestId,
              result: evaluation.response,
            });
          }
          continue;
        }
        this.promptPermission(
          pending.requestId,
          request,
          live.binding,
          live.session.sessionId,
          (result) => {
            void live.session.rpc.permissions
              .handlePendingPermissionRequest({ requestId: pending.requestId, result })
              .catch((error: unknown) => {
                if (!this.liveConnectionCurrent(live, false)) {
                  return;
                }
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
        );
      }
    } catch (error) {
      if (this.liveConnectionCurrent(live, false)) {
        this.emit(
          "tasks.error",
          {
            message: `Session recovery failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          { runId: live.runId, memberId: live.target, target: "status", done: true },
        );
      }
    } finally {
      live.recoveringEvents = false;
    }
  }

  private baseSessionConfig(): SessionConfig {
    return nativeSessionScaffold(this.policy);
  }

  private bindSessionHandlers(
    config: SessionConfig,
    permission: DynamicPermission | undefined,
    binding: SessionHandlerBinding,
  ): SessionConfig {
    binding.managedSettingsEnabled =
      config.enableManagedSettings === true || config.managedSettings !== undefined;
    return {
      ...config,
      onPermissionRequest: this.permissionHandler(permission, binding),
      onMcpAuthRequest: this.mcpAuthHandler(binding),
    };
  }

  private async githubMcpAuthTrustFailure(
    request: McpAuthRequest,
    binding: SessionHandlerBinding,
  ): Promise<string | undefined> {
    if (request.serverName !== GITHUB_MCP_SERVER_NAME) {
      return "This MCP server requires a host authentication provider.";
    }
    if (!isTrustedGitHubMcpEndpoint(request.serverUrl)) {
      return "The reserved GitHub MCP name requested credentials for an untrusted endpoint.";
    }
    if (Object.hasOwn(this.policy.mcpServers, GITHUB_MCP_SERVER_NAME)) {
      return "A launch-provided MCP configuration overrides the reserved GitHub MCP server name.";
    }
    const client = this.client;
    if (!client) {
      return "The MCP server provenance could not be verified.";
    }
    const [discovered, userConfigured] = await Promise.all([
      client.rpc.mcp.discover({ workingDirectory: this.workspace }),
      client.rpc.mcp.config.list(),
    ]);
    if (Object.hasOwn(userConfigured.servers, GITHUB_MCP_SERVER_NAME)) {
      return "A user-defined MCP configuration overrides the reserved GitHub MCP server name.";
    }
    const discoveredMatching = discovered.servers.filter(
      (server) => server.name === GITHUB_MCP_SERVER_NAME,
    );
    if (
      discoveredMatching.length !== 1 ||
      discoveredMatching[0]!.source !== "builtin" ||
      discoveredMatching[0]!.enabled !== true
    ) {
      return "The reserved GitHub MCP server is not the unique built-in server for this workspace.";
    }
    if (binding.resumeExisting) {
      const live = this.live.get(binding.target);
      if (!live || live.binding !== binding) {
        return "A resumed session's persisted MCP provenance is not yet available.";
      }
      const sessionMatching = (await live.session.rpc.mcp.list()).servers.filter(
        (server) => server.name === GITHUB_MCP_SERVER_NAME,
      );
      if (sessionMatching.length !== 1 || sessionMatching[0]!.source !== "builtin") {
        return "The resumed session does not expose the trusted built-in GitHub MCP server.";
      }
    }
    return undefined;
  }

  private mcpAuthHandler(binding: SessionHandlerBinding): McpAuthHandler {
    return async (request, invocation) => {
      if (!this.sessionBindingCurrent(binding, invocation.sessionId)) {
        return { kind: "cancelled" };
      }
      const context = this.agents.get(binding.agentId);
      if (
        context &&
        !this.childMcpServerAllowed(context, request.serverName)
      ) {
        this.emit(
          "environment.error",
          {
            component: `${request.serverName} authentication`,
            message: "This MCP server is outside the agent's captured allowlist.",
          },
          {
            runId: binding.runId,
            memberId: binding.target,
            target: "activity",
            done: true,
          },
        );
        return { kind: "cancelled" };
      }
      let trustFailure: string | undefined;
      try {
        trustFailure = await this.githubMcpAuthTrustFailure(request, binding);
      } catch {
        trustFailure = "The MCP server provenance could not be verified.";
      }
      if (!this.sessionBindingCurrent(binding, invocation.sessionId)) {
        return { kind: "cancelled" };
      }
      if (trustFailure !== undefined) {
        this.emit(
          "environment.error",
          {
            component: `${request.serverName} authentication`,
            message: trustFailure,
          },
          {
            runId: binding.runId,
            memberId: binding.target,
            target: "activity",
            done: true,
          },
        );
        return { kind: "cancelled" };
      }

      const component = "GitHub MCP authentication";
      this.emit(
        "environment.progress",
        { component, message: "Reading credentials from the authenticated GitHub CLI" },
        {
          runId: binding.runId,
          memberId: binding.target,
          target: "activity",
          done: false,
        },
      );
      try {
        const accessToken = await githubCliAuthToken();
        if (!this.sessionBindingCurrent(binding, invocation.sessionId)) {
          return { kind: "cancelled" };
        }
        this.emit(
          "environment.loaded",
          { component, items: [{ status: "authenticated" }] },
          {
            runId: binding.runId,
            memberId: binding.target,
            target: "activity",
            done: true,
          },
        );
        return { kind: "token", accessToken };
      } catch {
        if (!this.sessionBindingCurrent(binding, invocation.sessionId)) {
          return { kind: "cancelled" };
        }
        this.emit(
          "environment.error",
          {
            component,
            message: "Run `gh auth login` and restart the Copilot session.",
          },
          {
            runId: binding.runId,
            memberId: binding.target,
            target: "activity",
            done: true,
          },
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
        if (
          refresh !== live.taskRefresh ||
          this.live.get(live.target) !== live ||
          this.agentGenerations.get(live.agentId) !== live.generation
        ) {
          return;
        }
        this.emit(
          "tasks.changed",
          { tasks },
          { runId: live.runId, memberId: live.target, target: "status", done: true },
        );
      })
      .catch((error: unknown) => {
        if (
          refresh !== live.taskRefresh ||
          this.live.get(live.target) !== live ||
          this.agentGenerations.get(live.agentId) !== live.generation
        ) {
          return;
        }
        this.emit(
          "tasks.error",
          { message: error instanceof Error ? error.message : String(error) },
          { runId: live.runId, memberId: live.target, target: "status", done: true },
        );
      });
  }

  private effectiveMcpServers(context: AgentContext): ReadonlySet<string> {
    return context.agent.mcpServers ?? context.mcpServers;
  }

  private childMcpServerAllowed(context: AgentContext, serverName: string): boolean {
    return (
      context.agentId === this.primaryAgentId ||
      (
        this.effectiveMcpServers(context).has(serverName) &&
        !this.policy.disabledMcpServers.includes(serverName)
      )
    );
  }

  private agentConfig(
    context: AgentContext,
    availableMcpServers: ReadonlySet<string>,
  ): SessionConfig {
    // Start from the identical native base the primary session uses. The base has
    // already layered the canonical native policy, so everything below only narrows
    // or deliberately overrides individual inherited fields.
    const agent = context.agent;
    const config = this.baseSessionConfig();
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
    if (context.agentId !== this.primaryAgentId) {
      const effectiveMcpServers = this.effectiveMcpServers(context);
      for (const server of effectiveMcpServers) {
        if (!context.mcpServers.has(server)) {
          throw new Error(
            `Agent "${context.alias}" attempted to widen its captured MCP ceiling with "${server}".`,
          );
        }
      }
      const knownServers = new Set([
        ...availableMcpServers,
        ...context.mcpServers,
      ]);
      config.disabledMcpServers = [
        ...new Set([
          ...(config.disabledMcpServers ?? []),
          ...[...knownServers].filter((server) => !effectiveMcpServers.has(server)),
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
        this.assertTransitionAccess(source);
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
          this.assertLiveAvailable(live);
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
            this.assertLiveAvailable(live);
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
        this.assertLiveAvailable(live);
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
      // canonical native ceiling, never widen it. The profile grants no approval
      // authority of its own, so skipPermission on the management tool cannot turn
      // an interactive parent into an auto-approving child.
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
      if (context.runId === agentRef || this.lookupAgentSessionId(context) === agentRef) {
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
    this.assertTransitionAccess(context);
    return context;
  }

  private agentState(context: AgentContext): string {
    if (this.transitions.has(context.agentId)) {
      return "loading";
    }
    const live = this.currentLive(context);
    if (!live) {
      return "loading";
    }
    return live.foregroundBusy ? "busy" : "idle";
  }

  private storedAgentJson(context: AgentContext): string {
    this.sanitizeContextAcls(context);
    return this.storedAgentJsonFor(
      context,
      context.definition,
      context.canTalkTo,
      context.canObserve,
    );
  }

  private storedAgentJsonFor(
    context: AgentContext,
    definition: DynamicAgentDefinition,
    canTalkTo: ReadonlySet<string>,
    canObserve: ReadonlySet<string>,
  ): string {
    const record: StoredAgentRecord = {
      definition,
      mcpServers: [...context.mcpServers],
      canTalkToAgentIds: [...canTalkTo],
      canObserveAgentIds: [...canObserve],
    };
    return JSON.stringify(record);
  }

  private async availableMcpServers(): Promise<Set<string>> {
    const context = this.primaryAgentId === undefined
      ? undefined
      : this.agents.get(this.primaryAgentId);
    const primary = context === undefined ? undefined : this.currentLive(context);
    if (!primary) {
      throw new Error(
        "The primary agent must be ready before an additional agent MCP ceiling can be built.",
      );
    }
    return new Set((await primary.session.rpc.mcp.list()).servers.map((server) => server.name));
  }

  private async sessionConnectionPlan(
    context: AgentContext,
  ): Promise<{
    availableMcpServers: Set<string>;
    config: SessionConfig;
    configSignature: string;
  }> {
    const availableMcpServers =
      context.agentId === this.primaryAgentId
        ? new Set<string>()
        : await this.availableMcpServers();
    return {
      availableMcpServers,
      config: this.agentConfig(context, availableMcpServers),
      configSignature: this.sessionSignature(context, availableMcpServers),
    };
  }

  /**
   * The complete signature of the SessionConfig an agent would be connected with:
   * its full definition, original MCP ceiling, and the primary MCP list used to
   * derive the connection's explicit deny list.
   */
  private sessionSignature(
    context: AgentContext,
    availableMcpServers: ReadonlySet<string>,
  ): string {
    return stableStringify({
      definition: context.definition,
      mcpCeiling: [...context.mcpServers].sort(),
      availableMcpServers:
        context.agentId === this.primaryAgentId
          ? []
          : [...availableMcpServers].sort(),
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
    if (this.transitions.has(context.agentId)) {
      return undefined;
    }
    return this.lookupAgentSessionId(context);
  }

  private lookupAgentSessionId(context: AgentContext): string | undefined {
    return (
      this.currentLive(context)?.session.sessionId ??
      this.live.get(context.target)?.session.sessionId ??
      this.db.session(context.runId)?.sessionId
    );
  }

  private registerAgent(context: AgentContext): void {
    const existingAgentId = this.aliasIndex.get(context.alias);
    if (existingAgentId !== undefined && existingAgentId !== context.agentId) {
      throw new Error(
        `Alias "${context.alias}" is already used by active agent "${existingAgentId}".`,
      );
    }
    this.agents.set(context.agentId, context);
    this.aliasIndex.set(context.alias, context.agentId);
    if (!this.agentGenerations.has(context.agentId)) {
      this.agentGenerations.set(context.agentId, 0);
    }
  }

  private unregisterAgent(context: AgentContext): void {
    const binding = this.sessionBindings.get(context.agentId);
    if (binding) {
      this.invalidateSessionBinding(binding, `agent "${context.alias}" was unregistered`);
    }
    this.agents.delete(context.agentId);
    if (this.aliasIndex.get(context.alias) === context.agentId) {
      this.aliasIndex.delete(context.alias);
    }
    this.cancelMailboxRetry(context.target);
    this.mailboxDrainRequested.delete(context.target);
  }

  private sanitizeContextAcls(context: AgentContext, alreadyChanged = false): boolean {
    let changed = alreadyChanged;
    for (const agentId of this.disqualifiedAgentIds) {
      changed = context.canTalkTo.delete(agentId) || changed;
      changed = context.canObserve.delete(agentId) || changed;
    }
    const isDisqualifiedSelector = (selector: string): boolean => {
      if (this.disqualifiedAgentIds.has(selector)) {
        return true;
      }
      if (
        selector.startsWith(AGENT_TARGET_PREFIX) &&
        this.disqualifiedAgentIds.has(
          selector.slice(AGENT_TARGET_PREFIX.length),
        )
      ) {
        return true;
      }
      return false;
    };
    const canTalkTo = context.definition.canTalkTo.filter(
      (selector) => !isDisqualifiedSelector(selector),
    );
    const canObserve = context.definition.canObserve.filter(
      (selector) => !isDisqualifiedSelector(selector),
    );
    if (
      canTalkTo.length !== context.definition.canTalkTo.length ||
      canObserve.length !== context.definition.canObserve.length
    ) {
      changed = true;
    }
    if (changed) {
      context.definition = {
        ...context.definition,
        canTalkTo,
        canObserve,
      };
      context.agent = {
        ...context.agent,
        recipientSelectors: new Set(canTalkTo),
        observeSelectors: new Set(canObserve),
      };
      const live = this.live.get(context.target);
      if (live && live.runId === context.runId) {
        live.configSignature = this.sessionSignature(
          context,
          live.availableMcpServers,
        );
      }
    }
    return changed;
  }

  private synchronizeDisqualifiedAgent(agentId: string, alias: string): void {
    this.disqualifiedAgentIds.add(agentId);
    for (const context of this.agents.values()) {
      if (context.agentId !== agentId) {
        const canTalkTo = context.definition.canTalkTo.filter(
          (selector) => selector !== alias,
        );
        const canObserve = context.definition.canObserve.filter(
          (selector) => selector !== alias,
        );
        const aliasChanged =
          canTalkTo.length !== context.definition.canTalkTo.length ||
          canObserve.length !== context.definition.canObserve.length;
        if (aliasChanged) {
          context.definition = {
            ...context.definition,
            canTalkTo,
            canObserve,
          };
        }
        this.sanitizeContextAcls(context, aliasChanged);
      }
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
      if (this.disqualifiedAgentIds.has(agentId)) {
        throw new Error(`Agent selector "${selector}" refers to a permanently failed agent.`);
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
    this.assertTransitionAccess(current);

    const matched = this.resolveAgentRef(selector);
    if (!matched) {
      throw new Error(
        `Recipient "${selector}" is not a known active agent. Call ` +
          "native_copilot_list_recipients to refresh the authorized mapping.",
      );
    }
    const recipientTransition = this.transitions.get(matched.agentId);
    if (recipientTransition) {
      throw this.transitionUnavailable(matched, recipientTransition);
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
    this.scheduleMailboxDrain(recipient.target);
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
          this.assertTransitionAccess(source);
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
          this.assertTransitionAccess(source);
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

  private connectionRequest(options: SessionConnectionOptions): ConnectionRequest {
    const context = this.agents.get(options.agentId);
    if (!context) {
      throw new Error(`Agent "${options.agentId}" is not active.`);
    }
    const generation = this.assertTransitionAccess(context, options.transition);
    if (
      context.target !== options.target ||
      context.runId !== options.runId ||
      this.sessionSignature(context, options.availableMcpServers) !== options.configSignature
    ) {
      throw new Error(
        `The requested SDK connection for agent "${context.alias}" no longer matches its ` +
          "current run or configuration.",
      );
    }
    return {
      runId: options.runId,
      target: options.target,
      agentId: options.agentId,
      requestedSessionId: options.sessionId,
      resumeExisting: options.resumeExisting === true,
      configSignature: options.configSignature,
      availableMcpServers: new Set(options.availableMcpServers),
      generation,
      transition: options.transition,
    };
  }

  private assertConnectionCurrent(request: ConnectionRequest): AgentContext {
    const context = this.agents.get(request.agentId);
    if (!context) {
      throw new Error(`Agent "${request.agentId}" is no longer active.`);
    }
    const activeTransition = this.transitions.get(request.agentId);
    if (
      this.shuttingDown ||
      this.agentGenerations.get(request.agentId) !== request.generation ||
      (request.transition === undefined
        ? activeTransition !== undefined
        : activeTransition !== request.transition) ||
      context.target !== request.target ||
      context.runId !== request.runId ||
      this.sessionSignature(context, request.availableMcpServers) !== request.configSignature
    ) {
      throw this.transitionUnavailable(context, activeTransition);
    }
    return context;
  }

  private connectionAttemptMatches(
    attempt: ConnectionRequest,
    requested: ConnectionRequest,
  ): boolean {
    return (
      attempt.runId === requested.runId &&
      attempt.target === requested.target &&
      attempt.agentId === requested.agentId &&
      attempt.resumeExisting === requested.resumeExisting &&
      attempt.configSignature === requested.configSignature &&
      attempt.generation === requested.generation &&
      attempt.transition === requested.transition &&
      (
        requested.requestedSessionId === undefined ||
        attempt.requestedSessionId === requested.requestedSessionId
      )
    );
  }

  private assertLiveMatchesRequest(live: LiveSession, request: ConnectionRequest): void {
    this.assertConnectionCurrent(request);
    if (
      live.runId !== request.runId ||
      live.target !== request.target ||
      live.agentId !== request.agentId ||
      live.configSignature !== request.configSignature ||
      live.generation !== request.generation ||
      !this.sessionBindingCurrent(live.binding, live.session.sessionId) ||
      (
        request.requestedSessionId !== undefined &&
        live.session.sessionId !== request.requestedSessionId
      )
    ) {
      throw new Error(
        `The live SDK session for "${request.target}" does not match the requested run, ` +
          "session, configuration, or lifecycle generation.",
      );
    }
  }

  private async connectSession(options: SessionConnectionOptions): Promise<LiveSession> {
    const request = this.connectionRequest(options);
    const existing = this.live.get(options.target);
    if (existing) {
      this.assertLiveMatchesRequest(existing, request);
      return existing;
    }
    return this.trackConnection(options, request);
  }

  /**
   * Joins only an in-flight connection for the exact requested run, session,
   * configuration, and lifecycle generation. A mismatched attempt is never reused.
   */
  private async trackConnection(
    options: SessionConnectionOptions,
    request = this.connectionRequest(options),
  ): Promise<LiveSession> {
    const inFlight = this.connecting.get(options.target);
    if (inFlight) {
      if (!this.connectionAttemptMatches(inFlight.request, request)) {
        const context = this.assertConnectionCurrent(request);
        throw new Error(
          `Agent "${context.alias}" already has a different SDK connection attempt in progress. ` +
            "Retry after its lifecycle transition completes.",
        );
      }
      const live = await inFlight.promise;
      this.assertLiveMatchesRequest(live, request);
      return live;
    }
    const attempt: ConnectionAttempt = {
      request,
      promise: this.establishSession(options, request),
    };
    this.connecting.set(options.target, attempt);
    try {
      const live = await attempt.promise;
      this.assertLiveMatchesRequest(live, request);
      return live;
    } finally {
      if (this.connecting.get(options.target) === attempt) {
        this.connecting.delete(options.target);
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
    availableMcpServers: Set<string>;
    resumeExisting?: boolean;
    continuity?: SessionContinuity;
    transition?: AgentTransition;
  }, request: ConnectionRequest): Promise<LiveSession> {
    const { runId, target, agentId, alias, sessionId, config } = options;
    const resumeExisting = options.resumeExisting === true;
    let session: CopilotSession | undefined;
    let live: LiveSession | undefined;
    let binding: SessionHandlerBinding | undefined;
    let persistedSessionId: string | undefined;
    try {
      const context = this.assertConnectionCurrent(request);
      if (sessionId !== undefined) {
        const liveOwner = this.liveSessionById(sessionId);
        if (liveOwner) {
          throw new Error(
            `SDK session "${sessionId}" is already live as agent "${liveOwner.alias}".`,
          );
        }
        this.assertDurableSessionOwnership(sessionId, agentId);
        this.db.upsertSession(runId, sessionId, "connecting");
        persistedSessionId = sessionId;
      }
      binding = this.activateSessionBinding(request);
      const boundConfig = this.bindSessionHandlers(config, context.agent.permission, binding);
      const client = await this.ensureClient();
      this.assertConnectionCurrent(request);
      if (sessionId && (resumeExisting || this.knownSessionIds.has(sessionId))) {
        // Managed sessions are never silently recreated: a missing SDK conversation
        // would discard schedules and state that SQLite intentionally does not copy.
        session = await client.resumeSession(sessionId, {
          ...boundConfig,
          suppressResumeEvent: true,
        });
      } else {
        session = await client.createSession(boundConfig);
      }
      const actualSessionId = session.sessionId;
      if (sessionId !== undefined && actualSessionId !== sessionId) {
        throw new Error(
          `Copilot connected session "${actualSessionId}" instead of requested session ` +
            `"${sessionId}".`,
        );
      }
      this.assertConnectionCurrent(request);
      if (!this.sessionBindingCurrent(binding, actualSessionId)) {
        throw new Error(
          `Copilot session "${actualSessionId}" belongs to a stale agent lifecycle generation.`,
        );
      }
      this.assertDurableSessionOwnership(actualSessionId, agentId);
      this.db.upsertSession(runId, actualSessionId, "connected");
      persistedSessionId = actualSessionId;
      await session.rpc.permissions.setApproveAll({ enabled: false });
      this.assertConnectionCurrent(request);
      if (!this.sessionBindingCurrent(binding, actualSessionId)) {
        throw new Error(
          `Copilot session "${actualSessionId}" became stale while permissions were initialized.`,
        );
      }
      this.knownSessionIds.add(actualSessionId);
      const continuity = options.continuity;
      live = {
        session,
        binding,
        runId,
        target,
        agentId,
        alias,
        generation: request.generation,
        configSignature: options.configSignature,
        availableMcpServers: new Set(options.availableMcpServers),
        modelId: continuity?.modelId ?? config.model,
        aicUsed: continuity?.aicUsed ?? 0,
        busy: continuity?.busy ?? false,
        foregroundBusy: continuity?.foregroundBusy ?? false,
        foregroundTurnId: continuity?.foregroundTurnId,
        foregroundTurnSequence: continuity?.foregroundTurnSequence ?? 0,
        foregroundCompleteTurnId: continuity?.foregroundCompleteTurnId,
        foregroundTurnHasToolRequests: continuity?.foregroundTurnHasToolRequests ?? false,
        foregroundAbortSequence: continuity?.foregroundAbortSequence,
        sequence: continuity?.sequence ?? 0,
        taskRefresh: 0,
        seenEventIds: new Set(continuity?.seenEventIds ?? []),
        historicalToolResults: new Map(),
        lastEventAt: Date.now(),
        lastRecoveryAt: 0,
        recoveringEvents: false,
        idleCycle: continuity?.idleCycle ?? 1,
        mailboxDrainCycle: continuity?.mailboxDrainCycle ?? 0,
        approveAll: usesApproveAll(context.agent.permission, this.policy.allowAll),
        unsubscribe: () => undefined,
      };
      this.assertConnectionCurrent(request);
      this.live.set(target, live);
      live.unsubscribe = session.on((event) => this.handleSessionEvent(live!, event));
      const history = await session.getEvents();
      this.assertLiveMatchesRequest(live, request);
      const durableHistory = history.filter((event) => event.ephemeral !== true);
      for (const event of durableHistory) {
        if (event.type !== "tool.execution_complete" || event.agentId !== undefined) {
          continue;
        }
        const toolCallId = event.data.toolCallId;
        if (typeof toolCallId !== "string" || toolCallId === "") {
          continue;
        }
        live.historicalToolResults.set(toolCallId, {
          result: event.data.result,
          error: event.data.error,
        });
      }
      const stateReplayEvents = durableHistory.filter(
        (event) => !live!.seenEventIds.has(event.id),
      );
      const replayEvents =
        continuity === undefined
          ? durableHistory
          : stateReplayEvents;
      for (const event of stateReplayEvents) {
        this.applyReplayedSessionState(live, event);
      }
      for (const event of history) {
        live.seenEventIds.add(event.id);
      }
      if (continuity === undefined || replayEvents.length > 0) {
        const compactEvents = compactHistoryEvents(replayEvents);
        const chunks = historyChunks(compactEvents);
        const replayId = randomUUID();
        const replayChunks = chunks.length > 0 ? chunks : [[]];
        let loadedEvents = 0;
        for (const [chunkIndex, events] of replayChunks.entries()) {
          loadedEvents += events.length;
          this.emit(
            "session.history",
            {
              events,
              incremental: continuity !== undefined,
              replayId,
              chunkIndex,
              chunkCount: replayChunks.length,
              loadedEvents,
              totalEvents: compactEvents.length,
              first: chunkIndex === 0,
              last: chunkIndex === replayChunks.length - 1,
            },
            { runId, memberId: target, target: "conversation", done: true },
          );
        }
      }
      if (continuity === undefined) {
        this.emit(
          "session.identity",
          { sessionId: actualSessionId },
          { runId, memberId: target, target: "activity", done: true },
        );
      }
      this.emit(
        "environment.progress",
        {
          component: "Copilot environment",
          message: "Starting runtime and discovering configuration",
        },
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
          items: await probe.load(session!),
        })),
      );
      this.assertLiveMatchesRequest(live, request);
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
              message:
                result.reason instanceof Error ? result.reason.message : String(result.reason),
            },
            { runId, memberId: target, target: "activity", done: true },
          );
        }
      }
      this.emit(
        "member.state",
        {
          state: live.foregroundBusy || live.busy ? "busy" : "idle",
          sessionId: actualSessionId,
        },
        { runId, memberId: target, target: "status" },
      );
      try {
        await this.modelStateForLive(live);
      } catch (error) {
        this.assertLiveMatchesRequest(live, request);
        this.emit(
          "environment.error",
          {
            component: "Model",
            message: error instanceof Error ? error.message : String(error),
          },
          { runId, memberId: target, target: "activity", done: true },
        );
      }
      this.assertLiveMatchesRequest(live, request);
      this.emit(
        "session.metrics",
        { modelId: live.modelId, aicUsed: live.aicUsed },
        { runId, memberId: target, target: "status", done: true },
      );
      this.refreshTasks(live);
      return live;
    } catch (error) {
      if (binding) {
        this.invalidateSessionBinding(binding, "the SDK session connection failed");
      }
      if (live && this.live.get(target) === live) {
        this.live.delete(target);
      }
      live?.unsubscribe();
      if (session) {
        try {
          await session.disconnect();
        } catch (disconnectError) {
          this.emit(
            "member.error",
            {
              message:
                `SDK session cleanup failed after connection failure: ${
                  disconnectError instanceof Error
                    ? disconnectError.message
                    : String(disconnectError)
                }`,
            },
            { runId, memberId: target, target: "activity", done: true },
          );
        }
        if (persistedSessionId === session.sessionId) {
          this.db.upsertSession(runId, session.sessionId, "disconnected");
        }
      }
      throw error;
    }
  }

  private async ensureAgentSession(
    agentId: string,
    transition?: AgentTransition,
  ): Promise<LiveSession> {
    const context = this.agents.get(agentId);
    if (!context) {
      throw new Error(`Agent "${agentId}" is not active.`);
    }
    this.assertTransitionAccess(context, transition);
    if (transition === undefined) {
      const existing = this.currentLive(context);
      if (existing) {
        return existing;
      }
    }
    const storedSessionId = this.db.session(context.runId)?.sessionId;
    const plan = await this.sessionConnectionPlan(context);
    return this.connectSession({
      runId: context.runId,
      target: context.target,
      agentId: context.agentId,
      alias: context.alias,
      sessionId: storedSessionId,
      config: plan.config,
      configSignature: plan.configSignature,
      availableMcpServers: plan.availableMcpServers,
      resumeExisting: storedSessionId !== undefined,
      ...(transition === undefined ? {} : { transition }),
    });
  }

  private applyReplayedSessionState(live: LiveSession, event: SessionEvent): void {
    switch (event.type) {
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
        break;
      case "assistant.usage":
        live.modelId = event.data.model || live.modelId;
        live.aicUsed += (event.data.copilotUsage?.totalNanoAiu ?? 0) / 1_000_000_000;
        break;
      case "assistant.turn_start":
        if (event.agentId === undefined) {
          live.busy = true;
          live.foregroundBusy = true;
          live.foregroundTurnId = event.data.turnId;
          live.foregroundTurnSequence += 1;
          live.foregroundCompleteTurnId = undefined;
          live.foregroundTurnHasToolRequests = false;
        }
        break;
      case "assistant.turn_end":
        if (event.agentId === undefined && event.data.turnId === live.foregroundTurnId) {
          const foregroundComplete = live.foregroundCompleteTurnId === event.data.turnId;
          live.foregroundTurnId = undefined;
          live.foregroundCompleteTurnId = undefined;
          live.foregroundTurnHasToolRequests = false;
          if (foregroundComplete) {
            live.foregroundBusy = false;
            live.foregroundAbortSequence = undefined;
          }
        }
        break;
      case "assistant.idle":
        if (event.agentId === undefined && event.data.aborted === true) {
          live.foregroundBusy = false;
          live.foregroundTurnId = undefined;
          live.foregroundCompleteTurnId = undefined;
          live.foregroundTurnHasToolRequests = false;
          live.foregroundAbortSequence = undefined;
        }
        break;
      case "session.idle":
        live.busy = false;
        live.foregroundBusy = false;
        live.foregroundTurnId = undefined;
        live.foregroundCompleteTurnId = undefined;
        live.foregroundTurnHasToolRequests = false;
        live.foregroundAbortSequence = undefined;
        live.idleCycle += 1;
        break;
      default:
        break;
    }
  }

  private handleSessionEvent(live: LiveSession, event: SessionEvent): void {
    if (!this.liveConnectionCurrent(live, true)) {
      return;
    }
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
        live.idleCycle += 1;
        this.emit("member.state", { state: "idle", ...event.data }, { ...fields, target: "status" });
        if (
          live.agentId === this.primaryAgentId &&
          !this.transitions.has(live.agentId)
        ) {
          queueMicrotask(() => void this.drainPendingSpawns(live.agentId));
        }
        this.scheduleMailboxDrain(live.target);
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
        {
          const context = this.agents.get(live.agentId);
          if (context && context.agentId !== this.primaryAgentId) {
            for (const server of event.data.servers) {
              if (this.childMcpServerAllowed(context, server.name)) {
                continue;
              }
              void live.session.rpc.mcp.disable({ serverName: server.name }).catch(
                (error: unknown) => {
                  if (!this.liveConnectionCurrent(live, true)) {
                    return;
                  }
                  this.emit(
                    "environment.error",
                    {
                      component: `MCP ${server.name}`,
                      message:
                        `Could not enforce the agent MCP ceiling: ${
                          error instanceof Error ? error.message : String(error)
                        }`,
                    },
                    { ...fields, target: "activity", done: true },
                  );
                },
              );
            }
          }
        }
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

  private createFreshPrimaryContext(): AgentContext {
    const runId = randomUUID();
    const claimed = this.db.claimPrimaryRun(
      runId,
      randomUUID(),
      this.workspace,
      process.pid,
      (stagedDefinition, alias, agentId) => {
        const stagedRecord =
          stagedDefinition === undefined
            ? undefined
            : storedAgentRecord(stagedDefinition);
        const definition =
          stagedRecord === undefined
            ? primaryAgentDefinition(alias)
            : { ...stagedRecord.definition, id: alias };
        const context: AgentContext = {
          agentId,
          target: agentTarget(agentId),
          alias,
          runId,
          definition,
          agent: this.resolveStoredDefinition(definition),
          canTalkTo: new Set(stagedRecord?.canTalkToAgentIds ?? []),
          canObserve: new Set(stagedRecord?.canObserveAgentIds ?? []),
          mcpServers: new Set(stagedRecord?.mcpServers ?? []),
        };
        return this.storedAgentJson(context);
      },
    );
    if (!claimed.run.definition) {
      throw new Error(
        `Claimed primary agent run "${claimed.run.id}" has no stored definition.`,
      );
    }
    const record = storedAgentRecord(claimed.run.definition);
    return {
      agentId: claimed.run.agentId,
      target: agentTarget(claimed.run.agentId),
      alias: claimed.run.alias,
      runId: claimed.run.id,
      definition: record.definition,
      agent: this.resolveStoredDefinition(record.definition),
      canTalkTo: new Set(record.canTalkToAgentIds),
      canObserve: new Set(record.canObserveAgentIds),
      mcpServers: new Set(record.mcpServers),
      ...(claimed.claim ? { primaryClaim: claimed.claim } : {}),
    };
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
      context = this.createFreshPrimaryContext();
    }

    this.primaryAgentId = context.agentId;
    try {
      this.registerAgent(context);
      return { context, recovered, sessionId };
    } catch (error) {
      this.unregisterAgent(context);
      this.primaryAgentId = undefined;
      if (recovered) {
        this.db.finishRun(context.runId, "interrupted", "Primary context recovery failed");
      } else {
        this.db.failAgentStartup(
          context.runId,
          this.workspace,
          context.agentId,
          "Fresh primary context failed before SDK startup",
        );
      }
      throw error;
    }
  }

  private async disconnectLiveSession(live: LiveSession, reason: string): Promise<void> {
    this.invalidateSessionBinding(live.binding, reason);
    live.unsubscribe();
    try {
      await live.session.disconnect();
    } catch (error) {
      this.emit(
        "member.error",
        {
          message:
            `${reason}: ${error instanceof Error ? error.message : String(error)}`,
        },
        { runId: live.runId, memberId: live.target, target: "activity", done: true },
      );
    }
    this.db.upsertSession(live.runId, live.session.sessionId, "disconnected");
  }

  private async discardLiveRun(
    target: string,
    runId: string,
    transition: AgentTransition,
  ): Promise<void> {
    const context = this.agents.get(transition.agentId);
    if (context) {
      this.assertTransitionAccess(context, transition);
    }
    const live = this.live.get(target);
    if (!live || live.runId !== runId) {
      return;
    }
    this.live.delete(target);
    await this.disconnectLiveSession(live, "SDK session disconnect failed during lifecycle change");
  }

  async openPrimary(): Promise<void> {
    if (this.primaryAgentId !== undefined) {
      const existing = this.agents.get(this.primaryAgentId);
      if (existing) {
        await this.ensureAgentSession(existing.agentId);
        return;
      }
    }

    const context = this.createFreshPrimaryContext();
    this.primaryAgentId = context.agentId;
    try {
      this.registerAgent(context);
    } catch (error) {
      this.primaryAgentId = undefined;
      this.db.failAgentStartup(
        context.runId,
        this.workspace,
        context.agentId,
        "Fresh primary context failed before SDK startup",
      );
      throw error;
    }
    const transition = this.beginAgentTransition(
      context,
      "starting a fresh SDK session",
    );
    let resumeMailbox = false;
    try {
      this.emitAgentLifecycle("agent.loading", context, { recovered: false });
      const live = await this.ensureAgentSession(context.agentId, transition);
      const adoptedMessages = this.db.completePrimaryStartup(
        context.runId,
        this.workspace,
        context.agentId,
        context.target,
        context.primaryClaim,
      );
      delete context.primaryClaim;
      this.emitAgentLifecycle("agent.ready", context, {
        recovered: false,
        sessionId: live.session.sessionId,
      });
      this.emit(
        "primary.ready",
        {
          ...this.agentPayload(context),
          mode: "primary",
          recovered: false,
          adoptedMessages,
          sessionId: live.session.sessionId,
          runId: context.runId,
        },
        { runId: context.runId, memberId: context.target, target: "status", done: true },
      );
      resumeMailbox = true;
    } catch (error) {
      await this.discardLiveRun(context.target, context.runId, transition);
      const message = error instanceof Error ? error.message : String(error);
      this.unregisterAgent(context);
      this.primaryAgentId = undefined;
      this.db.failAgentStartup(
        context.runId,
        this.workspace,
        context.agentId,
        "Primary Copilot agent failed to start",
      );
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
      throw error;
    } finally {
      this.endAgentTransition(transition, resumeMailbox);
    }
  }

  async historicalToolResult(
    target: string,
    toolCallId: string,
  ): Promise<Record<string, unknown>> {
    const context = this.requireAgent(target);
    const live = this.currentLive(context);
    if (!live) {
      throw new Error(`Agent "${context.alias}" has no active SDK session.`);
    }
    const details = live.historicalToolResults.get(toolCallId);
    if (!details) {
      return { found: false };
    }
    return {
      found: true,
      result: details.result,
      error: details.error,
    };
  }

  async resumePrimarySession(sessionId: string): Promise<void> {
    const client = await this.ensureClient();
    const active = this.liveSessionById(sessionId);
    if (active) {
      throw new Error(`Session "${sessionId}" is already active as "${active.target}".`);
    }

    const available = await client.listSessions({ workingDirectory: this.workspace });
    if (!available.some((session) => session.sessionId === sessionId)) {
      throw new Error(`Session "${sessionId}" was not found for this workspace.`);
    }
    const currentPrimary =
      this.primaryAgentId === undefined
        ? undefined
        : this.agents.get(this.primaryAgentId);
    const resumablePrimary =
      currentPrimary === undefined
        ? this.db.resumablePrimaryRun(this.workspace)
        : undefined;
    const intendedPrimaryAgentId = currentPrimary?.agentId ?? resumablePrimary?.agentId;
    const owner = this.db.sessionOwner(sessionId);
    if (
      owner &&
      (
        intendedPrimaryAgentId === undefined ||
        owner.agentId !== intendedPrimaryAgentId ||
        owner.workspace !== this.workspace
      )
    ) {
      throw new Error(
        `Session "${sessionId}" belongs to durable agent "${owner.agentId}" in workspace ` +
          `"${owner.workspace}" and cannot be selected for this primary agent.`,
      );
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
    let claimedTransition: AgentTransition | undefined;
    if (!context) {
      claimed = this.claimPrimaryContext(false);
      if (claimed) {
        context = claimed.context;
        claimedTransition = this.beginAgentTransition(
          context,
          `replacing its SDK session with "${sessionId}"`,
        );
      } else {
        await this.openPrimary();
        context = this.requirePrimary();
      }
    }
    const claimedContext = claimed !== undefined;
    const primaryContext = context!;
    const preclaimedTransition = claimedTransition;
    await this.withAgentLock(primaryContext.agentId, async () => {
      if (preclaimedTransition) {
        this.assertTransitionAccess(primaryContext, preclaimedTransition);
      } else {
        this.assertTransitionAccess(primaryContext);
      }
      const oldLive = preclaimedTransition ? undefined : this.currentLive(primaryContext);
      const oldRunId = primaryContext.runId;
      const oldSessionId =
        preclaimedTransition
          ? claimed?.sessionId
          : oldLive?.session.sessionId ?? this.db.session(oldRunId)?.sessionId;
      const runId = randomUUID();
      const transition =
        preclaimedTransition ??
        this.beginAgentTransition(
          primaryContext,
          `replacing its SDK session with "${sessionId}"`,
        );
      let resumeMailbox = false;
      let newRunCreated = false;
      let replacementActivated = false;
      try {
        if (claimedContext) {
          this.emitAgentLifecycle("agent.loading", primaryContext, { recovered: true });
        }
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
        const pendingConnection = this.connecting.get(primaryContext.target);
        if (pendingConnection) {
          await pendingConnection.promise.then(
            () => undefined,
            () => undefined,
          );
        }
        if (oldLive) {
          this.live.delete(primaryContext.target);
          await this.disconnectLiveSession(
            oldLive,
            "Previous primary SDK session disconnect failed during replacement",
          );
        }
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
        const plan = await this.sessionConnectionPlan(primaryContext);
        const live = await this.connectSession({
          runId,
          target: primaryContext.target,
          agentId: primaryContext.agentId,
          alias: primaryContext.alias,
          sessionId,
          config: plan.config,
          configSignature: plan.configSignature,
          availableMcpServers: plan.availableMcpServers,
          resumeExisting: true,
          transition,
        });
        const adoptedMessages = this.db.completePrimaryReplacementStartup(
          runId,
          oldRunId,
          this.workspace,
          primaryContext.agentId,
          primaryContext.target,
          `Resuming session ${sessionId}`,
        );
        replacementActivated = true;
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
            sessionId: live.session.sessionId,
            adoptedMessages,
            runId,
          },
          { runId, memberId: primaryContext.target, target: "status", done: true },
        );
        resumeMailbox = true;
      } catch (error) {
        await this.discardLiveRun(primaryContext.target, runId, transition);
        const replacementMessage = error instanceof Error ? error.message : String(error);
        const failureReason =
          `Primary session replacement with "${sessionId}" failed: ${replacementMessage}`;
        primaryContext.runId = oldRunId;
        let durableRollbackCompleted = false;
        try {
          let restoredMessages = 0;
          if (newRunCreated) {
            if (replacementActivated) {
              restoredMessages = this.db.rollbackPrimaryReplacement(
                runId,
                oldRunId,
                this.workspace,
                primaryContext.agentId,
                primaryContext.target,
                process.pid,
                failureReason,
              );
            } else {
              this.db.disqualifyPrimaryRun(
                runId,
                this.workspace,
                primaryContext.agentId,
                failureReason,
              );
            }
            durableRollbackCompleted = true;
          }
          if (oldSessionId === undefined) {
            throw new Error(
              `Previous primary agent run "${oldRunId}" has no managed SDK session and cannot ` +
                "be restored safely.",
            );
          }
          const restorePlan = await this.sessionConnectionPlan(primaryContext);
          const restored = await this.connectSession({
            runId: oldRunId,
            target: primaryContext.target,
            agentId: primaryContext.agentId,
            alias: primaryContext.alias,
            sessionId: oldSessionId,
            config: restorePlan.config,
            configSignature: restorePlan.configSignature,
            availableMcpServers: restorePlan.availableMcpServers,
            resumeExisting: true,
            transition,
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
          resumeMailbox = true;
        } catch (recoveryError) {
          await this.discardLiveRun(primaryContext.target, oldRunId, transition);
          let disqualificationError: unknown;
          if (newRunCreated && !durableRollbackCompleted) {
            try {
              if (replacementActivated) {
                this.db.finishRun(
                  runId,
                  "interrupted",
                  `${failureReason}; rollback to the previous primary run failed`,
                );
              } else {
                this.db.disqualifyPrimaryRun(
                  runId,
                  this.workspace,
                  primaryContext.agentId,
                  failureReason,
                );
              }
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
                newRunCreated &&
                (
                  durableRollbackCompleted ||
                  (!replacementActivated && disqualificationError === undefined)
                ),
            },
            { runId: oldRunId, memberId: primaryContext.target, target: "activity", done: true },
          );
          throw new Error(combinedMessage, { cause: error });
        }
        throw error;
      } finally {
        this.endAgentTransition(transition, resumeMailbox);
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

  private async withAgentLocks<T>(
    agentIds: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    // Management operations take the primary UUID and every target UUID in one
    // stable order so independently targeted updates cannot deadlock.
    const ordered = [...new Set(agentIds)].sort();
    const acquire = (index: number): Promise<T> => {
      const agentId = ordered[index];
      return agentId === undefined
        ? operation()
        : this.withAgentLock(agentId, () => acquire(index + 1));
    };
    return acquire(0);
  }

  private async drainPendingSpawns(callerAgentId: string): Promise<void> {
    while (this.pendingSpawns.length > 0) {
      const pending = this.pendingSpawns[0]!;
      if (pending.callerAgentId !== callerAgentId) {
        return;
      }
      const caller = this.agents.get(callerAgentId);
      const live = caller && this.currentLive(caller);
      if (!caller || !live || live.busy) {
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
   * Atomically reserves every agent named by an ephemeral spawn request, then starts
   * their independent SDK sessions. Once reservation and caller ACL persistence
   * succeed, one session-start failure never prevents the others from starting.
   */
  async spawnAgents(request: SpawnAgentsRequest): Promise<Array<Record<string, unknown>>> {
    await this.openPrimary();
    return this.spawnAgentsForCaller(this.requirePrimary(), request);
  }

  private async spawnAgentsForCaller(
    caller: AgentContext,
    request: SpawnAgentsRequest,
  ): Promise<Array<Record<string, unknown>>> {
    return this.withAgentLocks(
      [caller.agentId],
      () => this.spawnAgentsForCallerUnlocked(caller, request),
    );
  }

  private async spawnAgentsForCallerUnlocked(
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
      contexts.push(context);
    }
    const nextCallerTalk = new Set(caller.canTalkTo);
    const nextCallerObserve = new Set(caller.canObserve);
    for (const alias of request.callerCanTalkTo) {
      nextCallerTalk.add(batchAliases.get(alias)!);
    }
    for (const alias of request.callerCanObserve) {
      nextCallerObserve.add(batchAliases.get(alias)!);
    }
    this.db.createAgentRunsWithCallerUpdate(
      contexts.map((context) => ({
        id: context.runId,
        agentId: context.agentId,
        alias: context.alias,
        definition: this.storedAgentJson(context),
        workspace: this.workspace,
        ownerPid: process.pid,
      })),
      {
        id: caller.runId,
        alias: caller.alias,
        definition: this.storedAgentJsonFor(
          caller,
          caller.definition,
          nextCallerTalk,
          nextCallerObserve,
        ),
      },
    );
    caller.canTalkTo = nextCallerTalk;
    caller.canObserve = nextCallerObserve;

    const startupTransitions = new Map<string, AgentTransition>();
    for (const context of contexts) {
      this.registerAgent(context);
      startupTransitions.set(
        context.agentId,
        this.beginAgentTransition(context, "starting its SDK session and initial task"),
      );
    }
    const results: Array<Record<string, unknown>> = [];
    for (const context of contexts) {
      const transition = startupTransitions.get(context.agentId)!;
      try {
        this.emitAgentLifecycle("agent.loading", context, { recovered: false });
        const live = await this.ensureAgentSession(context.agentId, transition);
        await this.sendUserPromptOnLive(live, context.agent.task, false, true);
        this.emitAgentLifecycle("agent.ready", context, {
          recovered: false,
          sessionId: live.session.sessionId,
        });
        this.endAgentTransition(transition, true);
        results.push({
          ...this.agentPayload(context),
          runId: context.runId,
          sessionId: live.session.sessionId,
          started: true,
        });
      } catch (error) {
        const message = await this.failStartingAgent(
          context,
          transition,
          error instanceof Error ? error.message : String(error),
        );
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

  private async failStartingAgent(
    context: AgentContext,
    transition: AgentTransition,
    message: string,
  ): Promise<string> {
    let finalMessage = message;
    try {
      await this.discardLiveRun(context.target, context.runId, transition);
      const permanentlyDisqualified = this.db.failAgentStartup(
        context.runId,
        this.workspace,
        context.agentId,
        message,
      );
      if (permanentlyDisqualified) {
        this.synchronizeDisqualifiedAgent(context.agentId, context.alias);
      }
    } catch (cleanupError) {
      finalMessage =
        `${message}. Atomic failed-startup and ACL cleanup also failed: ${
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }`;
    } finally {
      this.unregisterAgent(context);
      this.endAgentTransition(transition, false);
    }
    const primaryTarget =
      this.primaryAgentId === undefined
        ? context.target
        : this.agents.get(this.primaryAgentId)?.target ?? context.target;
    this.emit(
      "agent.error",
      { ...this.agentPayload(context), runId: context.runId, message: finalMessage },
      { runId: context.runId, memberId: primaryTarget, target: "activity", done: true },
    );
    this.emit(
      "agent.stopped",
      {
        ...this.agentPayload(context),
        runId: context.runId,
        reason: finalMessage,
        failed: true,
      },
      { runId: context.runId, memberId: context.target, target: "status", done: true },
    );
    return finalMessage;
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
    if (stored.startupState !== "ready") {
      throw new Error(`Agent run "${runId}" never completed its initial task and cannot resume.`);
    }
    if (this.agents.has(stored.agentId)) {
      throw new Error(`Agent "${stored.alias}" is already active.`);
    }
    const liveOwner = this.liveSessionById(stored.session.sessionId);
    if (liveOwner) {
      throw new Error(
        `SDK session "${stored.session.sessionId}" is already live as agent ` +
          `"${liveOwner.alias}".`,
      );
    }
    this.assertDurableSessionOwnership(stored.session.sessionId, stored.agentId);
    const client = await this.ensureClient();
    const { inUse } = await client.rpc.sessions.checkInUse({
      sessionIds: [stored.session.sessionId],
    });
    if (inUse.includes(stored.session.sessionId)) {
      throw new Error(
        `SDK session "${stored.session.sessionId}" is active in another process.`,
      );
    }
    const record = storedAgentRecord(stored.definition);
    const definition = record.definition;
    const resolved = this.resolveStoredDefinition(definition);
    this.assertPermissionCeiling([definition]);
    this.assertAliasesAvailable([definition.id], stored.agentId);
    await this.openPrimary();
    // Recovery retains the original captured ceiling. The connection plan separately
    // disables every currently visible primary server outside it, so newly added
    // servers can never become available to a recovered agent.
    const mcpServers = new Set(record.mcpServers);
    this.assertMcpCeiling([definition], mcpServers);
    const available = await this.availableMcpServers();
    for (const server of definition.mcpServers ?? []) {
      if (!available.has(server)) {
        throw new Error(
          `Agent "${definition.id}" requested MCP server "${server}", which is no longer available.`,
        );
      }
    }
    this.assertAliasesAvailable([definition.id], stored.agentId);

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
    const transition = this.beginAgentTransition(context, "recovering its SDK session");
    let resumeMailbox = false;
    try {
      this.db.updateAgentRun(runId, context.alias, this.storedAgentJson(context));
      this.emitAgentLifecycle("agent.loading", context, {
        recovered: true,
        sessionId: stored.session.sessionId,
      });
      const live = await this.ensureAgentSession(context.agentId, transition);
      this.emitAgentLifecycle("agent.ready", context, {
        recovered: true,
        sessionId: live.session.sessionId,
      });
      resumeMailbox = true;
    } catch (error) {
      await this.failAgent(context, "Agent recovery failed", transition);
      throw error;
    } finally {
      this.endAgentTransition(transition, resumeMailbox);
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
    const transition = this.beginAgentTransition(context, "stopping");
    try {
      await this.discardLiveRun(context.target, context.runId, transition);
      this.unregisterAgent(context);
      this.db.finishRun(context.runId, "stopped", reason);
      this.emit(
        "agent.stopped",
        { ...this.agentPayload(context), runId: context.runId, reason },
        { runId: context.runId, memberId: context.target, target: "status", done: true },
      );
    } finally {
      this.endAgentTransition(transition, false);
    }
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
    return this.withAgentLocks(
      [caller.agentId, context.agentId],
      () => this.updateAgentUnlocked(caller, context, update),
    );
  }

  private async updateAgentUnlocked(
    caller: AgentContext,
    context: AgentContext,
    update: AgentUpdate,
  ): Promise<Record<string, unknown>> {
    this.requireCallingPrimary(caller.agentId);
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
    const callerHadTalk = caller.canTalkTo.has(context.agentId);
    const callerHadObserve = caller.canObserve.has(context.agentId);
    const nextCallerCanTalkTo = new Set(caller.canTalkTo);
    const nextCallerCanObserve = new Set(caller.canObserve);
    if (update.callerCanTalk === true) {
      nextCallerCanTalkTo.add(context.agentId);
    } else if (update.callerCanTalk === false) {
      nextCallerCanTalkTo.delete(context.agentId);
    }
    if (update.callerCanObserve === true) {
      nextCallerCanObserve.add(context.agentId);
    } else if (update.callerCanObserve === false) {
      nextCallerCanObserve.delete(context.agentId);
    }
    const normalizedDefinition: DynamicAgentDefinition = {
      ...definition,
      canTalkTo: this.grantDetails(nextCanTalkTo),
      canObserve: this.grantDetails(nextCanObserve),
    };
    const transition = this.beginAgentTransition(context, "updating its definition");
    let resumeMailbox = false;
    try {
      const previousDefinition = context.definition;
      const previousAgent = context.agent;
      const previousAlias = context.alias;
      const previousCanTalkTo = context.canTalkTo;
      const previousCanObserve = context.canObserve;
      try {
        this.db.updateAgentRuns([
          {
            id: context.runId,
            alias: definition.id,
            definition: this.storedAgentJsonFor(
              context,
              normalizedDefinition,
              nextCanTalkTo,
              nextCanObserve,
            ),
          },
          {
            id: caller.runId,
            alias: caller.alias,
            definition: this.storedAgentJsonFor(
              caller,
              caller.definition,
              nextCallerCanTalkTo,
              nextCallerCanObserve,
            ),
          },
        ]);
      } catch (error) {
        try {
          await this.reconnectAgent(context, transition);
          resumeMailbox = true;
        } catch (restoreError) {
          const restoreMessage =
            restoreError instanceof Error ? restoreError.message : String(restoreError);
          await this.failAgent(
            context,
            `Agent update could not restore its original live session: ${restoreMessage}`,
            transition,
          );
          throw new Error(
            `Agent "${previousAlias}" update was not persisted and its original session could ` +
              `not be restored: ${restoreMessage}`,
            { cause: error },
          );
        }
        throw error;
      }

      if (this.aliasIndex.get(previousAlias) === context.agentId) {
        this.aliasIndex.delete(previousAlias);
      }
      context.alias = definition.id;
      this.aliasIndex.set(context.alias, context.agentId);
      context.definition = normalizedDefinition;
      context.agent = validated.agent;
      context.canTalkTo = nextCanTalkTo;
      context.canObserve = nextCanObserve;
      caller.canTalkTo = nextCallerCanTalkTo;
      caller.canObserve = nextCallerCanObserve;
      const live = this.live.get(context.target);
      if (live) {
        live.alias = context.alias;
      }
      const restorePreviousState = async (cause: unknown): Promise<never> => {
        const rollbackCallerCanTalkTo = new Set(caller.canTalkTo);
        const rollbackCallerCanObserve = new Set(caller.canObserve);
        if (update.callerCanTalk !== undefined) {
          if (callerHadTalk) {
            rollbackCallerCanTalkTo.add(context.agentId);
          } else {
            rollbackCallerCanTalkTo.delete(context.agentId);
          }
        }
        if (update.callerCanObserve !== undefined) {
          if (callerHadObserve) {
            rollbackCallerCanObserve.add(context.agentId);
          } else {
            rollbackCallerCanObserve.delete(context.agentId);
          }
        }
        try {
          this.db.updateAgentRuns([
            {
              id: context.runId,
              alias: previousAlias,
              definition: this.storedAgentJsonFor(
                context,
                previousDefinition,
                previousCanTalkTo,
                previousCanObserve,
              ),
            },
            {
              id: caller.runId,
              alias: caller.alias,
              definition: this.storedAgentJsonFor(
                caller,
                caller.definition,
                rollbackCallerCanTalkTo,
                rollbackCallerCanObserve,
              ),
            },
          ]);
          this.aliasIndex.delete(context.alias);
          context.alias = previousAlias;
          this.aliasIndex.set(previousAlias, context.agentId);
          context.definition = previousDefinition;
          context.agent = previousAgent;
          context.canTalkTo = previousCanTalkTo;
          context.canObserve = previousCanObserve;
          caller.canTalkTo = rollbackCallerCanTalkTo;
          caller.canObserve = rollbackCallerCanObserve;
          if (live) live.alias = previousAlias;
          const currentLive = this.live.get(context.target);
          if (currentLive) currentLive.alias = previousAlias;
          await this.reconnectAgent(context, transition);
          resumeMailbox = true;
        } catch (restoreError) {
          const restoreMessage =
            restoreError instanceof Error ? restoreError.message : String(restoreError);
          await this.failAgent(
            context,
            `Agent update rollback could not restore its durable/live state: ${restoreMessage}`,
            transition,
          );
          throw new Error(
            `Agent "${previousAlias}" update failed and its previous state could not be ` +
              `restored: ${restoreMessage}`,
            { cause },
          );
        }
        throw cause;
      };

      let reconnected = false;
      try {
        reconnected = await this.reconnectIfConfigChanged(context, transition);
      } catch (error) {
        // The reconnect failed, so restore the previous definition durably and in
        // memory rather than leaving a committed update the live session never
        // received, then surface the failure.
        return restorePreviousState(error);
      }
      this.emitAgentLifecycle("agent.updated", context, { reconnected });
      resumeMailbox = true;
      return {
        action: "updated",
        ...this.agentPayload(context),
        runId: context.runId,
        reconnected,
      };
    } finally {
      this.endAgentTransition(transition, resumeMailbox);
    }
  }

  /**
   * Reconnects an agent whenever anything its SessionConfig is derived from changed:
   * prompt, task, model, reasoning, permissions, MCP subset, or ACL. The session id
   * and conversation history are preserved.
   */
  private async reconnectIfConfigChanged(
    context: AgentContext,
    transition: AgentTransition,
  ): Promise<boolean> {
    const live = this.live.get(context.target);
    if (!live) {
      return false;
    }
    const plan = await this.sessionConnectionPlan(context);
    if (
      plan.configSignature === live.configSignature &&
      this.liveConnectionCurrent(live, true)
    ) {
      return false;
    }
    await this.reconnectAgent(context, transition, plan);
    return true;
  }

  // Reconnects one agent in place, preserving its SDK session id and history while
  // rebuilding its complete session config from the current definition. Several
  // callers can be waiting on the same in-flight connection, so each pass re-enters
  // the shared guard (which joins rather than duplicates) and then verifies the
  // resulting session really was built from the current config; a session joined
  // from an older connect is replaced on the next pass.
  private async reconnectAgent(
    context: AgentContext,
    transition: AgentTransition,
    initialPlan?: {
      availableMcpServers: Set<string>;
      config: SessionConfig;
      configSignature: string;
    },
  ): Promise<void> {
    const target = context.target;
    let continuity: SessionContinuity | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const pending = this.connecting.get(target);
      if (pending) {
        // Wait for the connection already in progress before replacing it; its own
        // caller reports any failure, so only its completion matters here.
        await pending.promise.then(
          () => undefined,
          () => undefined,
        );
      }
      const plan =
        attempt === 0 && initialPlan !== undefined
          ? initialPlan
          : await this.sessionConnectionPlan(context);
      const live = this.live.get(target);
      if (
        live &&
        live.configSignature === plan.configSignature &&
        this.liveConnectionCurrent(live, true)
      ) {
        return;
      }
      const sessionId = live?.session.sessionId ?? this.db.session(context.runId)?.sessionId;
      if (live) {
        continuity = this.captureContinuity(live);
        this.live.delete(target);
        await this.disconnectLiveSession(
          live,
          "SDK session disconnect failed while reconnecting updated agent",
        );
      }
      const connected = await this.connectSession({
        runId: context.runId,
        target,
        agentId: context.agentId,
        alias: context.alias,
        sessionId,
        config: plan.config,
        configSignature: plan.configSignature,
        availableMcpServers: plan.availableMcpServers,
        resumeExisting: true,
        ...(continuity === undefined ? {} : { continuity }),
        transition,
      });
      const verifiedPlan = await this.sessionConnectionPlan(context);
      if (connected.configSignature === verifiedPlan.configSignature) {
        return;
      }
      continuity = this.captureContinuity(connected);
    }
    throw new Error(
      `Agent "${context.alias}" could not be reconnected with its current configuration.`,
    );
  }

  // Tears down a previously recoverable agent whose recovery failed. Fresh-start
  // failures use failStartingAgent so the alias and failed UUID ACLs are released.
  private async failAgent(
    context: AgentContext,
    message: string,
    transition: AgentTransition,
  ): Promise<void> {
    await this.discardLiveRun(context.target, context.runId, transition);
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
    return this.sendUserPromptOnLive(live, content, true);
  }

  private async sendUserPromptOnLive(
    live: LiveSession,
    content: string,
    retryOnFailure: boolean,
    initialTask = false,
  ): Promise<string> {
    if (!this.liveConnectionCurrent(live, true)) {
      throw new Error("The SDK session selected for this prompt is no longer current.");
    }
    const runId = live.runId;
    const id = randomUUID();
    this.db.enqueueMessage(id, runId, "user", live.target, "user", content);
    const claim = this.db.claimMessage(id, runId, live.target);
    if (!claim) {
      throw new Error(`Prompt message "${id}" could not be claimed for delivery.`);
    }
    let sdkMessageId: string;
    try {
      sdkMessageId = await live.session.send({ prompt: content, mode: "immediate" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const released = this.db.failMessage(
        claim.id,
        claim.runId,
        claim.target,
        claim.leaseToken,
        message,
        retryOnFailure,
      );
      if (retryOnFailure && released) {
        this.scheduleMailboxRetry(live.target, 1);
      }
      throw error;
    }
    if (!this.liveConnectionCurrent(live, true)) {
      const released = this.db.releaseMessage(
        claim.id,
        claim.runId,
        claim.target,
        claim.leaseToken,
        "The prompt was accepted by a superseded SDK session.",
      );
      if (released) {
        this.scheduleMailboxDrain(live.target);
      }
      throw new Error(
        `Prompt message "${id}" was accepted by an SDK session that is no longer current.`,
      );
    }
    const completed = initialTask
      ? this.db.completeInitialTask(
          claim.id,
          claim.runId,
          claim.target,
          claim.leaseToken,
        )
      : this.db.completeMessage(
          claim.id,
          claim.runId,
          claim.target,
          claim.leaseToken,
        );
    if (!completed) {
      throw new Error(`Prompt message "${id}" lost its delivery lease before completion.`);
    }
    this.emit(
      "prompt.accepted",
      { id, sdkMessageId, source: "user", target: live.target, content },
      { runId, memberId: live.target, target: "conversation" },
    );
    return sdkMessageId;
  }

  private cancelMailboxRetry(target: string): void {
    const timer = this.mailboxRetryTimers.get(target);
    if (timer) {
      clearTimeout(timer);
      this.mailboxRetryTimers.delete(target);
    }
    this.mailboxRetryAttempts.delete(target);
  }

  private reportMailboxFailure(target: string, error: unknown): void {
    this.emit(
      "mailbox.failed",
      { message: error instanceof Error ? error.message : String(error) },
      { memberId: target, target: "messages", done: true },
    );
  }

  private scheduleMailboxDrain(target: string): void {
    if (this.shuttingDown) {
      return;
    }
    if (this.drainingMailboxes.has(target)) {
      this.mailboxDrainRequested.add(target);
      return;
    }
    queueMicrotask(() => {
      if (this.shuttingDown) {
        return;
      }
      void this.drainMailbox(target, false).catch((error: unknown) => {
        this.reportMailboxFailure(target, error);
      });
    });
  }

  private scheduleMailboxRetry(target: string, attempts: number): number {
    if (this.shuttingDown) {
      return attempts;
    }
    if (this.mailboxRetryTimers.has(target)) {
      return this.mailboxRetryAttempts.get(target) ?? attempts;
    }
    const retryAttempts = Math.max(
      attempts,
      (this.mailboxRetryAttempts.get(target) ?? 0) + 1,
    );
    this.mailboxRetryAttempts.set(target, retryAttempts);
    const exponent = Math.min(Math.max(retryAttempts - 1, 0), 5);
    const delay = Math.min(
      MAILBOX_RETRY_MAX_MS,
      MAILBOX_RETRY_BASE_MS * (2 ** exponent),
    );
    const timer = setTimeout(() => {
      if (this.mailboxRetryTimers.get(target) !== timer) {
        return;
      }
      this.mailboxRetryTimers.delete(target);
      void this.drainMailbox(target, true).catch((error: unknown) => {
        this.reportMailboxFailure(target, error);
        this.scheduleMailboxRetry(target, retryAttempts + 1);
      });
    }, delay);
    timer.unref?.();
    this.mailboxRetryTimers.set(target, timer);
    return retryAttempts;
  }

  /** Claims and transmits at most one message for one recipient idle cycle. */
  private async drainMailbox(target: string, retryWake: boolean): Promise<void> {
    if (this.drainingMailboxes.has(target)) {
      this.mailboxDrainRequested.add(target);
      return;
    }
    this.drainingMailboxes.add(target);
    try {
      if (!target.startsWith(AGENT_TARGET_PREFIX)) {
        return;
      }
      const agentId = target.slice(AGENT_TARGET_PREFIX.length);
      const context = this.agents.get(agentId);
      if (!context) {
        return;
      }
      if (this.transitions.has(agentId)) {
        if (retryWake) {
          this.scheduleMailboxRetry(target, 1);
        }
        return;
      }
      let live = this.currentLive(context);
      if (!live) {
        try {
          live = await this.ensureAgentSession(agentId);
        } catch (error) {
          if (this.transitions.has(agentId)) {
            if (retryWake) {
              this.scheduleMailboxRetry(target, 1);
            }
            return;
          }
          this.emit(
            "mailbox.failed",
            {
              message: `The recipient session could not be started: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
            { memberId: target, target: "messages", done: true },
          );
          this.scheduleMailboxRetry(target, 1);
          return;
        }
      }
      if (live.busy) {
        return;
      }
      if (!retryWake && live.mailboxDrainCycle >= live.idleCycle) {
        return;
      }
      if (!this.liveConnectionCurrent(live, false)) {
        return;
      }
      const [message] = this.db.claimMessages(live.runId, target, 1);
      if (!message) {
        if (retryWake) {
          this.cancelMailboxRetry(target);
        }
        return;
      }
      if (!retryWake) {
        live.mailboxDrainCycle = live.idleCycle;
      }
      const prompt =
        message.kind === "user"
          ? message.content
          : `<agent_message id="${message.id}" source="${message.source}">\n` +
            `${message.content}\n` +
            "</agent_message>\n\n" +
            "Process this durable message from another Copilot agent. Respond or act as " +
            "appropriate, and use the relevant send tool if the sender needs a direct answer.";
      try {
        const sdkMessageId = await live.session.send({ prompt, mode: "immediate" });
        if (!this.liveConnectionCurrent(live, false)) {
          this.db.releaseMessage(
            message.id,
            message.runId,
            message.target,
            message.leaseToken,
            "Delivery returned from a superseded SDK session.",
          );
          return;
        }
        if (
          !this.db.completeMessage(
            message.id,
            message.runId,
            message.target,
            message.leaseToken,
          )
        ) {
          return;
        }
        this.cancelMailboxRetry(target);
        if (message.kind === "user") {
          this.emit(
            "prompt.accepted",
            {
              id: message.id,
              sdkMessageId,
              source: "user",
              target: live.target,
              content: message.content,
              recovered: true,
            },
            { runId: live.runId, memberId: live.target, target: "conversation" },
          );
          return;
        }
        const source = this.resolveAgentRef(message.source);
        this.emit(
          "mailbox.delivered",
          {
            id: message.id,
            runId: message.runId,
            target: message.target,
            kind: message.kind,
            content: message.content,
            sequence: message.sequence,
            createdAt: message.createdAt,
            updatedAt: message.updatedAt,
            deliveryAttempts: message.deliveryAttempts,
            source: source?.alias ?? message.source,
            ...(source ? { sourceAgentId: source.agentId } : {}),
            status: "delivered",
          },
          { runId: live.runId, memberId: live.target, target: "messages" },
        );
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error);
        if (!this.liveConnectionCurrent(live, false)) {
          this.db.releaseMessage(
            message.id,
            message.runId,
            message.target,
            message.leaseToken,
            failure,
          );
          return;
        }
        const released = this.db.failMessage(
          message.id,
          message.runId,
          message.target,
          message.leaseToken,
          failure,
          true,
        );
        if (!released) {
          return;
        }
        const retryAttempt = this.scheduleMailboxRetry(
          target,
          message.deliveryAttempts,
        );
        this.emit(
          "mailbox.failed",
          {
            id: message.id,
            message: failure,
            retrying: true,
            attempts: retryAttempt,
          },
          { runId: live.runId, memberId: live.target, target: "messages", done: true },
        );
      }
    } finally {
      this.drainingMailboxes.delete(target);
      if (this.mailboxDrainRequested.delete(target) && !this.shuttingDown) {
        this.scheduleMailboxDrain(target);
      }
    }
  }

  async abort(target: string): Promise<void> {
    const route = routeTarget(target);
    const context = this.agents.get(route.agentId);
    if (!context) {
      throw new Error(`Target "${target}" has no active agent.`);
    }
    this.assertTransitionAccess(context);
    const live = this.currentLive(context);
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
    const primaryLive = primary === undefined ? undefined : this.currentLive(primary);
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
        const live = this.currentLive(context);
        return {
          ...this.agentPayload(context),
          runId: context.runId,
          ...(live ? { sessionId: live.session.sessionId } : {}),
          state: this.agentState(context),
        };
      }),
      sessions: [...this.agents.values()].flatMap((context) => {
        const live = this.currentLive(context);
        return live
          ? [{
              target: live.target,
              agentId: live.agentId,
              alias: live.alias,
              sessionId: live.session.sessionId,
              state: live.foregroundBusy ? "busy" : "idle",
            }]
          : [];
      }),
    };
  }

  async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    clearInterval(this.recoveryTimer);
    for (const timer of this.mailboxRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.mailboxRetryTimers.clear();
    this.mailboxRetryAttempts.clear();
    for (const binding of [...this.sessionBindings.values()]) {
      this.invalidateSessionBinding(binding, reason);
    }
    this.sessionBindings.clear();
    for (const pending of this.pendingPermissions.values()) {
      pending.respond(reject(`Permission request cancelled: ${reason}`));
    }
    this.pendingPermissions.clear();
    const runIds = new Set<string>();
    // Every agent owns its own run, so each is interrupted independently.
    for (const context of this.agents.values()) {
      runIds.add(context.runId);
      this.agentGenerations.set(
        context.agentId,
        (this.agentGenerations.get(context.agentId) ?? 0) + 1,
      );
    }
    const pendingConnections = [...this.connecting.values()].map((attempt) => attempt.promise);
    for (const live of this.live.values()) {
      live.unsubscribe();
    }
    this.live.clear();
    this.agents.clear();
    this.aliasIndex.clear();
    this.disqualifiedAgentIds.clear();
    this.transitions.clear();
    this.drainingMailboxes.clear();
    this.mailboxDrainRequested.clear();
    this.pendingSpawns.length = 0;
    this.primaryAgentId = undefined;
    for (const runId of runIds) {
      this.db.finishRun(runId, "interrupted", reason);
    }
    await Promise.allSettled(pendingConnections);
    this.connecting.clear();
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
