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
 * tool-safe alias used in generated `send_to_<alias>` tool names and in every
 * user-facing reference; the runtime assigns the durable agent UUID separately.
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
  mcpServers?: string[];
  /** Directional outgoing recipients: peer aliases in the same request, or "standard". */
  canTalkTo: string[];
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
  /** Aliases in this request the Standard session is explicitly allowed to message. */
  standardCanTalkTo: string[];
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
  mcpServers?: Set<string>;
  /** Outgoing recipient aliases, possibly including the reserved alias "standard". */
  recipients: Set<string>;
  /** Whether the Standard session was explicitly granted permission to message this agent. */
  standardCanTalk: boolean;
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
