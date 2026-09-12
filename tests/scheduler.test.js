import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServices } from "../packages/core/src/services.js";
import { InputError } from "../packages/core/src/TaskStore.js";
import {
  next,
  parse,
  wallClock,
  quietHoursAt,
  isValidTimeZone,
} from "../packages/core/src/workflows/cron.js";
import {
  Scheduler,
  createScheduler,
  SETTING_SCHEDULER_ENABLED,
} from "../packages/core/src/workflows/Scheduler.js";
import { createFeatureFlags } from "../packages/core/src/ops/FeatureFlags.js";
import scheduleRoutes from "../packages/server/src/routes/schedules.js";

const NY = "America/New_York";
const IN = "Asia/Kolkata";

const TEMP_DIRS = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "agent-space-scheduler-"));
  TEMP_DIRS.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of TEMP_DIRS.splice(0))
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
});

/**
 * A fake run worker: no provider CLI, no provider home. `start` records a run
 * row through the recorder so the scheduler's overlap check (which reads
 * run status) sees real statuses; `cancel` is recorded for assertions.
 */
/**
 * Matches the rule RunRecorder.ensureRun actually enforces: an agent is busy
 * while it holds an unfinished TASK. A completed managed run leaves its task
 * IN_PROGRESS pending review, so checking runs alone would pick an agent that
 * ensureRun then refuses.
 */
function hasActiveTask(services, agentId) {
  return !!services.db
    .prepare(
      "SELECT 1 FROM tasks WHERE assigned_agent_id = ? AND status IN ('IN_PROGRESS','BLOCKED') LIMIT 1",
    )
    .get(agentId);
}

function fakeWorker(services) {
  const started = [];
  const cancelled = [];
  const worker = {
    started,
    cancelled,
    failNext: null,
    async start(input) {
      if (worker.failNext) {
        const message = worker.failNext;
        worker.failNext = null;
        throw new InputError(message, 409);
      }
      const workspace = services.hub.get(input.workspaceId);
      // A real workspace has capacity: give every dispatch its own profile so
      // an "allow" overlap policy can genuinely run two at once. Reusing one
      // profile would fail with "already working" and hide the real outcome.
      const agent =
        workspace.profiles.list().find((p) => !hasActiveTask(services, p.id)) ??
        workspace.createAgent({
          name: `Runner ${started.length + 1}`,
          role: "Coding assistant",
          provider: input.provider ?? "claude-code",
        });
      const run = services.recorder.ensureRun({
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        agentId: agent.id,
        provider: input.provider ?? "claude-code",
        mode: "managed",
        status: "running",
      });
      started.push({ ...input, runId: run.id });
      return run;
    },
    get(runId) {
      return services.recorder.get(runId);
    },
    async cancel(runId, { actor } = {}) {
      cancelled.push({ runId, actor });
      services.recorder.setStatus(runId, "cancelled", { summary: "cancelled" });
    },
    finish(runId) {
      services.recorder.setStatus(runId, "completed", { summary: "done" });
    },
  };
  return worker;
}

function setup({ now = Date.UTC(2026, 0, 15, 12, 0), enabled = true } = {}) {
  const clock = { now };
  const services = createServices({
    demo: false,
    disableObservation: true,
    detect: async () => [],
    optional: false,
  });
  const worker = fakeWorker(services);
  services.runWorker = worker;
  createFeatureFlags(services);
  const scheduler = createScheduler(services, {
    now: () => clock.now,
    tickMs: 60_000,
  });
  if (enabled) services.settings.set(SETTING_SCHEDULER_ENABLED, true);
  const record = services.hub.create({
    name: "Scheduled",
    rootPath: tempDir(),
  });
  const workspace = services.hub.get(record.id);
  workspace.createAgent({
    name: "Claude Code",
    role: "Coding assistant",
    provider: "claude-code",
  });
  const cleanup = () => services.close();
  return {
    services,
    scheduler,
    worker,
    workspace,
    workspaceId: record.id,
    clock,
    cleanup,
  };
}

