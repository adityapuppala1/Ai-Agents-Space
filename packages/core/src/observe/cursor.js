/**
 * Cursor observer (experimental).
 *
 * Cursor's IDE storage is not documented as a session event source, so this
 * observer only (1) detects the installation and (2) reads, best effort and
 * read-only, `<home>/ai-tracking/ai-code-tracking.db` `conversation_summaries`
 * to list past conversations. It never emits activity events and never
 * writes. Managed runs require the separate `cursor-agent` CLI.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const provider = "cursor";

export const capabilityNote =
  "Cursor observation is experimental: Agent Space only lists conversation summaries " +
  "from ~/.cursor/ai-tracking (read-only) and cannot see live activity. Install the " +
  "`cursor-agent` CLI (https://docs.cursor.com/en/cli) to launch managed runs; " +
  "headless output (`cursor-agent -p --output-format stream-json`) is unverified here.";

export const capabilities = {
  observe: "experimental",
  launch: "unknown",
  stream: "unknown",
  attach: "unsupported",
  interrupt: "unknown",
  resume: "unknown",
  fork: "unsupported",
  approve: "unsupported",
  reportModel: "experimental",
  reportUsage: "unsupported",
  artifacts: "unknown",
  delegate: "unsupported",
};

function expandHome(p, env) {
  if (!p) return p;
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    const home = env?.HOME || env?.USERPROFILE || os.homedir();
    return path.join(home, p.slice(1));
  }
  return p;
}

function normalizePath(p) {
  if (!p) return null;
  let out = String(p).replace(/\//g, path.sep).replace(/\\/g, path.sep);
  if (out.length > 1) out = out.replace(/[\\/]+$/, "");
  return out;
}

function exists(p) {
  try {
    return Boolean(p) && fs.existsSync(p);
  } catch {
    return false;
  }
}

function truncate(text, max = 200) {
  const s = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * @param {object} options
 * @param {string} [options.home]     override of ~/.cursor (else env CURSOR_HOME)
 * @param {string} [options.appData]  %APPDATA% (Cursor IDE user storage lives under <appData>/Cursor)
 * @param {object} [options.env]
 */
export function createObserver({ home, appData, env = process.env } = {}) {
  const homePath = normalizePath(
    expandHome(home || env?.CURSOR_HOME || "~/.cursor", env),
  );
  const appDataPath = normalizePath(appData ?? env?.APPDATA ?? null);
  const trackingDb = path.join(homePath, "ai-tracking", "ai-code-tracking.db");
  const ideStorage = appDataPath
    ? path.join(appDataPath, "Cursor", "User", "globalStorage", "state.vscdb")
    : null;

  function status() {
    const homeExists = exists(homePath);
    const ideExists = exists(ideStorage);
    return {
      provider,
      installed: homeExists || ideExists,
      experimental: true,
      home: homePath,
      homeExists,
      ideStorage: ideExists ? ideStorage : null,
      trackingDb: exists(trackingDb) ? trackingDb : null,
      cliRequired: "cursor-agent",
      note: capabilityNote,
      capabilities,
    };
  }

  function readSummaries() {
    if (!exists(trackingDb)) return [];
    let db = null;
    try {
      const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
      db = new DatabaseSync(trackingDb, { readOnly: true });
      return db
        .prepare(
          "SELECT conversationId, title, tldr, model, mode, updatedAt FROM conversation_summaries ORDER BY updatedAt DESC LIMIT 500",
        )
        .all();
    } catch {
      return []; // locked, missing table, or schema drift → best effort
    } finally {
      try {
        db?.close();
      } catch {
        // ignore
      }
    }
  }

  function scanSessions() {
    const sessions = readSummaries().map((row) => ({
      provider,
      sessionId: String(row.conversationId),
      cwd: null,
      title: truncate(row.title || row.tldr || "Cursor conversation"),
      sourcePath: trackingDb,
      startedAt: null,
      updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : null,
      live: false,
      model: row.model ?? null,
      pid: null,
      entrypoint: "cursor-ide",
      isSubagent: false,
      gitBranch: null,
      metadata: {
        experimental: true,
        source: "ai-code-tracking.db/conversation_summaries",
        mode: row.mode ?? null,
        tldr: row.tldr ? truncate(row.tldr, 500) : null,
        note: "Summary only; Cursor does not expose a documented live event source.",
      },
    }));
    sessions.metadata = status();
    return sessions;
  }

  function readEvents(session, offset = 0) {
    // No documented per-conversation event log exists; report nothing rather
    // than scrape undocumented IDE storage.
    return { events: [], offset, ended: true };
  }

  function isLive() {
    return false;
  }

  return { provider, home: homePath, status, scanSessions, readEvents, isLive };
}

export default createObserver;
