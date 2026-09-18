import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AgentDatabase } from "../dist/database.js";

const artifacts = resolve(".e2e-artifacts", "database-tests");
mkdirSync(artifacts, { recursive: true });

function databasePath(t) {
  const directory = mkdtempSync(join(artifacts, "case-"));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return join(directory, "state.sqlite");
}

function storedDefinition(alias, canTalkToAgentIds = [], canObserveAgentIds = []) {
  return JSON.stringify({
    definition: {
      id: alias,
      displayName: alias === "copilot" ? "Copilot" : alias,
      description: `${alias} description`,
      task: `${alias} task`,
      prompt: `${alias} prompt`,
      canTalkTo: canTalkToAgentIds.map((agentId) => `agent:${agentId}`),
      canObserve: canObserveAgentIds.map((agentId) => `agent:${agentId}`),
    },
    mcpServers: [],
    canTalkToAgentIds,
    canObserveAgentIds,
  });
}

function claimedDefinition(stagedDefinition, alias) {
  if (stagedDefinition === undefined) {
    return storedDefinition(alias);
  }
  const record = JSON.parse(stagedDefinition);
  record.definition.id = alias;
  return JSON.stringify(record);
}

function seedBrokenV13(path) {
  const bootstrap = new AgentDatabase(path, () => false);
  bootstrap.close();
  const db = new DatabaseSync(path);
  const failedAt = "2026-09-01T00:00:00.000Z";
  db.exec(`
    DELETE FROM delivery_leases;
    DELETE FROM messages;
    DELETE FROM agent_sessions;
    DELETE FROM runs;
    UPDATE schema_meta SET version = 13;
  `);
  db.prepare(
    `INSERT INTO runs(
       id, mode, agent_id, alias, definition, standard_can_talk,
       standard_can_observe, is_primary, startup_state, recovery_eligible,
       workspace, status, started_at, ended_at, interruption_reason, owner_pid,
       primary_predecessor_run_id, primary_claim_token
     ) VALUES (
       'primary-failed', 'agent', 'primary-agent', 'copilot', NULL, 0,
       0, 1, 'failed', 0, 'workspace', 'interrupted',
       '2026-08-31T23:00:00.000Z', ?, ?, NULL, NULL, NULL
     )`,
  ).run(failedAt, "Incomplete agent startup found during schema migration");
  db.prepare(
    `INSERT INTO runs(
       id, mode, agent_id, alias, definition, standard_can_talk,
       standard_can_observe, is_primary, startup_state, recovery_eligible,
       workspace, status, started_at, ended_at, interruption_reason, owner_pid,
       primary_predecessor_run_id, primary_claim_token
     ) VALUES (
       'worker-run', 'agent', 'worker-agent', 'copilot', ?, 1,
       1, 0, 'ready', 1, 'workspace', 'interrupted',
       '2026-08-31T22:00:00.000Z', '2026-08-31T22:30:00.000Z', NULL, NULL,
       NULL, NULL
     )`,
  ).run(storedDefinition("copilot"));
  db.prepare(
    `INSERT INTO agent_sessions(run_id, session_id, state, last_active_at)
     VALUES ('worker-run', 'worker-session', 'disconnected', ?)`,
  ).run(failedAt);
  db.prepare(
    `INSERT INTO messages(
       id, run_id, source, target, kind, content, status, sequence, created_at, updated_at
     ) VALUES
       ('migration-mail', 'primary-failed', 'user', 'standard', 'user',
        'restore me', 'failed', 1, '2026-08-31T23:30:00.000Z', ?),
       ('genuine-failure', 'primary-failed', 'user', 'standard', 'user',
        'leave me failed', 'failed', 2, '2026-08-31T23:31:00.000Z',
        '2026-08-31T23:59:00.000Z'),
       ('worker-task', 'worker-run', 'user', 'agent:worker-agent', 'user',
        'worker task', 'delivered', 1, '2026-08-31T22:01:00.000Z',
        '2026-08-31T22:01:00.000Z'),
       ('leased-mail', 'worker-run', 'user', 'agent:worker-agent', 'user',
        'leased', 'delivering', 2, '2026-08-31T22:02:00.000Z',
        '2026-08-31T22:02:00.000Z')`,
  ).run(failedAt);
  db.prepare(
    `INSERT INTO delivery_leases(
       message_id, run_id, target, lease_token, lease_until, attempts, last_error
     ) VALUES (
       'leased-mail', 'worker-run', 'agent:worker-agent', 'lease-token',
       '2099-01-01T00:00:00.000Z', 1, NULL
     )`,
  ).run();
  db.close();
}

