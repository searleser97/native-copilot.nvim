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
    expect(schema.version).toBe(3);
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
});
