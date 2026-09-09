import test from "node:test";
import assert from "node:assert/strict";
import { createServices } from "../packages/core/src/services.js";
import { RunRecorder } from "../packages/core/src/runs/RunRecorder.js";
import {
  Analytics,
  unionMs,
  toCsv,
  readTokens,
  readCost,
} from "../packages/core/src/analytics/Analytics.js";

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

/** Pins the end time (RunRecorder stamps Date.now(); the test uses a fake clock). */
function endRun(services, runId, endedAt) {
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
