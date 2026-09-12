import test from "node:test";
import assert from "node:assert/strict";
import { createServices } from "../packages/core/src/services.js";
import { RunRecorder } from "../packages/core/src/runs/RunRecorder.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Analytics,
  unionMs,
  toCsv,
  readTokens,
  readCost,
  parseRange,
  subtractIntervals,
  quantile,
} from "../packages/core/src/analytics/Analytics.js";
import { Pricing } from "../packages/core/src/analytics/pricing.js";

const T0 = 1_700_000_000_000;

function setup() {
  const services = createServices({ demo: false });
  const recorder = new RunRecorder(services, { broadcastIntervalMs: 1 });
  services.recorder = recorder;
  const workspace = services.hub.get(
    services.hub.create({ name: "Metrics" }).id,
  );
  const agents = workspace.snapshot().agents;
  return { services, recorder, workspace, agents };
}

/**
 * Pins the end time (RunRecorder stamps Date.now(); the test uses a fake clock)
 * and releases the agent. A completed managed run leaves its task IN_PROGRESS
 * pending review, which keeps the profile busy; a test that starts a second run
 * for the same agent has to close the first task the way accepting a review does.
 */
function endRun(services, runId, endedAt) {
  const run = services.db
    .prepare("SELECT workspace_id, task_id FROM runs WHERE id = ?")
    .get(runId);
  if (run?.task_id) {
    const task = services.db
      .prepare("SELECT status FROM tasks WHERE id = ?")
      .get(run.task_id);
    if (task && task.status !== "COMPLETED")
      services.db
        .prepare(
          "UPDATE tasks SET status = 'COMPLETED', progress = 100, completed_at = ? WHERE id = ?",
        )
        .run(endedAt, run.task_id);
  }
  services.db
    .prepare("UPDATE runs SET ended_at = ? WHERE id = ?")
    .run(endedAt, runId);
  services.db
    .prepare(
      "UPDATE events SET timestamp = ? WHERE run_id = ? AND kind IN ('error', 'complete')",
    )
    .run(endedAt, runId);
}

test("helpers: interval union, csv, usage and cost readers", () => {
  assert.equal(
    unionMs([
      [0, 10],
      [5, 15],
      [20, 25],
    ]),
    20,
  );
  assert.equal(unionMs([]), 0);
  const csv = toCsv([
    { a: 1, b: 'say "hi", ok' },
    { a: null, b: "x" },
  ]);
  assert.equal(csv, 'a,b\r\n1,"say ""hi"", ok"\r\n,x\r\n');
  assert.deepEqual(readTokens({ input_tokens: 5, output_tokens: 2 }), {
    input: 5,
    output: 2,
    reported: true,
  });
  assert.deepEqual(readTokens({ total_token_usage: { input_tokens: 7 } }), {
    input: 7,
    output: null,
    reported: true,
  });
  assert.deepEqual(readTokens({}), {
    input: null,
    output: null,
    reported: false,
  });
  assert.deepEqual(readCost({}, { total_cost_usd: 0.25 }), {
    value: 0.25,
    reported: true,
  });
  assert.deepEqual(readCost({}, {}), { value: null, reported: false });
});

