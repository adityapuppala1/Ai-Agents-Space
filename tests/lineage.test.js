import test from "node:test";
import assert from "node:assert/strict";
import { createServices } from "../packages/core/src/services.js";
import { RunRecorder } from "../packages/core/src/runs/RunRecorder.js";
import {
  Lineage,
  pathBetween,
} from "../packages/core/src/analytics/lineage.js";

const T0 = 1_700_000_000_000;

function setup() {
  const services = createServices({ demo: false });
  const recorder = new RunRecorder(services, { broadcastIntervalMs: 1 });
  services.recorder = recorder;
  const workspace = services.hub.get(
    services.hub.create({ name: "Lineage" }).id,
  );
  return { services, recorder, workspace, agents: workspace.snapshot().agents };
}

const MANIFEST = {
  version: 1,
  createdAt: T0 - 1000,
  files: [
    {
      path: "C:\\repo\\src\\app.js",
      revision: "git:abc123",
      bytes: 120,
      included: true,
    },
  ],
  documents: [{ title: "Spec", ref: "spec-1", revision: "v3" }],
};

/**
 * Attempt 1 fails after editing a file; attempt 2 retries, produces a diff
 * artifact, and the human accepts it. The whole chain must stay connected.
 */
function seedRetryChain({ services, recorder, workspace, agents }) {
  const task = workspace.create({ title: "Ship the fix" });
  const first = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agents[0].id,
    mode: "managed",
    provider: "claude-code",
    taskId: task.id,
    startedAt: T0,
    context: MANIFEST,
  });
  recorder.applyEvent(first.id, {
    kind: "file.edit",
    tool: "Edit",
    file: "C:\\repo\\src\\app.js",
    summary: "Edited app.js",
    timestamp: T0 + 500,
  });
  recorder.setStatus(first.id, "failed", { error: "transport" });

  const second = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agents[0].id,
    mode: "managed",
    provider: "claude-code",
    taskId: task.id,
    startedAt: T0 + 2000,
    attempt: 2,
    parentRunId: first.id,
  });
  recorder.applyEvent(second.id, {
    kind: "command",
    tool: "Bash",
    summary: "Ran: npm test",
    timestamp: T0 + 2500,
  });
  recorder.addArtifact(second.id, {
    kind: "diff",
    title: "Patch",
    content: "--- a\n+++ b\n",
  });
  recorder.setStatus(second.id, "completed");
  services.db
    .prepare(
      "UPDATE tasks SET review = ?, updated_at = ?, completed_at = ? WHERE id = ?",
    )
    .run(
      JSON.stringify({
        runId: second.id,
        status: "accepted",
        decidedAt: T0 + 5000,
        decidedBy: "local-user",
      }),
      T0 + 5000,
      T0 + 5000,
      task.id,
    );
  return { task, first, second };
}

test("lineage connects pinned inputs through artifacts to the accepted result across a retry chain", () => {
  const context = setup();
  const { task, first, second } = seedRetryChain(context);
  const lineage = new Lineage(context.services, { now: () => T0 + 9000 });

  // Asking about attempt 1 still returns the whole attempt chain.
  const graph = lineage.forRun(first.id);
  assert.deepEqual(graph.runIds, [first.id, second.id]);

  const input = graph.nodes.find(
    (node) => node.type === "input" && node.kind === "file",
  );
  assert.equal(input.label, "C:\\repo\\src\\app.js");
  assert.equal(input.revision, "git:abc123");
  const doc = graph.nodes.find(
    (node) => node.type === "input" && node.kind === "document",
  );
  assert.equal(doc.revision, "v3");

  const artifact = graph.nodes.find((node) => node.type === "artifact");
  assert.equal(artifact.size, 12);
  assert.match(artifact.revision, /^sha256:[0-9a-f]{16}$/);
  const review = graph.nodes.find((node) => node.type === "review");
  assert.equal(review.status, "accepted");
  const result = graph.nodes.find((node) => node.type === "result");
  assert.equal(result.label, "Ship the fix");

  // Input → run(attempt 1) → run(attempt 2) → artifact → review → result.
  const path = pathBetween(graph, input.id, result.id);
  assert.ok(path, "the accepted result must be reachable from its input");
  assert.deepEqual(path, [
    input.id,
    `run:${first.id}`,
    `run:${second.id}`,
    artifact.id,
    review.id,
    result.id,
  ]);
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.relation === "retried-as" &&
        edge.from === `run:${first.id}` &&
        edge.to === `run:${second.id}`,
    ),
  );

  // Tools and commands are recorded as their own nodes with their provenance.
  const tools = graph.nodes.filter((node) => node.type === "tool");
  assert.deepEqual(
    tools.map((node) => node.label).sort(),
    ["Bash", "Edit"],
    "both attempts contribute their recorded tool calls",
  );
  assert.equal(
    tools.every((node) => node.provenance),
    true,
  );
  assert.ok(
    graph.edges.some(
      (edge) => edge.relation === "ran" && edge.from === `run:${first.id}`,
    ),
  );
  assert.equal(graph.taskId, task.id);
});

