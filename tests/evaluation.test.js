import test from "node:test";
import assert from "node:assert/strict";
import { createServices } from "../packages/core/src/services.js";
import { RunRecorder } from "../packages/core/src/runs/RunRecorder.js";
import {
  Evaluation,
  DIMENSIONS,
  NEVER_ASSERTED,
  freezeInputs,
} from "../packages/core/src/analytics/evaluation.js";

const T0 = 1_700_000_000_000;

function setup() {
  const services = createServices({ demo: false });
  const recorder = new RunRecorder(services, { broadcastIntervalMs: 1 });
  services.recorder = recorder;
  const workspace = services.hub.get(
    services.hub.create({ name: "Evaluation" }).id,
  );
  const agents = workspace.snapshot().agents;
  const evaluation = new Evaluation(services, { now: () => T0 });
  let seq = 0;
  const seed = ({
    title = "Work",
    status = "completed",
    provider = "claude-code",
    agent = seq++,
  } = {}) => {
    const task = workspace.create({ title });
    const run = recorder.ensureRun({
      workspaceId: workspace.id,
      agentId: agents[agent % agents.length].id,
      mode: "managed",
      provider,
      taskId: task.id,
      startedAt: T0,
    });
    recorder.applyEvent(run.id, {
      kind: "message",
      summary: "working",
      timestamp: T0 + 10,
    });
    recorder.setStatus(run.id, status);
    return { task, run };
  };
  return { services, recorder, workspace, agents, evaluation, seed };
}

test("evaluation refuses to assert correctness or security itself", () => {
  const { evaluation, seed } = setup();
  const { run } = seed();

  assert.deepEqual([...NEVER_ASSERTED], ["correctness", "security"]);
  for (const dimension of NEVER_ASSERTED) {
    assert.throws(
      () =>
        evaluation.record({
          runId: run.id,
          dimension,
          verdict: "pass",
          grader: { kind: "objective", identity: "agent-space" },
        }),
      new RegExp(`never asserts ${dimension}`),
    );
  }

  // Computing the objective dimensions never touches correctness/security.
  const written = evaluation.computeObjective(run.id);
  assert.deepEqual(written.map((row) => row.dimension).sort(), [
    "availability",
    "completion",
  ]);
  const summary = evaluation.summary(run.id);
  assert.equal(summary.dimensions.completion.verdict, "pass");
  assert.equal(summary.dimensions.completion.grader.kind, "objective");
  assert.equal(summary.dimensions.availability.verdict, "pass");
  assert.equal(summary.dimensions.correctness.verdict, "unknown");
  assert.match(summary.dimensions.correctness.reason, /never asserts this/);
  assert.equal(summary.dimensions.security.verdict, "unknown");
  assert.deepEqual(summary.neverAssertedByUs, ["correctness", "security"]);
  assert.deepEqual([...DIMENSIONS].sort(), [
    "acceptance",
    "availability",
    "completion",
    "correctness",
    "security",
  ]);

  // A human may decide correctness; the record keeps who decided.
  const human = evaluation.record({
    runId: run.id,
    dimension: "correctness",
    verdict: "fail",
    grader: { kind: "human", identity: "local-user" },
    evidence: { note: "off-by-one in the loop" },
  });
  assert.equal(human.verdict, "fail");
  assert.equal(human.claim, false);
  assert.throws(
    () =>
      evaluation.record({
        runId: run.id,
        dimension: "correctness",
        verdict: "pass",
        grader: { kind: "human" },
      }),
    /who decided/,
  );
});

