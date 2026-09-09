import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { classifyTool, makeEvent } from "../contracts.js";
import { fileStat, parseJsonLine, readNewLines } from "./jsonl.js";

/**
 * Codex CLI / Codex Desktop observer.
 *
 * Reads the vendor's own rollout files (docs/ARCHITECTURE.md §3):
 *   <home>/sessions/YYYY/MM/DD/rollout-<ISO>-<threadId>.jsonl
 *   <home>/archived_sessions/**  (same layout)
 *   <home>/session_index.jsonl   { id, thread_name, updated_at }
 *   <home>/state_5.sqlite        threads table (read-only, best effort)
 * `auth.json` is never opened. Reasoning payloads (encrypted) are never stored.
 */

const PROVIDER = "codex";
const LIVE_WINDOW_MS = 120_000;
const ROLLOUT_RE =
  /^rollout-(.+?)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const EXEC_TOOLS = new Set(["exec_command", "write_stdin", "wait"]);

/* ----------------------------------------------------------------- helpers */

function isWin() {
  return process.platform === "win32";
}

function normalizePath(p) {
  if (!p) return "";
  let out = String(p);
  if (isWin()) out = out.replace(/\//g, "\\");
  return out.replace(/[\\/]+$/, "");
}

function isAbsolute(p) {
  return path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/");
}

function clip(text, max = 120) {
  const line = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (line.length <= max) return line;
  return `${line.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function firstLine(text, max = 120) {
  const line =
    String(text ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length) ?? "";
  return clip(line, max);
}

function toMillis(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function parseArguments(args) {
  if (args && typeof args === "object") return args;
  if (typeof args !== "string") return {};
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // Truncated or sanitized arguments: salvage the string fields we use.
    const out = {};
    const re = /"(cmd|workdir|command|session_id)"\s*:\s*"((?:[^"\\]|\\.)*)"?/g;
    let match;
    while ((match = re.exec(args))) {
      let value = match[2];
      try {
        value = JSON.parse(`"${value}"`);
      } catch {
        value = value.replace(/\\(.)/g, "$1");
      }
      if (out[match[1]] === undefined) out[match[1]] = value;
    }
    return out;
  }
}

/** Extracts `cmd` from the JS-ish `exec` custom tool input. */
function commandFromExecInput(input) {
  if (typeof input !== "string") return "";
  // Tolerates a truncated input (no closing quote) so a cut-off record still
  // yields the command's beginning.
  const match =
    input.match(/\bcmd\s*:\s*(")((?:[^"\\]|\\.)*)(")?/) ??
    input.match(/\bcmd\s*:\s*(')((?:[^'\\]|\\.)*)(')?/) ??
    input.match(/\bcmd\s*:\s*(`)((?:[^`\\]|\\.)*)(`)?/);
  if (match) {
    const quote = match[1];
    const body = match[2];
    if (quote === '"' && match[3]) {
      try {
        return JSON.parse(`"${body}"`);
      } catch {
        /* fall through to manual unescape */
      }
    }
    return body.replace(/\\(.)/g, "$1");
  }
  return input.trim();
}

/** Parses `*** Add File: path` style headers out of an apply_patch input. */
export function filesFromPatch(input) {
  const files = [];
  if (typeof input !== "string") return files;
  const re = /^\*\*\* (Add|Update|Delete) File: (.+?)\s*$/gm;
  let match;
  while ((match = re.exec(input))) {
    const action = match[1].toLowerCase();
    files.push({
      action:
        action === "add" ? "add" : action === "delete" ? "delete" : "update",
      path: match[2].trim(),
    });
  }
  return files;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      typeof block === "string"
        ? block
        : typeof block?.text === "string"
          ? block.text
          : "",
    )
    .filter(Boolean)
    .join("\n");
}

function threadIdFromName(fileName) {
  const match = ROLLOUT_RE.exec(fileName);
  return match ? match[2] : null;
}

function pickUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const out = {};
  for (const [key, value] of Object.entries(usage))
    if (typeof value === "number") out[key] = value;
  return out;
}

/* --------------------------------------------------------- line mapping */

/**
 * Maps one rollout line to normalized events and updates the per-session
 * `state` (open turn tracking, call_id → tool name, model, cwd).
 */