test("lineage by task and by workspace cover the same records", () => {
  const context = setup();
  const { task, second } = seedRetryChain(context);
  const lineage = new Lineage(context.services, { now: () => T0 + 9000 });

  const byTask = lineage.forTask(task.id);
  assert.equal(byTask.runIds.length, 2);
  const input = byTask.nodes.find((node) => node.type === "input");
  const result = byTask.nodes.find((node) => node.type === "result");
  assert.ok(pathBetween(byTask, input.id, result.id));

  const workspaceGraph = lineage.lineage({
    workspaceId: context.workspace.id,
  });
  assert.equal(workspaceGraph.runIds.length, 2);
  assert.ok(
    workspaceGraph.nodes.some((node) => node.id === `run:${second.id}`),
  );
  assert.deepEqual(workspaceGraph.scope, {
    workspaceId: context.workspace.id,
    since: 0,
  });

  // `since` trims the graph, and unknown ids are refused rather than empty.
  assert.equal(
    lineage.lineage({ workspaceId: context.workspace.id, since: T0 + 1000 })
      .runIds.length,
    1,
  );
  assert.throws(() => lineage.forRun("ghost"), /Run not found/);
  assert.throws(() => lineage.forTask("ghost"), /Task not found/);
  assert.throws(
    () => lineage.lineage({ workspaceId: "ghost" }),
    /Workspace not found/,
  );
});

test("a run without a context manifest has no inputs rather than invented ones", () => {
  const { services, recorder, workspace, agents } = setup();
  const task = workspace.create({ title: "No manifest" });
  const run = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agents[0].id,
    mode: "observed",
    provider: "codex",
    taskId: task.id,
    startedAt: T0,
  });
  recorder.setStatus(run.id, "completed");
  const graph = new Lineage(services, { now: () => T0 + 1000 }).forRun(run.id);
  assert.equal(
    graph.nodes.filter((node) => node.type === "input").length,
    0,
    "inputs are absent, never guessed",
  );
  assert.equal(graph.nodes.filter((node) => node.type === "result").length, 0);
  assert.equal(graph.nodes[0].type, "run");
  assert.equal(graph.nodes[0].provider, "codex");
});

test("lineage() never emits an edge to a run outside the requested range", () => {
  const context = setup();
  const { first, second } = seedRetryChain(context);
  // Attempt 1 started at T0, attempt 2 at T0 + 2000.
  context.services.db
    .prepare("UPDATE runs SET started_at = ? WHERE id = ?")
    .run(T0 + 4_000_000, second.id);
  const lineage = new Lineage(context.services, { now: () => T0 + 9_000_000 });
  const graph = lineage.lineage({
    workspaceId: context.workspace.id,
    since: T0 + 3_000_000,
  });
  const ids = new Set(graph.nodes.map((node) => node.id));
  assert.ok(!ids.has(`run:${first.id}`), "attempt 1 is outside the range");
  for (const edge of graph.edges) {
    assert.ok(ids.has(edge.from), `edge.from ${edge.from} is in the graph`);
    assert.ok(ids.has(edge.to), `edge.to ${edge.to} is in the graph`);
  }
});

test("lineage() understands an ISO since instead of widening to all time", () => {
  const context = setup();
  seedRetryChain(context);
  const lineage = new Lineage(context.services, { now: () => T0 + 9000 });
  const iso = new Date(T0 + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const graph = lineage.lineage({
    workspaceId: context.workspace.id,
    since: iso,
  });
  assert.equal(
    graph.scope.since,
    Date.parse(iso),
    "an ISO date is parsed, not turned into 0",
  );
  assert.equal(graph.runIds.length, 0, "nothing started after that date");
});

test("a step skipped by its branch condition is not an accepted result", () => {
  const { services, workspace } = setup();
  const task = workspace.create({ title: "Gated step" });
  services.db
    .prepare(
      "UPDATE tasks SET status = 'COMPLETED', review = ?, updated_at = ? WHERE id = ?",
    )
    .run(
      JSON.stringify({
        status: "skipped",
        skipped: true,
        note: "skipped by condition",
        runId: null,
      }),
      T0 + 1000,
      task.id,
    );
  const graph = new Lineage(services, { now: () => T0 + 2000 }).forTask(
    task.id,
  );
  assert.equal(
    graph.nodes.filter((node) => node.type === "result").length,
    0,
    "no accepted result for a step that never ran",
  );
  const skip = graph.nodes.find((node) => node.type === "skip");
  assert.ok(skip, "the skip is shown as a skip");
  assert.match(skip.label, /skipped by condition/);
});