test("schema v16 reconstructs a migration-failed primary without Standard rows", (t) => {
  const path = databasePath(t);
  seedBrokenV13(path);

  const db = new AgentDatabase(path, () => false);
  const schema = db.db.prepare("SELECT version FROM schema_meta").get();
  assert.equal(schema.version, 16);

  const primary = db.stagedPrimaryRun("workspace");
  assert.ok(primary);
  assert.equal(primary.id, "primary-failed");
  assert.equal(primary.agentId, "primary-agent");
  assert.equal(primary.alias, "primary");
  const primaryRecord = JSON.parse(primary.definition);
  assert.deepEqual(primaryRecord.canTalkToAgentIds, ["worker-agent"]);
  assert.deepEqual(primaryRecord.canObserveAgentIds, ["worker-agent"]);

  const messages = db.db
    .prepare(
      `SELECT id, status, target FROM messages
       WHERE run_id = 'primary-failed' ORDER BY sequence`,
    )
    .all()
    .map((row) => ({ ...row }));
  assert.deepEqual(messages, [
    {
      id: "migration-mail",
      status: "pending",
      target: "agent:primary-agent",
    },
    {
      id: "genuine-failure",
      status: "failed",
      target: "agent:primary-agent",
    },
  ]);
  const lease = db.db
    .prepare(
      `SELECT lease_token AS leaseToken FROM delivery_leases
       WHERE message_id = 'leased-mail'`,
    )
    .get();
  assert.equal(lease.leaseToken, "lease-token");
  db.close();
});

