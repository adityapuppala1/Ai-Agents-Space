import test from "node:test";
import assert from "node:assert/strict";
import { createServices } from "../packages/core/src/services.js";
import { TaskGraph } from "../packages/core/src/workflows/TaskGraph.js";
import { WorkflowService } from "../packages/core/src/workflows/WorkflowService.js";
import {
  CheckpointService,
  NOT_ROLLED_BACK,
} from "../packages/core/src/workflows/checkpoints.js";
import { plan, replay } from "../packages/core/src/workflows/dryRun.js";
import {
  suggestTeam,
  pickTemplate,
} from "../packages/core/src/workflows/suggest.js";

function setup({ rootPath = process.cwd() } = {}) {
  const services = createServices({ demo: false, disableObservation: true });
  const audits = [];
  services.audit = { record: (entry) => audits.push(entry) };
  const graph = new TaskGraph(services);
  services.graph = graph;
  const workflows = new WorkflowService(services, { graph });
  services.workflows = workflows;
  const checkpoints = new CheckpointService(services);
  services.checkpoints = checkpoints;
  const workspace = services.hub.get(
    services.hub.create({ name: "Recovery", rootPath }).id,
  );
  return { services, graph, workflows, checkpoints, workspace, audits };
}

function completeTask(workspace, taskId) {
  const agent = workspace
    .snapshot()
    .agents.find((a) => !a.taskId && a.state === "IDLE");
  workspace.assign(taskId, agent.id);
  return workspace.update(taskId, { status: "COMPLETED" });
}

