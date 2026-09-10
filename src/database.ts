import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Deprecated schema-v8 primary identity retained for migration and mailbox adoption. */
const LEGACY_PRIMARY_IDENTITY = "standard";
const CALLER_ALIAS = "caller";
const PRIMARY_ALIAS = "copilot";
const AGENT_ALIAS_PATTERN = /^[a-z][a-z0-9_]*$/;
const RESERVED_AGENT_ALIAS_INDEX = "runs_reserved_agent_alias_uq";
const AGENT_ALIAS_CONFLICT_MARKER = "agent alias reservation conflict";
const INCOMPLETE_MIGRATION_STARTUP_REASON =
  "Incomplete agent startup found during schema migration";
const LEGACY_PRIMARY_STAGED_REASON =
  "Legacy primary session was unavailable; pending mail retained for adoption";
const OBSOLETE_LEGACY_PRIMARY_REASON =
  "Obsolete legacy primary state repaired by schema v14";
const OBSOLETE_LEGACY_PRIMARY_REASONS = new Set([
  "Obsolete legacy primary state repaired by schema v13",
  OBSOLETE_LEGACY_PRIMARY_REASON,
]);

type LegacyRunMode = "standard" | "agent";
export type OwnerIsAlive = (pid: number) => boolean;
export type RunStatus = "active" | "stopped" | "interrupted";
export type RunStartupState = "reserved" | "session_created" | "ready" | "failed";
export type MessageStatus = "pending" | "delivering" | "delivered" | "failed";

/**
 * Current durable schema version. Every run is one UUID-backed agent session; a
 * minimal primary marker identifies the agent attached to the main UI buffer.
 */
const SCHEMA_VERSION = 14;

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
  leaseToken: string;
  leaseUntil: string;
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
  primaryPredecessorRunId: string | null;
  primaryClaimToken: string | null;
  session: StoredAgentSession | undefined;
}

export interface PrimaryStartupClaim {
  predecessorRunId: string;
  token: string;
}

export interface ClaimedPrimaryRun {
  run: StoredAgentRun;
  claim?: PrimaryStartupClaim;
}

export type PrimaryDefinitionFactory = (
  stagedDefinition: string | undefined,
  alias: string,
  agentId: string,
) => string;

export interface StoredSessionOwner {
  sessionId: string;
  agentId: string;
  workspace: string;
  runIds: string[];
}

interface SessionOwnershipRow {
  sessionId: string;
  agentId: string;
  workspace: string;
  runId: string;
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

function primaryAliasCandidate(attempt: number): string {
  if (attempt === 0) {
    return PRIMARY_ALIAS;
  }
  if (attempt === 1) {
    return "primary";
  }
  return `primary_${attempt}`;
}

/**
 * Probes a process without signalling it. Only an explicit "no such process"
 * result is treated as dead; access-denied and unknown OS failures stay live so
 * recovery and migration fail closed on Windows.
 */
export function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

export class AgentDatabase {
  readonly db: DatabaseSync;
  private readonly ownerIsAlive: OwnerIsAlive;