test("a model grader is recorded with its identity and rubric and stays a claim", () => {
  const { evaluation, seed } = setup();
  const { run } = seed();

  assert.throws(
    () =>
      evaluation.record({
        runId: run.id,
        dimension: "security",
        verdict: "pass",
        grader: { kind: "model" },
        rubric: "OWASP top ten",
      }),
    /must record its identity/,
  );
  assert.throws(
    () =>
      evaluation.record({
        runId: run.id,
        dimension: "security",
        verdict: "pass",
        grader: { kind: "model", identity: "grader-run-1" },
      }),
    /must record the rubric/,
  );

  const record = evaluation.record({
    runId: run.id,
    dimension: "security",
    verdict: "pass",
    score: 0.9,
    grader: {
      kind: "model",
      identity: "grader-run-1 (claude-fable-5-1)",
      version: "rubric-v2",
    },
    rubric:
      "No secret is written to disk; no network call outside the allow list.",
    evidence: { verdictFromRun: "grader-run-1" },
  });
  assert.equal(record.claim, true, "a model verdict is a claim, not truth");
  assert.equal(record.grader.identity, "grader-run-1 (claude-fable-5-1)");
  assert.match(record.rubric, /No secret is written/);
  assert.equal(evaluation.summary(run.id).dimensions.security.claim, true);

  const byDimension = evaluation.byDimension({});
  const security = byDimension.dimensions.find(
    (row) => row.dimension === "security",
  );
  assert.equal(security.pass, 1);
  assert.equal(security.byGrader.model, 1);
  assert.equal(security.assertedByUs, false);
  assert.equal(
    byDimension.dimensions.find((row) => row.dimension === "completion")
      .assertedByUs,
    true,
  );
  assert.throws(
    () =>
      evaluation.record({
        runId: run.id,
        dimension: "completion",
        verdict: "maybe",
        grader: { kind: "objective" },
      }),
    /verdict must be one of/,
  );
  assert.throws(() => evaluation.record({ runId: "ghost" }), /Run not found/);
});

test("objective dimensions read the recorded status, disconnects, and human acceptance", () => {
  const { services, evaluation, seed } = setup();
  const disconnected = seed({ title: "Lost", status: "disconnected" });
  evaluation.computeObjective(disconnected.run.id);
  const lost = evaluation.summary(disconnected.run.id);
  assert.equal(lost.dimensions.completion.verdict, "unknown");
  assert.equal(lost.dimensions.availability.verdict, "fail");

  const failed = seed({ title: "Failed", status: "failed" });
  evaluation.computeObjective(failed.run.id);
  assert.equal(
    evaluation.summary(failed.run.id).dimensions.completion.verdict,
    "fail",
  );

  const accepted = seed({ title: "Accepted" });
  services.db.prepare("UPDATE tasks SET review = ? WHERE id = ?").run(
    JSON.stringify({
      runId: accepted.run.id,
      status: "accepted",
      decidedBy: "local-user",
    }),
    accepted.task.id,
  );
  evaluation.computeObjective(accepted.run.id);
  const acceptance = evaluation.summary(accepted.run.id).dimensions.acceptance;
  assert.equal(acceptance.verdict, "pass");
  assert.equal(acceptance.grader.kind, "human");
  assert.equal(acceptance.grader.identity, "local-user");
});

