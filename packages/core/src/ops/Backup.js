import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { InputError } from "../TaskStore.js";
import { openDatabase, schemaVersion } from "../db.js";
import { isWithin, normalizePath, providerHome } from "../util/paths.js";

const PROVIDER_IDS = ["claude-code", "codex", "copilot", "cursor", "gemini"];

/** Tables whose row counts are recorded in the manifest and compared on drill. */
export const COUNTED_TABLES = [
  "workspaces",
  "agent_profiles",
  "connections",
  "tasks",
  "runs",
  "events",
  "artifacts",
  "approvals",
  "audit_log",
  "settings",
  "observed_sessions",
  "workflows",
];

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Row counts for the tables that exist in this database. */
export function tableCounts(db, tables = COUNTED_TABLES) {
  const counts = {};
  for (const table of tables) {
    try {
      counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    } catch {
      /* table not present in this schema version */
    }
  }
  return counts;
}

/** The file backing the main database, or null for an in-memory database. */
export function databaseFile(db, fallback = null) {
  try {
    const rows = db.prepare("PRAGMA database_list").all();
    const main = rows.find((row) => row.name === "main") ?? rows[0];
    if (main?.file) return main.file;
  } catch {
    /* older builds may not expose the pragma through prepare() */
  }
  return fallback && fallback !== ":memory:" ? fallback : null;
}

/**
 * Refuses any path inside a provider home; those directories are never ours.
 * Returns the path unchanged (comparison is normalized, the value is not).
 */
export function assertOutsideProviderHomes(path, env = process.env) {
  const target = normalizePath(path);
  for (const provider of PROVIDER_IDS) {
    let home = null;
    try {
      home = providerHome(provider, env);
    } catch {
      home = null;
    }
    if (!home) continue;
    if (isWithin(target, home) || normalizePath(home) === target)
      throw new InputError(
        `Refusing to write inside the ${provider} home directory (${home}). Choose a path outside every provider home.`,
        400,
      );
  }
  return path;
}

/**
 * Backup, restore, and restore drills for the local SQLite database.
 *
 * Backups use SQLite's own `VACUUM INTO`, which produces a consistent copy of
 * a live database without stopping writers. Each backup gets a sidecar
 * `<file>.manifest.json` holding the schema version, per-table row counts, the
 * file size, and the SHA-256 of the backup itself.
 *
 * Restore is deliberately offline: the file is written next to the live
 * database and the operator is told to restart. Overwriting an open SQLite
 * file would corrupt the running process's page cache, so a restore that
 * targets the live database is refused.
 */
export class BackupService {
  constructor(services, { now = Date.now, env = process.env } = {}) {
    this.services = services;
    this.db = services.db;
    this.now = now;
    this.env = env;
  }

  livePath() {
    return databaseFile(this.db, this.services.options?.dbPath ?? null);
  }

  /** backup({ outPath }) → { path, bytes, sha256, manifest, manifestPath } */
  backup({ outPath, actor = "local-user", label = null } = {}) {
    if (!outPath || typeof outPath !== "string")
      throw new InputError("outPath is required");
    const target = assertOutsideProviderHomes(resolve(outPath), this.env);
    if (existsSync(target))
      throw new InputError(
        "A file already exists at that path; backups never overwrite",
        409,
      );
    mkdirSync(dirname(target), { recursive: true });

    const counts = tableCounts(this.db);
    const version = schemaVersion(this.db);
    // VACUUM INTO takes a literal path; SQLite string quoting doubles quotes.
    this.db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);

