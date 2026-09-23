import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { AgentDatabase } from "../dist/database.js";
import { CopilotRuntime } from "../dist/runtime.js";

const artifacts = resolve(".e2e-artifacts", "agent-resume-tests");
mkdirSync(artifacts, { recursive: true });

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
