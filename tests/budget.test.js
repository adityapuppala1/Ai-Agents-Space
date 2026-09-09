import test from "node:test";
import assert from "node:assert/strict";
import { createServices } from "../packages/core/src/services.js";
import { schemaVersion } from "../packages/core/src/db.js";
import {
  BudgetTracker,
  totalTokens,
  BUDGET_EXCEEDED_ERROR,
} from "../packages/core/src/runs/budget.js";

function setup(
  t,
  { policy = {}, now = () => Date.parse("2026-09-10T12:00:00") } = {},
) {
  const services = createServices({ demo: false, disableObservation: true });
  t.after(() => services.close());
  const workspace = services.hub.get(
    services.hub.create({ name: "Budgeted" }).id,
  );
  if (Object.keys(policy).length)
    services.policy.setForWorkspace(workspace.id, policy);
  const tracker = new BudgetTracker(services, { now });
  services.budget = tracker;
  const agents = workspace.snapshot().agents;
  let index = 0;
  const run = (usage = null, status = "running") => {
    const created = services.recorder.ensureRun({
      workspaceId: workspace.id,
      agentId: agents[index++ % agents.length].id,
      mode: "managed",
      provider: "claude-code",
      createTask: { title: "Spendy" },
      status,
      startedAt: now(),
    });
    if (usage) services.recorder.update(created.id, { usage });
    return services.recorder.get(created.id);
  };
  return { services, workspace, tracker, run, now };
}

test("migration 3 creates budget_reservations", (t) => {
  const services = createServices({ demo: false, disableObservation: true });
  t.after(() => services.close());
  assert.ok(schemaVersion(services.db) >= 3);
  const columns = services.db
    .prepare("PRAGMA table_info(budget_reservations)")
    .all()
    .map((row) => row.name);
  assert.deepEqual(columns, [
    "id",
    "workspace_id",
    "run_id",
    "estimate_tokens",
    "created_at",
    "released_at",
  ]);
});

test("totalTokens never double counts provider usage shapes", () => {
  assert.equal(totalTokens({ input_tokens: 10, output_tokens: 5 }), 15);
  assert.equal(
    totalTokens({ total_tokens: 99, input_tokens: 10, output_tokens: 5 }),
    99,
  );
  assert.equal(totalTokens({ inputTokens: 3, outputTokens: 4 }), 7);
  assert.equal(totalTokens({ premiumRequests: 0.33 }), 0);
  assert.equal(totalTokens(null), 0);
});

test("reserve books estimated headroom, release frees it, and the daily rollup is a query", (t) => {
  const { services, workspace, tracker, run } = setup(t);
  // The Settings guard rejects any key containing "token" as a possible
  // secret, so the tracker writes this non-secret limit itself.
  tracker.setDailyTokenLimit(1000);
  assert.equal(tracker.dailyTokenLimit(), 1000);

  const empty = tracker.headroom(workspace.id);
  assert.equal(empty.limit, 1000);
  assert.equal(empty.spent, 0);
  assert.equal(empty.reserved, 0);
  assert.equal(empty.remaining, 1000);
  assert.equal(empty.reported, false, "nothing reported yet is said out loud");

  const first = run({
    input_tokens: 100,
    output_tokens: 50,
    reportedBy: "provider",
  });
  const reservation = tracker.reserve({
    workspaceId: workspace.id,
    runId: first.id,
    estimateTokens: 200,
  });
  assert.equal(reservation.ok, true);
  assert.equal(reservation.basis, "estimate");
  const head = tracker.headroom(workspace.id);
  assert.equal(head.spent, 150, "provider-reported tokens");
  assert.equal(head.reserved, 200);
  assert.equal(head.remaining, 650);
  assert.equal(head.reported, true);
  assert.equal(tracker.remaining(workspace.id), 650);
  assert.equal(tracker.dayUsage(workspace.id).tokens, 150);

  assert.equal(tracker.release(first.id), 1);
  assert.equal(tracker.headroom(workspace.id).reserved, 0);

  // An exhausted daily budget refuses the next reservation with a reason.
  const second = run({
    input_tokens: 900,
    output_tokens: 0,
    reportedBy: "provider",
  });
  const refused = tracker.reserve({
    workspaceId: workspace.id,
    runId: second.id,
    estimateTokens: 10,
  });
  assert.equal(refused.ok, false);
  assert.match(
    refused.reason,
    /daily token budget of 1000 is already committed/,
  );
  assert.equal(refused.id, null);
});