function taskSchedule(overrides = {}) {
  return {
    name: "Nightly lint",
    kind: "task",
    target: "Run the linter",
    definition: {
      prompt: "Run npm run lint and fix findings",
      provider: "claude-code",
    },
    expression: "0 3 * * *",
    timeZone: NY,
    ...overrides,
  };
}

function audits(services, action) {
  return services.audit.list({ action, limit: 500 });
}

/* ------------------------------------------------------------------ cron */

test("cron next() is computed in the schedule's zone across the New York spring-forward gap", () => {
  // 2026-03-08: 02:00 EST does not exist in New York.
  const midnight = Date.UTC(2026, 2, 8, 5, 0); // 00:00 EST
  const at230 = next("30 2 * * *", midnight, NY);
  assert.deepEqual(wallClock(at230, NY), {
    year: 2026,
    month: 3,
    day: 9,
    hour: 2,
    minute: 30,
    weekday: 1,
  });
  // Hourly occurrences step over the gap by real instants: 01:00 EST → 03:00 EDT.
  const one = next("0 * * * *", midnight + 30 * 60_000, NY);
  const two = next("0 * * * *", one, NY);
  assert.equal(wallClock(one, NY).hour, 1);
  assert.equal(wallClock(two, NY).hour, 3);
  assert.equal(two - one, 60 * 60_000);
});

test("cron next() handles the New York fall-back overlap without skipping or looping", () => {
  const from = Date.UTC(2026, 10, 1, 4, 0); // 00:00 EDT on 2026-11-01
  const times = [];
  let t = from;
  for (let i = 0; i < 4; i++) {
    t = next("30 * * * *", t, NY);
    times.push(t);
  }
  for (let i = 1; i < times.length; i++)
    assert.equal(times[i] - times[i - 1], 60 * 60_000);
  assert.deepEqual(
    times.map((ms) => wallClock(ms, NY).hour),
    [0, 1, 1, 2],
  );
  // A daily 01:30 fires once per calendar day even when 01:30 happens twice.
  const daily = next("30 1 * * *", from, NY);
  const following = next("30 1 * * *", daily + 60 * 60_000, NY);
  assert.equal(wallClock(following, NY).day, 2);
});

test("cron next() in Asia/Kolkata (no DST, +05:30) and with names, ranges, steps and intervals", () => {
  const from = Date.UTC(2026, 0, 1, 4, 0); // 09:30 IST
  const at = next("15 9 * * *", from, IN);
  assert.equal(new Date(at).toISOString(), "2026-01-02T03:45:00.000Z");
  const weekday = next("0 9 * * mon-fri", Date.UTC(2026, 0, 2, 10, 0), IN); // Friday 15:30 IST
  assert.deepEqual(
    [wallClock(weekday, IN).weekday, wallClock(weekday, IN).hour],
    [1, 9],
  );
  const feb = next("0 0 29 feb *", Date.UTC(2026, 0, 1), "UTC");
  assert.equal(new Date(feb).toISOString(), "2028-02-29T00:00:00.000Z");
  const every = next("*/15 * * * *", Date.UTC(2026, 0, 1, 0, 7), "UTC");
  assert.equal(new Date(every).toISOString(), "2026-01-01T00:15:00.000Z");
  assert.equal(next("every 2 hours", 1000), 1000 + 2 * 3_600_000);
  assert.equal(parse("EVERY 3 days").ms, 3 * 86_400_000);
  // Both day fields restricted → either matches (classic cron).
  const either = next("0 0 15 * sun", Date.UTC(2026, 0, 1), "UTC");
  assert.equal(new Date(either).toISOString(), "2026-01-04T00:00:00.000Z");
});

