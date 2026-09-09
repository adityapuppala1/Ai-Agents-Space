import { InputError } from "../TaskStore.js";

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Reads provider-reported token counts from the merged usage object. */
export function readTokens(usage = {}) {
  const u = usage ?? {};
  const nested = u.total_token_usage ?? u.totalTokenUsage ?? {};
  const input =
    num(u.input_tokens) ??
    num(u.inputTokens) ??
    num(nested.input_tokens) ??
    num(u.input) ??
    null;
  const output =
    num(u.output_tokens) ??
    num(u.outputTokens) ??
    num(nested.output_tokens) ??
    num(u.output) ??
    null;
  return { input, output, reported: input !== null || output !== null };
}

/** Reads provider-reported cost; never derives it from tokens here. */
export function readCost(cost = {}, usage = {}) {
  const c = cost ?? {};
  const value =
    num(c.total_usd) ??
    num(c.totalUsd) ??
    num(c.usd) ??
    num(c.value) ??
    num(usage?.total_cost_usd) ??
    num(usage?.totalCostUsd) ??
    null;
  return { value, reported: value !== null };
}

/** Flat export row shape (one row per run). */
export const ROW_COLUMNS = [
  "runId",
  "workspaceId",
  "taskId",
  "taskTitle",
  "provider",
  "mode",
  "model",
  "modelReported",
  "status",
  "attempt",
  "startedAt",
  "endedAt",
  "durationMs",
  "executingMs",
  "waitingApprovalMs",
  "blockedMs",
  "queuedMs",
  "reviewingMs",
  "inputTokens",
  "outputTokens",
  "usageReported",
  "costUsd",
  "costReported",
  "costEstimatedUsd",
  "artifacts",
  "reviewStatus",
  "error",
];

const STATUS_MESSAGE =
  /^Run (queued|running|blocked|waiting_approval|stale|disconnected|failed|cancelled|completed)\b/;

function stateFromEvent(event) {
  if (event.kind === "approval.request") return "waiting_approval";
  if (event.kind === "approval.decision") return "running";
  if (event.kind === "complete") return "ended";
  // Only run-lifecycle events carry a run status in `data.status`; provider
  // tool payloads (Codex item status "completed") must not end the timeline.
  const status = event.data?.status;
  if (typeof status === "string" && event.provenance === "system")
    return status === "completed" ? "ended" : status;
  if (event.kind === "status" || event.kind === "error") {
    if (/marked stale/i.test(event.message)) return "stale";
    const match = STATUS_MESSAGE.exec(event.message ?? "");
    if (match)
      return ["failed", "cancelled", "completed"].includes(match[1])
        ? "ended"
        : match[1];
  }
  if (event.provenance === "provider") return "running";
  return null;
}

/** Merges intervals and returns the total covered milliseconds. */
export function unionMs(intervals) {
  const sorted = intervals
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let current = null;
  for (const [start, end] of sorted) {
    if (!current || start > current[1]) {
      if (current) total += current[1] - current[0];
      current = [start, end];
    } else if (end > current[1]) current[1] = end;
  }
  if (current) total += current[1] - current[0];
  return total;
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text =
    typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows, columns = Object.keys(rows[0] ?? {})) {
  if (!columns.length) return "";
  const lines = [columns.join(",")];
  for (const row of rows)
    lines.push(columns.map((column) => csvEscape(row[column])).join(","));
  return lines.join("\r\n") + "\r\n";
}

/**
 * Read-only analytics over runs, events, tasks, artifacts, and approvals.
 * Every number is either provider-reported or labelled as derived/estimate.
 *
 * Constructor: `new Analytics(services, { now = Date.now, pricing = null })`.
 * `pricing` = { [model]: { inputUsdPerMillion, outputUsdPerMillion } };
 * without it cost is never estimated from tokens.
 */
export class Analytics {
  constructor(services, { now = Date.now, pricing = null } = {}) {
    this.services = services;
    this.db = services.db;
    this.now = now;
    this.pricing = pricing;
  }