test("a per-run estimate larger than maxTokensPerRun is refused before anything is spawned", (t) => {
  const { workspace, tracker, run } = setup(t, {
    policy: { budget: { maxTokensPerRun: 500, maxRunsPerDay: null } },
  });
  const verdict = tracker.reserve({
    workspaceId: workspace.id,
    runId: run().id,
    estimateTokens: 900,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /exceed the per-run budget of 500/);
  assert.equal(tracker.maxTokensPerRun(workspace.id), 500);
});

test("an over-limit run is cancelled with an honest, post-hoc event", async (t) => {
  const { services, workspace, tracker, run } = setup(t, {
    policy: { budget: { maxTokensPerRun: 100, maxRunsPerDay: null } },
  });
  const active = run({
    input_tokens: 400,
    output_tokens: 120,
    reportedBy: "provider",
  });
  tracker.reserve({
    workspaceId: workspace.id,
    runId: active.id,
    estimateTokens: 50,
  });
  const cancelled = [];
  services.runWorker = {
    cancel: async (runId) => {
      cancelled.push(runId);
      services.recorder.setStatus(runId, "cancelled", {
        summary: "Run cancelled; side effects already made are not undone",
      });
    },
  };

  const verdict = await tracker.consume(active.id, {
    input_tokens: 400,
    output_tokens: 120,
    reportedBy: "provider",
  });
  assert.equal(verdict.exceeded, true);
  assert.equal(verdict.tokens, 520);
  assert.equal(verdict.limit, 100);
  assert.equal(verdict.action, "cancelled");
  assert.equal(verdict.reported, true);
  assert.deepEqual(cancelled, [active.id]);
  const after = services.recorder.get(active.id);
  assert.equal(after.status, "cancelled");
  assert.equal(after.error, BUDGET_EXCEEDED_ERROR);

  const event = services.recorder
    .events(active.id)
    .find((e) => /Token budget exceeded/.test(e.message));
  assert.ok(event, "an event explains the enforcement");
  assert.equal(event.kind, "status");
  assert.equal(event.provenance, "system");
  assert.match(event.message, /reported 520 tokens against a limit of 100/);
  assert.match(
    event.message,
    /arrive after the fact, so this enforcement is post-hoc/,
  );
  assert.match(event.message, /work already done is not undone/);
  assert.equal(event.data.enforcement, "post-hoc");
  assert.equal(
    services.audit.list({ action: "run.budget.exceeded" }).length,
    1,
  );
  // The reservation is released once the real total is known.
  assert.equal(tracker.headroom(workspace.id).reserved, 0);

  // A run that already ended is acknowledged, not "cancelled" a second time.
  const ended = run(
    { input_tokens: 300, output_tokens: 0, reportedBy: "provider" },
    "completed",
  );
  const late = await tracker.enforce(ended.id);
  assert.equal(late.exceeded, true);
  assert.equal(late.action, "recorded");
  assert.match(
    services.recorder
      .events(ended.id)
      .find((e) => /Token budget exceeded/.test(e.message)).message,
    /had already ended, so nothing could be stopped/,
  );
});

test("without a limit nothing is enforced and nothing is invented", async (t) => {
  const { tracker, run, workspace } = setup(t);
  const active = run({ input_tokens: 9_000_000, reportedBy: "provider" });
  const verdict = await tracker.enforce(active.id);
  assert.equal(verdict.exceeded, false);
  assert.equal(verdict.limit, null);
  assert.equal(verdict.action, "none");
  const head = tracker.headroom(workspace.id);
  assert.equal(head.limit, null);
  assert.equal(head.remaining, null, "no limit means no invented remainder");
  assert.equal(tracker.maxTokensPerRun(workspace.id), null);
  assert.equal(
    await tracker.enforce("missing-run").then((v) => v.action),
    "none",
  );
});