test("summary computes funnel, time breakdown, provider usage, and reported flags from recorded runs", () => {
  const { services, recorder, workspace, agents } = setup();
  const now = T0 + 20_000;
  const analytics = new Analytics(services, { now: () => now });

  // Run 1: observed claude-code run with usage, an approval wait, and an artifact.
  const task1 = workspace.create({ title: "Observed work" });
  const run1 = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agents[0].id,
    mode: "managed",
    provider: "claude-code",
    taskId: task1.id,
    startedAt: T0,
  });
  recorder.applyEvent(run1.id, {
    providerEventId: "r1-e1",
    kind: "tool.start",
    tool: "Edit",
    file: "C:/w/app.js",
    summary: "Editing",
    model: "claude-fable-5-1",
    usage: { input_tokens: 100, output_tokens: 40 },
    timestamp: T0 + 1000,
  });
  recorder.applyEvent(run1.id, {
    kind: "approval.request",
    summary: "Approve?",
    timestamp: T0 + 2000,
  });
  recorder.applyEvent(run1.id, {
    kind: "approval.decision",
    summary: "Approved",
    timestamp: T0 + 5000,
    provenance: "user",
  });
  recorder.addArtifact(run1.id, {
    kind: "diff",
    title: "Patch",
    content: "diff",
  });
  recorder.setStatus(run1.id, "completed");
  endRun(services, run1.id, T0 + 10_000);
  services.db
    .prepare("UPDATE tasks SET review = ?, updated_at = ? WHERE id = ?")
    .run(
      JSON.stringify({
        runId: run1.id,
        status: "accepted",
        decidedAt: T0 + 12_000,
      }),
      T0 + 12_000,
      task1.id,
    );

  // Run 2: codex run, no usage or model, failed; overlaps with run 1.
  const task2 = workspace.create({ title: "Codex work" });
  const run2 = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agents[1].id,
    mode: "managed",
    provider: "codex",
    taskId: task2.id,
    startedAt: T0 + 2000,
  });
  recorder.setStatus(run2.id, "failed", { error: "usage limit" });
  endRun(services, run2.id, T0 + 6000);

  // Run 3: retry of run 2, cancelled, still without an end time in our window.
  const run3 = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agents[1].id,
    mode: "managed",
    provider: "codex",
    taskId: task2.id,
    startedAt: T0 + 7000,
    attempt: 2,
    parentRunId: run2.id,
  });
  services.db
    .prepare("UPDATE tasks SET status = 'IN_PROGRESS' WHERE id = ?")
    .run(task2.id);
  recorder.setStatus(run3.id, "cancelled");
  endRun(services, run3.id, T0 + 9000);

  // Run 4: disconnected without any provider event, never started properly.
  const task3 = workspace.create({ title: "Lost" });
  const run4 = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agents[2].id,
    mode: "managed",
    provider: "copilot",
    taskId: task3.id,
    startedAt: T0 + 15_000,
  });
  recorder.setStatus(run4.id, "disconnected");
  endRun(services, run4.id, T0 + 16_000);

  const summary = analytics.summary({ workspaceId: workspace.id });
  assert.deepEqual(summary.funnel, {
    created: 3,
    dispatched: 4,
    started: 1,
    artifact: 1,
    reviewed: 1,
    accepted: 1,
  });
  assert.equal(summary.units.created, "tasks");

  // Run 1: running 0-2000, waiting 2000-5000, running 5000-10000.
  assert.equal(summary.time.waitingApprovalMs, 3000);
  // Sum: run1 7000 + run2 4000 + run3 2000 + run4 1000 = 14000.
  assert.equal(summary.time.executingMs, 14_000);
  // Wall clock merges run1 [0,2000]+[5000,10000] with run2 [2000,6000], run3 [7000,9000], run4 [15000,16000].
  assert.equal(summary.time.wallClock.executingMs, 11_000);
  assert.equal(summary.time.wallClock.spanMs, 16_000);
  assert.equal(summary.time.reviewingMs, 2000);
  assert.match(summary.time.note, /wallClock merges/);

  const claude = summary.byProvider.find((p) => p.provider === "claude-code");
  assert.equal(claude.runs, 1);
  assert.equal(claude.completed, 1);
  assert.deepEqual(claude.tokens, { input: 100, output: 40, reported: true });
  assert.deepEqual(claude.costUsd, {
    value: null,
    reported: false,
    estimated: false,
  });
  const codex = summary.byProvider.find((p) => p.provider === "codex");
  assert.equal(codex.runs, 2);
  assert.equal(codex.failed, 1);
  assert.equal(codex.cancelled, 1);
  assert.equal(codex.retries, 1);
  assert.equal(codex.tokens.reported, false);
  const copilot = summary.byProvider.find((p) => p.provider === "copilot");
  assert.equal(copilot.disconnected, 1);

  const model = summary.byModel.find((m) => m.model === "claude-fable-5-1");
  assert.equal(model.runs, 1);
  assert.equal(model.reported, true);
  assert.equal(summary.byModel.find((m) => m.model === "unknown").runs, 3);
  assert.equal(summary.byWorkspace[0].workspaceId, workspace.id);
  assert.equal(summary.byWorkspace[0].runs, 4);

  assert.equal(summary.reliability.disconnects, 1);
  assert.equal(summary.reliability.cancellations, 1);
  // Observed on this machine: the Analytics "Failed runs" tile said "—"
  // under a "counted" label, because failures were never counted.
  assert.equal(summary.reliability.failures, 1);
  assert.equal(summary.reliability.retries, 1);
  assert.deepEqual(summary.reliability.retryReasons, { "usage limit": 1 });
  assert.deepEqual(summary.dataQuality, {
    usageMissingRuns: 3,
    modelUnknownRuns: 3,
    runsWithoutEvents: 0,
  });
  assert.equal(summary.rows.length, 4);
  const row1 = summary.rows.find((r) => r.runId === run1.id);
  assert.equal(row1.usageReported, true);
  assert.equal(row1.costReported, false);
  assert.equal(row1.costUsd, null);
  assert.equal(row1.reviewStatus, "accepted");
  assert.equal(row1.taskTitle, "Observed work");

  // Blocked heatmap: task2 became blocked when run 2 failed until run 3 started.
  const cell = summary.blockedHeatmap.find((c) => c.taskId === task2.id);
  assert.ok(cell);
  assert.equal(
    cell.hour,
    new Date(
      services.db
        .prepare(
          "SELECT timestamp FROM events WHERE run_id = ? AND kind = 'error'",
        )
        .get(run2.id).timestamp,
    ).getHours(),
  );
  assert.ok(cell.blockedMs > 0);

  // Filters: since excludes older runs; unknown workspace is a 404.
  assert.equal(
    analytics.summary({ workspaceId: workspace.id, since: T0 + 14_000 }).funnel
      .dispatched,
    1,
  );
  assert.throws(() => analytics.summary({ workspaceId: "ghost" }), /not found/);
  // Global scope includes this workspace.
  assert.equal(
    analytics.summary().byWorkspace.some((w) => w.workspaceId === workspace.id),
    true,
  );

  // Export.
  const csv = analytics.export("csv", { workspaceId: workspace.id });
  assert.equal(csv.rows, 4);
  assert.match(
    csv.body.split("\r\n")[0],
    /^runId,workspaceId,taskId,taskTitle,provider/,
  );
  assert.equal(csv.body.trim().split("\r\n").length, 5);
  const json = analytics.export("json", { workspaceId: workspace.id });
  assert.equal(JSON.parse(json.body).rows.length, 4);
  assert.throws(() => analytics.export("xml"), /csv or json/);
});