test("cron rejects invalid expressions and unknown zones", () => {
  for (const bad of [
    "* * * *",
    "60 * * * *",
    "* 24 * * *",
    "* * 0 * *",
    "* * * 13 *",
    "* * * * foo",
    "1-0 * * * *",
    "*/0 * * * *",
    "every 0 days",
    "every 5 fortnights",
    "",
    42,
  ])
    assert.throws(
      () => parse(bad),
      InputError,
      `should reject ${JSON.stringify(bad)}`,
    );
  assert.throws(
    () => next("* * * * *", 0, "Mars/Olympus"),
    /Unknown time zone/,
  );
  assert.throws(() => next("* * * * *", 0, ""), /Unknown time zone/);
  assert.equal(isValidTimeZone("Europe/Berlin"), true);
  assert.equal(isValidTimeZone("Not/AZone"), false);
});

test("quiet hours are evaluated in the zone and can cross midnight", () => {
  const window = { start: "22:00", end: "07:00" };
  const late = Date.UTC(2026, 0, 2, 4, 0); // 23:00 EST Jan 1
  const q = quietHoursAt(late, window, NY);
  assert.equal(q.inside, true);
  assert.deepEqual(wallClock(q.endsAt, NY), {
    year: 2026,
    month: 1,
    day: 2,
    hour: 7,
    minute: 0,
    weekday: 5,
  });
  assert.equal(
    quietHoursAt(Date.UTC(2026, 0, 2, 17, 0), window, NY).inside,
    false,
  ); // noon EST
  assert.throws(
    () => quietHoursAt(late, { start: "25:00", end: "07:00" }, NY),
    /HH:MM/,
  );
});

/* -------------------------------------------------------------- opt-in */

test("schedules are created disabled, validated, and nothing dispatches until both opt-ins are on", async () => {
  const ctx = setup({ enabled: false });
  try {
    const { scheduler, services, worker, workspaceId, clock } = ctx;
    const schedule = scheduler.create(workspaceId, taskSchedule());
    assert.equal(schedule.enabled, false);
    assert.equal(schedule.cancelledAt, null);
    assert.ok(schedule.nextRunAt > clock.now);
    assert.equal(wallClock(schedule.nextRunAt, NY).hour, 3);
    assert.ok(audits(services, "schedule.create").length === 1);

    for (const bad of [
      { expression: "nope" },
      { timeZone: "Mars/Olympus" },
      { overlapPolicy: "maybe" },
      { maxConcurrent: 0 },
      { missedRunPolicy: "later" },
      { quietHours: { start: "22:00" } },
      { name: "" },
      { kind: "cron" },
      { definition: [] },
    ])
      assert.throws(
        () => scheduler.create(workspaceId, taskSchedule(bad)),
        InputError,
        JSON.stringify(bad),
      );
    assert.throws(
      () => scheduler.create("missing-workspace", taskSchedule()),
      /Workspace not found/,
    );

    // Due, enabled schedule, but scheduler.enabled is false: nothing happens.
    scheduler.enable(schedule.id);
    clock.now = scheduler.get(schedule.id).nextRunAt + 1000;
    assert.equal(scheduler.enabled(), false);
    assert.deepEqual(await scheduler.tick(), []);
    const started = await scheduler.start();
    assert.equal(started.started, false);
    assert.match(started.reason, /scheduler.enabled/);
    assert.equal(scheduler.timer, null);
    assert.equal(worker.started.length, 0);
    assert.equal(scheduler.runs(schedule.id).length, 0);

    // A disabled schedule never dispatches even with the global switch on.
    services.settings.set(SETTING_SCHEDULER_ENABLED, true);
    scheduler.disable(schedule.id);
    assert.deepEqual(await scheduler.tick(), []);
    assert.equal(worker.started.length, 0);

    // Both on: the task is created in the workspace and dispatched.
    scheduler.enable(schedule.id);
    clock.now = scheduler.get(schedule.id).nextRunAt + 1000;
    const results = await scheduler.tick();
    assert.equal(results.length, 1);
    assert.equal(results[0].decisions[0].outcome, "started");
    assert.equal(worker.started.length, 1);
    assert.equal(worker.started[0].prompt, "Run npm run lint and fix findings");
    assert.equal(worker.started[0].actor, "scheduler");
    const task = services.hub
      .get(workspaceId)
      .store.get(worker.started[0].taskId);
    assert.equal(task.title, "Run the linter");
    assert.equal(task.source, "schedule");
    const runs = scheduler.runs(schedule.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].outcome, "started");
    assert.equal(runs[0].runId, worker.started[0].runId);
    const dispatchAudit = audits(services, "schedule.dispatch");
    assert.equal(dispatchAudit.length, 1);
    assert.equal(dispatchAudit[0].actor, "scheduler");
    assert.equal(dispatchAudit[0].details.provenance, "system");
    assert.ok(scheduler.get(schedule.id).nextRunAt > clock.now);
    assert.equal(scheduler.get(schedule.id).lastRunAt, clock.now);
    const status = scheduler.status();
    assert.equal(status.enabled, true);
    assert.equal(status.schedules.enabled, 1);
    assert.equal(status.schedules.due, 0);
  } finally {
    await ctx.cleanup();
  }
});

