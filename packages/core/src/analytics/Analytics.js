import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { InputError } from "../TaskStore.js";
import { DEFAULT_POLICY } from "../contracts.js";
import { Pricing, readTokens, readCost } from "./pricing.js";

export { readTokens, readCost };

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

/**
 * Parses a range bound. Accepts epoch milliseconds (number or digit string)
 * and ISO date/time strings ("2026-09-01", "2026-09-01T10:00:00Z").
 * Anything unparseable is 0, which means "all time".
 *
 * This is the fix for the range-chip bug: `Number("2026-09-01")` is NaN, and
 * the old `Number(x) || 0` turned every ISO range start into "all time".
 */
export function parseRange(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number")
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  }
  const text = String(value).trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) {
    const ms = Number(text);
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
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
  "waitingForProviderMs",
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
  "workflowId",
  "reviewStatus",
  "error",
];

const STATUS_MESSAGE =
  /^Run (queued|running|blocked|waiting_approval|stale|disconnected|failed|cancelled|completed)\b/;

/** Retry classification events written by RunWorker (see runs/retry.js). */
const CLASSIFICATION_MESSAGE = /^Failure classified as/;

const TOOL_START_KINDS = new Set(["tool.start", "command", "test"]);

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

/** Merges intervals into a normalized, sorted, non-overlapping list. */
export function mergeIntervals(intervals) {
  const sorted = intervals
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (!last || start > last[1]) out.push([start, end]);
    else if (end > last[1]) last[1] = end;
  }
  return out;
}

/** `a` minus `b`: the parts of a not covered by any interval of b. */
export function subtractIntervals(a, b) {
  const cuts = mergeIntervals(b);
  const out = [];
  for (const [start, end] of mergeIntervals(a)) {
    let from = start;
    for (const [cutStart, cutEnd] of cuts) {
      if (cutEnd <= from) continue;
      if (cutStart >= end) break;
      if (cutStart > from) out.push([from, Math.min(cutStart, end)]);
      from = Math.max(from, cutEnd);
      if (from >= end) break;
    }
    if (from < end) out.push([from, end]);
  }
  return out;
}

