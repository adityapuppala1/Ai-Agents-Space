/**
 * GitHub Copilot CLI observer.
 *
 * Reads the vendor's own session storage (ARCHITECTURE §3, verified 2026-09-09):
 *   <home>/session-state/<id>/workspace.yaml   flat "key: value" YAML
 *   <home>/session-state/<id>/events.jsonl     same vocabulary as `copilot -p --output-format json`
 *   <home>/session-store.db                    sqlite (read-only, best effort)
 *   <home>/logs/process-<ts>-<pid>.log         one log per CLI process; mentions the session id
 *
 * Every emitted event is provider-reported; activities derived from tool
 * names are inferred downstream by RunRecorder/classifyTool.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeEvent, classifyTool } from "../contracts.js";

export const provider = "copilot";

const LIVE_WINDOW_MS = 90_000;
const SUMMARY_MAX = 120;
const TAIL_BYTES = 64 * 1024;
const LOG_HEAD_BYTES = 256 * 1024;

/** Ephemeral/stream-only event types we never persist. */
const SKIP_TYPES = new Set([
  "assistant.reasoning_delta",
  "assistant.message_delta",
  "assistant.tool_call_delta",
  "assistant.message_start",
  "assistant.reasoning",
  "assistant.idle",
  "session.mcp_servers_loaded",
  "session.mcp_server_status_changed",
  "session.skills_loaded",
  "session.tools_updated",
  "session.model_change",
  "mcp.tools.list_changed",
]);

/** Types that mean "this session has finished producing output for now". */
const END_TYPES = new Set(["result", "assistant.idle"]);

// ---------------------------------------------------------------------------
// Private path helpers (util/paths.js belongs to module A; keep no dependency)
// ---------------------------------------------------------------------------

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

function truncate(text, max = SUMMARY_MAX) {
  const s = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function toMs(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return fallback;
}

function statSafe(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// ---------------------------------------------------------------------------
// Private incremental line reader (module B owns observe/jsonl.js)
// ---------------------------------------------------------------------------

/**
 * Reads complete lines from `file` starting at byte `offset`. A trailing
 * partial line (no newline yet) is left unread so the next call picks it up.
 * Returns { lines: [{ text, start, end }], offset }.
 */
export function readLinesFrom(file, offset = 0) {
  const stat = statSafe(file);
  if (!stat) return { lines: [], offset, missing: true };
  let start = Number.isFinite(offset) && offset > 0 ? offset : 0;
  if (start > stat.size) start = 0; // file truncated/rotated → restart
  const length = stat.size - start;
  if (length <= 0) return { lines: [], offset: start };
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, "r");
  let read = 0;
  try {
    read = fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  const lines = [];
  let cursor = 0;
  while (cursor < read) {
    const nl = buffer.indexOf(0x0a, cursor);
    if (nl === -1) break; // partial trailing line
    let text = buffer.toString("utf8", cursor, nl);
    if (text.endsWith("\r")) text = text.slice(0, -1);
    lines.push({ text, start: start + cursor, end: start + nl + 1 });
    cursor = nl + 1;
  }
  return { lines, offset: start + cursor };
}

/** Parses the flat `key: value` YAML Copilot writes to workspace.yaml. */
export function parseFlatYaml(text) {
  const out = {};
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value === "null" || value === "~") value = null;
    else if (value === "true") value = true;
    else if (value === "false") value = false;
    else if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
    out[key] = value;
  }
  return out;
}

/** Returns the parsed last event of an events.jsonl (or null). */
function lastEventOf(file) {
  const stat = statSafe(file);
  if (!stat || stat.size === 0) return null;
  const start = Math.max(0, stat.size - TAIL_BYTES);
  const buffer = Buffer.alloc(stat.size - start);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    fs.closeSync(fd);
  }
  const lines = buffer.toString("utf8").split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === "object" && parsed.type) return parsed;
    } catch {
      // partial or corrupt tail line → look further back
    }
  }
  return null;
}

/** Maps a Copilot tool name + arguments to the activity-specific event kind. */
export function copilotToolKind(toolName, args = {}) {
  const name = String(toolName ?? "").toLowerCase();
  if (name === "view") return "file.read";
  if (name === "edit" || name === "create") return "file.edit";
  if (name === "grep" || name === "glob") return "search";
  if (name === "web_fetch") return "web";
  if (name === "bash" || name === "powershell") {
    return classifyTool(name, args) === "TESTING" ? "test" : "command";
  }
  return null;
}

function toolFile(args) {
  const p = args?.path ?? args?.file ?? args?.file_path ?? null;
  return p ? normalizePath(String(p)) : null;
}

function toolCommand(args) {
  const c = args?.command ?? args?.cmd ?? null;
  return c ? String(c) : null;
}

