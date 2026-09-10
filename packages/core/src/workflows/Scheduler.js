import { randomUUID } from "node:crypto";
import { InputError } from "../TaskStore.js";
import {
  isValidTimeZone,
  next as nextOccurrence,
  parse,
  quietHoursAt,
} from "./cron.js";

export const SETTING_SCHEDULER_ENABLED = "scheduler.enabled";
export const SCHEDULE_KINDS = ["task", "workflow"];
export const OVERLAP_POLICIES = ["skip", "queue", "allow"];
export const MISSED_RUN_POLICIES = ["skip", "run-once", "catch-up"];
export const OUTCOMES = [
  "started",
  "queued",
  "skipped-overlap",
  "skipped-quiet",
  "skipped-missed",
  "skipped-flag",
  "failed",
];

/** Run statuses that count as "still active" for the overlap policy. */
const LIVE_STATUSES = ["queued", "running", "blocked", "waiting_approval"];

/** Most missed occurrences enumerated (and recorded) per schedule. */
const MAX_MISSED = 100;

const SCHEDULER_ACTOR = "scheduler";

function parseJson(text, fallback) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

function rowToSchedule(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    kind: row.kind,
    target: row.target,
    definition: parseJson(row.definition, {}),
    expression: row.expression,
    timeZone: row.time_zone,
    quietHours: parseJson(row.quiet_hours, null),
    overlapPolicy: row.overlap_policy,
    maxConcurrent: row.max_concurrent,
    missedRunPolicy: row.missed_run_policy,
    catchUpLimit: row.catch_up_limit,
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at ?? null,
    lastRunAt: row.last_run_at ?? null,
    lastResult: parseJson(row.last_result, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cancelledAt: row.cancelled_at ?? null,
  };
}

function rowToRun(row) {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    plannedAt: row.planned_at,
    startedAt: row.started_at ?? null,
    runId: row.run_id ?? null,
    workflowId: row.workflow_id ?? null,
    outcome: row.outcome,
    detail: parseJson(row.detail, {}),
  };
}

function text(value, label, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new InputError(`${label} must contain 1-${max} characters`);
  return value.trim();
}

function oneOf(value, options, label) {
  if (!options.includes(value))
    throw new InputError(`${label} must be one of ${options.join(", ")}`);
  return value;
}

function intRange(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new InputError(
      `${label} must be an integer between ${min} and ${max}`,
    );
  return value;
}

/** Validates quiet hours: null or { start: "HH:MM", end: "HH:MM" }. */
export function validateQuietHours(input) {
  if (input === null || input === undefined) return null;
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new InputError("quietHours must be null or { start, end }");
  // parseClock inside quietHoursAt throws for a malformed clock.
  quietHoursAt(0, input, "UTC");
  return { start: input.start, end: input.end };
}

/**
 * Validates a create/update payload. `existing` supplies the fields a PATCH
 * leaves untouched. Returns the normalized column values.
 */
export function validateSchedule(input, existing = null) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new InputError("Expected a schedule object");
  const pick = (key, fallback) =>
    input[key] !== undefined ? input[key] : (existing?.[key] ?? fallback);
  const kind = oneOf(pick("kind", "task"), SCHEDULE_KINDS, "kind");
  const definition = pick("definition", {});
  if (
    !definition ||
    typeof definition !== "object" ||
    Array.isArray(definition)
  )
    throw new InputError("definition must be an object");
  if (JSON.stringify(definition).length > 16384)
    throw new InputError("definition is too large");
  if (kind === "task") {
    if (
      definition.prompt !== undefined &&
      typeof definition.prompt !== "string"
    )
      throw new InputError("definition.prompt must be a string");
    if (
      definition.provider !== undefined &&
      definition.provider !== null &&
      typeof definition.provider !== "string"
    )
      throw new InputError("definition.provider must be a string");
    if (
      definition.agentId !== undefined &&
      definition.agentId !== null &&
      typeof definition.agentId !== "string"
    )
      throw new InputError("definition.agentId must be a string");
  } else if (
    definition.inputs !== undefined &&
    (!definition.inputs ||
      typeof definition.inputs !== "object" ||
      Array.isArray(definition.inputs))
  )
    throw new InputError("definition.inputs must be an object");
  const expression = text(pick("expression", ""), "expression", 120);
  parse(expression);
  const timeZone = text(pick("timeZone", "UTC"), "timeZone", 64);
  if (!isValidTimeZone(timeZone))
    throw new InputError(`Unknown time zone "${timeZone}"`);
  return {
    name: text(pick("name", ""), "name", 120),
    kind,
    target: text(pick("target", ""), "target", 200),
    definition,
    expression,
    timeZone,
    quietHours: validateQuietHours(pick("quietHours", null)),
    overlapPolicy: oneOf(
      pick("overlapPolicy", "skip"),
      OVERLAP_POLICIES,
      "overlapPolicy",
    ),
    maxConcurrent: intRange(pick("maxConcurrent", 1), 1, 20, "maxConcurrent"),
    missedRunPolicy: oneOf(
      pick("missedRunPolicy", "skip"),
      MISSED_RUN_POLICIES,
      "missedRunPolicy",
    ),
    catchUpLimit: intRange(pick("catchUpLimit", 5), 1, 100, "catchUpLimit"),
  };
}