test("cost is only estimated when a pricing table is supplied, and stays labelled", () => {
  const { services, recorder, workspace, agents } = setup();
  const task = workspace.create({ title: "Priced" });
  const run = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agents[0].id,
    mode: "managed",
    provider: "claude-code",
    taskId: task.id,
    startedAt: T0,
  });
  recorder.applyEvent(run.id, {
    kind: "usage",
    summary: "usage",
    model: "claude-fable-5-1",
    usage: { input_tokens: 1_000_000, output_tokens: 500_000 },
    timestamp: T0 + 10,
  });
  const plain = new Analytics(services, { now: () => T0 + 100 }).summary({
    workspaceId: workspace.id,
  });
  assert.deepEqual(plain.byProvider[0].costUsd, {
    value: null,
    reported: false,
    estimated: false,
  });
  const priced = new Analytics(services, {
    now: () => T0 + 100,
    pricing: {
      "claude-fable-5-1": { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
    },
  }).summary({ workspaceId: workspace.id });
  assert.equal(priced.byProvider[0].costUsd.value, 10.5);
  assert.equal(priced.byProvider[0].costUsd.reported, false);
  assert.equal(priced.byProvider[0].costUsd.estimated, true);
  assert.equal(priced.rows[0].costEstimatedUsd, 10.5);
  assert.equal(priced.rows[0].costReported, false);

  // Provider-reported cost wins over any estimate.
  recorder.update(run.id, { cost: { total_usd: 0.42 } });
  const reported = new Analytics(services, {
    now: () => T0 + 100,
    pricing: {
      "claude-fable-5-1": { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
    },
  }).summary({ workspaceId: workspace.id });
  assert.deepEqual(reported.byProvider[0].costUsd, {
    value: 0.42,
    reported: true,
    estimated: false,
  });
});

test("provider tool payloads with status 'completed' do not end the run timeline", () => {
  const { services, recorder, workspace, agents } = setup();
  const analytics = new Analytics(services, { now: () => T0 + 7_200_000 });
  const task = workspace.create({ title: "Codex patch" });
  const run = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agents[0].id,
    mode: "observed",
    provider: "codex",
    taskId: task.id,
    startedAt: T0,
  });
  // Codex apply_patch items carry item status "completed" in their data.
  recorder.applyEvent(run.id, {
    kind: "tool.start",
    tool: "apply_patch",
    summary: "Applied patch to a.js",
    timestamp: T0 + 60_000,
    provenance: "provider",
    data: { status: "completed" },
  });
  recorder.applyEvent(run.id, {
    kind: "command",
    tool: "exec_command",
    summary: "Ran: npm test",
    timestamp: T0 + 3_600_000,
    provenance: "provider",
  });
  const row = analytics
    .summary({ workspaceId: workspace.id })
    .rows.find((r) => r.runId === run.id);
  assert.equal(row.durationMs, 7_200_000);
  assert.equal(row.executingMs, 7_200_000, "timeline runs to now");
});

// --------------------------------------------------------------------------
// Wave 2 (roadmap §15): range parsing, provider vs human waiting, grouping by
// workflow and accepted result, availability/saturation, drill-down,
// forecasts, pricing, saved views, scheduled reports, OTLP-shaped export.
// --------------------------------------------------------------------------