/** Empirical quantile (linear interpolation) of a sorted numeric sample. */
export function quantile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function dayKey(ms) {
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
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

/** How many comparable completed runs a forecast needs before it speaks. */
export const FORECAST_MINIMUM_SAMPLES = 5;

export const FORECAST_METRICS = [
  "durationMs",
  "costUsd",
  "inputTokens",
  "outputTokens",
  "tokens",
];

export const REPORT_CADENCES = Object.freeze({
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
});

/**
 * Read-only analytics over runs, events, tasks, artifacts, and approvals,
 * plus the two pieces of stored state it owns: saved views and scheduled
 * reports.
 *
 * Every number is either provider-reported or labelled as derived/estimate.
 *
 * Constructor: `new Analytics(services, { now = Date.now, pricing = null })`.
 * `pricing` is an explicit table (see analytics/pricing.js); without one the
 * settings key `pricing` is used, and without that cost is never estimated.
 */
export class Analytics {
  constructor(services, { now = Date.now, pricing = null } = {}) {
    this.services = services;
    this.db = services.db;
    this.now = now;
    this.pricing = pricing;
    this.pricingService = new Pricing(services, { table: pricing, now });
    this.reportTimer = null;
    this.views = {
      list: (opts) => this.listViews(opts),
      get: (id) => this.getView(id),
      create: (input) => this.createView(input),
      update: (id, patch) => this.updateView(id, patch),
      remove: (id) => this.deleteView(id),
    };
    this.reports = {
      list: () => this.listReports(),
      get: (id) => this.getReport(id),
      create: (input) => this.createReport(input),
      update: (id, patch) => this.updateReport(id, patch),
      remove: (id) => this.deleteReport(id),
      run: (id) => this.runReport(id),
      runDue: (at) => this.runDueReports(at),
      start: (opts) => this.startReportTimer(opts),
      stop: () => this.stopReportTimer(),
    };
    services.onClose?.(() => this.stopReportTimer());
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
    return { clauses, params, since: parseRange(since) };
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
        `SELECT id, run_id, task_id, kind, message, timestamp, provenance, data, sequence, tool, file FROM events ${where("timestamp >= ?")} ORDER BY sequence ASC`,
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
    // Provider-wait bookkeeping: a tool.start / command / test opens a wait
    // that its matching tool.end closes. An unmatched start closes at the
    // run's last recorded event. Human waits are subtracted afterwards.
    const toolIntervals = [];
    const approvalIntervals = [];
    const classifications = [];
    let pendingTools = [];
    let approvalAt = null;
    let lastEventAt = start;
    const clamp = (value) => Math.min(Math.max(value, start), end);
    for (const event of sorted) {
      const at = clamp(event.timestamp);
      lastEventAt = Math.max(lastEventAt, at);
      if (TOOL_START_KINDS.has(event.kind))
        pendingTools.push({ tool: event.tool ?? null, at });
      else if (event.kind === "tool.end" && pendingTools.length) {
        let index = pendingTools.findLastIndex(
          (pending) => pending.tool && pending.tool === event.tool,
        );
        if (index < 0) index = pendingTools.length - 1;
        const [pending] = pendingTools.splice(index, 1);
        toolIntervals.push([pending.at, at]);
      }
      if (event.kind === "approval.request") approvalAt = at;
      else if (event.kind === "approval.decision" && approvalAt !== null) {
        approvalIntervals.push([approvalAt, at]);
        approvalAt = null;
      }
      if (
        event.kind === "status" &&
        CLASSIFICATION_MESSAGE.test(event.message ?? "") &&
        typeof event.data?.class === "string"
      )
        classifications.push(event.data.class);
      if (event.provenance === "provider" && firstProviderEventAt === null)
        firstProviderEventAt = event.timestamp;
      const next = stateFromEvent(event);
      if (!next) continue;
      if (next === "stale") staleEvents++;
      const stateAt = Math.min(Math.max(event.timestamp, cursor), end);
      if (state in spans) spans[state] += stateAt - cursor;
      if (state === "running") runningIntervals.push([cursor, stateAt]);
      cursor = stateAt;
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
    for (const pending of pendingTools)
      toolIntervals.push([pending.at, Math.max(pending.at, lastEventAt)]);
    pendingTools = [];
    if (approvalAt !== null) approvalIntervals.push([approvalAt, end]);
    const waitingForProviderMs = unionMs(
      subtractIntervals(toolIntervals, approvalIntervals),
    );
    return {
      spans,
      runningIntervals,
      staleEvents,
      firstProviderEventAt,
      waitingForProviderMs,
      waitingForHumanMs: unionMs(approvalIntervals),
      classifications,
    };
  }

  /** The workspace concurrency limit that saturation is measured against. */
  #concurrencyLimit(workspaceId) {
    try {
      const policy = this.services.policy?.forWorkspace?.(workspaceId);
      const limit = num(policy?.maxConcurrentRuns);
      if (limit !== null) return limit;
    } catch {
      /* fall through to the default */
    }
    return DEFAULT_POLICY.maxConcurrentRuns;
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
          "SELECT id, title, status, review, updated_at, completed_at, created_at, started_at, workflow_id FROM tasks",
        )
        .all()
        .map((row) => [row.id, row]),
    );

    const time = {
      queuedMs: 0,
      executingMs: 0,
      waitingApprovalMs: 0,
      waitingForProviderMs: 0,
      waitingForHumanMs: 0,
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
      retryClassifications: {},
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
      workflow: new Map(),
      acceptedResult: new Map(),
    };
    const dataQuality = {
      usageMissingRuns: 0,
      modelUnknownRuns: 0,
      runsWithoutEvents: 0,
    };
    const rows = [];
    const availabilityCells = new Map();
    const workloadCells = new Map();
    let cancelRequested = 0;
    let cancelAcknowledged = 0;

    for (const run of runs) {
      const runEvents = eventsByRun.get(run.id) ?? [];
      if (!runEvents.length) dataQuality.runsWithoutEvents++;
      const {
        spans,
        runningIntervals,
        staleEvents,
        firstProviderEventAt,
        waitingForProviderMs,
        waitingForHumanMs,
        classifications,
      } = this.#timeline(run, runEvents, now);
      time.queuedMs += spans.queued;
      time.executingMs += spans.running;
      time.waitingApprovalMs += spans.waiting_approval;
      time.waitingForProviderMs += waitingForProviderMs;
      time.waitingForHumanMs += waitingForHumanMs;
      time.blockedMs += spans.blocked;
      time.staleMs += spans.stale;
      allRunning.push(...runningIntervals);
      reliability.staleEvents += staleEvents;
      for (const name of classifications)
        reliability.retryClassifications[name] =
          (reliability.retryClassifications[name] ?? 0) + 1;
      if (run.status === "disconnected") reliability.disconnects++;
      if (run.status === "cancelled") {
        reliability.cancellations++;
        cancelRequested++;
        if (run.ended_at !== null && run.ended_at !== undefined)
          cancelAcknowledged++;
      }
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
      const reviewOfThisRun = review.runId === run.id ? review : null;
      let reviewingMs = 0;
      if (reviewOfThisRun) {
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
      const workflowId = task?.workflow_id ?? null;
      const acceptedKey = reviewOfThisRun
        ? (review.status ?? "pending")
        : "not-reviewed";

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
      bump(groups.workflow, workflowId ?? "none", {
        workflowId,
        reported: workflowId !== null,
      });
      bump(groups.acceptedResult, acceptedKey, { reviewStatus: acceptedKey });

      // Availability and workload cells (per provider per day / per hour).
      const day = dayKey(run.started_at);
      const availabilityKey = `${run.provider} ${day}`;
      if (!availabilityCells.has(availabilityKey))
        availabilityCells.set(availabilityKey, {
          provider: run.provider,
          day,
          attempts: 0,
          successes: 0,
          disconnects: 0,
          cancellations: 0,
          runIds: [],
        });
      const availabilityCell = availabilityCells.get(availabilityKey);
      availabilityCell.attempts++;
      if (run.status === "completed") availabilityCell.successes++;
      if (run.status === "disconnected") availabilityCell.disconnects++;
      if (run.status === "cancelled") availabilityCell.cancellations++;
      availabilityCell.runIds.push(run.id);

      const hour = new Date(run.started_at).getHours();
      const workloadKey = `${run.provider} ${hour}`;
      if (!workloadCells.has(workloadKey))
        workloadCells.set(workloadKey, {
          provider: run.provider,
          hour,
          runs: 0,
          executingMs: 0,
          runIds: [],
          taskIds: [],
        });
      const workloadCell = workloadCells.get(workloadKey);
      workloadCell.runs++;
      workloadCell.executingMs += spans.running;
      workloadCell.runIds.push(run.id);
      if (run.task_id && !workloadCell.taskIds.includes(run.task_id))
        workloadCell.taskIds.push(run.task_id);

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
        waitingForProviderMs,
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
        workflowId,
        reviewStatus: reviewOfThisRun ? (review.status ?? null) : null,
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

    const availability = [...availabilityCells.values()]
      .map((cell) => ({
        ...cell,
        availability: cell.attempts ? cell.successes / cell.attempts : null,
      }))
      .sort((a, b) =>
        a.day === b.day
          ? a.provider.localeCompare(b.provider)
          : a.day.localeCompare(b.day),
      );
    const availabilityByProvider = new Map();
    for (const cell of availability) {
      if (!availabilityByProvider.has(cell.provider))
        availabilityByProvider.set(cell.provider, {
          provider: cell.provider,
          attempts: 0,
          successes: 0,
          disconnects: 0,
          days: 0,
        });
      const total = availabilityByProvider.get(cell.provider);
      total.attempts += cell.attempts;
      total.successes += cell.successes;
      total.disconnects += cell.disconnects;
      total.days++;
    }
    reliability.availability = {
      basis:
        "successful runs ÷ attempted runs, per provider per calendar day (local time). Null when there were no attempts.",
      byProviderDay: availability,
      byProvider: [...availabilityByProvider.values()].map((total) => ({
        ...total,
        availability: total.attempts ? total.successes / total.attempts : null,
        disconnectFrequency: total.attempts
          ? total.disconnects / total.attempts
          : null,
      })),
    };
    reliability.disconnectFrequency = {
      disconnects: reliability.disconnects,
      runs: runs.length,
      perRun: runs.length ? reliability.disconnects / runs.length : null,
    };
    reliability.cancellationAcknowledgement = {
      requested: cancelRequested,
      acknowledged: cancelAcknowledged,
      rate: cancelRequested ? cancelAcknowledged / cancelRequested : null,
      basis:
        "a cancellation is acknowledged when the run actually reached a terminal state with an end time. Interrupting does not undo side effects.",
    };
    reliability.saturation = this.#saturation(runs, now);

    return {
      generatedAt: now,
      scope: { workspaceId, since: parseRange(since) },
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
        waitingNote:
          "waitingForProviderMs is the recorded gap between a tool/command start and its end, with human approval waits removed. waitingForHumanMs is approval.request → approval.decision.",
      },
      byProvider: finalize(groups.provider),
      byModel: finalize(groups.model),
      byWorkspace: finalize(groups.workspace),
      byWorkflow: finalize(groups.workflow),
      byAcceptedResult: finalize(groups.acceptedResult),
      reliability,
      blockedHeatmap: this.#blockedHeatmap(tasks, events, now),
      workloadHeatmap: [...workloadCells.values()].sort(
        (a, b) => b.runs - a.runs || a.hour - b.hour,
      ),
      criticalPaths: this.#criticalPaths(workspaceId, runs, tasks),
      dataQuality,
      rows,
    };
  }

  #estimateCost(model, tokens) {
    if (!tokens.reported) return null;
    const estimate = this.pricingService.estimateCost(tokens, model);
    return estimate.estimated ? estimate.value : null;
  }

  /** Concurrent managed/observed runs against the workspace limit over time. */
  #saturation(runs, now) {
    const byWorkspace = new Map();
    for (const run of runs) {
      if (!byWorkspace.has(run.workspace_id))
        byWorkspace.set(run.workspace_id, []);
      byWorkspace.get(run.workspace_id).push(run);
    }
    const workspaces = [];
    for (const [workspaceId, list] of byWorkspace) {
      const limit = this.#concurrencyLimit(workspaceId);
      const points = [];
      for (const run of list) {
        const start = run.started_at;
        const end = Math.max(start, run.ended_at ?? now);
        points.push({ at: start, delta: 1, runId: run.id });
        points.push({ at: end, delta: -1, runId: run.id });
      }
      points.sort((a, b) => a.at - b.at || a.delta - b.delta);
      let concurrent = 0;
      let cursor = points.length ? points[0].at : 0;
      const active = new Set();
      let maxConcurrent = 0;
      let saturatedMs = 0;
      let weighted = 0;
      const windows = [];
      for (const point of points) {
        if (point.at > cursor) {
          const span = point.at - cursor;
          weighted += concurrent * span;
          if (limit > 0 && concurrent >= limit) {
            saturatedMs += span;
            if (windows.length < 50)
              windows.push({
                from: cursor,
                to: point.at,
                concurrent,
                limit,
                runIds: [...active],
              });
          }
          cursor = point.at;
        }
        concurrent += point.delta;
        if (point.delta > 0) active.add(point.runId);
        else active.delete(point.runId);
        maxConcurrent = Math.max(maxConcurrent, concurrent);
      }
      const spanMs = points.length
        ? points[points.length - 1].at - points[0].at
        : 0;
      workspaces.push({
        workspaceId,
        limit,
        maxConcurrent,
        saturatedMs,
        spanMs,
        averageConcurrent: spanMs > 0 ? weighted / spanMs : null,
        utilization: spanMs > 0 && limit > 0 ? weighted / spanMs / limit : null,
        atOrOverLimit: limit > 0 && maxConcurrent >= limit,
        windows,
      });
    }
    return {
      basis:
        "concurrent recorded runs versus policy.maxConcurrentRuns. Null where there is no measurable span or no limit.",
      byWorkspace: workspaces.sort((a, b) => b.saturatedMs - a.saturatedMs),
    };
  }

  /**
   * Longest dependency chain per workspace, with the blocked tasks on it
   * highlighted. Returns [] when the task graph module is not present.
   */
  #criticalPaths(workspaceId, runs, tasks) {
    const graph = this.services.graph;
    if (!graph?.graph) return [];
    const ids = workspaceId
      ? [workspaceId]
      : [
          ...new Set([
            ...runs.map((run) => run.workspace_id),
            ...tasks.map((task) => task.workspace_id),
          ]),
        ];
    const runsByTask = new Map();
    for (const run of runs) {
      if (!runsByTask.has(run.task_id)) runsByTask.set(run.task_id, []);
      runsByTask.get(run.task_id).push(run.id);
    }
    const out = [];
    for (const id of ids) {
      let result;
      try {
        result = graph.graph(id);
      } catch {
        continue;
      }
      const byId = new Map(result.nodes.map((node) => [node.id, node]));
      const path = (result.criticalPath ?? []).map((taskId) => {
        const node = byId.get(taskId);
        return {
          taskId,
          title: node?.title ?? null,
          status: node?.status ?? null,
          blocked: node?.status === "BLOCKED",
          runIds: runsByTask.get(taskId) ?? [],
        };
      });
      if (!path.length) continue;
      out.push({
        workspaceId: id,
        path,
        blockedTaskIds: path
          .filter((step) => step.blocked)
          .map((step) => step.taskId),
      });
    }
    return out;
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
      let startRunId = null;
      for (const event of list) {
        if (isBlockStart(event)) {
          if (start === null) {
            start = event.timestamp;
            startRunId = event.run_id ?? null;
          }
        } else if (start !== null && event.timestamp > start) {
          add(task, start, event.timestamp, [startRunId, event.run_id]);
          start = null;
          startRunId = null;
        }
      }
      if (start !== null && task.status === "BLOCKED")
        add(task, start, now, [startRunId]);
    }
    function add(task, from, to, runIds) {
      if (to <= from) return;
      const hour = new Date(from).getHours();
      const key = `${task.id}:${hour}`;
      if (!cells.has(key))
        cells.set(key, {
          taskId: task.id,
          title: task.title,
          hour,
          blockedMs: 0,
          taskIds: [task.id],
          runIds: [],
        });
      const cell = cells.get(key);
      cell.blockedMs += to - from;
      for (const runId of runIds)
        if (runId && !cell.runIds.includes(runId)) cell.runIds.push(runId);
    }
    return [...cells.values()].sort((a, b) => b.blockedMs - a.blockedMs);
  }

  // ------------------------------------------------------------- drill-down

  /**
   * The runs behind one heatmap cell or saturation window, so a chart can be
   * clicked through to the real records.
   */
  drillDown({ runIds = [], taskIds = [], limit = 200 } = {}) {
    const ids = [...new Set(runIds)].slice(0, limit);
    const tasks = [...new Set(taskIds)].slice(0, limit);
    const runs = ids.length
      ? this.db
          .prepare(
            `SELECT id, workspace_id, task_id, provider, mode, status, started_at, ended_at, actual_model, error
             FROM runs WHERE id IN (${ids.map(() => "?").join(",")})`,
          )
          .all(...ids)
      : [];
    const taskRows = tasks.length
      ? this.db
          .prepare(
            `SELECT id, workspace_id, title, status, workflow_id, review
             FROM tasks WHERE id IN (${tasks.map(() => "?").join(",")})`,
          )
          .all(...tasks)
      : [];
    return {
      runs: runs.map((run) => ({
        runId: run.id,
        workspaceId: run.workspace_id,
        taskId: run.task_id,
        provider: run.provider,
        mode: run.mode,
        status: run.status,
        startedAt: run.started_at,
        endedAt: run.ended_at ?? null,
        model: run.actual_model ?? null,
        error: run.error ?? null,
      })),
      tasks: taskRows.map((task) => ({
        taskId: task.id,
        workspaceId: task.workspace_id,
        title: task.title,
        status: task.status,
        workflowId: task.workflow_id ?? null,
        review: parseJson(task.review, {}),
      })),
    };
  }

  // --------------------------------------------------------------- forecast

  /**
   * A bounded forecast from empirical quantiles of comparable completed runs.
   * Fewer than FORECAST_MINIMUM_SAMPLES samples → { available: false, reason }.
   * Never a point promise: the caller always gets low/high and assumptions.
   */
  forecast({
    workspaceId = null,
    since = 0,
    provider = null,
    model = null,
    metric = "durationMs",
  } = {}) {
    if (!FORECAST_METRICS.includes(metric))
      throw new InputError(
        `metric must be one of ${FORECAST_METRICS.join(", ")}`,
      );
    const summary = this.summary({ workspaceId, since });
    const comparable = summary.rows.filter(
      (row) =>
        row.status === "completed" &&
        (!provider || row.provider === provider) &&
        (!model || row.model === model),
    );
    const valueOf = (row) => {
      if (metric === "durationMs") return num(row.durationMs);
      if (metric === "costUsd")
        return num(row.costUsd) ?? num(row.costEstimatedUsd);
      if (metric === "inputTokens") return num(row.inputTokens);
      if (metric === "outputTokens") return num(row.outputTokens);
      return num(row.inputTokens) !== null || num(row.outputTokens) !== null
        ? (num(row.inputTokens) ?? 0) + (num(row.outputTokens) ?? 0)
        : null;
    };
    const sample = comparable
      .map(valueOf)
      .filter((value) => value !== null)
      .sort((a, b) => a - b);
    const scope = {
      workspaceId,
      since: parseRange(since),
      provider,
      model,
      metric,
    };
    if (sample.length < FORECAST_MINIMUM_SAMPLES)
      return {
        available: false,
        scope,
        sampleSize: sample.length,
        minimumSamples: FORECAST_MINIMUM_SAMPLES,
        reason: `only ${sample.length} comparable completed run${
          sample.length === 1 ? "" : "s"
        } with a measured ${metric}; at least ${FORECAST_MINIMUM_SAMPLES} are needed before a forecast is worth anything`,
      };
    const estimate = quantile(sample, 0.5);
    const low = quantile(sample, 0.1);
    const high = quantile(sample, 0.9);
    const assumptions = [
      `${sample.length} completed runs in scope, treated as exchangeable`,
      provider ? `provider fixed to ${provider}` : "all providers pooled",
      model ? `model fixed to ${model}` : "all models pooled",
      metric === "costUsd"
        ? "cost is provider-reported where available, otherwise the configured pricing table"
        : "measured from recorded events only",
      "past runs are assumed to resemble the next one; a changed prompt, repository, or provider version invalidates this",
    ];
    return {
      available: true,
      scope,
      sampleSize: sample.length,
      minimumSamples: FORECAST_MINIMUM_SAMPLES,
      estimate,
      low,
      high,
      assumptions,
      confidence: {
        interval: "p10–p90 of the observed sample",
        method: "empirical quantiles, no distribution assumed",
        level: sample.length >= 20 ? "moderate" : "weak",
        note: "this is a range over past runs, not a probability statement about the next one",
      },
      capacity: this.#capacity(summary, estimate),
    };
  }

  /** A capacity suggestion with its assumptions; never a promise. */
  #capacity(summary, estimatePerRun) {
    const saturation = summary.reliability.saturation.byWorkspace;
    if (!saturation.length)
      return { available: false, reason: "no runs in scope to measure" };
    const worst = saturation[0];
    const suggestions = [];
    if (worst.atOrOverLimit && worst.saturatedMs > 0)
      suggestions.push(
        `workspace ${worst.workspaceId} spent ${worst.saturatedMs} ms at or above its concurrency limit of ${worst.limit}; raising the limit by one would let one more run start during those windows`,
      );
    else
      suggestions.push(
        `no workspace in scope reached its concurrency limit, so raising maxConcurrentRuns would not have started work sooner`,
      );
    return {
      available: true,
      suggestions,
      perRunEstimate: estimatePerRun,
      assumptions: [
        "concurrency is the only modelled constraint; provider rate limits and machine resources are not measured",
        "queue time is taken from recorded events, not from a provider queue",
      ],
      confidence: {
        level: "weak",
        note: "derived from this workspace's recorded history only",
      },
    };
  }

  // ------------------------------------------------------------ saved views

  #viewRow(row) {
    return {
      id: row.id,
      name: row.name,
      workspaceId: row.workspace_id ?? null,
      filters: parseJson(row.filters, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listViews({ workspaceId = null } = {}) {
    const rows = workspaceId
      ? this.db
          .prepare(
            "SELECT * FROM analytics_saved_views WHERE workspace_id = ? OR workspace_id IS NULL ORDER BY name",
          )
          .all(workspaceId)
      : this.db
          .prepare("SELECT * FROM analytics_saved_views ORDER BY name")
          .all();
    return rows.map((row) => this.#viewRow(row));
  }

  getView(id) {
    const row = this.db
      .prepare("SELECT * FROM analytics_saved_views WHERE id = ?")
      .get(id);
    if (!row) throw new InputError("Saved view not found", 404);
    return this.#viewRow(row);
  }

  #checkFilters(filters) {
    if (filters === undefined || filters === null) return {};
    if (typeof filters !== "object" || Array.isArray(filters))
      throw new InputError("filters must be an object");
    const json = JSON.stringify(filters);
    if (json.length > 8192) throw new InputError("filters are too large");
    return filters;
  }

  createView({ name, workspaceId = null, filters = {} } = {}) {
    const title = String(name ?? "").trim();
    if (!title) throw new InputError("A saved view needs a name");
    if (title.length > 120) throw new InputError("Name is too long");
    if (workspaceId && !this.services.hub.has(workspaceId))
      throw new InputError("Workspace not found", 404);
    const now = this.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO analytics_saved_views (id, name, workspace_id, filters, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        title,
        workspaceId,
        JSON.stringify(this.#checkFilters(filters)),
        now,
        now,
      );
    return this.getView(id);
  }

  updateView(id, patch = {}) {
    const view = this.getView(id);
    const name =
      patch.name === undefined ? view.name : String(patch.name).trim();
    if (!name) throw new InputError("A saved view needs a name");
    const filters =
      patch.filters === undefined
        ? view.filters
        : this.#checkFilters(patch.filters);
    this.db
      .prepare(
        "UPDATE analytics_saved_views SET name = ?, filters = ?, updated_at = ? WHERE id = ?",
      )
      .run(name, JSON.stringify(filters), this.now(), id);
    return this.getView(id);
  }

  deleteView(id) {
    this.getView(id);
    this.db.prepare("DELETE FROM analytics_saved_views WHERE id = ?").run(id);
    return { id, deleted: true };
  }

  // ------------------------------------------------------ scheduled reports

  #reportRow(row) {
    return {
      id: row.id,
      name: row.name,
      workspaceId: row.workspace_id ?? null,
      format: row.format,
      filters: parseJson(row.filters, {}),
      cadence: row.cadence,
      cadenceMs: REPORT_CADENCES[row.cadence] ?? null,
      nextRunAt: row.next_run_at ?? null,
      lastRunAt: row.last_run_at ?? null,
      outputDir: row.output_dir,
      enabled: !!row.enabled,
      delivery: "writes a file into outputDir; nothing is sent anywhere",
    };
  }

  listReports() {
    return this.db
      .prepare("SELECT * FROM scheduled_reports ORDER BY name")
      .all()
      .map((row) => this.#reportRow(row));
  }

  getReport(id) {
    const row = this.db
      .prepare("SELECT * FROM scheduled_reports WHERE id = ?")
      .get(id);
    if (!row) throw new InputError("Scheduled report not found", 404);
    return this.#reportRow(row);
  }

  createReport({
    name,
    workspaceId = null,
    format = "json",
    filters = {},
    cadence = "daily",
    outputDir,
    enabled = false,
  } = {}) {
    const title = String(name ?? "").trim();
    if (!title) throw new InputError("A scheduled report needs a name");
    if (!["csv", "json"].includes(format))
      throw new InputError("format must be csv or json");
    if (!REPORT_CADENCES[cadence])
      throw new InputError(
        `cadence must be one of ${Object.keys(REPORT_CADENCES).join(", ")}`,
      );
    const dir = String(outputDir ?? "").trim();
    if (!dir)
      throw new InputError(
        "A scheduled report needs an output directory; reports are written to disk and never sent anywhere",
      );
    if (workspaceId && !this.services.hub.has(workspaceId))
      throw new InputError("Workspace not found", 404);
    const now = this.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO scheduled_reports
           (id, name, workspace_id, format, filters, cadence, next_run_at, last_run_at, output_dir, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        id,
        title,
        workspaceId,
        format,
        JSON.stringify(this.#checkFilters(filters)),
        cadence,
        now + REPORT_CADENCES[cadence],
        resolve(dir),
        enabled === true ? 1 : 0,
      );
    return this.getReport(id);
  }

  updateReport(id, patch = {}) {
    const report = this.getReport(id);
    const next = {
      name: patch.name === undefined ? report.name : String(patch.name).trim(),
      format: patch.format ?? report.format,
      cadence: patch.cadence ?? report.cadence,
      outputDir:
        patch.outputDir === undefined
          ? report.outputDir
          : String(patch.outputDir).trim(),
      enabled: patch.enabled === undefined ? report.enabled : !!patch.enabled,
      filters:
        patch.filters === undefined
          ? report.filters
          : this.#checkFilters(patch.filters),
    };
    if (!next.name) throw new InputError("A scheduled report needs a name");
    if (!["csv", "json"].includes(next.format))
      throw new InputError("format must be csv or json");
    if (!REPORT_CADENCES[next.cadence])
      throw new InputError(
        `cadence must be one of ${Object.keys(REPORT_CADENCES).join(", ")}`,
      );
    if (!next.outputDir)
      throw new InputError("A scheduled report needs an output directory");
    const nextRunAt =
      patch.cadence && patch.cadence !== report.cadence
        ? this.now() + REPORT_CADENCES[next.cadence]
        : (report.nextRunAt ?? this.now() + REPORT_CADENCES[next.cadence]);
    this.db
      .prepare(
        `UPDATE scheduled_reports
           SET name = ?, format = ?, filters = ?, cadence = ?, next_run_at = ?, output_dir = ?, enabled = ?
         WHERE id = ?`,
      )
      .run(
        next.name,
        next.format,
        JSON.stringify(next.filters),
        next.cadence,
        nextRunAt,
        resolve(next.outputDir),
        next.enabled ? 1 : 0,
        id,
      );
    return this.getReport(id);
  }

  deleteReport(id) {
    this.getReport(id);
    this.db.prepare("DELETE FROM scheduled_reports WHERE id = ?").run(id);
    return { id, deleted: true };
  }

  /** Renders one report to a file. Local disk only; nothing is transmitted. */
  runReport(id) {
    const report = this.getReport(id);
    const now = this.now();
    const result = this.export(report.format, {
      workspaceId: report.filters.workspaceId ?? report.workspaceId ?? null,
      since: report.filters.since ?? 0,
    });
    mkdirSync(report.outputDir, { recursive: true });
    const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
    const safeName = report.name.replace(/[^a-zA-Z0-9._-]+/g, "-");
    const file = join(
      report.outputDir,
      `${safeName}-${stamp}.${report.format}`,
    );
    writeFileSync(file, result.body, "utf8");
    this.db
      .prepare(
        "UPDATE scheduled_reports SET last_run_at = ?, next_run_at = ? WHERE id = ?",
      )
      .run(now, now + (REPORT_CADENCES[report.cadence] ?? 0), id);
    this.services.audit?.record?.({
      actor: "system",
      action: "analytics.report.written",
      target: report.id,
      workspaceId: report.workspaceId,
      details: { file, rows: result.rows, format: report.format },
    });
    return { id, file, rows: result.rows, writtenAt: now };
  }

  /** Runs every enabled report that is due. Returns what it wrote. */
  runDueReports(at = this.now()) {
    const due = this.db
      .prepare(
        "SELECT id FROM scheduled_reports WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?",
      )
      .all(at);
    const written = [];
    for (const row of due) {
      try {
        written.push(this.runReport(row.id));
      } catch (error) {
        written.push({ id: row.id, error: error.message });
      }
    }
    return written;
  }

  /**
   * Starts the cadence timer. Disabled reports are skipped, the timer is
   * unref'd so it never holds the process open, and nothing leaves the disk.
   */
  startReportTimer({ intervalMs = 60_000 } = {}) {
    this.stopReportTimer();
    this.reportTimer = setInterval(() => {
      try {
        this.runDueReports();
      } catch {
        /* a broken report never stops the timer */
      }
    }, intervalMs);
    this.reportTimer.unref?.();
    return { running: true, intervalMs };
  }

  stopReportTimer() {
    if (this.reportTimer) clearInterval(this.reportTimer);
    this.reportTimer = null;
    return { running: false };
  }

  // -------------------------------------------------------- OTLP-shaped export

  /**
   * An OpenTelemetry-shaped JSON document (resourceSpans → scopeSpans →
   * spans). Nothing is transmitted: there is no OTLP client here, only the
   * document, so the caller can post it to whatever collector they already
   * run.
   *
   * Prompts, responses, file contents, and secrets are NEVER included unless
   * `includeAttributes.prompts` is explicitly true, and the document always
   * names what it left out.
   */
  otlpExport({ workspaceId = null, since = 0, includeAttributes = {} } = {}) {
    const now = this.now();
    const includePrompts = includeAttributes?.prompts === true;
    const includeFiles = includeAttributes?.files === true;
    const { runs, events } = this.#load({ workspaceId, since });
    const omitted = ["gen_ai.prompt", "gen_ai.completion", "event.message"];
    if (!includeFiles) omitted.push("file.path");
    omitted.push("secrets (never exported)");

    const toNano = (ms) => String(Math.round(ms) * 1e6);
    const attr = (key, value) => {
      if (value === null || value === undefined) return null;
      if (typeof value === "number")
        return Number.isInteger(value)
          ? { key, value: { intValue: String(value) } }
          : { key, value: { doubleValue: value } };
      if (typeof value === "boolean")
        return { key, value: { boolValue: value } };
      return { key, value: { stringValue: String(value) } };
    };
    const attrs = (pairs) =>
      pairs.map(([key, value]) => attr(key, value)).filter(Boolean);

    const eventsByRun = new Map();
    for (const event of events) {
      if (!event.run_id) continue;
      if (!eventsByRun.has(event.run_id)) eventsByRun.set(event.run_id, []);
      eventsByRun.get(event.run_id).push(event);
    }
    const spans = [];
    for (const run of runs) {
      const usage = parseJson(run.usage, {});
      const tokens = readTokens(usage);
      const traceId = run.id.replace(/-/g, "").slice(0, 32).padEnd(32, "0");
      const spanId = traceId.slice(0, 16);
      spans.push({
        traceId,
        spanId,
        name: `run ${run.provider}`,
        kind: 3, // SPAN_KIND_CLIENT
        startTimeUnixNano: toNano(run.started_at),
        endTimeUnixNano: toNano(run.ended_at ?? now),
        status: {
          code:
            run.status === "completed" ? 1 : run.status === "failed" ? 2 : 0,
        },
        attributes: attrs([
          ["gen_ai.system", run.provider],
          ["gen_ai.request.model", run.requested_model],
          ["gen_ai.response.model", run.actual_model],
          ["gen_ai.usage.input_tokens", tokens.input],
          ["gen_ai.usage.output_tokens", tokens.output],
          ["agent_space.run.id", run.id],
          ["agent_space.run.mode", run.mode],
          ["agent_space.run.status", run.status],
          ["agent_space.run.attempt", run.attempt ?? 1],
          ["agent_space.workspace.id", run.workspace_id],
          ["agent_space.task.id", run.task_id],
        ]),
      });
      let index = 0;
      for (const event of eventsByRun.get(run.id) ?? []) {
        if (!TOOL_START_KINDS.has(event.kind)) continue;
        index++;
        spans.push({
          traceId,
          spanId: (spanId.slice(0, 12) + index.toString(16).padStart(4, "0"))
            .slice(0, 16)
            .padEnd(16, "0"),
          parentSpanId: spanId,
          name: `tool ${event.tool ?? event.kind}`,
          kind: 3,
          startTimeUnixNano: toNano(event.timestamp),
          endTimeUnixNano: toNano(event.timestamp),
          attributes: attrs([
            ["gen_ai.system", run.provider],
            ["gen_ai.tool.name", event.tool],
            ["agent_space.event.kind", event.kind],
            ["agent_space.event.provenance", event.provenance],
            ...(includeFiles ? [["file.path", event.file]] : []),
            ...(includePrompts
              ? [["agent_space.event.summary", event.message]]
              : []),
          ]),
        });
      }
    }

    return {
      schemaVersion: 1,
      generatedAt: now,
      scope: { workspaceId, since: parseRange(since) },
      privacy: {
        promptsIncluded: includePrompts,
        fileAttributesIncluded: includeFiles,
        omitted,
        note: "Prompts, model responses, file contents, and any credential are excluded by default. Nothing here is transmitted; this is a document for your own collector.",
      },
      resourceSpans: [
        {
          resource: {
            attributes: attrs([
              ["service.name", "agent-space"],
              ["service.namespace", "agent-space"],
              ["telemetry.sdk.name", "agent-space-analytics"],
              ["telemetry.sdk.language", "nodejs"],
            ]),
          },
          scopeSpans: [
            {
              scope: { name: "agent-space.analytics", version: "1" },
              spans,
            },
          ],
        },
      ],
    };
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