/**
 * Opt-in scheduler for tasks and workflows (roadmap §10).
 *
 * Nothing runs by itself: a schedule is created disabled, the tick timer only
 * starts when start() is called, and start() refuses unless the
 * `scheduler.enabled` setting is true. Every occurrence decision — start,
 * queue, or any skip — is written to schedule_runs AND to the audit log with
 * actor "scheduler", so a run that appears at 03:00 can always be traced to
 * the schedule and the policy that produced it.
 *
 * Dispatch goes through the same paths a person uses: services.runWorker.start
 * for tasks (after creating the task in the workspace) and
 * services.workflows.instantiate for workflows. The run worker applies the
 * workspace policy, incidents (stop-all), budget and provider availability;
 * a refusal there is recorded as outcome "failed" with the reason.
 *
 * Overlap policy is evaluated against the schedule's OWN active runs:
 *   skip   — at or above maxConcurrent: record skipped-overlap and advance.
 *   allow  — dispatch while below maxConcurrent, otherwise skipped-overlap.
 *   queue  — dispatch while below maxConcurrent (the run worker queues it
 *            when the workspace is at its own limit); at the cap the
 *            occurrence is held (outcome "queued", next_run_at is NOT
 *            advanced) and retried on the next tick until a slot frees.
 *
 * Quiet hours are evaluated in the schedule's zone at dispatch time; a due
 * run inside the window is deferred to the window's end (skipped-quiet with
 * `deferredTo`) unless missedRunPolicy is "skip", in which case the
 * occurrence is dropped and the schedule advances.
 */
export class Scheduler {
  constructor(services, { now = Date.now, tickMs = 30_000 } = {}) {
    this.services = services;
    this.db = services.db;
    this.now = now;
    this.tickMs = tickMs;
    this.timer = null;
    this.lastTickAt = null;
    this.ticking = false;
  }

  /* ------------------------------------------------------------ helpers */