test("range accepts ISO strings and epoch milliseconds alike", () => {
  assert.equal(parseRange(T0), T0);
  assert.equal(parseRange(String(T0)), T0);
  assert.equal(parseRange(new Date(T0).toISOString()), T0);
  assert.equal(parseRange("2026-09-01"), Date.parse("2026-09-01"));
  assert.equal(parseRange(""), 0);
  assert.equal(parseRange(null), 0);
  assert.equal(parseRange("not a date"), 0);
  assert.equal(parseRange(-5), 0);
  assert.deepEqual(
    subtractIntervals(
      [
        [0, 10],
        [20, 30],
      ],
      [[5, 25]],
    ),
    [
      [0, 5],
      [25, 30],
    ],
  );
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(quantile([], 0.5), null);

  // The bug this fixes: an ISO range start used to become 0 ("all time").
  const { services, recorder, workspace, agents } = setup();
  const task = workspace.create({ title: "Ranged" });
  recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agents[0].id,
    mode: "managed",
    provider: "claude-code",
    taskId: task.id,
    startedAt: T0,
  });
  const analytics = new Analytics(services, { now: () => T0 + 60_000 });
  const iso = new Date(T0 + 30_000).toISOString();
  assert.equal(
    analytics.summary({ workspaceId: workspace.id, since: iso }).funnel
      .dispatched,
    0,
    "an ISO since must exclude the older run",
  );
  assert.equal(
    analytics.summary({ workspaceId: workspace.id, since: iso }).scope.since,
    T0 + 30_000,
  );
  assert.equal(
    analytics.summary({ workspaceId: workspace.id, since: T0 - 1 }).funnel
      .dispatched,
    1,
  );
});

test("waiting for the provider is separate from waiting for a human", () => {
  const { services, recorder, workspace, agents } = setup();
  const task = workspace.create({ title: "Waiting" });
  const run = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agents[0].id,
    mode: "managed",
    provider: "claude-code",
    taskId: task.id,
    startedAt: T0,
  });
  // Tool call the provider answered: 1000 -> 4000.
  recorder.applyEvent(run.id, {
    kind: "command",
    tool: "Bash",
    summary: "Ran: npm test",
    timestamp: T0 + 1000,
  });
  recorder.applyEvent(run.id, {
    kind: "tool.end",
    tool: "Bash",
    summary: "Done",
    timestamp: T0 + 4000,
  });
  // Human wait: 5000 -> 7000.
  recorder.applyEvent(run.id, {
    kind: "approval.request",
    summary: "Approve?",
    timestamp: T0 + 5000,
  });
  recorder.applyEvent(run.id, {
    kind: "approval.decision",
    summary: "Approved",
    timestamp: T0 + 7000,
    provenance: "user",
  });
  // Tool the provider never finished: 8000 -> last event (10000).
  recorder.applyEvent(run.id, {
    kind: "tool.start",
    tool: "Edit",
    file: "C:/w/a.js",
    summary: "Editing",
    timestamp: T0 + 8000,
  });
  recorder.setStatus(run.id, "completed");
  endRun(services, run.id, T0 + 10_000);

  const summary = new Analytics(services, { now: () => T0 + 20_000 }).summary({
    workspaceId: workspace.id,
  });
  assert.equal(summary.time.waitingForProviderMs, 3000 + 2000);
  assert.equal(summary.time.waitingForHumanMs, 2000);
  assert.equal(summary.time.waitingApprovalMs, 2000);
  assert.equal(summary.rows[0].waitingForProviderMs, 5000);
  assert.match(summary.time.waitingNote, /human approval waits removed/);
});

test("a tool call spanning an approval does not count the human wait as provider time", () => {
  const { services, recorder, workspace, agents } = setup();
  const task = workspace.create({ title: "Overlap" });
  const run = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agents[0].id,
    mode: "managed",
    provider: "codex",
    taskId: task.id,
    startedAt: T0,
  });
  recorder.applyEvent(run.id, {
    kind: "command",
    tool: "exec_command",
    summary: "Ran: build",
    timestamp: T0 + 1000,
  });
  recorder.applyEvent(run.id, {
    kind: "approval.request",
    summary: "Approve?",
    timestamp: T0 + 2000,
  });
  recorder.applyEvent(run.id, {
    kind: "approval.decision",
    summary: "Approved",
    timestamp: T0 + 5000,
    provenance: "user",
  });
  recorder.applyEvent(run.id, {
    kind: "tool.end",
    tool: "exec_command",
    summary: "Done",
    timestamp: T0 + 6000,
  });
  recorder.setStatus(run.id, "completed");
  endRun(services, run.id, T0 + 7000);
  const summary = new Analytics(services, { now: () => T0 + 9000 }).summary({
    workspaceId: workspace.id,
  });
  // [1000,6000] is 5000 ms, of which [2000,5000] was a human wait.
  assert.equal(summary.time.waitingForProviderMs, 2000);
  assert.equal(summary.time.waitingForHumanMs, 3000);
});

