/**
 * Gemini CLI observer (unverified; Gemini CLI is not installed on the
 * reference machine). Reads, per the Gemini CLI docs:
 *   <home>/tmp/<project_hash>/chats/*.json   saved chat sessions
 *   <home>/tmp/<project_hash>/logs.json      prompt log [{sessionId,messageId,type,message,timestamp}]
 *
 * The chat file structure is parsed defensively: either an array of messages
 * or an object with `messages`/`history`; each message with `role`|`type`
 * and `parts`|`content`, optional `toolCalls`, `tokens`, `model`, `timestamp`.
 * Everything emitted carries `data.unverified = true` and sessions carry
 * `metadata.unverified = true` until the format is verified against a real
 * installation. Antigravity (`<home>/antigravity`) is a different product:
 * detected and reported as unsupported, never parsed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeEvent, classifyTool } from "../contracts.js";

export const provider = "gemini";

export const capabilityNote =
  "Gemini CLI observation is unverified: session files under ~/.gemini/tmp are parsed " +
  "defensively from the documented layout, and live-ness is inferred from file " +
  "modification time. Antigravity IDE data in ~/.gemini/antigravity is detected only.";

export const capabilities = {
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
};

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
  const antigravityDir = path.join(homePath, "antigravity");

  function status() {
    const homeExists = Boolean(statSafe(homePath));
    const antigravity = Boolean(statSafe(antigravityDir));
    const hasSessions = Boolean(statSafe(tmpDir));
    return {
      provider,
      home: homePath,
      homeExists,
      installed: hasSessions, // a Gemini CLI home has tmp/<hash>; antigravity alone is not the CLI
      unverified: true,
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

  function sessionFromChat(projectHash, file) {
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
      cwd: json.cwd ? normalizePath(json.cwd) : null,
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
        projectHash,
        messageCount: messages.length,
      },
    };
  }

  function sessionsFromLogs(projectHash, file, seen) {
    const json = readJson(file);
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
        cwd: null,
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
          source: "logs.json",
          projectHash,
          messageCount: group.entries.length,
        },
      });
    }
    return out;
  }

  function scanSessions() {
    const sessions = [];
    const seen = new Set();
    for (const hash of listDirs(tmpDir)) {
      const projectDir = path.join(tmpDir, hash);
      const chatsDir = path.join(projectDir, "chats");
      for (const name of listFiles(chatsDir, ".json")) {
        const session = sessionFromChat(hash, path.join(chatsDir, name));
        if (session && !seen.has(session.sessionId)) {
          seen.add(session.sessionId);
          sessions.push(session);
        }
      }
      const logs = path.join(projectDir, "logs.json");
      if (statSafe(logs)) {
        for (const session of sessionsFromLogs(hash, logs, seen)) {
          seen.add(session.sessionId);
          sessions.push(session);
        }
      }
    }
    for (const session of sessions) session.live = isLive(session);
    sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    sessions.metadata = status();
    return sessions;
  }

  /** Live-ness is inferred from mtime only; Gemini does not expose a registry we know of. */
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
      path.basename(file).toLowerCase() === "logs.json" &&
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

  return { provider, home: homePath, status, scanSessions, readEvents, isLive };
}

export default createObserver;
