import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { FleetDatabase } from "../src/database.js";

const paths: string[] = [];

afterEach(() => {
  for (const path of paths.splice(0)) {
    for (const suffix of ["", "-shm", "-wal"]) {
      if (existsSync(path + suffix)) {
        rmSync(path + suffix);
      }
    }
  }
});

describe("FleetDatabase", () => {
  it("maps one stable Copilot session across multiple runs", () => {
    const path = resolve(tmpdir(), `native-copilot-db-${process.pid}-${Date.now()}.sqlite`);
    paths.push(path);
    const database = new FleetDatabase(path);
    database.createRun("run-1", "standard", null, "C:\\work", 1001);
    database.upsertSession("run-1", "standard", "stable-session", "connected");
    database.finishRun("run-1", "stopped");

    database.createRun("run-2", "standard", null, "C:\\work", 1001);
    expect(() =>
      database.upsertSession("run-2", "standard", "stable-session", "connected"),
    ).not.toThrow();
    expect(database.snapshot().sessions).toHaveLength(2);
    database.close();
  });

  it("migrates the original unique-session schema without losing mappings", () => {
    const path = resolve(tmpdir(), `native-copilot-db-v1-${process.pid}-${Date.now()}.sqlite`);
    paths.push(path);
    const original = new DatabaseSync(path);
    original.exec(`
      CREATE TABLE schema_meta (version INTEGER NOT NULL);
      INSERT INTO schema_meta(version) VALUES (1);
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        fleet_id TEXT,
        workspace TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        interruption_reason TEXT
      );
      INSERT INTO runs(id, mode, workspace, status, started_at)
      VALUES ('run-1', 'standard', 'C:\\work', 'stopped', '2026-01-01T00:00:00Z');
      CREATE TABLE member_sessions (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        state TEXT NOT NULL,
        last_active_at TEXT NOT NULL,
        PRIMARY KEY(run_id, member_id),
        UNIQUE(session_id)
      );
      INSERT INTO member_sessions(run_id, member_id, session_id, state, last_active_at)
      VALUES ('run-1', 'standard', 'stable-session', 'disconnected', '2026-01-01T00:00:00Z');
    `);
    original.close();

    const database = new FleetDatabase(path);
    database.createRun("run-2", "standard", null, "C:\\work", 1001);
    database.upsertSession("run-2", "standard", "stable-session", "connected");
    expect(database.snapshot().sessions).toHaveLength(2);
    const schema = database.db.prepare("SELECT version FROM schema_meta").get() as {
      version: number;
    };
    expect(schema.version).toBe(5);
    database.close();
  });

  it("only interrupts runs whose owning Neovim host is gone", () => {
    const path = resolve(tmpdir(), `native-copilot-db-owner-${process.pid}-${Date.now()}.sqlite`);
    paths.push(path);
    const database = new FleetDatabase(path);
    database.createRun("live-run", "fleet", "engineering", "C:\\work", 1001);
    database.createRun("stale-run", "fleet", "engineering", "C:\\work", 1002);

    expect(database.markInterruptedWork("host exited", (pid) => pid === 1001)).toBe(1);
    const runs = database.snapshot().runs as Array<{ id: string; status: string }>;
    expect(runs.find((run) => run.id === "live-run")?.status).toBe("active");
    expect(runs.find((run) => run.id === "stale-run")?.status).toBe("interrupted");
    database.close();
  });

  it("lists and reclaims inactive Fleet sessions without exposing active runs", () => {
    const path = resolve(tmpdir(), `native-copilot-db-resume-${process.pid}-${Date.now()}.sqlite`);
    paths.push(path);
    const database = new FleetDatabase(path);
    database.createRun("inactive-run", "fleet", "engineering", "C:\\work", 1001);
    database.upsertSession("inactive-run", "planner", "planner-session", "disconnected");
    expect(database.hasConversationActivity("inactive-run", "planner")).toBe(false);
    database.finishRun("inactive-run", "stopped");
    database.createRun("active-run", "fleet", "engineering", "C:\\work", 1002);
    database.upsertSession("active-run", "planner", "other-session", "connected");

    const runs = database.resumableFleetRuns("C:\\work");
    expect(runs.map((run) => run.id)).toEqual(["inactive-run"]);
    expect(runs[0]?.sessions[0]?.sessionId).toBe("planner-session");

    database.resumeRun("inactive-run", 2001);
    expect(database.fleetRun("inactive-run", "C:\\work")?.status).toBe("active");
    expect(database.resumableFleetRuns("C:\\work")).toEqual([]);
    database.close();
  });

  it("persists generated fleet definitions for recovery", () => {
    const path = resolve(tmpdir(), `native-copilot-db-definition-${process.pid}-${Date.now()}.sqlite`);
    paths.push(path);
    const database = new FleetDatabase(path);
    const definition = JSON.stringify({
      definition: { id: "generated", agents: [] },
      mcpServers: ["myado"],
    });
    database.createRun("run", "fleet", "generated", "C:\\work", 1001, definition);
    database.finishRun("run", "stopped");

    expect(database.fleetRun("run", "C:\\work")?.fleetDefinition).toBe(definition);
    database.close();
  });

  it("updates the persisted fleet definition after a runtime mutation", () => {
    const path = resolve(tmpdir(), `native-copilot-db-mutate-${process.pid}-${Date.now()}.sqlite`);
    paths.push(path);
    const database = new FleetDatabase(path);
    const original = JSON.stringify({
      definition: { id: "generated", agents: [{ id: "planner" }] },
      mcpServers: [],
    });
    database.createRun("run", "fleet", "generated", "C:\\work", 1001, original);

    const mutated = JSON.stringify({
      definition: { id: "generated", agents: [{ id: "planner" }, { id: "reviewer" }] },
      mcpServers: ["myado"],
    });
    database.updateFleetDefinition("run", mutated);
    expect(database.fleetRun("run", "C:\\work")?.fleetDefinition).toBe(mutated);

    expect(() => database.updateFleetDefinition("missing-run", mutated)).toThrow();
    database.close();
  });

  it("atomically persists both definitions and moves a session when moving an agent", () => {
    const path = resolve(tmpdir(), `native-copilot-db-move-${process.pid}-${Date.now()}.sqlite`);
    paths.push(path);
    const database = new FleetDatabase(path);
    const sourceBefore = JSON.stringify({
      definition: { id: "fleet_a", agents: [{ id: "planner" }, { id: "dev" }] },
      mcpServers: [],
    });
    const destinationBefore = JSON.stringify({
      definition: { id: "fleet_b", agents: [{ id: "host" }] },
      mcpServers: [],
    });
    database.createRun("source-run", "fleet", "fleet_a", "C:\\work", 1001, sourceBefore);
    database.createRun("dest-run", "fleet", "fleet_b", "C:\\work", 1001, destinationBefore);
    database.upsertSession("source-run", "dev", "dev-session", "connected");

    const sourceAfter = JSON.stringify({
      definition: { id: "fleet_a", agents: [{ id: "planner" }] },
      mcpServers: [],
    });
    const destinationAfter = JSON.stringify({
      definition: { id: "fleet_b", agents: [{ id: "host" }, { id: "dev" }] },
      mcpServers: [],
    });
    database.updateFleetDefinitions([
      { runId: "source-run", fleetDefinition: sourceAfter },
      { runId: "dest-run", fleetDefinition: destinationAfter },
    ]);
    expect(database.fleetRun("source-run", "C:\\work")?.fleetDefinition).toBe(sourceAfter);
    expect(database.fleetRun("dest-run", "C:\\work")?.fleetDefinition).toBe(destinationAfter);

    // The moved session record is reassociated to the destination run intact.
    database.reassociateSession("source-run", "dest-run", "dev", "dev-session", "connected");
    expect(database.fleetRun("source-run", "C:\\work")?.sessions).toEqual([]);
    const destSessions = database.fleetRun("dest-run", "C:\\work")?.sessions ?? [];
    expect(destSessions.map((session) => session.sessionId)).toEqual(["dev-session"]);
    database.close();
  });

  it("rolls back an atomic multi-run definition update when one run is missing", () => {
    const path = resolve(tmpdir(), `native-copilot-db-atomic-${process.pid}-${Date.now()}.sqlite`);
    paths.push(path);
    const database = new FleetDatabase(path);
    const original = JSON.stringify({ definition: { id: "fleet_a", agents: [] }, mcpServers: [] });
    database.createRun("present-run", "fleet", "fleet_a", "C:\\work", 1001, original);

    const attempted = JSON.stringify({
      definition: { id: "fleet_a", agents: [{ id: "planner" }] },
      mcpServers: [],
    });
    expect(() =>
      database.updateFleetDefinitions([
        { runId: "present-run", fleetDefinition: attempted },
        { runId: "missing-run", fleetDefinition: attempted },
      ]),
    ).toThrow();
    // The transaction rolls back, so the present run keeps its original definition.
    expect(database.fleetRun("present-run", "C:\\work")?.fleetDefinition).toBe(original);
    database.close();
  });

  it("deletes a single member session record", () => {
    const path = resolve(tmpdir(), `native-copilot-db-del-${process.pid}-${Date.now()}.sqlite`);
    paths.push(path);
    const database = new FleetDatabase(path);
    database.createRun("run", "fleet", "fleet_a", "C:\\work", 1001);
    database.upsertSession("run", "dev", "dev-session", "connected");
    database.upsertSession("run", "planner", "planner-session", "connected");

    database.deleteSession("run", "dev");
    const sessions = database.fleetRun("run", "C:\\work")?.sessions ?? [];
    expect(sessions.map((session) => session.memberId)).toEqual(["planner"]);
    database.close();
  });

  it("keeps mailbox claims scoped to one recovered Fleet run", () => {
    const path = resolve(tmpdir(), `native-copilot-db-mail-${process.pid}-${Date.now()}.sqlite`);
    paths.push(path);
    const database = new FleetDatabase(path);
    database.createRun("older-run", "fleet", "engineering", "C:\\work", 1001);
    database.createRun("current-run", "fleet", "engineering", "C:\\work", 1001);
    database.enqueueMessage("old-message", "older-run", "planner", "reviewer", "agent", "old");
    database.enqueueMessage("new-message", "current-run", "planner", "reviewer", "agent", "new");

    expect(database.claimMessages("current-run", "reviewer").map((message) => message.id)).toEqual([
      "new-message",
    ]);
    expect(database.hasConversationActivity("current-run", "reviewer")).toBe(true);
    database.close();
  });

  it("settles in-flight moved mail while preserving delivered history, then restores it", () => {
    const path = resolve(tmpdir(), `native-copilot-db-settle-${process.pid}-${Date.now()}.sqlite`);
    paths.push(path);
    const database = new FleetDatabase(path);
    database.createRun("run-a", "fleet", "fleet_a", "C:\\work", 1001);
    // A delivered message (history that must be preserved).
    database.enqueueMessage("delivered", "run-a", "planner", "tester", "agent", "done");
    database.completeMessage("delivered");
    // Enqueue then claim one message so it is 'delivering'.
    database.enqueueMessage("claimed", "run-a", "planner", "tester", "agent", "in flight");
    database.claimMessages("run-a", "tester");
    // Enqueue a second message afterwards so it stays 'pending' (unclaimed).
    database.enqueueMessage("pending", "run-a", "planner", "tester", "agent", "queued");
    // A message addressed to a different member must be untouched.
    database.enqueueMessage("other", "run-a", "planner", "dev", "agent", "for dev");

    const settled = database.settleMovedMessages("run-a", "tester", "moved to fleet_b");
    expect(settled.map((entry) => entry.id).sort()).toEqual(["claimed", "pending"]);
    expect(settled.find((entry) => entry.id === "claimed")?.previousStatus).toBe("delivering");
    expect(settled.find((entry) => entry.id === "pending")?.previousStatus).toBe("pending");

    const byId = (id: string) => database.snapshot().messages.find((message) => message.id === id);
    expect(byId("pending")?.status).toBe("settled");
    expect(byId("claimed")?.status).toBe("settled");
    // A delivery that completes or fails after the move must not overwrite the
    // terminal settlement established by settleMovedMessages.
    database.completeMessage("claimed");
    database.failMessage("pending", "late delivery failure", true);
    expect(byId("claimed")?.status).toBe("settled");
    expect(byId("pending")?.status).toBe("settled");
    // Delivered history and other-target mail are preserved.
    expect(byId("delivered")?.status).toBe("delivered");
    expect(byId("other")?.status).toBe("pending");
    // Settled messages are no longer claimable.
    expect(database.claimMessages("run-a", "tester")).toEqual([]);

    // Restoring returns them to a safely redeliverable pending state.
    database.restoreMovedMessages(settled);
    expect(byId("pending")?.status).toBe("pending");
    expect(byId("claimed")?.status).toBe("pending");
    expect(database.claimMessages("run-a", "tester").map((message) => message.id).sort()).toEqual([
      "claimed",
      "pending",
    ]);
    database.close();
  });

  it("migrates a version 4 message table to the settled-capable schema without losing rows", () => {
    const path = resolve(tmpdir(), `native-copilot-db-v4-${process.pid}-${Date.now()}.sqlite`);
    paths.push(path);
    const original = new DatabaseSync(path);
    original.exec(`
      CREATE TABLE schema_meta (version INTEGER NOT NULL);
      INSERT INTO schema_meta(version) VALUES (4);
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        fleet_id TEXT,
        fleet_definition TEXT,
        workspace TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        interruption_reason TEXT,
        owner_pid INTEGER
      );
      INSERT INTO runs(id, mode, fleet_id, workspace, status, started_at, owner_pid)
      VALUES ('run-a', 'fleet', 'fleet_a', 'C:\\work', 'active', '2026-01-01T00:00:00Z', 1001);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('user', 'agent', 'system')),
        content TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'delivering', 'delivered', 'failed')),
        sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, target, sequence)
      );
      INSERT INTO messages(id, run_id, source, target, kind, content, status, sequence, created_at, updated_at)
      VALUES ('legacy', 'run-a', 'planner', 'tester', 'agent', 'legacy body', 'pending', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      CREATE TABLE delivery_leases (
        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        target TEXT NOT NULL,
        lease_until TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
    `);
    original.close();

    const database = new FleetDatabase(path);
    const schema = database.db.prepare("SELECT version FROM schema_meta").get() as {
      version: number;
    };
    expect(schema.version).toBe(5);
    // The legacy message survived the table rebuild.
    const legacy = database.snapshot().messages.find((message) => message.id === "legacy");
    expect(legacy?.status).toBe("pending");
    // The new settled status now works against the migrated table.
    const settled = database.settleMovedMessages("run-a", "tester", "moved");
    expect(settled.map((entry) => entry.id)).toEqual(["legacy"]);
    expect(
      database.snapshot().messages.find((message) => message.id === "legacy")?.status,
    ).toBe("settled");
    database.close();
  });
});
