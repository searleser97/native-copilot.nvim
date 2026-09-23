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
