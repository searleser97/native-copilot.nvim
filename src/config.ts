import { z } from "zod";
import type {
  AgentValidationResult,
  DynamicAgentDefinition,
  ResolvedAgent,
  SpawnAgentsRequest,
  SpawnValidationResult,
  ValidationIssue,
} from "./types.js";

/** Request-local selector for the agent invoking a management tool. */
export const CALLER_SELECTOR = "caller";
/** Deprecated compatibility selector that resolves to the current primary agent. */
export const LEGACY_PRIMARY_SELECTOR = "standard";
/** Default alias of the agent attached to the primary user-facing buffer. */
export const PRIMARY_ALIAS = "copilot";

const aliasPattern = /^[a-z][a-z0-9_]*$/;
const alias = z.string().min(1).regex(
  aliasPattern,
  "must start with a lowercase letter and contain only lowercase letters, numbers, and underscores",
).describe(
  "Tool-safe alias used in agent messaging and every user-facing reference to this agent. It must " +
    `be unique among active and recoverable agents, and must not be the request-local selector ` +
    `"${CALLER_SELECTOR}" or a host-reserved compatibility selector. Several agents may share a ` +
    "display name as long as their aliases differ.",
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
  prompt: z.string().min(1).describe("Complete operating instructions for this agent."),
  model: z.string().min(1).optional().describe("Model ID; omit to inherit the runtime default."),
  reasoningEffort: reasoningEffort.optional().describe("Optional reasoning effort override."),
  reasoningSummary: reasoningSummary.optional().describe("Optional reasoning display level."),
  permissions: dynamicPermissionSchema.optional().describe(
    "Agent permission policy; omit to inherit the main session policy.",
  ),
  mcpServers: stringList.optional().describe(
    "Subset of the MCP server ceiling captured from the primary session; omit to inherit that ceiling.",
  ),
  canTalkTo: z.array(z.string().min(1)).describe(
    `Directional outgoing recipients: peer aliases, durable agent:<uuid> targets, or the request-local selector ` +
      `"${CALLER_SELECTOR}". Each selector is resolved to a durable agent UUID before it is ` +
      "persisted. It must not identify this agent itself, and it grants no incoming permission.",
  ),
  canObserve: z.array(z.string().min(1)).describe(
    `Directional passive-observation grants. Each peer alias, durable agent:<uuid> target, or ` +
      `"${CALLER_SELECTOR}" allows this ` +
      "agent to read that session's SDK event history through " +
      "native_copilot_read_agent_activity without prompting or interrupting it. This is " +
      "independent from canTalkTo.",
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
  callerCanTalkTo: z.array(z.string().min(1)).describe(
    "Aliases in this request that the calling agent is explicitly allowed to message. This grants " +
      "caller-to-child access only; child-to-caller access requires the child's canTalkTo to " +
      `contain "${CALLER_SELECTOR}".`,
  ),
  callerCanObserve: z.array(z.string().min(1)).describe(
    "Aliases in this request whose SDK event history the calling agent may inspect passively. " +
      "This grants no messaging permission.",
  ),
}).strict();

function addIssue(issues: ValidationIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function resolveAgent(definition: DynamicAgentDefinition): ResolvedAgent {
  const agent: ResolvedAgent = {
    alias: definition.id,
    displayName: definition.displayName,
    description: definition.description,
    task: definition.task,
    initialPrompt: definition.prompt,
    reasoningSummary: definition.reasoningSummary ?? "detailed",
    recipientSelectors: new Set(definition.canTalkTo),
    observeSelectors: new Set(definition.canObserve),
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
   * Aliases this agent's canTalkTo/canObserve may reference, excluding its own
   * alias. The request-local `caller` selector is always referenceable.
   */
  availableAliases: ReadonlySet<string>;
  /** Used only to recover a legacy v8 agent whose alias was `caller`. */
  allowCallerAlias?: boolean;
  path?: string;
}

/**
 * Validates a single complete agent definition and resolves it. Directional
 * communication is validated strictly: an alias may not reference itself, and every
 * recipient must be a known alias or the request-local `caller` selector.
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
  if (normalized.id === CALLER_SELECTOR && options.allowCallerAlias !== true) {
    addIssue(issues, `${path}.id`, `"${CALLER_SELECTOR}" is a request-local selector`);
  }
  if (normalized.id === LEGACY_PRIMARY_SELECTOR) {
    addIssue(
      issues,
      `${path}.id`,
      `"${LEGACY_PRIMARY_SELECTOR}" is a reserved compatibility selector`,
    );
  }
  for (const field of ["canTalkTo", "canObserve"] as const) {
    const aliases = new Set(normalized[field]);
    if (aliases.has(normalized.id)) {
      addIssue(issues, `${path}.${field}`, "cannot include the agent itself");
    }
    for (const referenced of aliases) {
      if (referenced === normalized.id) {
        continue;
      }
      if (
        referenced === CALLER_SELECTOR ||
        referenced === LEGACY_PRIMARY_SELECTOR
      ) {
        continue;
      }
      if (referenced.startsWith("agent:") && referenced.length > "agent:".length) {
        continue;
      }
      if (!aliasPattern.test(referenced)) {
        addIssue(
          issues,
          `${path}.${field}`,
          `"${referenced}" is not a valid agent alias`,
        );
        continue;
      }
      if (!options.availableAliases.has(referenced)) {
        addIssue(issues, `${path}.${field}`, `references unknown agent "${referenced}"`);
      }
    }
  }
  if (issues.length > 0) {
    return { valid: false, issues };
  }
  return {
    valid: true,
    issues,
    agent: resolveAgent(normalized),
  };
}

/**
 * Validates an ephemeral spawn request and resolves every agent in it. The request
 * carries no group identity: it only names the agents to start and caller-relative
 * outgoing grants.
 */
export function validateSpawnRequest(
  request: SpawnAgentsRequest,
  path = "spawn",
  existingAliases: ReadonlySet<string> = new Set<string>(),
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

  const callerCanTalkTo = new Set(normalized.callerCanTalkTo);
  for (const [index, granted] of [...callerCanTalkTo].entries()) {
    if (!aliases.has(granted)) {
      addIssue(
        issues,
        `${path}.callerCanTalkTo.${index}`,
        `references unknown agent "${granted}"`,
      );
    }
  }
  const callerCanObserve = new Set(normalized.callerCanObserve);
  for (const [index, granted] of [...callerCanObserve].entries()) {
    if (!aliases.has(granted)) {
      addIssue(
        issues,
        `${path}.callerCanObserve.${index}`,
        `references unknown agent "${granted}"`,
      );
    }
  }

  const agents: ResolvedAgent[] = [];
  for (const [index, definition] of normalized.agents.entries()) {
    const availableAliases = new Set([...existingAliases, ...aliases]);
    availableAliases.delete(definition.id);
    const result = validateAgentDefinition(definition, {
      availableAliases,
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
