import test from "node:test";
import assert from "node:assert/strict";
import {
  SCHEDULE_PRESETS,
  draftProblems,
  formatInZone,
  presetFor,
  scheduleBody,
  scheduleDraft,
  scheduleOutcome,
  scheduleState,
} from "../apps/web/src/hooks/scheduleLogic.js";

/**
 * The Schedules page words what the scheduler recorded, and never says a
 * schedule will run when scheduling as a whole is off.
 */

test("a schedule's state says which of the two switches is off", () => {
  const on = { enabled: true };
  const off = { enabled: false };
  assert.equal(scheduleState({ enabled: true }, on).key, "enabled");
  // Enabled, but scheduling is off: it will not start on its timer.
  const waiting = scheduleState({ enabled: true }, off);
  assert.equal(waiting.key, "waiting");
  assert.match(waiting.label, /scheduling is off/);
  assert.equal(scheduleState({ enabled: false }, on).key, "disabled");
  assert.equal(
    scheduleState({ enabled: false, cancelledAt: 5 }, on).key,
    "cancelled",
  );
});

test("recorded decisions read as words, from a history row or a last result", () => {
  assert.equal(scheduleOutcome({ outcome: "started" }).label, "Started");
  // History rows nest the detail; a schedule's lastResult spreads it.
  assert.equal(
    scheduleOutcome({ outcome: "started", detail: { manual: true } }).label,
    "Started by hand",
  );
  assert.equal(
    scheduleOutcome({ outcome: "started", manual: true }).label,
    "Started by hand",
  );
  const failed = scheduleOutcome({
    outcome: "failed",
    detail: { error: "Provider is not available" },
  });
  assert.equal(failed.tone, "bad");
  assert.equal(failed.detail.text, "Provider is not available");
  assert.equal(
    scheduleOutcome({ outcome: "failed", error: "no agent" }).detail.text,
    "no agent",
  );
  const deferred = scheduleOutcome({
    outcome: "skipped-quiet",
    detail: { deferredTo: 1000 },
  });
  assert.equal(deferred.label, "Moved past quiet hours");
  assert.equal(deferred.detail.at, 1000);
  assert.equal(
    scheduleOutcome({ outcome: "skipped-missed" }).label,
    "Missed while scheduling was off",
  );
  assert.match(scheduleOutcome({ outcome: "queued" }).label, /free slot/);
});

test("times are shown in the schedule's own zone", () => {
  const at = Date.UTC(2026, 8, 14, 13, 0); // 09:00 in New York (EDT)
  const text = formatInZone(at, "America/New_York", "en-GB");
  assert.match(text, /09:00/);
  assert.match(text, /GMT-4|EDT/);
  // An unknown zone falls back instead of throwing.
  assert.ok(formatInZone(at, "Mars/Olympus", "en-GB"));
  assert.equal(formatInZone(null, "UTC"), null);
});

test("the form sends what the server validates, and names what is missing", () => {
  const draft = scheduleDraft();
  assert.equal(draft.kind, "task");
  assert.equal(presetFor(draft.expression), "weekdays-9");
  assert.equal(presetFor("*/7 * * * *"), "custom");
  assert.ok(SCHEDULE_PRESETS.every((preset) => preset.expression));
  assert.deepEqual(draftProblems(draft), [
    "Give the schedule a name.",
    "Name the task it creates.",
  ]);

  const task = {
    ...draft,
    name: "  Nightly check ",
    target: " Check dependencies ",
    prompt: "",
    provider: "claude-code",
    quiet: true,
    quietStart: "22:00",
    quietEnd: "06:00",
    maxConcurrent: 99,
  };
  assert.deepEqual(draftProblems(task), []);
  const body = scheduleBody(task);
  assert.equal(body.name, "Nightly check");
  assert.equal(body.target, "Check dependencies");
  // An empty prompt is not sent; the provider is.
  assert.deepEqual(body.definition, { provider: "claude-code" });
  assert.deepEqual(body.quietHours, { start: "22:00", end: "06:00" });
  assert.equal(body.maxConcurrent, 20, "clamped to what the server accepts");

  // A workflow needs its template's inputs.
  const template = { id: "bug-clinic", inputKeys: ["issue"] };
  const workflow = {
    ...draft,
    name: "Weekly clinic",
    kind: "workflow",
    target: "bug-clinic",
    inputs: {},
  };
  assert.deepEqual(draftProblems(workflow, template), [
    'The workflow needs a value for "issue".',
  ]);
  workflow.inputs = { issue: " Flaky login test ", stray: "x" };
  assert.deepEqual(scheduleBody(workflow, template).definition, {
    inputs: { issue: "Flaky login test" },
  });
  // Quiet hours that start and end together are refused before sending.
  assert.ok(
    draftProblems({ ...task, quietEnd: "22:00" }).some((p) =>
      p.includes("Quiet hours"),
    ),
  );
  // Editing keeps what the schedule has.
  const edited = scheduleDraft({
    name: "Nightly",
    kind: "task",
    target: "Lint",
    definition: { prompt: "Run lint", provider: "codex" },
    expression: "0 2 * * *",
    timeZone: "Asia/Kolkata",
    quietHours: null,
    overlapPolicy: "queue",
    maxConcurrent: 2,
    missedRunPolicy: "run-once",
    catchUpLimit: 3,
  });
  assert.equal(edited.prompt, "Run lint");
  assert.equal(edited.quiet, false);
  assert.equal(presetFor(edited.expression), "nightly-2");
  assert.equal(edited.overlapPolicy, "queue");
});