test("schema v16 separates legacy rules into host-only links", (t) => {
  const path = databasePath(t);
  const original = new AgentDatabase(path, () => false);
  original.createOwnedAgentRun(
    {
      id: "worker-run",
      agentId: "worker-agent",
      alias: "worker",
      definition: storedDefinition("worker"),
      workspace: "workspace",
      ownerPid: 4200,
    },
    "owner-agent",
    "owner-session",
  );
  original.db.exec(`
    DROP TABLE agent_links;
    CREATE TABLE agent_rules (
      agent_id TEXT PRIMARY KEY,
      owner_agent_id TEXT NOT NULL,
      owner_session_id TEXT NOT NULL,
      workspace TEXT NOT NULL,
      configured INTEGER NOT NULL DEFAULT 0,
      permissions_json TEXT,
      mcp_servers_json TEXT NOT NULL DEFAULT '[]',
      can_talk_to_json TEXT NOT NULL DEFAULT '[]',
      can_observe_json TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    INSERT INTO agent_rules(
      agent_id, owner_agent_id, owner_session_id, workspace, configured,
      permissions_json, mcp_servers_json, can_talk_to_json, can_observe_json,
      revision, updated_at
    ) VALUES (
      'worker-agent', 'owner-agent', 'owner-session', 'workspace', 1,
      '{"mode":"inherit"}', '["myworkiq"]', '["peer-agent"]', '["observer-agent"]',
      7, '2026-09-16T00:00:00.000Z'
    );
    UPDATE schema_meta SET version = 15;
  `);
  original.close();

  const migrated = new AgentDatabase(path, () => false);
  assert.equal(migrated.db.prepare("SELECT version FROM schema_meta").get().version, 16);
  assert.deepEqual(migrated.agentAdministration("worker-agent"), {
    agentId: "worker-agent",
    ownerAgentId: "owner-agent",
    ownerSessionId: "owner-session",
    workspace: "workspace",
    canTalkToJson: '["peer-agent"]',
    canObserveJson: '["observer-agent"]',
    revision: 7,
    createdAt: migrated.agentAdministration("worker-agent").createdAt,
    updatedAt: "2026-09-16T00:00:00.000Z",
  });
  const tables = migrated.db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN ('agent_links', 'agent_rules')
       ORDER BY name`,
    )
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables, ["agent_links"]);
  migrated.close();
});

test("staged primary claim and successor creation are atomic and explicit", (t) => {
  const path = databasePath(t);
  seedBrokenV13(path);
  const db = new AgentDatabase(path, (pid) => pid === 4242);

  const claimed = db.claimPrimaryRun(
    "primary-successor",
    randomUUID(),
    "workspace",
    4242,
    claimedDefinition,
  );
  assert.equal(claimed.run.agentId, "primary-agent");
  assert.equal(claimed.run.alias, "primary");
  assert.deepEqual(claimed.claim, {
    predecessorRunId: "primary-failed",
    token: claimed.run.primaryClaimToken,
  });
  assert.throws(
    () =>
      db.claimPrimaryRun(
        "competing-successor",
        randomUUID(),
        "workspace",
        4343,
        claimedDefinition,
      ),
    /already claimed by live host process 4242/,
  );

  db.createAgentRun(
    "unrelated-primary",
    "primary-agent",
    "other_primary",
    storedDefinition("other_primary"),
    "workspace",
    4242,
    true,
  );
  db.upsertSession("primary-successor", "primary-session", "connected");
  db.completePrimaryStartup(
    "primary-successor",
    "workspace",
    "primary-agent",
    "agent:primary-agent",
    claimed.claim,
  );

  const predecessor = db.db
    .prepare(
      `SELECT definition, startup_state AS startupState, primary_claim_token AS claimToken
       FROM runs WHERE id = 'primary-failed'`,
    )
    .get();
  assert.equal(predecessor.definition, null);
  assert.equal(predecessor.startupState, "failed");
  assert.equal(predecessor.claimToken, null);
  const unrelated = db.db
    .prepare("SELECT definition, status FROM runs WHERE id = 'unrelated-primary'")
    .get();
  assert.equal(typeof unrelated.definition, "string");
  assert.equal(unrelated.status, "active");
  db.close();
});

test("fresh primary alias fallback is selected inside the claim transaction", (t) => {
  const path = databasePath(t);
  const db = new AgentDatabase(path, () => false);
  db.createAgentRun(
    "worker-reservation",
    "worker-agent",
    "copilot",
    storedDefinition("copilot"),
    "workspace",
    6161,
  );

  const claimed = db.claimPrimaryRun(
    "fresh-primary",
    "fresh-primary-agent",
    "workspace",
    6262,
    claimedDefinition,
  );
  assert.equal(claimed.run.agentId, "fresh-primary-agent");
  assert.equal(claimed.run.alias, "primary");
  assert.equal(claimed.claim, undefined);
  db.close();
});

test("dead staged-primary claims are retryable or resumable", (t) => {
  const path = databasePath(t);
  seedBrokenV13(path);
  const db = new AgentDatabase(path, () => false);

  const first = db.claimPrimaryRun(
    "sessionless-successor",
    randomUUID(),
    "workspace",
    5151,
    claimedDefinition,
  );
  assert.equal(db.markInterruptedWork("dead host", () => false), 1);
  const failed = db.agentRun("sessionless-successor", "workspace");
  const staged = db.stagedPrimaryRun("workspace");
  assert.ok(failed);
  assert.ok(staged);
  assert.equal(failed.startupState, "failed");
  assert.equal(staged.agentId, "primary-agent");

  const second = db.claimPrimaryRun(
    "session-backed-successor",
    randomUUID(),
    "workspace",
    5252,
    claimedDefinition,
  );
  assert.equal(second.run.agentId, first.run.agentId);
  db.upsertSession(second.run.id, "recovered-primary-session", "connected");
  assert.equal(db.markInterruptedWork("dead host", () => false), 1);

  const resumable = db.resumablePrimaryRun("workspace");
  assert.ok(resumable);
  assert.equal(resumable.id, second.run.id);
  assert.equal(resumable.primaryClaimToken, null);
  assert.equal(resumable.primaryPredecessorRunId, "primary-failed");
  db.close();
});

test("ready primary identity starts a fresh successor conversation", (t) => {
  const path = databasePath(t);
  const db = new AgentDatabase(path, () => false);

  const first = db.claimPrimaryRun(
    "first-primary",
    "durable-primary-agent",
    "workspace",
    7001,
    claimedDefinition,
  );
  db.upsertSession(first.run.id, "previous-primary-session", "connected");
  db.completePrimaryStartup(
    first.run.id,
    "workspace",
    first.run.agentId,
    `agent:${first.run.agentId}`,
    first.claim,
  );
  db.enqueueMessage(
    "pending-primary-mail",
    first.run.id,
    "monitor",
    `agent:${first.run.agentId}`,
    "agent",
    "status update",
  );
  db.finishRun(first.run.id, "interrupted", "Host exited");

  const second = db.claimPrimaryRun(
    "fresh-primary",
    randomUUID(),
    "workspace",
    7002,
    claimedDefinition,
  );
  assert.equal(second.run.agentId, first.run.agentId);
  assert.equal(second.run.alias, first.run.alias);
  assert.deepEqual(second.claim, {
    predecessorRunId: first.run.id,
    token: second.run.primaryClaimToken,
  });
  assert.equal(second.run.session, undefined);

  db.upsertSession(second.run.id, "fresh-primary-session", "connected");
  assert.equal(
    db.completePrimaryStartup(
      second.run.id,
      "workspace",
      second.run.agentId,
      `agent:${second.run.agentId}`,
      second.claim,
    ),
    1,
  );

  const previous = db.agentRun(first.run.id, "workspace");
  const fresh = db.agentRun(second.run.id, "workspace");
  assert.ok(previous);
  assert.ok(fresh);
  assert.equal(previous.status, "stopped");
  assert.equal(previous.startupState, "ready");
  assert.equal(previous.session?.sessionId, "previous-primary-session");
  assert.equal(fresh.status, "active");
  assert.equal(fresh.startupState, "ready");
  assert.equal(fresh.session?.sessionId, "fresh-primary-session");
  assert.deepEqual(db.ownedSessionIds("workspace"), ["fresh-primary-session"]);

  const adopted = db.db
    .prepare(
      `SELECT run_id AS runId, status
       FROM messages WHERE id = 'pending-primary-mail'`,
    )
    .get();
  assert.deepEqual({ ...adopted }, {
    runId: second.run.id,
    status: "pending",
  });
  db.close();
});

test("latest inactive primary is selected while another host is active", (t) => {
  const path = databasePath(t);
  const db = new AgentDatabase(path, (pid) => pid === 7303);

  const createReadyPrimary = (runId, agentId, ownerPid) => {
    db.createAgentRun(
      runId,
      agentId,
      "copilot",
      storedDefinition("copilot"),
      "workspace",
      ownerPid,
      true,
    );
    db.upsertSession(runId, `${runId}-session`, "connected");
    db.completePrimaryStartup(runId, "workspace", agentId, `agent:${agentId}`);
  };

  createReadyPrimary("older-inactive-primary", "older-agent", 7301);
  db.finishRun("older-inactive-primary", "interrupted", "Older host exited");
  createReadyPrimary("latest-inactive-primary", "latest-agent", 7302);
  db.finishRun("latest-inactive-primary", "interrupted", "Latest host exited");
  createReadyPrimary("active-primary", "active-agent", 7303);
  db.db.exec(`
    UPDATE runs SET started_at = '2026-09-18T01:00:00.000Z'
      WHERE id = 'older-inactive-primary';
    UPDATE runs SET started_at = '2026-09-18T02:00:00.000Z'
      WHERE id = 'latest-inactive-primary';
    UPDATE runs SET started_at = '2026-09-18T03:00:00.000Z'
      WHERE id = 'active-primary';
  `);

  const resumable = db.resumablePrimaryRun("workspace");
  assert.ok(resumable);
  assert.equal(resumable.id, "latest-inactive-primary");
  assert.equal(resumable.agentId, "latest-agent");

  const claimed = db.claimPrimaryRun(
    "successor-primary",
    "unused-fresh-agent",
    "workspace",
    7304,
    claimedDefinition,
  );
  assert.equal(claimed.run.agentId, "latest-agent");
  assert.equal(claimed.run.alias, "copilot");
  assert.deepEqual(claimed.claim, {
    predecessorRunId: "latest-inactive-primary",
    token: claimed.run.primaryClaimToken,
  });
  db.close();
});

test("dead claim on a resumable primary releases a sessionless successor", (t) => {
  const path = databasePath(t);
  const db = new AgentDatabase(path, () => false);

  const first = db.claimPrimaryRun(
    "resumable-primary",
    "durable-primary-agent",
    "workspace",
    7101,
    claimedDefinition,
  );
  db.upsertSession(first.run.id, "resumable-primary-session", "connected");
  db.completePrimaryStartup(
    first.run.id,
    "workspace",
    first.run.agentId,
    `agent:${first.run.agentId}`,
    first.claim,
  );
  db.finishRun(first.run.id, "interrupted", "Host exited");

  const second = db.claimPrimaryRun(
    "interrupted-successor",
    randomUUID(),
    "workspace",
    7102,
    claimedDefinition,
  );
  assert.equal(second.run.agentId, first.run.agentId);
  assert.equal(db.markInterruptedWork("dead host", () => false), 1);

  const predecessor = db.agentRun(first.run.id, "workspace");
  const successor = db.agentRun(second.run.id, "workspace");
  assert.ok(predecessor);
  assert.ok(successor);
  assert.equal(predecessor.status, "interrupted");
  assert.equal(predecessor.startupState, "ready");
  assert.equal(predecessor.primaryClaimToken, null);
  assert.equal(predecessor.session?.sessionId, "resumable-primary-session");
  assert.equal(successor.status, "interrupted");
  assert.equal(successor.startupState, "failed");
  assert.equal(successor.definition, null);
  const durable = db.db
    .prepare(
      `SELECT id, recovery_eligible AS recoveryEligible, definition
       FROM runs WHERE id IN (?, ?) ORDER BY id`,
    )
    .all(first.run.id, second.run.id);
  assert.deepEqual(
    durable.map((row) => ({ ...row })),
    [
      {
        id: second.run.id,
        recoveryEligible: 0,
        definition: null,
      },
      {
        id: first.run.id,
        recoveryEligible: 1,
        definition: first.run.definition,
      },
    ].sort((left, right) => left.id.localeCompare(right.id)),
  );
  db.close();
});

test("owned agent links remain controlled by the immutable owner session", (t) => {
  const path = databasePath(t);
  const db = new AgentDatabase(path, () => false);
  const childDefinition = storedDefinition("reviewer");
  db.createOwnedAgentRun(
    {
      id: "reviewer-run",
      agentId: "reviewer-agent",
      alias: "reviewer",
      definition: childDefinition,
      workspace: "workspace",
      ownerPid: 8101,
    },
    "parent-agent",
    "parent-session",
  );
  db.upsertSession("reviewer-run", "reviewer-session", "connected");
  db.completeProvisionedAgentStartup("reviewer-run");

  assert.deepEqual(db.agentAdministration("reviewer-agent"), {
    agentId: "reviewer-agent",
    ownerAgentId: "parent-agent",
    ownerSessionId: "parent-session",
    workspace: "workspace",
    canTalkToJson: "[]",
    canObserveJson: "[]",
    revision: 0,
    createdAt: db.agentAdministration("reviewer-agent").createdAt,
    updatedAt: db.agentAdministration("reviewer-agent").updatedAt,
  });
  assert.throws(
    () =>
      db.updateOwnedAgentLinks({
        subjectAgentId: "reviewer-agent",
        ownerAgentId: "parent-agent",
        ownerSessionId: "different-session",
        workspace: "workspace",
        canTalkToJson: '["parent-agent"]',
        canObserveJson: "[]",
        runUpdates: [],
      }),
    /does not own agent/,
  );

  const configured = db.updateOwnedAgentLinks({
    subjectAgentId: "reviewer-agent",
    ownerAgentId: "parent-agent",
    ownerSessionId: "parent-session",
    workspace: "workspace",
    canTalkToJson: '["parent-agent"]',
    canObserveJson: "[]",
    runUpdates: [
      {
        id: "reviewer-run",
        alias: "reviewer",
        definition: childDefinition,
      },
    ],
  });
  assert.equal(configured.revision, 1);
  assert.equal(configured.ownerSessionId, "parent-session");
  db.close();
});
