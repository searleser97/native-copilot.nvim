import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { AgentDatabase } from "../dist/database.js";
import { agentCreateSchema, createDefinitionToDynamic } from "../dist/config.js";
import { CopilotRuntime, permissionDecision } from "../dist/runtime.js";

const artifacts = resolve(".e2e-artifacts", "agent-directory-tests");
mkdirSync(artifacts, { recursive: true });

function fixture(t, { allowAll = true, approveFileHooks = false } = {}) {
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
  const configure = (fileHookDirectories = approveFileHooks ? [target, host] : []) => {
    const runtime = new CopilotRuntime(host, db, () => {}, undefined, fileHookDirectories);
    t.after(() => clearInterval(runtime.recoveryTimer));
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
    runtime.availableMcpServers = async () => new Set(["approved", "builtin-only", "github-mcp-server"]);
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
  assert.equal(configs[0].enableFileHooks, undefined);
  assert.deepEqual(discoveries, []);
});

test("file-hook API accepts the exact flag and rejects renamed or nonboolean inputs", () => {
  const definition = { ...child("worker"), enableFileHooks: true };
  assert.equal(createDefinitionToDynamic(agentCreateSchema.parse(definition)).enableFileHooks, true);
  assert.throws(() => agentCreateSchema.parse({ ...child("worker"), enableRepositoryHooks: true }));
  assert.throws(() => agentCreateSchema.parse({ ...child("worker"), enableFileHooks: "true" }));
});

test("file hooks require distinct exact-directory host approval before reserving state", async (t) => {
  const { runtime, parent, target, host, db, configure } = fixture(t);
  const request = { ...child("worker", target), enableFileHooks: true };
  await assert.rejects(runtime.createAgentForCaller(parent, request), /explicit host approval/);
  assert.deepEqual(db.ownedRecoverableOrActiveAgentRuns(parent.agentId, host), []);
  const wrongApproval = configure([host]);
  await assert.rejects(wrongApproval.runtime.createAgentForCaller(wrongApproval.parent, request), /explicit host approval/);
  const approved = configure([target]);
  const nested = join(target, "nested");
  mkdirSync(nested);
  await assert.rejects(
    approved.runtime.createAgentForCaller(approved.parent, { ...request, workingDirectory: nested }),
    /explicit host approval/,
  );
});

test("approved hooks persist while configuration discovery and MCP isolation remain unchanged", async (t) => {
  const { runtime, parent, target, host, db, configs, configure } = fixture(t, { approveFileHooks: true });
  const created = await runtime.createAgentTool(parent).handler({ ...child("worker", target), enableFileHooks: true });
  const context = runtime.agents.get(created.agentId);
  const signature = runtime.sessionSignature(context, new Set(["approved"]));
  assert.equal(created.enableFileHooks, true);
  assert.equal(configs[0].enableFileHooks, true);
  assert.equal(configs[0].enableConfigDiscovery, false);
  assert.deepEqual(Object.keys(configs[0].mcpServers), ["approved"]);
  assert.equal(configs[0].mcpServers.approved.workingDirectory, host);
  assert.ok(configs[0].disabledMcpServers.includes("target-only"));
  assert.equal(JSON.parse(db.agentRun(created.runId, host).definition).definition.enableFileHooks, true);
  await runtime.stopAgent(created.agentId);
  const restarted = configure();
  await restarted.runtime.resumeAgent(created.runId, {}, restarted.parent);
  const recovered = restarted.runtime.agents.get(created.agentId);
  assert.equal(configs.at(-1).enableFileHooks, true);
  assert.equal(restarted.runtime.sessionSignature(recovered, new Set(["approved"])), signature);
  await restarted.runtime.stopAgent(created.agentId);
  await restarted.runtime.resumeAgent(created.runId, { enableFileHooks: false }, restarted.parent);
  assert.equal(configs.at(-1).enableFileHooks, false);
  assert.notEqual(restarted.runtime.sessionSignature(restarted.runtime.agents.get(created.agentId), new Set(["approved"])), signature);
  await restarted.runtime.stopAgent(created.agentId);
  await restarted.runtime.resumeAgent(created.runId, {}, restarted.parent);
  assert.equal(configs.at(-1).enableFileHooks, false);
});

test("public resume enables a previously unapproved stopped agent without changing its session ID", async (t) => {
  const { runtime, parent, target, configs } = fixture(t, { approveFileHooks: true });
  const created = await runtime.createAgentForCaller(parent, child("worker", target));
  assert.equal(configs.at(-1).enableFileHooks, false);
  await runtime.stopAgent(created.agentId);
  const result = await runtime.resumeAgentTool(parent).handler({
    sessionId: created.sessionId, enableFileHooks: true,
  });
  assert.equal(result.reconfigured, true);
  assert.equal(result.sessionId, created.sessionId);
  assert.equal(result.enableFileHooks, true);
  assert.equal(configs.at(-1).enableFileHooks, true);
});

