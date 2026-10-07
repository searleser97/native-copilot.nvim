import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { AgentDatabase } from "../dist/database.js";
import { CopilotRuntime } from "../dist/runtime.js";

const artifacts = resolve(".e2e-artifacts", "agent-resume-tests");
mkdirSync(artifacts, { recursive: true });

function startupFixture(t) {
  const directory = mkdtempSync(join(artifacts, "startup-"));
  const db = new AgentDatabase(join(directory, "state.sqlite"), () => false);
  const events = [];
  const connections = [];
  const runtime = new CopilotRuntime(directory, db, (type, payload) => {
    events.push({ type, payload });
  });
  runtime.ensureClient = async () => ({
    listSessions: async () => [{ sessionId: "selected-session" }],
    rpc: { sessions: { checkInUse: async () => ({ inUse: [] }) } },
  });
  runtime.sessionConnectionPlan = async () => ({
    config: {},
    configSignature: "startup-test",
    availableMcpServers: new Set(),
  });
  runtime.ensureAgentSession = async () => {
    assert.fail("resuming at startup must never create a throwaway SDK session");
  };
  runtime.connectSession = async (request) => {
    connections.push(request);
    db.upsertSession(request.runId, request.sessionId, "connected");
    return { session: { sessionId: request.sessionId } };
  };
  t.after(() => {
    clearInterval(runtime.recoveryTimer);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { runtime, db, events, connections };
}

test("startup resume connects only the selected SDK session in a fresh workspace", async (t) => {
  const { runtime, db, events, connections } = startupFixture(t);
  await runtime.resumePrimarySession("selected-session");
  assert.equal(connections.length, 1);
  assert.equal(connections[0].sessionId, "selected-session");
  assert.equal(connections[0].resumeExisting, true);
  assert.equal(events.filter((event) => event.type === "primary.ready").length, 1);
  const ready = events.find((event) => event.type === "primary.ready").payload;
  assert.equal(ready.sessionId, "selected-session");
  assert.equal(ready.recovered, true);
  assert.equal(db.agentRun(ready.runId, runtime.workspace).startupState, "ready");
});

test("startup resume rejects locked or missing sessions before claiming a primary", async (t) => {
  const { runtime, connections } = startupFixture(t);
  await assert.rejects(runtime.resumePrimarySession("missing-session"), /not found/);
  runtime.ensureClient = async () => ({
    listSessions: async () => [{ sessionId: "selected-session" }],
    rpc: { sessions: { checkInUse: async () => ({ inUse: ["selected-session"] }) } },
  });
  await assert.rejects(runtime.resumePrimarySession("selected-session"), /active in another process/);
  assert.equal(runtime.primaryAgentId, undefined);
  assert.equal(connections.length, 0);
});

test("failed startup resume leaves no active or recoverable failed primary", async (t) => {
  const { runtime, db, events } = startupFixture(t);
  runtime.connectSession = async (request) => {
    db.upsertSession(request.runId, request.sessionId, "connected");
    throw new Error("resume unavailable");
  };
  await assert.rejects(runtime.resumePrimarySession("selected-session"), /resume unavailable/);
  assert.equal(runtime.primaryAgentId, undefined);
  assert.equal(runtime.agents.size, 0);
  assert.deepEqual(db.reservedAgentAliases(runtime.workspace), []);
  assert.equal(db.resumablePrimaryRun(runtime.workspace), undefined);
  assert.equal(events.some((event) => event.type === "primary.ready"), false);
  assert.equal(events.some((event) => event.type === "agent.error"), true);
});

test("failed startup resume restores a stopped worker's session ownership", async (t) => {
  const { runtime, db, events } = startupFixture(t);
  const definition = JSON.stringify({
    definition: { id: "worker", displayName: "Worker", description: "Worker", task: "Wait" },
    mcpServers: [],
    canTalkToAgentIds: [],
    canObserveAgentIds: [],
  });
  db.createAgentRun("worker-run", "worker-agent", "worker", definition, runtime.workspace, 8104);
  db.upsertSession("worker-run", "selected-session", "connected");
  db.completeProvisionedAgentStartup("worker-run");
  db.finishRun("worker-run", "stopped");
  const owner = db.sessionOwner("selected-session");
  runtime.connectSession = async (request) => {
    db.upsertSession(request.runId, request.sessionId, "connected");
    throw new Error("resume unavailable");
  };

  await assert.rejects(runtime.resumePrimarySession("selected-session"), /resume unavailable/);

  assert.deepEqual(db.sessionOwner("selected-session"), owner);
  assert.equal(runtime.primaryAgentId, undefined);
  assert.deepEqual(db.reservedAgentAliases(runtime.workspace).map((entry) => entry.alias), ["worker"]);
  assert.equal(events.some((event) => event.type === "primary.ready"), false);
});

test("established primary still restores its session when replacement fails", async (t) => {
  const { runtime, db, events, connections } = startupFixture(t);
  await runtime.resumePrimarySession("selected-session");
  const original = events.find((event) => event.type === "primary.ready").payload;
  runtime.ensureClient = async () => ({
    listSessions: async () => [{ sessionId: "replacement-session" }],
    rpc: { sessions: { checkInUse: async () => ({ inUse: [] }) } },
  });
  const connect = runtime.connectSession;
  runtime.connectSession = async (request) => {
    if (request.sessionId === "replacement-session") throw new Error("replacement unavailable");
    return connect(request);
  };

  await assert.rejects(runtime.resumePrimarySession("replacement-session"), /replacement unavailable/);

  assert.equal(connections.length, 2);
  assert.equal(connections[1].sessionId, "selected-session");
  const restored = events.filter((event) => event.type === "primary.ready").at(-1).payload;
  assert.equal(restored.replacementFailed, true);
  assert.equal(restored.runId, original.runId);
  assert.equal(db.agentRun(original.runId, runtime.workspace).status, "active");
});

function fixture(t, availableMcpServers) {
  const directory = mkdtempSync(join(artifacts, "case-"));
  const db = new AgentDatabase(join(directory, "state.sqlite"), () => false);
  const definition = JSON.stringify({
    definition: {
      id: "worker",
      displayName: "Worker",
      description: "Worker agent",
      task: "Wait for work.",
      prompt: "Wait for explicit instructions.",
      permissions: { mode: "inherit" },
      mcpServers: ["old-server"],
      canTalkTo: [],
      canObserve: [],
    },
    mcpServers: ["old-server"],
    canTalkToAgentIds: [],
    canObserveAgentIds: [],
  });
  db.createOwnedAgentRun(
    {
      id: "worker-run",
      agentId: "worker-agent",
      alias: "worker",
      definition,
      workspace: directory,
      ownerPid: 8104,
    },
    "parent-agent",
    "parent-session",
  );
  db.upsertSession("worker-run", "worker-session", "connected");
  db.completeProvisionedAgentStartup("worker-run");
  db.finishRun("worker-run", "interrupted", "Stopped for reconfiguration");

  const runtime = new CopilotRuntime(directory, db, () => {});
  runtime.ensureClient = async () => ({
    rpc: {
      sessions: {
        checkInUse: async () => ({ inUse: [] }),
      },
    },
  });
  runtime.openPrimary = async () => {};
  runtime.availableMcpServers = async () => new Set(availableMcpServers);
  runtime.ensureAgentSession = async () => ({
    session: { sessionId: "worker-session" },
  });

  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { db, runtime, originalDefinition: definition };
}

async function primaryAdoptionFixture(t) {
  const result = startupFixture(t);
  const { runtime, db } = result;
  await runtime.resumePrimarySession("selected-session");
  const caller = runtime.agents.get(runtime.primaryAgentId);
  db.createAgentRun(
    "former-run", "former-agent", "former",
    JSON.stringify({
      definition: {
        id: "former", displayName: "Former main", description: "Former main",
        task: "Wait.", prompt: "Wait.", permissions: { mode: "inherit" },
        canTalkTo: [], canObserve: [],
      },
      mcpServers: [], canTalkToAgentIds: [], canObserveAgentIds: [],
    }),
    runtime.workspace, 8104, true,
  );
  db.upsertSession("former-run", "former-session", "connected");
  db.completeRunStartup("former-run");
  db.finishRun("former-run", "stopped");
  runtime.ensureClient = async () => ({
    listSessions: async () => [{ sessionId: "former-session" }, { sessionId: "unowned-session" }],
    rpc: { sessions: { checkInUse: async () => ({ inUse: [] }) } },
  });
  runtime.availableMcpServers = async () => new Set();
  return {
    ...result, caller,
    resume: (sessionId = "former-session", overrides = {}) =>
      runtime.resumeAgentTool(caller).handler({ sessionId, ...overrides }),
  };
}

test("resume tool adopts an inactive primary conversation without replacing the current primary", async (t) => {
  const { runtime, db, caller, connections, resume } = await primaryAdoptionFixture(t);
  const former = db.agentRun("former-run", runtime.workspace);
  db.createOwnedAgentRun({
    id: "former-child-run", agentId: "former-child", alias: "former_child",
    definition: former.definition, workspace: runtime.workspace, ownerPid: 8104,
  }, former.agentId, "former-session");
  const childBefore = db.agentAdministration("former-child");

  const adopted = await resume();

  assert.equal(adopted.adopted, true);
  assert.equal(adopted.sessionId, "former-session");
  assert.notEqual(adopted.agentId, former.agentId);
  assert.equal(runtime.primaryAgentId, caller.agentId);
  assert.equal(db.session(caller.runId).sessionId, "selected-session");
  assert.equal(connections.length, 2);
  assert.equal(connections[1].sessionId, "former-session");
  assert.equal(connections[1].resumeExisting, true);
  assert.equal(db.sessionOwner("former-session").agentId, adopted.agentId);
  assert.equal(db.agentRun(adopted.runId, runtime.workspace).isPrimary, false);
  assert.equal(db.agentAdministration(adopted.agentId).ownerAgentId, caller.agentId);
  assert.deepEqual(db.agentAdministration("former-child"), childBefore);
  const context = runtime.agents.get(adopted.agentId);
  assert.deepEqual([...context.canTalkTo], []);
  assert.deepEqual([...context.canObserve], []);
  assert.equal(db.agentRun("former-run", runtime.workspace).definition, former.definition);
  await assert.rejects(resume(), /already open in this Neovim instance/);
});

test("resume tool rejects a primary open locally or in another SDK process without transferring ownership", async (t) => {
  const { runtime, db, connections, resume } = await primaryAdoptionFixture(t);
  const owner = db.sessionOwner("former-session");
  await assert.rejects(resume("selected-session"), /already open in this Neovim instance/);
  runtime.ensureClient = async () => ({
    listSessions: async () => [{ sessionId: "former-session" }],
    rpc: { sessions: { checkInUse: async () => ({ inUse: ["former-session"] }) } },
  });
  await assert.rejects(resume(), /already open in another Neovim or Copilot process/);
  assert.deepEqual(db.sessionOwner("former-session"), owner);
  assert.equal(connections.length, 1);
});

test("resume tool rejects a primary with an active database reservation even if SDK reports free", async (t) => {
  const { runtime, db, connections, resume } = await primaryAdoptionFixture(t);
  db.createAgentRun(
    "active-former-run", "former-agent", "former_active",
    db.agentRun("former-run", runtime.workspace).definition,
    runtime.workspace, 8105, true,
  );
  db.upsertSession("active-former-run", "former-session", "connected");
  db.completeRunStartup("active-former-run");
  const owner = db.sessionOwner("former-session");
  await assert.rejects(resume(), /active or no longer eligible/);
  assert.deepEqual(db.sessionOwner("former-session"), owner);
  assert.equal(connections.length, 1);
});

test("failed primary adoption restores ownership and permits retry after partial connection", async (t) => {
  const { runtime, db, caller, resume } = await primaryAdoptionFixture(t);
  const owner = db.sessionOwner("former-session");
  const connect = runtime.connectSession;
  runtime.connectSession = async (request) => {
    db.upsertSession(request.runId, request.sessionId, "connected");
    throw new Error("expected connection failure");
  };
  await assert.rejects(resume(), /expected connection failure/);
  assert.deepEqual(db.sessionOwner("former-session"), owner);
  assert.equal(runtime.agents.size, 1);
  assert.equal(runtime.primaryAgentId, caller.agentId);
  assert.equal(db.agentRunBySession("former-session", runtime.workspace).id, "former-run");
  assert.equal(db.reservedAgentAliases(runtime.workspace).some(row => row.alias.startsWith("session_")), false);
  runtime.connectSession = connect;
  const retried = await resume();
  assert.equal(retried.sessionId, "former-session");
  assert.equal(retried.adopted, true);
});

test("primary adoption keeps MCP and hook approval checks and restores rejected transfers", async (t) => {
  const { db, runtime, resume } = await primaryAdoptionFixture(t);
  const owner = db.sessionOwner("former-session");
  await assert.rejects(resume("former-session", { mcpServers: ["unapproved-server"] }), /unapproved-server/);
  assert.deepEqual(db.sessionOwner("former-session"), owner);
  await assert.rejects(resume("former-session", { enableFileHooks: true }), /approval|allow-all/);
  assert.deepEqual(db.sessionOwner("former-session"), owner);
  assert.equal(runtime.agents.size, 1);
});

test("adopted primary conversation subsequently recovers its new managed identity", async (t) => {
  const { runtime, db, resume } = await primaryAdoptionFixture(t);
  const adopted = await resume();
  db.finishRun(adopted.runId, "stopped");
  runtime.unregisterAgent(runtime.agents.get(adopted.agentId));
  // A transferred conversation can have historical runs with the same timestamp.
  db.db.prepare("UPDATE runs SET started_at = ? WHERE id IN (?, ?)")
    .run("2026-10-07T00:00:00.000Z", "former-run", adopted.runId);
  runtime.openPrimary = async () => {};
  runtime.ensureAgentSession = async (agentId) => ({
    session: { sessionId: db.session(runtime.agents.get(agentId).runId).sessionId },
  });

  const recovered = await resume();

  assert.equal(recovered.adopted, false);
  assert.equal(recovered.agentId, adopted.agentId);
  assert.equal(recovered.sessionId, "former-session");
  assert.equal(db.sessionOwner("former-session").agentId, adopted.agentId);
});

test("concurrent primary adoption requests cannot create two owners", async (t) => {
  const { db, connections, resume } = await primaryAdoptionFixture(t);
  const results = await Promise.allSettled([resume(), resume()]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const adopted = results.find(result => result.status === "fulfilled").value;
  assert.equal(connections.length, 2);
  assert.equal(db.sessionOwner("former-session").agentId, adopted.agentId);
  assert.match(String(results.find(result => result.status === "rejected").reason), /active|already open/);
});

test("primary conversation missing from the workspace remains reserved", async (t) => {
  const { runtime, db, resume, connections } = await primaryAdoptionFixture(t);
  const owner = db.sessionOwner("former-session");
  runtime.ensureClient = async () => ({ listSessions: async () => [] });
  await assert.rejects(resume(), /not found for this workspace/);
  assert.deepEqual(db.sessionOwner("former-session"), owner);
  assert.equal(connections.length, 1);
});

test("ownership restoration cannot introduce duplicate owners after another transfer wins", async (t) => {
  const { runtime, db, resume } = await primaryAdoptionFixture(t);
  const adopted = await resume();
  assert.throws(
    () => db.restoreSessionOwnership("former-session", runtime.workspace, ["former-run"]),
    /multiple agent identities/,
  );
  assert.equal(db.sessionOwner("former-session").agentId, adopted.agentId);
});

test("unowned conversation adoption is unchanged and primary-only release cannot steal managed sessions", async (t) => {
  const { runtime, db, caller, resume } = await primaryAdoptionFixture(t);
  const adopted = await resume("unowned-session");
  assert.equal(adopted.adopted, true);
  assert.equal(adopted.sessionId, "unowned-session");
  db.finishRun(adopted.runId, "stopped");
  const owner = db.sessionOwner("unowned-session");
  assert.throws(() => db.releaseSession("unowned-session", runtime.workspace, true), /no longer eligible/);
  assert.deepEqual(db.sessionOwner("unowned-session"), owner);
  assert.equal(db.agentAdministration(adopted.agentId).ownerAgentId, caller.agentId);
});

const elevatedPermissions = {
  tools: { allow: ["builtin:*"], deny: [] },
  paths: { read: ["${workspace}"], write: ["${workspace}"] },
  commands: true,
  network: true,
  gitWrite: true,
  externalActions: true,
};

const restrictedPermissions = {
  tools: { allow: ["builtin:rg"], deny: ["builtin:powershell"] },
  paths: {
    read: ["${workspace}\\src"],
    write: ["${workspace}\\src"],
  },
  commands: false,
  network: false,
  gitWrite: false,
  externalActions: false,
};

function restrictedCaller(runtime) {
  return {
    agentId: "parent-agent",
    target: "agent:parent-agent",
    alias: "parent",
    runId: "parent-run",
    definition: {
      id: "parent",
      displayName: "Parent",
      description: "Restricted parent",
      task: "Coordinate.",
      prompt: "Coordinate.",
      permissions: restrictedPermissions,
      mcpServers: ["old-server"],
      canTalkTo: [],
      canObserve: [],
    },
    agent: { mcpServers: new Set(["old-server"]) },
    canTalkTo: new Set(),
    canObserve: new Set(),
    mcpServers: new Set(["old-server"]),
  };
}

test("stopped agent resumes the same SDK session with replacement access", async (t) => {
  const { db, runtime } = fixture(t, ["old-server", "new-server"]);

  await runtime.resumeAgent("worker-run", {
    permissions: elevatedPermissions,
    mcpServers: ["new-server"],
  });

  const resumed = db.agentRun("worker-run", runtime.workspace);
  const stored = JSON.parse(resumed.definition);
  assert.equal(resumed.status, "active");
  assert.equal(resumed.agentId, "worker-agent");
  assert.equal(resumed.session.sessionId, "worker-session");
  assert.deepEqual(stored.definition.permissions, elevatedPermissions);
  assert.deepEqual(stored.definition.mcpServers, ["new-server"]);
  assert.deepEqual(new Set(stored.mcpServers), new Set(["old-server", "new-server"]));
  assert.deepEqual(runtime.agents.get("worker-agent").definition, stored.definition);
});

test("invalid MCP escalation leaves a stopped agent unchanged", async (t) => {
  const { db, runtime, originalDefinition } = fixture(t, ["old-server", "new-server"]);

  await assert.rejects(
    runtime.resumeAgent("worker-run", {
      permissions: elevatedPermissions,
      mcpServers: ["missing-server"],
    }),
    /missing-server/,
  );

  const unchanged = db.agentRun("worker-run", runtime.workspace);
  assert.equal(unchanged.status, "interrupted");
  assert.equal(unchanged.definition, originalDefinition);
  assert.equal(runtime.agents.has("worker-agent"), false);
});

test("creator ceilings reject broader managed recovery without mutation", async (t) => {
  const { db, runtime, originalDefinition } = fixture(t, ["old-server", "new-server"]);
  const caller = restrictedCaller(runtime);

  await assert.rejects(
    runtime.resumeAgent("worker-run", {
      permissions: {
        ...restrictedPermissions,
        network: true,
      },
      mcpServers: ["old-server"],
    }, caller),
    /creator .* effective permission ceiling/,
  );
  await assert.rejects(
    runtime.resumeAgent("worker-run", {
      permissions: restrictedPermissions,
      mcpServers: ["new-server"],
    }, caller),
    /new-server/,
  );

  const unchanged = db.agentRun("worker-run", runtime.workspace);
  assert.equal(unchanged.status, "interrupted");
  assert.equal(unchanged.definition, originalDefinition);
  assert.equal(runtime.agents.has("worker-agent"), false);
});

test("creator ceilings allow narrower managed recovery", async (t) => {
  const { db, runtime } = fixture(t, ["old-server", "new-server"]);
  const caller = restrictedCaller(runtime);
  const narrower = {
    ...restrictedPermissions,
    paths: {
      read: ["${workspace}\\src\\nested"],
      write: [],
    },
  };

  await runtime.resumeAgent("worker-run", {
    permissions: narrower,
    mcpServers: ["old-server"],
  }, caller);

  const resumed = db.agentRun("worker-run", runtime.workspace);
  const stored = JSON.parse(resumed.definition);
  assert.equal(resumed.status, "active");
  assert.deepEqual(stored.definition.permissions, narrower);
  assert.deepEqual(stored.definition.mcpServers, ["old-server"]);
  assert.deepEqual(stored.mcpServers, ["old-server"]);
});

test("restricted agents can create only narrower children", async (t) => {
  const directory = mkdtempSync(join(artifacts, "nested-"));
  const db = new AgentDatabase(join(directory, "state.sqlite"), () => false);
  const caller = restrictedCaller({ workspace: directory });
  caller.definition.id = "parent";
  const parentRecord = JSON.stringify({
    definition: caller.definition,
    mcpServers: ["old-server"],
    canTalkToAgentIds: [],
    canObserveAgentIds: [],
  });
  db.createAgentRun(
    caller.runId,
    caller.agentId,
    caller.alias,
    parentRecord,
    directory,
    8200,
    true,
  );
  db.upsertSession(caller.runId, "parent-session", "connected");
  db.completeRunStartup(caller.runId);
  const runtime = new CopilotRuntime(directory, db, () => {});
  runtime.agents.set(caller.agentId, caller);
  runtime.availableMcpServers = async () => new Set(["old-server", "new-server"]);
  runtime.ensureAgentSession = async (agentId) => {
    const child = runtime.agents.get(agentId);
    const sessionId = `${child.alias}-session`;
    db.upsertSession(child.runId, sessionId, "connected");
    return { session: { sessionId } };
  };
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const child = (id, permissions, mcpServers) => ({
    id,
    displayName: id,
    description: `${id} child`,
    prompt: "Wait.",
    permissions,
    mcpServers,
  });

  await assert.rejects(
    runtime.createAgentForCaller(
      caller,
      child("broad_child", { ...restrictedPermissions, commands: true }, ["old-server"]),
    ),
    /creator .* effective permission ceiling/,
  );
  await assert.rejects(
    runtime.createAgentForCaller(
      caller,
      child("mcp_child", restrictedPermissions, ["new-server"]),
    ),
    /new-server/,
  );
  assert.deepEqual(db.ownedRecoverableOrActiveAgentRuns(caller.agentId, directory), []);

  const created = await runtime.createAgentForCaller(
    caller,
    child("narrow_child", {
      ...restrictedPermissions,
      paths: { read: ["${workspace}\\src\\nested"], write: [] },
    }, ["old-server"]),
  );
  assert.equal(created.alias, "narrow_child");
  const stored = db.agentRun(created.runId, directory);
  const record = JSON.parse(stored.definition);
  assert.deepEqual(record.mcpServers, ["old-server"]);
  assert.deepEqual(record.definition.mcpServers, ["old-server"]);
});

test("prompting agents may create stricter prompting children", async (t) => {
  const { runtime } = fixture(t, ["old-server"]);
  const caller = restrictedCaller(runtime);
  caller.definition.permissions = { mode: "prompt" };

  assert.doesNotThrow(() => runtime.assertPermissionCeiling([{
    ...caller.definition,
    id: "strict_child",
    permissions: restrictedPermissions,
  }], caller));
  assert.throws(
    () => runtime.assertPermissionCeiling([{
      ...caller.definition,
      id: "elevated_child",
      permissions: { mode: "approveAll" },
    }], caller),
    /approveAll|non-interactive permissions/,
  );
});

test("links use ordinary durable sessions and resolve stopped targets", async (t) => {
  const directory = mkdtempSync(join(artifacts, "links-"));
  const db = new AgentDatabase(join(directory, "state.sqlite"), () => false);
  const definitionFor = (id) => JSON.stringify({
    definition: {
      id,
      displayName: id,
      description: `${id} agent`,
      task: "Wait.",
      prompt: "Wait.",
      permissions: { mode: "inherit" },
      mcpServers: [],
      canTalkTo: [],
      canObserve: [],
    },
    mcpServers: [],
    canTalkToAgentIds: [],
    canObserveAgentIds: [],
  });
  db.createAgentRun(
    "parent-run",
    "parent-agent",
    "parent",
    definitionFor("parent"),
    directory,
    8201,
    true,
  );
  db.upsertSession("parent-run", "replacement-parent-session", "connected");
  db.completeRunStartup("parent-run");
  for (const [id, session, active] of [
    ["subject", "subject-session", true],
    ["stopped", "stopped-session", false],
  ]) {
    db.createOwnedAgentRun(
      {
        id: `${id}-run`,
        agentId: `${id}-agent`,
        alias: id,
        definition: definitionFor(id),
        workspace: directory,
        ownerPid: 8201,
      },
      "parent-agent",
      "historical-parent-session",
    );
    db.upsertSession(`${id}-run`, session, "connected");
    db.completeProvisionedAgentStartup(`${id}-run`);
    if (!active) {
      db.finishRun(`${id}-run`, "interrupted", "Stopped");
    }
  }

  const runtime = new CopilotRuntime(directory, db, () => {});
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const contextFor = (id, runId) => {
    const definition = JSON.parse(db.agentRun(runId, directory).definition).definition;
    return {
      agentId: `${id}-agent`,
      target: `agent:${id}-agent`,
      alias: id,
      runId,
      definition,
      agent: runtime.resolveStoredDefinition(definition),
      canTalkTo: new Set(),
      canObserve: new Set(),
      mcpServers: new Set(),
    };
  };
  const parent = contextFor("parent", "parent-run");
  const subject = {
    ...contextFor("subject", "subject-run"),
    ownerAgentId: "parent-agent",
    ownerSessionId: "historical-parent-session",
  };
  runtime.agents.set(parent.agentId, parent);
  runtime.agents.set(subject.agentId, subject);

  const childLinks = await runtime.updateOwnedAgentLinks(parent, subject, {
    canTalkToSessionIds: ["stopped-session"],
    canObserveSessionIds: ["stopped-session"],
  });
  assert.deepEqual(childLinks.canTalkToSessionIds, ["stopped-session"]);
  assert.deepEqual(childLinks.canObserveSessionIds, ["stopped-session"]);
  assert.deepEqual(
    JSON.parse(db.agentAdministration("subject-agent").canTalkToJson),
    ["stopped-agent"],
  );
  assert.equal(subject.canTalkTo.has("parent-agent"), false);

  const parentLinks = await runtime.updateOwnedAgentLinks(parent, parent, {
    canTalkToSessionIds: ["subject-session"],
    canObserveSessionIds: [],
  });
  assert.deepEqual(parentLinks.canTalkToSessionIds, ["subject-session"]);
  assert.equal(parent.canTalkTo.has("subject-agent"), true);
  assert.deepEqual(
    JSON.parse(db.agentRun("parent-run", directory).definition).canTalkToAgentIds,
    ["subject-agent"],
  );

});
