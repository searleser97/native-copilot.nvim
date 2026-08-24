import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import type {
  FleetConfig,
  FleetDefinition,
  FleetValidationResult,
  PermissionNarrowing,
  PermissionProfile,
  ResolvedFleet,
  ResolvedMember,
  ValidationIssue,
} from "./types.js";

const idPattern = /^[a-z0-9][a-z0-9._-]*$/;
const id = z.string().min(1).regex(idPattern, "must be a stable lowercase identifier");
const reasoningEffort = z.enum(["low", "medium", "high", "xhigh", "max"]);
const stringList = z.array(z.string().min(1));

const permissionProfileSchema = z.object({
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
});

const permissionNarrowingSchema = z.object({
  denyTools: stringList.optional(),
  readPaths: stringList.optional(),
  writePaths: stringList.optional(),
  commands: z.literal(false).optional(),
  network: z.literal(false).optional(),
  gitWrite: z.literal(false).optional(),
  externalActions: z.literal(false).optional(),
});

const fleetMemberSchema = z.object({
  agent: id,
  displayName: z.string().min(1).optional(),
  promptAppend: z.string().optional(),
  model: z.string().min(1).optional(),
  reasoningEffort: reasoningEffort.optional(),
  permissionNarrowing: permissionNarrowingSchema.optional(),
  recipients: z.array(id),
  recipientGroups: z.array(id).optional(),
  canBroadcast: z.boolean().optional(),
  autoStart: z.boolean().optional(),
});

const fleetDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  entryMember: id,
  coordinatorMember: id.optional(),
  groups: z.record(id, z.array(id)).optional(),
  validation: z.object({
    coordinatorFallback: z.enum(["none", "direct", "path"]),
    requireEntryReachability: z.boolean(),
    allowIsolatedMembers: z.boolean(),
  }),
  members: z.record(id, fleetMemberSchema),
});

export const fleetConfigSchema = z.object({
  schemaVersion: z.literal(1),
  defaultFleetId: id.optional(),
  standard: z.object({
    id,
    displayName: z.string().min(1),
    initialPrompt: z.string().min(1),
    model: z.string().min(1).optional(),
    reasoningEffort: reasoningEffort.optional(),
    permissionProfile: id,
  }),
  permissionProfiles: z.record(id, permissionProfileSchema),
  agents: z.record(
    id,
    z.object({
      name: z.string().min(1),
      description: z.string(),
      initialPrompt: z.string().min(1),
      model: z.string().min(1).optional(),
      reasoningEffort: reasoningEffort.optional(),
      permissionProfile: id,
      ui: z
        .object({
          icon: z.string().min(1).optional(),
          color: z.string().min(1).optional(),
        })
        .optional(),
    }),
  ),
  fleets: z.record(id, fleetDefinitionSchema),
});

function addIssue(issues: ValidationIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function pathWithin(candidate: string, roots: string[], workspace: string): boolean {
  const expanded = resolve(workspace, candidate.replaceAll("${workspace}", workspace));
  return roots.some((root) => {
    const expandedRoot = resolve(workspace, root.replaceAll("${workspace}", workspace));
    const child = relative(expandedRoot, expanded);
    return child === "" || (!child.startsWith("..") && !isAbsolute(child));
  });
}

export function narrowPermission(
  base: PermissionProfile,
  narrowing: PermissionNarrowing | undefined,
  workspace: string,
  issues: ValidationIssue[],
  path: string,
): PermissionProfile {
  if (!narrowing) {
    return structuredClone(base);
  }
  const read = narrowing.readPaths ?? base.paths.read;
  const write = narrowing.writePaths ?? base.paths.write;
  for (const candidate of read) {
    if (!pathWithin(candidate, base.paths.read, workspace)) {
      addIssue(issues, `${path}.readPaths`, `"${candidate}" exceeds the base read-path ceiling`);
    }
  }
  for (const candidate of write) {
    if (!pathWithin(candidate, base.paths.write, workspace)) {
      addIssue(issues, `${path}.writePaths`, `"${candidate}" exceeds the base write-path ceiling`);
    }
  }
  return {
    tools: {
      allow: [...base.tools.allow],
      deny: [...new Set([...base.tools.deny, ...(narrowing.denyTools ?? [])])],
    },
    paths: { read: [...read], write: [...write] },
    commands: narrowing.commands ?? base.commands,
    network: narrowing.network ?? base.network,
    gitWrite: narrowing.gitWrite ?? base.gitWrite,
    externalActions: narrowing.externalActions ?? base.externalActions,
  };
}

function reachable(start: string, members: Map<string, ResolvedMember>): Set<string> {
  const seen = new Set<string>();
  const pending = [start];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const recipient of members.get(current)?.recipients ?? []) {
      if (!seen.has(recipient)) {
        pending.push(recipient);
      }
    }
  }
  return seen;
}