export function mapRolloutLine(record, { offset, sourcePath, session, state }) {
  const events = [];
  if (!record || typeof record !== "object") return events;
  const type = record.type;
  const payload = record.payload;
  if (!type || !payload || typeof payload !== "object") return events;
  const threadId = state.threadId ?? session?.sessionId ?? null;
  const ordinal = Number.isInteger(record.ordinal) ? record.ordinal : null;
  const baseId =
    ordinal !== null && threadId
      ? `${threadId}:${ordinal}`
      : `${sourcePath}:${offset}`;
  const timestamp = toMillis(record.timestamp) ?? Date.now();

  const push = (partial, idSuffix = null) => {
    events.push(
      makeEvent({
        provenance: "provider",
        ...partial,
        providerEventId: idSuffix ? `${baseId}:${idSuffix}` : baseId,
        sessionId: threadId,
        cwd: state.cwd ?? session?.cwd ?? null,
        timestamp,
        provider: PROVIDER,
        data: partial.data ?? {},
      }),
    );
  };

  const resolveFile = (p) => {
    const cwd = state.cwd ?? session?.cwd ?? null;
    if (!p) return null;
    if (isAbsolute(p) || !cwd) return normalizePath(p);
    return normalizePath(path.join(cwd, p));
  };

  const prompt = (text) => {
    const clean = String(text ?? "").trim();
    if (!clean) return;
    if (state.lastPrompt === clean) return; // same prompt echoed by a second record type
    state.lastPrompt = clean;
    if (!state.firstPrompt) state.firstPrompt = firstLine(clean, 80);
    push({
      kind: "prompt",
      provenance: "user",
      summary: firstLine(clean, 120),
      data: { text: clip(clean, 1000) },
    });
  };

  const message = (text, extra = {}) => {
    const clean = String(text ?? "").trim();
    if (!clean) return;
    if (state.lastMessage === clean) return;
    state.lastMessage = clean;
    push({
      kind: "message",
      model: state.model ?? null,
      summary: firstLine(clean, 120),
      data: { text: clip(clean, 1000), ...extra },
    });
  };

  switch (type) {
    case "session_meta": {
      if (payload.id) state.threadId = String(payload.id);
      if (payload.cwd) state.cwd = payload.cwd;
      state.meta = {
        id: payload.id ?? null,
        cwd: payload.cwd ?? null,
        originator: payload.originator ?? null,
        cliVersion: payload.cli_version ?? null,
        source: payload.source ?? null,
        threadSource: payload.thread_source ?? null,
        modelProvider: payload.model_provider ?? null,
        timestamp: toMillis(payload.timestamp),
        parentThreadId: payload.parent_thread_id ?? null,
      };
      return events; // RunRecorder writes the session.start event itself
    }
    case "turn_context": {
      if (payload.cwd) state.cwd = payload.cwd;
      if (typeof payload.model === "string") state.model = payload.model;
      const parts = [];
      if (payload.model) parts.push(`model ${payload.model}`);
      if (payload.approval_policy)
        parts.push(`approval ${payload.approval_policy}`);
      if (payload.sandbox_policy?.type)
        parts.push(`sandbox ${payload.sandbox_policy.type}`);
      push({
        kind: "status",
        model: typeof payload.model === "string" ? payload.model : null,
        summary: clip(`Turn context: ${parts.join(", ") || "updated"}`),
        data: {
          turnId: payload.turn_id ?? null,
          cwd: payload.cwd ?? null,
          approvalPolicy: payload.approval_policy ?? null,
          sandbox: payload.sandbox_policy?.type ?? null,
          model: payload.model ?? null,
        },
      });
      return events;
    }
    case "event_msg": {
      const kind = payload.type;
      switch (kind) {
        case "task_started":
          state.openTurnId = payload.turn_id ?? "unknown";
          state.turnOpen = true;
          push({
            kind: "turn.start",
            summary: "Turn started",
            data: {
              turnId: payload.turn_id ?? null,
              startedAt: toMillis(payload.started_at),
            },
          });
          return events;
        case "task_complete":
          state.turnOpen = false;
          state.openTurnId = null;
          push({
            kind: "turn.end",
            summary: clip(
              firstLine(payload.last_agent_message, 120) || "Turn completed",
            ),
            data: {
              turnId: payload.turn_id ?? null,
              durationMs: payload.duration_ms ?? null,
            },
          });
          return events;
        case "turn_aborted":
          state.turnOpen = false;
          state.openTurnId = null;
          push({
            kind: "turn.end",
            summary: clip(
              `Turn aborted${payload.reason ? `: ${payload.reason}` : ""}`,
            ),
            data: {
              turnId: payload.turn_id ?? null,
              aborted: true,
              reason: payload.reason ?? null,
            },
          });
          return events;
        case "user_message":
          prompt(payload.message);
          return events;
        case "agent_message":
          message(
            payload.message,
            payload.phase ? { phase: payload.phase } : {},
          );
          return events;
        case "item_completed": {
          const item = payload.item;
          if (!item || typeof item !== "object") return events;
          if (item.type === "UserMessage")
            prompt(textFromContent(item.content));
          else if (item.type === "AgentMessage")
            message(textFromContent(item.content ?? item.text));
          return events;
        }
        case "token_count": {
          const info = payload.info ?? {};
          const last = pickUsage(info.last_token_usage);
          const total = pickUsage(info.total_token_usage);
          if (!last && !total) return events;
          const usage = last ?? total;
          push({
            kind: "usage",
            model: state.model ?? null,
            usage,
            summary: clip(
              `Usage: ${usage.input_tokens ?? 0} in / ${usage.output_tokens ?? 0} out${
                total?.total_tokens ? ` (total ${total.total_tokens})` : ""
              }`,
            ),
            data: {
              total: total ?? undefined,
              modelContextWindow: info.model_context_window ?? undefined,
            },
          });
          return events;
        }
        case "thread_settings_applied": {
          const settings = payload.thread_settings ?? {};
          if (typeof settings.model === "string") state.model = settings.model;
          push({
            kind: "status",
            model: typeof settings.model === "string" ? settings.model : null,
            summary: clip(
              settings.model
                ? `Model: ${settings.model}`
                : "Thread settings applied",
            ),
            data: {
              model: settings.model ?? null,
              approvalPolicy: settings.approval_policy ?? null,
              serviceTier: settings.service_tier ?? null,
            },
          });
          return events;
        }
        case "error":
        case "stream_error":
          push({
            kind: "error",
            summary: clip(
              `${kind === "stream_error" ? "Stream error" : "Error"}: ${
                payload.message ?? payload.error?.message ?? "unknown"
              }`,
            ),
            data: {
              message: clip(
                payload.message ?? payload.error?.message ?? "",
                500,
              ),
            },
          });
          return events;
        default:
          // agent_reasoning, exec_command_begin/end, patch_apply_begin/end,
          // item_started, etc. are either duplicates of response_items or
          // content we deliberately do not store.
          return events;
      }
    }
    case "response_item": {
      const kind = payload.type;
      switch (kind) {
        case "function_call": {
          const name = String(payload.name ?? "tool");
          const args = parseArguments(payload.arguments);
          if (payload.call_id) state.calls.set(payload.call_id, name);
          if (EXEC_TOOLS.has(name)) {
            const command = typeof args.cmd === "string" ? args.cmd : "";
            const activity = classifyTool(name, {
              cmd: command,
              workdir: args.workdir,
            });
            const summary =
              name === "exec_command"
                ? `Ran: ${firstLine(command, 100) || "command"}`
                : name === "write_stdin"
                  ? "Sent input to a running command"
                  : "Waited for command output";
            push({
              kind: activity === "TESTING" ? "test" : "command",
              tool: name,
              model: state.model ?? null,
              summary: clip(summary),
              data: {
                callId: payload.call_id ?? null,
                cmd: command ? clip(command, 500) : undefined,
                workdir: args.workdir ?? undefined,
                sessionId: args.session_id ?? undefined,
              },
            });
            return events;
          }
          push({
            kind: "tool.start",
            tool: name,
            model: state.model ?? null,
            summary: clip(`Called ${name}`),
            data: {
              callId: payload.call_id ?? null,
              arguments: clip(JSON.stringify(args), 500),
            },
          });
          return events;
        }
        case "custom_tool_call": {
          const name = String(payload.name ?? "tool");
          if (payload.call_id) state.calls.set(payload.call_id, name);
          if (name === "apply_patch") {
            const files = filesFromPatch(payload.input);
            push(
              {
                kind: "tool.start",
                tool: name,
                model: state.model ?? null,
                file: files[0] ? resolveFile(files[0].path) : null,
                summary: clip(
                  files.length === 1
                    ? `Applied patch to ${files[0].path}`
                    : `Applied patch to ${files.length} files`,
                ),
                data: {
                  callId: payload.call_id ?? null,
                  files: files.map((f) => f.path).slice(0, 50),
                  status: payload.status ?? null,
                },
              },
              "tool",
            );
            files.forEach((entry, index) => {
              const verb =
                entry.action === "add"
                  ? "Added"
                  : entry.action === "delete"
                    ? "Deleted"
                    : "Edited";
              push(
                {
                  kind: "file.edit",
                  tool: name,
                  model: state.model ?? null,
                  file: resolveFile(entry.path),
                  summary: clip(`${verb} ${entry.path}`),
                  data: {
                    callId: payload.call_id ?? null,
                    action: entry.action,
                    path: entry.path,
                  },
                },
                `file:${index}`,
              );
            });
            return events;
          }
          if (name === "exec") {
            const command = commandFromExecInput(payload.input);
            const activity = classifyTool("exec", { cmd: command });
            push({
              kind: activity === "TESTING" ? "test" : "command",
              tool: name,
              model: state.model ?? null,
              summary: clip(`Ran: ${firstLine(command, 100) || "command"}`),
              data: {
                callId: payload.call_id ?? null,
                cmd: clip(command, 500),
              },
            });
            return events;
          }
          push({
            kind: "tool.start",
            tool: name,
            model: state.model ?? null,
            summary: clip(`Called ${name}`),
            data: { callId: payload.call_id ?? null },
          });
          return events;
        }
        case "function_call_output":
        case "custom_tool_call_output": {
          const callId = payload.call_id ?? null;
          const tool = (callId && state.calls.get(callId)) || null;
          const output =
            typeof payload.output === "string"
              ? payload.output
              : textFromContent(payload.output?.content ?? payload.output);
          push({
            kind: "tool.end",
            tool,
            model: state.model ?? null,
            summary: clip(`Finished ${tool ?? "tool"}`),
            data: { callId, outputPreview: clip(output, 200) || undefined },
          });
          return events;
        }
        case "message": {
          // role user/assistant messages duplicate event_msg records; use
          // them only when the event_msg form has not been seen.
          if (payload.role === "user") prompt(textFromContent(payload.content));
          else if (payload.role === "assistant")
            message(textFromContent(payload.content));
          return events;
        }
        default:
          // reasoning (encrypted, never stored), web_search_call, etc.
          return events;
      }
    }
    default:
      // token_usage_record (duplicate of token_count), world_state, compacted.
      if (type === "world_state") {
        const model = payload.state?.collaboration_mode?.model;
        if (typeof model === "string" && !state.model) state.model = model;
      }
      return events;
  }
}

