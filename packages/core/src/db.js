import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Versioned migrations. Append new entries; never edit a shipped one.
const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('demo', 'project')),
        root_path TEXT,
        created_at INTEGER NOT NULL,
        archived_at INTEGER
      );
      CREATE TABLE agent_profiles (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        color TEXT NOT NULL,
        initials TEXT NOT NULL,
        specialty TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '',
        working_state TEXT NOT NULL,
        runtime TEXT,
        model TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER
      );
      CREATE INDEX agent_profiles_workspace ON agent_profiles(workspace_id, position);
      CREATE TABLE connections (
        id TEXT PRIMARY KEY,
        workspace_id TEXT REFERENCES workspaces(id),
        provider TEXT NOT NULL,
        alias TEXT NOT NULL,
        host TEXT NOT NULL DEFAULT 'local',
        auth_ref TEXT,
        capabilities TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        priority TEXT NOT NULL,
        status TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL,
        assigned_agent_id TEXT REFERENCES agent_profiles(id),
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER
      );
      CREATE INDEX tasks_workspace ON tasks(workspace_id);
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        agent_id TEXT NOT NULL REFERENCES agent_profiles(id),
        agent_snapshot TEXT NOT NULL,
        connection_id TEXT REFERENCES connections(id),
        provider TEXT NOT NULL,
        requested_model TEXT,
        actual_model TEXT,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );
      CREATE INDEX runs_task ON runs(task_id);
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        run_id TEXT REFERENCES runs(id),
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        agent_id TEXT,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX events_workspace ON events(workspace_id, sequence DESC);
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_at INTEGER NOT NULL,
        decided_at INTEGER
      );
    `,
  },
  {
    // Roadmap R2–R5: observed/managed runs, connections, approvals, audit,
    // policies, workflows, context manifests, settings.
    version: 2,
    sql: `
      ALTER TABLE workspaces ADD COLUMN auto_created INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE workspaces ADD COLUMN policy TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE workspaces ADD COLUMN theme TEXT NOT NULL DEFAULT 'studio';
      ALTER TABLE workspaces ADD COLUMN settings TEXT NOT NULL DEFAULT '{}';

      ALTER TABLE agent_profiles ADD COLUMN provider TEXT;
      ALTER TABLE agent_profiles ADD COLUMN auto_created INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE agent_profiles ADD COLUMN connection_id TEXT;
      ALTER TABLE agent_profiles ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE agent_profiles ADD COLUMN avatar TEXT;

      ALTER TABLE tasks ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE tasks ADD COLUMN deliverable TEXT NOT NULL DEFAULT '';
      ALTER TABLE tasks ADD COLUMN target TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE tasks ADD COLUMN provider TEXT;
      ALTER TABLE tasks ADD COLUMN execution_policy TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE tasks ADD COLUMN template_id TEXT;
      ALTER TABLE tasks ADD COLUMN workflow_id TEXT;
      ALTER TABLE tasks ADD COLUMN context TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE tasks ADD COLUMN updated_at INTEGER;
      ALTER TABLE tasks ADD COLUMN review TEXT NOT NULL DEFAULT '{}';

      ALTER TABLE runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'manual';
      ALTER TABLE runs ADD COLUMN provider_session_id TEXT;
      ALTER TABLE runs ADD COLUMN cwd TEXT;
      ALTER TABLE runs ADD COLUMN branch TEXT;
      ALTER TABLE runs ADD COLUMN worktree TEXT;
      ALTER TABLE runs ADD COLUMN host TEXT NOT NULL DEFAULT 'local';
      ALTER TABLE runs ADD COLUMN label TEXT;
      ALTER TABLE runs ADD COLUMN title TEXT;
      ALTER TABLE runs ADD COLUMN current_action TEXT;
      ALTER TABLE runs ADD COLUMN current_file TEXT;
      ALTER TABLE runs ADD COLUMN activity TEXT;
      ALTER TABLE runs ADD COLUMN last_event_at INTEGER;
      ALTER TABLE runs ADD COLUMN usage TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE runs ADD COLUMN cost TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE runs ADD COLUMN exit_code INTEGER;
      ALTER TABLE runs ADD COLUMN error TEXT;
      ALTER TABLE runs ADD COLUMN pid INTEGER;
      ALTER TABLE runs ADD COLUMN source_path TEXT;
      ALTER TABLE runs ADD COLUMN source_offset INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE runs ADD COLUMN summary TEXT;
      ALTER TABLE runs ADD COLUMN orchestration_owner TEXT NOT NULL DEFAULT 'agent-space';
      ALTER TABLE runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE runs ADD COLUMN parent_run_id TEXT;
      ALTER TABLE runs ADD COLUMN config_snapshot TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE runs ADD COLUMN context TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE runs ADD COLUMN prompt TEXT;
      CREATE UNIQUE INDEX runs_provider_session ON runs(provider, provider_session_id)
        WHERE provider_session_id IS NOT NULL;
      CREATE INDEX runs_workspace_status ON runs(workspace_id, status);

      ALTER TABLE events ADD COLUMN provenance TEXT NOT NULL DEFAULT 'system';
      ALTER TABLE events ADD COLUMN data TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE events ADD COLUMN tool TEXT;
      ALTER TABLE events ADD COLUMN file TEXT;
      ALTER TABLE events ADD COLUMN provider_event_id TEXT;
      ALTER TABLE events ADD COLUMN task_id TEXT;
      CREATE UNIQUE INDEX events_provider_event ON events(provider_event_id)
        WHERE provider_event_id IS NOT NULL;
      CREATE INDEX events_run ON events(run_id, sequence);

      ALTER TABLE connections ADD COLUMN status TEXT NOT NULL DEFAULT 'unknown';
      ALTER TABLE connections ADD COLUMN version TEXT;
      ALTER TABLE connections ADD COLUMN binary_path TEXT;
      ALTER TABLE connections ADD COLUMN home_path TEXT;
      ALTER TABLE connections ADD COLUMN last_probe_at INTEGER;
      ALTER TABLE connections ADD COLUMN last_event_at INTEGER;
      ALTER TABLE connections ADD COLUMN error TEXT;
      ALTER TABLE connections ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE connections ADD COLUMN observe INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE connections ADD COLUMN owner TEXT;
      ALTER TABLE connections ADD COLUMN allowed_workspaces TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE connections ADD COLUMN details TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE connections ADD COLUMN updated_at INTEGER;
      CREATE UNIQUE INDEX connections_provider_alias ON connections(provider, alias);

      ALTER TABLE approvals ADD COLUMN workspace_id TEXT;
      ALTER TABLE approvals ADD COLUMN task_id TEXT;
      ALTER TABLE approvals ADD COLUMN kind TEXT NOT NULL DEFAULT 'tool';
      ALTER TABLE approvals ADD COLUMN payload TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE approvals ADD COLUMN reason TEXT;
      ALTER TABLE approvals ADD COLUMN decision TEXT;
      ALTER TABLE approvals ADD COLUMN decided_by TEXT;
      ALTER TABLE approvals ADD COLUMN expires_at INTEGER;
      ALTER TABLE approvals ADD COLUMN provider TEXT;
      ALTER TABLE approvals ADD COLUMN provider_ref TEXT;
      CREATE INDEX approvals_status ON approvals(status, requested_at);

      ALTER TABLE artifacts ADD COLUMN workspace_id TEXT;
      ALTER TABLE artifacts ADD COLUMN task_id TEXT;
      ALTER TABLE artifacts ADD COLUMN title TEXT;
      ALTER TABLE artifacts ADD COLUMN content TEXT;
      ALTER TABLE artifacts ADD COLUMN size INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE artifacts ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';

      CREATE TABLE audit_log (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        workspace_id TEXT,
        run_id TEXT,
        policy_decision TEXT,
        details TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX audit_log_time ON audit_log(timestamp DESC);

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE observed_sessions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        cwd TEXT,
        title TEXT,
        source_path TEXT,
        source_offset INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER,
        updated_at INTEGER,
        ended_at INTEGER,
        live INTEGER NOT NULL DEFAULT 0,
        model TEXT,
        run_id TEXT,
        workspace_id TEXT,
        agent_id TEXT,
        metadata TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX observed_sessions_provider ON observed_sessions(provider, updated_at DESC);

      CREATE TABLE workflows (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        name TEXT NOT NULL,
        template_id TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        definition TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
];

export function openDatabase(path = ":memory:") {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
    // WAL is durable at checkpoint; NORMAL skips the per-commit fsync that
    // otherwise dominates the observation poll (one commit per event).
    db.exec("PRAGMA synchronous = NORMAL");
  }
  db.exec(
    "CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const applied = new Set(
    db
      .prepare("SELECT version FROM migrations")
      .all()
      .map((row) => row.version),
  );
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO migrations VALUES (?, ?)").run(
        migration.version,
        Date.now(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return db;
}

export function schemaVersion(db) {
  return db.prepare("SELECT MAX(version) AS version FROM migrations").get()
    .version;
}

export function transaction(db, work) {
  db.exec("SAVEPOINT work");
  try {
    const result = work();
    db.exec("RELEASE work");
    return result;
  } catch (error) {
    db.exec("ROLLBACK TO work");
    db.exec("RELEASE work");
    throw error;
  }
}
