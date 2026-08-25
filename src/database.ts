import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type RunMode = "standard" | "fleet";
export type RunStatus = "active" | "stopped" | "interrupted";
export type MessageStatus = "pending" | "delivering" | "delivered" | "failed";

export interface StoredMessage {
  id: string;
  runId: string;
  source: string;
  target: string;
  kind: "user" | "agent" | "system";
  content: string;
  status: MessageStatus;
  sequence: number;
  createdAt: string;
  updatedAt: string;
}

export interface StateSnapshot {
  runs: Array<Record<string, unknown>>;
  sessions: Array<Record<string, unknown>>;
  messages: StoredMessage[];
  events: Array<Record<string, unknown>>;
}

export interface StoredFleetRun {
  id: string;
  fleetId: string;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  sessions: Array<{ memberId: string; sessionId: string; state: string; lastActiveAt: string }>;
}

function now(): string {
  return new Date().toISOString();
}

export class FleetDatabase {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS schema_meta (
        version INTEGER NOT NULL
      );
      INSERT INTO schema_meta(version)
      SELECT 3
      WHERE NOT EXISTS (SELECT 1 FROM schema_meta);

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK(mode IN ('standard', 'fleet')),
        fleet_id TEXT,
        workspace TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'stopped', 'interrupted')),
        started_at TEXT NOT NULL,
        ended_at TEXT,
        interruption_reason TEXT,
        owner_pid INTEGER
      );

      CREATE TABLE IF NOT EXISTS member_sessions (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        state TEXT NOT NULL,
        last_active_at TEXT NOT NULL,
        PRIMARY KEY(run_id, member_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
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

      CREATE TABLE IF NOT EXISTS delivery_leases (
        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        target TEXT NOT NULL,
        lease_until TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
        member_id TEXT,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        sequence INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_run_member_idx
      ON events(run_id, member_id, created_at);

      CREATE TABLE IF NOT EXISTS checkpoints (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL,
        last_event_sequence INTEGER NOT NULL DEFAULT 0,
        unread_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(run_id, member_id)
      );
    `);
    const schema = this.db.prepare("SELECT version FROM schema_meta LIMIT 1").get() as {
      version: number;
    };
    if (schema.version < 2) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE member_sessions_v2 (
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          member_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          state TEXT NOT NULL,
          last_active_at TEXT NOT NULL,
          PRIMARY KEY(run_id, member_id)
        );
        INSERT INTO member_sessions_v2(run_id, member_id, session_id, state, last_active_at)
        SELECT run_id, member_id, session_id, state, last_active_at
        FROM member_sessions;
        DROP TABLE member_sessions;
        ALTER TABLE member_sessions_v2 RENAME TO member_sessions;
        UPDATE schema_meta SET version = 2;
        COMMIT;
      `);
    }
    if (schema.version < 3) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE runs ADD COLUMN owner_pid INTEGER;
        UPDATE schema_meta SET version = 3;
        COMMIT;
      `);
    }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markInterruptedWork(reason: string, ownerIsAlive: (pid: number) => boolean): number {
    const timestamp = now();
    const active = this.db
      .prepare("SELECT id, owner_pid AS ownerPid FROM runs WHERE status = 'active'")
      .all() as unknown as Array<{ id: string; ownerPid: number | null }>;
    const staleIds = active
      .filter((run) => run.ownerPid === null || !ownerIsAlive(run.ownerPid))
      .map((run) => run.id);
    const interrupt = this.db.prepare(
      `UPDATE runs
       SET status = 'interrupted', ended_at = ?, interruption_reason = ?
       WHERE id = ? AND status = 'active'`,
    );
    for (const id of staleIds) {
      interrupt.run(timestamp, reason, id);
    }
    if (staleIds.length === 0) {
      return 0;
    }
    const placeholders = staleIds.map(() => "?").join(", ");
    this.db
      .prepare(
        `UPDATE messages
         SET status = 'pending', updated_at = ?
         WHERE status = 'delivering'
           AND run_id IN (${placeholders})`,
      )
      .run(timestamp, ...staleIds);
    this.db
      .prepare(
      `DELETE FROM delivery_leases
       WHERE message_id IN (SELECT id FROM messages WHERE run_id IN (${placeholders}))`,
      )
      .run(...staleIds);
    return staleIds.length;
  }

  createRun(
    id: string,
    mode: RunMode,
    fleetId: string | null,
    workspace: string,
    ownerPid: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO runs(id, mode, fleet_id, workspace, status, started_at, owner_pid)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(id, mode, fleetId, workspace, now(), ownerPid);
  }

  resumableFleetRuns(workspace: string, limit = 20): StoredFleetRun[] {
    const runs = this.db
      .prepare(
        `SELECT id, fleet_id AS fleetId, status, started_at AS startedAt, ended_at AS endedAt
         FROM runs
         WHERE mode = 'fleet' AND workspace = ? AND fleet_id IS NOT NULL
           AND status != 'active'
           AND EXISTS (SELECT 1 FROM member_sessions WHERE run_id = runs.id)
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(workspace, limit) as unknown as Array<Omit<StoredFleetRun, "sessions">>;
    const sessions = this.db.prepare(
      `SELECT member_id AS memberId, session_id AS sessionId, state,
              last_active_at AS lastActiveAt
       FROM member_sessions
       WHERE run_id = ?
       ORDER BY last_active_at DESC`,
    );
    return runs.map((run) => ({
      ...run,
      sessions: sessions.all(run.id) as unknown as StoredFleetRun["sessions"],
    }));
  }

  fleetRun(id: string, workspace: string): StoredFleetRun | undefined {
    const run = this.db
      .prepare(
        `SELECT id, fleet_id AS fleetId, status, started_at AS startedAt, ended_at AS endedAt
         FROM runs
         WHERE id = ? AND mode = 'fleet' AND workspace = ? AND fleet_id IS NOT NULL`,
      )
      .get(id, workspace) as unknown as Omit<StoredFleetRun, "sessions"> | undefined;
    if (!run) {
      return undefined;
    }
    const sessions = this.db
      .prepare(
        `SELECT member_id AS memberId, session_id AS sessionId, state,
                last_active_at AS lastActiveAt
         FROM member_sessions WHERE run_id = ?`,
      )
      .all(id) as unknown as StoredFleetRun["sessions"];
    return { ...run, sessions };
  }

  resumeRun(id: string, ownerPid: number): void {
    const result = this.db
      .prepare(
        `UPDATE runs
         SET status = 'active', ended_at = NULL, interruption_reason = NULL, owner_pid = ?
         WHERE id = ? AND mode = 'fleet' AND status != 'active'`,
      )
      .run(ownerPid, id);
    if (result.changes !== 1) {
      throw new Error(`Fleet run "${id}" could not be resumed.`);
    }
  }

  finishRun(id: string, status: Exclude<RunStatus, "active">, reason?: string): void {
    this.db
      .prepare(
        `UPDATE runs
         SET status = ?, ended_at = ?, interruption_reason = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(status, now(), reason ?? null, id);
  }

  upsertSession(runId: string, memberId: string, sessionId: string, state: string): void {
    this.db
      .prepare(
        `INSERT INTO member_sessions(run_id, member_id, session_id, state, last_active_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id, member_id) DO UPDATE SET
           session_id = excluded.session_id,
           state = excluded.state,
           last_active_at = excluded.last_active_at`,
      )
      .run(runId, memberId, sessionId, state, now());
  }

  hasConversationActivity(runId: string, memberId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT EXISTS(
           SELECT 1 FROM messages
           WHERE run_id = ? AND target = ?
         ) OR EXISTS(
           SELECT 1 FROM events
           WHERE run_id = ? AND member_id = ?
             AND type IN ('user.message', 'assistant.message', 'assistant.reasoning')
         ) AS present`,
      )
      .get(runId, memberId, runId, memberId) as { present: number };
    return row.present === 1;
  }

  nextSequence(runId: string, target: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
         FROM messages WHERE run_id = ? AND target = ?`,
      )
      .get(runId, target) as { sequence: number };
    return row.sequence;
  }

  enqueueMessage(
    id: string,
    runId: string,
    source: string,
    target: string,
    kind: StoredMessage["kind"],
    content: string,
  ): StoredMessage {
    return this.transaction(() => {
      const timestamp = now();
      const sequence = this.nextSequence(runId, target);
      this.db
        .prepare(
          `INSERT INTO messages(
             id, run_id, source, target, kind, content, status, sequence, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(id, runId, source, target, kind, content, sequence, timestamp, timestamp);
      return {
        id,
        runId,
        source,
        target,
        kind,
        content,
        status: "pending",
        sequence,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    });
  }

  claimMessages(runId: string, target: string, limit = 20, leaseMs = 60_000): StoredMessage[] {
    return this.transaction(() => {
      const timestamp = now();
      const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
      this.db
        .prepare(
          `UPDATE messages
           SET status = 'pending', updated_at = ?
           WHERE status = 'delivering'
             AND id IN (SELECT message_id FROM delivery_leases WHERE lease_until <= ?)`,
        )
        .run(timestamp, timestamp);
      this.db.prepare("DELETE FROM delivery_leases WHERE lease_until <= ?").run(timestamp);

      const rows = this.db
        .prepare(
          `SELECT
             id, run_id AS runId, source, target, kind, content, status, sequence,
             created_at AS createdAt, updated_at AS updatedAt
           FROM messages
           WHERE run_id = ? AND target = ? AND status = 'pending'
           ORDER BY created_at, sequence
           LIMIT ?`,
        )
        .all(runId, target, limit) as unknown as StoredMessage[];

      const update = this.db.prepare(
        `UPDATE messages SET status = 'delivering', updated_at = ? WHERE id = ?`,
      );
      const lease = this.db.prepare(
        `INSERT INTO delivery_leases(message_id, target, lease_until, attempts)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(message_id) DO UPDATE SET
           lease_until = excluded.lease_until,
           attempts = delivery_leases.attempts + 1`,
      );
      for (const row of rows) {
        update.run(timestamp, row.id);
        lease.run(row.id, target, leaseUntil);
        row.status = "delivering";
        row.updatedAt = timestamp;
      }
      return rows;
    });
  }

  completeMessage(id: string): void {
    this.transaction(() => {
      this.db
        .prepare("UPDATE messages SET status = 'delivered', updated_at = ? WHERE id = ?")
        .run(now(), id);
      this.db.prepare("DELETE FROM delivery_leases WHERE message_id = ?").run(id);
    });
  }

  failMessage(id: string, error: string, retry: boolean): void {
    this.transaction(() => {
      const status: MessageStatus = retry ? "pending" : "failed";
      this.db
        .prepare("UPDATE messages SET status = ?, updated_at = ? WHERE id = ?")
        .run(status, now(), id);
      if (retry) {
        this.db.prepare("DELETE FROM delivery_leases WHERE message_id = ?").run(id);
      } else {
        this.db
          .prepare("UPDATE delivery_leases SET last_error = ? WHERE message_id = ?")
          .run(error, id);
      }
    });
  }

  appendEvent(
    id: string,
    runId: string | null,
    memberId: string | null,
    type: string,
    payload: unknown,
    sequence?: number,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO events(
           id, run_id, member_id, type, payload, sequence, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, runId, memberId, type, JSON.stringify(payload), sequence ?? null, now());
  }

  checkpoint(runId: string, memberId: string, sequence: number, unreadCount: number): void {
    this.db
      .prepare(
        `INSERT INTO checkpoints(
           run_id, member_id, last_event_sequence, unread_count, updated_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id, member_id) DO UPDATE SET
           last_event_sequence = excluded.last_event_sequence,
           unread_count = excluded.unread_count,
           updated_at = excluded.updated_at`,
      )
      .run(runId, memberId, sequence, unreadCount, now());
  }

  snapshot(eventLimit = 500): StateSnapshot {
    const runs = this.db
      .prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 50")
      .all() as Array<Record<string, unknown>>;
    const sessions = this.db
      .prepare("SELECT * FROM member_sessions ORDER BY last_active_at DESC")
      .all() as Array<Record<string, unknown>>;
    const messages = this.db
      .prepare(
        `SELECT
           id, run_id AS runId, source, target, kind, content, status, sequence,
           created_at AS createdAt, updated_at AS updatedAt
         FROM messages ORDER BY created_at, sequence`,
      )
      .all() as unknown as StoredMessage[];
    const events = this.db
      .prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT ?")
      .all(eventLimit) as Array<Record<string, unknown>>;
    return { runs, sessions, messages, events };
  }

  close(): void {
    this.db.close();
  }
}
