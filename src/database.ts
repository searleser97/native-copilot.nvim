import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Deprecated schema-v8 primary identity retained for migration and mailbox adoption. */
const LEGACY_PRIMARY_IDENTITY = "standard";
const PRIMARY_ALIAS = "copilot";
const RESERVED_AGENT_ALIAS_INDEX = "runs_reserved_agent_alias_uq";
const AGENT_ALIAS_CONFLICT_MARKER = "agent alias reservation conflict";

type LegacyRunMode = "standard" | "agent";
export type RunStatus = "active" | "stopped" | "interrupted";
export type RunStartupState = "reserved" | "session_created" | "ready" | "failed";
export type MessageStatus = "pending" | "delivering" | "delivered" | "failed";

/**
 * Current durable schema version. Every run is one UUID-backed agent session; a
 * minimal primary marker identifies the agent attached to the main UI buffer.
 */
const SCHEMA_VERSION = 11;

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

export interface ClaimedMessage extends StoredMessage {
  deliveryAttempts: number;
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
  startupState: RunStartupState;
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

export interface AgentRunReservation {
  id: string;
  agentId: string;
  alias: string;
  definition: string;
  workspace: string;
  ownerPid: number;
  isPrimary?: boolean;
}

export interface AgentRunDefinitionUpdate {
  id: string;
  alias: string;
  definition: string;
}

export class AgentAliasConflictError extends Error {
  readonly code = "AGENT_ALIAS_CONFLICT";

