/**
 * Cross-record search over what Agent Space has already recorded.
 *
 * Honesty rules that shape this module:
 *  - It searches ONLY the SQLite tables. It never opens a file on disk, never
 *    walks a repository, and never reads provider storage. A file path can be
 *    matched (we stored it), the file's content cannot.
 *  - It never invents a result. When nothing matches, the kind comes back with
 *    an empty array and `total: 0`, and the response says so in `empty`.
 *  - Snippets are cut out of text we already stored, run through the audit
 *    secret redactor, and clipped, so a search result can never surface more
 *    than the record it came from.
 *  - Every kind has its own cap so one noisy table cannot crowd out the rest.
 */
import { redactSecrets } from "../audit/Audit.js";

/** Record kinds that can be searched, in the order results are returned. */
export const SEARCH_KINDS = Object.freeze([
  "tasks",
  "runs",
  "events",
  "artifacts",
  "sessions",
]);

/** Default and maximum number of rows returned per kind. */
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;

/** Longest snippet returned for any result. */
export const SNIPPET_CHARS = 200;

/** Longest query accepted; longer queries are rejected, not silently cut. */
export const MAX_QUERY_CHARS = 200;

/** Escapes the LIKE wildcards so a query of "100%" matches the literal text. */
export function likePattern(query) {
  return `%${String(query).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function clip(text, max = SNIPPET_CHARS) {
  const value = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

/**
 * Cuts a window of text around the first case-insensitive hit so the caller
 * sees why the row matched. Falls back to the head of the text when the match
 * is in a field that is not the snippet source (a title or a path).
 */
export function snippetAround(text, query, max = SNIPPET_CHARS) {
  const value = String(text ?? "");
  if (!value) return "";
  const index = value.toLowerCase().indexOf(String(query).toLowerCase());
  if (index < 0) return clip(value, max);
  const start = Math.max(0, index - Math.floor(max / 3));
  const window = value.slice(start, start + max);
  return `${start > 0 ? "…" : ""}${clip(window, max)}`;
}

function safeSnippet(text, query) {
  const redacted = redactSecrets(String(text ?? ""), 0, { maxString: 4000 });
  return snippetAround(typeof redacted === "string" ? redacted : "", query);
}

function normalizeKinds(kinds) {
  if (kinds === undefined || kinds === null || kinds === "")
    return [...SEARCH_KINDS];
  const list = Array.isArray(kinds)
    ? kinds
    : String(kinds)
        .split(",")
        .map((k) => k.trim());
  const chosen = list.filter((kind) => SEARCH_KINDS.includes(kind));
  return chosen.length ? [...new Set(chosen)] : [...SEARCH_KINDS];
}

function normalizeLimit(limit) {
  const value = Number(limit);
  if (!Number.isFinite(value) || value < 1) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(value));
}

/**
 * Search over recorded tasks, runs, events, artifacts, and observed sessions.
 *
 *   new Search(services).search({ q, workspaceId, kinds, limit })
 *     → { query, kinds, limit, empty, counts, results: [Result] }
 *
 * Result = { kind, id, title, snippet, workspaceId, runId, taskId, timestamp,
 *            provider, basis }
 * `basis` names the column that matched, so the UI never has to guess.
 */
export class Search {
  constructor(services, options = {}) {
    this.services = services;
    this.db = options.db ?? services.db;
  }

  search({ q, query, workspaceId = null, kinds, limit } = {}) {
    const text = String(q ?? query ?? "").trim();
    const chosen = normalizeKinds(kinds);
    const cap = normalizeLimit(limit);
    const base = {
      query: text,
      kinds: chosen,
      limit: cap,
      workspaceId: workspaceId || null,
      counts: Object.fromEntries(chosen.map((kind) => [kind, 0])),
      results: [],
      empty: true,
      note: null,
    };
    if (!text) return { ...base, note: "Type something to search for." };
    if (text.length > MAX_QUERY_CHARS)
      return {
        ...base,
        note: `Search text must be ${MAX_QUERY_CHARS} characters or fewer.`,
      };

    const pattern = likePattern(text);
    const results = [];
    for (const kind of chosen) {
      let rows = [];
      try {
        rows = this[`_${kind}`](pattern, text, workspaceId, cap);
      } catch (error) {
        this.services?.log?.error?.(
          `[search] ${kind} failed: ${error?.message ?? error}`,
        );
        rows = [];
      }
      base.counts[kind] = rows.length;
      results.push(...rows);
    }
    return {
      ...base,
      results,
      empty: results.length === 0,
      note: results.length
        ? null
        : "No recorded task, run, event, artifact, or observed session matches. Agent Space searches its own records only; it never reads file contents from disk.",
    };
  }

  #where(workspaceId, column = "workspace_id") {
    return workspaceId ? ` AND ${column} = ?` : "";
  }

  _tasks(pattern, text, workspaceId, limit) {
    const sql = `SELECT id, workspace_id, title, description, deliverable, status, created_at, updated_at
       FROM tasks
       WHERE (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR deliverable LIKE ? ESCAPE '\\')${this.#where(
         workspaceId,
       )}
       ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ?`;
    const args = workspaceId
      ? [pattern, pattern, pattern, workspaceId, limit]
      : [pattern, pattern, pattern, limit];
    return this.db
      .prepare(sql)
      .all(...args)
      .map((row) => ({
        kind: "tasks",
        id: row.id,
        title: row.title,
        snippet: safeSnippet(
          `${row.description ?? ""} ${row.deliverable ?? ""}`.trim() ||
            row.title,
          text,
        ),
        workspaceId: row.workspace_id,
        runId: null,
        taskId: row.id,
        timestamp: row.updated_at ?? row.created_at,
        provider: null,
        basis: `task ${String(row.status).toLowerCase()}`,
      }));
  }

  _runs(pattern, text, workspaceId, limit) {
    const sql = `SELECT id, workspace_id, task_id, provider, status, title, summary, prompt, mode,
              started_at, ended_at, last_event_at
       FROM runs
       WHERE (title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR prompt LIKE ? ESCAPE '\\'
              OR provider LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')${this.#where(workspaceId)}
       ORDER BY started_at DESC LIMIT ?`;
    const p = [pattern, pattern, pattern, pattern, pattern];
    const args = workspaceId ? [...p, workspaceId, limit] : [...p, limit];
    return this.db
      .prepare(sql)
      .all(...args)
      .map((row) => ({
        kind: "runs",
        id: row.id,
        title: row.title ?? `${row.provider} run`,
        snippet: safeSnippet(
          row.summary ?? row.prompt ?? row.title ?? "",
          text,
        ),
        workspaceId: row.workspace_id,
        runId: row.id,
        taskId: row.task_id ?? null,
        timestamp: row.last_event_at ?? row.ended_at ?? row.started_at,
        provider: row.provider,
        basis: `${row.mode ?? "manual"} run · ${row.status}`,
      }));
  }

  _events(pattern, text, workspaceId, limit) {
    // `data` is deliberately not searched: it is the raw provider payload and
    // is only ever shown through the run inspector, which redacts it there.
    const sql = `SELECT id, workspace_id, run_id, task_id, kind, message, tool, file, timestamp, provenance
       FROM events
       WHERE (message LIKE ? ESCAPE '\\' OR tool LIKE ? ESCAPE '\\' OR file LIKE ? ESCAPE '\\')${this.#where(
         workspaceId,
       )}
       ORDER BY timestamp DESC LIMIT ?`;
    const args = workspaceId
      ? [pattern, pattern, pattern, workspaceId, limit]
      : [pattern, pattern, pattern, limit];
    return this.db
      .prepare(sql)
      .all(...args)
      .map((row) => ({
        kind: "events",
        id: row.id,
        title: row.tool ? `${row.kind} · ${row.tool}` : row.kind,
        snippet: safeSnippet(row.message ?? row.file ?? "", text),
        workspaceId: row.workspace_id,
        runId: row.run_id ?? null,
        taskId: row.task_id ?? null,
        timestamp: row.timestamp,
        provider: null,
        basis: `event (${row.provenance ?? "system"})`,
      }));
  }

  _artifacts(pattern, text, workspaceId, limit) {
    // Only the first 8 KB of content is scanned so a huge diff cannot stall a
    // search; the row still says how big the artifact is.
    const sql = `SELECT id, workspace_id, run_id, task_id, kind, path, title, size, created_at,
              SUBSTR(COALESCE(content, ''), 1, 8000) AS head
       FROM artifacts
       WHERE (title LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\'
              OR SUBSTR(COALESCE(content, ''), 1, 8000) LIKE ? ESCAPE '\\')${this.#where(
                workspaceId,
              )}
       ORDER BY created_at DESC LIMIT ?`;
    const args = workspaceId
      ? [pattern, pattern, pattern, workspaceId, limit]
      : [pattern, pattern, pattern, limit];
    return this.db
      .prepare(sql)
      .all(...args)
      .map((row) => ({
        kind: "artifacts",
        id: row.id,
        title: row.title ?? `${row.kind} artifact`,
        snippet: safeSnippet(row.head ?? row.path ?? "", text),
        workspaceId: row.workspace_id ?? null,
        runId: row.run_id ?? null,
        taskId: row.task_id ?? null,
        timestamp: row.created_at,
        provider: null,
        basis: `${row.kind} artifact · ${row.size ?? 0} bytes`,
      }));
  }

  _sessions(pattern, text, workspaceId, limit) {
    const sql = `SELECT id, provider, session_id, cwd, title, model, run_id, workspace_id,
              started_at, updated_at, live
       FROM observed_sessions
       WHERE (title LIKE ? ESCAPE '\\' OR cwd LIKE ? ESCAPE '\\'
              OR session_id LIKE ? ESCAPE '\\' OR provider LIKE ? ESCAPE '\\')${this.#where(
                workspaceId,
              )}
       ORDER BY COALESCE(updated_at, started_at) DESC LIMIT ?`;
    const p = [pattern, pattern, pattern, pattern];
    const args = workspaceId ? [...p, workspaceId, limit] : [...p, limit];
    return this.db
      .prepare(sql)
      .all(...args)
      .map((row) => ({
        kind: "sessions",
        id: row.id,
        title: row.title ?? `${row.provider} session`,
        snippet: safeSnippet(row.cwd ?? row.session_id, text),
        workspaceId: row.workspace_id ?? null,
        runId: row.run_id ?? null,
        taskId: null,
        timestamp: row.updated_at ?? row.started_at,
        provider: row.provider,
        basis: row.live === 1 ? "observed session · live" : "observed session",
      }));
  }
}

/** Attaches the service as `services.search` and returns it. */
export function createSearch(services, options = {}) {
  services.search = new Search(services, options);
  return services.search;
}