/* --------------------------------------------------------- side sources */

function readSessionIndex(file) {
  const titles = new Map();
  let offset = 0;
  while (true) {
    const chunk = readNewLines(file, offset, { maxBytes: 512 * 1024 });
    for (const { line } of chunk.lines) {
      const record = parseJsonLine(line);
      if (!record?.id) continue;
      const current = titles.get(String(record.id));
      const updatedAt = toMillis(record.updated_at) ?? 0;
      if (!current || updatedAt >= current.updatedAt) {
        titles.set(String(record.id), {
          title:
            typeof record.thread_name === "string"
              ? clip(record.thread_name, 80)
              : null,
          updatedAt,
        });
      }
    }
    offset = chunk.offset;
    if (chunk.eof || chunk.lines.length === 0) break;
  }
  return titles;
}

/** Best-effort read of the `threads` table; any failure yields an empty map. */
export function readStateDb(file) {
  const threads = new Map();
  if (!fileStat(file)) return threads;
  let db = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db
      .prepare(
        "SELECT id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, approval_mode, tokens_used, archived FROM threads",
      )
      .all();
    for (const row of rows) {
      if (!row?.id) continue;
      threads.set(String(row.id), {
        title:
          typeof row.title === "string" && row.title.trim()
            ? clip(row.title, 80)
            : null,
        cwd: row.cwd ?? null,
        rolloutPath: row.rollout_path ?? null,
        source: row.source ?? null,
        modelProvider: row.model_provider ?? null,
        approvalMode: row.approval_mode ?? null,
        tokensUsed:
          typeof row.tokens_used === "number" ? row.tokens_used : null,
        archived: Boolean(row.archived),
        createdAt: toMillis(row.created_at),
        updatedAt: toMillis(row.updated_at),
      });
    }
  } catch {
    /* locked (WAL), missing table, or unsupported schema: fall back to rollouts */
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
  return threads;
}

