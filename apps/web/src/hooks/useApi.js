import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Small fetch layer shared by every component in apps/web/src/components and
 * apps/web/src/views. Requests go to `/api`, JSON in and out, with the bearer
 * token from localStorage "agent-space-token" attached when present (shared
 * mode). Pure helpers used by the views live here too so node:test can cover
 * them without a DOM.
 */

export const API_BASE = "/api";
export const TOKEN_KEY = "agent-space-token";

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export function readToken() {
  try {
    return globalThis.localStorage?.getItem(TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

/**
 * Fetch JSON from the API. `path` may start with "/api" or be relative to it.
 * @param {string} path
 * @param {{ method?: string, body?: any, signal?: AbortSignal }} [options]
 */
export async function apiFetch(path, { method = "GET", body, signal } = {}) {
  const url = path.startsWith("/api") ? path : `${API_BASE}${path}`;
  const headers = { Accept: "application/json" };
  const token = readToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new ApiError(
      "Server unreachable. Check that Agent Space is running.",
      0,
    );
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!response.ok) {
    const message =
      data?.error ??
      data?.message ??
      (response.status === 404
        ? "Not available. This endpoint is not enabled on the server."
        : `Request failed (${response.status})`);
    throw new ApiError(message, response.status, data);
  }
  return data;
}

/**
 * Declarative GET hook.
 * @param {string|null} path  null disables the request.
 * @param {{ interval?: number, enabled?: boolean, deps?: any[] }} [options]
 *   interval: re-fetch every N ms while mounted.
 * @returns {{ data:any, error:Error|null, loading:boolean, reload:()=>Promise<void>, setData:Function }}
 */
export function useApi(path, { interval = 0, enabled = true, deps = [] } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(Boolean(path && enabled));
  const alive = useRef(true);
  const reload = useCallback(async () => {
    if (!path || !enabled) return;
    try {
      const result = await apiFetch(path);
      if (alive.current) {
        setData(result);
        setError(null);
      }
    } catch (err) {
      if (alive.current && err?.name !== "AbortError") setError(err);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [path, enabled]);
  useEffect(() => {
    alive.current = true;
    if (path && enabled) {
      setLoading(true);
      reload();
    }
    let timer = null;
    if (interval > 0 && path && enabled)
      timer = setInterval(() => {
        if (typeof document === "undefined" || !document.hidden) reload();
      }, interval);
    return () => {
      alive.current = false;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, enabled, interval, reload, ...deps]);
  return { data, error, loading, reload, setData };
}

/* ------------------------------------------------------------------ */
/* Pure helpers (covered by tests/web-components.test.js)              */
/* ------------------------------------------------------------------ */

export const PROVIDER_LABELS = {
  "claude-code": "Claude Code",
  codex: "Codex",
  copilot: "Copilot",
  cursor: "Cursor",
  gemini: "Gemini",
  antigravity: "Antigravity",
  opencode: "OpenCode",
  aider: "Aider",
  windsurf: "Windsurf",
  manual: "Manual",
  simulated: "Demo",
  demo: "Demo",
};

export function providerLabel(provider) {
  if (!provider) return "Manual";
  return PROVIDER_LABELS[provider] ?? String(provider);
}

export const ACTIVITY_LABELS = {
  IDLE: "Idle",
  ANALYZING: "Planning",
  CODING: "Coding",
  RESEARCHING: "Researching",
  TESTING: "Testing",
  DEBUGGING: "Debugging",
  REVIEWING: "Reviewing",
  COMMANDING: "Running command",
  MESSAGING: "Messaging",
  DELEGATING: "Delegating",
  WAITING_APPROVAL: "Needs approval",
  BLOCKED: "Blocked",
  ERROR: "Error",
  STALE: "Stale",
  // Presentation only: a manual task, whose one recorded fact is its status.
  MANUAL: "In progress",
};

/** Why a manual task shows no activity (tooltips and screen readers). */
export const MANUAL_ACTIVITY_NOTE =
  "A manual task: nothing reports what this agent is doing, so only the task's status is shown.";

export function activityLabel(activity) {
  if (!activity) return "Idle";
  return ACTIVITY_LABELS[activity] ?? String(activity);
}

/** Readable names for the normalized event kinds (core/contracts.js). */
export const EVENT_KIND_LABELS = {
  "session.start": "Session started",
  "session.end": "Session ended",
  "turn.start": "Turn started",
  "turn.end": "Turn ended",
  prompt: "Prompt",
  message: "Message",
  // Only the fact of reasoning is recorded; its content is never stored.
  reasoning: "Reasoning",
  "tool.start": "Tool call",
  "tool.end": "Tool finished",
  "file.read": "Read file",
  "file.edit": "Edited file",
  "file.write": "Wrote file",
  search: "Search",
  web: "Web",
  command: "Command",
  test: "Test",
  "approval.request": "Approval asked",
  "approval.decision": "Decision",
  delegation: "Delegated",
  usage: "Usage",
  error: "Error",
  status: "Status",
  "run.status": "Status",
  system: "System",
  task: "Task",
  complete: "Completed",
  handoff: "Handoff",
  team: "Team",
};

export function eventKindLabel(kind) {
  return EVENT_KIND_LABELS[kind] ?? String(kind ?? "Event");
}

export const RUN_STATUS_LABELS = {
  queued: "Queued",
  running: "Running",
  blocked: "Blocked",
  waiting_approval: "Needs approval",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  disconnected: "Disconnected",
  stale: "Stale",
};

export const ACTIVE_RUN_STATUSES = [
  "queued",
  "running",
  "blocked",
  "waiting_approval",
  "stale",
];

export function isActiveRun(run) {
  return Boolean(run) && ACTIVE_RUN_STATUSES.includes(run.status);
}

/** "1h 02m 03s" style elapsed time from milliseconds. */
export function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h >= 24)
    return `${Math.floor(h / 24)}d ${h % 24}h ${String(m).padStart(2, "0")}m`;
  if (h > 0)
    return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/**
 * Re-renders the caller every `intervalMs` while `active`, so elapsed times
 * and "4m ago" labels stay true between snapshots. One timer per caller.
 */
export function useTicker(active = true, intervalMs = 1000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setTick((value) => value + 1), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
}

/**
 * "just now", "4m ago", "2h ago", "3d ago" for a recorded time (epoch ms or
 * an ISO string); null when there is no usable time.
 */
export function timeAgo(timestamp, now = Date.now()) {
  const at =
    typeof timestamp === "number" ? timestamp : Date.parse(timestamp ?? "");
  if (!Number.isFinite(at) || at <= 0) return null;
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatTime(timestamp) {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatNumber(value) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString();
}

/** Masks private absolute paths for presentation mode: keeps the last two segments. */
export function maskPath(path, masked = true) {
  if (!path) return "";
  if (!masked) return path;
  const parts = String(path)
    .split(/[\\/]+/)
    .filter(Boolean);
  if (parts.length <= 2) return parts.join("/");
  return `…/${parts.slice(-2).join("/")}`;
}

/**
 * Masks absolute paths inside free text (doctor findings, CLI errors) the way
 * maskPath masks a path field, so presentation mode does not leak a user name
 * through a sentence. `~/…` paths name no user and are left alone. A sentence
 * full stop after a path stays outside the mask.
 */
const ABSOLUTE_PATH =
  /(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|root)\/)[^\s"'`,;()<>]+/g;
export function maskPathsInText(text, masked = true) {
  if (!text || !masked) return text ?? "";
  return String(text).replace(ABSOLUTE_PATH, (match) => {
    const stop = /[.:]+$/.exec(match)?.[0] ?? "";
    return maskPath(match.slice(0, match.length - stop.length), true) + stop;
  });
}

export function basename(path) {
  if (!path) return "";
  const parts = String(path)
    .split(/[\\/]+/)
    .filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/**
 * Subsequence fuzzy match. Returns a score (higher is better) or -1 when the
 * query does not match. Contiguous and word-start matches score higher.
 */
export function fuzzyScore(query, text) {
  const q = String(query ?? "")
    .toLowerCase()
    .replace(/\s+/g, "");
  const t = String(text ?? "").toLowerCase();
  if (!q) return 0;
  let score = 0;
  let ti = 0;
  let previous = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const index = t.indexOf(q[qi], ti);
    if (index === -1) return -1;
    score += 1;
    if (index === previous + 1) score += 2;
    if (index === 0 || /[\s\-_/.:]/.test(t[index - 1] ?? "")) score += 3;
    previous = index;
    ti = index + 1;
  }
  return score - (t.length - q.length) * 0.01;
}

export function fuzzyFilter(query, items, getText = (item) => item.label) {
  if (!String(query ?? "").trim()) return items.slice();
  return items
    .map((item) => ({ item, score: fuzzyScore(query, getText(item)) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);
}

/**
 * Groups tool.start/tool.end events by tool name.
 * @returns {Array<{ tool:string, starts:number, ends:number, errors:number, files:string[], last:number|null }>}
 */
export function groupToolEvents(events = []) {
  const groups = new Map();
  for (const event of events) {
    if (event.kind !== "tool.start" && event.kind !== "tool.end") continue;
    const name = event.tool || event.data?.tool || "unknown";
    if (!groups.has(name))
      groups.set(name, {
        tool: name,
        starts: 0,
        ends: 0,
        errors: 0,
        files: [],
        last: null,
      });
    const group = groups.get(name);
    if (event.kind === "tool.start") group.starts += 1;
    else group.ends += 1;
    if (event.kind === "error" || event.data?.isError || event.data?.is_error)
      group.errors += 1;
    if (event.file && !group.files.includes(event.file))
      group.files.push(event.file);
    if (event.timestamp && (!group.last || event.timestamp > group.last))
      group.last = event.timestamp;
  }
  return [...groups.values()].sort(
    (a, b) => b.starts - a.starts || a.tool.localeCompare(b.tool),
  );
}

/**
 * Longest-path layering for a DAG. Nodes: [{ id }], edges: [{ from, to }]
 * (from must finish before to). Cycles are tolerated: the offending edge is
 * ignored for layout. Returns { layers: string[][], position: Map<id,{layer,index}> }.
 */
export function layerGraph(nodes = [], edges = []) {
  const ids = nodes.map((node) => node.id);
  const known = new Set(ids);
  const incoming = new Map(ids.map((id) => [id, []]));
  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to) || edge.from === edge.to)
      continue;
    incoming.get(edge.to).push(edge.from);
  }
  const layerOf = new Map();
  const visiting = new Set();
  const resolve = (id) => {
    if (layerOf.has(id)) return layerOf.get(id);
    if (visiting.has(id)) return 0; // cycle guard
    visiting.add(id);
    let layer = 0;
    for (const parent of incoming.get(id))
      layer = Math.max(layer, resolve(parent) + 1);
    visiting.delete(id);
    layerOf.set(id, layer);
    return layer;
  };
  ids.forEach(resolve);
  const layers = [];
  for (const id of ids) {
    const layer = layerOf.get(id);
    (layers[layer] ??= []).push(id);
  }
  const position = new Map();
  layers.forEach((layer, layerIndex) =>
    layer.forEach((id, index) =>
      position.set(id, { layer: layerIndex, index }),
    ),
  );
  return { layers, position };
}

/**
 * Splits a unified diff into typed lines for rendering.
 * @returns {Array<{ type:'add'|'del'|'hunk'|'meta'|'context', text:string }>}
 */
export function parseDiff(text = "") {
  return String(text)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      if (
        line.startsWith("+++") ||
        line.startsWith("---") ||
        line.startsWith("diff ") ||
        line.startsWith("index ")
      )
        return { type: "meta", text: line };
      if (line.startsWith("@@")) return { type: "hunk", text: line };
      if (line.startsWith("+")) return { type: "add", text: line };
      if (line.startsWith("-")) return { type: "del", text: line };
      return { type: "context", text: line };
    });
}

/** Chains attempts: walks parentRunId links from `run` through `runs`. */
export function attemptChain(run, runs = []) {
  if (!run) return [];
  const byId = new Map(runs.map((entry) => [entry.id, entry]));
  const chain = [];
  const seen = new Set();
  let current = run;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.parentRunId ? byId.get(current.parentRunId) : null;
  }
  for (const entry of runs) {
    if (entry.parentRunId === run.id && !seen.has(entry.id)) {
      seen.add(entry.id);
      chain.push(entry);
    }
  }
  return chain;
}

/** Expiry helper for approvals: "expires in 4m 10s" | "expired". */
export function expiresIn(expiresAt, now = Date.now()) {
  if (!expiresAt) return "no expiry";
  const ms = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(ms)) return "no expiry";
  if (ms <= 0) return "expired";
  return `expires in ${formatElapsed(ms)}`;
}