/* ---------------------------------------------------------- quiet hours */

test("a due run inside quiet hours is deferred to the window end, or dropped when missed-run policy is skip", async () => {
  const ctx = setup({ now: Date.UTC(2026, 0, 2, 4, 0) }); // 23:00 EST
  try {
    const { scheduler, worker, workspaceId, clock, services } = ctx;
    const deferred = scheduler.create(
      workspaceId,
      taskSchedule({
        expression: "0 23 * * *",
        quietHours: { start: "22:00", end: "07:00" },
        missedRunPolicy: "run-once",
      }),
    );
    const dropped = scheduler.create(
      workspaceId,
      taskSchedule({
        name: "Dropped",
        expression: "0 23 * * *",
        quietHours: { start: "22:00", end: "07:00" },
        missedRunPolicy: "skip",
      }),
    );
    for (const s of [deferred, dropped]) {
      scheduler.enable(s.id);
      services.db
        .prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?")
        .run(clock.now - 60_000, s.id);
    }
    await scheduler.tick();
    assert.equal(worker.started.length, 0);
    const d = scheduler.get(deferred.id);
    assert.deepEqual(wallClock(d.nextRunAt, NY), {
      year: 2026,
      month: 1,
      day: 2,
      hour: 7,
      minute: 0,
      weekday: 5,
    });
    assert.equal(scheduler.runs(deferred.id)[0].outcome, "skipped-quiet");
    assert.equal(scheduler.runs(deferred.id)[0].detail.deferredTo, d.nextRunAt);
    const p = scheduler.get(dropped.id);
    assert.equal(scheduler.runs(dropped.id)[0].outcome, "skipped-quiet");
    assert.equal(scheduler.runs(dropped.id)[0].detail.dropped, true);
    assert.equal(wallClock(p.nextRunAt, NY).hour, 23);
    assert.equal(audits(services, "schedule.skip").length, 2);

    // At 07:00 the deferred one runs.
    clock.now = d.nextRunAt + 1000;
    await scheduler.tick();
    assert.equal(worker.started.length, 1);
    assert.equal(scheduler.runs(deferred.id)[0].outcome, "started");
  } finally {
    await ctx.cleanup();
  }
});

/* ---------------------------------------------------------- overlap */