test("cost and tokens group by workflow and by accepted result", () => {
  const { services, recorder, workspace, agents } = setup();
  const accepted = workspace.create({ title: "Accepted" });
  const rejected = workspace.create({ title: "Rejected" });
  services.db
    .prepare("UPDATE tasks SET workflow_id = ? WHERE id = ?")
    .run("wf-1", accepted.id);
  const runA = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agents[0].id,
    mode: "managed",
    provider: "claude-code",
    taskId: accepted.id,
    startedAt: T0,
  });
  recorder.applyEvent(runA.id, {
    kind: "usage",
    summary: "usage",
    model: "claude-fable-5-1",
    usage: { input_tokens: 200, output_tokens: 100 },
    timestamp: T0 + 100,
  });
  recorder.setStatus(runA.id, "completed");
  endRun(services, runA.id, T0 + 1000);
  services.db
    .prepare("UPDATE tasks SET review = ?, updated_at = ? WHERE id = ?")
    .run(
      JSON.stringify({
        runId: runA.id,
        status: "accepted",
        decidedAt: T0 + 2000,
      }),
      T0 + 2000,
      accepted.id,
    );

  const runB = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agents[1].id,
    mode: "managed",
    provider: "codex",
    taskId: rejected.id,
    startedAt: T0 + 100,
  });
  recorder.setStatus(runB.id, "completed");
  endRun(services, runB.id, T0 + 1500);
  services.db
    .prepare("UPDATE tasks SET review = ?, updated_at = ? WHERE id = ?")
    .run(
      JSON.stringify({
        runId: runB.id,
        status: "rejected",
        decidedAt: T0 + 2500,
      }),
      T0 + 2500,
      rejected.id,
    );

  const summary = new Analytics(services, { now: () => T0 + 5000 }).summary({
    workspaceId: workspace.id,
  });
  const wf = summary.byWorkflow.find((row) => row.workflowId === "wf-1");
  assert.equal(wf.runs, 1);
  assert.deepEqual(wf.tokens, { input: 200, output: 100, reported: true });
  const noWorkflow = summary.byWorkflow.find((row) => row.workflowId === null);
  assert.equal(noWorkflow.runs, 1);
  assert.equal(noWorkflow.reported, false);

  const acceptedGroup = summary.byAcceptedResult.find(
    (row) => row.reviewStatus === "accepted",
  );
  assert.equal(acceptedGroup.runs, 1);
  assert.equal(acceptedGroup.tokens.input, 200);
  assert.equal(
    summary.byAcceptedResult.find((row) => row.reviewStatus === "rejected")
      .runs,
    1,
  );
  assert.equal(
    summary.rows.find((r) => r.runId === runA.id).workflowId,
    "wf-1",
  );
});

test("availability, disconnects, cancellation acknowledgement, and saturation arithmetic", () => {
  const { services, recorder, workspace, agents } = setup();
  const task = workspace.create({ title: "Reliability" });
  const make = (provider, startedAt, status, endedAt, agent = 0) => {
    const run = recorder.ensureRun({
      workspaceId: workspace.id,
      agentId: agents[agent].id,
      mode: "managed",
      provider,
      taskId: task.id,
      startedAt,
    });
    recorder.setStatus(run.id, status);
    endRun(services, run.id, endedAt);
    return run;
  };
  // Two overlapping claude runs: [0,10000] and [2000,6000] -> limit 2 reached.
  make("claude-code", T0, "completed", T0 + 10_000);
  make("claude-code", T0 + 2000, "failed", T0 + 6000, 1);
  make("claude-code", T0 + 20_000, "disconnected", T0 + 21_000, 2);
  const cancelled = make("codex", T0 + 30_000, "cancelled", T0 + 30_500);

  const summary = new Analytics(services, { now: () => T0 + 40_000 }).summary({
    workspaceId: workspace.id,
  });
  const claude = summary.reliability.availability.byProvider.find(
    (row) => row.provider === "claude-code",
  );
  assert.equal(claude.attempts, 3);
  assert.equal(claude.successes, 1);
  assert.equal(claude.availability, 1 / 3);
  assert.equal(claude.disconnectFrequency, 1 / 3);
  const codex = summary.reliability.availability.byProvider.find(
    (row) => row.provider === "codex",
  );
  assert.equal(codex.availability, 0, "no successes is 0, never null");
  assert.equal(summary.reliability.disconnectFrequency.perRun, 1 / 4);
  assert.deepEqual(
    {
      requested: summary.reliability.cancellationAcknowledgement.requested,
      acknowledged:
        summary.reliability.cancellationAcknowledgement.acknowledged,
      rate: summary.reliability.cancellationAcknowledgement.rate,
    },
    { requested: 1, acknowledged: 1, rate: 1 },
  );
  assert.ok(cancelled.id);

  const saturation = summary.reliability.saturation.byWorkspace[0];
  assert.equal(saturation.limit, 2);
  assert.equal(saturation.maxConcurrent, 2);
  assert.equal(saturation.saturatedMs, 4000);
  assert.equal(saturation.spanMs, 30_500);
  assert.equal(saturation.atOrOverLimit, true);
  assert.ok(saturation.utilization > 0 && saturation.utilization < 1);
  assert.equal(saturation.windows[0].runIds.length, 2);

  // Division by zero: an empty scope reports null rates, never NaN.
  const empty = services.hub.get(services.hub.create({ name: "Empty" }).id);
  const none = new Analytics(services, { now: () => T0 }).summary({
    workspaceId: empty.id,
  });
  assert.equal(none.reliability.disconnectFrequency.perRun, null);
  assert.equal(none.reliability.cancellationAcknowledgement.rate, null);
  assert.deepEqual(none.reliability.saturation.byWorkspace, []);
  assert.deepEqual(none.reliability.availability.byProvider, []);
});

