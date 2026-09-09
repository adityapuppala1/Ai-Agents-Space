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
];

export function openDatabase(path = ":memory:") {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
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
