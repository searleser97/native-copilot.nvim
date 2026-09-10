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

test("schema v14 reconstructs a migration-failed primary without Standard rows", (t) => {
  const path = databasePath(t);
  seedBrokenV13(path);

  const db = new AgentDatabase(path, () => false);
  const schema = db.db.prepare("SELECT version FROM schema_meta").get();
  assert.equal(schema.version, 14);

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
