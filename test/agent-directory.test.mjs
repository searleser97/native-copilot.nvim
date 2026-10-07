import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { AgentDatabase } from "../dist/database.js";
import { agentCreateSchema, createDefinitionToDynamic } from "../dist/config.js";
import { CopilotRuntime, permissionDecision } from "../dist/runtime.js";

const artifacts = resolve(".e2e-artifacts", "agent-directory-tests");
mkdirSync(artifacts, { recursive: true });

function fixture(t, { allowAll = true } = {}) {
  const directory = realpathSync.native(mkdtempSync(join(artifacts, "case-")));
  const host = join(directory, "host");
  const target = join(directory, "target");
  mkdirSync(host);
  mkdirSync(target);
  const db = new AgentDatabase(join(directory, "state.sqlite"), () => false);
  const definition = {
    id: "parent", displayName: "Parent", description: "Parent",
    task: "Coordinate.", prompt: "Coordinate.", permissions: { mode: "inherit" },
    mcpServers: ["approved"], canTalkTo: [], canObserve: [],
  };
  db.createAgentRun("parent-run", "parent-agent", "parent", JSON.stringify({
    definition, mcpServers: ["approved"], canTalkToAgentIds: [], canObserveAgentIds: [],
  }), host, process.pid, true);
  db.upsertSession("parent-run", "parent-session", "connected");
  db.completeRunStartup("parent-run");
  const discoveries = [];
  const configs = [];
  const configure = () => {
    const runtime = new CopilotRuntime(host, db, () => {});
    runtime.policy.allowAll = allowAll;
    runtime.policy.mcpServers = {
      approved: { command: "node", args: ["server.js"], env: { FLAVOR: "approved" } },
    };
    const parent = {
      agentId: "parent-agent", target: "agent:parent-agent", alias: "parent",
      runId: "parent-run", definition,
      agent: runtime.resolveStoredDefinition(definition),
      mcpServers: new Set(["approved"]), canTalkTo: new Set(), canObserve: new Set(),
    };
    runtime.primaryAgentId = parent.agentId;
    runtime.agents.set(parent.agentId, parent);
    runtime.aliasIndex.set(parent.alias, parent.agentId);
    runtime.openPrimary = async () => {};
    runtime.availableMcpServers = async () => new Set(["approved", "builtin-only"]);
    runtime.ensureClient = async () => ({
      rpc: {
        sessions: { checkInUse: async () => ({ inUse: [] }) },
        mcp: { discover: async ({ workingDirectory }) => {
          discoveries.push(workingDirectory);
          return { servers: [
            { name: "approved", source: "workspace", enabled: true, type: "stdio" },
            { name: "target-only", source: "workspace", enabled: true, type: "stdio" },
          ] };
        } },
      },
    });
    runtime.ensureAgentSession = async (agentId) => {
      const context = runtime.agents.get(agentId);
      const plan = await runtime.sessionConnectionPlan(context);
      configs.push(plan.config);
      const sessionId = db.session(context.runId)?.sessionId ?? `${context.alias}-session`;
      db.upsertSession(context.runId, sessionId, "connected");
      return { session: { sessionId } };
    };
    return { runtime, parent };
  };
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, host, target, db, discoveries, configs, configure, ...configure() };
}

function child(id, workingDirectory, permissions = { mode: "inherit" }, mcpServers = ["approved"]) {
  return {
    id, displayName: id, description: id, prompt: "Wait.", permissions, mcpServers,
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
  };
}

function profile(read, write = read) {
  return {
    tools: { allow: ["builtin:*"], deny: [] }, paths: { read, write },
    commands: true, network: false, gitWrite: false, externalActions: false,
  };
}

test("create schema carries optional cwd and rejects empty or unknown inputs", () => {
  assert.equal(createDefinitionToDynamic(agentCreateSchema.parse(child("worker", "repo"))).workingDirectory, "repo");
  assert.equal(createDefinitionToDynamic(agentCreateSchema.parse(child("worker"))).workingDirectory, undefined);
  assert.throws(() => agentCreateSchema.parse(child("worker", "")));
  assert.throws(() => agentCreateSchema.parse({ ...child("worker"), cwd: "repo" }));
});

test("omitted cwd retains host discovery and execution defaults", async (t) => {
  const { runtime, parent, host, configs, discoveries } = fixture(t);
  const result = await runtime.createAgentForCaller(parent, child("worker"));
  assert.equal(result.workingDirectory, host);
  assert.equal(configs[0].workingDirectory, host);
  assert.equal(configs[0].enableConfigDiscovery, true);
  assert.deepEqual(discoveries, []);
});