test("overlap policy skip / allow / queue is applied against the schedule's own active runs", async () => {
  const ctx = setup();
  try {
    const { scheduler, worker, workspaceId, clock, services } = ctx;
    const make = (overrides) => {
      const s = scheduler.create(
        workspaceId,
        taskSchedule({
          expression: "every 10 minutes",
          timeZone: "UTC",
          ...overrides,
        }),
      );
      scheduler.enable(s.id);
      return s.id;
    };
    const skip = make({ name: "skip", overlapPolicy: "skip" });
    const allow = make({
      name: "allow",
      overlapPolicy: "allow",
      maxConcurrent: 2,
    });
    const queue = make({ name: "queue", overlapPolicy: "queue" });
    const due = async () => {
      clock.now += 10 * 60_000 + 1000;
      return scheduler.tick();
    };
    await due(); // first occurrence: everything starts
    assert.equal(worker.started.length, 3);
    await due(); // second: skip → skipped-overlap, allow → second run, queue → held
    assert.equal(worker.started.length, 4);
    assert.equal(scheduler.runs(skip)[0].outcome, "skipped-overlap");
    assert.deepEqual(scheduler.runs(skip)[0].detail.activeRuns, [
      scheduler.runs(skip)[1].runId,
    ]);
    assert.equal(
      scheduler.runs(allow)[0].outcome,
      "started",
      JSON.stringify(scheduler.runs(allow)[0].detail),
    );
    assert.equal(scheduler.runs(queue)[0].outcome, "queued");
    const heldAt = scheduler.get(queue).nextRunAt;
    assert.ok(
      heldAt <= clock.now,
      "a held occurrence keeps next_run_at in the past",
    );
    await due(); // third: allow is at its cap of 2 → skipped-overlap; queue still held (recorded once)
    assert.equal(scheduler.runs(allow)[0].outcome, "skipped-overlap");
    assert.equal(
      scheduler.runs(queue).filter((r) => r.outcome === "queued").length,
      1,
    );
    assert.equal(scheduler.get(queue).nextRunAt, heldAt);
    // The queued schedule's first run finishes → the held occurrence starts on the next tick.
    worker.finish(
      scheduler.runs(queue).find((r) => r.outcome === "started").runId,
    );
    await scheduler.tick();
    assert.equal(scheduler.runs(queue)[0].outcome, "started");
    assert.ok(scheduler.get(queue).nextRunAt > clock.now);
    // Every decision, including skips, is in the audit log.
    assert.ok(audits(services, "schedule.skip").length >= 2);
    assert.ok(audits(services, "schedule.dispatch").length >= 6);
  } finally {
    await ctx.cleanup();
  }
});

/* ---------------------------------------------------------- missed runs */

test("start() applies the missed-run policy to overdue schedules and records every skipped occurrence", async () => {
  const ctx = setup({ now: Date.UTC(2026, 0, 10, 12, 0) });
  try {
    const { scheduler, worker, workspaceId, clock, services } = ctx;
    const make = (overrides) => {
      const s = scheduler.create(
        workspaceId,
        taskSchedule({
          expression: "0 6 * * *",
          timeZone: "UTC",
          ...overrides,
        }),
      );
      scheduler.enable(s.id);
      // Pretend the server was down for four days: the next run was 4 days ago.
      services.db
        .prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?")
        .run(Date.UTC(2026, 0, 7, 6, 0), s.id);
      return s.id;
    };
    const skip = make({ name: "skip", missedRunPolicy: "skip" });
    const once = make({ name: "once", missedRunPolicy: "run-once" });
    const catchUp = make({
      name: "catch-up",
      missedRunPolicy: "catch-up",
      catchUpLimit: 2,
      overlapPolicy: "allow",
      maxConcurrent: 5,
    });
    const result = await scheduler.start();
    assert.equal(result.started, true);
    assert.ok(scheduler.timer);
    scheduler.stop();
    // Occurrences missed: Jan 7, 8, 9, 10 at 06:00 (four).
    const outcomes = (id) =>
      scheduler
        .runs(id)
        .map((r) => r.outcome)
        .reverse();
    assert.deepEqual(outcomes(skip), [
      "skipped-missed",
      "skipped-missed",
      "skipped-missed",
      "skipped-missed",
    ]);
    assert.deepEqual(outcomes(once), [
      "skipped-missed",
      "skipped-missed",
      "skipped-missed",
      "started",
    ]);
    // runs() orders by planned time, and catch-up dispatches the OLDEST
    // occurrences (Jan 7-8) and skips the newest (Jan 9-10), so chronological
    // order is: started, started, skipped, skipped.
    assert.deepEqual(outcomes(catchUp), [
      "started",
      "started",
      "skipped-missed",
      "skipped-missed",
    ]);
    assert.equal(
      scheduler.runs(once).find((r) => r.outcome === "started").plannedAt,
      Date.UTC(2026, 0, 10, 6, 0),
    );
    assert.deepEqual(
      scheduler
        .runs(catchUp)
        .filter((r) => r.outcome === "started")
        .map((r) => r.plannedAt)
        .sort(),
      [Date.UTC(2026, 0, 7, 6, 0), Date.UTC(2026, 0, 8, 6, 0)],
    );
    assert.equal(worker.started.length, 3);
    for (const id of [skip, once, catchUp])
      assert.equal(scheduler.get(id).nextRunAt, Date.UTC(2026, 0, 11, 6, 0));
    assert.equal(scheduler.runs(skip)[0].detail.missedRunPolicy, "skip");
    assert.equal(scheduler.runs(skip)[0].detail.mode, "start");
    assert.equal(audits(services, "schedule.skip").length, 9);
    void clock;
  } finally {
    await ctx.cleanup();
  }
});