test("heatmap cells carry the run and task ids behind them, and drill-down resolves them", () => {
  const { services, recorder, workspace, agents } = setup();
  const task = workspace.create({ title: "Drillable" });
  const run = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agents[0].id,
    mode: "managed",
    provider: "copilot",
    taskId: task.id,
    startedAt: T0,
  });
  recorder.setStatus(run.id, "completed");
  endRun(services, run.id, T0 + 1000);
  const summary = new Analytics(services, { now: () => T0 + 2000 }).summary({
    workspaceId: workspace.id,
  });
  const cell = summary.workloadHeatmap[0];
  assert.deepEqual(cell.runIds, [run.id]);
  assert.deepEqual(cell.taskIds, [task.id]);
  const detail = new Analytics(services, { now: () => T0 }).drillDown({
    runIds: cell.runIds,
    taskIds: cell.taskIds,
  });
  assert.equal(detail.runs[0].runId, run.id);
  assert.equal(detail.runs[0].provider, "copilot");
  assert.equal(detail.tasks[0].title, "Drillable");
});

test("forecasts stay unavailable under five samples and are bounded above it", () => {
  const { services, recorder, workspace, agents } = setup();
  const task = workspace.create({ title: "Forecast" });
  const complete = (index) => {
    const run = recorder.ensureRun({
      workspaceId: workspace.id,
      agentId: agents[index % agents.length].id,
      mode: "managed",
      provider: "claude-code",
      taskId: task.id,
      startedAt: T0 + index * 100_000,
    });
    recorder.setStatus(run.id, "completed");
    endRun(services, run.id, T0 + index * 100_000 + (index + 1) * 1000);
  };
  for (let i = 0; i < 4; i++) complete(i);
  const analytics = new Analytics(services, { now: () => T0 + 1_000_000 });
  const short = analytics.forecast({ workspaceId: workspace.id });
  assert.equal(short.available, false);
  assert.equal(short.sampleSize, 4);
  assert.match(short.reason, /at least 5/);

  for (let i = 4; i < 8; i++) complete(i);
  const forecast = analytics.forecast({ workspaceId: workspace.id });
  assert.equal(forecast.available, true);
  assert.equal(forecast.sampleSize, 8);
  assert.ok(forecast.low <= forecast.estimate);
  assert.ok(forecast.estimate <= forecast.high);
  assert.equal(forecast.low, 1700);
  assert.equal(forecast.high, 7300);
  assert.ok(forecast.assumptions.length >= 3);
  assert.match(forecast.confidence.interval, /p10/);
  assert.ok(forecast.capacity.available);
  assert.throws(
    () => analytics.forecast({ workspaceId: workspace.id, metric: "vibes" }),
    /metric must be one of/,
  );
  // A metric nothing reports stays unavailable rather than guessing zero.
  assert.equal(
    analytics.forecast({ workspaceId: workspace.id, metric: "costUsd" })
      .available,
    false,
  );
});

test("without pricing cost is null with a reason; configured pricing is versioned and estimated", () => {
  const { services } = setup();
  const bare = new Pricing(services);
  assert.deepEqual(bare.estimateCost({ input_tokens: 1000 }, "some-model"), {
    value: null,
    currency: null,
    reported: false,
    estimated: false,
    reason: "no pricing configured",
  });
  assert.equal(bare.table().configured, false);

  const configured = new Pricing(services).configure({
    "claude-fable-5-1": {
      inputPer1k: 0.003,
      outputPer1k: 0.015,
      currency: "USD",
      source: "vendor price page",
      version: "2026-09-01",
    },
  });
  assert.equal(configured.configured, true);
  const pricing = new Pricing(services);
  const estimate = pricing.estimateCost(
    { input_tokens: 1000, output_tokens: 1000 },
    "claude-fable-5-1",
  );
  assert.equal(estimate.value, 0.018);
  assert.equal(estimate.estimated, true);
  assert.equal(estimate.reported, false);
  assert.equal(estimate.pricingVersion, "2026-09-01");
  assert.ok(
    estimate.assumptions.some((line) => /vendor price page/.test(line)),
  );

  // Provider-reported cost always wins and is marked reported.
  const reported = pricing.costFor({
    usage: { input_tokens: 1000, output_tokens: 1000 },
    cost: { total_usd: 0.42 },
    model: "claude-fable-5-1",
  });
  assert.deepEqual(reported, {
    value: 0.42,
    currency: "USD",
    reported: true,
    estimated: false,
    source: "provider",
  });
  // An entry without an explicit version is refused.
  assert.throws(
    () => new Pricing(services).configure({ m: { inputPer1k: 1 } }),
    /explicit version/,
  );
  // Reported usage is still required before anything is estimated.
  assert.equal(pricing.estimateCost({}, "claude-fable-5-1").estimated, false);
});

