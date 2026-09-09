/**
 * Gemini CLI observer (gemini 0.59.0 on this machine).
 *
 * Storage layout (verified by inspection on 2026-09-09):
 *   <home>/projects.json          lower-cased absolute cwd → short project alias
 *   <home>/history/<alias>/       per-project data written by the CLI
 *   <home>/tmp/<alias>/           per-project scratch data (chats/, logs.json)
 *   <home>/settings.json          exists only once an auth method is chosen
 *   <home>/antigravity/           the Antigravity IDE, a different product
 *
 * The *layout* is real; the *file formats* are not verified, because the CLI
 * on this machine is not authenticated (every run exits 41), so no session has
 * ever been produced here. Every `*.json` under those folders is therefore
 * parsed defensively — array of messages, `{messages|history|turns}`, or a
 * flat log array — and anything unreadable is skipped rather than guessed at.
 * Every session and every event carries `unverified: true`.
 *
 * Antigravity data is detected and reported as unsupported, never parsed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeEvent, classifyTool } from "../contracts.js";

export const provider = "gemini";

export const capabilityNote =
  "Gemini CLI observation is unverified: ~/.gemini/projects.json, ~/.gemini/history/<alias>/ " +
  "and ~/.gemini/tmp/<alias>/ are the real storage locations, but no authenticated Gemini " +
  "session has been observed on this machine, so the file formats are parsed defensively and " +
  "live-ness is inferred from file modification time. Launch flags are the only Gemini facts " +
  "verified here (from the CLI's own --help). Antigravity IDE data in ~/.gemini/antigravity " +
  "is detected only.";

const allUnknown = () => ({
  observe: "unknown",
  launch: "unknown",
  stream: "unknown",
  attach: "unsupported",
  interrupt: "unknown",
  resume: "unknown",
  fork: "unsupported",
  approve: "unsupported",
  reportModel: "unknown",
  reportUsage: "unknown",
  artifacts: "unknown",
  delegate: "unsupported",
});

/**
 * Everything is `unknown` except the two facts we can defend: the launch
 * flags come from the CLI's own help, and the storage layout is real enough
 * to list sessions from (experimental — the formats are not verified).
 */
export const capabilities = {
  ...allUnknown(),
  launch: "experimental",
  observe: "experimental",
};

/** Environment variables that count as "an auth method is configured". */
export const AUTH_ENV = [
  "GEMINI_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_GENAI_USE_GCA",
];

/** The CLI's own wording when no auth method is set (exit code 41). */
export const AUTH_FIX =
  "Please set an Auth method in your ~/.gemini/settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA";

const LIVE_WINDOW_MS = 120_000;
const SUMMARY_MAX = 120;

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
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value; // seconds → ms
  }
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

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function listFiles(dir, ext) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(ext))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Reads `<home>/projects.json` and returns `alias → absolute cwd`. The file
 * maps a lower-cased absolute path to a short alias; both `{path: "alias"}`
 * and `{path: {alias|hash|id}}` shapes are accepted, and anything else is
 * ignored rather than guessed at.
 */
export function readProjectAliases(file) {
  const json = readJson(file);
  const byAlias = new Map();
  if (!json || typeof json !== "object" || Array.isArray(json)) return byAlias;
  const source =
    json.projects && typeof json.projects === "object" ? json.projects : json;
  for (const [cwd, value] of Object.entries(source)) {
    let alias = null;
    if (typeof value === "string") alias = value;
    else if (value && typeof value === "object")
      alias = value.alias ?? value.hash ?? value.id ?? null;
    if (!alias || typeof alias !== "string") continue;
    if (!byAlias.has(alias)) byAlias.set(alias, normalizePath(cwd));
  }
  return byAlias;
}

/** Extracts the message array from whatever shape the chat file has. */
export function extractMessages(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object") {
    if (Array.isArray(json.messages)) return json.messages;
    if (Array.isArray(json.history)) return json.history;
    if (Array.isArray(json.turns)) return json.turns;
  }
  return [];
}

/** True when an array looks like a flat prompt log rather than a chat. */
function looksLikeLog(json) {
  return (
    Array.isArray(json) &&
    json.length > 0 &&
    json.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        entry.sessionId !== undefined &&
        entry.message !== undefined,
    )
  );
}

function roleOf(message) {
  const role = String(message?.role ?? message?.type ?? "").toLowerCase();
  if (role === "user" || role === "human") return "user";
  if (role === "model" || role === "gemini" || role === "assistant")
    return "model";
  if (role === "tool" || role === "function") return "tool";
  return role || "unknown";
}