  constructor(
    readonly alias: string,
    readonly workspace: string | undefined,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentAliasConflictError";
  }
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
   * v6-v10 agent runs and mailboxes are migrated in place. A database written by a
   * newer host is never erased.
   */
  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = OFF;
    `);
    // SQLite ignores PRAGMA foreign_keys changes inside a transaction. Disable it
    // before taking the migration write lock so the pre-v6 rebuild remains legal,
    // then keep every schema read and mutation under that same lock.
    let transactionStarted = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_meta (
          version INTEGER NOT NULL
        );
        INSERT INTO schema_meta(version)
        SELECT ${SCHEMA_VERSION}
        WHERE NOT EXISTS (SELECT 1 FROM schema_meta);
      `);
      // A concurrent migrator may have completed while this connection waited for
      // BEGIN IMMEDIATE. Always read the authoritative version after acquiring it.
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
        this.db.exec(`
          DROP TABLE IF EXISTS activity_cursors;
          DROP TABLE IF EXISTS checkpoints;
          DROP TABLE IF EXISTS delivery_leases;
          DROP TABLE IF EXISTS messages;
          DROP TABLE IF EXISTS events;
          DROP TABLE IF EXISTS member_sessions;
          DROP TABLE IF EXISTS agent_sessions;
          DROP TABLE IF EXISTS runs;
        `);
      }
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
          startup_state TEXT NOT NULL DEFAULT 'ready'
            CHECK(startup_state IN ('reserved', 'session_created', 'ready', 'failed')),
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
        if (schema.version === 6 && !this.hasColumn("runs", "standard_can_observe")) {
          this.db.exec(
            "ALTER TABLE runs ADD COLUMN standard_can_observe INTEGER NOT NULL DEFAULT 0",
          );
        }
        if (!this.hasColumn("runs", "is_primary")) {
          this.db.exec("ALTER TABLE runs ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0");
        }
        if (!this.hasColumn("runs", "startup_state")) {
          this.db.exec(
            `ALTER TABLE runs ADD COLUMN startup_state TEXT NOT NULL DEFAULT 'ready'
             CHECK(startup_state IN ('reserved', 'session_created', 'ready', 'failed'))`,
          );
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
        if (schema.version < 11) {
          this.classifyIncompleteStartups();
        }
        this.assertAgentAliasState();
        if (schema.version < 9) {
          this.migrateLegacyAgentState();
        }
        if (schema.version < 11) {
          // Legacy Standard conversion can create one more no-session agent row.
          this.classifyIncompleteStartups();
        }
      }
      this.db.prepare("UPDATE schema_meta SET version = ?").run(SCHEMA_VERSION);
      this.db.exec("COMMIT");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        this.db.exec("ROLLBACK");
      }
      throw error;
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
    this.ensureAgentAliasConstraints();
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
      name: string;
    }>;
    return rows.some((row) => row.name === column);
  }

  private classifyIncompleteStartups(): void {
    // Schema-v10 could persist a definition before SDK session creation.
    // Preserve a live owner's reservation, but classify it as unfinished so
    // stale-owner cleanup releases it. Inactive no-session rows are already
    // failed startups and must stop reserving aliases immediately.
    this.db.exec(`
      UPDATE runs
      SET startup_state = 'reserved', recovery_eligible = 0
      WHERE mode = 'agent' AND status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM agent_sessions WHERE agent_sessions.run_id = runs.id
        );

      UPDATE runs
      SET definition = NULL,
          startup_state = 'failed',
          recovery_eligible = 0
      WHERE mode = 'agent' AND status != 'active'
        AND NOT EXISTS (
          SELECT 1 FROM agent_sessions WHERE agent_sessions.run_id = runs.id
        );

      UPDATE messages
      SET status = 'failed', updated_at = CURRENT_TIMESTAMP
      WHERE status IN ('pending', 'delivering')
        AND run_id IN (
          SELECT id FROM runs
          WHERE mode = 'agent' AND startup_state = 'failed'
        );

      DELETE FROM delivery_leases
      WHERE message_id IN (
        SELECT messages.id
        FROM messages
        JOIN runs ON runs.id = messages.run_id
        WHERE runs.mode = 'agent' AND runs.startup_state = 'failed'
      );
    `);
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

    const primaryCollisions = this.db
      .prepare(
        `SELECT primary_run.workspace, primary_run.alias,
                primary_run.id AS primaryRunId, worker_run.id AS workerRunId
         FROM runs AS primary_run
         JOIN runs AS worker_run
           ON worker_run.workspace = primary_run.workspace
          AND worker_run.alias = primary_run.alias
         WHERE primary_run.mode = 'agent' AND primary_run.is_primary = 1
           AND primary_run.alias IS NOT NULL
           AND primary_run.agent_id IS NOT NULL
           AND primary_run.definition IS NOT NULL
           AND worker_run.mode = 'agent' AND worker_run.is_primary = 0
           AND worker_run.alias IS NOT NULL
           AND worker_run.agent_id IS NOT NULL
           AND worker_run.definition IS NOT NULL
         ORDER BY primary_run.workspace, primary_run.alias,
                  primary_run.started_at DESC, worker_run.started_at DESC`,
      )
      .all() as unknown as Array<{
        workspace: string;
        alias: string;
        primaryRunId: string;
        workerRunId: string;
      }>;
    if (primaryCollisions.length > 0) {
      const details = primaryCollisions
        .map(
          (conflict) =>
            `alias "${conflict.alias}" in workspace "${conflict.workspace}" is shared by ` +
            `primary run "${conflict.primaryRunId}" and non-primary run ` +
            `"${conflict.workerRunId}"`,
        )
        .join("; ");
      throw new Error(
        `The Copilot state database contains primary/non-primary alias collisions: ${details}. ` +
          "Resolve the conflicting persisted aliases before starting native-copilot.nvim.",
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

          CREATE TRIGGER IF NOT EXISTS runs_primary_alias_reservation_insert
          BEFORE INSERT ON runs
          WHEN NEW.mode = 'agent' AND NEW.is_primary = 1
            AND NEW.alias IS NOT NULL AND NEW.agent_id IS NOT NULL
            AND NEW.definition IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM runs AS reserved
              WHERE reserved.workspace = NEW.workspace
                AND reserved.alias = NEW.alias
                AND reserved.mode = 'agent' AND reserved.is_primary = 0
                AND reserved.alias IS NOT NULL
                AND reserved.agent_id IS NOT NULL
                AND reserved.definition IS NOT NULL
            )
          BEGIN
            SELECT RAISE(ABORT, '${AGENT_ALIAS_CONFLICT_MARKER}');
          END;

          CREATE TRIGGER IF NOT EXISTS runs_primary_alias_reservation_update
          BEFORE UPDATE OF mode, is_primary, workspace, alias, agent_id, definition ON runs
          WHEN NEW.mode = 'agent' AND NEW.is_primary = 1
            AND NEW.alias IS NOT NULL AND NEW.agent_id IS NOT NULL
            AND NEW.definition IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM runs AS reserved
              WHERE reserved.id != NEW.id
                AND reserved.workspace = NEW.workspace
                AND reserved.alias = NEW.alias
                AND reserved.mode = 'agent' AND reserved.is_primary = 0
                AND reserved.alias IS NOT NULL
                AND reserved.agent_id IS NOT NULL
                AND reserved.definition IS NOT NULL
            )
          BEGIN
            SELECT RAISE(ABORT, '${AGENT_ALIAS_CONFLICT_MARKER}');
          END;

          CREATE TRIGGER IF NOT EXISTS runs_non_primary_alias_reservation_insert
          BEFORE INSERT ON runs
          WHEN NEW.mode = 'agent' AND NEW.is_primary = 0
            AND NEW.alias IS NOT NULL AND NEW.agent_id IS NOT NULL
            AND NEW.definition IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM runs AS reserved
              WHERE reserved.workspace = NEW.workspace
                AND reserved.alias = NEW.alias
                AND reserved.mode = 'agent' AND reserved.is_primary = 1
                AND reserved.alias IS NOT NULL
                AND reserved.agent_id IS NOT NULL
                AND reserved.definition IS NOT NULL
            )
          BEGIN
            SELECT RAISE(ABORT, '${AGENT_ALIAS_CONFLICT_MARKER}');
          END;

          CREATE TRIGGER IF NOT EXISTS runs_non_primary_alias_reservation_update
          BEFORE UPDATE OF mode, is_primary, workspace, alias, agent_id, definition ON runs
          WHEN NEW.mode = 'agent' AND NEW.is_primary = 0
            AND NEW.alias IS NOT NULL AND NEW.agent_id IS NOT NULL
            AND NEW.definition IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM runs AS reserved
              WHERE reserved.id != NEW.id
                AND reserved.workspace = NEW.workspace
                AND reserved.alias = NEW.alias
                AND reserved.mode = 'agent' AND reserved.is_primary = 1
                AND reserved.alias IS NOT NULL
                AND reserved.agent_id IS NOT NULL
                AND reserved.definition IS NOT NULL
            )
          BEGIN
            SELECT RAISE(ABORT, '${AGENT_ALIAS_CONFLICT_MARKER}');
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
      message.includes(AGENT_ALIAS_CONFLICT_MARKER) ||
      message.includes(`agent alias "${LEGACY_PRIMARY_IDENTITY}" is reserved`)
    );
  }

  private aliasConflict(error: unknown, alias: string, workspace?: string): never {
    if (!this.isAliasConstraintFailure(error)) {
      throw error;
    }
    if (alias === LEGACY_PRIMARY_IDENTITY) {
      throw new AgentAliasConflictError(
        alias,
        workspace,
        `Alias "${alias}" is reserved for primary-agent compatibility and cannot be assigned ` +
          "to an agent.",
        { cause: error },
      );
    }
    throw new AgentAliasConflictError(
      alias,
      workspace,
      `Alias "${alias}" is already reserved by another primary or recoverable agent` +
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
      isPrimary: number;
      legacyPrimaryCanTalk: number;
      legacyPrimaryCanObserve: number;
    };
    const runs = this.db
      .prepare(
        `SELECT id, mode, agent_id AS agentId, alias, definition, workspace,
                is_primary AS isPrimary,
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
    const primaryRunsToConvert = new Set<string>();
    // A partially completed or defensively repeated migration must adopt the
    // primary that already exists instead of promoting another legacy Standard
    // row in the same workspace.
    for (const run of runs) {
      if (
        run.mode === "agent" &&
        run.isPrimary === 1 &&
        run.agentId &&
        run.alias &&
        !primaryByWorkspace.has(run.workspace)
      ) {
        primaryByWorkspace.set(run.workspace, {
          agentId: run.agentId,
          runId: run.id,
          alias: run.alias,
        });
      }
    }
    for (const run of runs) {
      if (run.mode !== "standard" || primaryByWorkspace.has(run.workspace)) {
        continue;
      }
      primaryByWorkspace.set(run.workspace, {
        agentId: randomUUID(),
        runId: run.id,
        alias: PRIMARY_ALIAS,
      });
      primaryRunsToConvert.add(run.id);
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
      if (!primaryRunsToConvert.has(primary.runId)) {
        workspaceByAgentId.set(primary.agentId, workspace);
        continue;
      }
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
          canTalkToAgentIds?: unknown;
          canObserveAgentIds?: unknown;
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
        const canTalkToAgentIds = new Set(resolveSelectors(canTalkTo, run.workspace));
        if (Array.isArray(parsed.canTalkToAgentIds)) {
          for (const persistedAgentId of parsed.canTalkToAgentIds) {
            if (typeof persistedAgentId === "string") {
              canTalkToAgentIds.add(persistedAgentId);
            }
          }
        }
        const canObserveAgentIds = new Set(resolveSelectors(canObserve, run.workspace));
        if (Array.isArray(parsed.canObserveAgentIds)) {
          for (const persistedAgentId of parsed.canObserveAgentIds) {
            if (typeof persistedAgentId === "string") {
              canObserveAgentIds.add(persistedAgentId);
            }
          }
        }
        const definition = {
          ...parsed.definition,
          canTalkTo: [...canTalkToAgentIds].map((agentId) => `agent:${agentId}`),
          canObserve: [...canObserveAgentIds].map((agentId) => `agent:${agentId}`),
        };
        updateDefinition.run(
          JSON.stringify({
            definition,
            mcpServers: Array.isArray(parsed.mcpServers) ? parsed.mcpServers : [],
            canTalkToAgentIds: [...canTalkToAgentIds],
            canObserveAgentIds: [...canObserveAgentIds],
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
       WHERE id = ? AND mode = 'standard' AND is_primary = 0`,
    );
    const updatePrimaryMessages = this.db.prepare(
      `UPDATE messages SET target = ?, source = CASE WHEN source = ? THEN ? ELSE source END
       WHERE run_id = ?`,
    );
    for (const [workspace, primary] of primaryByWorkspace) {
      if (!primaryRunsToConvert.has(primary.runId)) {
        continue;
      }
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
      const converted = convertPrimary.run(
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
      if (converted.changes !== 1) {
        continue;
      }
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
    return this.transaction(() => {
      const timestamp = now();
      const active = this.db
        .prepare(
          `SELECT id, owner_pid AS ownerPid, startup_state AS startupState
           FROM runs WHERE status = 'active'`,
        )
        .all() as unknown as Array<{
          id: string;
          ownerPid: number | null;
          startupState: RunStartupState;
        }>;
      const stale = active.filter(
        (run) => run.ownerPid === null || !ownerIsAlive(run.ownerPid),
      );
      if (stale.length === 0) {
        return 0;
      }
      const readyIds = stale
        .filter((run) => run.startupState === "ready")
        .map((run) => run.id);
      const startupIds = stale
        .filter((run) => run.startupState !== "ready")
        .map((run) => run.id);
      const interrupt = this.db.prepare(
        `UPDATE runs
         SET status = 'interrupted', ended_at = ?, interruption_reason = ?, owner_pid = NULL
         WHERE id = ? AND status = 'active'`,
      );
      for (const id of readyIds) {
        interrupt.run(timestamp, reason, id);
      }
      const failStartup = this.db.prepare(
        `UPDATE runs
         SET definition = NULL,
             startup_state = 'failed',
             recovery_eligible = 0,
             status = 'interrupted',
             ended_at = ?,
             interruption_reason = ?,
             owner_pid = NULL
         WHERE id = ? AND status = 'active' AND startup_state != 'ready'`,
      );
      for (const id of startupIds) {
        failStartup.run(timestamp, `${reason} during agent startup`, id);
      }
      if (readyIds.length > 0) {
        const placeholders = readyIds.map(() => "?").join(", ");
        this.db
          .prepare(
            `UPDATE messages
             SET status = 'pending', updated_at = ?
             WHERE status = 'delivering'
               AND run_id IN (${placeholders})`,
          )
          .run(timestamp, ...readyIds);
      }
      if (startupIds.length > 0) {
        const placeholders = startupIds.map(() => "?").join(", ");
        this.db
          .prepare(
            `UPDATE messages
             SET status = 'failed', updated_at = ?
             WHERE status IN ('pending', 'delivering')
               AND run_id IN (${placeholders})`,
          )
          .run(timestamp, ...startupIds);
      }
      const staleIds = stale.map((run) => run.id);
      const placeholders = staleIds.map(() => "?").join(", ");
      this.db
        .prepare(
        `DELETE FROM delivery_leases
         WHERE message_id IN (SELECT id FROM messages WHERE run_id IN (${placeholders}))`,
        )
        .run(...staleIds);
      return staleIds.length;
    });
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
             startup_state = 'failed',
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
   * Atomically disqualifies a failed replacement, adopts pending mail back into the
   * previous primary run, and reactivates that run for the current owner.
   */
  rollbackPrimaryReplacement(
    failedRunId: string,
    restoredRunId: string,
    workspace: string,
    agentId: string,
    target: string,
    ownerPid: number,
    reason: string,
  ): number {
    if (failedRunId === restoredRunId) {
      throw new Error("A failed primary replacement cannot restore the same run.");
    }
    return this.transaction(() => {
      const timestamp = now();
      const result = this.db
        .prepare(
          `UPDATE runs
           SET recovery_eligible = 0,
               startup_state = 'failed',
               status = 'interrupted',
               ended_at = COALESCE(ended_at, ?),
               interruption_reason = ?,
               owner_pid = NULL
           WHERE id = ? AND workspace = ? AND mode = 'agent'
             AND is_primary = 1 AND agent_id = ?`,
        )
        .run(timestamp, reason, failedRunId, workspace, agentId);
      if (result.changes !== 1) {
        throw new Error(
          `Failed primary replacement run "${failedRunId}" could not be rolled back.`,
        );
      }
      const adoptedMessages = this.adoptAgentMessagesInTransaction(
        restoredRunId,
        workspace,
        agentId,
        target,
      );
      const restored = this.db
        .prepare(
          `UPDATE runs
           SET recovery_eligible = 1,
               startup_state = 'ready',
               status = 'active',
               ended_at = NULL,
               interruption_reason = NULL,
               owner_pid = ?
           WHERE id = ? AND workspace = ? AND mode = 'agent'
             AND is_primary = 1 AND agent_id = ? AND status != 'active'
             AND EXISTS (SELECT 1 FROM agent_sessions WHERE run_id = runs.id)`,
        )
        .run(ownerPid, restoredRunId, workspace, agentId);
      if (restored.changes !== 1) {
        throw new Error(
          `Previous primary agent run "${restoredRunId}" could not be reactivated.`,
        );
      }
      return adoptedMessages;
    });
  }

  /** Atomically reserves every durable run in a newly accepted agent batch. */
  createAgentRuns(runs: readonly AgentRunReservation[]): void {
    if (runs.length === 0) {
      return;
    }
    let current: AgentRunReservation | undefined;
    try {
      this.transaction(() => {
        const insert = this.db.prepare(
          `INSERT INTO runs(
             id, mode, agent_id, alias, definition, is_primary, startup_state,
             recovery_eligible, workspace, status, started_at, owner_pid
           ) VALUES (?, 'agent', ?, ?, ?, ?, 'reserved', 0, ?, 'active', ?, ?)`,
        );
        for (const run of runs) {
          current = run;
          insert.run(
            run.id,
            run.agentId,
            run.alias,
            run.definition,
            run.isPrimary === true ? 1 : 0,
            run.workspace,
            now(),
            run.ownerPid,
          );
        }
      });
    } catch (error) {
      if (current) {
        this.aliasConflict(error, current.alias, current.workspace);
      }
      throw error;
    }
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
    this.createAgentRuns([
      {
        id,
        agentId,
        alias,
        definition,
        workspace,
        ownerPid,
        isPrimary,
      },
    ]);
  }

  /**
   * Atomically makes a no-session worker batch non-reserving after its caller ACL
   * update fails, so none of its aliases can be stranded.
   */
  abandonAgentRunReservations(
    runIds: readonly string[],
    workspace: string,
    reason: string,
  ): void {
    const ids = [...new Set(runIds)];
    if (ids.length === 0) {
      return;
    }
    if (ids.length !== runIds.length) {
      throw new Error("Agent run reservation ids must be unique.");
    }
    this.transaction(() => {
      const placeholders = ids.map(() => "?").join(", ");
      const result = this.db
        .prepare(
          `UPDATE runs
           SET definition = NULL,
               startup_state = 'failed',
               recovery_eligible = 0,
               status = 'interrupted',
               ended_at = COALESCE(ended_at, ?),
               interruption_reason = ?,
               owner_pid = NULL
           WHERE workspace = ? AND mode = 'agent' AND is_primary = 0
             AND id IN (${placeholders})
             AND NOT EXISTS (
               SELECT 1 FROM agent_sessions WHERE agent_sessions.run_id = runs.id
             )`,
        )
        .run(now(), reason, workspace, ...ids);
      if (result.changes !== ids.length) {
        throw new Error(
          "The no-session agent batch could not be abandoned safely; no aliases were released.",
        );
      }
    });
  }

  /**
   * Atomically releases a run whose SDK startup never completed and removes that
   * failed UUID from every related caller/peer ACL persisted by the same batch.
   */
  failAgentStartup(
    id: string,
    workspace: string,
    agentId: string,
    reason: string,
    relatedRuns: readonly AgentRunDefinitionUpdate[],
  ): void {
    this.transaction(() => {
      const timestamp = now();
      const failed = this.db
        .prepare(
          `UPDATE runs
           SET definition = NULL,
               startup_state = 'failed',
               recovery_eligible = 0,
               status = 'interrupted',
               ended_at = COALESCE(ended_at, ?),
               interruption_reason = ?,
               owner_pid = NULL
           WHERE id = ? AND workspace = ? AND mode = 'agent' AND agent_id = ?
             AND startup_state != 'ready'`,
        )
        .run(timestamp, reason, id, workspace, agentId);
      if (failed.changes !== 1) {
        throw new Error(
          `Agent run "${id}" could not be released after its startup failed.`,
        );
      }
      this.db
        .prepare(
          `UPDATE messages
           SET status = 'failed', updated_at = ?
           WHERE run_id = ? AND status IN ('pending', 'delivering')`,
        )
        .run(timestamp, id);
      this.db
        .prepare(
          `DELETE FROM delivery_leases
           WHERE message_id IN (SELECT id FROM messages WHERE run_id = ?)`,
        )
        .run(id);

      const updateDefinition = this.db.prepare(
        `UPDATE runs
         SET alias = ?, definition = ?
         WHERE id = ? AND workspace = ? AND mode = 'agent' AND definition IS NOT NULL`,
      );
      for (const related of relatedRuns) {
        if (related.id === id) {
          throw new Error("A failed startup run cannot update its own released definition.");
        }
        const updated = updateDefinition.run(
          related.alias,
          related.definition,
          related.id,
          workspace,
        );
        if (updated.changes !== 1) {
          throw new Error(
            `Related agent run "${related.id}" could not remove failed startup ACL "${agentId}".`,
          );
        }
      }
    });
  }

  private agentRunRows(where: string, ...parameters: Array<string | number>): StoredAgentRun[] {
    const rows = this.db
      .prepare(
        `SELECT id, agent_id AS agentId, alias, definition, is_primary AS isPrimary,
                startup_state AS startupState, status,
                started_at AS startedAt, ended_at AS endedAt
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
         AND startup_state = 'ready'
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
             AND latest.startup_state = 'ready'
             AND EXISTS (
               SELECT 1 FROM agent_sessions
               WHERE agent_sessions.run_id = latest.id
             )
           ORDER BY latest.started_at DESC
           LIMIT 1
         )
         AND status != 'active'
         AND startup_state = 'ready'
         AND definition IS NOT NULL
         AND EXISTS (SELECT 1 FROM agent_sessions WHERE run_id = runs.id)
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
         WHERE id = ? AND mode = 'agent' AND status != 'active'
           AND recovery_eligible = 1 AND startup_state = 'ready'
           AND EXISTS (SELECT 1 FROM agent_sessions WHERE run_id = runs.id)`,
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
    this.transaction(() => {
      const timestamp = now();
      const row = this.db
        .prepare(
          "SELECT startup_state AS startupState FROM runs WHERE id = ? AND status = 'active'",
        )
        .get(id) as { startupState: RunStartupState } | undefined;
      if (!row) {
        return;
      }
      const startupFailed = row.startupState !== "ready";
      this.db
        .prepare(
          `UPDATE runs
           SET status = ?,
               ended_at = ?,
               interruption_reason = ?,
               definition = CASE WHEN ? = 1 THEN NULL ELSE definition END,
               startup_state = CASE WHEN ? = 1 THEN 'failed' ELSE startup_state END,
               recovery_eligible = CASE WHEN ? = 1 THEN 0 ELSE recovery_eligible END,
               owner_pid = NULL
           WHERE id = ? AND status = 'active'`,
        )
        .run(
          status,
          timestamp,
          reason ?? null,
          startupFailed ? 1 : 0,
          startupFailed ? 1 : 0,
          startupFailed ? 1 : 0,
          id,
        );
      if (!startupFailed) {
        return;
      }
      this.db
        .prepare(
          `UPDATE messages
           SET status = 'failed', updated_at = ?
           WHERE run_id = ? AND status IN ('pending', 'delivering')`,
        )
        .run(timestamp, id);
      this.db
        .prepare(
          `DELETE FROM delivery_leases
           WHERE message_id IN (SELECT id FROM messages WHERE run_id = ?)`,
        )
        .run(id);
    });
  }

  /** Persists the single SDK session owned by a run. */
  upsertSession(runId: string, sessionId: string, state: string): void {
    this.transaction(() => {
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
      this.db
        .prepare(
          `UPDATE runs SET startup_state = 'session_created'
           WHERE id = ? AND mode = 'agent' AND startup_state = 'reserved'`,
        )
        .run(runId);
    });
  }

  /** Makes a run recoverable only after its SDK session and initial task are accepted. */
  completeRunStartup(runId: string): void {
    const result = this.db
      .prepare(
        `UPDATE runs
         SET startup_state = 'ready', recovery_eligible = 1
         WHERE id = ? AND mode = 'agent' AND status = 'active'
           AND startup_state IN ('reserved', 'session_created')
           AND EXISTS (SELECT 1 FROM agent_sessions WHERE run_id = runs.id)
           AND (
             is_primary = 1
             OR EXISTS (
               SELECT 1 FROM messages
               WHERE messages.run_id = runs.id
                 AND messages.kind = 'user'
                 AND messages.status = 'delivered'
             )
           )`,
      )
      .run(runId);
    if (result.changes !== 1) {
      const current = this.db
        .prepare(
          `SELECT startup_state AS startupState, recovery_eligible AS recoveryEligible
           FROM runs WHERE id = ? AND mode = 'agent'`,
        )
        .get(runId) as { startupState: RunStartupState; recoveryEligible: number } | undefined;
      if (current?.startupState === "ready" && current.recoveryEligible === 1) {
        return;
      }
      throw new Error(
        `Agent run "${runId}" cannot become recoverable before its SDK session and initial ` +
          "task are accepted.",
      );
    }
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

  claimMessages(runId: string, target: string, limit = 1, leaseMs = 60_000): ClaimedMessage[] {
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
      const attempts = this.db.prepare(
        "SELECT attempts FROM delivery_leases WHERE message_id = ?",
      );
      return rows.map((row) => ({
        ...row,
        deliveryAttempts:
          (attempts.get(row.id) as { attempts: number } | undefined)?.attempts ?? 1,
      }));
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