test("saved views and scheduled reports are stored, and a report writes a file locally", () => {
  const { services, recorder, workspace, agents } = setup();
  const analytics = new Analytics(services, { now: () => T0 });
  const task = workspace.create({ title: "Reported" });
  const run = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agents[0].id,
    mode: "managed",
    provider: "claude-code",
    taskId: task.id,
    startedAt: T0,
  });
  recorder.setStatus(run.id, "completed");
  endRun(services, run.id, T0 + 1000);

  const view = analytics.views.create({
    name: "Last week, Claude only",
    workspaceId: workspace.id,
    filters: { provider: "claude-code", since: T0 },
  });
  assert.equal(view.name, "Last week, Claude only");
  assert.equal(analytics.views.list({ workspaceId: workspace.id }).length, 1);
  assert.equal(
    analytics.views.update(view.id, { name: "Renamed" }).name,
    "Renamed",
  );
  assert.throws(() => analytics.views.create({ name: "  " }), /needs a name/);
  assert.deepEqual(analytics.views.remove(view.id), {
    id: view.id,
    deleted: true,
  });
  assert.throws(() => analytics.views.get(view.id), /not found/);

  const dir = mkdtempSync(join(tmpdir(), "agent-space-reports-"));
  try {
    const report = analytics.reports.create({
      name: "Weekly rollup",
      workspaceId: workspace.id,
      format: "csv",
      cadence: "daily",
      outputDir: dir,
    });
    assert.equal(report.enabled, false, "reports are disabled by default");
    assert.equal(report.nextRunAt, T0 + 24 * 60 * 60 * 1000);
    // Disabled reports are never due.
    assert.deepEqual(analytics.reports.runDue(T0 + 10 * 24 * 3600 * 1000), []);
    const written = analytics.reports.run(report.id);
    assert.equal(written.rows, 1);
    assert.ok(existsSync(written.file));
    assert.match(readFileSync(written.file, "utf8"), /^runId,/);
    assert.equal(analytics.reports.get(report.id).lastRunAt, T0);
    assert.equal(
      analytics.reports.update(report.id, { enabled: true }).enabled,
      true,
    );
    assert.equal(
      analytics.reports.runDue(T0 + 10 * 24 * 3600 * 1000).length,
      1,
    );
    assert.throws(
      () => analytics.reports.create({ name: "No dir", outputDir: "" }),
      /output directory/,
    );
    assert.throws(
      () =>
        analytics.reports.create({
          name: "Bad cadence",
          cadence: "fortnightly",
          outputDir: dir,
        }),
      /cadence must be one of/,
    );
    analytics.reports.remove(report.id);
    assert.deepEqual(analytics.reports.list(), []);
    // The cadence timer is unref'd and stoppable.
    assert.equal(analytics.reports.start({ intervalMs: 60_000 }).running, true);
    assert.equal(analytics.reports.stop().running, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the OpenTelemetry-shaped export excludes prompts by default and says so", () => {
  const { services, recorder, workspace, agents } = setup();
  const task = workspace.create({ title: "Traced" });
  const run = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agents[0].id,
    mode: "managed",
    provider: "claude-code",
    taskId: task.id,
    startedAt: T0,
  });
  recorder.applyEvent(run.id, {
    kind: "prompt",
    summary: "SECRET-PROMPT-TEXT",
    timestamp: T0 + 100,
  });
  recorder.applyEvent(run.id, {
    kind: "tool.start",
    tool: "Edit",
    file: "C:/w/private.js",
    summary: "SECRET-PROMPT-TEXT",
    model: "claude-fable-5-1",
    usage: { input_tokens: 10, output_tokens: 5 },
    timestamp: T0 + 200,
  });
  recorder.setStatus(run.id, "completed");
  endRun(services, run.id, T0 + 1000);

  const analytics = new Analytics(services, { now: () => T0 + 2000 });
  const doc = analytics.otlpExport({ workspaceId: workspace.id });
  const text = JSON.stringify(doc);
  assert.equal(doc.privacy.promptsIncluded, false);
  assert.ok(doc.privacy.omitted.includes("gen_ai.prompt"));
  assert.doesNotMatch(text, /SECRET-PROMPT-TEXT/);
  assert.doesNotMatch(text, /private\.js/);
  const spans = doc.resourceSpans[0].scopeSpans[0].spans;
  const runSpan = spans.find((span) => span.name === "run claude-code");
  const attrs = Object.fromEntries(
    runSpan.attributes.map((a) => [
      a.key,
      a.value.stringValue ?? a.value.intValue ?? a.value.doubleValue,
    ]),
  );
  assert.equal(attrs["gen_ai.system"], "claude-code");
  assert.equal(attrs["gen_ai.request.model"], undefined);
  assert.equal(attrs["gen_ai.response.model"], "claude-fable-5-1");
  assert.equal(attrs["gen_ai.usage.input_tokens"], "10");
  assert.equal(attrs["gen_ai.usage.output_tokens"], "5");
  const toolSpan = spans.find((span) => span.name === "tool Edit");
  assert.equal(toolSpan.parentSpanId, runSpan.spanId);
  assert.equal(toolSpan.traceId, runSpan.traceId);

  const opted = analytics.otlpExport({
    workspaceId: workspace.id,
    includeAttributes: { prompts: true, files: true },
  });
  assert.equal(opted.privacy.promptsIncluded, true);
  assert.match(JSON.stringify(opted), /SECRET-PROMPT-TEXT/);
});

