import test from "node:test";
import assert from "node:assert/strict";
import { createServices } from "../packages/core/src/services.js";
import { TaskGraph } from "../packages/core/src/workflows/TaskGraph.js";
import { WorkflowService } from "../packages/core/src/workflows/WorkflowService.js";
import {
  listTemplates,
  getTemplate,
  validateTemplate,
  interpolate,
} from "../packages/core/src/workflows/templates/index.js";
import {
  exportWorkspace,
  importWorkspace,
} from "../packages/core/src/export/manifest.js";

function setup() {
  const services = createServices({ demo: false });
  const audits = [];
  services.audit = { record: (entry) => audits.push(entry) };
  const graph = new TaskGraph(services);
  const workflows = new WorkflowService(services, { graph });
  services.workflows = workflows;
  const workspace = services.hub.get(
    services.hub.create({ name: "Graph", rootPath: "C:/work/graph" }).id,
  );
  return { services, graph, workflows, workspace, audits };
}

function setProvider(services, taskId, provider) {
  services.db
    .prepare("UPDATE tasks SET provider = ? WHERE id = ?")
    .run(provider, taskId);
}

function complete(workspace, taskId) {
  const agent = workspace
    .snapshot()
    .agents.find((a) => !a.taskId && a.state === "IDLE");
  workspace.assign(taskId, agent.id);
  return workspace.update(taskId, { status: "COMPLETED" });
}

test("dependencies are validated: existence, workspace, self, cycles", () => {
  const { services, graph, workspace, audits } = setup();
  const a = workspace.create({ title: "A" });
  const b = workspace.create({ title: "B" });
  const c = workspace.create({ title: "C" });
  const other = services.hub.get(services.hub.create({ name: "Other" }).id);
  const foreign = other.create({ title: "Foreign" });

  assert.throws(
    () => graph.setDependencies(workspace.id, a.id, [a.id]),
    /itself/,
  );
  assert.throws(
    () => graph.setDependencies(workspace.id, a.id, ["missing"]),
    /does not exist/,
  );
  assert.throws(
    () => graph.setDependencies(workspace.id, a.id, [foreign.id]),
    /does not exist/,
  );
  assert.throws(() => graph.setDependencies(other.id, a.id, []), /not found/);
  assert.throws(() => graph.setDependencies(workspace.id, a.id, "b"), /array/);

  graph.setDependencies(workspace.id, b.id, [a.id]);
  graph.setDependencies(workspace.id, c.id, [b.id]);
  assert.throws(
    () => graph.setDependencies(workspace.id, a.id, [c.id]),
    /cycle/,
  );
  assert.deepEqual(
    graph.dependencies(c.id).map((d) => d.id),
    [b.id],
  );
  assert.deepEqual(
    graph.blockedBy(c.id).map((d) => d.id),
    [b.id],
  );
  assert.equal(
    audits.filter((e) => e.action === "task.dependencies.set").length,
    2,
  );
  // Duplicate ids are collapsed.
  const node = graph.setDependencies(workspace.id, c.id, [b.id, b.id, a.id]);
  assert.deepEqual(node.dependsOn, [b.id, a.id]);
});

test("readiness, graph edges, and critical path", () => {
  const { graph, workspace } = setup();
  const a = workspace.create({ title: "A" });
  const b = workspace.create({ title: "B" });
  const c = workspace.create({ title: "C" });
  const d = workspace.create({ title: "D" });
  graph.setDependencies(workspace.id, b.id, [a.id]);
  graph.setDependencies(workspace.id, c.id, [b.id]);
  assert.deepEqual(
    graph
      .ready(workspace.id)
      .map((t) => t.id)
      .sort(),
    [a.id, d.id].sort(),
  );
  const g = graph.graph(workspace.id);
  assert.equal(g.nodes.length, 4);
  assert.deepEqual(g.edges, [
    { from: a.id, to: b.id },
    { from: b.id, to: c.id },
  ]);
  assert.deepEqual(g.criticalPath, [a.id, b.id, c.id]);
  assert.equal(g.nodes.find((n) => n.id === b.id).dependsOn[0], a.id);

  complete(workspace, a.id);
  assert.deepEqual(
    graph
      .ready(workspace.id)
      .map((t) => t.id)
      .sort(),
    [b.id, d.id].sort(),
  );
  assert.deepEqual(graph.blockedBy(b.id), []);
  assert.deepEqual(
    graph.blockedBy(c.id).map((t) => t.id),
    [b.id],
  );
});