/** Normalizes message content into Gemini-style parts. */
function partsOf(message) {
  const parts = [];
  const push = (value) => {
    if (value == null) return;
    if (typeof value === "string") parts.push({ text: value });
    else if (Array.isArray(value)) value.forEach(push);
    else if (typeof value === "object") parts.push(value);
  };
  push(message?.parts);
  if (!parts.length) push(message?.content);
  if (!parts.length && typeof message?.text === "string") push(message.text);
  if (!parts.length && typeof message?.message === "string")
    push(message.message);
  for (const call of Array.isArray(message?.toolCalls)
    ? message.toolCalls
    : []) {
    parts.push({
      functionCall: {
        name: call.name,
        args: call.args ?? call.arguments ?? {},
      },
      _id: call.id ?? null,
    });
    if (call.result !== undefined || call.status) {
      parts.push({
        functionResponse: {
          name: call.name,
          response: {
            status: call.status ?? null,
            result: call.result ?? null,
          },
        },
        _id: call.id ?? null,
      });
    }
  }
  return parts;
}

function geminiToolFile(args) {
  const p =
    args?.file_path ?? args?.absolute_path ?? args?.path ?? args?.file ?? null;
  return p ? normalizePath(String(p)) : null;
}

function geminiToolActivity(name, args) {
  const n = String(name ?? "").toLowerCase();
  if (
    /^(read_file|read_many_files|list_directory|glob|search_file_content|grep)$/.test(
      n,
    )
  )
    return "RESEARCHING";
  if (/^(write_file|replace|edit|create_file)$/.test(n)) return "CODING";
  if (/^(google_web_search|web_fetch)$/.test(n)) return "RESEARCHING";
  if (/^(run_shell_command|shell|bash)$/.test(n))
    return classifyTool("bash", args);
  return classifyTool(n, args);
}

function geminiToolKind(name, args) {
  const n = String(name ?? "").toLowerCase();
  if (/^(read_file|read_many_files)$/.test(n)) return "file.read";
  if (/^(write_file|replace|edit|create_file)$/.test(n)) return "file.edit";
  if (/^(glob|search_file_content|grep|list_directory)$/.test(n))
    return "search";
  if (/^(google_web_search|web_fetch)$/.test(n)) return "web";
  if (/^(run_shell_command|shell|bash)$/.test(n))
    return classifyTool("bash", args) === "TESTING" ? "test" : "command";
  return null;
}

/**
 * @param {object} options
 * @param {string} [options.home]  override of ~/.gemini (else env GEMINI_HOME)
 * @param {object} [options.env]
 * @param {() => number} [options.now]
 * @param {number} [options.liveWindowMs]
 */
