export const PROTOCOL_VERSION = 1 as const;

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ReasoningSummary = "none" | "concise" | "detailed";

export interface ToolPolicy {
  allow: string[];
  deny: string[];
}

export interface PathPolicy {
  read: string[];
  write: string[];
}

/** A child-agent ceiling that narrows, but never grants beyond, the main policy. */
export interface PermissionProfile {
  tools: ToolPolicy;
  paths: PathPolicy;
  commands: boolean;
  network: boolean;
  gitWrite: boolean;
  externalActions: boolean;
}

export type DynamicPermission =
  | { mode: "inherit" | "prompt" | "approveAll" }
  | PermissionProfile;

/**
 * The complete runtime definition of one standalone durable agent. `id` is the
 * tool-safe alias used in messaging and every user-facing reference; the runtime
 * assigns the durable agent UUID separately.
 */
export interface DynamicAgentDefinition {
  id: string;
  displayName: string;
  description: string;
  /** Complete initial objective delivered to this agent immediately after startup. */
  task: string;
  prompt: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  reasoningSummary?: ReasoningSummary;
  permissions?: DynamicPermission;
  /** Optional subset of the primary MCP ceiling captured when this agent is created. */
  mcpServers?: string[];
  /**
   * Directional outgoing recipient selectors. `caller` resolves to the spawning
   * or updating caller; peer aliases and `agent:<uuid>` targets resolve to UUIDs.
   */
  canTalkTo: string[];
  /** Caller/agent selectors whose SDK activity this agent may inspect passively. */
  canObserve: string[];
  ui?: {
    icon?: string;
    color?: string;
  };
}

/**
 * An ephemeral batch request to spawn standalone agents. It is never persisted as
 * a group: every agent it names becomes its own durable run, session, and mailbox.
 */
export interface SpawnAgentsRequest {
  agents: DynamicAgentDefinition[];
  /** New-agent aliases the calling agent should be allowed to message. */
  callerCanTalkTo: string[];
  /** New-agent aliases the calling agent should be allowed to observe. */
  callerCanObserve: string[];
}

export interface ResolvedAgent {
  alias: string;
  displayName: string;
  description: string;
  task: string;
  initialPrompt: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  reasoningSummary: ReasoningSummary;
  permission?: DynamicPermission;
  /** Explicit MCP subset; omission inherits the durable captured ceiling. */
  mcpServers?: Set<string>;
  /** Request-local selectors resolved to UUID grants by the runtime. */
  recipientSelectors: Set<string>;
  /** Request-local observation selectors resolved to UUID grants by the runtime. */
  observeSelectors: Set<string>;
  ui?: DynamicAgentDefinition["ui"];
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface AgentValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  agent?: ResolvedAgent;
}

export interface SpawnValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  agents?: ResolvedAgent[];
}

export interface ProtocolMessage {
  v: typeof PROTOCOL_VERSION;
  id: string;
  type: string;
  ts: string;
  requestId?: string;
  runId?: string;
  memberId?: string;
  target?: string;
  sequence?: number;
  done?: boolean;
  payload?: unknown;
}