test("explicit cwd reaches session config and survives stop and host restart without moving ownership", async (t) => {
  const { runtime, parent, host, target, db, configs, discoveries, configure } = fixture(t);
  const created = await runtime.createAgentForCaller(parent, child("worker", join("..", "target")));
  assert.equal(created.workingDirectory, target);
  assert.equal(configs[0].workingDirectory, target);
  assert.deepEqual(discoveries, [target]);
  const stored = db.agentRun(created.runId, host);
  assert.equal(db.agentRun(created.runId, target), undefined);
  assert.equal(db.sessionOwner(created.sessionId).workspace, host);
  assert.equal(JSON.parse(stored.definition).definition.workingDirectory, target);
  await runtime.stopAgent(created.agentId);
  const restarted = configure();
  assert.equal(restarted.runtime.recoverableAgentRuns()[0].workingDirectory, target);
  await restarted.runtime.resumeAgent(created.runId, {}, restarted.parent);
  const recovered = restarted.runtime.agents.get(created.agentId);
  assert.equal(recovered.definition.workingDirectory, target);
  assert.equal(configs.at(-1).workingDirectory, target);
  assert.equal(db.session(created.runId).sessionId, created.sessionId);
  assert.equal(db.agentAdministration(created.agentId).ownerAgentId, parent.agentId);
});

test("invalid directories fail before reserving aliases or discovering MCP", async (t) => {
  const { runtime, parent, directory, db, host, discoveries } = fixture(t);
  const file = join(directory, "file.txt");
  writeFileSync(file, "not a directory");
  for (const path of [file, join(directory, "missing"), "\0"]) {
    await assert.rejects(runtime.createAgentForCaller(parent, child("worker", path)), /existing, accessible directory/);
  }
  assert.deepEqual(db.ownedRecoverableOrActiveAgentRuns(parent.agentId, host), []);
  assert.deepEqual(discoveries, []);
});

test("interactive hosts cannot silently grant a directory outside the host workspace", async (t) => {
  const { runtime, parent, target, host } = fixture(t, { allowAll: false });
  await assert.rejects(runtime.createAgentForCaller(parent, child("worker", target)), /outside the host workspace/);
  mkdirSync(join(host, "nested"));
  await runtime.createAgentForCaller(parent, child("worker", "nested"));
});

test("junctions are canonicalized before creator path authorization", async (t) => {
  const { runtime, parent, host, target } = fixture(t);
  const link = join(host, "escape");
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  runtime.primaryAgentId = "another-primary";
  parent.definition.permissions = profile(["${workspace}"]);
  await assert.rejects(
    runtime.createAgentForCaller(parent, child("worker", link, profile(["${workspace}"]))),
    /creator .* readable path ceiling/,
  );
  parent.definition.permissions = { mode: "inherit" };
  const created = await runtime.createAgentForCaller(parent, child("worker", link));
  assert.equal(created.workingDirectory, target);
});

test("permission roots stay host-relative while tool paths resolve against execution cwd", (t) => {
  const { host, target } = fixture(t);
  const permissions = profile(["${workspace}", "relative"]);
  assert.equal(permissionDecision(permissions, host, { kind: "read", path: "file.txt" }, target).kind, "reject");
  assert.equal(permissionDecision(permissions, host, { kind: "write", fileName: "file.txt" }, target).kind, "reject");
  assert.equal(permissionDecision(permissions, host, { kind: "read", path: join(host, "file.txt") }, target).kind, "no-result");
  const escape = join(host, "escape");
  symlinkSync(target, escape, process.platform === "win32" ? "junction" : "dir");
  assert.equal(permissionDecision(permissions, host, { kind: "read", path: join(escape, "new.txt") }).kind, "reject");
});

test("cross-directory MCP never loads extra or same-name target definitions", async (t) => {
  const { runtime, parent, target, host, configs, db } = fixture(t);
  const created = await runtime.createAgentForCaller(parent, child("worker", target));
  const config = configs[0];
  assert.equal(config.enableConfigDiscovery, false);
  assert.equal(config.enableOnDemandInstructionDiscovery, true);
  assert.equal(config.enableFileHooks, false);
  assert.deepEqual(Object.keys(config.mcpServers), ["approved"]);
  assert.equal(config.mcpServers.approved.workingDirectory, host);
  assert.equal(config.mcpServers.approved.env.FLAVOR, "approved");
  assert.ok(config.disabledMcpServers.includes("target-only"));
  assert.match(created.configurationWarnings.join("\n"), /same-name replacements.*approved, target-only/);
  const stored = JSON.parse(db.agentRun(created.runId, host).definition);
  assert.match(stored.mcpConfigFingerprints.approved, /^[a-f0-9]{64}$/);
  assert.equal(stored.mcpConfigFingerprints.approved.includes("FLAVOR"), false);
  await assert.rejects(
    runtime.createAgentForCaller(parent, child("unapproved", target, undefined, ["target-only"])),
    /unavailable MCP server/,
  );
  await assert.rejects(
    runtime.createAgentForCaller(parent, child("unverifiable", target, undefined, ["builtin-only"])),
    /no verifiable launch configuration/,
  );
});