test("byRole groups runs by the frozen agent snapshot role with reported flags", () => {
  const { services, recorder, workspace, agents } = setup();
  const roleOf = (agent) => agent.role;
  const taskA = workspace.create({ title: "Design" });
  const taskB = workspace.create({ title: "Design again" });
  const taskC = workspace.create({ title: "Build" });
  const runA = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agents[0].id,
    mode: "managed",
    provider: "claude-code",
    taskId: taskA.id,
    startedAt: T0,
  });
  recorder.applyEvent(runA.id, {
    kind: "usage",
    summary: "usage",
    model: "claude-fable-5-1",
    usage: { input_tokens: 300, output_tokens: 50, total_cost_usd: 0.5 },
    timestamp: T0 + 100,
  });
  recorder.setStatus(runA.id, "completed");
  endRun(services, runA.id, T0 + 1000);
  const runB = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agents[0].id,
    mode: "managed",
    provider: "codex",
    taskId: taskB.id,
    startedAt: T0 + 200,
  });
  recorder.setStatus(runB.id, "failed");
  endRun(services, runB.id, T0 + 1200);
  const runC = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agents[1].id,
    mode: "managed",
    provider: "claude-code",
    taskId: taskC.id,
    startedAt: T0 + 300,
  });
  recorder.setStatus(runC.id, "completed");
  endRun(services, runC.id, T0 + 1300);
  // A run whose snapshot lost its role (or is unparsable) lands in 'unspecified'.
  services.db
    .prepare("UPDATE runs SET agent_snapshot = ? WHERE id = ?")
    .run("{not json", runC.id);

  const analytics = new Analytics(services, { now: () => T0 + 5000 });
  const summary = analytics.summary({ workspaceId: workspace.id });
  const architect = summary.byRole.find(
    (row) => row.role === roleOf(agents[0]),
  );
  assert.ok(architect, "grouped by the agent's role");
  assert.equal(architect.reported, true);
  assert.equal(architect.runs, 2);
  assert.equal(architect.completed, 1);
  assert.equal(architect.failed, 1);
  assert.equal(architect.cancelled, 0);
  assert.equal(architect.disconnected, 0);
  assert.equal(architect.retries, 0);
  assert.deepEqual(architect.tokens, {
    input: 300,
    output: 50,
    reported: true,
  });
  assert.deepEqual(architect.costUsd, {
    value: 0.5,
    reported: true,
    estimated: false,
  });
  const unspecified = summary.byRole.find((row) => row.role === "unspecified");
  assert.equal(unspecified.runs, 1);
  assert.equal(unspecified.reported, false);
  assert.deepEqual(unspecified.tokens, {
    input: 0,
    output: 0,
    reported: false,
  });
  assert.deepEqual(unspecified.costUsd, {
    value: null,
    reported: false,
    estimated: false,
  });
  assert.deepEqual(
    Object.keys(architect).sort(),
    Object.keys(summary.byProvider[0])
      .filter((k) => k !== "provider")
      .concat("role", "reported")
      .sort(),
    "same shape as byProvider (plus the reported flag)",
  );

  // Rows and both export formats carry the role.
  assert.equal(
    summary.rows.find((r) => r.runId === runA.id).role,
    roleOf(agents[0]),
  );
  assert.equal(
    summary.rows.find((r) => r.runId === runC.id).role,
    "unspecified",
  );
  const csv = analytics.export("csv", { workspaceId: workspace.id });
  assert.ok(csv.body.split("\r\n")[0].endsWith(",role"));
  assert.ok(csv.body.includes(roleOf(agents[0])));
  const json = JSON.parse(
    analytics.export("json", { workspaceId: workspace.id }).body,
  );
  assert.equal(
    json.rows.find((r) => r.runId === runB.id).role,
    roleOf(agents[0]),
  );
});