export function toCsv(rows, columns) {
  const escape = (value) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = columns.map(escape).join(",");
  const lines = rows.map((row) =>
    columns.map((column) => escape(row[column])).join(","),
  );
  return [header, ...lines].join("\r\n");
}

/* ------------------------------------------------------------------ */
/* Presentation (creator/presenter) mode                               */
/* ------------------------------------------------------------------ */

/**
 * Presentation mode hides private material before a screen recording. It is a
 * display filter, not redaction: the records are untouched and anyone with
 * access to the machine still sees everything. Say so wherever it is offered.
 *
 * `maskPath` above already hides private absolute paths. These helpers extend
 * the same treatment to task text, account labels and artifact titles.
 */

/** Keeps the first `keep` words of a title and replaces the rest with a count. */
export function maskText(text, masked = true, keep = 2) {
  if (!text) return "";
  if (!masked) return String(text);
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length <= keep) return words.join(" ");
  return `${words.slice(0, keep).join(" ")} … (${words.length - keep} words hidden)`;
}

/** Replaces an account or owner label with its shape, never its value. */
export function maskAccount(label, masked = true) {
  if (!label) return "";
  if (!masked) return String(label);
  const text = String(label);
  return `${text.slice(0, 1)}${"•".repeat(Math.max(2, Math.min(8, text.length - 1)))}`;
}

/**
 * An artifact's title and path are both private material: the title often
 * carries a branch or file name. In presentation mode we keep only the kind.
 */
export function maskArtifact(artifact, masked = true) {
  if (!artifact) return { title: "", kind: null };
  const kind = artifact.kind ?? null;
  if (!masked) return { title: artifact.title ?? kind ?? artifact.id, kind };
  return {
    title: kind ? `${kind} artifact (title hidden)` : "artifact (title hidden)",
    kind,
  };
}