test("explicit false disables same-directory hooks without requiring trust; approved true pins host cwd", async (t) => {
  const { runtime, parent, host, configs, configure } = fixture(t);
  await runtime.createAgentForCaller(parent, { ...child("disabled"), enableFileHooks: false });
  assert.equal(configs.at(-1).enableFileHooks, false);
  assert.equal(configs.at(-1).enableConfigDiscovery, true);
  const approved = configure([host]);
  const created = await approved.runtime.createAgentForCaller(approved.parent, { ...child("enabled"), enableFileHooks: true });
  assert.equal(approved.runtime.agents.get(created.agentId).definition.workingDirectory, host);
  assert.equal(configs.at(-1).enableFileHooks, true);
});

test("hook approval cannot bypass host or concrete/interactive execution ceilings", async (t) => {
  const { runtime, parent, target, host } = fixture(t, { approveFileHooks: true });
  for (const permissions of [{ mode: "prompt" }, profile([target, host])]) {
    await assert.rejects(runtime.createAgentForCaller(parent, {
      ...child("worker", target, permissions), enableFileHooks: true,
    }), /unrestricted, non-prompting/);
  }
  runtime.policy.allowAll = false;
  await assert.rejects(runtime.createAgentForCaller(parent, {
    ...child("worker", host), enableFileHooks: true,
  }), /host --allow-all/);
  runtime.policy.allowAll = true;
  parent.permissionPromptRequired = true;
  await assert.rejects(runtime.createAgentForCaller(parent, {
    ...child("worker", target), enableFileHooks: true,
  }), /unrestricted, non-prompting/);
});