test("completing a task auto-dispatches ready dependents through the run worker", async () => {
  const { services, graph, workspace, audits } = setup();
  const calls = [];
  services.runWorker = {
    start(input) {
      calls.push(input);
      return { id: `run-${calls.length}` };
    },
  };
  const a = workspace.create({ title: "A" });
  const b = workspace.create({ title: "B" });
  const c = workspace.create({ title: "C (no provider)" });
  const d = workspace.create({ title: "D (needs A and B)" });
  graph.setDependencies(workspace.id, b.id, [a.id]);
  graph.setDependencies(workspace.id, c.id, [a.id]);
  graph.setDependencies(workspace.id, d.id, [a.id, b.id]);
  setProvider(services, b.id, "claude-code");
  setProvider(services, d.id, "codex");

  assert.deepEqual(await graph.onTaskCompleted(a.id), []);
  complete(workspace, a.id);
  const results = await graph.onTaskCompleted(a.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].taskId, b.id);
  assert.equal(calls[0].provider, "claude-code");
  assert.equal(calls[0].workspaceId, workspace.id);
  assert.equal(
    results.find((r) => r.taskId === c.id).reason,
    "no provider on task",
  );
  assert.equal(
    results.find((r) => r.taskId === d.id),
    undefined,
  );
  assert.ok(
    audits.some(
      (e) => e.action === "workflow.auto-dispatch" && e.runId === "run-1",
    ),
  );

  // Same completion again does not double dispatch.
  await graph.onTaskCompleted(a.id);
  assert.equal(calls.length, 1);

  // Policy switch disables auto-dispatch.
  services.db
    .prepare("UPDATE workspaces SET policy = ? WHERE id = ?")
    .run(JSON.stringify({ autoDispatch: false }), workspace.id);
  complete(workspace, b.id);
  const blocked = await graph.onTaskCompleted(b.id);
  assert.equal(calls.length, 1);
  assert.match(blocked[0].reason, /autoDispatch disabled/);
});

test("dispatch failures are audited and recorded as events; watch() reacts to completions", async () => {
  const { services, graph, workspace, audits } = setup();
  services.runWorker = {
    start() {
      throw new Error("provider missing");
    },
  };
  const a = workspace.create({ title: "A" });
  const b = workspace.create({ title: "B" });
  graph.setDependencies(workspace.id, b.id, [a.id]);
  setProvider(services, b.id, "copilot");
  let unhandled = 0;
  const onUnhandled = () => unhandled++;
  process.on("unhandledRejection", onUnhandled);
  const unwatch = graph.watch();
  complete(workspace, a.id);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(audits.some((e) => e.action === "workflow.auto-dispatch.failed"));
  assert.ok(
    workspace
      .snapshot()
      .events.some(
        (e) => e.kind === "error" && /Auto-dispatch/.test(e.message),
      ),
  );
  unwatch();
  // RunWorker.start is async: a rejected launch is handled the same way,
  // never as an unhandled rejection, and never leaves the task "dispatched".
  services.runWorker = {
    async start() {
      throw new Error("binary not found");
    },
  };
  const rejected = await graph.onTaskCompleted(a.id);
  assert.equal(rejected[0].dispatched, false);
  assert.match(rejected[0].reason, /binary not found/);
  assert.equal(
    audits.filter((e) => e.action === "workflow.auto-dispatch.failed").length,
    2,
  );
  // Failed dispatch is retryable, and the real run id is recorded.
  let started = 0;
  services.runWorker = { start: async () => ({ id: `r${++started}` }) };
  const results = await graph.onTaskCompleted(a.id);
  assert.equal(results[0].dispatched, true);
  assert.equal(results[0].runId, "r1");
  assert.ok(
    audits.some(
      (e) => e.action === "workflow.auto-dispatch" && e.runId === "r1",
    ),
  );
  await new Promise((r) => setTimeout(r, 10));
  process.off("unhandledRejection", onUnhandled);
  assert.equal(unhandled, 0);
});

