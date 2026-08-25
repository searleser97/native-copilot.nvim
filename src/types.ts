export const PROTOCOL_VERSION = 1 as const;

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ReasoningSummary = "none" | "concise" | "detailed";

export interface StandardConfig {
  id: string;
  displayName: string;
  initialPrompt: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  reasoningSummary?: ReasoningSummary;
  permissionProfile: string;
}

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

export interface AgentDefinition {
  name: string;
  description: string;
  initialPrompt: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  reasoningSummary?: ReasoningSummary;
  permissionProfile: string;
  ui?: {
    icon?: string;
    color?: string;
  };
}

export interface PermissionNarrowing {
  denyTools?: string[];
  readPaths?: string[];
  writePaths?: string[];
  commands?: false;
  network?: false;
  gitWrite?: false;
  externalActions?: false;
}

export interface FleetMember {
  agent: string;
  displayName?: string;
  promptAppend?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  reasoningSummary?: ReasoningSummary;
  permissionNarrowing?: PermissionNarrowing;
  recipients: string[];
  recipientGroups?: string[];
  canBroadcast?: boolean;
  autoStart?: boolean;
}

export interface FleetValidationPolicy {
  coordinatorFallback: "none" | "direct" | "path";
  requireEntryReachability: boolean;
  allowIsolatedMembers: boolean;
}

export interface FleetDefinition {
  name: string;
  description: string;
  entryMember: string;
  coordinatorMember?: string;
  groups?: Record<string, string[]>;
  validation: FleetValidationPolicy;
  members: Record<string, FleetMember>;
}

export interface FleetConfig {
  schemaVersion: 1;
  defaultFleetId?: string;
  standard: StandardConfig;
  permissionProfiles: Record<string, PermissionProfile>;
  agents: Record<string, AgentDefinition>;
  fleets: Record<string, FleetDefinition>;
}

export interface ResolvedMember {
  id: string;
  agentId: string;
  displayName: string;
  description: string;
  initialPrompt: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  reasoningSummary: ReasoningSummary;
  permission: PermissionProfile;
  recipients: Set<string>;
  canBroadcast: boolean;
  autoStart: boolean;
  ui?: AgentDefinition["ui"];
}

export interface ResolvedFleet {
  id: string;
  name: string;
  description: string;
  entryMember: string;
  coordinatorMember?: string;
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