  constructor(path: string, ownerIsAlive: OwnerIsAlive = processIsAlive) {
    this.ownerIsAlive = ownerIsAlive;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      this.migrate(ownerIsAlive);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /**
   * Brings the database to {@link SCHEMA_VERSION}. Pre-v6 state is rebuilt as before;
   * v6-v13 agent runs and mailboxes are migrated in place. A database written by a
   * newer host is never erased.
   */
  private migrate(ownerIsAlive: OwnerIsAlive): void {
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
      if (schema.version < SCHEMA_VERSION) {
        // Older hosts do not re-read schema_meta after startup. Refuse the version
        // flip while one still owns active work; the v12 NOT NULL lease columns
        // then make any startup race from an older writer fail closed.
        this.assertNoLiveMigrationOwners(schema.version, ownerIsAlive);
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
          owner_pid INTEGER,
          primary_predecessor_run_id TEXT,
          primary_claim_token TEXT
        );
        CREATE INDEX IF NOT EXISTS runs_agent_idx ON runs(agent_id);

        CREATE TABLE IF NOT EXISTS agent_sessions (
          run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
          session_id TEXT NOT NULL,
          state TEXT NOT NULL,
          last_active_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS agent_sessions_session_idx
          ON agent_sessions(session_id);

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
          run_id TEXT NOT NULL,
          target TEXT NOT NULL,
          lease_token TEXT NOT NULL,
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
        if (schema.version < 12) {
          this.migrateDeliveryLeases();
        }
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
        if (!this.hasColumn("runs", "primary_predecessor_run_id")) {
          this.db.exec("ALTER TABLE runs ADD COLUMN primary_predecessor_run_id TEXT");
        }
        if (!this.hasColumn("runs", "primary_claim_token")) {
          this.db.exec("ALTER TABLE runs ADD COLUMN primary_claim_token TEXT");
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
        let preservedLegacyPrimaryRunIds = new Set<string>();
        if (schema.version < 9) {
          preservedLegacyPrimaryRunIds = this.migrateLegacyAgentState();
        } else {
          preservedLegacyPrimaryRunIds = this.repairLegacyPrimaryStateV14();
        }
        // Legacy Standard mail and ACLs must be adopted before classification so
        // a failed/sessionless generic primary cannot hide an older viable session.
        this.classifyLegacyStartups(preservedLegacyPrimaryRunIds);
        this.scrubGhostAclsInTransaction();
        this.assertAgentAliasState();
      }
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS runs_primary_predecessor_idx
          ON runs(primary_predecessor_run_id);
        CREATE INDEX IF NOT EXISTS runs_primary_claim_token_idx
          ON runs(primary_claim_token);
      `);
      this.assertSessionOwnershipState();
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

  private assertNoLiveMigrationOwners(
    schemaVersion: number,
    ownerIsAlive: OwnerIsAlive,
  ): void {
    if (
      !this.hasColumn("runs", "status") ||
      !this.hasColumn("runs", "owner_pid")
    ) {
      return;
    }
    const active = this.db
      .prepare(
        `SELECT DISTINCT owner_pid AS ownerPid
         FROM runs
         WHERE status = 'active' AND owner_pid IS NOT NULL`,
      )
      .all() as unknown as Array<{ ownerPid: number }>;
    const live = active.filter((run) => {
      try {
        return ownerIsAlive(run.ownerPid);
      } catch {
        return true;
      }
    });
    if (live.length === 0) {
      return;
    }
    const owners = [...new Set(live.map((run) => run.ownerPid))]
      .sort((left, right) => left - right);
    throw new Error(
      `Restart required: cannot migrate the Copilot state database from schema version ` +
        `${schemaVersion} to ${SCHEMA_VERSION} while active runs are owned by live host ` +
        `process${owners.length === 1 ? "" : "es"} ${owners.join(", ")}. Close every Neovim ` +
        "instance using this database, then start native-copilot.nvim again. The migration was " +
        "deferred without changing run, message, or delivery-lease state.",
    );
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
      name: string;
    }>;
    return rows.some((row) => row.name === column);
  }

  private migrateDeliveryLeases(): void {
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE messages
         SET status = 'pending', updated_at = ?
         WHERE status = 'delivering'`,
      )
      .run(timestamp);
    this.db.exec(`
      DROP TABLE IF EXISTS delivery_leases;
      CREATE TABLE delivery_leases (
        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        target TEXT NOT NULL,
        lease_token TEXT NOT NULL,
        lease_until TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
    `);
  }

  /**
   * Repairs legacy-primary state left by pre-v14 migrations. In addition to
   * adopting a surviving Standard session, this reconstructs a staged primary
   * from migration-failed generic rows after every Standard row has already been
   * consumed. It is safe to repeat inside the migration transaction.
   */
  private repairLegacyPrimaryStateV14(): Set<string> {
    type RepairRun = {
      id: string;
      mode: LegacyRunMode;
      agentId: string | null;
      alias: string | null;
      definition: string | null;
      workspace: string;
      status: RunStatus;
      startedAt: string;
      endedAt: string | null;
      interruptionReason: string | null;
      isPrimary: number;
      startupState: RunStartupState;
      recoveryEligible: number;
      legacyPrimaryCanTalk: number;
      legacyPrimaryCanObserve: number;
      sessionId: string | null;
    };
    type ParsedDefinition = {
      record: Record<string, unknown>;
      definition: Record<string, unknown>;
      mcpServers: string[];
      canTalkTo: string[];
      canObserve: string[];
      canTalkToAgentIds: string[];
      canObserveAgentIds: string[];
      standardCanTalk: boolean;
      standardCanObserve: boolean;
    };

    const runs = this.db
      .prepare(
        `SELECT runs.id, runs.mode, runs.agent_id AS agentId, runs.alias,
                runs.definition, runs.workspace, runs.status,
                runs.started_at AS startedAt,
                runs.ended_at AS endedAt,
                runs.interruption_reason AS interruptionReason,
                runs.is_primary AS isPrimary,
                runs.startup_state AS startupState,
                runs.recovery_eligible AS recoveryEligible,
                runs.standard_can_talk AS legacyPrimaryCanTalk,
                runs.standard_can_observe AS legacyPrimaryCanObserve,
                agent_sessions.session_id AS sessionId
         FROM runs
         LEFT JOIN agent_sessions ON agent_sessions.run_id = runs.id
         ORDER BY runs.workspace, runs.started_at DESC, runs.id DESC`,
      )
      .all() as unknown as RepairRun[];
    const runsByWorkspace = new Map<string, RepairRun[]>();
    for (const run of runs) {
      const workspaceRuns = runsByWorkspace.get(run.workspace) ?? [];
      workspaceRuns.push(run);
      runsByWorkspace.set(run.workspace, workspaceRuns);
    }

    const parseDefinition = (run: RepairRun): ParsedDefinition | undefined => {
      if (run.definition === null) {
        return undefined;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(run.definition);
      } catch (error) {
        throw new Error(
          `Stored agent run "${run.id}" contains invalid JSON during schema-v14 ` +
            "legacy-primary repair.",
          { cause: error },
        );
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(
          `Stored agent run "${run.id}" is not an object during schema-v14 ` +
            "legacy-primary repair.",
        );
      }
      const record = { ...(parsed as Record<string, unknown>) };
      if (
        typeof record.definition !== "object" ||
        record.definition === null ||
        Array.isArray(record.definition)
      ) {
        throw new Error(
          `Stored agent run "${run.id}" has no valid definition during schema-v14 ` +
            "legacy-primary repair.",
        );
      }
      const definition = {
        ...(record.definition as Record<string, unknown>),
      };
      const stringArray = (
        value: unknown,
        field: string,
        optional = false,
      ): string[] => {
        if (value === undefined && optional) {
          return [];
        }
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
          throw new Error(
            `Stored agent run "${run.id}" has an invalid ${field} during schema-v14 ` +
              "legacy-primary repair.",
          );
        }
        return [...value] as string[];
      };
      const booleanValue = (value: unknown, field: string): boolean => {
        if (value === undefined) {
          return false;
        }
        if (typeof value !== "boolean") {
          throw new Error(
            `Stored agent run "${run.id}" has an invalid ${field} during schema-v14 ` +
              "legacy-primary repair.",
          );
        }
        return value;
      };
      for (const field of [
        "id",
        "displayName",
        "description",
        "task",
        "prompt",
      ] as const) {
        const value = definition[field];
        if (typeof value !== "string" || value.length === 0) {
          throw new Error(
            `Stored agent run "${run.id}" has an invalid definition.${field} during ` +
              "schema-v14 legacy-primary repair.",
          );
        }
      }
      if (
        run.isPrimary === 0 &&
        (
          run.alias === null ||
          definition.id !== run.alias ||
          !AGENT_ALIAS_PATTERN.test(run.alias)
        )
      ) {
        throw new Error(
          `Stored non-primary run "${run.id}" has an inconsistent alias during schema-v14 ` +
            "legacy-primary repair.",
        );
      }
      return {
        record,
        definition,
        mcpServers: stringArray(record.mcpServers, "mcpServers", true),
        canTalkTo: stringArray(definition.canTalkTo, "definition.canTalkTo"),
        canObserve: stringArray(
          definition.canObserve,
          "definition.canObserve",
          true,
        ),
        canTalkToAgentIds: stringArray(
          record.canTalkToAgentIds,
          "canTalkToAgentIds",
          true,
        ),
        canObserveAgentIds: stringArray(
          record.canObserveAgentIds,
          "canObserveAgentIds",
          true,
        ),
        standardCanTalk: booleanValue(record.standardCanTalk, "standardCanTalk"),
        standardCanObserve: booleanValue(
          record.standardCanObserve,
          "standardCanObserve",
        ),
      };
    };

    const preservedPrimaryRunIds = new Set<string>();
    const timestamp = now();
    for (const [workspace, workspaceRuns] of runsByWorkspace) {
      const standards = workspaceRuns.filter((run) => run.mode === "standard");
      const primaryRuns = workspaceRuns.filter(
        (run) => run.mode === "agent" && run.isPrimary === 1,
      );
      const isMigrationPrimary = (run: RepairRun): boolean =>
        run.isPrimary === 1 &&
        (
          (
            run.startupState === "failed" &&
            run.interruptionReason === INCOMPLETE_MIGRATION_STARTUP_REASON
          ) ||
          (
            run.sessionId === null &&
            run.startupState === "reserved" &&
            run.recoveryEligible === 0
          ) ||
          run.interruptionReason === LEGACY_PRIMARY_STAGED_REASON
        );
      const isRelatedLegacyPrimary = (run: RepairRun): boolean =>
        isMigrationPrimary(run) ||
        (
          run.interruptionReason !== null &&
          OBSOLETE_LEGACY_PRIMARY_REASONS.has(run.interruptionReason)
        );
      const migrationPrimaries = primaryRuns.filter(isMigrationPrimary);
      if (standards.length === 0 && migrationPrimaries.length === 0) {
        continue;
      }
      for (const run of primaryRuns) {
        if (!run.agentId || !run.alias) {
          throw new Error(
            `Legacy primary run "${run.id}" in workspace "${workspace}" has no complete ` +
              "durable agent identity; schema-v14 repair was aborted.",
          );
        }
      }

      const viablePrimaries = primaryRuns.filter(
        (run) =>
          run.sessionId !== null &&
          (
            (
              run.definition !== null &&
              run.startupState !== "failed" &&
              run.recoveryEligible === 1
            ) ||
            isMigrationPrimary(run)
          ),
      );
      const viablePrimaryAgentIds = new Set(
        viablePrimaries.map((run) => run.agentId!),
      );
      if (viablePrimaryAgentIds.size > 1) {
        const details = viablePrimaries
          .map(
            (run) =>
              `run "${run.id}" / agent "${run.agentId}" / session "${run.sessionId}"`,
          )
          .join(", ");
        throw new Error(
          `Workspace "${workspace}" has multiple session-backed generic primary identities ` +
            `during schema-v14 repair (${details}). Resolve the ambiguous persisted state ` +
            "before starting native-copilot.nvim.",
        );
      }

      const viablePrimary = viablePrimaries[0];
      const migrationPrimaryAgentIds = new Set(
        migrationPrimaries.map((run) => run.agentId!),
      );
      if (!viablePrimary && migrationPrimaryAgentIds.size > 1) {
        const details = migrationPrimaries
          .map(
            (run) =>
              `run "${run.id}" / agent "${run.agentId}" / state "${run.startupState}"`,
          )
          .join(", ");
        throw new Error(
          `Workspace "${workspace}" has multiple migration-created generic primary ` +
            `identities during schema-v14 repair (${details}). Resolve the ambiguous ` +
            "persisted state before starting native-copilot.nvim.",
        );
      }
      const existingPrimary = viablePrimary ?? migrationPrimaries[0];
      const sessionBackedStandard = standards.find(
        (run) => run.sessionId !== null,
      );
      const targetRun =
        existingPrimary ?? sessionBackedStandard ?? standards[0];
      if (!targetRun) {
        continue;
      }
      const sessionSource =
        viablePrimary ??
        sessionBackedStandard ??
        (
          existingPrimary?.sessionId !== null &&
          existingPrimary?.sessionId !== undefined
            ? existingPrimary
            : undefined
        );
      const primaryAgentId = existingPrimary?.agentId ?? randomUUID();
      const relatedPrimaryRuns = primaryRuns.filter(
        (run) =>
          run.agentId === primaryAgentId ||
          isRelatedLegacyPrimary(run),
      );
      const oldPrimaryAgentIds = new Set(
        relatedPrimaryRuns
          .map((run) => run.agentId)
          .filter((agentId): agentId is string => agentId !== null),
      );
      const oldPrimaryAliases = new Set(
        relatedPrimaryRuns
          .map((run) => run.alias)
          .filter((alias): alias is string => alias !== null),
      );

      const workerAliases = new Set(
        workspaceRuns
          .filter(
            (run) =>
              run.mode === "agent" &&
              run.isPrimary === 0 &&
              run.agentId !== null &&
              run.alias !== null &&
              run.definition !== null,
          )
          .map((run) => run.alias!),
      );
      const reusablePrimaryAliases = new Set(
        [...oldPrimaryAliases].filter((alias) => !workerAliases.has(alias)),
      );
      let primaryAlias = existingPrimary?.alias ?? PRIMARY_ALIAS;
      if (
        primaryAlias === LEGACY_PRIMARY_IDENTITY ||
        primaryAlias === CALLER_ALIAS ||
        !AGENT_ALIAS_PATTERN.test(primaryAlias) ||
        workerAliases.has(primaryAlias)
      ) {
        let attempt = 0;
        do {
          primaryAlias =
            attempt === 0
              ? PRIMARY_ALIAS
              : attempt === 1
                ? "primary"
                : `primary_${attempt}`;
          attempt += 1;
        } while (
          primaryAlias === LEGACY_PRIMARY_IDENTITY ||
          primaryAlias === CALLER_ALIAS ||
          workerAliases.has(primaryAlias)
        );
      }

      const parsedByRunId = new Map<string, ParsedDefinition>();
      const aliases = new Map<string, string>();
      const knownAgentIds = new Set<string>();
      for (const run of workspaceRuns) {
        if (run.mode !== "agent") {
          continue;
        }
        if (run.agentId) {
          knownAgentIds.add(run.agentId);
        }
        const parsed = parseDefinition(run);
        if (!parsed) {
          continue;
        }
        if (!run.agentId || !run.alias) {
          throw new Error(
            `Stored agent run "${run.id}" has a definition but no complete durable identity ` +
              "during schema-v14 legacy-primary repair.",
          );
        }
        parsedByRunId.set(run.id, parsed);
        const mappedAgentId = oldPrimaryAgentIds.has(run.agentId)
          ? primaryAgentId
          : run.agentId;
        if (run.isPrimary === 0) {
          const existingAlias = aliases.get(run.alias);
          if (
            existingAlias !== undefined &&
            existingAlias !== mappedAgentId
          ) {
            throw new Error(
              `Workspace "${workspace}" has ambiguous persisted alias "${run.alias}" during ` +
                "schema-v14 legacy-primary repair.",
            );
          }
          aliases.set(run.alias, mappedAgentId);
        }
      }
      aliases.set(primaryAlias, primaryAgentId);
      for (const alias of reusablePrimaryAliases) {
        aliases.set(alias, primaryAgentId);
      }
      knownAgentIds.add(primaryAgentId);

      const mapAgentId = (agentId: string): string =>
        oldPrimaryAgentIds.has(agentId) ? primaryAgentId : agentId;
      const resolveSelectors = (selectors: readonly string[]): string[] => {
        const resolved = new Set<string>();
        for (const selector of selectors) {
          if (selector === LEGACY_PRIMARY_IDENTITY) {
            resolved.add(primaryAgentId);
            continue;
          }
          if (selector.startsWith("agent:") && selector.length > "agent:".length) {
            resolved.add(mapAgentId(selector.slice("agent:".length)));
            continue;
          }
          const byAlias = aliases.get(selector);
          if (byAlias) {
            resolved.add(byAlias);
            continue;
          }
          if (knownAgentIds.has(selector)) {
            resolved.add(mapAgentId(selector));
          }
        }
        return [...resolved];
      };
      const normalizePersistedIds = (agentIds: readonly string[]): string[] =>
        [...new Set(agentIds.map(mapAgentId))];

      const primaryCanTalkTo = new Set<string>();
      const primaryCanObserve = new Set<string>();
      let primaryDefinitionSource: ParsedDefinition | undefined;
      for (const run of relatedPrimaryRuns) {
        const parsed = parsedByRunId.get(run.id);
        if (!parsed) {
          continue;
        }
        if (!primaryDefinitionSource && run.agentId === primaryAgentId) {
          primaryDefinitionSource = parsed;
        }
        for (const agentId of [
          ...normalizePersistedIds(parsed.canTalkToAgentIds),
          ...resolveSelectors(parsed.canTalkTo),
        ]) {
          if (agentId !== primaryAgentId) {
            primaryCanTalkTo.add(agentId);
          }
        }
        for (const agentId of [
          ...normalizePersistedIds(parsed.canObserveAgentIds),
          ...resolveSelectors(parsed.canObserve),
        ]) {
          if (agentId !== primaryAgentId) {
            primaryCanObserve.add(agentId);
          }
        }
      }
      primaryDefinitionSource ??= relatedPrimaryRuns
        .map((run) => parsedByRunId.get(run.id))
        .find((parsed): parsed is ParsedDefinition => parsed !== undefined);

      const obsoletePrimaryRuns = relatedPrimaryRuns.filter(
        (run) => run.id !== targetRun.id,
      );
      const disqualify = this.db.prepare(
        `UPDATE runs
         SET definition = NULL,
             startup_state = 'failed',
             recovery_eligible = 0,
             status = CASE WHEN status = 'active' THEN 'interrupted' ELSE status END,
             ended_at = COALESCE(ended_at, ?),
             interruption_reason = COALESCE(
               interruption_reason,
               '${OBSOLETE_LEGACY_PRIMARY_REASON}'
             ),
             owner_pid = NULL
         WHERE id = ?`,
      );
      for (const run of obsoletePrimaryRuns) {
        disqualify.run(timestamp, run.id);
      }
      if (targetRun.mode === "agent") {
        this.db
          .prepare("UPDATE runs SET alias = ?, definition = NULL WHERE id = ?")
          .run(primaryAlias, targetRun.id);
      }

      const updateDefinition = this.db.prepare(
        "UPDATE runs SET definition = ? WHERE id = ?",
      );
      for (const run of workspaceRuns) {
        if (
          run.mode !== "agent" ||
          run.isPrimary === 1 ||
          !run.agentId
        ) {
          continue;
        }
        const parsed = parsedByRunId.get(run.id);
        if (!parsed) {
          continue;
        }
        const canTalkToAgentIds = new Set([
          ...normalizePersistedIds(parsed.canTalkToAgentIds),
          ...resolveSelectors(parsed.canTalkTo),
        ]);
        const canObserveAgentIds = new Set([
          ...normalizePersistedIds(parsed.canObserveAgentIds),
          ...resolveSelectors(parsed.canObserve),
        ]);
        if (
          run.legacyPrimaryCanTalk === 1 ||
          parsed.standardCanTalk
        ) {
          primaryCanTalkTo.add(run.agentId);
        }
        if (
          run.legacyPrimaryCanObserve === 1 ||
          parsed.standardCanObserve
        ) {
          primaryCanObserve.add(run.agentId);
        }
        parsed.definition.canTalkTo = [...canTalkToAgentIds].map(
          (agentId) => `agent:${agentId}`,
        );
        parsed.definition.canObserve = [...canObserveAgentIds].map(
          (agentId) => `agent:${agentId}`,
        );
        parsed.record.definition = parsed.definition;
        parsed.record.mcpServers = parsed.mcpServers;
        parsed.record.canTalkToAgentIds = [...canTalkToAgentIds];
        parsed.record.canObserveAgentIds = [...canObserveAgentIds];
        delete parsed.record.standardCanTalk;
        delete parsed.record.standardCanObserve;
        updateDefinition.run(JSON.stringify(parsed.record), run.id);
      }

      const primaryDefinition: Record<string, unknown> = primaryDefinitionSource
        ? { ...primaryDefinitionSource.definition }
        : {
            id: primaryAlias,
            displayName: "Copilot",
            description: "Primary user-facing Copilot agent",
            task: "Assist the user in the primary Neovim conversation.",
            prompt:
              "You are the Copilot agent attached to the primary user-facing Neovim buffer.",
          };
      primaryDefinition.id = primaryAlias;
      primaryDefinition.canTalkTo = [...primaryCanTalkTo].map(
        (agentId) => `agent:${agentId}`,
      );
      primaryDefinition.canObserve = [...primaryCanObserve].map(
        (agentId) => `agent:${agentId}`,
      );
      const primaryRecord: Record<string, unknown> = primaryDefinitionSource
        ? { ...primaryDefinitionSource.record }
        : {};
      primaryRecord.definition = primaryDefinition;
      primaryRecord.mcpServers = primaryDefinitionSource?.mcpServers ?? [];
      primaryRecord.canTalkToAgentIds = [...primaryCanTalkTo];
      primaryRecord.canObserveAgentIds = [...primaryCanObserve];
      delete primaryRecord.standardCanTalk;
      delete primaryRecord.standardCanObserve;

      if (sessionSource?.sessionId) {
        const associations = this.db
          .prepare(
            `SELECT runs.id, runs.mode, runs.workspace,
                    runs.is_primary AS isPrimary, runs.agent_id AS agentId
             FROM agent_sessions
             JOIN runs ON runs.id = agent_sessions.run_id
             WHERE agent_sessions.session_id = ?`,
          )
          .all(sessionSource.sessionId) as unknown as Array<{
            id: string;
            mode: LegacyRunMode;
            workspace: string;
            isPrimary: number;
            agentId: string | null;
          }>;
        for (const association of associations) {
          const repairable =
            association.workspace === workspace &&
            (
              association.mode === "standard" ||
              (
                association.mode === "agent" &&
                association.isPrimary === 1 &&
                association.agentId !== null &&
                oldPrimaryAgentIds.has(association.agentId)
              )
            );
          if (!repairable) {
            throw new Error(
              `SDK session "${sessionSource.sessionId}" selected for legacy primary repair in ` +
                `workspace "${workspace}" is also attached to run "${association.id}". ` +
                "The ambiguous durable ownership was left unchanged.",
            );
          }
        }
        this.db
          .prepare(
            `DELETE FROM agent_sessions
             WHERE session_id = ? AND run_id != ?`,
          )
          .run(sessionSource.sessionId, sessionSource.id);
        if (sessionSource.id !== targetRun.id) {
          this.db
            .prepare("DELETE FROM agent_sessions WHERE run_id = ?")
            .run(targetRun.id);
          const moved = this.db
            .prepare(
              `UPDATE agent_sessions SET run_id = ?
               WHERE run_id = ? AND session_id = ?`,
            )
            .run(targetRun.id, sessionSource.id, sessionSource.sessionId);
          if (moved.changes !== 1) {
            throw new Error(
              `SDK session "${sessionSource.sessionId}" could not be transferred from legacy ` +
                `Standard run "${sessionSource.id}" to generic primary run "${targetRun.id}".`,
            );
          }
        }
      }

      const recoverable = sessionSource?.sessionId !== null &&
        sessionSource?.sessionId !== undefined;
      const targetUpdated = this.db
        .prepare(
          `UPDATE runs
           SET mode = 'agent',
               agent_id = ?,
               alias = ?,
               definition = ?,
               is_primary = 1,
               startup_state = ?,
               recovery_eligible = ?,
               status = CASE WHEN status = 'active' THEN 'interrupted' ELSE status END,
               ended_at = CASE
                 WHEN status = 'active' THEN COALESCE(ended_at, ?)
                 ELSE ended_at
               END,
               interruption_reason = CASE
                 WHEN status = 'active' THEN COALESCE(
                   interruption_reason,
                   'Legacy primary ownership repaired by schema v14'
                 )
                 ELSE interruption_reason
               END,
               owner_pid = NULL
           WHERE id = ?`,
        )
        .run(
          primaryAgentId,
          primaryAlias,
          JSON.stringify(primaryRecord),
          recoverable ? "ready" : "reserved",
          recoverable ? 1 : 0,
          timestamp,
          targetRun.id,
        );
      if (targetUpdated.changes !== 1) {
        throw new Error(
          `Legacy primary run "${targetRun.id}" in workspace "${workspace}" could not be ` +
            "repaired atomically.",
        );
      }
      if (!recoverable) {
        preservedPrimaryRunIds.add(targetRun.id);
      }

      const target = `agent:${primaryAgentId}`;
      const migrationFailedWithoutTimestamp = relatedPrimaryRuns.filter(
        (run) =>
          run.startupState === "failed" &&
          run.interruptionReason === INCOMPLETE_MIGRATION_STARTUP_REASON &&
          run.endedAt === null,
      );
      for (const run of migrationFailedWithoutTimestamp) {
        const failedMail = this.db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM messages WHERE run_id = ? AND status = 'failed'`,
          )
          .get(run.id) as { count: number };
        if (failedMail.count > 0) {
          throw new Error(
            `Migration-failed primary run "${run.id}" has failed mail but no durable failure ` +
              "timestamp, so migration-created failures cannot be distinguished from genuine " +
              "message failures.",
          );
        }
      }
      const migrationFailedPrimaryRuns = relatedPrimaryRuns
        .filter(
          (run) =>
            run.startupState === "failed" &&
            run.interruptionReason === INCOMPLETE_MIGRATION_STARTUP_REASON &&
            run.endedAt !== null,
        );
      const restoreMigrationFailedMessages = this.db.prepare(
        `UPDATE messages
         SET status = 'pending', updated_at = ?
         WHERE status = 'failed' AND run_id = ? AND updated_at = ?`,
      );
      for (const run of migrationFailedPrimaryRuns) {
        restoreMigrationFailedMessages.run(timestamp, run.id, run.endedAt!);
      }
      const sourceAliases = new Set<string>([
        LEGACY_PRIMARY_IDENTITY,
        ...reusablePrimaryAliases,
        ...[...oldPrimaryAgentIds].flatMap((agentId) => [
          agentId,
          `agent:${agentId}`,
        ]),
      ]);
      const normalizeSource = (source: string): string =>
        sourceAliases.has(source) ? target : source;
      let sequence = this.nextSequence(targetRun.id, target);
      const retarget = this.db.prepare(
        `UPDATE messages
         SET target = ?,
             sequence = ?,
             source = ?,
             status = CASE WHEN status = 'delivering' THEN 'pending' ELSE status END,
             updated_at = CASE WHEN status = 'delivering' THEN ? ELSE updated_at END
         WHERE id = ?`,
      );
      const releaseLease = this.db.prepare(
        "DELETE FROM delivery_leases WHERE message_id = ?",
      );
      const targetMessages = this.db
        .prepare(
          `SELECT id, source
           FROM messages
           WHERE run_id = ? AND target != ?
           ORDER BY created_at, sequence, id`,
        )
        .all(targetRun.id, target) as unknown as Array<{
          id: string;
          source: string;
        }>;
      for (const message of targetMessages) {
        retarget.run(
          target,
          sequence,
          normalizeSource(message.source),
          timestamp,
          message.id,
        );
        releaseLease.run(message.id);
        sequence += 1;
      }
      this.db
        .prepare(
          `UPDATE messages
           SET source = CASE
                 WHEN source IN (${[...sourceAliases].map(() => "?").join(", ")})
                   THEN ?
                 ELSE source
               END,
               status = CASE WHEN status = 'delivering' THEN 'pending' ELSE status END,
               updated_at = CASE WHEN status = 'delivering' THEN ? ELSE updated_at END
           WHERE run_id = ? AND target = ?`,
        )
        .run(...sourceAliases, target, timestamp, targetRun.id, target);
      this.db
        .prepare(
          `DELETE FROM delivery_leases
           WHERE message_id IN (
             SELECT id FROM messages
             WHERE run_id = ? AND status = 'pending'
           )`,
        )
        .run(targetRun.id);

      const obsoleteRunIds = [
        ...standards.map((run) => run.id),
        ...obsoletePrimaryRuns.map((run) => run.id),
      ].filter((runId) => runId !== targetRun.id);
      if (obsoleteRunIds.length > 0) {
        const placeholders = obsoleteRunIds.map(() => "?").join(", ");
        const messages = this.db
          .prepare(
            `SELECT id, source
             FROM messages
             WHERE run_id IN (${placeholders})
               AND status IN ('pending', 'delivering')
             ORDER BY created_at, sequence, id`,
          )
          .all(...obsoleteRunIds) as unknown as Array<{
            id: string;
            source: string;
          }>;
        const adopt = this.db.prepare(
          `UPDATE messages
           SET run_id = ?,
               target = ?,
               sequence = ?,
               source = ?,
               status = 'pending',
               updated_at = ?
           WHERE id = ?`,
        );
        for (const message of messages) {
          adopt.run(
            targetRun.id,
            target,
            sequence,
            normalizeSource(message.source),
            timestamp,
            message.id,
          );
          releaseLease.run(message.id);
          sequence += 1;
        }
        for (const runId of obsoleteRunIds) {
          disqualify.run(timestamp, runId);
        }
        this.db
          .prepare(
            `DELETE FROM delivery_leases
             WHERE message_id IN (
               SELECT id FROM messages WHERE run_id IN (${placeholders})
             )`,
          )
          .run(...obsoleteRunIds);
      }

      for (const source of sourceAliases) {
        this.db
          .prepare(
            `UPDATE messages SET source = ?
             WHERE source = ? AND kind = 'agent'
               AND run_id IN (SELECT id FROM runs WHERE workspace = ?)`,
          )
          .run(target, source, workspace);
      }

      const workspaceSessionIds = new Set(
        workspaceRuns
          .map((run) => run.sessionId)
          .filter((sessionId): sessionId is string => sessionId !== null),
      );
      if (sessionSource?.sessionId) {
        workspaceSessionIds.add(sessionSource.sessionId);
      }
      const cursors = this.db
        .prepare(
          `SELECT observer_id AS observerId, target_agent_id AS targetAgentId,
                  session_id AS sessionId, event_cursor AS cursor,
                  updated_at AS updatedAt
           FROM activity_cursors
           ORDER BY updated_at, observer_id, target_agent_id`,
        )
        .all() as unknown as Array<{
          observerId: string;
          targetAgentId: string;
          sessionId: string;
          cursor: string;
          updatedAt: string;
        }>;
      const normalizeCursorIdentity = (identity: string): string => {
        if (identity === LEGACY_PRIMARY_IDENTITY || oldPrimaryAliases.has(identity)) {
          return primaryAgentId;
        }
        const unprefixed = identity.startsWith("agent:")
          ? identity.slice("agent:".length)
          : identity;
        return oldPrimaryAgentIds.has(unprefixed)
          ? primaryAgentId
          : unprefixed;
      };
      const normalizedCursors = new Map<
        string,
        {
          observerId: string;
          targetAgentId: string;
          sessionId: string;
          cursor: string;
          updatedAt: string;
        }
      >();
      const changedCursorKeys: Array<{ observerId: string; targetAgentId: string }> = [];
      for (const cursor of cursors) {
        const mentionsPrimary =
          sourceAliases.has(cursor.observerId) ||
          sourceAliases.has(cursor.targetAgentId);
        if (!mentionsPrimary && !workspaceSessionIds.has(cursor.sessionId)) {
          continue;
        }
        const observerId = normalizeCursorIdentity(cursor.observerId);
        const targetAgentId = normalizeCursorIdentity(cursor.targetAgentId);
        if (
          observerId !== cursor.observerId ||
          targetAgentId !== cursor.targetAgentId
        ) {
          changedCursorKeys.push({
            observerId: cursor.observerId,
            targetAgentId: cursor.targetAgentId,
          });
        }
        normalizedCursors.set(`${observerId}\u0000${targetAgentId}`, {
          observerId,
          targetAgentId,
          sessionId: cursor.sessionId,
          cursor: cursor.cursor,
          updatedAt: cursor.updatedAt,
        });
      }
      const deleteCursor = this.db.prepare(
        `DELETE FROM activity_cursors
         WHERE observer_id = ? AND target_agent_id = ?`,
      );
      for (const key of changedCursorKeys) {
        deleteCursor.run(key.observerId, key.targetAgentId);
      }
      const upsertCursor = this.db.prepare(
        `INSERT OR REPLACE INTO activity_cursors(
           observer_id, target_agent_id, session_id, event_cursor, updated_at
         ) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const cursor of normalizedCursors.values()) {
        upsertCursor.run(
          cursor.observerId,
          cursor.targetAgentId,
          cursor.sessionId,
          cursor.cursor,
          cursor.updatedAt,
        );
      }
    }
    return preservedPrimaryRunIds;
  }