test("all 13 templates load, validate, and match the roadmap order", () => {
  const templates = listTemplates();
  assert.equal(templates.length, 13);
  assert.deepEqual(
    templates.map((t) => t.id),
    [
      "feature-delivery",
      "bug-clinic",
      "repository-onboarding",
      "release-room",
      "devops-incident-room",
      "data-engineering",
      "data-analytics",
      "research-desk",
      "documentation-studio",
      "design-review",
      "security-review",
      "agency-delivery",
      "marketing-operations",
    ],
  );
  for (const template of templates) {
    assert.ok(validateTemplate(template));
    for (const key of [
      "name",
      "domain",
      "priority",
      "description",
      "roles",
      "steps",
      "outputSchema",
      "rubric",
      "requiredTools",
      "sampleInputs",
    ])
      assert.ok(template[key] !== undefined, `${template.id} missing ${key}`);
    assert.ok(["Launch", "Growth", "Explore"].includes(template.priority));
    assert.ok(template.steps.length >= 3);
    for (const step of template.steps)
      for (const key of [
        "key",
        "title",
        "role",
        "deliverable",
        "acceptance",
        "dependsOn",
        "instructions",
      ])
        assert.ok(
          step[key] !== undefined,
          `${template.id}.${step.key} missing ${key}`,
        );
  }
  assert.equal(getTemplate("bug-clinic").steps.length, 4);
  assert.throws(() => getTemplate("nope"), /not found/);
  assert.throws(
    () =>
      validateTemplate({
        id: "x",
        roles: [],
        steps: [{ key: "a", dependsOn: ["zzz"] }],
      }),
    /unknown zzz/,
  );
  assert.equal(
    interpolate("Plan {{feature}} {{missing}}", { feature: "Search" }),
    "Plan Search {{missing}}",
  );
});

test("instantiating a template creates dependent tasks with interpolated titles", () => {
  const { services, workflows, workspace, graph } = setup();
  const agent = workspace.snapshot().agents[0];
  const workflow = workflows.instantiate(workspace.id, "feature-delivery", {
    inputs: { feature: "Saved filters" },
    provider: "claude-code",
    agentByRole: { architect: agent.id },
  });
  assert.equal(workflow.status, "active");
  assert.equal(workflow.templateId, "feature-delivery");
  assert.equal(workflow.tasks.length, 5);
  assert.equal(workflow.name, "Feature delivery: Saved filters");
  const byStep = Object.fromEntries(workflow.tasks.map((t) => [t.stepKey, t]));
  assert.equal(byStep.plan.title, "Plan Saved filters");
  assert.equal(byStep.qa.title, "Test Saved filters");
  assert.deepEqual(byStep.plan.dependsOn, []);
  assert.deepEqual(byStep.frontend.dependsOn, [byStep.plan.id]);
  assert.deepEqual(
    byStep.qa.dependsOn.sort(),
    [byStep.frontend.id, byStep.backend.id].sort(),
  );
  assert.deepEqual(byStep.review.dependsOn, [byStep.qa.id]);
  assert.equal(byStep.plan.provider, "claude-code");
  assert.equal(byStep.plan.priority, "high");
  assert.equal(byStep.plan.assignedAgentId, agent.id);
  assert.equal(byStep.plan.status, "QUEUE");
  assert.match(byStep.plan.description, /Deliverable: Implementation plan/);
  assert.match(byStep.plan.description, /Saved filters/);
  assert.equal(
    byStep.plan.deliverable,
    "Implementation plan (files, interfaces, risks)",
  );
  assert.deepEqual(workflow.ready, [byStep.plan.id]);
  assert.equal(workflow.progress.total, 5);
  assert.equal(workflow.progress.queued, 5);
  assert.equal(workflow.definition.inputs.feature, "Saved filters");
  assert.equal(
    workspace.snapshot().tasks.every((t) => t.source === "workflow"),
    true,
  );

  const list = workflows.list(workspace.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].definition, undefined);
  assert.equal(list[0].progress.total, 5);

  // Graph sees the same structure.
  const g = graph.graph(workspace.id);
  assert.equal(g.edges.length, 5);
  assert.equal(g.criticalPath.length, 4);

  // Status recompute: all completed → completed; rejected review → failed.
  const rows = workflows.get(workflow.id).tasks;
  for (const task of rows) {
    complete(workspace, task.id);
  }
  assert.equal(workflows.get(workflow.id).status, "completed");
  assert.equal(workflows.get(workflow.id).progress.percent, 100);

  const second = workflows.instantiate(workspace.id, "bug-clinic", {
    inputs: { issue: "Crash on save" },
  });
  assert.equal(second.tasks.length, 4);
  assert.equal(second.tasks[0].provider, null);
  const first = second.tasks[0];
  const idle = workspace.snapshot().agents.find((a) => !a.taskId);
  workspace.assign(first.id, idle.id);
  workspace.update(first.id, { status: "BLOCKED" });
  services.db
    .prepare("UPDATE tasks SET review = ? WHERE id = ?")
    .run(JSON.stringify({ runId: "x", status: "rejected" }), first.id);
  assert.equal(workflows.get(second.id).status, "failed");
  assert.equal(workflows.archive(second.id).status, "archived");
  assert.throws(() => workflows.get("nope"), /not found/);
  assert.throws(
    () =>
      workflows.instantiate(workspace.id, "feature-delivery", {
        agentByRole: { qa: "ghost" },
      }),
    /Agent not found/,
  );
});

