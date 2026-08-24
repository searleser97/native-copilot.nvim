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
    const path = resolve(tmpdir(), `copilot-fleet-db-${process.pid}-${Date.now()}.sqlite`);
    paths.push(path);
    const database = new FleetDatabase(path);
    database.createRun("run-1", "standard", null, "C:\\work");
    database.upsertSession("run-1", "standard", "stable-session", "connected");
    database.finishRun("run-1", "stopped");

    database.createRun("run-2", "standard", null, "C:\\work");
    expect(() =>
      database.upsertSession("run-2", "standard", "stable-session", "connected"),
    ).not.toThrow();
    expect(database.snapshot().sessions).toHaveLength(2);
    database.close();
  });

  it("migrates the original unique-session schema without losing mappings", () => {
    const path = resolve(tmpdir(), `copilot-fleet-db-v1-${process.pid}-${Date.now()}.sqlite`);
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
    database.createRun("run-2", "standard", null, "C:\\work");
    database.upsertSession("run-2", "standard", "stable-session", "connected");
    expect(database.snapshot().sessions).toHaveLength(2);
    const schema = database.db.prepare("SELECT version FROM schema_meta").get() as {
      version: number;
    };
    expect(schema.version).toBe(2);
    database.close();
  });
});
