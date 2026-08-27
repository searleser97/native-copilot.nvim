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

export interface DynamicAgentDefinition {
  id: string;
  displayName: string;
  description: string;
  prompt: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  reasoningSummary?: ReasoningSummary;
  permissions?: DynamicPermission;
  mcpServers?: string[];
  canTalkTo: string[];
  autoStart?: boolean;
  ui?: {
    icon?: string;
    color?: string;
  };
}

export interface DynamicFleetDefinition {
  id: string;
  name: string;
  description: string;
  objective: string;
  entryAgent: string;
  agents: DynamicAgentDefinition[];
}

export interface ResolvedMember {
  id: string;
  displayName: string;
  description: string;
  initialPrompt: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  reasoningSummary: ReasoningSummary;
  permission?: DynamicPermission;
  mcpServers?: Set<string>;
  recipients: Set<string>;
  autoStart: boolean;
  ui?: DynamicAgentDefinition["ui"];
}

export interface ResolvedFleet {
  id: string;
  name: string;
  description: string;
  entryMember: string;
  definition: DynamicFleetDefinition;
  members: Map<string, ResolvedMember>;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface FleetValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  fleet?: ResolvedFleet;
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