  #scope(workspaceId, since) {
    const clauses = [];
    const params = [];
    if (workspaceId) {
      if (!this.services.hub.has(workspaceId))
        throw new InputError("Workspace not found", 404);
      clauses.push("workspace_id = ?");
      params.push(workspaceId);
    }
    return { clauses, params, since: Number(since) || 0 };
  }

  #load({ workspaceId = null, since = 0 } = {}) {
    const scope = this.#scope(workspaceId, since);
    const where = (extra) =>
      [...scope.clauses, extra].filter(Boolean).length
        ? `WHERE ${[...scope.clauses, extra].filter(Boolean).join(" AND ")}`
        : "";
    const tasks = this.db
      .prepare(`SELECT * FROM tasks ${where("created_at >= ?")}`)
      .all(...scope.params, scope.since);
    const runs = this.db
      .prepare(`SELECT * FROM runs ${where("started_at >= ?")}`)
      .all(...scope.params, scope.since);
    const runIds = new Set(runs.map((run) => run.id));
    const events = this.db
      .prepare(
        `SELECT id, run_id, task_id, kind, message, timestamp, provenance, data, sequence FROM events ${where("timestamp >= ?")} ORDER BY sequence ASC`,
      )
      .all(...scope.params, scope.since)
      .map((row) => ({ ...row, data: parseJson(row.data, {}) }));
    const artifactRows = this.db
      .prepare(`SELECT run_id, COUNT(*) AS n FROM artifacts GROUP BY run_id`)
      .all();
    const artifacts = new Map(
      artifactRows
        .filter((row) => runIds.has(row.run_id))
        .map((row) => [row.run_id, row.n]),
    );
    return { tasks, runs, events, artifacts, runIds };
  }

  /** Reconstructs per-run state intervals from the event stream. */
  #timeline(run, events, now) {
    const start = run.started_at;
    const end = run.ended_at ?? now;
    const spans = {
      queued: 0,
      running: 0,
      waiting_approval: 0,
      blocked: 0,
      stale: 0,
    };
    const runningIntervals = [];
    let state = "running";
    let cursor = start;
    const sorted = events
      .filter((event) => event.timestamp >= start)
      .sort((a, b) => a.sequence - b.sequence);
    let sawRunningTransition = false;
    let staleEvents = 0;
    let firstProviderEventAt = null;
    for (const event of sorted) {
      if (event.provenance === "provider" && firstProviderEventAt === null)
        firstProviderEventAt = event.timestamp;
      const next = stateFromEvent(event);
      if (!next) continue;
      if (next === "stale") staleEvents++;
      const at = Math.min(Math.max(event.timestamp, cursor), end);
      if (state in spans) spans[state] += at - cursor;
      if (state === "running") runningIntervals.push([cursor, at]);
      cursor = at;
      if (next === "ended") {
        state = "ended";
        break;
      }
      if (
        next === "running" &&
        !sawRunningTransition &&
        event.kind !== "approval.decision" &&
        event.provenance !== "provider"
      ) {
        // Explicit "Run running" after creation means the run began queued.
        sawRunningTransition = true;
        spans.queued += spans.running;
        runningIntervals.length = 0;
        spans.running = 0;
      }
      state = next;
    }
    if (state !== "ended" && end > cursor) {
      if (state in spans) spans[state] += end - cursor;
      if (state === "running") runningIntervals.push([cursor, end]);
    }
    return { spans, runningIntervals, staleEvents, firstProviderEventAt };
  }

  summary({ workspaceId = null, since = 0 } = {}) {
    const now = this.now();
    const { tasks, runs, events, artifacts } = this.#load({
      workspaceId,
      since,
    });
    const eventsByRun = new Map();
    for (const event of events) {
      if (!event.run_id) continue;
      if (!eventsByRun.has(event.run_id)) eventsByRun.set(event.run_id, []);
      eventsByRun.get(event.run_id).push(event);
    }
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const allTaskRows = new Map(
      this.db
        .prepare(
          "SELECT id, title, status, review, updated_at, completed_at, created_at, started_at FROM tasks",
        )
        .all()
        .map((row) => [row.id, row]),
    );

    const time = {
      queuedMs: 0,
      executingMs: 0,
      waitingApprovalMs: 0,
      blockedMs: 0,
      staleMs: 0,
      reviewingMs: 0,
    };
    const allRunning = [];
    const reliability = {
      disconnects: 0,
      cancellations: 0,
      staleEvents: 0,
      retries: 0,
      retryReasons: {},
    };
    const funnel = {
      created: tasks.length,
      dispatched: runs.length,
      started: 0,
      artifact: 0,
      reviewed: 0,
      accepted: 0,
    };
    const groups = {
      provider: new Map(),
      model: new Map(),
      workspace: new Map(),
    };
    const dataQuality = {
      usageMissingRuns: 0,
      modelUnknownRuns: 0,
      runsWithoutEvents: 0,
    };
    const rows = [];

    for (const run of runs) {
      const runEvents = eventsByRun.get(run.id) ?? [];
      if (!runEvents.length) dataQuality.runsWithoutEvents++;
      const { spans, runningIntervals, staleEvents, firstProviderEventAt } =
        this.#timeline(run, runEvents, now);
      time.queuedMs += spans.queued;
      time.executingMs += spans.running;
      time.waitingApprovalMs += spans.waiting_approval;
      time.blockedMs += spans.blocked;
      time.staleMs += spans.stale;
      allRunning.push(...runningIntervals);
      reliability.staleEvents += staleEvents;
      if (run.status === "disconnected") reliability.disconnects++;
      if (run.status === "cancelled") reliability.cancellations++;
      if ((run.attempt ?? 1) > 1 || run.parent_run_id) {
        reliability.retries++;
        const parent = run.parent_run_id
          ? this.db
              .prepare("SELECT error, status FROM runs WHERE id = ?")
              .get(run.parent_run_id)
          : null;
        const reason = parent?.error ?? parent?.status ?? "unknown";
        reliability.retryReasons[reason] =
          (reliability.retryReasons[reason] ?? 0) + 1;
      }
      if (firstProviderEventAt !== null) funnel.started++;
      const artifactCount = artifacts.get(run.id) ?? 0;
      if (artifactCount > 0) funnel.artifact++;
      const task = taskById.get(run.task_id) ?? allTaskRows.get(run.task_id);
      const review = parseJson(task?.review, {});
      let reviewingMs = 0;
      if (review.runId === run.id) {
        if (review.status === "accepted" || review.status === "rejected") {
          funnel.reviewed++;
          if (review.status === "accepted") funnel.accepted++;
          const decidedAt =
            num(review.decidedAt) ??
            task?.updated_at ??
            task?.completed_at ??
            run.ended_at;
          reviewingMs = Math.max(
            0,
            (decidedAt ?? 0) - (run.ended_at ?? decidedAt ?? 0),
          );
        } else if (review.status === "pending" && run.ended_at) {
          reviewingMs = Math.max(0, now - run.ended_at);
        }
      }
      time.reviewingMs += reviewingMs;

      const usage = parseJson(run.usage, {});
      const cost = parseJson(run.cost, {});
      const tokens = readTokens(usage);
      const reportedCost = readCost(cost, usage);
      if (!tokens.reported) dataQuality.usageMissingRuns++;
      if (!run.actual_model) dataQuality.modelUnknownRuns++;
      const model = run.actual_model ?? "unknown";
      const estimate = this.#estimateCost(model, tokens);

      const bump = (map, key, extra = {}) => {
        if (!map.has(key))
          map.set(key, {
            ...extra,
            runs: 0,
            completed: 0,
            failed: 0,
            cancelled: 0,
            disconnected: 0,
            retries: 0,
            tokens: { input: 0, output: 0, reported: false },
            costUsd: { value: null, reported: false, estimated: false },
            _estimated: 0,
            _hasEstimate: false,
          });
        const group = map.get(key);
        group.runs++;
        if (run.status in group && typeof group[run.status] === "number")
          group[run.status]++;
        if ((run.attempt ?? 1) > 1 || run.parent_run_id) group.retries++;
        if (tokens.reported) {
          group.tokens.reported = true;
          group.tokens.input += tokens.input ?? 0;
          group.tokens.output += tokens.output ?? 0;
        }
        if (reportedCost.reported) {
          group.costUsd.reported = true;
          group.costUsd.value = (group.costUsd.value ?? 0) + reportedCost.value;
        }
        if (estimate !== null) {
          group._hasEstimate = true;
          group._estimated += estimate;
        }
      };
      bump(groups.provider, run.provider, { provider: run.provider });
      bump(groups.model, model, { model, reported: model !== "unknown" });
      bump(groups.workspace, run.workspace_id, {
        workspaceId: run.workspace_id,
      });

      rows.push({
        runId: run.id,
        workspaceId: run.workspace_id,
        taskId: run.task_id,
        taskTitle: task?.title ?? null,
        provider: run.provider,
        mode: run.mode,
        model: run.actual_model ?? null,
        modelReported: !!run.actual_model,
        status: run.status,
        attempt: run.attempt ?? 1,
        startedAt: run.started_at,
        endedAt: run.ended_at ?? null,
        durationMs: (run.ended_at ?? now) - run.started_at,
        executingMs: spans.running,
        waitingApprovalMs: spans.waiting_approval,
        blockedMs: spans.blocked,
        queuedMs: spans.queued,
        reviewingMs,
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        usageReported: tokens.reported,
        costUsd: reportedCost.value,
        costReported: reportedCost.reported,
        costEstimatedUsd: estimate,
        artifacts: artifactCount,
        reviewStatus: review.runId === run.id ? (review.status ?? null) : null,
        error: run.error ?? null,
      });
    }

    const finalize = (map) =>
      [...map.values()].map((group) => {
        const { _estimated, _hasEstimate, ...rest } = group;
        if (!rest.costUsd.reported && _hasEstimate)
          rest.costUsd = {
            value: _estimated,
            reported: false,
            estimated: true,
            basis: "pricing table supplied by caller",
          };
        return rest;
      });

    // Task-level queued time (created → started) is independent of run events.
    let taskQueuedMs = 0;
    for (const task of tasks) {
      if (task.started_at)
        taskQueuedMs += Math.max(0, task.started_at - task.created_at);
    }

    return {
      generatedAt: now,
      scope: { workspaceId, since: Number(since) || 0 },
      units: {
        created: "tasks",
        dispatched: "runs",
        started: "runs",
        artifact: "runs",
        reviewed: "runs",
        accepted: "runs",
      },
      funnel,
      time: {
        ...time,
        taskQueuedMs,
        wallClock: {
          executingMs: unionMs(allRunning),
          spanMs: runs.length
            ? Math.max(...runs.map((run) => run.ended_at ?? now)) -
              Math.min(...runs.map((run) => run.started_at))
            : 0,
        },
        note: "Sums add every run; wallClock merges overlapping runs. Derived from recorded events, not provider-reported.",
      },
      byProvider: finalize(groups.provider),
      byModel: finalize(groups.model),
      byWorkspace: finalize(groups.workspace),
      reliability,
      blockedHeatmap: this.#blockedHeatmap(tasks, events, now),
      dataQuality,
      rows,
    };
  }

  #estimateCost(model, tokens) {
    if (!this.pricing || !tokens.reported) return null;
    const price = this.pricing[model];
    if (!price) return null;
    const input =
      ((tokens.input ?? 0) / 1e6) * (num(price.inputUsdPerMillion) ?? 0);
    const output =
      ((tokens.output ?? 0) / 1e6) * (num(price.outputUsdPerMillion) ?? 0);
    return Math.round((input + output) * 1e6) / 1e6;
  }

  /** Blocked intervals per task, bucketed by hour of day of the block start. */
  #blockedHeatmap(tasks, events, now) {
    const runTask = new Map(
      this.db
        .prepare("SELECT id, task_id FROM runs")
        .all()
        .map((row) => [row.id, row.task_id]),
    );
    const byTask = new Map();
    for (const event of events) {
      const taskId = event.task_id ?? runTask.get(event.run_id) ?? null;
      if (!taskId) continue;
      if (!byTask.has(taskId)) byTask.set(taskId, []);
      byTask.get(taskId).push(event);
    }
    const isBlockStart = (event) =>
      /^Paused /.test(event.message) ||
      (event.kind === "error" &&
        /^Run (failed|cancelled|disconnected)/.test(event.message)) ||
      event.data?.status === "blocked";
    const cells = new Map();
    for (const task of tasks) {
      const list = (byTask.get(task.id) ?? []).sort(
        (a, b) => a.sequence - b.sequence,
      );
      let start = null;
      for (const event of list) {
        if (isBlockStart(event)) {
          if (start === null) start = event.timestamp;
        } else if (start !== null && event.timestamp > start) {
          add(task, start, event.timestamp);
          start = null;
        }
      }
      if (start !== null && task.status === "BLOCKED") add(task, start, now);
    }
    function add(task, from, to) {
      if (to <= from) return;
      const hour = new Date(from).getHours();
      const key = `${task.id}:${hour}`;
      if (!cells.has(key))
        cells.set(key, {
          taskId: task.id,
          title: task.title,
          hour,
          blockedMs: 0,
        });
      cells.get(key).blockedMs += to - from;
    }
    return [...cells.values()].sort((a, b) => b.blockedMs - a.blockedMs);
  }

  export(format = "json", opts = {}) {
    if (!["csv", "json"].includes(format))
      throw new InputError("format must be csv or json");
    const summary = this.summary(opts);
    const rows = summary.rows;
    if (format === "csv")
      return {
        contentType: "text/csv; charset=utf-8",
        body: toCsv(rows, ROW_COLUMNS),
        rows: rows.length,
      };
    return {
      contentType: "application/json",
      body: JSON.stringify(
        { generatedAt: summary.generatedAt, scope: summary.scope, rows },
        null,
        2,
      ),
      rows: rows.length,
    };
  }
}