export function validateFleet(
  config: FleetConfig,
  fleetId: string,
  workspace = process.cwd(),
): FleetValidationResult {
  const issues: ValidationIssue[] = [];
  const definition = config.fleets[fleetId];
  if (!definition) {
    return { valid: false, issues: [{ path: `fleets.${fleetId}`, message: "unknown fleet" }] };
  }

  const memberIds = new Set(Object.keys(definition.members));
  if (!memberIds.has(definition.entryMember)) {
    addIssue(issues, `fleets.${fleetId}.entryMember`, "does not reference a fleet member");
  }
  if (definition.coordinatorMember && !memberIds.has(definition.coordinatorMember)) {
    addIssue(issues, `fleets.${fleetId}.coordinatorMember`, "does not reference a fleet member");
  }

  const groups = definition.groups ?? {};
  for (const [groupId, groupMembers] of Object.entries(groups)) {
    for (const memberId of groupMembers) {
      if (!memberIds.has(memberId)) {
        addIssue(
          issues,
          `fleets.${fleetId}.groups.${groupId}`,
          `references unknown member "${memberId}"`,
        );
      }
    }
  }

  const members = new Map<string, ResolvedMember>();
  for (const [memberId, member] of Object.entries(definition.members)) {
    const memberPath = `fleets.${fleetId}.members.${memberId}`;
    const agent = config.agents[member.agent];
    if (!agent) {
      addIssue(issues, `${memberPath}.agent`, `references unknown agent "${member.agent}"`);
      continue;
    }
    const profile = config.permissionProfiles[agent.permissionProfile];
    if (!profile) {
      addIssue(
        issues,
        `agents.${member.agent}.permissionProfile`,
        `references unknown profile "${agent.permissionProfile}"`,
      );
      continue;
    }

    const recipients = new Set(member.recipients);
    for (const groupId of member.recipientGroups ?? []) {
      const groupMembers = groups[groupId];
      if (!groupMembers) {
        addIssue(issues, `${memberPath}.recipientGroups`, `references unknown group "${groupId}"`);
        continue;
      }
      groupMembers.forEach((recipient) => recipients.add(recipient));
    }
    recipients.delete(memberId);
    for (const recipient of recipients) {
      if (!memberIds.has(recipient)) {
        addIssue(
          issues,
          `${memberPath}.recipients`,
          `references unknown member "${recipient}"`,
        );
      }
    }

    const initialPrompt = member.promptAppend
      ? `${agent.initialPrompt}\n\nFleet-specific instructions:\n${member.promptAppend}`
      : agent.initialPrompt;
    const resolved: ResolvedMember = {
      id: memberId,
      agentId: member.agent,
      displayName: member.displayName ?? agent.name,
      description: agent.description,
      initialPrompt,
      permission: narrowPermission(
        profile,
        member.permissionNarrowing,
        workspace,
        issues,
        `${memberPath}.permissionNarrowing`,
      ),
      recipients,
      canBroadcast: member.canBroadcast ?? false,
      autoStart: member.autoStart ?? true,
    };
    const model = member.model ?? agent.model;
    if (model !== undefined) {
      resolved.model = model;
    }
    const effort = member.reasoningEffort ?? agent.reasoningEffort;
    if (effort !== undefined) {
      resolved.reasoningEffort = effort;
    }
    if (agent.ui !== undefined) {
      resolved.ui = agent.ui;
    }
    members.set(memberId, resolved);
  }

  if (!definition.validation.allowIsolatedMembers) {
    for (const memberId of memberIds) {
      const inbound = [...members.values()].some((member) => member.recipients.has(memberId));
      const outbound = (members.get(memberId)?.recipients.size ?? 0) > 0;
      if (memberIds.size > 1 && !inbound && !outbound) {
        addIssue(
          issues,
          `fleets.${fleetId}.members.${memberId}`,
          "is isolated but isolated members are not allowed",
        );
      }
    }
  }

  const coordinator = definition.coordinatorMember;
  if (definition.validation.coordinatorFallback !== "none" && !coordinator) {
    addIssue(
      issues,
      `fleets.${fleetId}.coordinatorMember`,
      "is required by the coordinator fallback policy",
    );
  } else if (coordinator) {
    for (const memberId of memberIds) {
      if (memberId === coordinator) {
        continue;
      }
      if (
        definition.validation.coordinatorFallback === "direct" &&
        !members.get(memberId)?.recipients.has(coordinator)
      ) {
        addIssue(
          issues,
          `fleets.${fleetId}.members.${memberId}.recipients`,
          `must directly include coordinator "${coordinator}"`,
        );
      }
      if (
        definition.validation.coordinatorFallback === "path" &&
        !reachable(memberId, members).has(coordinator)
      ) {
        addIssue(
          issues,
          `fleets.${fleetId}.members.${memberId}.recipients`,
          `must have a directed path to coordinator "${coordinator}"`,
        );
      }
    }
  }

  if (definition.validation.requireEntryReachability && members.has(definition.entryMember)) {
    const fromEntry = reachable(definition.entryMember, members);
    for (const memberId of memberIds) {
      if (!fromEntry.has(memberId)) {
        addIssue(
          issues,
          `fleets.${fleetId}.entryMember`,
          `cannot reach member "${memberId}"`,
        );
      }
    }
  }

  if (issues.length > 0) {
    return { valid: false, issues };
  }
  const fleet: ResolvedFleet = {
    id: fleetId,
    name: definition.name,
    description: definition.description,
    entryMember: definition.entryMember,
    members,
  };
  if (definition.coordinatorMember !== undefined) {
    fleet.coordinatorMember = definition.coordinatorMember;
  }
  return { valid: true, issues, fleet };
}