  private rewriteWorkspaceAclsInTransaction(
    workspace: string,
    disqualified: ReadonlyMap<string, string>,
    additionalAliases: ReadonlySet<string> = new Set(),
  ): number {
    if (disqualified.size === 0) {
      return 0;
    }
    const disqualifiedIds = new Set(disqualified.keys());
    const disqualifiedAliases = new Set([
      ...disqualified.values(),
      ...additionalAliases,
    ]);
    const rows = this.db
      .prepare(
        `SELECT id, definition
         FROM runs
         WHERE workspace = ? AND mode = 'agent' AND definition IS NOT NULL`,
      )
      .all(workspace) as unknown as Array<{ id: string; definition: string }>;
    const update = this.db.prepare(
      `UPDATE runs SET definition = ? WHERE id = ? AND definition = ?`,
    );
    let updated = 0;

    const filteredStrings = (
      value: unknown,
      runId: string,
      field: string,
      remove: (entry: string) => boolean,
    ): string[] | undefined => {
      if (value === undefined) {
        return undefined;
      }
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        throw new Error(
          `Stored agent run "${runId}" has an invalid ${field}; ACL cleanup was aborted.`,
        );
      }
      return (value as string[]).filter((entry) => !remove(entry));
    };
    const removesAgentId = (entry: string): boolean =>
      disqualifiedIds.has(entry) ||
      (
        entry.startsWith("agent:") &&
        disqualifiedIds.has(entry.slice("agent:".length))
      );
    const removesSelector = (entry: string): boolean =>
      removesAgentId(entry) || disqualifiedAliases.has(entry);

    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.definition);
      } catch (error) {
        throw new Error(
          `Stored agent run "${row.id}" contains invalid JSON; ACL cleanup was aborted.`,
          { cause: error },
        );
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(
          `Stored agent run "${row.id}" is not an object; ACL cleanup was aborted.`,
        );
      }
      const record = parsed as Record<string, unknown>;
      if (
        typeof record.definition !== "object" ||
        record.definition === null ||
        Array.isArray(record.definition)
      ) {
        throw new Error(
          `Stored agent run "${row.id}" has no valid definition; ACL cleanup was aborted.`,
        );
      }
      const definition = record.definition as Record<string, unknown>;
      const canTalkToAgentIds = filteredStrings(
        record.canTalkToAgentIds,
        row.id,
        "canTalkToAgentIds",
        removesAgentId,
      );
      const canObserveAgentIds = filteredStrings(
        record.canObserveAgentIds,
        row.id,
        "canObserveAgentIds",
        removesAgentId,
      );
      const canTalkTo = filteredStrings(
        definition.canTalkTo,
        row.id,
        "definition.canTalkTo",
        removesSelector,
      );
      const canObserve = filteredStrings(
        definition.canObserve,
        row.id,
        "definition.canObserve",
        removesSelector,
      );
      let changed = false;
      if (
        canTalkToAgentIds !== undefined &&
        canTalkToAgentIds.length !== (record.canTalkToAgentIds as unknown[]).length
      ) {
        record.canTalkToAgentIds = canTalkToAgentIds;
        changed = true;
      }
      if (
        canObserveAgentIds !== undefined &&
        canObserveAgentIds.length !== (record.canObserveAgentIds as unknown[]).length
      ) {
        record.canObserveAgentIds = canObserveAgentIds;
        changed = true;
      }
      if (
        canTalkTo !== undefined &&
        canTalkTo.length !== (definition.canTalkTo as unknown[]).length
      ) {
        definition.canTalkTo = canTalkTo;
        changed = true;
      }
      if (
        canObserve !== undefined &&
        canObserve.length !== (definition.canObserve as unknown[]).length
      ) {
        definition.canObserve = canObserve;
        changed = true;
      }
      if (!changed) {
        continue;
      }
      const result = update.run(JSON.stringify(record), row.id, row.definition);
      if (result.changes !== 1) {
        throw new Error(
          `Stored agent run "${row.id}" changed during ACL cleanup; the transaction was aborted.`,
        );
      }
      updated += 1;
    }

    const ids = [...disqualifiedIds];
    const placeholders = ids.map(() => "?").join(", ");
    this.db
      .prepare(
        `DELETE FROM activity_cursors
         WHERE observer_id IN (${placeholders}) OR target_agent_id IN (${placeholders})`,
      )
      .run(...ids, ...ids);
    return updated;
  }

  private identitySurvivesOutsideRuns(
    workspace: string,
    agentId: string,
    excludedRunIds: ReadonlySet<string>,
  ): boolean {
    const rows = this.db
      .prepare(
        `SELECT id
         FROM runs
         WHERE workspace = ? AND mode = 'agent' AND agent_id = ?
           AND definition IS NOT NULL AND startup_state != 'failed'`,
      )
      .all(workspace, agentId) as unknown as Array<{ id: string }>;
    return rows.some((row) => !excludedRunIds.has(row.id));
  }

  private classifyLegacyStartups(
    preservedPrimaryRunIds: ReadonlySet<string> = new Set(),
  ): void {
    type LegacyStartup = {
      id: string;
      workspace: string;
      agentId: string;
      alias: string | null;
      isPrimary: number;
      hasSession: number;
      hasDeliveredTask: number;
    };
    const runs = this.db
      .prepare(
        `SELECT id, workspace, agent_id AS agentId, alias,
                is_primary AS isPrimary,
                EXISTS (
                  SELECT 1 FROM agent_sessions WHERE agent_sessions.run_id = runs.id
                ) AS hasSession,
                COALESCE((
                  SELECT CASE WHEN messages.status = 'delivered' THEN 1 ELSE 0 END
                  FROM messages
                  WHERE messages.run_id = runs.id
                    AND messages.kind = 'user'
                  ORDER BY messages.created_at, messages.sequence, messages.id
                  LIMIT 1
                ), 0) AS hasDeliveredTask
         FROM runs
         WHERE mode = 'agent' AND agent_id IS NOT NULL AND definition IS NOT NULL
           AND startup_state != 'failed'`,
      )
      .all() as unknown as LegacyStartup[];
    const ready = runs.filter(
      (run) =>
        run.hasSession === 1 &&
        (run.isPrimary === 1 || run.hasDeliveredTask === 1),
    );
    const readyIds = new Set(ready.map((run) => run.id));
    const preserved = runs.filter(
      (run) =>
        !readyIds.has(run.id) &&
        run.isPrimary === 1 &&
        preservedPrimaryRunIds.has(run.id),
    );
    const preservedIds = new Set(preserved.map((run) => run.id));
    const failed = runs.filter(
      (run) => !readyIds.has(run.id) && !preservedIds.has(run.id),
    );
    const timestamp = now();

    const markReady = this.db.prepare(
      `UPDATE runs
       SET startup_state = 'ready', recovery_eligible = 1
       WHERE id = ? AND mode = 'agent'`,
    );
    for (const run of ready) {
      markReady.run(run.id);
    }

    const preservePrimary = this.db.prepare(
      `UPDATE runs
       SET startup_state = 'reserved',
           recovery_eligible = 0,
           status = CASE WHEN status = 'active' THEN 'interrupted' ELSE status END,
           ended_at = COALESCE(ended_at, ?),
           interruption_reason = COALESCE(
             interruption_reason,
             '${LEGACY_PRIMARY_STAGED_REASON}'
           ),
           owner_pid = NULL
       WHERE id = ? AND mode = 'agent' AND is_primary = 1
         AND NOT EXISTS (SELECT 1 FROM agent_sessions WHERE run_id = runs.id)`,
    );
    const resetPreservedMessages = this.db.prepare(
      `UPDATE messages
       SET status = 'pending', updated_at = ?
       WHERE run_id = ? AND status = 'delivering'`,
    );
    const removePreservedLeases = this.db.prepare(
      `DELETE FROM delivery_leases
       WHERE message_id IN (SELECT id FROM messages WHERE run_id = ?)`,
    );
    for (const run of preserved) {
      const result = preservePrimary.run(timestamp, run.id);
      if (result.changes !== 1) {
        throw new Error(
          `Legacy primary run "${run.id}" could not retain its pending mailbox safely.`,
        );
      }
      resetPreservedMessages.run(timestamp, run.id);
      removePreservedLeases.run(run.id);
    }

    const failedIds = new Set(failed.map((run) => run.id));
    const byWorkspace = new Map<string, Map<string, string>>();
    for (const run of failed) {
      if (
        this.identitySurvivesOutsideRuns(run.workspace, run.agentId, failedIds)
      ) {
        continue;
      }
      const identities = byWorkspace.get(run.workspace) ?? new Map<string, string>();
      identities.set(run.agentId, run.alias ?? run.agentId);
      byWorkspace.set(run.workspace, identities);
    }
    for (const [workspace, identities] of byWorkspace) {
      this.rewriteWorkspaceAclsInTransaction(workspace, identities);
    }

    const markFailed = this.db.prepare(
      `UPDATE runs
       SET definition = NULL,
           startup_state = 'failed',
           recovery_eligible = 0,
           status = CASE WHEN status = 'active' THEN 'interrupted' ELSE status END,
           ended_at = COALESCE(ended_at, ?),
           interruption_reason = COALESCE(
             interruption_reason,
             '${INCOMPLETE_MIGRATION_STARTUP_REASON}'
           ),
           owner_pid = NULL
       WHERE id = ? AND mode = 'agent'`,
    );
    const failMessages = this.db.prepare(
      `UPDATE messages
       SET status = 'failed', updated_at = ?
       WHERE run_id = ? AND status IN ('pending', 'delivering')`,
    );
    const removeLeases = this.db.prepare(
      `DELETE FROM delivery_leases
       WHERE message_id IN (SELECT id FROM messages WHERE run_id = ?)`,
    );
    for (const run of failed) {
      markFailed.run(timestamp, run.id);
      failMessages.run(timestamp, run.id);
      removeLeases.run(run.id);
    }
  }

  /**
   * Removes durable references to agent identities that have no non-failed
   * definition left. This repairs databases whose failed startup rows predate
   * the transactional ACL cleanup.
   */
  private scrubGhostAclsInTransaction(): void {
    type IdentityState = {
      workspace: string;
      agentId: string;
      alias: string | null;
      definition: string | null;
      startupState: RunStartupState;
    };
    const rows = this.db
      .prepare(
        `SELECT workspace, agent_id AS agentId, alias, definition,
                startup_state AS startupState
         FROM runs
         WHERE mode = 'agent' AND agent_id IS NOT NULL
         ORDER BY workspace, started_at DESC, id DESC`,
      )
      .all() as unknown as IdentityState[];
    const identityKey = (row: Pick<IdentityState, "workspace" | "agentId">): string =>
      `${row.workspace}\u0000${row.agentId}`;
    const surviving = new Set(
      rows
        .filter((row) => row.definition !== null && row.startupState !== "failed")
        .map(identityKey),
    );
    const survivingAliases = new Set(
      rows
        .filter(
          (row) =>
            row.alias !== null &&
            row.definition !== null &&
            row.startupState !== "failed",
        )
        .map((row) => `${row.workspace}\u0000${row.alias}`),
    );
    const ghostsByWorkspace = new Map<
      string,
      { identities: Map<string, string>; aliases: Set<string> }
    >();
    for (const row of rows) {
      if (surviving.has(identityKey(row))) {
        continue;
      }
      const ghosts = ghostsByWorkspace.get(row.workspace) ?? {
        identities: new Map<string, string>(),
        aliases: new Set<string>(),
      };
      if (!ghosts.identities.has(row.agentId)) {
        ghosts.identities.set(row.agentId, row.alias ?? row.agentId);
      }
      if (
        row.alias &&
        !survivingAliases.has(`${row.workspace}\u0000${row.alias}`)
      ) {
        ghosts.aliases.add(row.alias);
      }
      ghostsByWorkspace.set(row.workspace, ghosts);
    }
    for (const [workspace, ghosts] of ghostsByWorkspace) {
      this.rewriteWorkspaceAclsInTransaction(
        workspace,
        ghosts.identities,
        ghosts.aliases,
      );
    }
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
   * Normalizes the selected legacy primary mailbox and appends every undelivered
   * Standard message in the workspace to it without colliding with old sequences.
   */
  private migrateLegacyPrimaryMessages(
    workspace: string,
    primaryRunId: string,
    primaryAgentId: string,
  ): number {
    const target = `agent:${primaryAgentId}`;
    const timestamp = now();
    let sequence = this.nextSequence(primaryRunId, target);
    const retarget = this.db.prepare(
      `UPDATE messages
       SET target = ?,
           sequence = ?,
           source = CASE WHEN source = ? THEN ? ELSE source END,
           status = CASE WHEN status = 'delivering' THEN 'pending' ELSE status END,
           updated_at = CASE WHEN status = 'delivering' THEN ? ELSE updated_at END
       WHERE id = ?`,
    );
    const releaseLease = this.db.prepare(
      "DELETE FROM delivery_leases WHERE message_id = ?",
    );
    const selectedMessages = this.db
      .prepare(
        `SELECT id
         FROM messages
         WHERE run_id = ? AND target != ?
         ORDER BY created_at, sequence, id`,
      )
      .all(primaryRunId, target) as unknown as Array<{ id: string }>;
    for (const message of selectedMessages) {
      retarget.run(
        target,
        sequence,
        LEGACY_PRIMARY_IDENTITY,
        target,
        timestamp,
        message.id,
      );
      releaseLease.run(message.id);
      sequence += 1;
    }

    this.db
      .prepare(
        `UPDATE messages
         SET source = CASE WHEN source = ? THEN ? ELSE source END,
             status = CASE WHEN status = 'delivering' THEN 'pending' ELSE status END,
             updated_at = CASE WHEN status = 'delivering' THEN ? ELSE updated_at END
         WHERE run_id = ? AND target = ?`,
      )
      .run(
        LEGACY_PRIMARY_IDENTITY,
        target,
        timestamp,
        primaryRunId,
        target,
      );
    this.db
      .prepare(
        `DELETE FROM delivery_leases
         WHERE message_id IN (
           SELECT id FROM messages
           WHERE run_id = ? AND target = ? AND status = 'pending'
         )`,
      )
      .run(primaryRunId, target);

    const legacyMessages = this.db
      .prepare(
        `SELECT messages.id AS id
         FROM messages
         JOIN runs ON runs.id = messages.run_id
         WHERE runs.workspace = ? AND runs.mode = 'standard'
           AND messages.status IN ('pending', 'delivering')
         ORDER BY messages.created_at, messages.sequence, messages.id`,
      )
      .all(workspace) as unknown as Array<{ id: string }>;
    const adopt = this.db.prepare(
      `UPDATE messages
       SET run_id = ?,
           target = ?,
           sequence = ?,
           source = CASE WHEN source = ? THEN ? ELSE source END,
           status = 'pending',
           updated_at = ?
       WHERE id = ?`,
    );
    for (const message of legacyMessages) {
      adopt.run(
        primaryRunId,
        target,
        sequence,
        LEGACY_PRIMARY_IDENTITY,
        target,
        timestamp,
        message.id,
      );
      releaseLease.run(message.id);
      sequence += 1;
    }

    this.db
      .prepare(
        `UPDATE messages SET source = ?
         WHERE source = ?
           AND kind = 'agent'
           AND run_id IN (SELECT id FROM runs WHERE workspace = ?)`,
      )
      .run(target, LEGACY_PRIMARY_IDENTITY, workspace);
    return selectedMessages.length + legacyMessages.length;
  }

  /**
   * Adopts legacy primary-session state into the same UUID-backed run/ACL model
   * as every other agent. Existing worker definitions and pending mail are retained.
   */
  private migrateLegacyAgentState(): Set<string> {
    type LegacyRun = {
      id: string;
      mode: LegacyRunMode;
      agentId: string | null;
      alias: string | null;
      definition: string | null;
      workspace: string;
      startedAt: string;
      isPrimary: number;
      hasSession: number;
      hasDeliveredTask: number;
      legacyPrimaryCanTalk: number;
      legacyPrimaryCanObserve: number;
    };
    const runs = this.db
      .prepare(
        `SELECT id, mode, agent_id AS agentId, alias, definition, workspace,
                is_primary AS isPrimary,
                EXISTS (
                  SELECT 1 FROM agent_sessions WHERE agent_sessions.run_id = runs.id
                ) AS hasSession,
                COALESCE((
                  SELECT CASE WHEN messages.status = 'delivered' THEN 1 ELSE 0 END
                  FROM messages
                  WHERE messages.run_id = runs.id
                    AND messages.kind = 'user'
                  ORDER BY messages.created_at, messages.sequence, messages.id
                  LIMIT 1
                ), 0) AS hasDeliveredTask,
                started_at AS startedAt, standard_can_talk AS legacyPrimaryCanTalk,
                standard_can_observe AS legacyPrimaryCanObserve
         FROM runs
         ORDER BY workspace, started_at DESC, id DESC`,
      )
      .all() as unknown as LegacyRun[];
    const primaryByWorkspace = new Map<
      string,
      { agentId: string; runId: string; alias: string }
    >();
    const primaryRunsToConvert = new Set<string>();
    const sessionlessPrimaryRunIds = new Set<string>();
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
    const standardsByWorkspace = new Map<string, LegacyRun[]>();
    for (const run of runs) {
      if (run.mode !== "standard") {
        continue;
      }
      const standards = standardsByWorkspace.get(run.workspace) ?? [];
      standards.push(run);
      standardsByWorkspace.set(run.workspace, standards);
    }
    for (const [workspace, standards] of standardsByWorkspace) {
      if (primaryByWorkspace.has(workspace)) {
        continue;
      }
      const selected = standards.find((run) => run.hasSession === 1) ?? standards[0];
      if (!selected) {
        continue;
      }
      primaryByWorkspace.set(workspace, {
        agentId: randomUUID(),
        runId: selected.id,
        alias: PRIMARY_ALIAS,
      });
      primaryRunsToConvert.add(selected.id);
      if (selected.hasSession !== 1) {
        sessionlessPrimaryRunIds.add(selected.id);
      }
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
      if (
        run.mode !== "agent" ||
        !agentId ||
        !storedDefinition ||
        run.hasSession !== 1 ||
        (run.isPrimary !== 1 && run.hasDeliveredTask !== 1)
      ) {
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
        if (
          !parsed.definition ||
          typeof parsed.definition !== "object" ||
          Array.isArray(parsed.definition)
        ) {
          throw new Error("stored definition is not an object");
        }
        const canTalkTo = parsed.definition.canTalkTo;
        const canObserve = parsed.definition.canObserve;
        if (
          !Array.isArray(canTalkTo) ||
          canTalkTo.some((selector) => typeof selector !== "string") ||
          (
            canObserve !== undefined &&
            (
              !Array.isArray(canObserve) ||
              canObserve.some((selector) => typeof selector !== "string")
            )
          ) ||
          (
            parsed.canTalkToAgentIds !== undefined &&
            (
              !Array.isArray(parsed.canTalkToAgentIds) ||
              parsed.canTalkToAgentIds.some((agentId) => typeof agentId !== "string")
            )
          ) ||
          (
            parsed.canObserveAgentIds !== undefined &&
            (
              !Array.isArray(parsed.canObserveAgentIds) ||
              parsed.canObserveAgentIds.some((agentId) => typeof agentId !== "string")
            )
          )
        ) {
          throw new Error("stored ACL fields are invalid");
        }
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
      } catch (error) {
        throw new Error(
          `Stored agent run "${run.id}" could not be migrated because its definition is invalid.`,
          { cause: error },
        );
      }
    }

    const convertPrimary = this.db.prepare(
      `UPDATE runs
       SET mode = 'agent', agent_id = ?, alias = ?, definition = ?, is_primary = 1
       WHERE id = ? AND mode = 'standard' AND is_primary = 0`,
    );
    for (const [workspace, primary] of primaryByWorkspace) {
      if (!primaryRunsToConvert.has(primary.runId)) {
        this.migrateLegacyPrimaryMessages(
          workspace,
          primary.runId,
          primary.agentId,
        );
        continue;
      }
      const outgoingTalk = new Set(runs
        .filter(
          (run) =>
            run.workspace === workspace &&
            run.mode === "agent" &&
            run.agentId !== null &&
            run.definition !== null &&
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
            run.definition !== null &&
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
      this.migrateLegacyPrimaryMessages(
        workspace,
        primary.runId,
        primary.agentId,
      );
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
    return sessionlessPrimaryRunIds;
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

  private sessionOwnershipRows(
    sessionId?: string,
    workspace?: string,
  ): SessionOwnershipRow[] {
    const filters = [
      "runs.mode = 'agent'",
      "runs.agent_id IS NOT NULL",
      "runs.definition IS NOT NULL",
      `(
          (runs.startup_state = 'ready' AND runs.recovery_eligible = 1)
          OR (runs.status = 'active' AND runs.startup_state = 'session_created')
        )`,
    ];
    const parameters: string[] = [];
    if (sessionId !== undefined) {
      filters.push("agent_sessions.session_id = ?");
      parameters.push(sessionId);
    }
    if (workspace !== undefined) {
      filters.push("runs.workspace = ?");
      parameters.push(workspace);
    }
    return this.db
      .prepare(
        `SELECT agent_sessions.session_id AS sessionId,
                  runs.agent_id AS agentId,
                  runs.workspace AS workspace,
                  runs.id AS runId
           FROM agent_sessions
           JOIN runs ON runs.id = agent_sessions.run_id
           WHERE ${filters.join(" AND ")}
           ORDER BY agent_sessions.session_id, runs.started_at, runs.id`,
      )
      .all(...parameters) as unknown as SessionOwnershipRow[];
  }

  private sessionOwnerFromRows(
    sessionId: string,
    rows: SessionOwnershipRow[],
  ): StoredSessionOwner | undefined {
    if (rows.length === 0) {
      return undefined;
    }
    const identities = new Map<string, { agentId: string; workspace: string; runIds: string[] }>();
    for (const row of rows) {
      const key = `${row.workspace}\u0000${row.agentId}`;
      const identity = identities.get(key) ?? {
        agentId: row.agentId,
        workspace: row.workspace,
        runIds: [],
      };
      identity.runIds.push(row.runId);
      identities.set(key, identity);
    }
    if (identities.size !== 1) {
      const details = [...identities.values()]
        .map(
          (identity) =>
            `agent "${identity.agentId}" in workspace "${identity.workspace}" ` +
            `(runs ${identity.runIds.map((runId) => `"${runId}"`).join(", ")})`,
        )
        .join("; ");
      throw new Error(
        `SDK session "${sessionId}" is durably owned by multiple agent identities: ${details}. ` +
          "Resolve the duplicate persisted ownership before starting or recovering an agent.",
      );
    }
    const owner = identities.values().next().value!;
    return {
      sessionId,
      agentId: owner.agentId,
      workspace: owner.workspace,
      runIds: owner.runIds,
    };
  }

  private assertSessionOwnershipState(): void {
    const rows = this.sessionOwnershipRows();
    const bySession = new Map<string, SessionOwnershipRow[]>();
    for (const row of rows) {
      const sessionRows = bySession.get(row.sessionId) ?? [];
      sessionRows.push(row);
      bySession.set(row.sessionId, sessionRows);
    }
    for (const [sessionId, sessionRows] of bySession) {
      this.sessionOwnerFromRows(sessionId, sessionRows);
    }
  }

  /** Durable owner of one SDK session, allowing historical runs of the same UUID. */
  sessionOwner(sessionId: string): StoredSessionOwner | undefined {
    return this.sessionOwnerFromRows(sessionId, this.sessionOwnershipRows(sessionId));
  }

  /** SDK sessions reserved by recoverable or currently-starting durable agents. */
  ownedSessionIds(workspace?: string): string[] {
    const rows = this.sessionOwnershipRows(undefined, workspace);
    const bySession = new Map<string, SessionOwnershipRow[]>();
    for (const row of rows) {
      const sessionRows = bySession.get(row.sessionId) ?? [];
      sessionRows.push(row);
      bySession.set(row.sessionId, sessionRows);
    }
    for (const [sessionId, sessionRows] of bySession) {
      this.sessionOwnerFromRows(sessionId, sessionRows);
    }
    return [...bySession.keys()];
  }

  private ownerPidIsAlive(pid: number, ownerIsAlive: OwnerIsAlive): boolean {
    try {
      return ownerIsAlive(pid);
    } catch {
      return true;
    }
  }

  private releaseClaimedPrimaryPredecessorInTransaction(
    successor: {
      id: string;
      workspace: string;
      agentId: string;
      ownerPid: number;
      predecessorRunId: string;
      claimToken: string;
    },
  ): void {
    const released = this.db
      .prepare(
        `UPDATE runs
         SET primary_claim_token = NULL, owner_pid = NULL
         WHERE id = ? AND workspace = ? AND mode = 'agent'
           AND is_primary = 1 AND agent_id = ?
           AND primary_predecessor_run_id IS NULL
           AND primary_claim_token = ? AND owner_pid = ?
           AND status != 'active'`,
      )
      .run(
        successor.predecessorRunId,
        successor.workspace,
        successor.agentId,
        successor.claimToken,
        successor.ownerPid,
      );
    if (released.changes !== 1) {
      throw new Error(
        `Primary startup run "${successor.id}" could not release its explicitly claimed ` +
          `predecessor "${successor.predecessorRunId}".`,
      );
    }
  }

  private retireClaimedPrimaryPredecessorInTransaction(
    successor: {
      id: string;
      workspace: string;
      agentId: string;
      ownerPid: number;
      predecessorRunId: string;
      claimToken: string;
    },
    reason: string,
  ): void {
    const predecessor = this.db
      .prepare(
        `SELECT startup_state AS startupState,
                recovery_eligible AS recoveryEligible,
                EXISTS (
                  SELECT 1 FROM agent_sessions
                  WHERE agent_sessions.run_id = runs.id
                ) AS hasSession
         FROM runs
         WHERE id = ? AND workspace = ? AND mode = 'agent'
           AND is_primary = 1 AND agent_id = ?
           AND primary_predecessor_run_id IS NULL
           AND primary_claim_token = ? AND owner_pid = ?
           AND status != 'active' AND definition IS NOT NULL`,
      )
      .get(
        successor.predecessorRunId,
        successor.workspace,
        successor.agentId,
        successor.claimToken,
        successor.ownerPid,
      ) as {
        startupState: RunStartupState;
        recoveryEligible: number;
        hasSession: number;
      } | undefined;
    if (!predecessor) {
      throw new Error(
        `Primary startup run "${successor.id}" no longer owns predecessor ` +
          `"${successor.predecessorRunId}".`,
      );
    }
    if (
      predecessor.startupState === "ready" &&
      predecessor.recoveryEligible === 1 &&
      predecessor.hasSession === 1
    ) {
      const retired = this.db
        .prepare(
          `UPDATE runs
           SET recovery_eligible = 0,
               status = 'stopped',
               ended_at = COALESCE(ended_at, ?),
               interruption_reason = ?,
               owner_pid = NULL,
               primary_claim_token = NULL
           WHERE id = ? AND workspace = ? AND mode = 'agent'
             AND is_primary = 1 AND agent_id = ?
             AND primary_predecessor_run_id IS NULL
             AND primary_claim_token = ? AND owner_pid = ?
             AND status != 'active'
             AND startup_state = 'ready' AND recovery_eligible = 1
             AND EXISTS (
               SELECT 1 FROM agent_sessions
               WHERE agent_sessions.run_id = runs.id
             )`,
        )
        .run(
          now(),
          reason,
          successor.predecessorRunId,
          successor.workspace,
          successor.agentId,
          successor.claimToken,
          successor.ownerPid,
        );
      if (retired.changes !== 1) {
        throw new Error(
          `Primary startup run "${successor.id}" could not retire previous conversation ` +
            `"${successor.predecessorRunId}".`,
        );
      }
      return;
    }
    const retired = this.db
      .prepare(
        `UPDATE runs
         SET definition = NULL,
             startup_state = 'failed',
             recovery_eligible = 0,
             status = CASE WHEN status = 'active' THEN 'interrupted' ELSE status END,
             ended_at = COALESCE(ended_at, ?),
             interruption_reason = COALESCE(interruption_reason, ?),
             owner_pid = NULL,
             primary_claim_token = NULL
         WHERE id = ? AND workspace = ? AND mode = 'agent'
           AND is_primary = 1 AND agent_id = ?
           AND primary_predecessor_run_id IS NULL
           AND primary_claim_token = ? AND owner_pid = ?
           AND status != 'active'
           AND startup_state = 'reserved' AND recovery_eligible = 0
           AND definition IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM agent_sessions WHERE agent_sessions.run_id = runs.id
           )`,
      )
      .run(
        now(),
        reason,
        successor.predecessorRunId,
        successor.workspace,
        successor.agentId,
        successor.claimToken,
        successor.ownerPid,
      );
    if (retired.changes !== 1) {
      throw new Error(
        `Primary startup run "${successor.id}" could not retire its explicitly claimed ` +
          `predecessor "${successor.predecessorRunId}".`,
      );
    }
  }

  /**
   * Resolves claims left by dead hosts before ordinary active-run recovery. A
   * session-backed successor is promoted and keeps the staged identity; a
   * sessionless successor is failed and releases the predecessor for another
   * atomic claim.
   */
  private recoverStalePrimaryClaimsInTransaction(
    reason: string,
    ownerIsAlive: OwnerIsAlive,
  ): number {
    type PredecessorClaim = {
      id: string;
      workspace: string;
      agentId: string;
      definition: string | null;
      claimToken: string;
      ownerPid: number | null;
      status: RunStatus;
      startupState: RunStartupState;
      recoveryEligible: number;
      hasSession: number;
    };
    type SuccessorClaim = {
      id: string;
      workspace: string;
      agentId: string;
      ownerPid: number | null;
      predecessorRunId: string;
      claimToken: string;
      status: RunStatus;
      definition: string | null;
      hasSession: number;
    };

    const predecessors = this.db
      .prepare(
        `SELECT id, workspace, agent_id AS agentId, definition,
                primary_claim_token AS claimToken, owner_pid AS ownerPid,
                status, startup_state AS startupState,
                recovery_eligible AS recoveryEligible,
                EXISTS (
                  SELECT 1 FROM agent_sessions WHERE agent_sessions.run_id = runs.id
                ) AS hasSession
         FROM runs
         WHERE mode = 'agent' AND is_primary = 1
           AND agent_id IS NOT NULL
           AND primary_predecessor_run_id IS NULL
           AND primary_claim_token IS NOT NULL`,
      )
      .all() as unknown as PredecessorClaim[];
    const successorRows = this.db.prepare(
      `SELECT id, workspace, agent_id AS agentId, owner_pid AS ownerPid,
              primary_predecessor_run_id AS predecessorRunId,
              primary_claim_token AS claimToken, status,
              definition,
              EXISTS (
                SELECT 1 FROM agent_sessions WHERE agent_sessions.run_id = runs.id
              ) AS hasSession
       FROM runs
       WHERE mode = 'agent' AND is_primary = 1
         AND agent_id IS NOT NULL
         AND primary_predecessor_run_id = ?
         AND primary_claim_token = ?`,
    );
    let recovered = 0;
    for (const predecessor of predecessors) {
      if (predecessor.ownerPid === null) {
        throw new Error(
          `Staged primary predecessor "${predecessor.id}" has claim token ` +
            `"${predecessor.claimToken}" but no owner PID.`,
        );
      }
      if (
        predecessor.definition === null ||
        predecessor.status === "active" ||
        predecessor.startupState !== "reserved" ||
        predecessor.recoveryEligible !== 0 ||
        predecessor.hasSession !== 0
      ) {
        throw new Error(
          `Staged primary predecessor "${predecessor.id}" is malformed and cannot be recovered.`,
        );
      }
      const successors = successorRows.all(
        predecessor.id,
        predecessor.claimToken,
      ) as unknown as SuccessorClaim[];
      if (successors.length !== 1) {
        if (
          successors.length === 0 &&
          !this.ownerPidIsAlive(predecessor.ownerPid, ownerIsAlive)
        ) {
          const released = this.db
            .prepare(
              `UPDATE runs
               SET primary_claim_token = NULL, owner_pid = NULL
               WHERE id = ? AND primary_claim_token = ? AND owner_pid = ?`,
            )
            .run(predecessor.id, predecessor.claimToken, predecessor.ownerPid);
          if (released.changes !== 1) {
            throw new Error(
              `Orphaned staged primary claim on run "${predecessor.id}" could not be released.`,
            );
          }
          recovered += 1;
          continue;
        }
        throw new Error(
          `Staged primary predecessor "${predecessor.id}" has ${successors.length} matching ` +
            "successor runs; the durable claim is ambiguous.",
        );
      }
      const successor = successors[0]!;
      if (
        successor.workspace !== predecessor.workspace ||
        successor.agentId !== predecessor.agentId ||
        successor.ownerPid === null ||
        successor.ownerPid !== predecessor.ownerPid ||
        successor.definition === null
      ) {
        throw new Error(
          `Staged primary claim "${predecessor.claimToken}" does not link one workspace, ` +
            "agent identity, and owner PID consistently.",
        );
      }
      if (this.ownerPidIsAlive(predecessor.ownerPid, ownerIsAlive)) {
        continue;
      }
      if (successor.status !== "active") {
        throw new Error(
          `Staged primary claim "${predecessor.claimToken}" points to non-active successor ` +
            `"${successor.id}" and cannot be recovered automatically.`,
        );
      }

      const claim = {
        id: successor.id,
        workspace: successor.workspace,
        agentId: successor.agentId,
        ownerPid: successor.ownerPid,
        predecessorRunId: successor.predecessorRunId,
        claimToken: successor.claimToken,
      };
      const timestamp = now();
      if (successor.hasSession === 1) {
        this.adoptAgentMessagesInTransaction(
          successor.id,
          successor.workspace,
          successor.agentId,
          `agent:${successor.agentId}`,
          LEGACY_PRIMARY_IDENTITY,
        );
        this.completeRunStartupInTransaction(successor.id);
        this.retireClaimedPrimaryPredecessorInTransaction(
          claim,
          "Staged primary identity was activated by an interrupted host",
        );
        const interrupted = this.db
          .prepare(
            `UPDATE runs
             SET status = 'interrupted', ended_at = ?, interruption_reason = ?,
                 owner_pid = NULL, primary_claim_token = NULL
             WHERE id = ? AND status = 'active'
               AND primary_predecessor_run_id = ? AND primary_claim_token = ?`,
          )
          .run(
            timestamp,
            reason,
            successor.id,
            successor.predecessorRunId,
            successor.claimToken,
          );
        if (interrupted.changes !== 1) {
          throw new Error(
            `Recovered primary successor "${successor.id}" could not be made resumable.`,
          );
        }
      } else {
        this.releaseClaimedPrimaryPredecessorInTransaction(claim);
        const failed = this.db
          .prepare(
            `UPDATE runs
             SET definition = NULL,
                 startup_state = 'failed',
                 recovery_eligible = 0,
                 status = 'interrupted',
                 ended_at = ?,
                 interruption_reason = ?,
                 owner_pid = NULL,
                 primary_claim_token = NULL
             WHERE id = ? AND status = 'active'
               AND primary_predecessor_run_id = ? AND primary_claim_token = ?`,
          )
          .run(
            timestamp,
            `${reason} during primary startup`,
            successor.id,
            successor.predecessorRunId,
            successor.claimToken,
          );
        if (failed.changes !== 1) {
          throw new Error(
            `Interrupted primary successor "${successor.id}" could not release its staged identity.`,
          );
        }
        this.db
          .prepare(
            `UPDATE messages
             SET status = 'failed', updated_at = ?
             WHERE run_id = ? AND status IN ('pending', 'delivering')`,
          )
          .run(timestamp, successor.id);
        this.db
          .prepare(
            `DELETE FROM delivery_leases
             WHERE message_id IN (SELECT id FROM messages WHERE run_id = ?)`,
          )
          .run(successor.id);
      }
      recovered += 1;
    }

    const dangling = this.db
      .prepare(
        `SELECT successor.id
         FROM runs AS successor
         WHERE successor.mode = 'agent' AND successor.is_primary = 1
           AND successor.primary_predecessor_run_id IS NOT NULL
           AND successor.primary_claim_token IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM runs AS predecessor
             WHERE predecessor.id = successor.primary_predecessor_run_id
               AND predecessor.primary_predecessor_run_id IS NULL
               AND predecessor.primary_claim_token = successor.primary_claim_token
           )
         LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    if (dangling) {
      throw new Error(
        `Primary successor run "${dangling.id}" has no matching staged predecessor claim.`,
      );
    }
    const incompleteSuccessor = this.db
      .prepare(
        `SELECT id
         FROM runs
         WHERE mode = 'agent' AND is_primary = 1
           AND primary_predecessor_run_id IS NOT NULL
           AND primary_claim_token IS NULL
           AND status = 'active' AND startup_state != 'ready'
         LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    if (incompleteSuccessor) {
      throw new Error(
        `Primary successor run "${incompleteSuccessor.id}" lost its staged claim token ` +
          "before startup completed.",
      );
    }
    return recovered;
  }

  markInterruptedWork(reason: string, ownerIsAlive: OwnerIsAlive = this.ownerIsAlive): number {
    return this.transaction(() => {
      const recoveredPrimaryClaims = this.recoverStalePrimaryClaimsInTransaction(
        reason,
        ownerIsAlive,
      );
      const timestamp = now();
      const active = this.db
        .prepare(
          `SELECT id, workspace, agent_id AS agentId, alias,
                  owner_pid AS ownerPid,
                  startup_state AS startupState,
                  is_primary AS isPrimary,
                  EXISTS (
                    SELECT 1 FROM agent_sessions
                    WHERE agent_sessions.run_id = runs.id
                  ) AS hasSession,
                  COALESCE((
                    SELECT CASE
                      WHEN messages.status = 'delivered'
                        AND messages.target = 'agent:' || runs.agent_id
                        AND messages.source = 'user'
                      THEN 1
                      ELSE 0
                    END
                    FROM messages
                    WHERE messages.run_id = runs.id
                      AND messages.kind = 'user'
                    ORDER BY messages.created_at, messages.sequence, messages.id
                    LIMIT 1
                  ), 0) AS hasDeliveredInitialTask
           FROM runs WHERE status = 'active'`,
        )
        .all() as unknown as Array<{
          id: string;
          workspace: string;
          agentId: string | null;
          alias: string | null;
          ownerPid: number | null;
          startupState: RunStartupState;
          isPrimary: number;
          hasSession: number;
          hasDeliveredInitialTask: number;
        }>;
      const stale = active.filter(
        (run) => run.ownerPid === null || !ownerIsAlive(run.ownerPid),
      );
      if (stale.length === 0) {
        return recoveredPrimaryClaims;
      }
      const promoteAcceptedStartup = this.db.prepare(
        `UPDATE runs
         SET startup_state = 'ready', recovery_eligible = 1
         WHERE id = ? AND mode = 'agent' AND is_primary = 0
           AND status = 'active' AND startup_state = 'session_created'`,
      );
      for (const run of stale) {
        if (
          run.isPrimary !== 0 ||
          run.startupState !== "session_created" ||
          run.hasSession !== 1 ||
          run.hasDeliveredInitialTask !== 1
        ) {
          continue;
        }
        const promoted = promoteAcceptedStartup.run(run.id);
        if (promoted.changes !== 1) {
          throw new Error(
            `Interrupted agent run "${run.id}" could not be promoted after its persisted ` +
              "initial task was accepted.",
          );
        }
        run.startupState = "ready";
      }
      const readyIds = stale
        .filter((run) => run.startupState === "ready")
        .map((run) => run.id);
      const startupIds = stale
        .filter((run) => run.startupState !== "ready")
        .map((run) => run.id);
      const startupIdSet = new Set(startupIds);
      const disqualifiedByWorkspace = new Map<string, Map<string, string>>();
      for (const run of stale) {
        if (
          run.startupState === "ready" ||
          run.agentId === null ||
          this.identitySurvivesOutsideRuns(run.workspace, run.agentId, startupIdSet)
        ) {
          continue;
        }
        const identities =
          disqualifiedByWorkspace.get(run.workspace) ?? new Map<string, string>();
        identities.set(run.agentId, run.alias ?? run.agentId);
        disqualifiedByWorkspace.set(run.workspace, identities);
      }
      for (const [workspace, identities] of disqualifiedByWorkspace) {
        this.rewriteWorkspaceAclsInTransaction(workspace, identities);
      }
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
             owner_pid = NULL,
             primary_claim_token = NULL
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
      return recoveredPrimaryClaims + staleIds.length;
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
   * Makes a connected primary run recoverable in the same transaction that adopts
   * mail from inactive predecessors. Only the predecessor named by the successor's
   * durable claim token is retired; unrelated or active primary runs are untouched.
   */
  completePrimaryStartup(
    runId: string,
    workspace: string,
    agentId: string,
    target: string,
    claim?: PrimaryStartupClaim,
  ): number {
    if (target !== `agent:${agentId}`) {
      throw new Error(
        `Primary startup target "${target}" does not match agent "${agentId}".`,
      );
    }
    return this.transaction(() => {
      const successor = this.db
        .prepare(
          `SELECT owner_pid AS ownerPid,
                  primary_predecessor_run_id AS predecessorRunId,
                  primary_claim_token AS claimToken,
                  startup_state AS startupState,
                  recovery_eligible AS recoveryEligible
           FROM runs
           WHERE id = ? AND workspace = ? AND mode = 'agent'
             AND is_primary = 1 AND agent_id = ?
             AND status = 'active' AND definition IS NOT NULL`,
        )
        .get(runId, workspace, agentId) as {
          ownerPid: number | null;
          predecessorRunId: string | null;
          claimToken: string | null;
          startupState: RunStartupState;
          recoveryEligible: number;
        } | undefined;
      if (!successor) {
        throw new Error(`Primary startup run "${runId}" does not exist.`);
      }
      const hasDurableClaim = successor.claimToken !== null;
      if (
        successor.predecessorRunId === null &&
        successor.claimToken !== null
      ) {
        throw new Error(
          `Primary startup run "${runId}" has an incomplete predecessor claim link.`,
        );
      }
      if (hasDurableClaim) {
        if (
          !claim ||
          claim.predecessorRunId !== successor.predecessorRunId ||
          claim.token !== successor.claimToken ||
          successor.ownerPid === null
        ) {
          throw new Error(
            `Primary startup run "${runId}" was not completed with its explicit staged claim.`,
          );
        }
      } else if (claim) {
        throw new Error(
          `Primary startup run "${runId}" does not own staged predecessor ` +
            `"${claim.predecessorRunId}".`,
        );
      }

      const adoptedMessages = this.adoptAgentMessagesInTransaction(
        runId,
        workspace,
        agentId,
        target,
        LEGACY_PRIMARY_IDENTITY,
      );
      this.completeRunStartupInTransaction(runId);
      if (claim && successor.ownerPid !== null) {
        this.retireClaimedPrimaryPredecessorInTransaction(
          {
            id: runId,
            workspace,
            agentId,
            ownerPid: successor.ownerPid,
            predecessorRunId: claim.predecessorRunId,
            claimToken: claim.token,
          },
          `Staged primary identity was claimed by successor run "${runId}"`,
        );
        const cleared = this.db
          .prepare(
            `UPDATE runs
             SET primary_claim_token = NULL
             WHERE id = ? AND primary_predecessor_run_id = ?
               AND primary_claim_token = ?`,
          )
          .run(runId, claim.predecessorRunId, claim.token);
        if (cleared.changes !== 1) {
          throw new Error(
            `Primary startup run "${runId}" could not finalize its staged claim.`,
          );
        }
      } else if (
        successor.startupState !== "ready" ||
        successor.recoveryEligible !== 1
      ) {
        const latest = this.db
          .prepare(
            `SELECT startup_state AS startupState,
                    recovery_eligible AS recoveryEligible
             FROM runs WHERE id = ?`,
          )
          .get(runId) as {
            startupState: RunStartupState;
            recoveryEligible: number;
          };
        if (latest.startupState !== "ready" || latest.recoveryEligible !== 1) {
          throw new Error(`Primary startup run "${runId}" did not become recoverable.`);
        }
      }
      return adoptedMessages;
    });
  }

  /**
   * Atomically retires the previous primary run, adopts its undelivered mail, and
   * makes the already-connected replacement recoverable.
   */
  completePrimaryReplacementStartup(
    runId: string,
    previousRunId: string,
    workspace: string,
    agentId: string,
    target: string,
    reason: string,
  ): number {
    if (runId === previousRunId) {
      throw new Error("A primary replacement must use a new run.");
    }
    return this.transaction(() => {
      const replacement = this.db
        .prepare(
          `SELECT startup_state AS startupState
           FROM runs
           WHERE id = ? AND workspace = ? AND mode = 'agent'
             AND is_primary = 1 AND agent_id = ? AND status = 'active'
             AND EXISTS (SELECT 1 FROM agent_sessions WHERE run_id = runs.id)`,
        )
        .get(runId, workspace, agentId) as { startupState: RunStartupState } | undefined;
      if (
        !replacement ||
        (replacement.startupState !== "reserved" &&
          replacement.startupState !== "session_created")
      ) {
        throw new Error(
          `Primary replacement run "${runId}" is not connected and ready for activation.`,
        );
      }
      const timestamp = now();
      const stopped = this.db
        .prepare(
          `UPDATE runs
           SET status = 'stopped', ended_at = ?, interruption_reason = ?, owner_pid = NULL
           WHERE id = ? AND workspace = ? AND mode = 'agent'
             AND is_primary = 1 AND agent_id = ? AND status = 'active'
             AND startup_state = 'ready'`,
        )
        .run(timestamp, reason, previousRunId, workspace, agentId);
      if (stopped.changes !== 1) {
        throw new Error(
          `Previous primary agent run "${previousRunId}" could not be retired atomically.`,
        );
      }
      const adoptedMessages = this.adoptAgentMessagesInTransaction(
        runId,
        workspace,
        agentId,
        target,
      );
      this.completeRunStartupInTransaction(runId);
      return adoptedMessages;
    });
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
    this.transaction(() => {
      const timestamp = now();
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
        .run(timestamp, reason, id, workspace, agentId);
      if (result.changes !== 1) {
        throw new Error(`Primary agent run "${id}" could not be disqualified from recovery.`);
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
             AND is_primary = 1 AND agent_id = ?
             AND startup_state = 'ready' AND status = 'active'`,
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

  /**
   * Atomically selects the latest unclaimed primary identity, reserves its alias,
   * marks the predecessor with a PID-owned token, and creates a fresh successor run.
   * A staged identity is completed in place; a ready predecessor keeps its SDK
   * conversation as history while the successor starts a new conversation.
   */
  claimPrimaryRun(
    id: string,
    freshAgentId: string,
    workspace: string,
    ownerPid: number,
    definitionFactory: PrimaryDefinitionFactory,
  ): ClaimedPrimaryRun {
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
      throw new Error("A primary startup claim requires a valid owner PID.");
    }
    let selectedAlias = PRIMARY_ALIAS;
    try {
      return this.transaction(() => {
        const existingClaims = this.db
          .prepare(
            `SELECT id, primary_claim_token AS claimToken, owner_pid AS ownerPid
             FROM runs
             WHERE workspace = ? AND mode = 'agent' AND is_primary = 1
               AND primary_predecessor_run_id IS NULL
               AND primary_claim_token IS NOT NULL`,
          )
          .all(workspace) as unknown as Array<{
            id: string;
            claimToken: string;
            ownerPid: number | null;
          }>;
        if (existingClaims.length > 0) {
          if (existingClaims.length > 1) {
            const details = existingClaims
              .map((claim) => `"${claim.id}" / token "${claim.claimToken}"`)
              .join(", ");
            throw new Error(
              `Workspace "${workspace}" has multiple staged primary claims (${details}); ` +
                "the durable state is ambiguous.",
            );
          }
          const claim = existingClaims[0]!;
          if (claim.ownerPid === null) {
            throw new Error(
              `Staged primary predecessor "${claim.id}" has claim token ` +
                `"${claim.claimToken}" but no owner PID.`,
            );
          }
          if (this.ownerPidIsAlive(claim.ownerPid, this.ownerIsAlive)) {
            throw new Error(
              `Staged primary identity in workspace "${workspace}" is already claimed by ` +
                `live host process ${claim.ownerPid}.`,
            );
          }
          throw new Error(
            `Staged primary identity in workspace "${workspace}" has a stale claim owned by ` +
              `process ${claim.ownerPid}. Run interrupted-work recovery before claiming it again.`,
          );
        }

        const predecessorRuns = this.agentRunRows(
          `workspace = ?
             AND is_primary = 1
             AND status != 'active'
             AND definition IS NOT NULL
             AND primary_predecessor_run_id IS NULL
             AND primary_claim_token IS NULL
             AND (
               (
                 recovery_eligible = 0
                 AND startup_state = 'reserved'
                 AND NOT EXISTS (
                   SELECT 1 FROM agent_sessions WHERE run_id = runs.id
                 )
               )
               OR
               (
                 recovery_eligible = 1
                 AND startup_state = 'ready'
                 AND EXISTS (
                   SELECT 1 FROM agent_sessions WHERE run_id = runs.id
                 )
               )
             )
           ORDER BY started_at DESC, id DESC`,
          workspace,
        );
        const predecessorAgentIds = new Set(
          predecessorRuns.map((run) => run.agentId),
        );
        if (predecessorAgentIds.size > 1) {
          const details = predecessorRuns
            .map((run) => `"${run.id}" / agent "${run.agentId}"`)
            .join(", ");
          throw new Error(
            `Workspace "${workspace}" has multiple claimable primary identities (${details}); ` +
              "the claim is ambiguous.",
          );
        }
        const predecessor = predecessorRuns[0];
        const reservedWorkerAliases = new Set(
          (
            this.db
              .prepare(
                `SELECT alias
                 FROM runs
                 WHERE workspace = ? AND mode = 'agent' AND is_primary = 0
                   AND alias IS NOT NULL AND agent_id IS NOT NULL
                   AND definition IS NOT NULL`,
              )
              .all(workspace) as unknown as Array<{ alias: string }>
          ).map((row) => row.alias),
        );
        if (
          predecessor &&
          predecessor.alias !== LEGACY_PRIMARY_IDENTITY &&
          predecessor.alias !== CALLER_ALIAS &&
          AGENT_ALIAS_PATTERN.test(predecessor.alias) &&
          !reservedWorkerAliases.has(predecessor.alias)
        ) {
          selectedAlias = predecessor.alias;
        } else {
          let attempt = 0;
          do {
            selectedAlias = primaryAliasCandidate(attempt);
            attempt += 1;
          } while (
            selectedAlias === LEGACY_PRIMARY_IDENTITY ||
            selectedAlias === CALLER_ALIAS ||
            reservedWorkerAliases.has(selectedAlias)
          );
        }

        const startedAt = now();
        const claimToken = predecessor ? randomUUID() : null;
        const agentId = predecessor?.agentId ?? freshAgentId;
        const definition = definitionFactory(
          predecessor?.definition ?? undefined,
          selectedAlias,
          agentId,
        );
        if (typeof definition !== "string" || definition.length === 0) {
          throw new Error("A primary startup claim requires a stored definition.");
        }
        let parsedDefinition: unknown;
        try {
          parsedDefinition = JSON.parse(definition);
        } catch (error) {
          throw new Error("A primary startup claim produced invalid definition JSON.", {
            cause: error,
          });
        }
        if (
          typeof parsedDefinition !== "object" ||
          parsedDefinition === null ||
          Array.isArray(parsedDefinition) ||
          typeof (parsedDefinition as Record<string, unknown>).definition !== "object" ||
          (parsedDefinition as Record<string, unknown>).definition === null ||
          Array.isArray((parsedDefinition as Record<string, unknown>).definition) ||
          (
            (parsedDefinition as { definition: Record<string, unknown> }).definition.id !==
            selectedAlias
          )
        ) {
          throw new Error(
            `A primary startup claim produced a definition that does not reserve alias ` +
              `"${selectedAlias}".`,
          );
        }
        this.db
          .prepare(
            `INSERT INTO runs(
               id, mode, agent_id, alias, definition, is_primary, startup_state,
               recovery_eligible, workspace, status, started_at, owner_pid,
               primary_predecessor_run_id, primary_claim_token
             ) VALUES (
               ?, 'agent', ?, ?, ?, 1, 'reserved',
               0, ?, 'active', ?, ?, ?, ?
             )`,
          )
          .run(
            id,
            agentId,
            selectedAlias,
            definition,
            workspace,
            startedAt,
            ownerPid,
            predecessor?.id ?? null,
            claimToken,
          );

        let claim: PrimaryStartupClaim | undefined;
        if (predecessor && claimToken) {
          const claimed = this.db
            .prepare(
              `UPDATE runs
               SET primary_claim_token = ?, owner_pid = ?
               WHERE id = ? AND workspace = ? AND mode = 'agent'
                 AND is_primary = 1 AND agent_id = ?
                 AND status != 'active' AND definition IS NOT NULL
                 AND primary_predecessor_run_id IS NULL
                 AND primary_claim_token IS NULL
                 AND (
                   (
                     recovery_eligible = 0
                     AND startup_state = 'reserved'
                     AND NOT EXISTS (
                       SELECT 1 FROM agent_sessions
                       WHERE agent_sessions.run_id = runs.id
                     )
                   )
                   OR
                   (
                     recovery_eligible = 1
                     AND startup_state = 'ready'
                     AND EXISTS (
                       SELECT 1 FROM agent_sessions
                       WHERE agent_sessions.run_id = runs.id
                     )
                   )
                 )`,
            )
            .run(
              claimToken,
              ownerPid,
              predecessor.id,
              workspace,
              predecessor.agentId,
            );
          if (claimed.changes !== 1) {
            throw new Error(
              `Primary predecessor "${predecessor.id}" could not be claimed atomically.`,
            );
          }
          claim = {
            predecessorRunId: predecessor.id,
            token: claimToken,
          };
        }

        const run: StoredAgentRun = {
          id,
          agentId,
          alias: selectedAlias,
          definition,
          isPrimary: true,
          startupState: "reserved",
          status: "active",
          startedAt,
          endedAt: null,
          primaryPredecessorRunId: predecessor?.id ?? null,
          primaryClaimToken: claimToken,
          session: undefined,
        };
        return claim ? { run, claim } : { run };
      });
    } catch (error) {
      this.aliasConflict(error, selectedAlias, workspace);
    }
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

  /**
   * Atomically reserves a new worker batch and persists the spawning caller's
   * resulting ACL definition. A caller-update failure leaves no reserved aliases.
   */
  createAgentRunsWithCallerUpdate(
    runs: readonly AgentRunReservation[],
    caller: AgentRunDefinitionUpdate,
  ): void {
    if (runs.length === 0) {
      throw new Error("An atomic agent batch must contain at least one run.");
    }
    let current: AgentRunReservation | AgentRunDefinitionUpdate | undefined;
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
        current = caller;
        const updated = this.db
          .prepare(
            `UPDATE runs
             SET alias = ?, definition = ?
             WHERE id = ? AND mode = 'agent' AND status = 'active'`,
          )
          .run(caller.alias, caller.definition, caller.id);
        if (updated.changes !== 1) {
          throw new Error(
            `Spawning caller run "${caller.id}" could not be updated atomically.`,
          );
        }
      });
    } catch (error) {
      if (current) {
        const workspace = "workspace" in current ? current.workspace : undefined;
        this.aliasConflict(error, current.alias, workspace);
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
   * permanently failed UUID from every persisted ACL in the workspace.
   */
  failAgentStartup(
    id: string,
    workspace: string,
    agentId: string,
    reason: string,
  ): boolean {
    return this.transaction(() => {
      const timestamp = now();
      const run = this.db
        .prepare(
          `SELECT alias, startup_state AS startupState,
                  owner_pid AS ownerPid,
                  primary_predecessor_run_id AS predecessorRunId,
                  primary_claim_token AS claimToken
           FROM runs
           WHERE id = ? AND workspace = ? AND mode = 'agent' AND agent_id = ?`,
        )
        .get(id, workspace, agentId) as {
          alias: string | null;
          startupState: RunStartupState;
          ownerPid: number | null;
          predecessorRunId: string | null;
          claimToken: string | null;
        } | undefined;
      if (!run || run.startupState === "ready") {
        throw new Error(
          `Agent run "${id}" could not be released after its startup failed.`,
        );
      }
      if (run.predecessorRunId === null && run.claimToken !== null) {
        throw new Error(
          `Agent run "${id}" has an incomplete staged-primary claim link.`,
        );
      }
      if (run.predecessorRunId !== null && run.claimToken !== null) {
        if (run.ownerPid === null) {
          throw new Error(
            `Agent run "${id}" has a staged-primary claim but no owner PID.`,
          );
        }
        this.releaseClaimedPrimaryPredecessorInTransaction({
          id,
          workspace,
          agentId,
          ownerPid: run.ownerPid,
          predecessorRunId: run.predecessorRunId,
          claimToken: run.claimToken,
        });
      }
      const permanentlyDisqualified =
        !this.identitySurvivesOutsideRuns(workspace, agentId, new Set([id]));
      if (permanentlyDisqualified) {
        this.rewriteWorkspaceAclsInTransaction(
          workspace,
          new Map([[agentId, run.alias ?? agentId]]),
        );
      }
      const failed = this.db
        .prepare(
          `UPDATE runs
           SET definition = NULL,
               startup_state = 'failed',
               recovery_eligible = 0,
               status = 'interrupted',
               ended_at = COALESCE(ended_at, ?),
               interruption_reason = ?,
               owner_pid = NULL,
               primary_claim_token = NULL
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
      return permanentlyDisqualified;
    });
  }

  private agentRunRows(where: string, ...parameters: Array<string | number>): StoredAgentRun[] {
    const rows = this.db
      .prepare(
        `SELECT id, agent_id AS agentId, alias, definition, is_primary AS isPrimary,
                startup_state AS startupState, status,
                started_at AS startedAt, ended_at AS endedAt,
                primary_predecessor_run_id AS primaryPredecessorRunId,
                primary_claim_token AS primaryClaimToken
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

  /**
   * Sessionless legacy primary identity retained only long enough for a fresh
   * primary run to inherit its UUID, ACLs, and pending mailbox. Runtime startup
   * must use claimPrimaryRun rather than composing this read with createAgentRun.
   */
  stagedPrimaryRun(workspace: string): StoredAgentRun | undefined {
    return this.agentRunRows(
      `workspace = ?
         AND is_primary = 1
         AND recovery_eligible = 0
         AND startup_state = 'reserved'
         AND status != 'active'
         AND definition IS NOT NULL
         AND primary_predecessor_run_id IS NULL
         AND primary_claim_token IS NULL
         AND NOT EXISTS (SELECT 1 FROM agent_sessions WHERE run_id = runs.id)
       ORDER BY started_at DESC
       LIMIT 1`,
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
    this.transaction(() => {
      const run = this.db
        .prepare(
          `SELECT runs.agent_id AS agentId, runs.workspace,
                  agent_sessions.session_id AS sessionId
           FROM runs
           JOIN agent_sessions ON agent_sessions.run_id = runs.id
           WHERE runs.id = ? AND runs.mode = 'agent'
             AND runs.agent_id IS NOT NULL AND runs.definition IS NOT NULL`,
        )
        .get(id) as {
          agentId: string;
          workspace: string;
          sessionId: string;
        } | undefined;
      if (!run) {
        throw new Error(`Agent run "${id}" could not be resumed.`);
      }
      const owner = this.sessionOwner(run.sessionId);
      if (
        !owner ||
        owner.agentId !== run.agentId ||
        owner.workspace !== run.workspace
      ) {
        throw new Error(
          `Agent run "${id}" cannot resume SDK session "${run.sessionId}" because its durable ` +
            "ownership is missing or belongs to another agent.",
        );
      }
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
    });
  }

  updateAgentRun(
    id: string,
    alias: string,
    definition: string,
  ): void {
    this.updateAgentRuns([{ id, alias, definition }]);
  }

  /** Atomically replaces one or more persisted agent definitions. */
  updateAgentRuns(updates: readonly AgentRunDefinitionUpdate[]): void {
    const ids = new Set<string>();
    for (const update of updates) {
      if (ids.has(update.id)) {
        throw new Error(`Agent run "${update.id}" was included more than once in one update.`);
      }
      ids.add(update.id);
    }
    let current: AgentRunDefinitionUpdate | undefined;
    try {
      this.transaction(() => {
        const updateRun = this.db.prepare(
          `UPDATE runs
           SET alias = ?, definition = ?
           WHERE id = ? AND mode = 'agent'`,
        );
        for (const update of updates) {
          current = update;
          const result = updateRun.run(update.alias, update.definition, update.id);
          if (result.changes !== 1) {
            throw new Error(
              `Agent run "${update.id}" could not be updated with a new definition.`,
            );
          }
        }
      });
    } catch (error) {
      this.aliasConflict(error, current?.alias ?? "unknown");
    }
  }

  finishRun(id: string, status: Exclude<RunStatus, "active">, reason?: string): void {
    this.transaction(() => {
      const timestamp = now();
      const row = this.db
        .prepare(
          `SELECT workspace, agent_id AS agentId, alias,
                  startup_state AS startupState, owner_pid AS ownerPid,
                  primary_predecessor_run_id AS predecessorRunId,
                  primary_claim_token AS claimToken
           FROM runs WHERE id = ? AND status = 'active'`,
        )
        .get(id) as {
          workspace: string;
          agentId: string | null;
          alias: string | null;
          startupState: RunStartupState;
          ownerPid: number | null;
          predecessorRunId: string | null;
          claimToken: string | null;
        } | undefined;
      if (!row) {
        return;
      }
      const startupFailed = row.startupState !== "ready";
      if (row.predecessorRunId === null && row.claimToken !== null) {
        throw new Error(`Agent run "${id}" has an incomplete staged-primary claim link.`);
      }
      if (
        row.predecessorRunId !== null &&
        row.claimToken !== null &&
        (row.agentId === null || row.ownerPid === null)
      ) {
        throw new Error(
          `Agent run "${id}" has a staged-primary claim without a complete owner identity.`,
        );
      }
      if (
        startupFailed &&
        row.agentId !== null &&
        row.ownerPid !== null &&
        row.predecessorRunId !== null &&
        row.claimToken !== null
      ) {
        this.releaseClaimedPrimaryPredecessorInTransaction({
          id,
          workspace: row.workspace,
          agentId: row.agentId,
          ownerPid: row.ownerPid,
          predecessorRunId: row.predecessorRunId,
          claimToken: row.claimToken,
        });
      }
      if (
        startupFailed &&
        row.agentId !== null &&
        !this.identitySurvivesOutsideRuns(row.workspace, row.agentId, new Set([id]))
      ) {
        this.rewriteWorkspaceAclsInTransaction(
          row.workspace,
          new Map([[row.agentId, row.alias ?? row.agentId]]),
        );
      }
      this.db
        .prepare(
          `UPDATE runs
           SET status = ?,
               ended_at = ?,
               interruption_reason = ?,
               definition = CASE WHEN ? = 1 THEN NULL ELSE definition END,
               startup_state = CASE WHEN ? = 1 THEN 'failed' ELSE startup_state END,
               recovery_eligible = CASE WHEN ? = 1 THEN 0 ELSE recovery_eligible END,
               owner_pid = NULL,
               primary_claim_token = CASE WHEN ? = 1 THEN NULL ELSE primary_claim_token END
           WHERE id = ? AND status = 'active'`,
        )
        .run(
          status,
          timestamp,
          reason ?? null,
          startupFailed ? 1 : 0,
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
      const run = this.db
        .prepare(
          `SELECT agent_id AS agentId, workspace
           FROM runs
           WHERE id = ? AND mode = 'agent'
             AND agent_id IS NOT NULL AND definition IS NOT NULL`,
        )
        .get(runId) as { agentId: string; workspace: string } | undefined;
      if (!run) {
        throw new Error(
          `Agent run "${runId}" cannot claim SDK session "${sessionId}".`,
        );
      }
      const owner = this.sessionOwner(sessionId);
      if (
        owner &&
        (owner.agentId !== run.agentId || owner.workspace !== run.workspace)
      ) {
        throw new Error(
          `SDK session "${sessionId}" is already durably owned by agent ` +
            `"${owner.agentId}" in workspace "${owner.workspace}" and cannot be assigned to ` +
            `agent "${run.agentId}" in workspace "${run.workspace}".`,
        );
      }
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
    this.transaction(() => this.completeRunStartupInTransaction(runId));
  }

  private completeRunStartupInTransaction(
    runId: string,
    initialMessage?: { id: string; target: string },
  ): void {
    const current = this.db
      .prepare(
        `SELECT agent_id AS agentId, is_primary AS isPrimary,
                startup_state AS startupState,
                recovery_eligible AS recoveryEligible
         FROM runs WHERE id = ? AND mode = 'agent'`,
      )
      .get(runId) as {
        agentId: string | null;
        isPrimary: number;
        startupState: RunStartupState;
        recoveryEligible: number;
      } | undefined;
    if (!current) {
      throw new Error(`Agent run "${runId}" does not exist.`);
    }
    if (current.isPrimary === 1 && initialMessage !== undefined) {
      throw new Error(
        `Primary agent run "${runId}" does not use a user-message startup transition.`,
      );
    }
    if (current.isPrimary !== 1) {
      if (!current.agentId) {
        throw new Error(
          `Agent run "${runId}" has no durable identity for its initial task.`,
        );
      }
      const target = `agent:${current.agentId}`;
      if (initialMessage && initialMessage.target !== target) {
        throw new Error(
          `Initial task message "${initialMessage.id}" targets "${initialMessage.target}" ` +
            `instead of agent run "${runId}".`,
        );
      }
      const firstUserMessage = this.db
        .prepare(
          `SELECT id, source, target, status
           FROM messages
           WHERE run_id = ? AND kind = 'user'
           ORDER BY created_at, sequence, id
           LIMIT 1`,
        )
        .get(runId) as {
          id: string;
          source: string;
          target: string;
          status: MessageStatus;
        } | undefined;
      if (
        !firstUserMessage ||
        firstUserMessage.source !== "user" ||
        firstUserMessage.target !== target ||
        firstUserMessage.status !== "delivered" ||
        (
          initialMessage !== undefined &&
          firstUserMessage.id !== initialMessage.id
        )
      ) {
        throw new Error(
          `Agent run "${runId}" cannot become recoverable because its first user task ` +
            "was not durably accepted.",
        );
      }
    }
    if (current.startupState === "ready" && current.recoveryEligible === 1) {
      return;
    }
    const result = this.db
      .prepare(
        `UPDATE runs
         SET startup_state = 'ready', recovery_eligible = 1
         WHERE id = ? AND mode = 'agent' AND status = 'active'
           AND startup_state IN ('reserved', 'session_created')
           AND EXISTS (SELECT 1 FROM agent_sessions WHERE run_id = runs.id)`,
      )
      .run(runId);
    if (result.changes !== 1) {
      const latest = this.db
        .prepare(
          `SELECT startup_state AS startupState, recovery_eligible AS recoveryEligible
           FROM runs WHERE id = ? AND mode = 'agent'`,
        )
        .get(runId) as { startupState: RunStartupState; recoveryEligible: number } | undefined;
      if (latest?.startupState === "ready" && latest.recoveryEligible === 1) {
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

  private resetExpiredDeliveriesInTransaction(timestamp: string): void {
    this.db
      .prepare(
        `UPDATE messages
         SET status = 'pending', updated_at = ?
         WHERE status = 'delivering'
           AND (
             NOT EXISTS (
               SELECT 1 FROM delivery_leases
               WHERE delivery_leases.message_id = messages.id
                 AND delivery_leases.run_id = messages.run_id
                 AND delivery_leases.target = messages.target
             )
             OR EXISTS (
               SELECT 1 FROM delivery_leases
               WHERE delivery_leases.message_id = messages.id
                 AND delivery_leases.run_id = messages.run_id
                 AND delivery_leases.target = messages.target
                 AND delivery_leases.lease_until <= ?
             )
           )`,
      )
      .run(timestamp, timestamp);
  }

  private claimRowsInTransaction(
    rows: StoredMessage[],
    runId: string,
    target: string,
    timestamp: string,
    leaseUntil: string,
  ): ClaimedMessage[] {
    const update = this.db.prepare(
      `UPDATE messages
       SET status = 'delivering', updated_at = ?
       WHERE id = ? AND run_id = ? AND target = ? AND status = 'pending'`,
    );
    const lease = this.db.prepare(
      `INSERT INTO delivery_leases(
         message_id, run_id, target, lease_token, lease_until, attempts, last_error
       ) VALUES (?, ?, ?, ?, ?, 1, NULL)
       ON CONFLICT(message_id) DO UPDATE SET
         run_id = excluded.run_id,
         target = excluded.target,
         lease_token = excluded.lease_token,
         lease_until = excluded.lease_until,
         attempts = delivery_leases.attempts + 1,
         last_error = NULL`,
    );
    const attempts = this.db.prepare(
      "SELECT attempts FROM delivery_leases WHERE message_id = ?",
    );
    return rows.map((row): ClaimedMessage => {
      const leaseToken = randomUUID();
      const claimed = update.run(timestamp, row.id, runId, target);
      if (claimed.changes !== 1) {
        throw new Error(`Message "${row.id}" could not be claimed from its current mailbox.`);
      }
      lease.run(row.id, runId, target, leaseToken, leaseUntil);
      return {
        ...row,
        status: "delivering",
        updatedAt: timestamp,
        leaseToken,
        leaseUntil,
        deliveryAttempts:
          (attempts.get(row.id) as { attempts: number } | undefined)?.attempts ?? 1,
      };
    });
  }

  claimMessage(
    id: string,
    runId: string,
    target: string,
    leaseMs = 60_000,
  ): ClaimedMessage | undefined {
    return this.transaction(() => {
      const timestamp = now();
      this.resetExpiredDeliveriesInTransaction(timestamp);
      const row = this.db
        .prepare(
          `SELECT
             id, run_id AS runId, source, target, kind, content, status, sequence,
             created_at AS createdAt, updated_at AS updatedAt
           FROM messages
           WHERE id = ? AND run_id = ? AND target = ? AND status = 'pending'`,
        )
        .get(id, runId, target) as unknown as StoredMessage | undefined;
      if (!row) {
        return undefined;
      }
      const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
      return this.claimRowsInTransaction(
        [row],
        runId,
        target,
        timestamp,
        leaseUntil,
      )[0];
    });
  }

  claimMessages(runId: string, target: string, limit = 1, leaseMs = 60_000): ClaimedMessage[] {
    return this.transaction(() => {
      const timestamp = now();
      this.resetExpiredDeliveriesInTransaction(timestamp);
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
      const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
      return this.claimRowsInTransaction(rows, runId, target, timestamp, leaseUntil);
    });
  }

  private completeMessageInTransaction(
    id: string,
    runId: string,
    target: string,
    leaseToken: string,
    timestamp = now(),
  ): boolean {
    const completed = this.db
      .prepare(
        `UPDATE messages
         SET status = 'delivered', updated_at = ?
         WHERE id = ? AND run_id = ? AND target = ? AND status = 'delivering'
           AND EXISTS (
             SELECT 1 FROM delivery_leases
             WHERE delivery_leases.message_id = messages.id
               AND delivery_leases.run_id = messages.run_id
               AND delivery_leases.target = messages.target
               AND delivery_leases.lease_token = ?
               AND delivery_leases.lease_until > ?
           )`,
      )
      .run(timestamp, id, runId, target, leaseToken, timestamp);
    if (completed.changes !== 1) {
      return false;
    }
    this.db
      .prepare(
        `DELETE FROM delivery_leases
         WHERE message_id = ? AND run_id = ? AND target = ? AND lease_token = ?`,
      )
      .run(id, runId, target, leaseToken);
    return true;
  }

  completeMessage(id: string, runId: string, target: string, leaseToken: string): boolean {
    return this.transaction(() =>
      this.completeMessageInTransaction(id, runId, target, leaseToken),
    );
  }

  /**
   * Commits SDK acceptance of the first user task and startup recoverability as
   * one durable transition. A stale lease or a later user message changes nothing.
   */
  completeInitialTask(
    id: string,
    runId: string,
    target: string,
    leaseToken: string,
  ): boolean {
    return this.transaction(() => {
      if (
        !this.completeMessageInTransaction(
          id,
          runId,
          target,
          leaseToken,
        )
      ) {
        return false;
      }
      this.completeRunStartupInTransaction(runId, { id, target });
      return true;
    });
  }

  failMessage(
    id: string,
    runId: string,
    target: string,
    leaseToken: string,
    error: string,
    retry: boolean,
  ): boolean {
    return this.transaction(() => {
      const timestamp = now();
      const status: MessageStatus = retry ? "pending" : "failed";
      const failed = this.db
        .prepare(
          `UPDATE messages
           SET status = ?, updated_at = ?
           WHERE id = ? AND run_id = ? AND target = ? AND status = 'delivering'
             AND EXISTS (
               SELECT 1 FROM delivery_leases
               WHERE delivery_leases.message_id = messages.id
                 AND delivery_leases.run_id = messages.run_id
                 AND delivery_leases.target = messages.target
                 AND delivery_leases.lease_token = ?
                 AND delivery_leases.lease_until > ?
             )`,
        )
        .run(status, timestamp, id, runId, target, leaseToken, timestamp);
      if (failed.changes !== 1) {
        return false;
      }
      this.db
        .prepare(
          `UPDATE delivery_leases
           SET lease_token = ?, lease_until = ?, last_error = ?
           WHERE message_id = ? AND run_id = ? AND target = ? AND lease_token = ?`,
        )
        .run(randomUUID(), timestamp, error, id, runId, target, leaseToken);
      return true;
    });
  }

  releaseMessage(
    id: string,
    runId: string,
    target: string,
    leaseToken: string,
    reason: string,
  ): boolean {
    return this.failMessage(id, runId, target, leaseToken, reason, true);
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