test("delegated creators need hook authority for the same directory even when host-approved", async (t) => {
  const { runtime, parent, target, host } = fixture(t, { approveFileHooks: true });
  const worker = await runtime.createAgentForCaller(parent, child("worker", target));
  const creator = runtime.agents.get(worker.agentId);
  const request = { ...child("grandchild", target), enableFileHooks: true };
  await assert.rejects(runtime.createAgentForCaller(creator, request), /creator's approved directory/);
  await runtime.stopAgent(worker.agentId);
  await runtime.resumeAgent(worker.runId, { enableFileHooks: true }, parent);
  const approvedCreator = runtime.agents.get(worker.agentId);
  await assert.rejects(runtime.createAgentForCaller(approvedCreator, {
    ...request, workingDirectory: host,
  }), /creator's approved directory/);
  const grandchild = await runtime.createAgentForCaller(approvedCreator, request);
  await runtime.stopAgent(grandchild.agentId);
  await runtime.stopAgent(worker.agentId);
  await runtime.resumeAgent(worker.runId, { enableFileHooks: false }, parent);
  await assert.rejects(runtime.resumeAgent(grandchild.runId), /creator's approved directory/);
});

test("revoked host trust blocks recovery unchanged, while explicit false permits recovery", async (t) => {
  const { runtime, parent, target, host, db, configure, configs } = fixture(t, { approveFileHooks: true });
  const created = await runtime.createAgentForCaller(parent, { ...child("worker", target), enableFileHooks: true });
  await runtime.stopAgent(created.agentId);
  const before = db.agentRun(created.runId, host).definition;
  const revoked = configure([]);
  await assert.rejects(revoked.runtime.resumeAgent(created.runId, {}, revoked.parent), /explicit host approval/);
  assert.equal(db.agentRun(created.runId, host).definition, before);
  assert.equal(db.agentRun(created.runId, host).status, "stopped");
  await revoked.runtime.resumeAgent(created.runId, { enableFileHooks: false }, revoked.parent);
  assert.equal(configs.at(-1).enableFileHooks, false);
});

test("redirecting a host approval junction cannot authorize either target on reconnect", async (t) => {
  const { directory, host, target, configure } = fixture(t);
  const link = join(directory, "approved-link");
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  const { runtime, parent } = configure([link]);
  const created = await runtime.createAgentForCaller(parent, {
    ...child("worker", target), enableFileHooks: true,
  });
  const context = runtime.agents.get(created.agentId);
  rmdirSync(link);
  symlinkSync(host, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(runtime.sessionConnectionPlan(context), /explicit host approval/);
  await assert.rejects(runtime.createAgentForCaller(parent, {
    ...child("other", host), enableFileHooks: true,
  }), /explicit host approval/);
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
  await assert.rejects(
    runtime.createAgentForCaller(parent, child("github", target, undefined, ["github-mcp-server"])),
    /github-mcp-server.*no verifiable launch configuration.*additional-mcp-config.*omit this server/,
  );
});

test("pinning preserves opaque server inputs and fingerprints ignore object key order", async (t) => {
  const { runtime, parent, target, host, db, configs } = fixture(t);
  const args = ["relative-server.js", "--opaque=../relative-data"];
  const env = { PRIVATE_VALUE: "test-secret", RELATIVE_VALUE: "../env-path" };
  runtime.policy.mcpServers.approved = {
    type: "stdio", command: ".\\bin\\server.exe", args, env, cwd: ".",
  };
  const created = await runtime.createAgentForCaller(parent, child("worker", target));
  assert.equal(configs[0].mcpServers.approved.command, ".\\bin\\server.exe");
  assert.deepEqual(configs[0].mcpServers.approved.args, args);
  assert.deepEqual(configs[0].mcpServers.approved.env, env);
  assert.equal(configs[0].mcpServers.approved.workingDirectory, host);
  const before = db.agentRun(created.runId, host).definition;
  assert.equal(before.includes("test-secret"), false);
  await runtime.stopAgent(created.agentId);
  runtime.policy.mcpServers.approved = {
    cwd: ".", env: { RELATIVE_VALUE: "../env-path", PRIVATE_VALUE: "test-secret" },
    args, command: ".\\bin\\server.exe", type: "stdio",
  };
  await runtime.resumeAgent(created.runId, {}, parent);
  assert.equal(db.agentRun(created.runId, host).definition, before);
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

test("discovery failure is actionable, redacted, and leaves creation and recovery unchanged", async (t) => {
  const { runtime, parent, target, host, db } = fixture(t);
  const created = await runtime.createAgentForCaller(parent, child("worker", target));
  await runtime.stopAgent(created.agentId);
  const before = db.agentRun(created.runId, host);
  const originalClient = await runtime.ensureClient();
  runtime.ensureClient = async () => ({
    ...originalClient,
    rpc: {
      ...originalClient.rpc,
      mcp: { discover: async () => { throw new Error("invalid config: secret-token"); } },
    },
  });
  const expectedError = (error) => {
    assert.match(error.message, /MCP discovery failed.*No agent state was changed.*then retry/);
    assert.equal(error.message.includes("secret-token"), false);
    assert.equal(error.cause, undefined);
    return true;
  };
  await assert.rejects(runtime.createAgentForCaller(parent, child("new_worker", target)), expectedError);
  await assert.rejects(runtime.resumeAgent(created.runId, {}, parent), expectedError);
  assert.equal(db.agentRun(created.runId, host).definition, before.definition);
  assert.equal(db.agentRun(created.runId, host).status, "stopped");
  assert.equal(db.ownedRecoverableOrActiveAgentRuns(parent.agentId, host).length, 1);
  assert.equal(runtime.aliasIndex.has("new_worker"), false);
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

test("recovered concrete grandchildren wait for interactive approval under an allow-all host", async (t) => {
  const { runtime, parent, host, db, configure } = fixture(t);
  runtime.primaryAgentId = "another-primary";
  parent.definition.permissions = { mode: "prompt" };
  const created = await runtime.createAgentForCaller(
    parent, child("worker", undefined, profile(["${workspace}"])),
  );
  const worker = runtime.agents.get(created.agentId);
  const grandchild = await runtime.createAgentForCaller(
    worker, child("grandchild", undefined, profile(["${workspace}"])),
  );
  assert.equal(JSON.parse(db.agentRun(grandchild.runId, host).definition).permissionPromptRequired, true);
  await runtime.stopAgent(grandchild.agentId);
  const restarted = configure();
  await restarted.runtime.resumeAgent(grandchild.runId);
  const context = restarted.runtime.agents.get(grandchild.agentId);
  restarted.runtime.sessionBindingCurrent = () => true;
  const handler = restarted.runtime.permissionHandler(context.definition.permissions, {
    agentId: context.agentId, runId: context.runId, target: context.target, managedSettingsEnabled: false,
  });
  const pending = handler(
    { kind: "read", path: join(host, "file.txt") }, { sessionId: grandchild.sessionId },
  );
  await new Promise(resolve => setImmediate(resolve));
  const requestIds = [...restarted.runtime.pendingPermissions.keys()];
  assert.equal(requestIds.length, 1);
  assert.equal(restarted.runtime.respondPermission(requestIds[0], true), true);
  assert.deepEqual(await pending, { kind: "approve-once", approvedInteractively: true });
  assert.equal(restarted.runtime.pendingPermissions.size, 0);
});
