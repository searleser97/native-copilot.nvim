import { z } from "zod";
import type {
  AgentValidationResult,
  DynamicAgentDefinition,
  ResolvedAgent,
  SpawnAgentsRequest,
  SpawnValidationResult,
  ValidationIssue,
} from "./types.js";

/** Reserved alias of the Standard supervisor session; never a spawned agent alias. */
export const STANDARD_ALIAS = "standard";

const aliasPattern = /^[a-z][a-z0-9_]*$/;
const alias = z.string().min(1).regex(
  aliasPattern,
  "must start with a lowercase letter and contain only lowercase letters, numbers, and underscores",
).describe(
  "Tool-safe alias used in generated send_to_<alias> tool names and in every user-facing " +
    "reference to this agent. It must be unique among active and recoverable agents, and must " +
    'not be the reserved alias "standard". Several agents may share a role or display name as ' +
    "long as their aliases differ.",
);
const reasoningEffort = z.enum(["low", "medium", "high", "xhigh", "max"]);
const reasoningSummary = z.enum(["none", "concise", "detailed"]);
const stringList = z.array(z.string().min(1));

export const permissionsSchema = z.object({
  tools: z.object({
    allow: stringList.describe("SDK tool patterns this agent may use."),
    deny: stringList.describe("SDK tool patterns explicitly denied to this agent."),
  }),
  paths: z.object({
    read: stringList.describe("Readable roots; ${workspace} resolves to the active workspace."),
    write: stringList.describe("Writable roots; ${workspace} resolves to the active workspace."),
  }),
  commands: z.boolean().describe("Whether shell commands are allowed."),
  network: z.boolean().describe("Whether network access is allowed."),
  gitWrite: z.boolean().describe("Whether Git write operations are allowed."),
  externalActions: z.boolean().describe("Whether MCP and other external actions are allowed."),
}).strict();

export const dynamicPermissionSchema = z.union([
  z.object({
    mode: z.enum(["inherit", "prompt", "approveAll"]).describe(
      "inherit uses the main session policy; prompt asks interactively; approveAll requires the main command to grant --allow-all.",
    ),
  }).strict(),
  permissionsSchema,
]);

export const dynamicAgentSchema = z.object({
  id: alias,
  displayName: z.string().min(1).describe(
    "Human-readable agent name shown in the UI. Need not be unique.",
  ),
  description: z.string().min(1).describe("Concise statement of this agent's responsibility."),
  task: z.string().min(1).describe(
    "Complete initial objective delivered to this agent immediately after it starts.",
  ),
  prompt: z.string().min(1).describe("Complete role and operating instructions for this agent."),
  model: z.string().min(1).optional().describe("Model ID; omit to inherit the runtime default."),
  reasoningEffort: reasoningEffort.optional().describe("Optional reasoning effort override."),
  reasoningSummary: reasoningSummary.optional().describe("Optional reasoning display level."),
  permissions: dynamicPermissionSchema.optional().describe(
    "Agent permission policy; omit to inherit the main session policy.",
  ),
  mcpServers: stringList.optional().describe(
    "Subset of MCP server names loaded by the main session; omit to inherit all.",
  ),
  canTalkTo: z.array(z.string().min(1)).describe(
    'Directional outgoing recipients: peer aliases, or the reserved alias "standard". Each ' +
      "entry creates a dedicated send_to_<alias> tool for this agent. It must not contain this " +
      "agent's own alias, and it grants no incoming permission.",
  ),
  ui: z.object({
    icon: z.string().min(1).optional(),
    color: z.string().min(1).optional(),
  }).strict().optional(),
}).strict();

export const spawnAgentsSchema = z.object({
  agents: z.array(dynamicAgentSchema).min(1).max(12).describe(
    "Complete runtime definitions for every agent to spawn. Each one becomes an independent, " +
      "durable agent with its own session, run, and mailbox; the request itself is not a group.",
  ),
  standardCanTalkTo: z.array(z.string().min(1)).describe(
    "Aliases in this request that the Standard session is explicitly allowed to message with " +
      "send_to_agent. Communication is denied in both directions unless explicitly granted: this " +
      "list grants Standard→agent only, and an agent's canTalkTo entry of \"standard\" grants " +
      "agent→Standard only.",
  ),
}).strict();

