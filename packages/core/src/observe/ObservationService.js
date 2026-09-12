import { basename } from "node:path";
import { arch, homedir, platform } from "node:os";
import { openSync, readSync, closeSync, statSync, existsSync } from "node:fs";
import { PROVIDERS, TERMINAL_RUN_STATUSES } from "../contracts.js";
import { InputError } from "../TaskStore.js";
import { DEMO_WORKSPACE_ID } from "../WorkspaceHub.js";
import { RunRecorder } from "../runs/RunRecorder.js";
import { transaction } from "../db.js";
import { detectPassiveSurfaces } from "../providers/surfaces.js";
import {
  agentUsable,
  ensureProviderAgent,
  resolveWorkspaceForCwd,
  expandHome,
} from "./mapping.js";

const OBSERVER_MODULES = [
  ["claude-code", "./claudeCode.js"],
  ["codex", "./codex.js"],
  ["copilot", "./copilot.js"],
  ["cursor", "./cursor.js"],
  ["gemini", "./gemini.js"],
];

/** Provider home directory from env override or the documented default. */
export function providerHome(providerId, env = process.env) {
  const provider = PROVIDERS[providerId];
  if (!provider) return null;
  const override = env[provider.homeEnv];
  if (override && override.trim()) return expandHome(override.trim());
  const fallback = provider.homeDefault ?? `~/.${providerId}`;
  return expandHome(fallback.replace(/^~/, homedir()));
}

/**
 * Lazily imports every observer module that exists. Missing or broken
 * modules are skipped so the service still runs with a partial set.
 */
export async function createDefaultObservers(services, { env, log } = {}) {
  const environment = env ?? process.env;
  const logger = log ?? services?.log ?? console;
  const observers = [];
  for (const [providerId, file] of OBSERVER_MODULES) {
    try {
      const mod = await import(file);
      const factory = mod.createObserver ?? mod.default;
      if (typeof factory !== "function") continue;
      const observer = factory({
        home: providerHome(providerId, environment),
        env: environment,
        services,
      });
      if (observer && typeof observer.scanSessions === "function") {
        observer.provider ??= providerId;
        observers.push(observer);
      }
    } catch (error) {
      logger.debug?.(
        `[observe] observer for ${providerId} unavailable: ${error?.message ?? error}`,
      );
    }
  }
  return observers;
}

function sessionKey(provider, sessionId) {
  return `${provider}:${sessionId}`;
}