test("benchmark cases freeze inputs as hashes and never store their contents", () => {
  const { evaluation } = setup();
  const frozen = freezeInputs({
    prompt: "SECRET PROMPT",
    files: [{ path: "a.js", content: "console.log(1)" }],
  });
  assert.equal(JSON.stringify(frozen).includes("SECRET PROMPT"), false);
  assert.equal(JSON.stringify(frozen).includes("console.log"), false);
  assert.match(frozen.files[0].hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(frozen.files[0].bytes, 14);

  const benchmark = evaluation.define({
    name: "Regression pack",
    cases: [
      {
        key: "case-1",
        inputs: {
          prompt: "SECRET PROMPT",
          files: [{ path: "a.js", content: "x" }],
        },
        expectations: { mustCompile: true, mustNotWriteOutsideRepo: true },
      },
      { key: "case-2", inputs: { prompt: "second" }, expectations: {} },
    ],
  });
  assert.equal(benchmark.cases.length, 2);
  assert.equal(JSON.stringify(benchmark).includes("SECRET PROMPT"), false);
  assert.equal(benchmark.cases[0].expectations.mustCompile, true);
  assert.match(benchmark.cases[0].inputs.hash, /^sha256:/);
  assert.equal(evaluation.benchmarks({}).length, 1);
  assert.throws(
    () => evaluation.define({ name: "Empty", cases: [] }),
    /at least one case/,
  );
  assert.throws(
    () =>
      evaluation.define({
        name: "Dupes",
        cases: [{ key: "a" }, { key: "a" }],
      }),
    /Duplicate benchmark case key/,
  );
});

test("comparing variants declares no winner when the objective signals tie", () => {
  const { evaluation, seed } = setup();
  const benchmark = evaluation.define({
    name: "Same tasks",
    cases: [
      { key: "case-1", inputs: { prompt: "one" } },
      { key: "case-2", inputs: { prompt: "two" } },
    ],
  });
  const link = (caseKey, variant, options) => {
    const { run } = seed(options);
    evaluation.computeObjective(run.id);
    return evaluation.runCase({
      benchmarkId: benchmark.id,
      caseKey,
      variant,
      runId: run.id,
    });
  };
  // Both variants complete both cases: a tie.
  link("case-1", "model-a");
  link("case-2", "model-a");
  link("case-1", "model-b");
  link("case-2", "model-b");
  const tie = evaluation.compare({ benchmarkId: benchmark.id });
  assert.deepEqual(tie.variants, ["model-a", "model-b"]);
  assert.equal(tie.winner, null);
  assert.match(tie.verdict, /no winner/);
  assert.match(tie.basis, /never used to rank quality/);
  assert.equal(tie.cases.length, 2);
  assert.equal(tie.cases[0].variants["model-a"].verdict, "pass");
  assert.deepEqual(
    tie.totals.map((row) => [row.variant, row.pass]),
    [
      ["model-a", 2],
      ["model-b", 2],
    ],
  );

  // A third variant that fails a case does not win either.
  link("case-1", "model-c", { status: "failed" });
  link("case-2", "model-c", { status: "failed" });
  const compared = evaluation.compare({
    benchmarkId: benchmark.id,
    variants: ["model-a", "model-c"],
  });
  assert.equal(compared.winner, "model-a");
  assert.equal(compared.cases[0].variants["model-c"].verdict, "fail");

  // A variant with no linked run is unknown, never a silent pass.
  const missing = evaluation.compare({
    benchmarkId: benchmark.id,
    variants: ["model-a", "never-run"],
  });
  assert.equal(missing.cases[0].variants["never-run"].verdict, "unknown");
  assert.throws(
    () =>
      evaluation.runCase({
        benchmarkId: benchmark.id,
        caseKey: "ghost",
        runId: "x",
      }),
    /Benchmark case not found/,
  );
});

test("a shadow experiment is refused without an explicit budget or isolation", () => {
  const { evaluation } = setup();
  const benchmark = evaluation.define({
    name: "Shadow pack",
    cases: [{ key: "case-1", inputs: { prompt: "one" } }],
  });

  assert.throws(
    () =>
      evaluation.startShadow({
        benchmarkId: benchmark.id,
        variant: "candidate",
        isolation: "worktree",
      }),
    /explicit token budget/,
  );
  assert.throws(
    () =>
      evaluation.startShadow({
        benchmarkId: benchmark.id,
        variant: "candidate",
        budgetTokens: 0,
        isolation: "worktree",
      }),
    /explicit token budget/,
  );
  assert.throws(
    () =>
      evaluation.startShadow({
        benchmarkId: benchmark.id,
        variant: "candidate",
        budgetTokens: 50_000,
      }),
    /must be isolated/,
  );
  assert.throws(
    () =>
      evaluation.startShadow({
        benchmarkId: benchmark.id,
        variant: "candidate",
        budgetTokens: 50_000,
        isolation: "in-place",
      }),
    /must be isolated/,
  );

  const worktree = evaluation.startShadow({
    benchmarkId: benchmark.id,
    variant: "candidate",
    budgetTokens: 50_000,
    isolation: "worktree",
    caseKey: "case-1",
  });
  assert.equal(worktree.result.shadow, true);
  assert.equal(worktree.result.budgetTokens, 50_000);
  assert.equal(worktree.result.isolation, "worktree");
  assert.match(worktree.result.guard, /production files are never touched/);
  assert.equal(worktree.runId, null);

  const scoped = evaluation.startShadow({
    benchmarkId: benchmark.id,
    variant: "candidate-2",
    budgetTokens: 1000,
    outputDir: "C:\\tmp\\shadow-out",
  });
  assert.equal(scoped.result.isolation, "scoped-output-folder");
  assert.equal(scoped.result.outputDir, "C:\\tmp\\shadow-out");
  assert.equal(scoped.result.status, "pending");
  assert.throws(
    () => evaluation.startShadow({ benchmarkId: "ghost", budgetTokens: 1 }),
    /Benchmark not found/,
  );
});