export function createObserver({
  home,
  env = process.env,
  now = Date.now,
  liveWindowMs = LIVE_WINDOW_MS,
} = {}) {
  const homePath = normalizePath(
    expandHome(home || env?.GEMINI_HOME || "~/.gemini", env),
  );
  const tmpDir = path.join(homePath, "tmp");
  const historyDir = path.join(homePath, "history");
  const projectsFile = path.join(homePath, "projects.json");
  const settingsFile = path.join(homePath, "settings.json");
  const antigravityDir = path.join(homePath, "antigravity");

  /** Existence only; the settings file is never read. */
  function auth() {
    const fromEnv = AUTH_ENV.filter(
      (name) => typeof env?.[name] === "string" && env[name].trim() !== "",
    );
    const hasSettings = Boolean(statSafe(settingsFile));
    return {
      loggedIn: hasSettings || fromEnv.length > 0,
      settingsFile: hasSettings ? settingsFile : null,
      envVars: fromEnv,
      category: hasSettings || fromEnv.length ? null : "not-logged-in",
      fix: hasSettings || fromEnv.length ? null : AUTH_FIX,
      note: "Only the existence of ~/.gemini/settings.json and the presence of the documented environment variables is checked; nothing is read.",
    };
  }

  function status() {
    const homeExists = Boolean(statSafe(homePath));
    const antigravity = Boolean(statSafe(antigravityDir));
    const hasTmp = Boolean(statSafe(tmpDir));
    const hasHistory = Boolean(statSafe(historyDir));
    const hasProjects = Boolean(statSafe(projectsFile));
    return {
      provider,
      home: homePath,
      homeExists,
      // A Gemini CLI home has projects.json plus history/ or tmp/;
      // antigravity alone is not the CLI.
      installed: hasProjects || hasTmp || hasHistory,
      unverified: true,
      projectsFile: hasProjects ? projectsFile : null,
      historyDir: hasHistory ? historyDir : null,
      tmpDir: hasTmp ? tmpDir : null,
      auth: auth(),
      capabilities,
      note: capabilityNote,
      antigravity: {
        detected: antigravity,
        path: antigravity ? antigravityDir : null,
        supported: false,
        note: antigravity
          ? "Antigravity IDE data detected in ~/.gemini/antigravity; it is a separate product and is not observed."
          : null,
      },
    };
  }

  function sessionFromChat(alias, cwd, file) {
    const json = readJson(file);
    if (json == null) return null;
    const messages = extractMessages(json);
    const stat = statSafe(file);
    const base = path.basename(file, path.extname(file));
    const sessionId = String(json.sessionId ?? json.id ?? base);
    const firstUser = messages.find((m) => roleOf(m) === "user");
    const firstText = firstUser
      ? partsOf(firstUser)
          .map((p) => p.text)
          .filter(Boolean)
          .join(" ")
      : "";
    const startedAt =
      toMs(json.startTime ?? json.createdAt, null) ??
      toMs(messages[0]?.timestamp, null) ??
      stat?.birthtimeMs ??
      null;
    const updatedAt =
      toMs(json.lastUpdated ?? json.updatedAt, null) ?? stat?.mtimeMs ?? null;
    const lastModel =
      [...messages].reverse().find((m) => m?.model)?.model ?? null;
    return {
      provider,
      sessionId,
      cwd: json.cwd ? normalizePath(json.cwd) : (cwd ?? null),
      title: firstText ? truncate(firstText, 200) : `Gemini session ${base}`,
      sourcePath: file,
      startedAt,
      updatedAt,
      live: false,
      model: lastModel,
      pid: null,
      entrypoint: "gemini-cli",
      isSubagent: false,
      gitBranch: null,
      metadata: {
        unverified: true,
        experimental: true,
        source: "chats",
        projectAlias: alias,
        projectHash: alias,
        messageCount: messages.length,
      },
    };
  }

  function sessionsFromLogs(alias, cwd, file, seen, json) {
    if (!Array.isArray(json)) return [];
    const stat = statSafe(file);
    const grouped = new Map();
    json.forEach((entry, index) => {
      const id = entry?.sessionId ? String(entry.sessionId) : null;
      if (!id || seen.has(id)) return;
      let group = grouped.get(id);
      if (!group) {
        group = { first: index, entries: [] };
        grouped.set(id, group);
      }
      group.entries.push(entry);
    });
    const out = [];
    for (const [sessionId, group] of grouped) {
      const first = group.entries[0];
      const last = group.entries[group.entries.length - 1];
      out.push({
        provider,
        sessionId,
        cwd: cwd ?? null,
        title: first?.message
          ? truncate(first.message, 200)
          : `Gemini session ${sessionId}`,
        sourcePath: file,
        startedAt: toMs(first?.timestamp, null),
        updatedAt: toMs(last?.timestamp, null) ?? stat?.mtimeMs ?? null,
        live: false,
        model: null,
        pid: null,
        entrypoint: "gemini-cli",
        isSubagent: false,
        gitBranch: null,
        metadata: {
          unverified: true,
          experimental: true,
          source: path.basename(file).toLowerCase(),
          projectAlias: alias,
          projectHash: alias,
          messageCount: group.entries.length,
        },
      });
    }
    return out;
  }

  /** `<root>/<alias>` folders plus their `chats/` subfolder, if present. */
  function projectFolders() {
    const aliases = readProjectAliases(projectsFile);
    const folders = [];
    for (const root of [historyDir, tmpDir]) {
      for (const alias of listDirs(root)) {
        const dir = path.join(root, alias);
        const cwd = aliases.get(alias) ?? null;
        folders.push({ alias, cwd, dir });
        const chats = path.join(dir, "chats");
        if (statSafe(chats)) folders.push({ alias, cwd, dir: chats });
      }
    }
    return folders;
  }

  function scanSessions() {
    const sessions = [];
    const seen = new Set();
    // Chats first so a richer chat file wins over a bare prompt log.
    const files = [];
    for (const folder of projectFolders())
      for (const name of listFiles(folder.dir, ".json"))
        files.push({ ...folder, file: path.join(folder.dir, name) });
    const logs = [];
    for (const entry of files) {
      const json = readJson(entry.file);
      if (json == null) continue; // unreadable or not JSON → skip, never guess
      if (
        path.basename(entry.file).toLowerCase() === "logs.json" ||
        looksLikeLog(json)
      ) {
        logs.push({ ...entry, json });
        continue;
      }
      const session = sessionFromChat(entry.alias, entry.cwd, entry.file);
      if (session && !seen.has(session.sessionId)) {
        seen.add(session.sessionId);
        sessions.push(session);
      }
    }
    for (const entry of logs) {
      for (const session of sessionsFromLogs(
        entry.alias,
        entry.cwd,
        entry.file,
        seen,
        entry.json,
      )) {
        seen.add(session.sessionId);
        sessions.push(session);
      }
    }
    for (const session of sessions) session.live = isLive(session);
    sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    sessions.metadata = status();
    return sessions;
  }

  /** Live-ness is inferred from mtime only; Gemini exposes no registry we know of. */
  function isLive(session) {
    const stat = session?.sourcePath ? statSafe(session.sourcePath) : null;
    if (!stat) return false;
    return now() - stat.mtimeMs <= liveWindowMs;
  }

  function mapMessage(message, index, session) {
    const role = roleOf(message);
    const timestamp = toMs(message?.timestamp, now());
    const msgId = message?.id
      ? String(message.id)
      : `${session.sessionId}:${index}`;
    const model = message?.model ?? null;
    const events = [];
    const ev = (suffix, partial) =>
      makeEvent({
        provider,
        sessionId: session.sessionId,
        cwd: session.cwd ?? null,
        timestamp,
        providerEventId: `${msgId}:${suffix}`,
        model,
        ...partial,
        data: { unverified: true, ...(partial.data ?? {}) },
      });

    partsOf(message).forEach((part, partIndex) => {
      if (typeof part?.text === "string" && part.text.trim()) {
        if (role === "user") {
          events.push(
            ev(`p${partIndex}`, {
              kind: "prompt",
              provenance: "user",
              summary: truncate(part.text),
              data: { content: truncate(part.text, 2000) },
            }),
          );
        } else if (role === "model") {
          events.push(
            ev(`p${partIndex}`, {
              kind: "message",
              summary: truncate(part.text),
              data: { content: truncate(part.text, 2000) },
            }),
          );
        }
        return;
      }
      if (part?.functionCall) {
        const name = part.functionCall.name ?? null;
        const args = part.functionCall.args ?? {};
        const file = geminiToolFile(args);
        const command = args?.command ? truncate(args.command, 200) : null;
        const summary = command
          ? `Running ${name}: ${command}`
          : file
            ? `${name} ${path.basename(file)}`
            : `Calling tool ${name ?? "(unknown)"}`;
        events.push(
          ev(`p${partIndex}`, {
            kind: "tool.start",
            tool: name,
            file,
            activity: geminiToolActivity(name, args),
            summary,
            data: { toolCallId: part._id ?? null, path: file, command },
          }),
        );
        const kind = geminiToolKind(name, args);
        if (kind) {
          events.push(
            ev(`p${partIndex}:${kind}`, {
              kind,
              tool: name,
              file,
              activity: geminiToolActivity(name, args),
              summary,
              data: { toolCallId: part._id ?? null, path: file, command },
            }),
          );
        }
        return;
      }
      if (part?.functionResponse) {
        const name = part.functionResponse.name ?? null;
        const response = part.functionResponse.response ?? {};
        const failed =
          response?.status === "error" ||
          response?.error != null ||
          (typeof response?.status === "string" &&
            /fail|error/i.test(response.status));
        events.push(
          ev(`p${partIndex}`, {
            kind: failed ? "error" : "tool.end",
            tool: name,
            summary: failed
              ? `${name ?? "Tool"} failed`
              : `${name ?? "Tool"} finished`,
            data: {
              toolCallId: part._id ?? null,
              status: response?.status ?? null,
            },
          }),
        );
      }
    });

    const tokens =
      message?.tokens ?? message?.usage ?? message?.usageMetadata ?? null;
    if (tokens && typeof tokens === "object") {
      events.push(
        ev("usage", {
          kind: "usage",
          usage: tokens,
          summary: `Usage reported: ${tokens.total ?? tokens.totalTokenCount ?? "?"} tokens`,
        }),
      );
    }
    return events;
  }

  function readEvents(session, offset = 0) {
    const file = session?.sourcePath;
    if (!file || !statSafe(file)) return { events: [], offset, ended: false };
    const json = readJson(file);
    if (json == null) return { events: [], offset, ended: false };
    const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
    const events = [];

    if (
      (path.basename(file).toLowerCase() === "logs.json" ||
        looksLikeLog(json)) &&
      Array.isArray(json)
    ) {
      json.forEach((entry, index) => {
        if (index < start) return;
        if (String(entry?.sessionId ?? "") !== session.sessionId) return;
        if (!entry?.message) return;
        events.push(
          makeEvent({
            provider,
            sessionId: session.sessionId,
            cwd: session.cwd ?? null,
            timestamp: toMs(entry.timestamp, now()),
            providerEventId: `${session.sessionId}:log:${entry.messageId ?? index}`,
            kind: "prompt",
            provenance: "user",
            summary: truncate(entry.message),
            data: { unverified: true, content: truncate(entry.message, 2000) },
          }),
        );
      });
      return { events, offset: json.length, ended: !isLive(session) };
    }

    const messages = extractMessages(json);
    for (let i = start; i < messages.length; i++) {
      for (const event of mapMessage(messages[i], i, session))
        events.push(event);
    }
    return {
      events,
      offset: Math.max(start, messages.length),
      ended: !isLive(session),
    };
  }

  return {
    provider,
    home: homePath,
    status,
    auth,
    scanSessions,
    readEvents,
    isLive,
  };
}

export default createObserver;