/* ---------------------------------------------------------- cancellation */

test("cancel() disables the schedule, requests cancellation of its active runs, and is audited", async () => {
  const ctx = setup();
  try {
    const { scheduler, worker, workspaceId, clock, services } = ctx;
    const s = scheduler.create(
      workspaceId,
      taskSchedule({ expression: "every 5 minutes", timeZone: "UTC" }),
    );
    scheduler.enable(s.id);
    clock.now += 5 * 60_000 + 1;
    await scheduler.tick();
    assert.equal(worker.started.length, 1);
    const runId = worker.started[0].runId;
    const result = await scheduler.cancel(s.id, { actor: "operator" });
    assert.equal(result.schedule.enabled, false);
    assert.ok(result.schedule.cancelledAt);
    assert.deepEqual(result.cancelledRuns, [{ runId, accepted: true }]);
    assert.deepEqual(worker.cancelled, [{ runId, actor: "operator" }]);
    assert.equal(services.recorder.get(runId).status, "cancelled");
    const entry = audits(services, "schedule.cancel")[0];
    assert.equal(entry.actor, "operator");
    assert.equal(entry.target, s.id);
    assert.equal(entry.details.cancelledRuns[0].runId, runId);
    assert.match(entry.details.note, /not undone/);
    assert.throws(() => scheduler.enable(s.id), /cancelled/);
    assert.throws(() => scheduler.update(s.id, { name: "x" }), /cancelled/);
    await assert.rejects(() => scheduler.runNow(s.id), /cancelled/);
    // Cancelled schedules never tick again and are hidden from the default list.
    clock.now += 10 * 60_000;
    assert.deepEqual(await scheduler.tick(), []);
    assert.equal(scheduler.list(workspaceId).length, 0);
    assert.equal(
      scheduler.list(workspaceId, { includeCancelled: true }).length,
      1,
    );
    assert.equal(scheduler.status().schedules.cancelled, 1);
  } finally {
    await ctx.cleanup();
  }
});

/* ---------------------------------------------- workflows, failures, flags */