    const bytes = statSync(target).size;
    const digest = sha256File(target);
    const manifest = {
      kind: "agent-space-backup",
      manifestVersion: 1,
      createdAt: this.now(),
      label: label ? String(label).slice(0, 120) : null,
      schemaVersion: version,
      sourcePath: this.livePath(),
      file: target,
      bytes,
      sha256: digest,
      counts,
    };
    const manifestPath = `${target}.manifest.json`;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    try {
      this.services.audit?.record?.({
        actor,
        action: "ops.backup",
        target,
        details: { bytes, schemaVersion: version, counts, sha256: digest },
      });
    } catch {
      /* audit is best effort */
    }
    return { path: target, bytes, sha256: digest, manifest, manifestPath };
  }

  /** Reads and validates the sidecar manifest for a backup file. */
  readManifest(inPath) {
    const manifestPath = `${inPath}.manifest.json`;
    if (!existsSync(manifestPath))
      throw new InputError(
        `No manifest found at ${manifestPath}; a backup without its manifest cannot be validated`,
        400,
      );
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      throw new InputError("The backup manifest is not readable JSON", 400);
    }
    if (manifest?.kind !== "agent-space-backup")
      throw new InputError("That manifest is not an Agent Space backup", 400);
    return { manifest, manifestPath };
  }

  /**
   * restore({ inPath, targetPath }) — validates the manifest, the file hash,
   * and the schema version, then writes the file. It refuses to write over the
   * database this process has open: restore is an offline operation.
   */
  restore({ inPath, targetPath, actor = "local-user", force = false } = {}) {
    if (!inPath || typeof inPath !== "string")
      throw new InputError("inPath is required");
    if (!targetPath || typeof targetPath !== "string")
      throw new InputError("targetPath is required");
    const source = resolve(inPath);
    if (!existsSync(source)) throw new InputError("Backup file not found", 404);
    const target = assertOutsideProviderHomes(resolve(targetPath), this.env);

    const live = this.livePath();
    if (live && normalizePath(live) === normalizePath(target))
      throw new InputError(
        "Refusing to restore over the database this server has open. Stop Agent Space, restore to the database path, then start it again.",
        409,
      );

    const { manifest } = this.readManifest(source);
    const digest = sha256File(source);
    if (manifest.sha256 && manifest.sha256 !== digest)
      throw new InputError(
        `Backup hash mismatch: the manifest expects ${manifest.sha256} but the file is ${digest}`,
        409,
      );
    const current = schemaVersion(this.db);
    if (
      !force &&
      Number.isInteger(manifest.schemaVersion) &&
      manifest.schemaVersion > current
    )
      throw new InputError(
        `The backup was written by schema version ${manifest.schemaVersion}; this build is at ${current}. Upgrade before restoring.`,
        409,
      );
    if (existsSync(target) && !force)
      throw new InputError(
        "A file already exists at the target path; pass force to overwrite",
        409,
      );
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    try {
      this.services.audit?.record?.({
        actor,
        action: "ops.restore",
        target,
        details: {
          from: source,
          schemaVersion: manifest.schemaVersion,
          sha256: digest,
        },
      });
    } catch {
      /* audit is best effort */
    }
    return {
      path: target,
      bytes: statSync(target).size,
      sha256: digest,
      manifest,
      restarted: false,
      message:
        "Restore written. Agent Space must be restarted against this file; the running process still holds the previous database.",
    };
  }

  /**
   * drill({ tmpDir }) — backup → restore into a temp path → openDatabase →
   * compare row counts. Never touches the live database file.
   * → { ok, checked, durationMs, mismatches, backup, restored }
   */
  drill({ tmpDir, actor = "local-user", keep = false } = {}) {
    const started = Date.now();
    const stamp = `${this.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const dir = resolve(
      tmpDir ?? join(tmpdir(), "agent-space-restore-drill", stamp),
    );
    assertOutsideProviderHomes(dir, this.env);
    mkdirSync(dir, { recursive: true });
    const backupPath = join(dir, `drill-${stamp}.db`);
    const restorePath = join(dir, `drill-${stamp}-restored.db`);
    let result;
    let restored;
    let db = null;
    try {
      result = this.backup({ outPath: backupPath, actor, label: "drill" });
      restored = this.restore({
        inPath: backupPath,
        targetPath: restorePath,
        actor,
      });
      db = openDatabase(restorePath);
      const restoredCounts = tableCounts(db);
      const sourceCounts = result.manifest.counts;
      const checked = {};
      const mismatches = [];
      for (const table of Object.keys(sourceCounts)) {
        const expected = sourceCounts[table];
        const actual = restoredCounts[table] ?? null;
        checked[table] = { expected, actual, ok: expected === actual };
        if (expected !== actual) mismatches.push(table);
      }
      const restoredVersion = schemaVersion(db);
      const ok =
        mismatches.length === 0 &&
        restoredVersion === result.manifest.schemaVersion;
      const report = {
        ok,
        checked,
        mismatches,
        schemaVersion: {
          expected: result.manifest.schemaVersion,
          actual: restoredVersion,
        },
        durationMs: Date.now() - started,
        backup: {
          path: result.path,
          bytes: result.bytes,
          sha256: result.sha256,
        },
        restored: { path: restored.path, bytes: restored.bytes },
        directory: dir,
        cleaned: !keep,
      };
      try {
        this.services.audit?.record?.({
          actor,
          action: "ops.restoreDrill",
          target: dir,
          details: {
            ok,
            mismatches,
            durationMs: report.durationMs,
            tables: Object.keys(checked).length,
          },
        });
      } catch {
        /* audit is best effort */
      }
      return report;
    } finally {
      try {
        db?.close();
      } catch {
        /* already closed */
      }
      if (!keep)
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* leave the drill files behind rather than fail the drill */
        }
    }
  }
}

/** Factory used by services.js: `createBackupService(services)`. */
export function createBackupService(services, options = {}) {
  const backup = new BackupService(services, options);
  services.backup = backup;
  return backup;
}