test("checkpoint create and restore moves statuses and never touches files", () => {
  const { services, checkpoints, workspace, audits } = setup();
  const a = workspace.create({ title: "Plan" });
  const b = workspace.create({ title: "Build" });
  const checkpoint = checkpoints.create({
    workspaceId: workspace.id,
    kind: "pre-dispatch",
    label: "before the run",
  });
  assert.equal(checkpoint.kind, "pre-dispatch");
  assert.equal(checkpoint.state.tasks.length, 2);
  assert.equal(checkpoint.state.note, NOT_ROLLED_BACK);
  assert.ok(!JSON.stringify(checkpoint.state).includes("content"));

  completeTask(workspace, a.id);
  services.db
    .prepare("UPDATE tasks SET review = ? WHERE id = ?")
    .run(JSON.stringify({ status: "pending", note: "check" }), b.id);
  assert.equal(
    workspace.snapshot().tasks.find((t) => t.id === a.id).status,
    "COMPLETED",
  );

  const preview = checkpoints.restore(checkpoint.id, { dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.changes.length, 2);
  assert.equal(preview.filesRestored, false);
  assert.equal(preview.rerun, false);
  assert.equal(preview.note, NOT_ROLLED_BACK);
  // A dry run writes nothing.
  assert.equal(
    workspace.snapshot().tasks.find((t) => t.id === a.id).status,
    "COMPLETED",
  );

  const restored = checkpoints.restore(checkpoint.id);
  assert.equal(restored.filesRestored, false);
  assert.equal(restored.rerun, false);
  assert.deepEqual(
    restored.changes.map((c) => [c.from, c.to]).sort(),
    [
      ["COMPLETED", "QUEUE"],
      ["QUEUE", "QUEUE"],
    ].sort(),
  );
  const tasks = workspace.snapshot().tasks;
  assert.equal(tasks.find((t) => t.id === a.id).status, "QUEUE");
  assert.deepEqual(tasks.find((t) => t.id === b.id).review, {});
  assert.ok(audits.some((entry) => entry.action === "checkpoint.restore"));
  const event = workspace
    .snapshot()
    .events.find((e) => /Checkpoint restored/.test(e.message));
  assert.ok(event, "the restore is recorded as a workspace event");
  assert.match(event.message, /NOT rolled back/);
  assert.match(event.message, /Nothing was re-run/);

  assert.equal(checkpoints.list({ workspaceId: workspace.id }).length, 1);
  assert.throws(() => checkpoints.get("nope"), /not found/);
  assert.throws(
    () => checkpoints.create({ workspaceId: workspace.id, kind: "weird" }),
    /kind must be/,
  );
});

test("compensation steps are stored for approval and never executed", () => {
  const { services, checkpoints, graph, workspace } = setup();
  const task = workspace.create({ title: "Publish package" });
  const registered = checkpoints.registerCompensation(task.id, {
    description: "Unpublish the package version",
    command: "npm unpublish demo@1.0.0",
  });
  assert.equal(registered.automatic, false);
  assert.match(registered.note, /does not execute/i);
  assert.equal(
    graph.contract(task.id).compensation.description,
    "Unpublish the package version",
  );
  assert.equal(graph.contract(task.id).compensation.automatic, false);

  // Only surfaced once the run actually failed.
  assert.deepEqual(graph.supervisorView(workspace.id).compensations, []);
  const agent = workspace.snapshot().agents[0];
  workspace.assign(task.id, agent.id);
  services.db
    .prepare(
      `INSERT INTO runs (id, workspace_id, task_id, agent_id, agent_snapshot, provider, status, started_at, mode)
       VALUES ('r-comp', ?, ?, ?, '{}', 'claude-code', 'failed', ?, 'managed')`,
    )
    .run(workspace.id, task.id, agent.id, Date.now());
  const view = graph.supervisorView(workspace.id);
  assert.equal(view.compensations.length, 1);
  assert.equal(view.compensations[0].automatic, false);
  assert.match(view.compensations[0].note, /never runs a compensation/i);
  assert.equal(checkpoints.compensationInbox(workspace.id).entries.length, 1);
  assert.throws(
    () => checkpoints.registerCompensation(task.id, {}),
    /description is required/,
  );
});

test("supervisor view lists stalled dependencies and failed jobs", () => {
  const { services, graph, workspace } = setup();
  const a = workspace.create({ title: "Upstream" });
  const b = workspace.create({ title: "Downstream" });
  graph.setDependencies(workspace.id, b.id, [a.id]);
  const agent = workspace.snapshot().agents[0];
  workspace.assign(a.id, agent.id);
  workspace.update(a.id, { status: "BLOCKED" });
  const longAgo = Date.now() - 60 * 60 * 1000;
  services.db
    .prepare("UPDATE tasks SET updated_at = ? WHERE id = ?")
    .run(longAgo, a.id);
  // Assigning created a manual run; age it so the dependency really is idle.
  services.db
    .prepare(
      "UPDATE runs SET started_at = ?, last_event_at = ? WHERE task_id = ?",
    )
    .run(longAgo, longAgo, a.id);

  const fresh = graph.supervisorView(workspace.id, {
    stalledAfterMs: 24 * 60 * 60 * 1000,
  });
  assert.equal(fresh.stalled.length, 0, "not stalled inside the window");

  const view = graph.supervisorView(workspace.id, {
    stalledAfterMs: 60 * 1000,
  });
  assert.equal(view.stalled.length, 1);
  assert.equal(view.stalled[0].taskId, b.id);
  assert.equal(view.stalled[0].blockers[0].taskId, a.id);
  assert.match(view.stalled[0].blockers[0].reason, /blocked/);

  services.db.prepare("UPDATE tasks SET review = ? WHERE id = ?").run(
    JSON.stringify({
      status: "pending",
      failures: [{ criterion: "test-passed", detail: "no test ran" }],
    }),
    a.id,
  );
  const inbox = graph.inbox(workspace.id);
  assert.equal(inbox.counts.failed, 1);
  assert.equal(inbox.failed[0].failures.length, 1);
});

test("dry run returns the command line each adapter would build, spawning nothing", () => {
  const { services, workspace } = setup();
  const task = workspace.create({ title: "Add a search box" });
  services.db
    .prepare("UPDATE tasks SET provider = ? WHERE id = ?")
    .run("claude-code", task.id);
  const noProvider = workspace.create({ title: "Manual step" });

  const result = plan(services, {
    workspaceId: workspace.id,
    // No process lookup: the binary is injected, so no CLI is touched.
    resolveBinary: () => ({
      command: "C:/fake/claude.cmd",
      args: [],
      resolved: true,
      source: "test",
    }),
  });
  assert.equal(result.spawned, false);
  assert.ok(result.assumptions.includes("one run per step"));
  assert.ok(result.assumptions.includes("no retries counted"));
  const step = result.steps.find((s) => s.taskId === task.id);
  assert.equal(step.provider, "claude-code");
  assert.equal(step.adapter, "claude-code");
  assert.match(step.commandLine, /claude\.cmd/);
  assert.match(step.commandLine, /--output-format stream-json/);
  assert.ok(step.args.includes("-p"));
  assert.equal(step.estimatedRuns, 1);
  const manual = result.steps.find((s) => s.taskId === noProvider.id);
  assert.equal(manual.estimatedRuns, 0);
  assert.match(manual.notes[0], /no provider/);
  assert.equal(result.estimatedRuns, 1);

  const missing = plan(services, {
    workspaceId: workspace.id,
    resolveBinary: () => ({ command: "claude", args: [], resolved: false }),
  });
  assert.match(
    missing.steps.find((s) => s.taskId === task.id).notes.join(" "),
    /binary was not found/,
  );
});

test("replay re-emits recorded events and says it is a replay", () => {
  const { services, workspace } = setup();
  const task = workspace.create({ title: "Recorded" });
  const agent = workspace.snapshot().agents[0];
  workspace.assign(task.id, agent.id);
  const now = Date.now();
  services.db
    .prepare(
      `INSERT INTO runs (id, workspace_id, task_id, agent_id, agent_snapshot, provider, status, started_at, ended_at, mode)
       VALUES ('r-1', ?, ?, ?, '{}', 'codex', 'completed', ?, ?, 'managed')`,
    )
    .run(workspace.id, task.id, agent.id, now, now + 5);
  const insert = services.db.prepare(
    `INSERT INTO events (id, sequence, workspace_id, run_id, kind, message, timestamp, provenance, data)
     VALUES (?, ?, ?, 'r-1', ?, ?, ?, 'provider', '{}')`,
  );
  insert.run("e1", 1, workspace.id, "prompt", "Do the thing", now);
  insert.run("e2", 2, workspace.id, "command", "npm test", now + 1);

  const result = replay(services, { runId: "r-1" });
  assert.equal(result.replay, true);
  assert.equal(result.recorded, true);
  assert.equal(result.executed, false);
  assert.match(result.note, /replay of events this run already recorded/);
  assert.match(result.note, /may take a different path/);
  assert.deepEqual(
    result.events.map((e) => e.message),
    ["Do the thing", "npm test"],
  );
  assert.ok(result.events.every((e) => e.replayed === true));
  assert.throws(() => replay(services, { runId: "ghost" }), /not found/);
});

test("team suggestions are deterministic, editable, and dispatch nothing", () => {
  const { services, workspace } = setup();
  const first = suggestTeam(services, {
    workspaceId: workspace.id,
    templateId: "feature-delivery",
  });
  const second = suggestTeam(services, {
    workspaceId: workspace.id,
    templateId: "feature-delivery",
  });
  assert.deepEqual(first, second, "same inputs give the same proposal");
  assert.equal(first.editable, true);
  assert.equal(first.dispatched, false);
  assert.equal(first.proposedRuns, first.assignments.length);
  assert.equal(first.proposedRuns, 5);
  assert.ok(first.assumptions.includes("one run per step"));
  assert.ok(first.assumptions.includes("no retries counted"));
  for (const assignment of first.assignments) {
    assert.ok(assignment.agentId);
    assert.ok(assignment.reason.length > 0);
    assert.equal(assignment.editable, true);
  }
  // Nothing was created.
  assert.equal(workspace.snapshot().tasks.length, 0);

  const byGoal = suggestTeam(services, {
    workspaceId: workspace.id,
    goal: "fix a bug reported by a customer",
  });
  assert.equal(byGoal.matchedFrom, "goal");
  assert.ok(byGoal.templateId);
  assert.equal(pickTemplate("zzzz qqqq"), null);
  assert.throws(
    () => suggestTeam(services, { workspaceId: workspace.id }),
    /templateId or goal/,
  );
});

test("a detected-but-not-signed-in provider is never proposed as ready", () => {
  const { services, workspace } = setup();
  // "detected" means the binary is on PATH and no credential file was found;
  // every run on it exits "not signed in".
  services.connections = {
    list: () => [
      {
        provider: "gemini",
        status: "detected",
        enabled: true,
        allowedWorkspaces: [],
        capabilities: { launch: "experimental" },
      },
      {
        provider: "claude-code",
        status: "ready",
        enabled: true,
        allowedWorkspaces: [],
        capabilities: { launch: "verified" },
      },
    ],
  };
  const agents = workspace.snapshot().agents;
  services.db
    .prepare("UPDATE agent_profiles SET provider = ? WHERE id = ?")
    .run("gemini", agents[0].id);

  const proposal = suggestTeam(services, {
    workspaceId: workspace.id,
    templateId: "feature-delivery",
  });
  const onGemini = proposal.assignments.filter(
    (row) => row.provider === "gemini",
  );
  assert.ok(onGemini.length > 0, "the gemini profile was proposed for a step");
  for (const row of onGemini) {
    assert.equal(row.providerReady, false, "detected is not ready");
    assert.equal(row.binaryDetected, true, "the CLI is installed");
    assert.match(row.reason, /installed but no sign-in was found/);
  }
  const onClaude = proposal.assignments.filter(
    (row) => row.provider === "claude-code",
  );
  for (const row of onClaude) assert.equal(row.providerReady, true);
});