/** Parsed `observed_sessions.metadata` (never throws). */
function metadataOf(row) {
  try {
    const value = row?.metadata ? JSON.parse(row.metadata) : {};
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function rowToSession(row) {
  let metadata = {};
  try {
    metadata = row.metadata ? JSON.parse(row.metadata) : {};
  } catch {
    metadata = {};
  }
  return {
    id: row.id,
    provider: row.provider,
    sessionId: row.session_id,
    cwd: row.cwd ?? null,
    title: row.title ?? null,
    sourcePath: row.source_path ?? null,
    sourceOffset: row.source_offset ?? 0,
    startedAt: row.started_at ?? null,
    updatedAt: row.updated_at ?? null,
    endedAt: row.ended_at ?? null,
    live: row.live === 1,
    model: row.model ?? null,
    runId: row.run_id ?? null,
    workspaceId: row.workspace_id ?? null,
    workspaceName: row.workspace_name ?? null,
    agentId: row.agent_id ?? null,
    agentName: row.agent_name ?? null,
    activity: row.run_activity ?? null,
    currentFile: row.run_current_file ?? null,
    currentAction: row.run_current_action ?? null,
    status: row.run_status ?? (row.ended_at ? "ended" : "history"),
    lastEventAt: row.run_last_event_at ?? row.updated_at ?? null,
    metadata,
  };
}

const SESSION_SELECT = `
  SELECT s.*,
    w.name AS workspace_name,
    a.name AS agent_name,
    r.status AS run_status,
    r.activity AS run_activity,
    r.current_file AS run_current_file,
    r.current_action AS run_current_action,
    r.last_event_at AS run_last_event_at,
    r.actual_model AS run_model
  FROM observed_sessions s
  LEFT JOIN workspaces w ON w.id = s.workspace_id
  LEFT JOIN agent_profiles a ON a.id = s.agent_id
  LEFT JOIN runs r ON r.id = s.run_id`;

/** Observed sessions for the global snapshot (live ones only). */
export function liveSessionsSummary(services) {
  const rows = services.db
    .prepare(
      `${SESSION_SELECT} WHERE s.live = 1 AND s.ended_at IS NULL ORDER BY s.updated_at DESC`,
    )
    .all();
  return rows.map((row) => {
    const session = rowToSession(row);
    return {
      id: session.id,
      provider: session.provider,
      sessionId: session.sessionId,
      cwd: session.cwd,
      title: session.title,
      workspaceId: session.workspaceId,
      workspaceName: session.workspaceName,
      runId: session.runId,
      agentId: session.agentId,
      agentName: session.agentName,
      activity: session.activity,
      currentFile: session.currentFile,
      currentAction: session.currentAction,
      model: session.model ?? row.run_model ?? null,
      startedAt: session.startedAt,
      lastEventAt: session.lastEventAt,
      live: session.live,
      status: session.status,
    };
  });
}

/**
 * Polls provider observers, maps their sessions onto workspaces/agents, and
 * feeds normalized events through the RunRecorder. Offsets live in
 * `observed_sessions` so restarts resume without replaying history.
 */
export class ObservationService {
  constructor(services, options = {}) {
    this.services = services;
    this.db = services.db;
    this.hub = services.hub;
    this.bus = services.bus;
    this.observers = [...(options.observers ?? [])];
    this.intervalMs = options.intervalMs ?? 2000;
    this.staleAfterMs = options.staleAfterMs ?? 180000;
    this.endAfterMs = options.endAfterMs ?? 1800000;
    this.now = options.now ?? Date.now;
    this.maxEventsPerSessionPerPoll = options.maxEventsPerSessionPerPoll ?? 500;
    this.initialBacklogBytes = options.initialBacklogBytes ?? 256 * 1024;
    this.log = options.log ?? services.log ?? console;
    this.timer = null;
    this.polling = null;
    this.lastPollAt = null;
    this.lastErrors = [];
    services.onClose?.(() => this.stop());
  }

  get recorder() {
    if (!this.services.recorder)
      this.services.recorder = new RunRecorder(this.services);
    return this.services.recorder;
  }

  addObserver(observer) {
    if (observer && !this.observers.includes(observer))
      this.observers.push(observer);
  }

  start() {
    if (this.timer) return;
    this.poll().catch(() => {});
    this.timer = setInterval(() => {
      this.poll().catch(() => {});
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get running() {
    return !!this.timer;
  }

  enabled() {
    try {
      const value = this.services.settings?.get?.("observation.enabled", true);
      return value === undefined || value === null ? true : !!value;
    } catch {
      return true;
    }
  }

  staleAfter() {
    try {
      const value = this.services.settings?.get?.(
        "observation.staleAfterMs",
        this.staleAfterMs,
      );
      return typeof value === "number" && value > 0 ? value : this.staleAfterMs;
    } catch {
      return this.staleAfterMs;
    }
  }

  /** Honors connections.observe / connections.enabled; defaults to allowed. */
  observeAllowed(provider) {
    let rows;
    try {
      rows = this.services.connections?.list?.();
    } catch {
      return true;
    }
    if (!Array.isArray(rows)) return true;
    const matches = rows.filter((row) => row.provider === provider);
    if (!matches.length) return true;
    return matches.some((row) => {
      const observe = row.observe ?? 1;
      const enabled = row.enabled ?? 1;
      return (
        observe !== 0 && observe !== false && enabled !== 0 && enabled !== false
      );
    });
  }

  status() {
    const counts = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN live = 1 AND ended_at IS NULL THEN 1 ELSE 0 END) AS live,
           SUM(CASE WHEN ended_at IS NOT NULL THEN 1 ELSE 0 END) AS ended,
           COUNT(*) AS total
         FROM observed_sessions`,
      )
      .get();
    const liveByProvider = Object.fromEntries(
      this.db
        .prepare(
          `SELECT provider, COUNT(*) AS count
           FROM observed_sessions
           WHERE live = 1 AND ended_at IS NULL
           GROUP BY provider`,
        )
        .all()
        .map((row) => [row.provider, row.count]),
    );
    const surfaces = [];
    for (const observer of this.observers) {
      let detail = {};
      try {
        // Observers without a status() of their own (Claude Code, Codex,
        // Copilot) still know their vendor home. Its existence is the
        // installation signal; without it an idle provider read as missing.
        detail =
          observer.status?.() ??
          (observer.home ? { homeExists: existsSync(observer.home) } : {});
      } catch (error) {
        detail = { error: String(error?.message ?? error) };
      }
      const provider = observer.provider;
      const liveSessions = liveByProvider[provider] ?? 0;
      // An observer that judges its own installation (Gemini excludes a home
      // that only Antigravity created) is authoritative over the bare folder.
      const installed =
        typeof detail.installed === "boolean"
          ? detail.installed
          : Boolean(detail.homeExists);
      surfaces.push({
        id: provider,
        provider,
        label: provider,
        kind: "cli",
        detected: installed || liveSessions > 0,
        observable: true,
        fidelity: detail.unverified
          ? "unverified-session-files"
          : detail.experimental
            ? "conversation-summaries"
            : "provider-session-files",
        liveSessions,
        note: detail.note ?? null,
        error: detail.error ?? null,
      });
      if (detail.antigravity) {
        surfaces.push({
          id: "antigravity-ide",
          provider: "antigravity",
          label: "Google Antigravity",
          kind: "ide",
          detected: Boolean(detail.antigravity.detected),
          observable: Boolean(detail.antigravity.supported),
          fidelity: detail.antigravity.supported
            ? "provider-session-files"
            : "installation-detection",
          liveSessions: 0,
          note:
            detail.antigravity.note ??
            "Antigravity was not detected on this machine.",
          error: null,
        });
      }
    }
    const existingSurfaceIds = new Set(surfaces.map((surface) => surface.id));
    for (const surface of detectPassiveSurfaces()) {
      if (surface.detected && !existingSurfaceIds.has(surface.id))
        surfaces.push(surface);
    }
    return {
      enabled: this.enabled(),
      running: this.running,
      intervalMs: this.intervalMs,
      staleAfterMs: this.staleAfter(),
      endAfterMs: this.endAfterMs,
      observers: this.observers.map((observer) => observer.provider),
      host: { platform: platform(), arch: arch() },
      surfaces,
      lastPollAt: this.lastPollAt,
      lastErrors: this.lastErrors,
      sessionCounts: {
        live: counts?.live ?? 0,
        ended: counts?.ended ?? 0,
        total: counts?.total ?? 0,
      },
    };
  }

  /** One pass over every observer. Concurrent calls share the same pass. */
  poll() {
    if (this.polling) return this.polling;
    this.polling = this.#poll().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  async #poll() {
    const summary = { sessions: 0, events: 0, skipped: [], errors: [] };
    if (!this.enabled()) {
      this.lastPollAt = this.now();
      return { ...summary, enabled: false };
    }
    let changed = false;
    for (const observer of this.observers) {
      const provider = observer.provider;
      if (!this.observeAllowed(provider)) {
        summary.skipped.push(provider);
        continue;
      }
      let sessions;
      try {
        sessions = (await observer.scanSessions()) ?? [];
      } catch (error) {
        summary.errors.push({
          provider,
          error: String(error?.message ?? error),
        });
        this.log.warn?.(`[observe] ${provider} scan failed: ${error?.message}`);
        continue;
      }
      for (const session of sessions) {
        if (!session || !session.sessionId) continue;
        // Let HTTP/WebSocket callbacks interleave with a long scan.
        await new Promise((resolve) => setImmediate(resolve));
        try {
          const result = await this.#processSession(observer, {
            ...session,
            provider: session.provider ?? provider,
          });
          summary.sessions++;
          summary.events += result.applied;
          if (result.changed) changed = true;
        } catch (error) {
          summary.errors.push({
            provider,
            sessionId: session.sessionId,
            error: String(error?.message ?? error),
          });
          this.log.warn?.(
            `[observe] ${provider} session ${session.sessionId} failed: ${error?.message}`,
          );
        }
      }
    }
    this.lastPollAt = this.now();
    this.lastErrors = summary.errors.slice(0, 20);
    if (changed) this.bus.emit("global");
    return { ...summary, enabled: true, changed };
  }

  #row(id) {
    return this.db
      .prepare("SELECT * FROM observed_sessions WHERE id = ?")
      .get(id);
  }

  #insertRow(id, session, { live, offset, endedAt = null, now }) {
    this.db
      .prepare(
        `INSERT INTO observed_sessions (id, provider, session_id, cwd, title, source_path, source_offset, started_at, updated_at, ended_at, live, model, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        session.provider,
        String(session.sessionId),
        session.cwd ?? null,
        session.title ? String(session.title).slice(0, 200) : null,
        session.sourcePath ?? null,
        offset,
        session.startedAt ?? now,
        session.updatedAt ?? session.startedAt ?? now,
        endedAt,
        live ? 1 : 0,
        session.model ?? null,
        JSON.stringify({
          entrypoint: session.entrypoint ?? null,
          gitBranch: session.gitBranch ?? null,
          pid: session.pid ?? null,
        }),
      );
  }

  #updateRow(id, fields) {
    const map = {
      cwd: "cwd",
      title: "title",
      sourcePath: "source_path",
      sourceOffset: "source_offset",
      updatedAt: "updated_at",
      endedAt: "ended_at",
      live: "live",
      model: "model",
      runId: "run_id",
      workspaceId: "workspace_id",
      agentId: "agent_id",
      metadata: "metadata",
    };
    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(fields)) {
      if (!map[key] || value === undefined) continue;
      sets.push(`${map[key]} = ?`);
      params.push(
        key === "metadata"
          ? JSON.stringify(value ?? {})
          : key === "live"
            ? value
              ? 1
              : 0
            : value,
      );
    }
    if (!sets.length) return;
    params.push(id);
    this.db
      .prepare(`UPDATE observed_sessions SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);
  }

  #isLive(observer, session) {
    try {
      if (typeof observer.isLive === "function")
        return !!observer.isLive(session);
    } catch {
      /* fall through */
    }
    return !!session.live;
  }

  /**
   * For a session seen for the first time with a large transcript, start
   * near the end (aligned to the next line boundary) instead of replaying
   * everything. Returns { offset, skipped }.
   */
  #backlogOffset(sourcePath) {
    if (!sourcePath || !this.initialBacklogBytes) return { offset: 0 };
    let size;
    try {
      size = statSync(sourcePath).size;
    } catch {
      return { offset: 0 };
    }
    if (size <= this.initialBacklogBytes) return { offset: 0 };
    let offset = size - this.initialBacklogBytes;
    try {
      const fd = openSync(sourcePath, "r");
      try {
        const chunk = Buffer.alloc(Math.min(64 * 1024, size - offset));
        const read = readSync(fd, chunk, 0, chunk.length, offset);
        const newline = chunk.subarray(0, read).indexOf(10);
        if (newline >= 0) offset += newline + 1;
      } finally {
        closeSync(fd);
      }
    } catch {
      /* keep the byte offset; observers tolerate a partial first line */
    }
    return { offset, skipped: true };
  }

  /**
   * A run revived after its task was mirrored to COMPLETED must bring the
   * task back too, or the agent shows IDLE while the session is working.
   */
  #reviveTask(run, now) {
    if (!run?.taskId) return;
    try {
      this.db
        .prepare(
          "UPDATE tasks SET status = 'IN_PROGRESS', completed_at = NULL, updated_at = ? WHERE id = ? AND status = 'COMPLETED'",
        )
        .run(now, run.taskId);
    } catch {
      /* task removed */
    }
  }

  #findRun(row, session) {
    const recorder = this.recorder;
    if (row?.run_id) {
      try {
        return recorder.get(row.run_id);
      } catch {
        /* run removed */
      }
    }
    return recorder.find({
      provider: session.provider,
      providerSessionId: String(session.sessionId),
    });
  }

  #titleFor(session) {
    const title = session.title ? String(session.title).trim() : "";
    if (title) return title.slice(0, 80);
    const name = PROVIDERS[session.provider]?.name ?? session.provider;
    const folder = session.cwd ? basename(session.cwd) : "";
    return `${name} session${folder ? ` in ${folder}` : ""}`.slice(0, 80);
  }

  #createRun(session, workspaceId, agentId, row) {
    const recorder = this.recorder;
    const input = {
      workspaceId,
      agentId,
      mode: "observed",
      provider: session.provider,
      providerSessionId: String(session.sessionId),
      cwd: session.cwd ?? null,
      branch: session.gitBranch ?? null,
      sourcePath: session.sourcePath ?? null,
      pid: session.pid ?? null,
      title: this.#titleFor(session),
      startedAt: session.startedAt ?? this.now(),
      createTask: {
        title: row?.title ?? this.#titleFor(session),
        description: session.cwd
          ? `Observed ${PROVIDERS[session.provider]?.name ?? session.provider} session in ${session.cwd}`
          : "",
        source: "observed",
      },
    };
    try {
      return recorder.ensureRun(input);
    } catch (error) {
      if (error?.status !== 409) throw error;
      // The chosen agent became busy between selection and creation.
      const agent = ensureProviderAgent(
        this.services,
        workspaceId,
        session.provider,
        { index: -1 },
      );
      return recorder.ensureRun({ ...input, agentId: agent.id });
    }
  }

  async #processSession(observer, session) {
    const id = sessionKey(session.provider, session.sessionId);
    const now = this.now();
    let row = this.#row(id);
    if (session.isSubagent) {
      if (row) return { applied: 0, changed: false };
      return { applied: 0, changed: false };
    }
    const live = this.#isLive(observer, session);
    const updatedAt = session.updatedAt ?? session.startedAt ?? now;
    let changed = false;
    let applied = 0;
    let offset = row?.source_offset ?? 0;
    let joinedLate = false;

    if (!row) {
      if (!live && now - updatedAt > this.endAfterMs) {
        // History only: too old to be worth a run.
        this.#insertRow(id, session, {
          live: false,
          offset: 0,
          endedAt: updatedAt,
          now,
        });
        return { applied: 0, changed: true };
      }
      const backlog = this.#backlogOffset(session.sourcePath);
      offset = backlog.offset;
      joinedLate = !!backlog.skipped;
      this.#insertRow(id, session, { live, offset, now });
      row = this.#row(id);
      changed = true;
    } else if (row.ended_at && !row.run_id) {
      // Known history row. Only revive it when the session actually came back.
      if (!live && now - updatedAt > this.endAfterMs) {
        const nextTitle = session.title
          ? String(session.title).slice(0, 200)
          : row.title;
        const nextCwd = session.cwd ?? row.cwd;
        // Rows on disk rarely change; skip the UPDATE (and its fsync) when
        // nothing did, or every poll pays one write per history session.
        if (
          row.updated_at !== updatedAt ||
          row.title !== nextTitle ||
          row.cwd !== nextCwd
        )
          this.#updateRow(id, { updatedAt, title: nextTitle, cwd: nextCwd });
        return { applied: 0, changed: false };
      }
      this.#updateRow(id, { endedAt: null, live });
      row = this.#row(id);
      changed = true;
    }

    // Workspace: keep a manual attach; otherwise map the cwd.
    let workspaceId = row.workspace_id;
    if (
      !workspaceId ||
      workspaceId === DEMO_WORKSPACE_ID ||
      !this.hub.has(workspaceId)
    ) {
      workspaceId = resolveWorkspaceForCwd(this.services, session.cwd).id;
      changed = true;
    }
    if (workspaceId === DEMO_WORKSPACE_ID)
      throw new InputError(
        "Refusing to map an observed session to the demo workspace",
      );

    // Agent: reuse the row's agent when still valid.
    let agentId = agentUsable(this.services, workspaceId, row.agent_id)
      ? row.agent_id
      : null;
    let run = this.#findRun(row, session);
    if (run && run.workspaceId !== workspaceId) run = null;
    if (run && !agentId && agentUsable(this.services, workspaceId, run.agentId))
      agentId = run.agentId;
    if (!agentId) {
      agentId = ensureProviderAgent(
        this.services,
        workspaceId,
        session.provider,
      ).id;
      changed = true;
    }
    if (!run) {
      run = this.#createRun(session, workspaceId, agentId, row);
      agentId = run.agentId;
      changed = true;
    }
    const recorder = this.recorder;
    if (
      row.run_id !== run.id ||
      row.workspace_id !== workspaceId ||
      row.agent_id !== agentId
    ) {
      this.#updateRow(id, { runId: run.id, workspaceId, agentId });
      changed = true;
    }
    if (joinedLate) {
      recorder.applyEvent(run.id, {
        kind: "system",
        provenance: "system",
        summary: "Joined an existing session; earlier activity not replayed",
        timestamp: now,
        providerEventId: `${id}:joined-late`,
        data: { sourceOffset: offset },
      });
    }

    // Events from the stored offset. Observers that also tail secondary
    // files (Claude Code subagent transcripts) keep their per-file progress
    // in `cursor`, persisted in the row's metadata next to the main offset.
    const previousCursor = metadataOf(row).cursor ?? null;
    let result = { events: [], offset, ended: false };
    try {
      result =
        (await observer.readEvents(session, offset, {
          cursor: previousCursor,
          initialBacklogBytes: this.initialBacklogBytes,
        })) ?? result;
    } catch (error) {
      this.log.warn?.(
        `[observe] ${session.provider} readEvents failed for ${session.sessionId}: ${error?.message}`,
      );
    }
    const events = Array.isArray(result.events) ? result.events : [];
    let firstPrompt = null;
    let model = session.model ?? row.model ?? null;
    let truncated = false;
    let lastEventAt = run.lastEventAt ?? run.startedAt ?? now;
    const wasTerminal = TERMINAL_RUN_STATUSES.includes(run.status);
    if (events.length && wasTerminal && live) {
      recorder.update(run.id, {
        status: "running",
        endedAt: null,
        activity: null,
      });
      this.#reviveTask(run, now);
      recorder.record(run.id, {
        kind: "status",
        provenance: "system",
        summary: "Session resumed after it had ended",
        timestamp: now,
      });
      changed = true;
    }
    // One transaction per session instead of one autocommit (and fsync)
    // per event; the loop itself is synchronous.
    transaction(this.db, () => {
      for (const raw of events) {
        if (!raw || !raw.kind) continue;
        const event = {
          ...raw,
          provider: raw.provider ?? session.provider,
          sessionId: raw.sessionId ?? String(session.sessionId),
          provenance: raw.provenance ?? "provider",
        };
        const stored = recorder.applyEvent(run.id, event);
        if (!stored) continue;
        applied++;
        if (event.model) model = event.model;
        if (!firstPrompt && event.kind === "prompt")
          firstPrompt = String(event.data?.text ?? event.summary ?? "").trim();
        if (
          typeof stored.timestamp === "number" &&
          stored.timestamp > lastEventAt
        )
          lastEventAt = stored.timestamp;
        if (applied >= this.maxEventsPerSessionPerPoll) {
          truncated = true;
          break;
        }
      }
    });
    const nextOffset = truncated
      ? offset
      : typeof result.offset === "number"
        ? result.offset
        : offset;
    const nextCursor =
      !truncated &&
      result.cursor &&
      typeof result.cursor === "object" &&
      !Array.isArray(result.cursor)
        ? result.cursor
        : previousCursor;

    // Title from the first prompt when the provider gave none.
    let title = row.title ?? null;
    if (!title && (session.title || firstPrompt)) {
      title = String(session.title || firstPrompt).slice(0, 80);
      recorder.update(run.id, { title });
      if (!session.title && firstPrompt) {
        this.db
          .prepare("UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?")
          .run(title, now, run.taskId);
      }
      changed = true;
    }

    run = recorder.get(run.id);
    // `result.ended` is reserved for a provider signal (a `result` /
    // `session.end` record, or a registered process that is gone); anything
    // else is inferred from inactivity and labelled as such.
    const providerEnded = result.ended === true;
    const ended =
      providerEnded ||
      (!live && now - (run.lastEventAt ?? lastEventAt) > this.endAfterMs);
    if (ended && !TERMINAL_RUN_STATUSES.includes(run.status)) {
      recorder.setStatus(run.id, "completed", {
        summary: providerEnded
          ? "Session ended (reported by the provider)"
          : `Session ended (inferred: no live process and no activity for ${Math.round(this.endAfterMs / 60000)} min)`,
      });
      changed = true;
    } else if (
      !ended &&
      applied === 0 &&
      run.status === "running" &&
      now - (run.lastEventAt ?? lastEventAt) > this.staleAfter()
    ) {
      recorder.setStatus(run.id, "stale");
      changed = true;
    }
    if (applied > 0 && run.status === "stale") {
      // applyEvent already flips stale → running; keep the row consistent.
      changed = true;
    }
    if (applied > 0) {
      try {
        this.services.connections?.markEvent?.(session.provider, lastEventAt);
      } catch {
        /* optional */
      }
    }

    const nowLive = live && !ended;
    if ((row.live === 1) !== nowLive) changed = true;
    this.#updateRow(id, {
      cwd: session.cwd ?? row.cwd,
      title: title ?? row.title,
      sourcePath: session.sourcePath ?? row.source_path,
      sourceOffset: nextOffset,
      updatedAt: Math.max(updatedAt, lastEventAt),
      endedAt: ended ? (row.ended_at ?? now) : null,
      live: nowLive,
      model,
      metadata: {
        entrypoint: session.entrypoint ?? null,
        gitBranch: session.gitBranch ?? null,
        pid: session.pid ?? null,
        lastEventAt,
        ...(nextCursor ? { cursor: nextCursor } : {}),
      },
    });
    return { applied, changed };
  }

  /** All observed sessions, newest first; `live` filters to live ones. */
  sessions({ live, limit = 200 } = {}) {
    const clauses = [];
    if (live === true) clauses.push("s.live = 1 AND s.ended_at IS NULL");
    if (live === false) clauses.push("(s.live = 0 OR s.ended_at IS NOT NULL)");
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(
        `${SESSION_SELECT}${where} ORDER BY s.live DESC, s.updated_at DESC LIMIT ?`,
      )
      .all(limit)
      .map(rowToSession);
  }

  liveSessions() {
    return this.sessions({ live: true });
  }

  session(id) {
    const row = this.db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id);
    if (!row) throw new InputError("Observed session not found", 404);
    const session = rowToSession(row);
    let run = null;
    try {
      run = session.runId ? this.recorder.get(session.runId) : null;
    } catch {
      run = null;
    }
    return { ...session, run };
  }

  /**
   * Re-maps an observed session to another workspace: the current run is
   * closed with an explanatory event and a fresh run starts in the target.
   */
  attach(id, workspaceId) {
    const row = this.#row(id);
    if (!row) throw new InputError("Observed session not found", 404);
    if (typeof workspaceId !== "string" || !workspaceId.trim())
      throw new InputError("workspaceId is required");
    if (workspaceId === DEMO_WORKSPACE_ID)
      throw new InputError(
        "Observed sessions cannot be attached to the demo workspace",
        409,
      );
    const target = this.hub.get(workspaceId);
    if (target.record.archivedAt)
      throw new InputError("Restore the workspace before attaching", 409);
    if (row.workspace_id === workspaceId) return this.session(id);
    const recorder = this.recorder;
    const now = this.now();
    const session = {
      provider: row.provider,
      sessionId: row.session_id,
      cwd: row.cwd,
      title: row.title,
      sourcePath: row.source_path,
      startedAt: row.started_at ?? now,
      updatedAt: row.updated_at ?? now,
    };
    let oldRun = null;
    try {
      oldRun = row.run_id ? recorder.get(row.run_id) : null;
    } catch {
      oldRun = null;
    }
    if (!oldRun)
      oldRun = recorder.find({
        provider: row.provider,
        providerSessionId: row.session_id,
      });
    if (oldRun) {
      // Release the unique (provider, session) slot before creating the new run.
      recorder.update(oldRun.id, { providerSessionId: null });
      if (!TERMINAL_RUN_STATUSES.includes(oldRun.status)) {
        recorder.setStatus(oldRun.id, "cancelled", {
          summary: `Session moved to workspace “${target.record.name}”; this run is closed here`,
          mirrorTask: false,
        });
      }
      try {
        const task = this.hub.get(oldRun.workspaceId).store.get(oldRun.taskId);
        if (task.status !== "COMPLETED")
          this.db
            .prepare(
              "UPDATE tasks SET status = 'COMPLETED', progress = 100, completed_at = ?, updated_at = ? WHERE id = ?",
            )
            .run(now, now, task.id);
        this.hub
          .get(oldRun.workspaceId)
          .changed(
            `Observed session moved to “${target.record.name}”`,
            "system",
            oldRun.agentId,
            oldRun.id,
          );
      } catch {
        /* task already gone */
      }
    }
    const agent = ensureProviderAgent(this.services, workspaceId, row.provider);
    const run = this.#createRun(session, workspaceId, agent.id, row);
    recorder.record(run.id, {
      kind: "system",
      provenance: "user",
      summary: `Attached observed session to workspace “${target.record.name}”`,
      timestamp: now,
    });
    this.#updateRow(id, {
      workspaceId,
      agentId: run.agentId,
      runId: run.id,
      endedAt: null,
    });
    recorder.scheduleBroadcast(workspaceId, true);
    this.bus.emit("global");
    return this.session(id);
  }
}

export { sessionKey, rowToSession };
