import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type RunMode = "standard" | "agent";
export type RunStatus = "active" | "stopped" | "interrupted";
export type MessageStatus = "pending" | "delivering" | "delivered" | "failed";

/**
 * Current durable schema version. Every run is a single session — the Standard
 * supervisor or one standalone agent — so the schema carries no group state.
 */
const SCHEMA_VERSION = 6;

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

export interface StoredAgentSession {
  sessionId: string;
  state: string;
  lastActiveAt: string;
}

export interface StoredAgentRun {
  id: string;
  agentId: string;
  alias: string;
  definition: string | null;
  standardCanTalk: boolean;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  session: StoredAgentSession | undefined;
}

export interface ReservedAgentAlias {
  alias: string;
  agentId: string;
  runId: string;
  status: RunStatus;
}

function now(): string {
  return new Date().toISOString();
}

export class AgentDatabase {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.migrate();
  }

  /**
   * Brings the database to {@link SCHEMA_VERSION}. Backward compatibility with an
   * older, pre-agent schema is deliberately not preserved: that state is dropped and
   * the durable schema is rebuilt coherently, so an existing database always opens
   * successfully instead of failing at startup. A database written by a *newer* host
   * is never erased — it is rejected with an explicit error.
   */
  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS schema_meta (
        version INTEGER NOT NULL
      );
      INSERT INTO schema_meta(version)
      SELECT ${SCHEMA_VERSION}
      WHERE NOT EXISTS (SELECT 1 FROM schema_meta);
    `);
    const schema = this.db.prepare("SELECT version FROM schema_meta LIMIT 1").get() as {
      version: number;
    };
    if (schema.version > SCHEMA_VERSION) {
      throw new Error(
        `The Copilot state database is at schema version ${schema.version}, which is newer than ` +
          `this host understands (${SCHEMA_VERSION}). Update native-copilot.nvim instead of ` +
          "opening it with an older host; the newer state is left untouched.",
      );
    }
    if (schema.version < SCHEMA_VERSION) {
      // Foreign keys cannot be toggled inside a transaction, so disable them around
      // the rebuild of the obsolete tables.
      this.db.exec("PRAGMA foreign_keys = OFF");
      this.db.exec(`
        BEGIN IMMEDIATE;
        DROP TABLE IF EXISTS checkpoints;
        DROP TABLE IF EXISTS delivery_leases;
        DROP TABLE IF EXISTS messages;
        DROP TABLE IF EXISTS events;
        DROP TABLE IF EXISTS member_sessions;
        DROP TABLE IF EXISTS agent_sessions;
        DROP TABLE IF EXISTS runs;
        UPDATE schema_meta SET version = ${SCHEMA_VERSION};
        COMMIT;
      `);
    }
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK(mode IN ('standard', 'agent')),
        agent_id TEXT,
        alias TEXT,
        definition TEXT,
        standard_can_talk INTEGER NOT NULL DEFAULT 0,
        workspace TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'stopped', 'interrupted')),
        started_at TEXT NOT NULL,
        ended_at TEXT,
        interruption_reason TEXT,
        owner_pid INTEGER
      );
      CREATE INDEX IF NOT EXISTS runs_agent_idx ON runs(agent_id);

      CREATE TABLE IF NOT EXISTS agent_sessions (
        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        state TEXT NOT NULL,
        last_active_at TEXT NOT NULL
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
        target TEXT,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        sequence INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_run_target_idx
      ON events(run_id, target, created_at);

      CREATE TABLE IF NOT EXISTS checkpoints (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        target TEXT NOT NULL,
        last_event_sequence INTEGER NOT NULL DEFAULT 0,
        unread_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(run_id, target)
      );
    `);
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

  createStandardRun(id: string, workspace: string, ownerPid: number): void {
    this.db
      .prepare(
        `INSERT INTO runs(id, mode, workspace, status, started_at, owner_pid)
         VALUES (?, 'standard', ?, 'active', ?, ?)`,
      )
      .run(id, workspace, now(), ownerPid);
  }

  /**
   * Moves every still-undelivered message addressed to the Standard session from
   * earlier, no-longer-active Standard runs in this workspace into the run that now
   * owns that mailbox. Messages an agent sent to Standard must survive a Standard
   * session replacement or a host restart rather than being stranded on a dead run,
   * so they are transferred instead of dropped: stale delivery leases are released,
   * the messages are reset to 'pending', and each one is given the next free
   * sequence in the new run so the UNIQUE(run_id, target, sequence) key cannot
   * collide. Returns how many messages were adopted.
   */
  adoptStandardMessages(runId: string, workspace: string, target = "standard"): number {
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT messages.id AS id
           FROM messages
           JOIN runs ON runs.id = messages.run_id
           WHERE messages.target = ?
             AND messages.status IN ('pending', 'delivering')
             AND runs.mode = 'standard'
             AND runs.workspace = ?
             AND runs.id != ?
             AND runs.status != 'active'
           ORDER BY messages.created_at, messages.sequence`,
        )
        .all(target, workspace, runId) as unknown as Array<{ id: string }>;
      if (rows.length === 0) {
        return 0;
      }
      const timestamp = now();
      let sequence = this.nextSequence(runId, target);
      const adopt = this.db.prepare(
        `UPDATE messages
         SET run_id = ?, sequence = ?, status = 'pending', updated_at = ?
         WHERE id = ?`,
      );
      const releaseLease = this.db.prepare("DELETE FROM delivery_leases WHERE message_id = ?");
      for (const row of rows) {
        adopt.run(runId, sequence, timestamp, row.id);
        releaseLease.run(row.id);
        sequence += 1;
      }
      return rows.length;
    });
  }

  /** Creates the single durable run that owns one standalone agent. */
  createAgentRun(
    id: string,
    agentId: string,
    alias: string,
    definition: string,
    standardCanTalk: boolean,
    workspace: string,
    ownerPid: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO runs(
           id, mode, agent_id, alias, definition, standard_can_talk,
           workspace, status, started_at, owner_pid
         ) VALUES (?, 'agent', ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(id, agentId, alias, definition, standardCanTalk ? 1 : 0, workspace, now(), ownerPid);
  }

  private agentRunRows(where: string, ...parameters: Array<string | number>): StoredAgentRun[] {
    const rows = this.db
      .prepare(
        `SELECT id, agent_id AS agentId, alias, definition,
                standard_can_talk AS standardCanTalk,
                status, started_at AS startedAt, ended_at AS endedAt
         FROM runs
         WHERE mode = 'agent' AND agent_id IS NOT NULL AND alias IS NOT NULL AND ${where}`,
      )
      .all(...parameters) as unknown as Array<
        Omit<StoredAgentRun, "standardCanTalk" | "session"> & { standardCanTalk: number }
      >;
    const session = this.db.prepare(
      `SELECT session_id AS sessionId, state, last_active_at AS lastActiveAt
       FROM agent_sessions WHERE run_id = ?`,
    );
    return rows.map((row) => ({
      ...row,
      standardCanTalk: row.standardCanTalk === 1,
      session: session.get(row.id) as unknown as StoredAgentSession | undefined,
    }));
  }

  /** Agent runs in this workspace that are not owned by a live host and can resume. */
  resumableAgentRuns(workspace: string, limit = 50): StoredAgentRun[] {
    return this.agentRunRows(
      `workspace = ?
         AND status != 'active'
         AND definition IS NOT NULL
         AND EXISTS (SELECT 1 FROM agent_sessions WHERE run_id = runs.id)
       ORDER BY started_at DESC
       LIMIT ?`,
      workspace,
      limit,
    );
  }

  agentRun(id: string, workspace: string): StoredAgentRun | undefined {
    return this.agentRunRows("id = ? AND workspace = ?", id, workspace)[0];
  }

  /**
   * Every agent alias reserved in a workspace: one row per agent run that still has
   * a stored definition, regardless of status or whether it ever produced a session.
   * Aliases must be unique across active agents and every recoverable definition, so
   * this is the authoritative reservation list.
   */
  reservedAgentAliases(workspace: string): ReservedAgentAlias[] {
    return this.db
      .prepare(
        `SELECT alias, agent_id AS agentId, id AS runId, status
         FROM runs
         WHERE mode = 'agent' AND workspace = ?
           AND alias IS NOT NULL AND agent_id IS NOT NULL AND definition IS NOT NULL
         ORDER BY started_at DESC`,
      )
      .all(workspace) as unknown as ReservedAgentAlias[];
  }

  resumeRun(id: string, ownerPid: number): void {
    const result = this.db
      .prepare(
        `UPDATE runs
         SET status = 'active', ended_at = NULL, interruption_reason = NULL, owner_pid = ?
         WHERE id = ? AND mode = 'agent' AND status != 'active'`,
      )
      .run(ownerPid, id);
    if (result.changes !== 1) {
      throw new Error(`Agent run "${id}" could not be resumed.`);
    }
  }

  updateAgentRun(
    id: string,
    alias: string,
    definition: string,
    standardCanTalk: boolean,
  ): void {
    const result = this.db
      .prepare(
        `UPDATE runs
         SET alias = ?, definition = ?, standard_can_talk = ?
         WHERE id = ? AND mode = 'agent'`,
      )
      .run(alias, definition, standardCanTalk ? 1 : 0, id);
    if (result.changes !== 1) {
      throw new Error(`Agent run "${id}" could not be updated with a new definition.`);
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

  /** Persists the single SDK session owned by a run. */
  upsertSession(runId: string, sessionId: string, state: string): void {
    this.db
      .prepare(
        `INSERT INTO agent_sessions(run_id, session_id, state, last_active_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           session_id = excluded.session_id,
           state = excluded.state,
           last_active_at = excluded.last_active_at`,
      )
      .run(runId, sessionId, state, now());
  }

  session(runId: string): StoredAgentSession | undefined {
    return this.db
      .prepare(
        `SELECT session_id AS sessionId, state, last_active_at AS lastActiveAt
         FROM agent_sessions WHERE run_id = ?`,
      )
      .get(runId) as unknown as StoredAgentSession | undefined;
  }

  hasConversationActivity(runId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT EXISTS(
           SELECT 1 FROM messages WHERE run_id = ?
         ) OR EXISTS(
           SELECT 1 FROM events
           WHERE run_id = ?
             AND type IN ('user.message', 'assistant.message', 'assistant.reasoning')
         ) AS present`,
      )
      .get(runId, runId) as { present: number };
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

  /**
   * Stores a durable message against the recipient's own run, so every mailbox is
   * drained independently and no shared run is required to route it.
   */
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
        .prepare(
          `UPDATE messages SET status = 'delivered', updated_at = ?
           WHERE id = ? AND status IN ('pending', 'delivering')`,
        )
        .run(now(), id);
      this.db.prepare("DELETE FROM delivery_leases WHERE message_id = ?").run(id);
    });
  }

  failMessage(id: string, error: string, retry: boolean): void {
    this.transaction(() => {
      const status: MessageStatus = retry ? "pending" : "failed";
      this.db
        .prepare(
          `UPDATE messages SET status = ?, updated_at = ?
           WHERE id = ? AND status IN ('pending', 'delivering')`,
        )
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
    target: string | null,
    type: string,
    payload: unknown,
    sequence?: number,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO events(
           id, run_id, target, type, payload, sequence, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, runId, target, type, JSON.stringify(payload), sequence ?? null, now());
  }

  checkpoint(runId: string, target: string, sequence: number, unreadCount: number): void {
    this.db
      .prepare(
        `INSERT INTO checkpoints(
           run_id, target, last_event_sequence, unread_count, updated_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id, target) DO UPDATE SET
           last_event_sequence = excluded.last_event_sequence,
           unread_count = excluded.unread_count,
           updated_at = excluded.updated_at`,
      )
      .run(runId, target, sequence, unreadCount, now());
  }

  snapshot(eventLimit = 500): StateSnapshot {
    const runs = this.db
      .prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 50")
      .all() as Array<Record<string, unknown>>;
    const sessions = this.db
      .prepare("SELECT * FROM agent_sessions ORDER BY last_active_at DESC")
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