  #row(id) {
    const row = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id);
    if (!row) throw new InputError("Schedule not found", 404);
    return row;
  }

  #audit(
    action,
    schedule,
    details = {},
    { actor = SCHEDULER_ACTOR, runId = null } = {},
  ) {
    try {
      this.services.audit?.record?.({
        actor,
        action,
        target: schedule?.id ?? null,
        workspaceId: schedule?.workspaceId ?? null,
        runId,
        details: { provenance: "system", ...details },
      });
    } catch {
      /* audit is best effort */
    }
  }

  #recordRun(
    schedule,
    {
      plannedAt,
      outcome,
      runId = null,
      workflowId = null,
      detail = {},
      startedAt = null,
    },
  ) {
    oneOf(outcome, OUTCOMES, "outcome");
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO schedule_runs (id, schedule_id, planned_at, started_at, run_id, workflow_id, outcome, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        schedule.id,
        plannedAt,
        startedAt,
        runId,
        workflowId,
        outcome,
        JSON.stringify(detail),
      );
    this.db
      .prepare(
        "UPDATE schedules SET last_result = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        JSON.stringify({
          outcome,
          at: this.now(),
          plannedAt,
          runId,
          workflowId,
          ...detail,
        }),
        this.now(),
        schedule.id,
      );
    this.#audit(
      outcome === "started" || outcome === "queued"
        ? "schedule.dispatch"
        : "schedule.skip",
      schedule,
      {
        outcome,
        plannedAt,
        runId,
        workflowId,
        ...detail,
      },
      { runId },
    );
    return id;
  }

  #setNextRun(id, at) {
    this.db
      .prepare(
        "UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(at, this.now(), id);
  }

  /** Global opt-in: the `scheduler.enabled` setting. */
  enabled() {
    try {
      return (
        this.services.settings?.get?.(SETTING_SCHEDULER_ENABLED, false) === true
      );
    } catch {
      return false;
    }
  }

  /** Runs this schedule started that are still live, by run id. */
  activeRuns(scheduleId) {
    const rows = this.db
      .prepare(
        "SELECT run_id FROM schedule_runs WHERE schedule_id = ? AND run_id IS NOT NULL AND outcome = 'started'",
      )
      .all(scheduleId);
    const active = [];
    for (const { run_id: runId } of rows) {
      let run = null;
      try {
        run =
          this.services.runWorker?.get?.(runId) ??
          this.services.recorder?.get?.(runId) ??
          null;
      } catch {
        run = null;
      }
      if (run && LIVE_STATUSES.includes(run.status)) active.push(runId);
    }
    return active;
  }

  /* --------------------------------------------------------------- CRUD */

  create(workspaceId, input, { actor = "local-user" } = {}) {
    this.services.hub.get(workspaceId); // 404 when unknown
    const fields = validateSchedule(input);
    const now = this.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO schedules (id, workspace_id, name, kind, target, definition, expression, time_zone, quiet_hours,
           overlap_policy, max_concurrent, missed_run_policy, catch_up_limit, enabled, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        fields.name,
        fields.kind,
        fields.target,
        JSON.stringify(fields.definition),
        fields.expression,
        fields.timeZone,
        fields.quietHours ? JSON.stringify(fields.quietHours) : null,
        fields.overlapPolicy,
        fields.maxConcurrent,
        fields.missedRunPolicy,
        fields.catchUpLimit,
        nextOccurrence(fields.expression, now, fields.timeZone),
        now,
        now,
      );
    const schedule = this.get(id);
    this.#audit(
      "schedule.create",
      schedule,
      {
        name: schedule.name,
        kind: schedule.kind,
        expression: schedule.expression,
        timeZone: schedule.timeZone,
        enabled: false,
      },
      { actor },
    );
    return schedule;
  }

  update(id, patch, { actor = "local-user" } = {}) {
    const existing = this.get(id);
    if (existing.cancelledAt)
      throw new InputError("A cancelled schedule cannot be edited", 409);
    const fields = validateSchedule(patch, existing);
    const now = this.now();
    const retime =
      fields.expression !== existing.expression ||
      fields.timeZone !== existing.timeZone;
    this.db
      .prepare(
        `UPDATE schedules SET name = ?, kind = ?, target = ?, definition = ?, expression = ?, time_zone = ?, quiet_hours = ?,
           overlap_policy = ?, max_concurrent = ?, missed_run_policy = ?, catch_up_limit = ?, next_run_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        fields.name,
        fields.kind,
        fields.target,
        JSON.stringify(fields.definition),
        fields.expression,
        fields.timeZone,
        fields.quietHours ? JSON.stringify(fields.quietHours) : null,
        fields.overlapPolicy,
        fields.maxConcurrent,
        fields.missedRunPolicy,
        fields.catchUpLimit,
        retime
          ? nextOccurrence(fields.expression, now, fields.timeZone)
          : existing.nextRunAt,
        now,
        id,
      );
    const schedule = this.get(id);
    this.#audit(
      "schedule.update",
      schedule,
      { changed: Object.keys(patch ?? {}) },
      { actor },
    );
    return schedule;
  }

  get(id) {
    return rowToSchedule(this.#row(id));
  }

  list(workspaceId = null, { includeCancelled = false } = {}) {
    const clauses = [];
    const params = [];
    if (workspaceId) {
      clauses.push("workspace_id = ?");
      params.push(workspaceId);
    }
    if (!includeCancelled) clauses.push("cancelled_at IS NULL");
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM schedules ${where} ORDER BY created_at DESC`)
      .all(...params)
      .map(rowToSchedule);
  }

  runs(id, { limit = 100 } = {}) {
    this.#row(id);
    return this.db
      .prepare(
        "SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY planned_at DESC, rowid DESC LIMIT ?",
      )
      .all(id, Math.max(1, Math.min(Number(limit) || 100, 1000)))
      .map(rowToRun);
  }

  /** Explicit opt-in per schedule. The next run is computed from now. */
  enable(id, { actor = "local-user" } = {}) {
    const schedule = this.get(id);
    if (schedule.cancelledAt)
      throw new InputError("A cancelled schedule cannot be enabled", 409);
    const now = this.now();
    this.db
      .prepare(
        "UPDATE schedules SET enabled = 1, next_run_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        nextOccurrence(schedule.expression, now, schedule.timeZone),
        now,
        id,
      );
    const updated = this.get(id);
    this.#audit(
      "schedule.enable",
      updated,
      { nextRunAt: updated.nextRunAt, schedulerEnabled: this.enabled() },
      { actor },
    );
    return updated;
  }

  disable(id, { actor = "local-user" } = {}) {
    const schedule = this.get(id);
    this.db
      .prepare("UPDATE schedules SET enabled = 0, updated_at = ? WHERE id = ?")
      .run(this.now(), id);
    const updated = this.get(id);
    this.#audit("schedule.disable", updated, {}, { actor });
    return updated;
  }

  /**
   * Cancels the schedule and REQUESTS cancellation of its live runs through
   * the run worker. Cancellation does not undo side effects a run already
   * had; the per-run result says whether the request was accepted.
   */
  async cancel(id, { actor = "local-user" } = {}) {
    const schedule = this.get(id);
    const now = this.now();
    this.db
      .prepare(
        "UPDATE schedules SET enabled = 0, cancelled_at = COALESCE(cancelled_at, ?), updated_at = ? WHERE id = ?",
      )
      .run(now, now, id);
    const requested = [];
    for (const runId of this.activeRuns(id)) {
      try {
        await this.services.runWorker?.cancel?.(runId, { actor });
        requested.push({ runId, accepted: true });
      } catch (error) {
        requested.push({
          runId,
          accepted: false,
          reason: error?.message ?? String(error),
        });
      }
    }
    const updated = this.get(id);
    this.#audit(
      "schedule.cancel",
      updated,
      {
        cancelledRuns: requested,
        note: "cancellation requested; side effects of started runs are not undone",
      },
      { actor },
    );
    return { schedule: updated, cancelledRuns: requested };
  }

  async remove(id, { actor = "local-user" } = {}) {
    const schedule = this.get(id);
    if (!schedule.cancelledAt) await this.cancel(id, { actor });
    this.db.prepare("DELETE FROM schedule_runs WHERE schedule_id = ?").run(id);
    this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
    this.#audit("schedule.delete", schedule, {}, { actor });
    return { deleted: true, id };
  }

  /* ------------------------------------------------------------ dispatch */

  /**
   * Evaluates one occurrence: quiet hours, then overlap, then dispatch.
   * Returns { outcome, runId?, workflowId?, deferredTo?, hold? }.
   */
  async dispatch(
    schedule,
    plannedAt,
    { actor = SCHEDULER_ACTOR, manual = false, reason = "due" } = {},
  ) {
    const now = this.now();
    if (!manual && schedule.quietHours) {
      const quiet = quietHoursAt(now, schedule.quietHours, schedule.timeZone);
      if (quiet.inside) {
        const drop = schedule.missedRunPolicy === "skip";
        this.#recordRun(schedule, {
          plannedAt,
          outcome: "skipped-quiet",
          detail: {
            reason,
            quietHours: schedule.quietHours,
            deferredTo: drop ? null : quiet.endsAt,
            dropped: drop,
          },
        });
        return {
          outcome: "skipped-quiet",
          deferredTo: drop ? null : quiet.endsAt,
        };
      }
    }
    if (
      !manual &&
      this.services.flags?.isEnabled?.("scheduler.dispatch", {
        workspaceId: schedule.workspaceId,
      }) === false
    ) {
      this.#recordRun(schedule, {
        plannedAt,
        outcome: "skipped-flag",
        detail: {
          reason,
          flag: "scheduler.dispatch",
          note: "feature flag is off for this workspace",
        },
      });
      return { outcome: "skipped-flag" };
    }
    const active = this.activeRuns(schedule.id);
    if (active.length >= schedule.maxConcurrent) {
      if (schedule.overlapPolicy === "queue") {
        // Hold the occurrence; record it once per planned time.
        const already = this.db
          .prepare(
            "SELECT id FROM schedule_runs WHERE schedule_id = ? AND planned_at = ? AND outcome = 'queued'",
          )
          .get(schedule.id, plannedAt);
        if (!already)
          this.#recordRun(schedule, {
            plannedAt,
            outcome: "queued",
            detail: {
              reason,
              activeRuns: active,
              maxConcurrent: schedule.maxConcurrent,
              note: "held until a slot frees; retried every tick",
            },
          });
        return { outcome: "queued", hold: true };
      }
      this.#recordRun(schedule, {
        plannedAt,
        outcome: "skipped-overlap",
        detail: {
          reason,
          overlapPolicy: schedule.overlapPolicy,
          activeRuns: active,
          maxConcurrent: schedule.maxConcurrent,
        },
      });
      return { outcome: "skipped-overlap" };
    }
    try {
      const result =
        schedule.kind === "task"
          ? await this.#dispatchTask(schedule, actor)
          : this.#dispatchWorkflow(schedule, actor);
      this.db
        .prepare("UPDATE schedules SET last_run_at = ? WHERE id = ?")
        .run(now, schedule.id);
      this.#recordRun(schedule, {
        plannedAt,
        startedAt: now,
        outcome: "started",
        runId: result.runId ?? null,
        workflowId: result.workflowId ?? null,
        detail: {
          reason,
          manual,
          actor,
          status: result.status ?? null,
          taskId: result.taskId ?? null,
        },
      });
      return { outcome: "started", ...result };
    } catch (error) {
      const message = error?.message ?? String(error);
      this.#recordRun(schedule, {
        plannedAt,
        outcome: "failed",
        detail: { reason, manual, actor, error: message },
      });
      return { outcome: "failed", error: message };
    }
  }

  async #dispatchTask(schedule, actor) {
    const worker = this.services.runWorker;
    if (!worker?.start)
      throw new InputError("Run worker is not available", 503);
    const workspace = this.services.hub.get(schedule.workspaceId);
    const def = schedule.definition ?? {};
    const task = workspace.create({
      title: schedule.target,
      description:
        typeof def.prompt === "string" ? def.prompt.slice(0, 2000) : "",
      priority: def.priority ?? "medium",
      provider: def.provider ?? undefined,
      source: "schedule",
    });
    const run = await worker.start({
      workspaceId: schedule.workspaceId,
      taskId: task.id,
      provider: def.provider ?? undefined,
      agentId: def.agentId ?? null,
      prompt: def.prompt ?? null,
      model: def.model ?? null,
      actor,
    });
    return {
      runId: run?.id ?? null,
      status: run?.status ?? null,
      taskId: task.id,
    };
  }

  #dispatchWorkflow(schedule, actor) {
    const workflows = this.services.workflows;
    if (!workflows?.instantiate)
      throw new InputError("Workflow service is not available", 503);
    const def = schedule.definition ?? {};
    const workflow = workflows.instantiate(
      schedule.workspaceId,
      schedule.target,
      {
        inputs: def.inputs ?? {},
        provider: def.provider ?? null,
        agentByRole: def.agentByRole ?? {},
        contracts: def.contracts ?? {},
        actor,
      },
    );
    return {
      workflowId: workflow?.id ?? null,
      status: workflow?.status ?? null,
    };
  }

  /** Manual one-off dispatch of an existing schedule (audited as the actor). */
  async runNow(id, { actor = "local-user" } = {}) {
    const schedule = this.get(id);
    if (schedule.cancelledAt)
      throw new InputError("A cancelled schedule cannot be run", 409);
    this.#audit("schedule.run-now", schedule, {}, { actor });
    return this.dispatch(schedule, this.now(), {
      actor,
      manual: true,
      reason: "run-now",
    });
  }

  /**
   * Occurrences of `schedule` that fell due at or before `now`, oldest first,
   * bounded by MAX_MISSED (+1 so the caller can tell when it was truncated).
   */
  #dueOccurrences(schedule, now) {
    const list = [];
    let t = schedule.nextRunAt;
    while (t !== null && t <= now && list.length <= MAX_MISSED) {
      list.push(t);
      t = nextOccurrence(schedule.expression, t, schedule.timeZone);
    }
    return list;
  }

  /**
   * Processes one schedule at `now`. `mode` is "start" (every overdue
   * occurrence is a missed run) or "tick" (the latest occurrence is due; any
   * earlier ones are missed). Returns the decisions made.
   */
  async #process(schedule, now, mode) {
    // Quiet hours are decided for the schedule, before any missed occurrence
    // is enumerated. Otherwise a schedule that slept through the window
    // records a backlog of "skipped-missed" rows next to the single
    // "skipped-quiet" one, which double-counts the same silence.
    if (schedule.quietHours) {
      const quiet = quietHoursAt(now, schedule.quietHours, schedule.timeZone);
      if (quiet.inside) {
        const drop = schedule.missedRunPolicy === "skip";
        const plannedAt = schedule.nextRunAt ?? now;
        this.#recordRun(schedule, {
          plannedAt,
          outcome: "skipped-quiet",
          detail: {
            reason: mode === "start" ? "missed" : "due",
            quietHours: schedule.quietHours,
            deferredTo: drop ? null : quiet.endsAt,
            dropped: drop,
          },
        });
        this.#setNextRun(
          schedule.id,
          drop
            ? nextOccurrence(schedule.expression, now, schedule.timeZone)
            : quiet.endsAt,
        );
        return [
          {
            plannedAt,
            outcome: "skipped-quiet",
            deferredTo: drop ? null : quiet.endsAt,
          },
        ];
      }
    }
    // A held occurrence (overlap policy "queue" at its cap) owns the schedule
    // until a slot frees. Retry exactly that planned time instead of
    // enumerating new ones, so waiting does not pile up a "queued" row per tick.
    const held = this.db
      .prepare(
        "SELECT planned_at FROM schedule_runs WHERE schedule_id = ? AND outcome = 'queued' ORDER BY planned_at DESC LIMIT 1",
      )
      .get(schedule.id);
    if (held && schedule.nextRunAt === held.planned_at) {
      const result = await this.dispatch(schedule, held.planned_at, {
        reason: "held",
      });
      if (result.hold) this.#setNextRun(schedule.id, held.planned_at);
      else
        this.#setNextRun(
          schedule.id,
          nextOccurrence(schedule.expression, now, schedule.timeZone),
        );
      return [{ plannedAt: held.planned_at, ...result }];
    }
    const occurrences = this.#dueOccurrences(schedule, now);
    if (!occurrences.length) return [];
    const truncated = occurrences.length > MAX_MISSED;
    const due = truncated ? occurrences.slice(0, MAX_MISSED) : occurrences;
    const policy = schedule.missedRunPolicy;
    const decisions = [];
    const skip = (plannedAt, extra = {}) => {
      this.#recordRun(schedule, {
        plannedAt,
        outcome: "skipped-missed",
        detail: { missedRunPolicy: policy, mode, ...extra },
      });
      decisions.push({ plannedAt, outcome: "skipped-missed" });
    };
    let toDispatch = [];
    let toSkip = [];
    if (mode === "tick" && due.length === 1) {
      toDispatch = due;
    } else if (policy === "skip") {
      toSkip = mode === "tick" ? due.slice(0, -1) : due;
      if (mode === "tick") toDispatch = due.slice(-1);
    } else if (policy === "run-once") {
      toSkip = due.slice(0, -1);
      toDispatch = due.slice(-1);
    } else {
      toDispatch = due.slice(0, schedule.catchUpLimit);
      toSkip = due.slice(schedule.catchUpLimit);
    }
    for (const plannedAt of toSkip) skip(plannedAt);
    if (truncated)
      skip(due[due.length - 1], {
        note: `more than ${MAX_MISSED} missed occurrences; the rest were not enumerated`,
      });
    let hold = null;
    let deferredTo = null;
    for (const plannedAt of toDispatch) {
      const reason =
        mode === "start" || toDispatch.length > 1 ? "missed" : "due";
      const result = await this.dispatch(schedule, plannedAt, { reason });
      decisions.push({ plannedAt, ...result });
      if (result.hold) {
        hold = plannedAt;
        break;
      }
      if (result.deferredTo) deferredTo = result.deferredTo;
    }
    if (hold !== null) this.#setNextRun(schedule.id, hold);
    else if (deferredTo) this.#setNextRun(schedule.id, deferredTo);
    else
      this.#setNextRun(
        schedule.id,
        nextOccurrence(schedule.expression, now, schedule.timeZone),
      );
    return decisions;
  }

  /** One pass over every enabled schedule. Safe to call directly in tests. */
  async tick({ mode = "tick" } = {}) {
    if (!this.enabled() || this.ticking) return [];
    this.ticking = true;
    const now = this.now();
    const results = [];
    try {
      const rows = this.db
        .prepare(
          "SELECT * FROM schedules WHERE enabled = 1 AND cancelled_at IS NULL AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC",
        )
        .all(now)
        .map(rowToSchedule);
      for (const schedule of rows) {
        try {
          const decisions = await this.#process(schedule, now, mode);
          results.push({ scheduleId: schedule.id, decisions });
        } catch (error) {
          this.services.log?.error?.(
            `[scheduler] ${schedule.id} failed: ${error?.message ?? error}`,
          );
          results.push({
            scheduleId: schedule.id,
            error: error?.message ?? String(error),
          });
        }
      }
    } finally {
      this.ticking = false;
      this.lastTickAt = now;
    }
    if (results.length) this.services.bus?.emit?.("global");
    return results;
  }

  /**
   * Applies the missed-run policy to every enabled schedule whose next run is
   * in the past, then starts the unref'd tick timer. Does nothing (and says
   * so) when the `scheduler.enabled` setting is off.
   */
  async start() {
    this.stop();
    if (!this.enabled())
      return {
        started: false,
        reason: `${SETTING_SCHEDULER_ENABLED} is false`,
        missed: [],
      };
    const missed = await this.tick({ mode: "start" });
    this.timer = setInterval(() => {
      this.tick().catch((error) =>
        this.services.log?.error?.(
          `[scheduler] tick failed: ${error?.message ?? error}`,
        ),
      );
    }, this.tickMs);
    this.timer.unref?.();
    return { started: true, missed };
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** For the health dashboard. Counts only; nothing is predicted. */
  status() {
    const counts = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN enabled = 1 AND cancelled_at IS NULL THEN 1 ELSE 0 END) AS enabled,
                SUM(CASE WHEN cancelled_at IS NOT NULL THEN 1 ELSE 0 END) AS cancelled,
                MIN(CASE WHEN enabled = 1 AND cancelled_at IS NULL THEN next_run_at END) AS next_run_at
         FROM schedules`,
      )
      .get();
    const now = this.now();
    const due = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM schedules WHERE enabled = 1 AND cancelled_at IS NULL AND next_run_at <= ?",
      )
      .get(now).n;
    return {
      enabled: this.enabled(),
      running: !!this.timer,
      tickMs: this.tickMs,
      lastTickAt: this.lastTickAt,
      schedules: {
        total: counts.total ?? 0,
        enabled: counts.enabled ?? 0,
        cancelled: counts.cancelled ?? 0,
        due,
      },
      nextRunAt: counts.next_run_at ?? null,
    };
  }
}

/** Factory used by services.js: `createScheduler(services)` → services.scheduler. */
export function createScheduler(services, options = {}) {
  const scheduler = new Scheduler(services, options);
  services.scheduler = scheduler;
  services.onClose?.(() => scheduler.stop());
  return scheduler;
}