function addIssue(issues: ValidationIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function resolveAgent(
  definition: DynamicAgentDefinition,
  standardCanTalk: boolean,
): ResolvedAgent {
  const agent: ResolvedAgent = {
    alias: definition.id,
    displayName: definition.displayName,
    description: definition.description,
    task: definition.task,
    initialPrompt: definition.prompt,
    reasoningSummary: definition.reasoningSummary ?? "detailed",
    recipients: new Set(definition.canTalkTo),
    standardCanTalk,
  };
  if (definition.model !== undefined) agent.model = definition.model;
  if (definition.reasoningEffort !== undefined) agent.reasoningEffort = definition.reasoningEffort;
  if (definition.permissions !== undefined) agent.permission = definition.permissions;
  if (definition.mcpServers !== undefined) agent.mcpServers = new Set(definition.mcpServers);
  if (definition.ui !== undefined) agent.ui = definition.ui;
  return agent;
}

export interface AgentValidationOptions {
  /**
   * Aliases this agent's canTalkTo may reference, excluding its own alias. The
   * reserved alias "standard" is always referenceable.
   */
  availableAliases: ReadonlySet<string>;
  /** Whether the Standard session is granted permission to message this agent. */
  standardCanTalk: boolean;
  path?: string;
}

/**
 * Validates a single complete agent definition and resolves it. Directional
 * communication is validated strictly: an alias may not reference itself, and every
 * recipient must be a known alias or the reserved alias "standard".
 */
export function validateAgentDefinition(
  definition: DynamicAgentDefinition,
  options: AgentValidationOptions,
): AgentValidationResult {
  const path = options.path ?? "agent";
  const parsed = dynamicAgentSchema.safeParse(definition);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((issue) => ({
        path: [path, ...issue.path].join("."),
        message: issue.message,
      })),
    };
  }
  const normalized = parsed.data as DynamicAgentDefinition;
  const issues: ValidationIssue[] = [];
  if (normalized.id === STANDARD_ALIAS) {
    addIssue(issues, `${path}.id`, `"${STANDARD_ALIAS}" is reserved for the Standard session`);
  }
  const recipients = new Set(normalized.canTalkTo);
  if (recipients.has(normalized.id)) {
    addIssue(issues, `${path}.canTalkTo`, "cannot include the agent itself");
  }
  for (const recipient of recipients) {
    if (recipient === STANDARD_ALIAS || recipient === normalized.id) {
      continue;
    }
    if (!aliasPattern.test(recipient)) {
      addIssue(
        issues,
        `${path}.canTalkTo`,
        `"${recipient}" is not a valid alias; use a peer alias or "${STANDARD_ALIAS}"`,
      );
      continue;
    }
    if (!options.availableAliases.has(recipient)) {
      addIssue(issues, `${path}.canTalkTo`, `references unknown agent "${recipient}"`);
    }
  }
  if (issues.length > 0) {
    return { valid: false, issues };
  }
  return {
    valid: true,
    issues,
    agent: resolveAgent(normalized, options.standardCanTalk),
  };
}

/**
 * Validates an ephemeral spawn request and resolves every agent in it. The request
 * carries no group identity: it only names the agents to start and the aliases the
 * Standard session may message.
 */
export function validateSpawnRequest(
  request: SpawnAgentsRequest,
  path = "spawn",
): SpawnValidationResult {
  const parsed = spawnAgentsSchema.safeParse(request);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((issue) => ({
        path: [path, ...issue.path].join("."),
        message: issue.message,
      })),
    };
  }

  const normalized = parsed.data as SpawnAgentsRequest;
  const issues: ValidationIssue[] = [];
  const aliases = new Set<string>();
  for (const [index, definition] of normalized.agents.entries()) {
    if (aliases.has(definition.id)) {
      addIssue(issues, `${path}.agents.${index}.id`, `duplicates agent "${definition.id}"`);
      continue;
    }
    aliases.add(definition.id);
  }

  const standardCanTalkTo = new Set(normalized.standardCanTalkTo);
  for (const [index, granted] of [...standardCanTalkTo].entries()) {
    if (!aliases.has(granted)) {
      addIssue(
        issues,
        `${path}.standardCanTalkTo.${index}`,
        `references unknown agent "${granted}"`,
      );
    }
  }

  const agents: ResolvedAgent[] = [];
  for (const [index, definition] of normalized.agents.entries()) {
    const availableAliases = new Set(aliases);
    availableAliases.delete(definition.id);
    const result = validateAgentDefinition(definition, {
      availableAliases,
      standardCanTalk: standardCanTalkTo.has(definition.id),
      path: `${path}.agents.${index}`,
    });
    issues.push(...result.issues);
    if (result.agent) {
      agents.push(result.agent);
    }
  }

  if (issues.length > 0) {
    return { valid: false, issues };
  }
  return { valid: true, issues, agents };
}