test("export produces a portable manifest and import rewires dependencies by index", () => {
  const { services, workflows, workspace } = setup();
  workflows.instantiate(workspace.id, "bug-clinic", {
    inputs: { issue: "Leak" },
    provider: "codex",
  });
  services.db
    .prepare("UPDATE workspaces SET policy = ? WHERE id = ?")
    .run(
      JSON.stringify({ allowedFolders: ["C:/private/secrets-dir", "src"] }),
      workspace.id,
    );
  const manifest = exportWorkspace(services, workspace.id);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.workspace.name, "Graph");
  assert.equal(manifest.workspace.rootPathName, "graph");
  assert.ok(!JSON.stringify(manifest).includes("C:/work/graph"));
  assert.ok(!JSON.stringify(manifest).includes("C:/private"));
  assert.deepEqual(manifest.workspace.policy.allowedFolders, [
    "secrets-dir",
    "src",
  ]);
  assert.equal(manifest.agents.length, 6);
  assert.ok(manifest.agents.every((a) => a.id === undefined));
  assert.deepEqual(manifest.templatesUsed, ["bug-clinic"]);
  assert.equal(manifest.tasks.length, 4);
  assert.deepEqual(manifest.tasks[1].dependsOn, [0]);
  assert.deepEqual(manifest.tasks[3].dependsOn, [2]);
  assert.ok(manifest.excluded.includes("credentials"));

  const result = importWorkspace(services, manifest, { name: "Graph copy" });
  assert.equal(result.tasks, 4);
  assert.equal(result.agents, 6);
  const copy = services.hub.get(result.workspace.id);
  assert.equal(copy.record.name, "Graph copy");
  assert.equal(copy.record.rootPath, null);
  assert.equal(copy.snapshot().agents.length, 6);
  const graph = new TaskGraph(services).graph(copy.id);
  assert.equal(graph.nodes.length, 4);
  assert.equal(graph.edges.length, 3);
  assert.equal(graph.nodes[1].dependsOn[0], graph.nodes[0].id);
  assert.equal(graph.nodes[0].provider, "codex");
  assert.throws(
    () => importWorkspace(services, { version: 2 }, { name: "x" }),
    /version 1/,
  );
});