test("workflow schedules instantiate the template; dispatch failures are recorded, not thrown; the dispatch flag is honoured", async () => {
  const ctx = setup();
  try {
    const { scheduler, worker, workspaceId, clock, services } = ctx;
    const wf = scheduler.create(workspaceId, {
      name: "Weekly bug clinic",
      kind: "workflow",
      target: "bug-clinic",
      definition: { inputs: { issue: "Flaky test in CI" } },
      expression: "0 9 * * mon",
      timeZone: IN,
    });
    scheduler.enable(wf.id);
    clock.now = scheduler.get(wf.id).nextRunAt + 5;
    await scheduler.tick();
    const run = scheduler.runs(wf.id)[0];
    assert.equal(run.outcome, "started");
    assert.ok(run.workflowId);
    assert.equal(
      services.workflows.get(run.workflowId).workspaceId,
      workspaceId,
    );
    assert.equal(
      worker.started.length,
      0,
      "workflow dispatch creates tasks; the graph decides when they run",
    );

    const failing = scheduler.create(
      workspaceId,
      taskSchedule({
        name: "Failing",
        expression: "every 1 minutes",
        timeZone: "UTC",
      }),
    );
    scheduler.enable(failing.id);
    worker.failNext = "Provider is not available";
    clock.now += 61_000;
    await scheduler.tick();
    assert.equal(scheduler.runs(failing.id)[0].outcome, "failed");
    assert.equal(
      scheduler.runs(failing.id)[0].detail.error,
      "Provider is not available",
    );
    assert.ok(scheduler.get(failing.id).nextRunAt > clock.now);

    services.flags.set("scheduler.dispatch", false, { workspaceId });
    clock.now += 61_000;
    await scheduler.tick();
    assert.equal(scheduler.runs(failing.id)[0].outcome, "skipped-flag");
    assert.equal(worker.started.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

/* ------------------------------------------------------------------ routes */

function routeCall(services, method, path, bodyValue = null, search = "") {
  const state = { status: 0, data: null };
  const ctx = {
    method,
    path,
    query: new URLSearchParams(search),
    send: (status, data) => {
      state.status = status;
      state.data = data;
    },
    services,
    hub: services.hub,
    db: services.db,
    bus: services.bus,
    actor: "local-user",
    body: async () => bodyValue,
  };
  return scheduleRoutes(ctx).then((handled) => ({ handled, ...state }));
}

test("schedule routes cover create, read, update, enable, run-now, runs, cancel, delete and status", async () => {
  const ctx = setup({ enabled: false });
  try {
    const { services, worker, workspaceId } = ctx;
    assert.equal(
      (await routeCall(services, "GET", `/api/workspaces/${workspaceId}/tasks`))
        .handled,
      false,
    );
    const created = await routeCall(
      services,
      "POST",
      `/api/workspaces/${workspaceId}/schedules`,
      taskSchedule(),
    );
    assert.equal(created.status, 201);
    assert.equal(created.data.enabled, false);
    const id = created.data.id;
    assert.equal(
      (
        await routeCall(
          services,
          "GET",
          `/api/workspaces/${workspaceId}/schedules`,
        )
      ).data.length,
      1,
    );
    assert.equal(
      (await routeCall(services, "GET", `/api/schedules/${id}`)).data.name,
      "Nightly lint",
    );
    const patched = await routeCall(services, "PATCH", `/api/schedules/${id}`, {
      expression: "30 4 * * *",
    });
    assert.equal(patched.data.expression, "30 4 * * *");
    assert.equal(wallClock(patched.data.nextRunAt, NY).hour, 4);
    await assert.rejects(
      () =>
        routeCall(services, "PATCH", `/api/schedules/${id}`, {
          expression: "bad",
        }),
      InputError,
    );
    assert.equal(
      (await routeCall(services, "POST", `/api/schedules/${id}/enable`)).data
        .enabled,
      true,
    );
    assert.equal(
      (await routeCall(services, "POST", `/api/schedules/${id}/disable`)).data
        .enabled,
      false,
    );
    // run-now works without the global opt-in: it is an explicit user action, audited as the actor.
    const ran = await routeCall(
      services,
      "POST",
      `/api/schedules/${id}/run-now`,
    );
    assert.equal(ran.data.outcome, "started");
    assert.equal(worker.started.length, 1);
    assert.equal(audits(services, "schedule.run-now")[0].actor, "local-user");
    assert.equal(
      (await routeCall(services, "GET", `/api/schedules/${id}/runs`)).data[0]
        .outcome,
      "started",
    );
    // The run-now flag is enforced server-side.
    services.flags.set("schedules.runNow", false, { workspaceId });
    await assert.rejects(
      () => routeCall(services, "POST", `/api/schedules/${id}/run-now`),
      /feature flag/,
    );
    const cancelled = await routeCall(
      services,
      "POST",
      `/api/schedules/${id}/cancel`,
    );
    assert.equal(cancelled.data.cancelledRuns.length, 1);
    const status = await routeCall(services, "GET", "/api/scheduler/status");
    assert.equal(status.data.enabled, false);
    assert.equal(status.data.running, false);
    assert.equal(
      (await routeCall(services, "DELETE", `/api/schedules/${id}`)).data
        .deleted,
      true,
    );
    await assert.rejects(
      () => routeCall(services, "GET", `/api/schedules/${id}`),
      /not found/,
    );
  } finally {
    await ctx.cleanup();
  }
});

test("createScheduler attaches services.scheduler and stops its timer on close", async () => {
  const services = createServices({
    demo: false,
    disableObservation: true,
    detect: async () => [],
    optional: false,
  });
  const scheduler = createScheduler(services, { tickMs: 1000 });
  assert.equal(services.scheduler, scheduler);
  assert.ok(scheduler instanceof Scheduler);
  services.settings.set(SETTING_SCHEDULER_ENABLED, true);
  await scheduler.start();
  assert.ok(scheduler.timer);
  await services.close();
  assert.equal(scheduler.timer, null);
});

test("scheduling is turned on and off without a restart, audited, and the setting is public", async () => {
  const ctx = setup({ enabled: false });
  try {
    const { services, scheduler } = ctx;
    // A documented, validated setting the browser can see.
    assert.equal(services.settings.get(SETTING_SCHEDULER_ENABLED), false);
    assert.equal(services.settings.publicSubset()["scheduler.enabled"], false);
    assert.throws(
      () => services.settings.set(SETTING_SCHEDULER_ENABLED, "yes"),
      /true or false/,
    );
    assert.equal(scheduler.timer, null);

    const on = await routeCall(services, "POST", "/api/scheduler/enabled", {
      enabled: true,
    });
    assert.equal(on.status, 200);
    assert.equal(on.data.enabled, true);
    assert.equal(on.data.running, true);
    assert.ok(
      scheduler.timer,
      "the timer starts at once, not at the next boot",
    );
    assert.equal(audits(services, "scheduler.enable")[0].actor, "local-user");

    const off = await routeCall(services, "POST", "/api/scheduler/enabled", {
      enabled: false,
    });
    assert.equal(off.data.enabled, false);
    assert.equal(off.data.running, false);
    assert.equal(scheduler.timer, null);
    assert.equal(audits(services, "scheduler.disable").length, 1);
    await assert.rejects(
      () =>
        routeCall(services, "POST", "/api/scheduler/enabled", {
          enabled: "on",
        }),
      /true or false/,
    );
  } finally {
    ctx.cleanup();
  }
});

test("a schedule's next run times are previewed in its zone without writing anything", async () => {
  const ctx = setup({ enabled: false });
  try {
    const { services } = ctx;
    const before = services.db
      .prepare("SELECT COUNT(*) AS n FROM schedules")
      .get().n;
    const preview = await routeCall(
      services,
      "POST",
      "/api/schedules/preview",
      {
        expression: "0 9 * * 1-5",
        timeZone: NY,
        count: 3,
      },
    );
    assert.equal(preview.status, 200);
    assert.equal(preview.data.occurrences.length, 3);
    for (const at of preview.data.occurrences) {
      const wall = wallClock(at, NY);
      assert.equal(wall.hour, 9);
      assert.equal(wall.minute, 0);
    }
    // Strictly increasing, from the scheduler's clock.
    const [a, b, c] = preview.data.occurrences;
    assert.ok(a > ctx.clock.now && b > a && c > b);
    // Nothing was written.
    assert.equal(
      services.db.prepare("SELECT COUNT(*) AS n FROM schedules").get().n,
      before,
    );
    await assert.rejects(
      () =>
        routeCall(services, "POST", "/api/schedules/preview", {
          expression: "not cron",
          timeZone: NY,
        }),
      InputError,
    );
    await assert.rejects(
      () =>
        routeCall(services, "POST", "/api/schedules/preview", {
          expression: "0 9 * * *",
          timeZone: "Mars/Olympus",
        }),
      /Unknown time zone/,
    );
  } finally {
    ctx.cleanup();
  }
});