export function validateConfig(config: FleetConfig, workspace = process.cwd()): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (config.defaultFleetId && !config.fleets[config.defaultFleetId]) {
    addIssue(issues, "defaultFleetId", `references unknown fleet "${config.defaultFleetId}"`);
  }
  if (!config.permissionProfiles[config.standard.permissionProfile]) {
    addIssue(
      issues,
      "standard.permissionProfile",
      `references unknown profile "${config.standard.permissionProfile}"`,
    );
  }
  for (const [agentId, agent] of Object.entries(config.agents)) {
    if (!config.permissionProfiles[agent.permissionProfile]) {
      addIssue(
        issues,
        `agents.${agentId}.permissionProfile`,
        `references unknown profile "${agent.permissionProfile}"`,
      );
    }
  }
  for (const fleetId of Object.keys(config.fleets)) {
    issues.push(...validateFleet(config, fleetId, workspace).issues);
  }
  return issues;
}

export function validateHostConfig(config: FleetConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!config.permissionProfiles[config.standard.permissionProfile]) {
    addIssue(
      issues,
      "standard.permissionProfile",
      `references unknown profile "${config.standard.permissionProfile}"`,
    );
  }
  return issues;
}

export async function loadConfig(path: string, workspace = process.cwd()): Promise<FleetConfig> {
  const text = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(text);
  const result = fleetConfigSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid fleet configuration:\n${detail}`);
  }
  const config = result.data as FleetConfig;
  const issues = validateHostConfig(config);
  if (issues.length > 0) {
    throw new Error(
      `Invalid fleet configuration:\n${issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n")}`,
    );
  }
  return config;
}

export function fleetSummaries(
  config: FleetConfig,
  workspace = process.cwd(),
): Array<{
  id: string;
  name: string;
  description: string;
  valid: boolean;
  issues: ValidationIssue[];
  members: number;
}> {
  return Object.entries(config.fleets).map(([fleetId, definition]: [string, FleetDefinition]) => {
    const result = validateFleet(config, fleetId, workspace);
    return {
      id: fleetId,
      name: definition.name,
      description: definition.description,
      valid: result.valid,
      issues: result.issues,
      members: Object.keys(definition.members).length,
    };
  });
}
