import { z } from "zod";
import type {
  DynamicFleetDefinition,
  FleetValidationResult,
  ResolvedMember,
  ValidationIssue,
} from "./types.js";

const idPattern = /^[a-z][a-z0-9_]*$/;
const id = z.string().min(1).regex(
  idPattern,
  "must start with a lowercase letter and contain only lowercase letters, numbers, and underscores",
).describe(
  "Tool-safe identifier used in generated send_to_<agent> tool names. Must be unique within the " +
    "Fleet — this is the only uniqueness requirement, so several agents may share the same role or " +
    "display name as long as their IDs differ.",
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
  id,
  displayName: z.string().min(1).describe(
    "Human-readable agent name shown in the UI. Need not be unique; a Fleet may contain multiple " +
      "agents with the same role or name (for example two planners) as long as their IDs differ.",
  ),
  description: z.string().min(1).describe("Concise statement of this agent's responsibility."),
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
  canTalkTo: z.array(id).describe(
    "Directional peer IDs. Each entry creates a dedicated send_to_<agent> tool.",
  ),
  autoStart: z.boolean().optional().describe("Defaults to true; false starts the member lazily."),
  ui: z.object({
    icon: z.string().min(1).optional(),
    color: z.string().min(1).optional(),
  }).strict().optional(),
}).strict();

export const dynamicFleetSchema = z.object({
  id: id.describe("Unique Fleet identifier."),
  name: z.string().min(1).describe("Human-readable Fleet name."),
  description: z.string().min(1).describe("Concise description of the Fleet's collaboration model."),
  objective: z.string().min(1).describe(
    "Complete task delivered automatically to the entry agent after startup.",
  ),
  entryAgent: id.describe("Agent ID that receives the objective and begins coordination."),
  agents: z.array(dynamicAgentSchema).min(1).max(12).describe(
    "Complete runtime definitions for every Fleet member. Only agent IDs must be unique; multiple " +
      "members may share the same role or display name (for example two developers) with distinct IDs.",
  ),
}).strict();

function addIssue(issues: ValidationIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

export function validateFleet(
  definition: DynamicFleetDefinition,
  path = "fleet",
): FleetValidationResult {
  const issues: ValidationIssue[] = [];
  const parsed = dynamicFleetSchema.safeParse(definition);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((issue) => ({
        path: [path, ...issue.path].join("."),
        message: issue.message,
      })),
    };
  }

  const normalized = parsed.data as DynamicFleetDefinition;
  const members = new Map<string, ResolvedMember>();
  const memberIds = new Set<string>();
  for (const [index, agent] of normalized.agents.entries()) {
    if (memberIds.has(agent.id)) {
      addIssue(issues, `${path}.agents.${index}.id`, `duplicates agent "${agent.id}"`);
      continue;
    }
    memberIds.add(agent.id);
  }

  if (!memberIds.has(normalized.entryAgent)) {
    addIssue(issues, `${path}.entryAgent`, "does not reference an agent in this fleet");
  }

  for (const [index, agent] of normalized.agents.entries()) {
    const recipients = new Set(agent.canTalkTo);
    if (recipients.has(agent.id)) {
      addIssue(issues, `${path}.agents.${index}.canTalkTo`, "cannot include the agent itself");
    }
    for (const recipient of recipients) {
      if (!memberIds.has(recipient)) {
        addIssue(
          issues,
          `${path}.agents.${index}.canTalkTo`,
          `references unknown agent "${recipient}"`,
        );
      }
    }
    const member: ResolvedMember = {
      id: agent.id,
      displayName: agent.displayName,
      description: agent.description,
      initialPrompt: agent.prompt,
      reasoningSummary: agent.reasoningSummary ?? "detailed",
      recipients,
      autoStart: agent.autoStart ?? true,
    };
    if (agent.model !== undefined) member.model = agent.model;
    if (agent.reasoningEffort !== undefined) member.reasoningEffort = agent.reasoningEffort;
    if (agent.permissions !== undefined) member.permission = agent.permissions;
    if (agent.mcpServers !== undefined) member.mcpServers = new Set(agent.mcpServers);
    if (agent.ui !== undefined) member.ui = agent.ui;
    members.set(agent.id, member);
  }

  if (issues.length > 0) {
    return { valid: false, issues };
  }
  return {
    valid: true,
    issues,
    fleet: {
      id: normalized.id,
      name: normalized.name,
      description: normalized.description,
      entryMember: normalized.entryAgent,
      definition: normalized,
      members,
    },
  };
}
