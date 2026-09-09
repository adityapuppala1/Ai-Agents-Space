import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir, tmpdir, platform, arch, release, type } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InputError } from "../TaskStore.js";
import { schemaVersion } from "../db.js";
import { redactSecrets } from "../audit/Audit.js";
import { assertOutsideProviderHomes } from "./Backup.js";
import { basenameOf } from "../util/paths.js";

const EVENT_LIMIT = 200;
const AUDIT_LIMIT = 200;

/** Anything that looks like a credential in free text is blanked out. */
const SECRET_TEXT = [
  [/\b(sk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[redacted:key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, "[redacted:github-token]"],
  [
    /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
    "[redacted:jwt]",
  ],
  [/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer [redacted]"],
];

/** Replaces the user's home directory with <home> anywhere it appears. */
export function maskHome(text, home = homedir()) {
  if (typeof text !== "string" || !home) return text;
  const variants = new Set([
    home,
    home.replaceAll("\\", "/"),
    home.replaceAll("\\", "\\\\"),
  ]);
  let out = text;
  for (const variant of variants) {
    if (!variant) continue;
    const pattern = new RegExp(
      variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "gi",
    );
    out = out.replace(pattern, "<home>");
  }
  return out;
}

/** Masks home paths and obvious secret literals in a serialized bundle. */
export function scrubText(text, home = homedir()) {
  let out = maskHome(text, home);
  for (const [pattern, replacement] of SECRET_TEXT)
    out = out.replace(pattern, replacement);
  return out;
}

function readPackageVersions(root) {
  const files = [
    ["agent-space", join(root, "package.json")],
    ["@agent-space/core", join(root, "packages", "core", "package.json")],
    ["@agent-space/server", join(root, "packages", "server", "package.json")],
    ["@agent-space/web", join(root, "apps", "web", "package.json")],
  ];
  const out = {};
  for (const [name, file] of files) {
    try {
      if (!existsSync(file)) continue;
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      out[parsed.name ?? name] = parsed.version ?? null;
    } catch {
      /* unreadable package.json is not worth failing the bundle */
    }
  }
  return out;
}

/**
 * Exportable support bundle.
 *
 * What goes in: the health snapshot, schema/migration state, connection rows
 * (binary paths only), the last 200 audit rows, optionally the last 200 events
 * with file paths reduced to basenames, the public settings subset, package
 * versions, and OS/Node information.
 *
 * What never goes in: prompts, transcripts, event payload data, file contents,
 * tokens or auth hints, and absolute user paths (the home directory is masked
 * to `<home>`). Every exclusion is listed in the bundle's `redaction` report,
 * so a reader can see what was removed rather than guess.
 */
export class DiagnosticsService {
  constructor(
    services,
    { now = Date.now, home = homedir(), env = process.env } = {},
  ) {
    this.services = services;
    this.db = services.db;
    this.now = now;
    this.home = home;
    this.env = env;
  }

  #migrations() {
    try {
      return this.db
        .prepare("SELECT version, applied_at FROM migrations ORDER BY version")
        .all()
        .map((row) => ({ version: row.version, appliedAt: row.applied_at }));
    } catch {
      return [];
    }
  }

  #connections() {
    try {
      return this.db
        .prepare("SELECT * FROM connections ORDER BY provider, alias")
        .all()
        .map((row) => ({
          id: row.id,
          provider: row.provider,
          alias: row.alias,
          host: row.host,
          status: row.status,
          version: row.version ?? null,
          binaryPath: row.binary_path ?? null,
          homePath: row.home_path ?? null,
          enabled: row.enabled === 1 || row.enabled === true,
          observe: row.observe === 1 || row.observe === true,
          lastProbeAt: row.last_probe_at ?? null,
          lastEventAt: row.last_event_at ?? null,
          error: row.error ?? null,
        }));
    } catch {
      return [];
    }
  }

  #audit() {
    try {
      return (this.services.audit?.list?.({ limit: AUDIT_LIMIT }) ?? []).map(
        (entry) => ({
          sequence: entry.sequence,
          timestamp: entry.timestamp,
          actor: entry.actor,
          action: entry.action,
          target: entry.target,
          workspaceId: entry.workspaceId,
          runId: entry.runId,
          policyDecision: entry.policyDecision,
          hash: entry.hash,
        }),
      );
    } catch {
      return [];
    }
  }

  #events() {
    try {
      return this.db
        .prepare(
          `SELECT id, sequence, workspace_id, run_id, kind, provenance, tool, file, timestamp
             FROM events ORDER BY sequence DESC LIMIT ?`,
        )
        .all(EVENT_LIMIT)
        .map((row) => ({
          id: row.id,
          sequence: row.sequence,
          workspaceId: row.workspace_id,
          runId: row.run_id,
          kind: row.kind,
          provenance: row.provenance,
          tool: row.tool ?? null,
          file: row.file ? basenameOf(row.file) : null,
          timestamp: row.timestamp,
        }));
    } catch {
      return [];
    }
  }

  /** The bundle contents as a plain object (no files written). */
  summary({ includeEvents = true } = {}) {
    const redaction = [
      "Event and audit `details` payloads removed (they can quote prompts or file contents).",
      "Event `message` and `summary` text removed.",
      "Run prompts, transcripts, artifact contents, and config snapshots removed.",
      "Connection `auth_ref`, `authHint`, and `details` removed; no token or credential is ever read.",
      "Absolute paths under the user's home directory masked to <home>.",
      "Settings limited to the public subset; secret-looking keys are refused by Settings itself.",
    ];
    if (includeEvents)
      redaction.push(
        `Event file paths reduced to basenames; at most the last ${EVENT_LIMIT} events are included.`,
      );
    else redaction.push("Events excluded at the operator's request.");

    let health = null;
    try {
      health = this.services.health?.snapshot?.() ?? null;
    } catch (error) {
      health = { error: error?.message ?? String(error) };
    }
    let incident = null;
    try {
      incident = this.services.incidents?.status?.() ?? null;
    } catch {
      incident = null;
    }
    let retention = null;
    try {
      retention = this.services.retention?.policy?.() ?? null;
    } catch {
      retention = null;
    }
    let settings = {};
    try {
      settings = this.services.settings?.publicSubset?.() ?? {};
    } catch {
      settings = {};
    }
    let verification = null;
    try {
      verification = this.services.audit?.verify?.() ?? null;
    } catch {
      verification = null;
    }

    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    return {
      kind: "agent-space-diagnostics",
      bundleVersion: 1,
      generatedAt: this.now(),
      health,
      incident,
      retention,
      schema: {
        version: (() => {
          try {
            return schemaVersion(this.db);
          } catch {
            return null;
          }
        })(),
        migrations: this.#migrations(),
      },
      connections: this.#connections(),
      audit: { verification, recent: this.#audit() },
      events: includeEvents ? this.#events() : [],
      settings,
      packages: readPackageVersions(root),
      runtime: {
        node: process.version,
        platform: platform(),
        arch: arch(),
        osType: type(),
        osRelease: release(),
        pid: process.pid,
      },
      redaction,
    };
  }

  /**
   * bundle({ outPath, includeEvents }) writes a folder containing
   * `summary.json` (everything above) and `REDACTIONS.txt` (the plain-language
   * list of what was removed). No archive library is used; the folder is the
   * deliverable.
   */
  bundle({ outPath, includeEvents = true, actor = "local-user" } = {}) {
    const dir = assertOutsideProviderHomes(
      resolve(
        outPath ?? join(tmpdir(), `agent-space-diagnostics-${this.now()}`),
      ),
      this.env,
    );
    if (existsSync(join(dir, "summary.json")))
      throw new InputError(
        "A diagnostics bundle already exists at that path; choose a new folder",
        409,
      );
    mkdirSync(dir, { recursive: true });
    const summary = redactSecrets(this.summary({ includeEvents }));
    const text = scrubText(JSON.stringify(summary, null, 2), this.home);
    const summaryPath = join(dir, "summary.json");
    writeFileSync(summaryPath, text);
    const redactionPath = join(dir, "REDACTIONS.txt");
    writeFileSync(
      redactionPath,
      [
        "Agent Space diagnostics bundle",
        `Generated ${new Date(this.now()).toISOString()}`,
        "",
        "Removed from this bundle:",
        ...summary.redaction.map((line) => `  - ${line}`),
        "",
        "This bundle contains no prompts, transcripts, file contents, tokens, or",
        "absolute paths under the user's home directory.",
        "",
      ].join("\r\n"),
    );
    try {
      this.services.audit?.record?.({
        actor,
        action: "ops.diagnostics",
        target: dir,
        details: {
          includeEvents,
          bytes: text.length,
          redactions: summary.redaction.length,
        },
      });
    } catch {
      /* audit is best effort */
    }
    return {
      path: dir,
      files: [summaryPath, redactionPath],
      bytes: text.length,
      redaction: summary.redaction,
      summary: JSON.parse(text),
    };
  }
}

/** Factory used by services.js: `createDiagnosticsService(services)`. */
export function createDiagnosticsService(services, options = {}) {
  const diagnostics = new DiagnosticsService(services, options);
  services.diagnostics = diagnostics;
  return diagnostics;
}
