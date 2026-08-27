import { readFile } from "node:fs/promises";
import { z } from "zod";
import type {
  DynamicFleetDefinition,
  FleetConfig,
  FleetValidationResult,
  ResolvedMember,
  ValidationIssue,
} from "./types.js";

const idPattern = /^[a-z][a-z0-9_]*$/;
const id = z.string().min(1).regex(
  idPattern,
  "must start with a lowercase letter and contain only lowercase letters, numbers, and underscores",
);
const reasoningEffort = z.enum(["low", "medium", "high", "xhigh", "max"]);
const reasoningSummary = z.enum(["none", "concise", "detailed"]);
const stringList = z.array(z.string().min(1));

export const permissionsSchema = z.object({
  tools: z.object({
    allow: stringList,
    deny: stringList,
  }),
  paths: z.object({
    read: stringList,
    write: stringList,
  }),
  commands: z.boolean(),
  network: z.boolean(),
  gitWrite: z.boolean(),
  externalActions: z.boolean(),
}).strict();

export const dynamicPermissionSchema = z.union([
  z.object({ mode: z.enum(["inherit", "prompt", "approveAll"]) }).strict(),
  permissionsSchema,
]);

export const dynamicAgentSchema = z.object({
  id,
  displayName: z.string().min(1),
  description: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().min(1).optional(),
  reasoningEffort: reasoningEffort.optional(),
  reasoningSummary: reasoningSummary.optional(),
  permissions: dynamicPermissionSchema.optional(),
  mcpServers: stringList.optional(),
  canTalkTo: z.array(id),
  autoStart: z.boolean().optional(),
  ui: z.object({
    icon: z.string().min(1).optional(),
    color: z.string().min(1).optional(),
  }).strict().optional(),
}).strict();

export const dynamicFleetSchema = z.object({
  id,
  name: z.string().min(1),
  description: z.string().min(1),
  objective: z.string().min(1),
  entryAgent: id,
  agents: z.array(dynamicAgentSchema).min(1).max(12),
}).strict();

export const fleetConfigSchema = z.object({
  schemaVersion: z.literal(2),
  standard: z.object({
    id,
    displayName: z.string().min(1),
    initialPrompt: z.string().min(1),
    model: z.string().min(1).optional(),
    reasoningEffort: reasoningEffort.optional(),
    reasoningSummary: reasoningSummary.optional(),
    permissions: permissionsSchema.optional(),
  }).strict(),
  fleetExamples: z.array(dynamicFleetSchema).min(1),
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

export function validateConfig(config: FleetConfig): ValidationIssue[] {
  return config.fleetExamples.flatMap((example, index) =>
    validateFleet(example, `fleetExamples.${index}`).issues
  );
}

export async function loadConfig(path: string): Promise<FleetConfig> {
  const text = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(text);
  const result = fleetConfigSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid Native Copilot configuration:\n${detail}`);
  }
  const config = result.data as FleetConfig;
  const issues = validateConfig(config);
  if (issues.length > 0) {
    throw new Error(
      `Invalid fleet examples:\n${issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n")}`,
    );
  }
  return config;
}
