import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyTool, makeEvent } from "../contracts.js";
import {
  fileStat,
  parseJsonLine,
  readNewLines,
  readTailLines,
} from "./jsonl.js";

/**
 * Claude Code observer.
 *
 * Reads only what the vendor writes for its own use, in the documented
 * locations (see docs/ARCHITECTURE.md §3):
 *   <home>/sessions/<pid>.json            live session registry
 *   <home>/projects/<slug>/<id>.jsonl     transcripts (top level only)
 *   <home>/projects/<slug>/<id>/**\/*.jsonl subagent transcripts (not sessions;
 *                                         folded into the parent session)
 *   <home>/history.jsonl                  prompt history (titles)
 * Never reads `<pid>.<hash>.key`, `.credentials.json`, or IDE lock tokens.
 */

const PROVIDER = "claude-code";
const SKIPPED_LINE_TYPES = new Set([
  "attachment",
  "bridge-session",
  "queue-operation",
  "summary",
  "system",
]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read"]);
const SEARCH_TOOLS = new Set(["Glob", "Grep"]);
const WEB_TOOLS = new Set(["WebFetch", "WebSearch"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const DELEGATE_TOOLS = new Set(["Task", "Agent"]);

/* ----------------------------------------------------------------- helpers */

function isWin() {
  return process.platform === "win32";
}

function normalizePath(p) {
  if (!p) return "";
  let out = String(p).replace(/\//g, path.sep).replace(/\\/g, path.sep);
  if (isWin()) out = out.replace(/\//g, "\\");
  return out.replace(/[\\/]+$/, "");
}

function pathKey(p) {
  const n = normalizePath(p);
  return isWin() ? n.toLowerCase() : n;
}

function isWithin(child, parent) {
  const c = pathKey(child);
  const p = pathKey(parent);
  if (!c || !p) return false;
  if (c === p) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** Path shown in summaries: relative to the session cwd when inside it. */
function displayPath(file, cwd) {
  if (!file) return "";
  const text = String(file);
  if (cwd && isWithin(text, cwd)) {
    const rel = normalizePath(text).slice(normalizePath(cwd).length + 1);
    return rel.replace(/\\/g, "/") || path.basename(text);
  }
  return text.replace(/\\/g, "/");
}

function clip(text, max = 120) {
  const line = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (line.length <= max) return line;
  return `${line.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
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

/**
 * Strips Claude Code's wrapper tags from a user prompt and returns the first
 * meaningful line. Blocks that are injected by the client (IDE context,
 * system reminders, local command output) are removed entirely; command
 * wrappers keep their text so `/graphify` becomes "graphify".
 */
export function cleanPromptText(text) {
  if (typeof text !== "string") return "";
  let out = text.replace(/\r\n?/g, "\n");
  out = out.replace(
    /<(ide_[a-z0-9_-]+|system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|antml:[a-z0-9_-]+)\b[^>]*>[\s\S]*?<\/\1>/gi,
    " ",
  );
  out = out.replace(/<\/?[a-zA-Z][a-zA-Z0-9_:-]*(\s[^<>]*)?\/?>/g, "\n");
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length)
    .join("\n");
}

function firstLine(text, max) {
  const cleaned = cleanPromptText(text);
  const line = cleaned.split("\n").find((l) => l.length) ?? "";
  return clip(line, max);
}

/** Claude Code names the project folder from cwd by replacing every non-alphanumeric char. */
export function slugForCwd(cwd) {
  return String(cwd ?? "").replace(/[^a-zA-Z0-9]/g, "-");
}

function compactInput(input, limit = 300) {
  if (!input || typeof input !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") out[key] = clip(value, limit);
    else if (typeof value === "number" || typeof value === "boolean")
      out[key] = value;
    else if (Array.isArray(value)) out[key] = `[${value.length} items]`;
    else if (value && typeof value === "object") out[key] = "{…}";
  }
  return out;
}

function previewContent(content, max = 200) {
  if (typeof content === "string") return clip(content, max);
  if (Array.isArray(content)) {
    const text = content
      .map((block) =>
        typeof block === "string"
          ? block
          : block?.type === "text"
            ? block.text
            : "",
      )
      .filter(Boolean)
      .join(" ");
    return clip(text, max);
  }
  return "";
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Subagent transcripts of one session: <slug>/<sessionId>/**\/*.jsonl */
const SUBAGENT_MAX_DEPTH = 5;
const SUBAGENT_MAX_FILES = 200;

/** Folder that holds a session's subagent transcripts (may not exist). */
export function subagentDirFor(transcriptPath, sessionId) {
  if (!transcriptPath || !sessionId) return null;
  return path.join(path.dirname(transcriptPath), String(sessionId));
}

/**
 * Lists `*.jsonl` files under the session folder (recursively: Claude Code
 * nests workflow subagents in `subagents/workflows/<id>/`), oldest first so
 * events are folded into the parent session in a stable order. Each entry is
 * `{ file, key, mtimeMs, size }` with `key` relative to the session folder
 * using forward slashes (cursor material).
 */
export function listSubagentTranscripts(sessionDir) {
  const out = [];
  if (!sessionDir) return out;
  const walk = (dir, rel, depth) => {
    if (depth > SUBAGENT_MAX_DEPTH || out.length >= SUBAGENT_MAX_FILES) return;
    for (const entry of listDir(dir)) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), childRel, depth + 1);
      } else if (
        entry.isFile() &&
        entry.name.toLowerCase().endsWith(".jsonl")
      ) {
        const file = path.join(dir, entry.name);
        const stat = fileStat(file);
        if (!stat) continue;
        out.push({
          file,
          key: childRel,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        });
        if (out.length >= SUBAGENT_MAX_FILES) return;
      }
    }
  };
  walk(sessionDir, "", 0);
  out.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.key < b.key ? -1 : 1));
  return out;
}

/** Byte offset of the next line boundary at or after `size - backlogBytes`. */
function backlogStart(file, size, backlogBytes) {
  if (!backlogBytes || size <= backlogBytes) return 0;
  let offset = size - backlogBytes;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const chunk = Buffer.alloc(Math.min(64 * 1024, size - offset));
      const read = fs.readSync(fd, chunk, 0, chunk.length, offset);
      const newline = chunk.subarray(0, read).indexOf(10);
      if (newline >= 0) offset += newline + 1;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* keep the byte offset; the tailer tolerates a partial first line */
  }
  return offset;
}

function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error?.code === "EPERM";
  }
}

/* ------------------------------------------------------------ line mapping */

/**
 * Maps one transcript line to normalized events. `state` is per-session
 * memory (tool_use id → tool name, usage already emitted per message id).
 */
export function mapTranscriptLine(
  record,
  { offset, sourcePath, session, state },
) {
  const events = [];
  if (!record || typeof record !== "object") return events;
  const type = record.type;
  if (!type || SKIPPED_LINE_TYPES.has(type)) return events;
  if (type !== "user" && type !== "assistant") return events;

  const baseId = record.uuid ? String(record.uuid) : `${sourcePath}:${offset}`;
  const timestamp = toMillis(record.timestamp) ?? Date.now();
  const cwd = record.cwd ?? session?.cwd ?? null;
  const sessionId = record.sessionId ?? session?.sessionId ?? null;
  const sidechain = record.isSidechain === true;
  const message = record.message ?? {};

  const push = (partial, idSuffix = null) => {
    const data = { ...(partial.data ?? {}) };
    if (sidechain) data.sidechain = true;
    // Subagent transcript lines name the subagent that produced them.
    if (record.agentId) data.subagent = String(record.agentId);
    if (record.gitBranch) data.gitBranch = record.gitBranch;
    events.push(
      makeEvent({
        provenance: "provider",
        ...partial,
        providerEventId: idSuffix ? `${baseId}:${idSuffix}` : baseId,
        sessionId,
        cwd,
        timestamp,
        provider: PROVIDER,
        data,
      }),
    );
  };

  if (type === "user") {
    const content = message.content;
    if (typeof content === "string") {
      if (record.isMeta) return events;
      const text = cleanPromptText(content);
      if (!text) return events;
      push({
        kind: "prompt",
        provenance: "user",
        summary: clip(text.split("\n")[0], 120),
        data: {
          text: clip(text, 1000),
          promptId: record.promptId ?? undefined,
        },
      });
      return events;
    }
    if (Array.isArray(content)) {
      content.forEach((block, index) => {
        if (!block || typeof block !== "object") return;
        if (block.type === "tool_result") {
          const toolUseId = block.tool_use_id ?? null;
          const tool = (toolUseId && state.tools.get(toolUseId)) || null;
          const isError = block.is_error === true;
          const preview = previewContent(block.content);
          const label = tool ?? "tool";
          push(
            {
              kind: isError ? "error" : "tool.end",
              tool,
              summary: isError
                ? clip(`${label} failed${preview ? `: ${preview}` : ""}`, 120)
                : clip(`Finished ${label}`, 120),
              data: {
                toolUseId,
                isError,
                outputPreview: preview || undefined,
                interrupted: record.toolUseResult?.interrupted || undefined,
              },
            },
            content.length > 1 ? `result:${index}` : null,
          );
        } else if (block.type === "text" && typeof block.text === "string") {
          const text = cleanPromptText(block.text);
          if (!text || record.isMeta) return;
          push(
            {
              kind: "prompt",
              provenance: "user",
              summary: clip(text.split("\n")[0], 120),
              data: { text: clip(text, 1000) },
            },
            content.length > 1 ? `text:${index}` : null,
          );
        }
      });
    }
    return events;
  }

  // assistant
  const model = typeof message.model === "string" ? message.model : null;
  const blocks = Array.isArray(message.content) ? message.content : [];
  blocks.forEach((block, index) => {
    if (!block || typeof block !== "object") return;
    if (block.type === "text") {
      const text = String(block.text ?? "").trim();
      if (!text) return;
      push(
        {
          kind: "message",
          model,
          summary: clip(text.split(/\r?\n/).find((l) => l.trim()) ?? text, 120),
          data: { text: clip(text, 1000) },
        },
        `text:${index}`,
      );
      return;
    }
    if (block.type !== "tool_use") return; // thinking, signatures, etc. are never stored
    const name = String(block.name ?? "tool");
    const input =
      block.input && typeof block.input === "object" ? block.input : {};
    if (block.id) state.tools.set(block.id, name);
    const file =
      typeof input.file_path === "string"
        ? input.file_path
        : typeof input.notebook_path === "string"
          ? input.notebook_path
          : typeof input.path === "string"
            ? input.path
            : null;
    const shown = displayPath(file, cwd);
    const data = { toolUseId: block.id ?? null, input: compactInput(input) };
    let secondary = null;
    if (EDIT_TOOLS.has(name)) {
      secondary = {
        kind: "file.edit",
        summary: clip(
          `${name === "Write" ? "Wrote" : "Edited"} ${shown || "file"}`,
        ),
      };
    } else if (READ_TOOLS.has(name)) {
      secondary = {
        kind: "file.read",
        summary: clip(`Read ${shown || "file"}`),
      };
    } else if (SEARCH_TOOLS.has(name)) {
      const pattern = input.pattern ?? input.glob ?? "";
      secondary = {
        kind: "search",
        summary: clip(
          `Searched ${name === "Glob" ? "files" : "code"} for ${pattern}`,
        ),
      };
    } else if (WEB_TOOLS.has(name)) {
      const target = input.url ?? input.query ?? "";
      secondary = {
        kind: "web",
        summary: clip(
          name === "WebFetch" ? `Fetched ${target}` : `Searched web: ${target}`,
        ),
      };
    } else if (SHELL_TOOLS.has(name)) {
      const command = String(input.command ?? "");
      const activity = classifyTool(name, input);
      secondary = {
        kind: activity === "TESTING" ? "test" : "command",
        summary: clip(`Ran: ${command.split(/\r?\n/)[0] || name}`),
      };
    } else if (DELEGATE_TOOLS.has(name)) {
      secondary = {
        kind: "delegation",
        summary: clip(
          `Delegated: ${input.description ?? input.prompt ?? "subagent"}`,
        ),
      };
    }
    const toolSummary = secondary
      ? secondary.summary
      : clip(
          `Used ${name}${input.description ? `: ${input.description}` : ""}`,
        );
    push(
      {
        kind: "tool.start",
        tool: name,
        file,
        model,
        summary: toolSummary,
        data,
      },
      `tool:${index}`,
    );
    if (secondary) {
      push(
        {
          ...secondary,
          tool: name,
          file,
          model,
          data: { toolUseId: block.id ?? null },
        },
        `${secondary.kind}:${index}`,
      );
    }
  });

  const usage = message.usage;
  if (usage && typeof usage === "object") {
    const messageId = message.id ? String(message.id) : baseId;
    if (!state.usageSeen.has(messageId)) {
      state.usageSeen.add(messageId);
      const picked = {};
      for (const key of [
        "input_tokens",
        "output_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
      ]) {
        if (typeof usage[key] === "number") picked[key] = usage[key];
      }
      events.push(
        makeEvent({
          providerEventId: `${messageId}:usage`,
          provider: PROVIDER,
          sessionId,
          cwd,
          timestamp,
          kind: "usage",
          provenance: "provider",
          model,
          usage: picked,
          summary: clip(
            `Usage: ${picked.input_tokens ?? 0} in / ${picked.output_tokens ?? 0} out${
              model ? ` (${model})` : ""
            }`,
          ),
          data: {
            messageId,
            model,
            ...(sidechain ? { sidechain: true } : {}),
          },
        }),
      );
    }
  }
  return events;
}

/* ------------------------------------------------------- transcript summary */

function emptySummary() {
  return {
    sessionId: null,
    firstPrompt: null,
    firstTimestamp: null,
    lastTimestamp: null,
    model: null,
    toolCallCount: 0,
    cwd: null,
    gitBranch: null,
    version: null,
    lineCount: 0,
    complete: true,
  };
}

function summarizeRecord(summary, record) {
  summary.lineCount++;
  const ts = toMillis(record.timestamp);
  if (ts !== null) {
    if (summary.firstTimestamp === null) summary.firstTimestamp = ts;
    summary.lastTimestamp = ts;
  }
  if (!summary.sessionId && record.sessionId)
    summary.sessionId = record.sessionId;
  if (!summary.cwd && record.cwd) summary.cwd = record.cwd;
  if (record.gitBranch) summary.gitBranch = record.gitBranch;
  if (!summary.version && record.version) summary.version = record.version;
  if (record.type === "user" && !record.isSidechain && !summary.firstPrompt) {
    const content = record.message?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.find((b) => b?.type === "text")?.text
          : null;
    const first = text ? firstLine(text, 80) : "";
    if (first) summary.firstPrompt = first;
  }
  if (record.type === "assistant") {
    const model = record.message?.model;
    if (typeof model === "string") summary.model = model;
    const blocks = record.message?.content;
    if (Array.isArray(blocks))
      summary.toolCallCount += blocks.filter(
        (b) => b?.type === "tool_use",
      ).length;
  }
}

/**
 * Advances an incremental summary state `{ offset, summary }` by reading
 * only the bytes appended since `offset` (up to `maxBytes` per call). This
 * is what keeps a 2 s poll from re-parsing whole transcripts.
 */
export function advanceSummary(
  transcriptPath,
  entry,
  { maxBytes = 8_000_000 } = {},
) {
  const stat = fileStat(transcriptPath);
  if (!stat) return entry;
  if (stat.size < entry.offset) {
    // Truncated or rotated: start over.
    entry.offset = 0;
    entry.summary = emptySummary();
  }
  const summary = entry.summary;
  summary.complete = true;
  let offset = entry.offset;
  let read = 0;
  while (true) {
    const chunk = readNewLines(transcriptPath, offset, {
      maxBytes: 512 * 1024,
    });
    for (const { line } of chunk.lines) {
      const record = parseJsonLine(line);
      if (record) summarizeRecord(summary, record);
    }
    read += chunk.offset - offset;
    offset = chunk.offset;
    if (chunk.eof || chunk.lines.length === 0) break;
    if (read >= maxBytes) {
      summary.complete = false;
      break;
    }
  }
  entry.offset = offset;
  if (!summary.complete) {
    for (const { line } of readTailLines(transcriptPath)) {
      const record = parseJsonLine(line);
      const ts = toMillis(record?.timestamp);
      if (ts !== null) summary.lastTimestamp = ts;
      if (typeof record?.message?.model === "string")
        summary.model = record.message.model;
    }
  }
  return entry;
}

/**
 * Cheap transcript summary: first prompt, first/last timestamps, model,
 * tool call count, cwd, branch, version. Reads the file in one pass.
 */
export function summarizeTranscript(
  transcriptPath,
  { maxBytes = 8_000_000 } = {},
) {
  return advanceSummary(
    transcriptPath,
    { offset: 0, summary: emptySummary() },
    { maxBytes },
  ).summary;
}

/* ---------------------------------------------------------------- observer */

export function createObserver({
  home = null,
  env = process.env,
  now = Date.now,
  isPidAlive = defaultIsPidAlive,
} = {}) {
  const resolvedHome = normalizePath(
    home ?? env?.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
  );
  const projectsDir = path.join(resolvedHome, "projects");
  const registryDir = path.join(resolvedHome, "sessions");
  const historyPath = path.join(resolvedHome, "history.jsonl");

  /** transcript path → { mtimeMs, size, offset, summary } (incremental) */
  const summaryCache = new Map();
  /** sessionId → { tools: Map, usageSeen: Set } */
  const sessionState = new Map();
  /** history.jsonl incremental state: titles are merged from appended bytes. */
  const historyCache = { size: -1, mtimeMs: -1, offset: 0, titles: new Map() };
  /**
   * Sessions that had a registry entry at some point in this process. A
   * session that was registered and no longer is has exited (Claude Code
   * removes <pid>.json on exit), which is a provider signal; a session that
   * was never registered (headless `claude -p`, another CLAUDE_CONFIG_DIR)
   * has unknown liveness and is never declared ended from here.
   */
  const everRegistered = new Set();

  function stateFor(sessionId) {
    const key = sessionId ?? "?";
    if (!sessionState.has(key))
      sessionState.set(key, { tools: new Map(), usageSeen: new Set() });
    return sessionState.get(key);
  }

  function readRegistry() {
    const bySession = new Map();
    for (const entry of listDir(registryDir)) {
      if (!entry.isFile() || !/^\d+\.json$/i.test(entry.name)) continue; // never *.key
      const record = safeReadJson(path.join(registryDir, entry.name));
      if (!record || typeof record !== "object" || !record.sessionId) continue;
      const pid = Number(record.pid ?? path.basename(entry.name, ".json"));
      bySession.set(String(record.sessionId), {
        pid: Number.isInteger(pid) ? pid : null,
        sessionId: String(record.sessionId),
        cwd: record.cwd ?? null,
        startedAt: toMillis(record.startedAt),
        version: record.version ?? null,
        entrypoint: record.entrypoint ?? null,
        kind: record.kind ?? null,
        name: record.name ?? null,
        registryPath: path.join(registryDir, entry.name),
      });
      everRegistered.add(String(record.sessionId));
    }
    return bySession;
  }

  /**
   * First prompt per session from history.jsonl. Only bytes appended since
   * the previous call are read; the file is re-scanned from the start when
   * it shrinks (rotation).
   */
  function readHistory() {
    const stat = fileStat(historyPath);
    if (!stat) {
      historyCache.size = -1;
      historyCache.offset = 0;
      historyCache.titles = new Map();
      return historyCache.titles;
    }
    if (
      stat.size === historyCache.size &&
      stat.mtimeMs === historyCache.mtimeMs
    )
      return historyCache.titles;
    if (stat.size < historyCache.offset) {
      historyCache.offset = 0;
      historyCache.titles = new Map();
    }
    const titles = historyCache.titles;
    let offset = historyCache.offset;
    let budget = 4_000_000;
    while (budget > 0) {
      const chunk = readNewLines(historyPath, offset, { maxBytes: 512 * 1024 });
      for (const { line } of chunk.lines) {
        const record = parseJsonLine(line);
        if (!record?.sessionId || typeof record.display !== "string") continue;
        const id = String(record.sessionId);
        const ts = toMillis(record.timestamp) ?? 0;
        const current = titles.get(id);
        if (!current || ts < current.timestamp) {
          const title = firstLine(record.display, 80);
          if (title)
            titles.set(id, { title, timestamp: ts, project: record.project });
        }
      }
      budget -= chunk.offset - offset;
      offset = chunk.offset;
      if (chunk.eof || chunk.lines.length === 0) break;
    }
    historyCache.offset = offset;
    historyCache.size = stat.size;
    historyCache.mtimeMs = stat.mtimeMs;
    return titles;
  }

  function summaryFor(transcriptPath, stat) {
    const cached = summaryCache.get(transcriptPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size)
      return cached.summary;
    const entry = cached ?? { offset: 0, summary: emptySummary() };
    advanceSummary(transcriptPath, entry);
    entry.mtimeMs = stat.mtimeMs;
    entry.size = stat.size;
    summaryCache.set(transcriptPath, entry);
    return entry.summary;
  }

  function pidAlive(pid) {
    if (!pid) return false;
    try {
      return Boolean(isPidAlive(pid));
    } catch {
      return false;
    }
  }

  /**
   * `{ known, live }` for a session: `known` is whether the registry ever
   * listed it, `live` is null when unknown. Sessions produced by
   * scanSessions carry `registered`/`pid`, so the registry is not re-read
   * for every session on every poll.
   */
  function livenessFor(session) {
    if (!session) return { known: false, live: null };
    const id = String(session.sessionId ?? "");
    if (typeof session.registered === "boolean") {
      if (session.registered)
        return { known: true, live: pidAlive(session.pid) };
      return {
        known: everRegistered.has(id),
        live: everRegistered.has(id) ? false : null,
      };
    }
    const entry = readRegistry().get(id) ?? null;
    if (entry) return { known: true, live: pidAlive(entry.pid) };
    return {
      known: everRegistered.has(id),
      live: everRegistered.has(id) ? false : null,
    };
  }

  function findTranscriptForRegistry(entry) {
    if (!entry?.cwd) return null;
    const wanted = pathKey(slugForCwd(entry.cwd));
    for (const dir of listDir(projectsDir)) {
      if (!dir.isDirectory()) continue;
      if (pathKey(dir.name) !== wanted) continue;
      return path.join(projectsDir, dir.name, `${entry.sessionId}.jsonl`);
    }
    return path.join(
      projectsDir,
      slugForCwd(entry.cwd),
      `${entry.sessionId}.jsonl`,
    );
  }

  function liveFor(entry) {
    if (!entry) return false;
    return pidAlive(entry.pid);
  }

  function buildSession({ sessionId, transcriptPath, stat, registry, titles }) {
    const summary = stat ? summaryFor(transcriptPath, stat) : null;
    const entry = registry.get(sessionId) ?? null;
    const history = titles.get(sessionId) ?? null;
    const title =
      summary?.firstPrompt ||
      history?.title ||
      entry?.name ||
      "Claude Code session";
    const cwd = summary?.cwd ?? entry?.cwd ?? null;
    const startedAt =
      entry?.startedAt ??
      summary?.firstTimestamp ??
      (stat ? Math.round(stat.birthtimeMs || stat.mtimeMs) : now());
    // Delegated work is written to subagent transcripts while the main
    // transcript stays quiet, so the newest subagent file counts as activity.
    const subagents = listSubagentTranscripts(
      subagentDirFor(transcriptPath, sessionId),
    );
    const subagentUpdatedAt = subagents.length
      ? Math.round(subagents[subagents.length - 1].mtimeMs)
      : 0;
    const updatedAt = Math.max(
      summary?.lastTimestamp ?? 0,
      stat ? Math.round(stat.mtimeMs) : 0,
      subagentUpdatedAt,
      startedAt,
    );
    return {
      provider: PROVIDER,
      sessionId,
      cwd,
      title,
      sourcePath: transcriptPath,
      startedAt,
      updatedAt,
      live: liveFor(entry),
      // `registered` lets readEvents/isLive reuse this scan's registry read.
      registered: entry !== null,
      model: summary?.model ?? null,
      pid: entry?.pid ?? null,
      entrypoint: entry?.entrypoint ?? null,
      isSubagent: false,
      gitBranch: summary?.gitBranch ?? null,
      version: summary?.version ?? entry?.version ?? null,
      toolCallCount: summary?.toolCallCount ?? 0,
      transcriptExists: Boolean(stat),
      subagentCount: subagents.length,
    };
  }

  function scanSessions() {
    const registry = readRegistry();
    const titles = readHistory();
    const sessions = [];
    const seen = new Set();
    for (const slugDir of listDir(projectsDir)) {
      if (!slugDir.isDirectory()) continue;
      const dir = path.join(projectsDir, slugDir.name);
      for (const entry of listDir(dir)) {
        // Subagent transcripts live in <slug>/<sessionId>/*.jsonl: not sessions.
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".jsonl"))
          continue;
        const transcriptPath = path.join(dir, entry.name);
        const sessionId = entry.name.slice(0, -".jsonl".length);
        const stat = fileStat(transcriptPath);
        if (!stat) continue;
        seen.add(sessionId);
        sessions.push(
          buildSession({ sessionId, transcriptPath, stat, registry, titles }),
        );
      }
    }
    // Live sessions that have not written a transcript yet.
    for (const [sessionId, entry] of registry) {
      if (seen.has(sessionId) || !liveFor(entry)) continue;
      const transcriptPath = findTranscriptForRegistry(entry);
      if (!transcriptPath) continue;
      const stat = fileStat(transcriptPath);
      sessions.push(
        buildSession({ sessionId, transcriptPath, stat, registry, titles }),
      );
    }
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return sessions;
  }

  function isLive(session) {
    return livenessFor(session).live === true;
  }

  /**
   * Events since `offset` (main transcript) plus everything new in the
   * session's subagent transcripts. Subagent files are "not sessions"
   * (see scanSessions) but they are where delegated work is written, so
   * their lines are folded into the parent session, tagged `data.sidechain`
   * / `data.subagent`. Per-file progress is returned as `cursor`
   * (`{ [relative file]: byte offset }`); pass it back on the next call.
   * A subagent file seen for the first time with more than
   * `initialBacklogBytes` behind it starts near its end, like the
   * ObservationService does for the main transcript.
   */
  function readEvents(
    session,
    offset = 0,
    { maxBytes = 1_000_000, cursor = null, initialBacklogBytes = 0 } = {},
  ) {
    const sourcePath = session?.sourcePath;
    if (!sourcePath)
      return { events: [], offset: offset ?? 0, ended: true, eof: true };
    const chunk = readNewLines(sourcePath, offset, { maxBytes });
    // Tool names persist across calls (results arrive after the call that
    // saw the tool_use); usage dedup is per call so re-reading from an
    // earlier offset yields the same stable ids again.
    const state = {
      tools: stateFor(session.sessionId).tools,
      usageSeen: new Set(),
    };
    const events = [];
    const mapLines = (lines, file) => {
      for (const { line, offset: lineOffset } of lines) {
        const record = parseJsonLine(line);
        if (!record) continue;
        try {
          events.push(
            ...mapTranscriptLine(record, {
              offset: lineOffset,
              sourcePath: file,
              session,
              state,
            }),
          );
        } catch {
          /* a malformed record never stops the tail */
        }
      }
    };
    mapLines(chunk.lines, sourcePath);

    const previous =
      cursor && typeof cursor === "object" && !Array.isArray(cursor)
        ? cursor
        : {};
    const nextCursor = {};
    let subagentEof = true;
    for (const transcript of listSubagentTranscripts(
      subagentDirFor(sourcePath, session.sessionId),
    )) {
      const known = previous[transcript.key];
      const start =
        typeof known === "number" && known >= 0
          ? known
          : backlogStart(transcript.file, transcript.size, initialBacklogBytes);
      const part = readNewLines(transcript.file, start, { maxBytes });
      mapLines(part.lines, transcript.file);
      nextCursor[transcript.key] = part.offset;
      if (!part.eof) subagentEof = false;
    }
    const { known, live } = livenessFor(session);
    return {
      events,
      offset: chunk.offset,
      eof: chunk.eof && subagentEof,
      // Provider-reported end: the registry listed this session and its
      // process is gone. Without a registry entry liveness is unknown and
      // the ObservationService's inactivity rule decides.
      ended: chunk.eof && known && live === false,
      live: known ? live : null,
      reset: chunk.reset ?? false,
      cursor: nextCursor,
    };
  }

  return {
    provider: PROVIDER,
    home: resolvedHome,
    scanSessions,
    readEvents,
    isLive,
    summarizeTranscript,
    slugForCwd,
    /** Exposed for tests: incremental read positions. */
    _internal: { summaryCache, historyCache },
  };
}

export default createObserver;