test("same-name host MCP changes cannot replace persisted approvals on recovery", async (t) => {
  const { runtime, parent, target, host, db } = fixture(t);
  const created = await runtime.createAgentForCaller(parent, child("worker", target));
  await runtime.stopAgent(created.agentId);
  const before = db.agentRun(created.runId, host);
  runtime.policy.mcpServers.approved = { type: "http", url: "https://different.invalid/mcp" };
  await assert.rejects(runtime.resumeAgent(created.runId, {}, parent), /same-name replacement is not authorized/);
  assert.equal(db.agentRun(created.runId, host).definition, before.definition);
  assert.equal(db.agentRun(created.runId, host).status, "stopped");
});

test("deleted cwd prevents recovery without mutating a stopped agent", async (t) => {
  const { runtime, parent, target, host, db } = fixture(t);
  const created = await runtime.createAgentForCaller(parent, child("worker", target));
  await runtime.stopAgent(created.agentId);
  rmdirSync(target);
  await assert.rejects(runtime.resumeAgent(created.runId, {}, parent), /existing, accessible directory/);
  assert.equal(db.agentRun(created.runId, host).status, "stopped");
});

test("redirecting a stored directory through a junction cannot redirect recovery", async (t) => {
  const { runtime, parent, target, host, db } = fixture(t);
  const created = await runtime.createAgentForCaller(parent, child("worker", target));
  await runtime.stopAgent(created.agentId);
  const before = db.agentRun(created.runId, host);
  rmdirSync(target);
  symlinkSync(host, target, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(runtime.resumeAgent(created.runId, {}, parent), /now resolves to a different location/);
  assert.equal(db.agentRun(created.runId, host).definition, before.definition);
  assert.equal(db.agentRun(created.runId, host).status, "stopped");
});

test("different execution directories retain ordinary durable peer links", async (t) => {
  const { runtime, parent, target, host, db } = fixture(t);
  const first = await runtime.createAgentForCaller(parent, child("first", target));
  const second = await runtime.createAgentForCaller(parent, child("second"));
  const subject = runtime.agents.get(first.agentId);
  await runtime.updateOwnedAgentLinks(parent, subject, {
    canTalkToSessionIds: [second.sessionId], canObserveSessionIds: [second.sessionId],
  });
  assert.equal(subject.canTalkTo.has(second.agentId), true);
  assert.equal(subject.canObserve.has(second.agentId), true);
  assert.equal(db.agentAdministration(first.agentId).workspace, host);
  await runtime.stopAgent(first.agentId);
  await runtime.resumeAgent(first.runId, {}, parent);
  assert.equal(runtime.agents.get(first.agentId).canTalkTo.has(second.agentId), true);
});

test("concrete creator ceilings cannot be discarded by requesting prompt mode", (t) => {
  const { runtime, parent } = fixture(t);
  runtime.primaryAgentId = "another-primary";
  parent.definition.permissions = profile(["${workspace}"]);
  assert.throws(() => runtime.assertPermissionCeiling([
    createDefinitionToDynamic(child("worker", undefined, { mode: "prompt" })),
  ], parent), /creator .* effective permission ceiling/);
});

test("prompt creator posture persists through concrete-child recovery under allow-all", async (t) => {
  const { runtime, parent, host, db, configure } = fixture(t);
  runtime.primaryAgentId = "another-primary";
  parent.definition.permissions = { mode: "prompt" };
  const created = await runtime.createAgentForCaller(parent, child("worker", undefined, profile(["${workspace}"])));
  assert.equal(JSON.parse(db.agentRun(created.runId, host).definition).permissionPromptRequired, true);
  await runtime.stopAgent(created.agentId);
  const restarted = configure();
  await restarted.runtime.resumeAgent(created.runId);
  const context = restarted.runtime.agents.get(created.agentId);
  assert.equal(context.permissionPromptRequired, true);
  restarted.runtime.sessionBindingCurrent = () => true;
  const decision = await restarted.runtime.evaluatePermissionRequest(
    context.definition.permissions,
    { agentId: context.agentId, managedSettingsEnabled: false },
    { kind: "read", path: join(host, "file.txt") },
    { sessionId: created.sessionId },
  );
  assert.deepEqual(decision, { kind: "prompt" });
});
