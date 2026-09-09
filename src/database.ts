import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Deprecated schema-v8 primary identity retained for migration and mailbox adoption. */
const LEGACY_PRIMARY_IDENTITY = "standard";
const PRIMARY_ALIAS = "copilot";
const RESERVED_AGENT_ALIAS_INDEX = "runs_reserved_agent_alias_uq";

type LegacyRunMode = "standard" | "agent";
export type RunStatus = "active" | "stopped" | "interrupted";
export type MessageStatus = "pending" | "delivering" | "delivered" | "failed";

/**
 * Current durable schema version. Every run is one UUID-backed agent session; a
 * minimal primary marker identifies the agent attached to the main UI buffer.
 */
const SCHEMA_VERSION = 10;

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
  isPrimary: boolean;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  session: StoredAgentSession | undefined;
}

export interface ActivityCursor {
  sessionId: string;
  cursor: string;
  updatedAt: string;
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
   * Brings the database to {@link SCHEMA_VERSION}. Pre-v6 state is rebuilt as before;
   * v6-v9 agent runs and mailboxes are migrated in place. A database written by a
   * newer host is never erased.
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
    if (schema.version < 6) {
      this.db.exec("PRAGMA foreign_keys = OFF");
      this.db.exec(`
        BEGIN IMMEDIATE;
        DROP TABLE IF EXISTS activity_cursors;
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
        standard_can_observe INTEGER NOT NULL DEFAULT 0,
        is_primary INTEGER NOT NULL DEFAULT 0,
        recovery_eligible INTEGER NOT NULL DEFAULT 1,
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

      CREATE TABLE IF NOT EXISTS activity_cursors (
        observer_id TEXT NOT NULL,
        target_agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        event_cursor TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(observer_id, target_agent_id)
      );
    `);
    if (schema.version >= 6 && schema.version < SCHEMA_VERSION) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (schema.version === 6 && !this.hasColumn("runs", "standard_can_observe")) {
          this.db.exec(
            "ALTER TABLE runs ADD COLUMN standard_can_observe INTEGER NOT NULL DEFAULT 0",
          );
        }
        if (!this.hasColumn("runs", "is_primary")) {
          this.db.exec("ALTER TABLE runs ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0");
        }
        if (!this.hasColumn("runs", "recovery_eligible")) {
          this.db.exec(
            "ALTER TABLE runs ADD COLUMN recovery_eligible INTEGER NOT NULL DEFAULT 1",
          );
        }
        if (schema.version <= 6) {
          this.db.exec("DROP TABLE IF EXISTS checkpoints; DROP TABLE IF EXISTS events;");
        }
        if (schema.version <= 7) {
          this.db.exec(`
            DROP TABLE IF EXISTS activity_cursors;
            CREATE TABLE activity_cursors (
              observer_id TEXT NOT NULL,
              target_agent_id TEXT NOT NULL,
              session_id TEXT NOT NULL,
              event_cursor TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              PRIMARY KEY(observer_id, target_agent_id)
            );
          `);
        }
        this.assertAgentAliasState();
        if (schema.version < 9) {
          this.migrateLegacyAgentState();
        }
        this.db.prepare("UPDATE schema_meta SET version = ?").run(SCHEMA_VERSION);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    this.ensureAgentAliasConstraints();
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
      name: string;
    }>;
    return rows.some((row) => row.name === column);
  }

  private assertAgentAliasState(): void {
    const reserved = this.db
      .prepare(
        `SELECT workspace, id AS runId
         FROM runs
         WHERE mode = 'agent' AND alias = ?`,
      )
      .all(LEGACY_PRIMARY_IDENTITY) as unknown as Array<{
        workspace: string;
        runId: string;
      }>;
    if (reserved.length > 0) {
      const details = reserved
        .map((row) => `"${row.runId}" in workspace "${row.workspace}"`)
        .join(", ");
      throw new Error(
        `The Copilot state database assigns the reserved compatibility selector ` +
          `"${LEGACY_PRIMARY_IDENTITY}" as an agent alias (${details}). ` +
          "Rename or remove the conflicting persisted agent before starting native-copilot.nvim.",
      );
    }

    const duplicates = this.db
      .prepare(
        `SELECT workspace, alias, GROUP_CONCAT(id, ', ') AS runIds, COUNT(*) AS runCount
         FROM runs
         WHERE mode = 'agent' AND is_primary = 0
           AND alias IS NOT NULL AND agent_id IS NOT NULL AND definition IS NOT NULL
         GROUP BY workspace, alias
         HAVING COUNT(*) > 1
         ORDER BY workspace, alias`,
      )
      .all() as unknown as Array<{
        workspace: string;
        alias: string;
        runIds: string;
        runCount: number;
      }>;
    if (duplicates.length > 0) {
      const details = duplicates
        .map(
          (conflict) =>
            `alias "${conflict.alias}" in workspace "${conflict.workspace}" is reserved by ` +
            `${conflict.runCount} runs (${conflict.runIds})`,
        )
        .join("; ");
      throw new Error(
        `The Copilot state database contains conflicting persisted agent aliases: ${details}. ` +
          "Resolve the duplicate aliases before starting native-copilot.nvim.",
      );
    }
  }

  private ensureAgentAliasConstraints(): void {
    this.transaction(() => {
      this.assertAgentAliasState();
      try {
        this.db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS ${RESERVED_AGENT_ALIAS_INDEX}
          ON runs(workspace, alias)
          WHERE mode = 'agent' AND is_primary = 0
            AND alias IS NOT NULL AND agent_id IS NOT NULL AND definition IS NOT NULL;

          CREATE TRIGGER IF NOT EXISTS runs_reserved_standard_alias_insert
          BEFORE INSERT ON runs
          WHEN NEW.mode = 'agent' AND NEW.alias = '${LEGACY_PRIMARY_IDENTITY}'
          BEGIN
            SELECT RAISE(ABORT, 'agent alias "${LEGACY_PRIMARY_IDENTITY}" is reserved');
          END;

          CREATE TRIGGER IF NOT EXISTS runs_reserved_standard_alias_update
          BEFORE UPDATE OF mode, alias ON runs
          WHEN NEW.mode = 'agent' AND NEW.alias = '${LEGACY_PRIMARY_IDENTITY}'
          BEGIN
            SELECT RAISE(ABORT, 'agent alias "${LEGACY_PRIMARY_IDENTITY}" is reserved');
          END;
        `);
      } catch (error) {
        if (this.isAliasConstraintFailure(error)) {
          throw new Error(
            "The Copilot state database contains conflicting persisted agent aliases. " +
              "Resolve the duplicate aliases before starting native-copilot.nvim.",
            { cause: error },
          );
        }
        throw error;
      }
    });
  }

  private isAliasConstraintFailure(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes(RESERVED_AGENT_ALIAS_INDEX) ||
      message.includes("UNIQUE constraint failed: runs.workspace, runs.alias") ||
      message.includes(`agent alias "${LEGACY_PRIMARY_IDENTITY}" is reserved`)
    );
  }

  private aliasConflict(error: unknown, alias: string, workspace?: string): never {
    if (!this.isAliasConstraintFailure(error)) {
      throw error;
    }
    if (alias === LEGACY_PRIMARY_IDENTITY) {
      throw new Error(
        `Alias "${alias}" is reserved for primary-agent compatibility and cannot be assigned ` +
          "to an agent.",
        { cause: error },
      );
    }
    throw new Error(
      `Alias "${alias}" is already reserved by another recoverable non-primary agent` +
        `${workspace === undefined ? "" : ` in workspace "${workspace}"`}.`,
      { cause: error },
    );
  }

  /**
   * Adopts schema-v8 primary-session state into the same UUID-backed run/ACL model as
   * every other agent. Existing worker definitions and pending mail are retained.
   */
  private migrateLegacyAgentState(): void {
    type LegacyRun = {
      id: string;
      mode: LegacyRunMode;
      agentId: string | null;
      alias: string | null;
      definition: string | null;
      workspace: string;
      startedAt: string;
      legacyPrimaryCanTalk: number;
      legacyPrimaryCanObserve: number;
    };
    const runs = this.db
      .prepare(
        `SELECT id, mode, agent_id AS agentId, alias, definition, workspace,
                started_at AS startedAt, standard_can_talk AS legacyPrimaryCanTalk,
                standard_can_observe AS legacyPrimaryCanObserve
         FROM runs
         ORDER BY workspace, started_at DESC`,
      )
      .all() as unknown as LegacyRun[];
    const primaryByWorkspace = new Map<
      string,
      { agentId: string; runId: string; alias: string }
    >();
    for (const run of runs) {
      if (run.mode !== "standard" || primaryByWorkspace.has(run.workspace)) {
        continue;
      }
      primaryByWorkspace.set(run.workspace, {
        agentId: randomUUID(),
        runId: run.id,
        alias: PRIMARY_ALIAS,
      });
    }

    const aliasesByWorkspace = new Map<string, Map<string, string>>();
    const workspaceByAgentId = new Map<string, string>();
    for (const run of runs) {
      if (run.mode !== "agent" || !run.agentId) {
        continue;
      }
      workspaceByAgentId.set(run.agentId, run.workspace);
      if (!run.alias || !run.definition) {
        continue;
      }
      const aliases = aliasesByWorkspace.get(run.workspace) ?? new Map<string, string>();
      if (!aliases.has(run.alias)) {
        aliases.set(run.alias, run.agentId);
      }
      aliasesByWorkspace.set(run.workspace, aliases);
    }
    for (const [workspace, primary] of primaryByWorkspace) {
      const aliases = aliasesByWorkspace.get(workspace);
      let candidate = PRIMARY_ALIAS;
      let suffix = 2;
      if (aliases?.has(candidate)) {
        candidate = "primary";
      }
      while (aliases?.has(candidate)) {
        candidate = `primary_${suffix}`;
        suffix += 1;
      }
      primary.alias = candidate;
      workspaceByAgentId.set(primary.agentId, workspace);
    }

    const resolveSelectors = (
      selectors: unknown,
      workspace: string,
    ): string[] => {
      if (!Array.isArray(selectors)) {
        return [];
      }
      const primary = primaryByWorkspace.get(workspace);
      const aliases = aliasesByWorkspace.get(workspace);
      const resolved = new Set<string>();
      for (const selector of selectors) {
        if (typeof selector !== "string") {
          continue;
        }
        if (selector === LEGACY_PRIMARY_IDENTITY) {
          if (primary) resolved.add(primary.agentId);
          continue;
        }
        if (selector.startsWith("agent:") && selector.length > "agent:".length) {
          resolved.add(selector.slice("agent:".length));
          continue;
        }
        const byAlias = aliases?.get(selector);
        if (byAlias) {
          resolved.add(byAlias);
          continue;
        }
        if (workspaceByAgentId.get(selector) === workspace) {
          resolved.add(selector);
        }
      }
      return [...resolved];
    };

    const updateDefinition = this.db.prepare(
      "UPDATE runs SET definition = ? WHERE id = ?",
    );
    const legacyTalkByWorkspace = new Map<string, Set<string>>();
    const legacyObserveByWorkspace = new Map<string, Set<string>>();
    for (const run of runs) {
      const agentId = run.agentId;
      const storedDefinition = run.definition;
      if (run.mode !== "agent" || !agentId || !storedDefinition) {
        continue;
      }
      try {
        const parsed = JSON.parse(storedDefinition) as {
          definition?: Record<string, unknown>;
          mcpServers?: unknown;
          standardCanTalk?: unknown;
          standardCanObserve?: unknown;
        };
        if (!parsed.definition || typeof parsed.definition !== "object") {
          continue;
        }
        const canTalkTo = parsed.definition.canTalkTo;
        const canObserve = parsed.definition.canObserve;
        if (parsed.standardCanTalk === true) {
          const grants = legacyTalkByWorkspace.get(run.workspace) ?? new Set<string>();
          grants.add(agentId);
          legacyTalkByWorkspace.set(run.workspace, grants);
        }
        if (parsed.standardCanObserve === true) {
          const grants = legacyObserveByWorkspace.get(run.workspace) ?? new Set<string>();
          grants.add(agentId);
          legacyObserveByWorkspace.set(run.workspace, grants);
        }
        const canTalkToAgentIds = resolveSelectors(canTalkTo, run.workspace);
        const canObserveAgentIds = resolveSelectors(canObserve, run.workspace);
        const definition = {
          ...parsed.definition,
          canTalkTo: canTalkToAgentIds.map((agentId) => `agent:${agentId}`),
          canObserve: canObserveAgentIds.map((agentId) => `agent:${agentId}`),
        };
        updateDefinition.run(
          JSON.stringify({
            definition,
            mcpServers: Array.isArray(parsed.mcpServers) ? parsed.mcpServers : [],
            canTalkToAgentIds,
            canObserveAgentIds,
          }),
          run.id,
        );
      } catch {
        // Preserve an unreadable record verbatim so migration never destroys state.
      }
    }

    const convertPrimary = this.db.prepare(
      `UPDATE runs
       SET mode = 'agent', agent_id = ?, alias = ?, definition = ?, is_primary = 1
       WHERE id = ?`,
    );
    const updatePrimaryMessages = this.db.prepare(
      `UPDATE messages SET target = ?, source = CASE WHEN source = ? THEN ? ELSE source END
       WHERE run_id = ?`,
    );
    for (const [workspace, primary] of primaryByWorkspace) {
      const outgoingTalk = new Set(runs
        .filter(
          (run) =>
            run.workspace === workspace &&
            run.mode === "agent" &&
            run.agentId !== null &&
            run.legacyPrimaryCanTalk === 1,
        )
        .map((run) => run.agentId!));
      for (const agentId of legacyTalkByWorkspace.get(workspace) ?? []) {
        outgoingTalk.add(agentId);
      }
      const outgoingObserve = new Set(runs
        .filter(
          (run) =>
            run.workspace === workspace &&
            run.mode === "agent" &&
            run.agentId !== null &&
            run.legacyPrimaryCanObserve === 1,
        )
        .map((run) => run.agentId!));
      for (const agentId of legacyObserveByWorkspace.get(workspace) ?? []) {
        outgoingObserve.add(agentId);
      }
      const definition = {
        id: primary.alias,
        displayName: "Copilot",
        description: "Primary user-facing Copilot agent",
        task: "Assist the user in the primary Neovim conversation.",
        prompt:
          "You are the Copilot agent attached to the primary user-facing Neovim buffer.",
        canTalkTo: [],
        canObserve: [],
      };
      convertPrimary.run(
        primary.agentId,
        primary.alias,
        JSON.stringify({
          definition,
          mcpServers: [],
          canTalkToAgentIds: [...outgoingTalk],
          canObserveAgentIds: [...outgoingObserve],
        }),
        primary.runId,
      );
      updatePrimaryMessages.run(
        `agent:${primary.agentId}`,
        LEGACY_PRIMARY_IDENTITY,
        `agent:${primary.agentId}`,
        primary.runId,
      );
      this.db
        .prepare(
          `UPDATE messages SET source = ?
           WHERE source = ?
             AND kind = 'agent'
             AND run_id IN (SELECT id FROM runs WHERE workspace = ?)`,
        )
        .run(`agent:${primary.agentId}`, LEGACY_PRIMARY_IDENTITY, workspace);
    }
    const updateLegacySourceAlias = this.db.prepare(
      `UPDATE messages SET source = ?
       WHERE source = ?
         AND kind = 'agent'
         AND run_id IN (SELECT id FROM runs WHERE workspace = ?)`,
    );
    for (const [workspace, aliases] of aliasesByWorkspace) {
      for (const [alias, agentId] of aliases) {
        updateLegacySourceAlias.run(`agent:${agentId}`, alias, workspace);
      }
    }

    const sessions = this.db
      .prepare(
        `SELECT agent_sessions.session_id AS sessionId, runs.agent_id AS agentId,
                runs.workspace AS workspace
         FROM agent_sessions
         JOIN runs ON runs.id = agent_sessions.run_id
         WHERE runs.agent_id IS NOT NULL`,
      )
      .all() as unknown as Array<{ sessionId: string; agentId: string; workspace: string }>;
    const sessionTargets = new Map<
      string,
      { sessionId: string; agentId: string; workspace: string }
    >();
    for (const row of sessions) {
      sessionTargets.set(row.sessionId, row);
    }
    for (const run of runs) {
      if (run.mode !== "standard") continue;
      const primary = primaryByWorkspace.get(run.workspace);
      const session = this.db
        .prepare("SELECT session_id AS sessionId FROM agent_sessions WHERE run_id = ?")
        .get(run.id) as { sessionId: string } | undefined;
      if (primary && session) {
        sessionTargets.set(session.sessionId, {
          sessionId: session.sessionId,
          agentId: primary.agentId,
          workspace: run.workspace,
        });
      }
    }
    const cursors = this.db
      .prepare(
        `SELECT observer_id AS observerId, target_agent_id AS targetAgentId,
                session_id AS sessionId, event_cursor AS cursor, updated_at AS updatedAt
         FROM activity_cursors`,
      )
      .all() as unknown as Array<{
        observerId: string;
        targetAgentId: string;
        sessionId: string;
        cursor: string;
        updatedAt: string;
      }>;
    const upsertCursor = this.db.prepare(
      `INSERT OR REPLACE INTO activity_cursors(
         observer_id, target_agent_id, session_id, event_cursor, updated_at
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const cursor of cursors) {
      let targetAgentId = cursor.targetAgentId;
      if (targetAgentId === LEGACY_PRIMARY_IDENTITY) {
        targetAgentId = sessionTargets.get(cursor.sessionId)?.agentId ?? targetAgentId;
      } else if (targetAgentId.startsWith("agent:")) {
        targetAgentId = targetAgentId.slice("agent:".length);
      }
      let observerId = cursor.observerId;
      if (observerId === LEGACY_PRIMARY_IDENTITY) {
        const workspace = workspaceByAgentId.get(targetAgentId);
        observerId = workspace
          ? primaryByWorkspace.get(workspace)?.agentId ?? observerId
          : observerId;
      } else if (observerId.startsWith("agent:")) {
        observerId = observerId.slice("agent:".length);
      }
      if (
        observerId !== LEGACY_PRIMARY_IDENTITY &&
        targetAgentId !== LEGACY_PRIMARY_IDENTITY
      ) {
        upsertCursor.run(
          observerId,
          targetAgentId,
          cursor.sessionId,
          cursor.cursor,
          cursor.updatedAt,
        );
      }
    }
    this.db
      .prepare(
        "DELETE FROM activity_cursors WHERE observer_id = ? OR target_agent_id = ?",
      )
      .run(LEGACY_PRIMARY_IDENTITY, LEGACY_PRIMARY_IDENTITY);
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

  /**
   * Moves still-undelivered mail from earlier runs of one durable agent into its
   * current run. The optional legacy target adopts pre-v9 primary mail as well.
   */
  adoptAgentMessages(
    runId: string,
    workspace: string,
    agentId: string,
    target: string,
    legacyTarget?: string,
  ): number {
    return this.transaction(() =>
      this.adoptAgentMessagesInTransaction(
        runId,
        workspace,
        agentId,
        target,
        legacyTarget,
      ));
  }

  adoptPrimaryMessages(
    runId: string,
    workspace: string,
    agentId: string,
    target: string,
  ): number {
    return this.adoptAgentMessages(
      runId,
      workspace,
      agentId,
      target,
      LEGACY_PRIMARY_IDENTITY,
    );
  }

  private adoptAgentMessagesInTransaction(
    runId: string,
    workspace: string,
    agentId: string,
    target: string,
    legacyTarget?: string,
  ): number {
    const rows = this.db
      .prepare(
        `SELECT messages.id AS id
         FROM messages
         JOIN runs ON runs.id = messages.run_id
         WHERE messages.status IN ('pending', 'delivering')
           AND runs.workspace = ?
           AND runs.id != ?
           AND runs.status != 'active'
           AND (
             (runs.mode = 'agent' AND runs.agent_id = ?)
             OR (? IS NOT NULL AND runs.mode = 'standard' AND messages.target = ?)
           )
         ORDER BY messages.created_at, messages.sequence`,
      )
      .all(workspace, runId, agentId, legacyTarget ?? null, legacyTarget ?? null) as unknown as Array<{
        id: string;
      }>;
    if (rows.length === 0) {
      return 0;
    }
    const timestamp = now();
    let sequence = this.nextSequence(runId, target);
    const adopt = this.db.prepare(
      `UPDATE messages
       SET run_id = ?, target = ?, sequence = ?, status = 'pending', updated_at = ?
       WHERE id = ?`,
    );
    const releaseLease = this.db.prepare("DELETE FROM delivery_leases WHERE message_id = ?");
    for (const row of rows) {
      adopt.run(runId, target, sequence, timestamp, row.id);
      releaseLease.run(row.id);
      sequence += 1;
    }
    return rows.length;
  }

  /**
   * Makes a failed primary replacement permanently ineligible for startup recovery
   * while retaining its run, session, and diagnostic details.
   */
  disqualifyPrimaryRun(
    id: string,
    workspace: string,
    agentId: string,
    reason: string,
  ): void {
    const result = this.db
      .prepare(
        `UPDATE runs
         SET recovery_eligible = 0,
             status = CASE WHEN status = 'active' THEN 'interrupted' ELSE status END,
             ended_at = COALESCE(ended_at, ?),
             interruption_reason = ?,
             owner_pid = NULL
         WHERE id = ? AND workspace = ? AND mode = 'agent'
           AND is_primary = 1 AND agent_id = ?`,
      )
      .run(now(), reason, id, workspace, agentId);
    if (result.changes !== 1) {
      throw new Error(`Primary agent run "${id}" could not be disqualified from recovery.`);
    }
  }

  /**
   * Atomically adopts pending mail back into the restored primary run and makes the
   * failed replacement ineligible for all future startup recovery.
   */
  rollbackPrimaryReplacement(
    failedRunId: string,
    restoredRunId: string,
    workspace: string,
    agentId: string,
    target: string,
    reason: string,
  ): number {
    return this.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE runs
           SET recovery_eligible = 0,
               status = 'interrupted',
               ended_at = COALESCE(ended_at, ?),
               interruption_reason = ?,
               owner_pid = NULL
           WHERE id = ? AND workspace = ? AND mode = 'agent'
             AND is_primary = 1 AND agent_id = ?`,
        )
        .run(now(), reason, failedRunId, workspace, agentId);
      if (result.changes !== 1) {
        throw new Error(
          `Failed primary replacement run "${failedRunId}" could not be rolled back.`,
        );
      }
      return this.adoptAgentMessagesInTransaction(
        restoredRunId,
        workspace,
        agentId,
        target,
      );
    });
  }

  /** Creates one durable run owned by one UUID-backed agent. */
  createAgentRun(
    id: string,
    agentId: string,
    alias: string,
    definition: string,
    workspace: string,
    ownerPid: number,
    isPrimary = false,
  ): void {
    try {
      this.db
        .prepare(
          `INSERT INTO runs(
             id, mode, agent_id, alias, definition, is_primary, workspace,
             status, started_at, owner_pid
           ) VALUES (?, 'agent', ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          id,
          agentId,
          alias,
          definition,
          isPrimary ? 1 : 0,
          workspace,
          now(),
          ownerPid,
        );
    } catch (error) {
      this.aliasConflict(error, alias, workspace);
    }
  }

  private agentRunRows(where: string, ...parameters: Array<string | number>): StoredAgentRun[] {
    const rows = this.db
      .prepare(
        `SELECT id, agent_id AS agentId, alias, definition, is_primary AS isPrimary,
                status, started_at AS startedAt, ended_at AS endedAt
         FROM runs
         WHERE mode = 'agent' AND agent_id IS NOT NULL AND alias IS NOT NULL AND ${where}`,
      )
      .all(...parameters) as unknown as Array<
        Omit<StoredAgentRun, "isPrimary" | "session"> & {
          isPrimary: number;
        }
      >;
    const session = this.db.prepare(
      `SELECT session_id AS sessionId, state, last_active_at AS lastActiveAt
       FROM agent_sessions WHERE run_id = ?`,
    );
    return rows.map((row) => ({
      ...row,
      isPrimary: row.isPrimary === 1,
      session: session.get(row.id) as unknown as StoredAgentSession | undefined,
    }));
  }

  /** Additional-agent runs not owned by a live host that can resume explicitly. */
  resumableAgentRuns(workspace: string, limit = 50): StoredAgentRun[] {
    return this.agentRunRows(
      `workspace = ?
         AND is_primary = 0
         AND recovery_eligible = 1
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

  /** Latest eligible inactive primary run available for this host to reclaim. */
  resumablePrimaryRun(workspace: string): StoredAgentRun | undefined {
    return this.agentRunRows(
      `workspace = ?
         AND is_primary = 1
         AND id = (
           SELECT id FROM runs AS latest
           WHERE latest.workspace = ? AND latest.mode = 'agent' AND latest.is_primary = 1
             AND latest.recovery_eligible = 1
           ORDER BY latest.started_at DESC
           LIMIT 1
         )
         AND status != 'active'
         AND definition IS NOT NULL
       LIMIT 1`,
      workspace,
      workspace,
    )[0];
  }

  /** Latest persisted run for a durable agent, active or inactive. */
  latestAgentRun(agentId: string, workspace: string): StoredAgentRun | undefined {
    return this.agentRunRows(
      `agent_id = ? AND workspace = ? AND definition IS NOT NULL
       ORDER BY started_at DESC
       LIMIT 1`,
      agentId,
      workspace,
    )[0];
  }

  latestAgentRunByAlias(alias: string, workspace: string): StoredAgentRun | undefined {
    return this.agentRunRows(
      `alias = ? AND workspace = ? AND definition IS NOT NULL
       ORDER BY started_at DESC
       LIMIT 1`,
      alias,
      workspace,
    )[0];
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
         WHERE mode = 'agent' AND is_primary = 0 AND workspace = ?
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
  ): void {
    try {
      const result = this.db
        .prepare(
          `UPDATE runs
           SET alias = ?, definition = ?
           WHERE id = ? AND mode = 'agent'`,
        )
        .run(alias, definition, id);
      if (result.changes !== 1) {
        throw new Error(`Agent run "${id}" could not be updated with a new definition.`);
      }
    } catch (error) {
      this.aliasConflict(error, alias);
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

  activityCursor(observerId: string, targetAgentId: string): ActivityCursor | undefined {
    return this.db
      .prepare(
        `SELECT session_id AS sessionId, event_cursor AS cursor, updated_at AS updatedAt
         FROM activity_cursors
         WHERE observer_id = ? AND target_agent_id = ?`,
      )
      .get(observerId, targetAgentId) as unknown as ActivityCursor | undefined;
  }

  advanceActivityCursor(
    observerId: string,
    targetAgentId: string,
    sessionId: string,
    cursor: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO activity_cursors(
           observer_id, target_agent_id, session_id, event_cursor, updated_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(observer_id, target_agent_id) DO UPDATE SET
           session_id = excluded.session_id,
           event_cursor = excluded.event_cursor,
           updated_at = excluded.updated_at`,
      )
      .run(observerId, targetAgentId, sessionId, cursor, now());
  }

  snapshot(): StateSnapshot {
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
    return { runs, sessions, messages };
  }

  close(): void {
    this.db.close();
  }
}