// ---------------------------------------------------------------------------
// Observer
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {string} [options.home]          override of ~/.copilot (else env COPILOT_HOME)
 * @param {object} [options.env]           environment (defaults to process.env)
 * @param {() => number} [options.now]     clock (ms) for live-ness
 * @param {(pid:number) => boolean} [options.isPidAlive]
 * @param {number} [options.liveWindowMs]  default 90 000
 */
export function createObserver({
  home,
  env = process.env,
  now = Date.now,
  isPidAlive = defaultIsPidAlive,
  liveWindowMs = LIVE_WINDOW_MS,
} = {}) {
  const homePath = normalizePath(
    expandHome(home || env?.COPILOT_HOME || "~/.copilot", env),
  );
  const stateDir = path.join(homePath, "session-state");
  const storePath = path.join(homePath, "session-store.db");
  const logsDir = path.join(homePath, "logs");

  /** toolCallId → { name, file, command } remembered between reads. */
  const toolCalls = new Map();

  function eventsPath(sessionId) {
    return path.join(stateDir, sessionId, "events.jsonl");
  }

  function readStoreRows() {
    if (!statSafe(storePath)) return [];
    let db = null;
    try {
      // Lazy import so hosts without node:sqlite still load the module.
      const { DatabaseSync } = sqliteModule();
      db = new DatabaseSync(storePath, { readOnly: true });
      return db
        .prepare(
          "SELECT id, cwd, repository, branch, summary, created_at, updated_at FROM sessions",
        )
        .all();
    } catch {
      return [];
    } finally {
      try {
        db?.close();
      } catch {
        // ignore
      }
    }
  }

  function readWorkspaceYaml(dir) {
    try {
      return parseFlatYaml(
        fs.readFileSync(path.join(dir, "workspace.yaml"), "utf8"),
      );
    } catch {
      return null;
    }
  }

  /** Live pids whose process log mentions the session id. */
  function livePidForSession(sessionId) {
    let names = [];
    try {
      names = fs.readdirSync(logsDir);
    } catch {
      return null;
    }
    for (const name of names) {
      const match = /^process-\d+-(\d+)\.log$/i.exec(name);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!isPidAlive(pid)) continue;
      const file = path.join(logsDir, name);
      const stat = statSafe(file);
      if (!stat) continue;
      const length = Math.min(stat.size, LOG_HEAD_BYTES);
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(file, "r");
      try {
        fs.readSync(fd, buffer, 0, length, 0);
      } finally {
        fs.closeSync(fd);
      }
      if (buffer.toString("utf8").includes(sessionId)) return pid;
    }
    return null;
  }

  function isLive(session) {
    const sessionId = session?.sessionId;
    if (!sessionId) return false;
    const file = session.sourcePath || eventsPath(sessionId);
    const stat = statSafe(file);
    if (stat) {
      const recent = now() - stat.mtimeMs <= liveWindowMs;
      if (recent) {
        const last = lastEventOf(file);
        if (!last || !END_TYPES.has(last.type)) return true;
      }
    }
    return livePidForSession(sessionId) !== null;
  }

  function scanSessions() {
    const byId = new Map();

    let dirs = [];
    try {
      dirs = fs
        .readdirSync(stateDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      dirs = [];
    }
    for (const name of dirs) {
      const dir = path.join(stateDir, name);
      const yaml = readWorkspaceYaml(dir) || {};
      const sessionId = String(yaml.id || name);
      const file = path.join(dir, "events.jsonl");
      const stat = statSafe(file);
      const createdAt = toMs(yaml.created_at, stat?.birthtimeMs ?? null);
      const updatedAt = toMs(yaml.updated_at, null);
      byId.set(sessionId, {
        provider,
        sessionId,
        cwd: normalizePath(yaml.cwd) ?? null,
        title: yaml.name ? truncate(yaml.name, 200) : null,
        sourcePath: file,
        startedAt: createdAt ?? null,
        updatedAt: Math.max(updatedAt ?? 0, stat?.mtimeMs ?? 0) || null,
        live: false,
        model: null,
        pid: null,
        entrypoint: yaml.client_name ? String(yaml.client_name) : null,
        isSubagent: false,
        gitBranch: null,
        metadata: {
          source: "session-state",
          gitRoot: normalizePath(yaml.git_root) ?? null,
          repository: yaml.repository ?? null,
          hasEvents: Boolean(stat),
        },
      });
    }

    for (const row of readStoreRows()) {
      const sessionId = String(row.id);
      const existing = byId.get(sessionId);
      if (existing) {
        existing.gitBranch = row.branch ?? existing.gitBranch;
        existing.metadata.repository =
          row.repository ?? existing.metadata.repository;
        existing.metadata.summary = row.summary ?? null;
        if (!existing.title && row.summary)
          existing.title = truncate(row.summary, 200);
        if (!existing.cwd && row.cwd) existing.cwd = normalizePath(row.cwd);
        existing.metadata.source = "session-state+session-store";
        continue;
      }
      const file = eventsPath(sessionId);
      const stat = statSafe(file);
      byId.set(sessionId, {
        provider,
        sessionId,
        cwd: normalizePath(row.cwd) ?? null,
        title: row.summary ? truncate(row.summary, 200) : null,
        sourcePath: file,
        startedAt: toMs(row.created_at, null),
        updatedAt: toMs(row.updated_at, stat?.mtimeMs ?? null),
        live: false,
        model: null,
        pid: null,
        entrypoint: null,
        isSubagent: false,
        gitBranch: row.branch ?? null,
        metadata: {
          source: "session-store",
          repository: row.repository ?? null,
          summary: row.summary ?? null,
          hasEvents: Boolean(stat),
        },
      });
    }

    const sessions = [...byId.values()];
    for (const session of sessions) {
      const pid = livePidForSession(session.sessionId);
      if (pid) session.pid = pid;
      session.live = isLive(session);
    }
    sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return sessions;
  }

  /** Converts one raw Copilot record into zero or more normalized events. */
  function mapRecord(raw, session, fallbackId) {
    const type = raw?.type;
    if (!type || SKIP_TYPES.has(type)) return [];
    const data = raw.data ?? {};
    const base = {
      provider,
      sessionId: session?.sessionId ?? raw.sessionId ?? data.sessionId ?? null,
      cwd: session?.cwd ?? null,
      timestamp: toMs(raw.timestamp, now()),
    };
    const id = raw.id ? String(raw.id) : fallbackId;
    const ev = (partial) =>
      makeEvent({ ...base, providerEventId: id, ...partial });
    const events = [];

    switch (type) {
      case "session.start": {
        const cwd = data.context?.cwd ? normalizePath(data.context.cwd) : null;
        events.push(
          ev({
            kind: "session.start",
            cwd: cwd ?? base.cwd,
            summary: `Copilot session started${data.copilotVersion ? ` (v${data.copilotVersion})` : ""}`,
            data: {
              sessionId: data.sessionId ?? null,
              version: data.copilotVersion ?? null,
              cwd,
              producer: data.producer ?? null,
            },
          }),
        );
        break;
      }
      case "user.message":
        events.push(
          ev({
            kind: "prompt",
            provenance: "user",
            summary: truncate(data.content),
            data: { content: truncate(data.content, 2000) },
          }),
        );
        break;
      case "assistant.message": {
        const content = String(data.content ?? "");
        if (content.trim()) {
          events.push(
            ev({
              kind: "message",
              model: data.model ?? null,
              summary: truncate(content),
              data: {
                content: truncate(content, 2000),
                turnId: data.turnId ?? null,
              },
            }),
          );
        }
        for (const req of Array.isArray(data.toolRequests)
          ? data.toolRequests
          : []) {
          const args = req.arguments ?? {};
          const file = toolFile(args);
          toolCalls.set(req.toolCallId, {
            name: req.name,
            file,
            command: toolCommand(args),
          });
          events.push(
            ev({
              providerEventId: `${id}:tool:${req.toolCallId ?? events.length}`,
              kind: "tool.start",
              tool: req.name ?? null,
              file,
              model: data.model ?? null,
              summary: `Requested tool ${req.name}${file ? ` on ${path.basename(file)}` : ""}`,
              data: {
                toolCallId: req.toolCallId ?? null,
                requested: true,
                ...smallArgs(args),
              },
            }),
          );
        }
        break;
      }
      case "tool.execution_start": {
        const args = data.arguments ?? {};
        const name = data.toolName ?? null;
        const file = toolFile(args);
        const command = toolCommand(args);
        toolCalls.set(data.toolCallId, { name, file, command });
        const label = command
          ? `Running ${name}: ${truncate(command, 80)}`
          : file
            ? `${name} ${path.basename(file)}`
            : `Running tool ${name}`;
        events.push(
          ev({
            kind: "tool.start",
            tool: name,
            file,
            model: data.model ?? null,
            summary: label,
            data: {
              toolCallId: data.toolCallId ?? null,
              turnId: data.turnId ?? null,
              ...smallArgs(args),
            },
          }),
        );
        const kind = copilotToolKind(name, args);
        if (kind) {
          events.push(
            ev({
              providerEventId: `${id}:${kind}`,
              kind,
              tool: name,
              file,
              model: data.model ?? null,
              summary: label,
              data: { toolCallId: data.toolCallId ?? null, ...smallArgs(args) },
            }),
          );
        }
        break;
      }
      case "tool.execution_complete": {
        const known = toolCalls.get(data.toolCallId) ?? {};
        const ok = data.success !== false;
        const output = data.result?.content ?? "";
        events.push(
          ev({
            kind: ok ? "tool.end" : "error",
            tool: known.name ?? null,
            file: known.file ?? null,
            model: data.model ?? null,
            summary: ok
              ? `${known.name ?? "Tool"} finished${known.file ? ` (${path.basename(known.file)})` : ""}`
              : `${known.name ?? "Tool"} failed: ${truncate(output, 80) || "no details"}`,
            data: {
              toolCallId: data.toolCallId ?? null,
              success: ok,
              output: truncate(output, 500),
            },
          }),
        );
        break;
      }
      case "assistant.turn_start":
        events.push(
          ev({
            kind: "turn.start",
            summary: `Turn ${data.turnId ?? ""} started`.trim(),
            data: { turnId: data.turnId ?? null },
          }),
        );
        break;
      case "assistant.turn_end":
        events.push(
          ev({
            kind: "turn.end",
            summary: `Turn ${data.turnId ?? ""} ended`.trim(),
            data: { turnId: data.turnId ?? null },
          }),
        );
        break;
      case "session.usage_checkpoint":
        // Checkpoints carry running totals; merging them would add each
        // checkpoint to the last. Keep them in data and let `result` report.
        events.push(
          ev({
            kind: "usage",
            usage: null,
            summary: `Usage checkpoint: ${data.totalPremiumRequests ?? "?"} premium requests`,
            data: {
              totalNanoAiu: data.totalNanoAiu ?? null,
              totalPremiumRequests: data.totalPremiumRequests ?? null,
              checkpoint: true,
            },
          }),
        );
        break;
      case "result": {
        const usage = raw.usage ?? data.usage ?? null;
        const exitCode = raw.exitCode ?? data.exitCode ?? null;
        if (usage) {
          events.push(
            ev({
              providerEventId: `${id}:usage`,
              kind: "usage",
              usage,
              summary: `Session usage: ${usage.premiumRequests ?? "?"} premium requests`,
              data: { codeChanges: usage.codeChanges ?? null },
            }),
          );
        }
        events.push(
          ev({
            kind: exitCode && exitCode !== 0 ? "error" : "session.end",
            summary:
              exitCode && exitCode !== 0
                ? `Copilot session ended with exit code ${exitCode}`
                : "Copilot session ended",
            data: { exitCode },
          }),
        );
        break;
      }
      case "model.call_start":
        events.push(
          ev({
            kind: "status",
            model: data.model ?? null,
            summary: `Calling model ${data.model ?? "(not reported)"}`,
            data: { turnId: data.turnId ?? null },
          }),
        );
        break;
      case "session.auto_mode_resolved":
        events.push(
          ev({
            kind: "status",
            model: data.chosenModel ?? null,
            summary: `Auto mode chose ${data.chosenModel ?? "(not reported)"}`,
            data: { routingMethod: data.routingMethod ?? null },
          }),
        );
        break;
      default:
        // Unknown or ephemeral type → skip rather than invent semantics.
        break;
    }
    return events;
  }

  function readEvents(session, offset = 0) {
    const file = session?.sourcePath || eventsPath(session?.sessionId ?? "");
    const { lines, offset: nextOffset, missing } = readLinesFrom(file, offset);
    if (missing) return { events: [], offset, ended: false };
    const events = [];
    let ended = false;
    for (const line of lines) {
      if (!line.text.trim()) continue;
      let raw;
      try {
        raw = JSON.parse(line.text);
      } catch {
        continue; // non-JSON noise → skip but keep advancing
      }
      if (raw?.type === "result") ended = true;
      const fallbackId = `${file}:${line.start}`;
      for (const event of mapRecord(raw, session, fallbackId))
        events.push(event);
    }
    if (!ended) ended = lastEventOf(file)?.type === "result";
    return { events, offset: nextOffset, ended };
  }

  return {
    provider,
    home: homePath,
    scanSessions,
    readEvents,
    isLive,
    /** Exposed for tests. */
    _internal: { mapRecord, parseFlatYaml, readLinesFrom },
  };
}

function smallArgs(args) {
  const out = {};
  if (args?.path) out.path = String(args.path);
  if (args?.command) out.command = truncate(args.command, 500);
  if (args?.pattern) out.pattern = truncate(args.pattern, 200);
  if (args?.url) out.url = truncate(args.url, 300);
  return out;
}

let sqliteCache = null;
function sqliteModule() {
  if (!sqliteCache) {
    // eslint-disable-next-line no-undef
    sqliteCache = process.getBuiltinModule("node:sqlite");
  }
  return sqliteCache;
}

export default createObserver;