function walkRollouts(root, { maxDepth = 4 } = {}) {
  const found = [];
  const visit = (dir, depth) => {
    for (const entry of listDir(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) visit(full, depth + 1);
      } else if (entry.isFile() && ROLLOUT_RE.test(entry.name)) {
        found.push(full);
      }
    }
  };
  visit(root, 0);
  return found;
}

/* ---------------------------------------------------------------- observer */

export function createObserver({
  home = null,
  env = process.env,
  now = Date.now,
} = {}) {
  const resolvedHome = normalizePath(
    home ?? env?.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
  );
  const sessionsDir = path.join(resolvedHome, "sessions");
  const archivedDir = path.join(resolvedHome, "archived_sessions");
  const indexPath = path.join(resolvedHome, "session_index.jsonl");
  const stateDbPath = path.join(resolvedHome, "state_5.sqlite");

  /**
   * Per rollout path: incremental scan state so `scanSessions()` only reads
   * bytes appended since the previous scan.
   */
  const scans = new Map();

  function scanStateFor(file) {
    if (!scans.has(file)) {
      scans.set(file, {
        offset: 0,
        state: newSessionState(),
        lastTimestamp: null,
        firstTimestamp: null,
        lineCount: 0,
        usageTotal: null,
      });
    }
    return scans.get(file);
  }

  function newSessionState() {
    return {
      threadId: null,
      cwd: null,
      model: null,
      meta: null,
      calls: new Map(),
      turnOpen: false,
      openTurnId: null,
      lastPrompt: null,
      lastMessage: null,
      firstPrompt: null,
    };
  }

  /** Advances the scan state of one rollout file to its current end. */
  function advanceScan(file, stat) {
    const scan = scanStateFor(file);
    if (stat.size < scan.offset) {
      scans.set(file, undefined);
      scans.delete(file);
      return advanceScan(file, stat);
    }
    let guard = 0;
    while (scan.offset < stat.size && guard++ < 200) {
      const chunk = readNewLines(file, scan.offset, { maxBytes: 1_000_000 });
      for (const { line, offset } of chunk.lines) {
        const record = parseJsonLine(line);
        if (!record) continue;
        scan.lineCount++;
        const ts = toMillis(record.timestamp);
        if (ts !== null) {
          if (scan.firstTimestamp === null) scan.firstTimestamp = ts;
          scan.lastTimestamp = ts;
        }
        if (
          record.type === "event_msg" &&
          record.payload?.type === "token_count"
        ) {
          const total = pickUsage(record.payload.info?.total_token_usage);
          if (total) scan.usageTotal = total;
        }
        try {
          mapRolloutLine(record, {
            offset,
            sourcePath: file,
            session: null,
            state: scan.state,
          });
        } catch {
          /* ignore malformed records */
        }
      }
      if (chunk.offset === scan.offset) break;
      scan.offset = chunk.offset;
      if (chunk.eof) break;
    }
    return scan;
  }

  function computeLive(stat, scan) {
    if (!stat) return false;
    const fresh = now() - stat.mtimeMs <= LIVE_WINDOW_MS;
    return fresh && scan.state.turnOpen === true;
  }

  function buildSession(file, { titles, threads, archived }) {
    const stat = fileStat(file);
    if (!stat) return null;
    const scan = advanceScan(file, stat);
    const state = scan.state;
    const meta = state.meta ?? {};
    const threadId = state.threadId ?? threadIdFromName(path.basename(file));
    if (!threadId) return null;
    const index = titles.get(threadId) ?? null;
    const dbRow = threads.get(threadId) ?? null;
    const source = meta.source ?? dbRow?.source ?? null;
    const isSubagent =
      meta.threadSource === "guardian_review" ||
      (source && typeof source === "object" && "subagent" in source) ||
      (typeof source === "string" && /subagent/i.test(source));
    const title =
      index?.title ||
      dbRow?.title ||
      state.firstPrompt ||
      (meta.threadSource === "guardian_review"
        ? "Codex guardian review"
        : "Codex session");
    const startedAt =
      meta.timestamp ??
      scan.firstTimestamp ??
      dbRow?.createdAt ??
      Math.round(stat.birthtimeMs || stat.mtimeMs);
    const updatedAt = Math.max(
      scan.lastTimestamp ?? 0,
      Math.round(stat.mtimeMs),
      startedAt,
    );
    return {
      provider: PROVIDER,
      sessionId: threadId,
      cwd: state.cwd ?? dbRow?.cwd ?? null,
      title,
      sourcePath: file,
      startedAt,
      updatedAt,
      live: computeLive(stat, scan),
      model: state.model ?? null,
      pid: null,
      entrypoint: meta.originator ?? null,
      isSubagent,
      gitBranch: null,
      threadSource: meta.threadSource ?? null,
      parentThreadId: meta.parentThreadId ?? null,
      source,
      cliVersion: meta.cliVersion ?? null,
      archived: archived || Boolean(dbRow?.archived),
      turnOpen: state.turnOpen === true,
      openTurnId: state.openTurnId ?? null,
      usageTotal: scan.usageTotal ?? null,
      tokensUsed: dbRow?.tokensUsed ?? scan.usageTotal?.total_tokens ?? null,
      approvalPolicy: dbRow?.approvalMode ?? null,
    };
  }

  function scanSessions() {
    const titles = readSessionIndex(indexPath);
    const threads = readStateDb(stateDbPath);
    const sessions = [];
    const seen = new Set();
    const collect = (root, archived) => {
      for (const file of walkRollouts(root)) {
        const session = buildSession(file, { titles, threads, archived });
        if (!session || seen.has(session.sessionId)) continue;
        seen.add(session.sessionId);
        sessions.push(session);
      }
    };
    collect(sessionsDir, false);
    collect(archivedDir, true);
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return sessions;
  }

  function isLive(session) {
    if (!session?.sourcePath) return false;
    const stat = fileStat(session.sourcePath);
    if (!stat) return false;
    const scan = advanceScan(session.sourcePath, stat);
    return computeLive(stat, scan);
  }

  /** Per session read state (tool name lookups) keyed by sessionId. */
  const readStates = new Map();
  function readStateFor(session) {
    const key = session?.sessionId ?? session?.sourcePath ?? "?";
    if (!readStates.has(key)) {
      const state = newSessionState();
      state.threadId = session?.sessionId ?? null;
      state.cwd = session?.cwd ?? null;
      state.model = session?.model ?? null;
      readStates.set(key, state);
    }
    return readStates.get(key);
  }

  function readEvents(session, offset = 0, { maxBytes = 1_000_000 } = {}) {
    const sourcePath = session?.sourcePath;
    if (!sourcePath)
      return { events: [], offset: offset ?? 0, ended: true, eof: true };
    const chunk = readNewLines(sourcePath, offset, { maxBytes });
    const persistent = readStateFor(session);
    // Prompt/message echo suppression is per call so re-reading from an
    // earlier offset produces the same events (and the same stable ids).
    const state = { ...persistent, lastPrompt: null, lastMessage: null };
    const events = [];
    for (const { line, offset: lineOffset } of chunk.lines) {
      const record = parseJsonLine(line);
      if (!record) continue;
      try {
        events.push(
          ...mapRolloutLine(record, {
            offset: lineOffset,
            sourcePath,
            session,
            state,
          }),
        );
      } catch {
        /* malformed record: keep tailing */
      }
    }
    // Carry forward what future calls need.
    persistent.threadId = state.threadId ?? persistent.threadId;
    persistent.cwd = state.cwd ?? persistent.cwd;
    persistent.model = state.model ?? persistent.model;
    persistent.meta = state.meta ?? persistent.meta;
    persistent.turnOpen = state.turnOpen;
    persistent.openTurnId = state.openTurnId;
    const live = isLive(session);
    return {
      events,
      offset: chunk.offset,
      eof: chunk.eof,
      // Codex never writes a "session ended" record: a rollout is simply
      // idle between turns while the person types. The end of a session is
      // inferred by the ObservationService (no live turn + no activity for
      // endAfterMs), never reported here.
      ended: false,
      live,
      reset: chunk.reset ?? false,
    };
  }

  return {
    provider: PROVIDER,
    home: resolvedHome,
    scanSessions,
    readEvents,
    isLive,
  };
}

export default createObserver;
