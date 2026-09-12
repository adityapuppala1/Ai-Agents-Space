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
        inputs: { feature: "Ghost check" },
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

/* ------------------------------------------------------------------ */
/* Wave 2: contracts, branches, repair loops, ownership, versions      */
/* ------------------------------------------------------------------ */

function setProviderAndAgent(services, workspace, taskId, provider) {
  const agent = workspace.snapshot().agents.find((a) => !a.taskId);
  services.db
    .prepare(
      "UPDATE tasks SET provider = ?, assigned_agent_id = ? WHERE id = ?",
    )
    .run(provider, agent.id, taskId);
  return agent;
}

test("branch conditions run or skip a step, and dependents still evaluate", async () => {
  const { services, graph, workspace } = setup();
  const calls = [];
  services.runWorker = {
    start(input) {
      calls.push(input.taskId);
      return { id: `run-${calls.length}` };
    },
  };
  const gate = workspace.create({ title: "Gate" });
  const onSuccess = workspace.create({ title: "Ship" });
  const onFailure = workspace.create({ title: "Investigate" });
  const after = workspace.create({ title: "Announce" });
  graph.setDependencies(workspace.id, onSuccess.id, [gate.id]);
  graph.setDependencies(workspace.id, onFailure.id, [gate.id]);
  graph.setDependencies(workspace.id, after.id, [onFailure.id]);
  setProvider(services, onSuccess.id, "claude-code");
  setProvider(services, onFailure.id, "claude-code");
  setProvider(services, after.id, "claude-code");
  graph.setBranchCondition(workspace.id, onSuccess.id, {
    when: "previous.status",
    equals: "COMPLETED",
    then: "run",
  });
  graph.setBranchCondition(workspace.id, onFailure.id, {
    when: "previous.status",
    equals: "COMPLETED",
    then: "skip",
  });
  assert.throws(
    () =>
      graph.setBranchCondition(workspace.id, onFailure.id, {
        when: "vibes",
        equals: true,
      }),
    /when must be one of/,
  );

  complete(workspace, gate.id);
  const results = await graph.onTaskCompleted(gate.id);
  assert.deepEqual(calls.sort(), [onSuccess.id, after.id].sort());
  const skipped = results.find((r) => r.taskId === onFailure.id);
  assert.equal(skipped.skipped, true);
  assert.match(skipped.reason, /skipped by condition/);
  const skippedNode = graph.node(onFailure.id);
  assert.equal(skippedNode.status, "COMPLETED");
  assert.equal(skippedNode.review.note, "skipped by condition");
  assert.equal(skippedNode.review.skipped, true);
  assert.equal(
    skippedNode.review.status,
    "skipped",
    "a step nobody reviewed is not 'accepted'",
  );
  // The dependent of the skipped step was evaluated in the same pass.
  assert.ok(results.some((r) => r.taskId === after.id && r.dispatched));
  assert.ok(
    workspace
      .snapshot()
      .events.some((e) =>
        /was skipped by its branch condition/.test(e.message),
      ),
  );
});

test("a step skipped by a branch condition does not satisfy a previous.review=accepted gate", async () => {
  const { services, graph, workspace } = setup();
  const calls = [];
  services.runWorker = {
    start(input) {
      calls.push(input.taskId);
      return { id: `run-${calls.length}` };
    },
  };
  // A -> B -> C. B is skipped when A completes; C runs only on an accepted
  // review of B. Nobody reviewed B and nothing ran, so C must not dispatch.
  const a = workspace.create({ title: "A" });
  const b = workspace.create({ title: "B" });
  const c = workspace.create({ title: "C" });
  graph.setDependencies(workspace.id, b.id, [a.id]);
  graph.setDependencies(workspace.id, c.id, [b.id]);
  setProvider(services, b.id, "claude-code");
  setProvider(services, c.id, "claude-code");
  graph.setBranchCondition(workspace.id, b.id, {
    when: "previous.status",
    equals: "COMPLETED",
    then: "skip",
  });
  graph.setBranchCondition(workspace.id, c.id, {
    when: "previous.review",
    equals: "accepted",
    then: "run",
  });

  complete(workspace, a.id);
  const results = await graph.onTaskCompleted(a.id);
  assert.equal(graph.node(b.id).review.status, "skipped");
  assert.ok(
    !calls.includes(c.id),
    "C is not dispatched on a review that never happened",
  );
  const forC = results.find((r) => r.taskId === c.id);
  assert.ok(forC, "C was evaluated when B finished");
  assert.equal(forC.dispatched ?? false, false);
  assert.match(
    forC.reason,
    /"skipped"/,
    "the reason names the review status that was actually observed",
  );

  // A gate written against the skip is the way to run on this path.
  const { graph: g2, services: s2, workspace: w2 } = setup();
  const dispatched = [];
  s2.runWorker = {
    start(input) {
      dispatched.push(input.taskId);
      return { id: "run-x" };
    },
  };
  const a2 = w2.create({ title: "A" });
  const b2 = w2.create({ title: "B" });
  const c2 = w2.create({ title: "C" });
  g2.setDependencies(w2.id, b2.id, [a2.id]);
  g2.setDependencies(w2.id, c2.id, [b2.id]);
  setProvider(s2, b2.id, "claude-code");
  setProvider(s2, c2.id, "claude-code");
  g2.setBranchCondition(w2.id, b2.id, {
    when: "previous.status",
    equals: "COMPLETED",
    then: "skip",
  });
  g2.setBranchCondition(w2.id, c2.id, {
    when: "previous.review",
    equals: "skipped",
    then: "run",
  });
  complete(w2, a2.id);
  await g2.onTaskCompleted(a2.id);
  assert.deepEqual(dispatched, [c2.id]);
});

test("task contracts validate an output schema and objective criteria", () => {
  const { graph, workspace } = setup();
  const task = workspace.create({ title: "Emit a report" });
  const contract = {
    inputs: [{ key: "issue", type: "string", required: true }],
    outputSchema: {
      type: "object",
      required: ["summary", "findings"],
      properties: {
        summary: { type: "string" },
        findings: { type: "array", items: { type: "string" } },
        severity: { enum: ["low", "high"] },
      },
    },
    completionCriteria: ["final-message-non-empty", "test-passed"],
    timeoutMs: 60000,
    allowedTools: ["Read", "Bash"],
    budget: { maxTokens: 100000, maxRuns: 2 },
    reviewer: "human",
  };
  graph.setContract(workspace.id, task.id, contract);
  const stored = graph.contract(task.id);
  assert.equal(stored.budget.maxTokens, 100000);
  assert.equal(stored.budget.maxRuns, 2);
  assert.equal(stored.reviewer, "human");
  assert.deepEqual(stored.inputs, [
    { key: "issue", type: "string", required: true },
  ]);

  // Subjective criteria are refused outright.
  assert.throws(
    () =>
      graph.setContract(workspace.id, task.id, {
        completionCriteria: ["the code looks good"],
      }),
    /not objective/,
  );

  // Required inputs.
  assert.equal(graph.checkTaskInputs(task.id).ok, false);
  assert.equal(graph.checkTaskInputs(task.id, { issue: "leak" }).ok, true);

  // A passing result.
  const pass = graph.recordResult(task.id, {
    runId: "run-x",
    artifacts: [
      {
        kind: "message",
        content: JSON.stringify({
          summary: "ok",
          findings: ["a"],
          severity: "low",
        }),
      },
    ],
    finalMessage: "Done",
    events: [{ kind: "test", data: { command: "npm test", exitCode: 0 } }],
  });
  assert.equal(pass.ok, true);
  assert.deepEqual(graph.node(task.id).review, {});

  // A failing result: wrong types, missing property, no test, no message.
  const fail = graph.recordResult(task.id, {
    runId: "run-y",
    artifacts: [
      {
        kind: "message",
        content: JSON.stringify({ summary: 5, severity: "urgent" }),
      },
    ],
    finalMessage: "",
    events: [],
  });
  assert.equal(fail.ok, false);
  const criteria = fail.failures.map((f) => f.criterion);
  assert.ok(criteria.includes("final-message-non-empty"));
  assert.ok(criteria.includes("test-passed"));
  assert.ok(criteria.includes("output-schema"));
  const details = fail.failures.map((f) => f.detail).join(" | ");
  assert.match(details, /summary should be string/);
  assert.match(details, /findings is required and missing/);
  assert.match(details, /severity should be one of/);
  const review = graph.node(task.id).review;
  assert.equal(review.status, "pending");
  assert.equal(review.runId, "run-y");
  assert.equal(review.failures.length, fail.failures.length);
});

test("a reviewer agent on another provider gets a review task; rejection opens a bounded repair loop", () => {
  const { services, graph, workspace } = setup();
  const designer = workspace.snapshot().agents[0];
  const reviewer = workspace.snapshot().agents[1];
  services.db
    .prepare("UPDATE agent_profiles SET provider = ? WHERE id = ?")
    .run("claude-code", designer.id);
  services.db
    .prepare("UPDATE agent_profiles SET provider = ? WHERE id = ?")
    .run("codex", reviewer.id);
  const task = workspace.create({ title: "Write the parser" });
  services.db
    .prepare(
      "UPDATE tasks SET provider = 'claude-code', assigned_agent_id = ? WHERE id = ?",
    )
    .run(designer.id, task.id);
  graph.setContract(workspace.id, task.id, {
    completionCriteria: ["file-edited"],
    reviewer: reviewer.id,
  });

  const failed = graph.recordResult(task.id, {
    runId: "run-1",
    artifacts: [],
    finalMessage: "I could not find the file",
    events: [],
  });
  assert.equal(failed.ok, false);
  assert.ok(failed.reviewTaskId);
  assert.equal(failed.repairTaskId, null);
  const reviewTask = graph.node(failed.reviewTaskId);
  assert.equal(
    reviewTask.provider,
    "codex",
    "the reviewer runs on a different provider",
  );
  assert.equal(reviewTask.agentId, reviewer.id);
  assert.deepEqual(reviewTask.dependsOn, [task.id]);
  assert.match(reviewTask.title, /^Review: /);

  // Rejecting opens repair 1, then repair 2, then the chain stops.
  const first = graph.resolveReview(task.id, {
    decision: "reject",
    note: "the parser was never written",
  });
  assert.equal(first.review.status, "rejected");
  assert.equal(first.repair.exhausted, false);
  assert.equal(first.repair.attempts, 1);
  const repair1 = graph.node(first.repair.taskId);
  assert.equal(repair1.repairOf, task.id);
  assert.equal(repair1.provider, "claude-code");
  assert.deepEqual(repair1.dependsOn, [task.id]);

  const second = graph.createRepairTask(task.id, { reason: "still wrong" });
  assert.equal(second.attempts, 2);
  assert.equal(second.exhausted, false);
  const third = graph.createRepairTask(task.id, { reason: "still wrong" });
  assert.equal(third.exhausted, true);
  assert.equal(third.taskId, null);
  assert.equal(third.max, 2);
  assert.ok(
    workspace
      .snapshot()
      .events.some((e) => /Repair loop for .* stopped after/.test(e.message)),
  );
  const inbox = graph.inbox(workspace.id);
  assert.ok(inbox.repairExhausted.some((entry) => entry.taskId === task.id));

  // A higher cap from the workspace policy is honoured.
  services.db
    .prepare("UPDATE workspaces SET policy = ? WHERE id = ?")
    .run(JSON.stringify({ maxRepairAttempts: 3 }), workspace.id);
  assert.equal(graph.maxRepairAttempts(workspace.id), 3);
  assert.equal(graph.createRepairTask(task.id, {}).exhausted, false);

  // Accepting simply records the verdict.
  const accepted = graph.resolveReview(task.id, { decision: "accept" });
  assert.equal(accepted.review.status, "accepted");
  assert.equal(accepted.repair, null);
  assert.throws(
    () => graph.resolveReview(task.id, { decision: "maybe" }),
    /accept/,
  );
});

test("validation reports cycles, unreachable steps, missing inputs, and permission conflicts", () => {
  const { services, graph, workspace } = setup();
  const a = workspace.create({ title: "A" });
  const b = workspace.create({ title: "B" });
  const lonely = workspace.create({ title: "Needs input" });
  const scoped = workspace.create({ title: "Codex step" });
  // A cycle written straight to the database (validate() would refuse it).
  services.db
    .prepare("UPDATE tasks SET depends_on = ? WHERE id = ?")
    .run(JSON.stringify([b.id]), a.id);
  services.db
    .prepare("UPDATE tasks SET depends_on = ? WHERE id = ?")
    .run(JSON.stringify([a.id]), b.id);
  graph.setContract(workspace.id, lonely.id, {
    inputs: [{ key: "brief", type: "string", required: true }],
    allowedTools: ["git push"],
  });
  setProvider(services, scoped.id, "codex");
  services.connections = {
    list: () => [
      {
        provider: "codex",
        alias: "work",
        allowedWorkspaces: ["some-other-workspace"],
      },
    ],
  };

  const report = graph.validateWorkflow(workspace.id);
  assert.equal(report.ok, false);
  const codes = report.problems.map((p) => p.code);
  assert.ok(codes.includes("cycle"));
  assert.ok(codes.includes("unreachable"));
  assert.ok(codes.includes("missing-input"));
  assert.ok(codes.includes("permission-conflict"));
  const unreachable = report.problems.filter((p) => p.code === "unreachable");
  assert.deepEqual(
    unreachable.map((p) => p.taskId).sort(),
    [a.id, b.id].sort(),
  );
  const conflict = report.problems.find(
    (p) => p.code === "permission-conflict" && p.taskId === scoped.id,
  );
  assert.match(conflict.detail, /not allowed in this workspace/);
  const toolConflict = report.problems.find(
    (p) => p.code === "permission-conflict" && p.taskId === lonely.id,
  );
  assert.match(toolConflict.detail, /policy denies/);
  const missing = report.problems.find((p) => p.code === "missing-input");
  assert.match(missing.detail, /required input "brief"/);

  // A clean graph validates.
  const clean = services.hub.get(
    services.hub.create({ name: "Clean", rootPath: "C:/work/clean" }).id,
  );
  clean.create({ title: "Only step" });
  assert.equal(graph.validateWorkflow(clean.id).ok, true);
});

test("idempotency keys stop a double dispatch while a run is active", async () => {
  const { services, graph, workspace } = setup();
  const task = workspace.create({ title: "Once only" });
  const agent = setProviderAndAgent(
    services,
    workspace,
    task.id,
    "claude-code",
  );
  const key = graph.idempotencyKeyFor({
    workspaceId: workspace.id,
    taskId: task.id,
    attempt: 1,
    prompt: "Once only",
  });
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(
    graph.idempotencyKeyFor({
      workspaceId: workspace.id,
      taskId: task.id,
      attempt: 2,
      prompt: "Once only",
    }) === key,
    false,
    "a new attempt gets a new key",
  );

  const first = graph.claimDispatch({
    workspaceId: workspace.id,
    taskId: task.id,
    prompt: "Once only",
  });
  assert.equal(first.ok, true);
  assert.equal(first.key, key);
  // No active run yet: the same claim is allowed again.
  assert.equal(
    graph.claimDispatch({
      workspaceId: workspace.id,
      taskId: task.id,
      prompt: "Once only",
    }).ok,
    true,
  );
  services.db
    .prepare(
      `INSERT INTO runs (id, workspace_id, task_id, agent_id, agent_snapshot, provider, status, started_at, mode)
       VALUES ('run-active', ?, ?, ?, '{}', 'claude-code', 'running', ?, 'managed')`,
    )
    .run(workspace.id, task.id, agent.id, Date.now());
  const second = graph.claimDispatch({
    workspaceId: workspace.id,
    taskId: task.id,
    prompt: "Once only",
  });
  assert.equal(second.ok, false);
  assert.match(second.reason, /same idempotency key is already active/);
  assert.match(
    second.reason,
    /side effect the provider already made still stands/,
  );
  assert.equal(second.runId, "run-active");
  // A different attempt is a different key and is allowed.
  assert.equal(
    graph.claimDispatch({
      workspaceId: workspace.id,
      taskId: task.id,
      attempt: 2,
      prompt: "Once only",
    }).ok,
    true,
  );
  graph.releaseDispatch(task.id);
  assert.equal(graph.node(task.id).idempotencyKey, null);

  // Auto-dispatch uses the claim, so one completion cannot start two runs.
  const upstream = workspace.create({ title: "Upstream" });
  const downstream = workspace.create({ title: "Downstream" });
  graph.setDependencies(workspace.id, downstream.id, [upstream.id]);
  setProvider(services, downstream.id, "claude-code");
  const started = [];
  services.runWorker = {
    start(input) {
      started.push(input.taskId);
      services.db
        .prepare(
          `INSERT INTO runs (id, workspace_id, task_id, agent_id, agent_snapshot, provider, status, started_at, mode)
           VALUES (?, ?, ?, ?, '{}', 'claude-code', 'running', ?, 'managed')`,
        )
        .run(
          `run-${started.length}`,
          workspace.id,
          input.taskId,
          agent.id,
          Date.now(),
        );
      return { id: `run-${started.length}` };
    },
  };
  complete(workspace, upstream.id);
  await graph.onTaskCompleted(upstream.id);
  graph.dispatched.clear();
  const again = await graph.onTaskCompleted(upstream.id);
  assert.equal(started.length, 1, "the second pass refuses the same key");
  assert.match(
    again.find((r) => r.taskId === downstream.id).reason,
    /already active/,
  );
});

test("an external orchestration owner blocks dispatch, retry, and reassignment", async () => {
  const { services, graph, workflows, workspace } = setup();
  const workflow = workflows.instantiate(workspace.id, "bug-clinic", {
    inputs: { issue: "Crash" },
    provider: "claude-code",
  });
  const [first, second] = workflow.tasks;
  const agent = workspace.snapshot().agents[0];
  services.db
    .prepare(
      `INSERT INTO runs (id, workspace_id, task_id, agent_id, agent_snapshot, provider, status, started_at, mode)
       VALUES ('run-ext', ?, ?, ?, '{}', 'claude-code', 'failed', ?, 'managed')`,
    )
    .run(workspace.id, second.id, agent.id, Date.now());

  assert.equal(graph.ownershipFor(second.id).local, true);
  assert.equal(workflows.ownership(workflow.id).owner, "agent-space");
  graph.assertRetryAllowed("run-ext");

  const adopted = workflows.adopt({
    workflowId: workflow.id,
    owner: "temporal",
    externalId: "wf-9876",
  });
  assert.equal(adopted.owner, "temporal");
  assert.equal(adopted.externalId, "wf-9876");
  assert.equal(
    services.db
      .prepare("SELECT orchestration_owner FROM runs WHERE id = 'run-ext'")
      .get().orchestration_owner,
    "temporal",
  );
  const ownership = graph.ownershipFor(second.id);
  assert.equal(ownership.local, false);
  assert.equal(ownership.externalId, "wf-9876");
  assert.match(ownership.reason, /owned by "temporal"/);
  assert.match(ownership.reason, /does not dispatch, retry, or reassign/);
  assert.throws(
    () => graph.assertRetryAllowed("run-ext"),
    /owned by "temporal"/,
  );
  assert.throws(() => graph.assertLocalOwnership(second.id), /temporal/);
  assert.equal(
    workflows.checkDispatch(workflow.id).allowed,
    false,
    "the dispatch gate refuses while an external engine owns the workflow",
  );

  const calls = [];
  services.runWorker = {
    start(input) {
      calls.push(input.taskId);
      return { id: "nope" };
    },
  };
  complete(workspace, first.id);
  const results = await graph.onTaskCompleted(first.id);
  assert.equal(calls.length, 0);
  assert.match(results[0].reason, /owned by "temporal"/);
  assert.ok(
    workspace
      .snapshot()
      .events.some((e) => /orchestrated by temporal/.test(e.message)),
  );

  // Taking ownership back re-enables dispatch.
  workflows.adopt({ workflowId: workflow.id, owner: "agent-space" });
  assert.equal(graph.ownershipFor(second.id).local, true);
  assert.equal(workflows.checkDispatch(workflow.id).allowed, true);
});

test("workflow versions export deterministically, publish, and roll back with hashes", () => {
  const { workflows, workspace } = setup();
  const workflow = workflows.instantiate(workspace.id, "bug-clinic", {
    inputs: { issue: "Leak" },
  });
  assert.equal(workflow.version, 1);
  assert.match(workflow.definitionHash, /^[0-9a-f]{64}$/);

  const exported = workflows.exportWorkflow(workflow.id);
  assert.equal(exported.formatVersion, 1);
  assert.equal(exported.definitionHash, workflow.definitionHash);
  // Deterministic: byte-identical on every export.
  assert.equal(
    JSON.stringify(exported),
    JSON.stringify(workflows.exportWorkflow(workflow.id)),
  );
  assert.ok(!JSON.stringify(exported).includes("exportedAt"));

  // Import creates version 2 as a draft; the hash must match the definition.
  const edited = {
    ...exported,
    definition: {
      ...exported.definition,
      quotas: { maxRuns: 3 },
      triggers: ["manual"],
    },
  };
  delete edited.definitionHash;
  const imported = workflows.importWorkflow(edited);
  assert.equal(imported.version, 2);
  assert.equal(imported.status, "draft");
  assert.notEqual(imported.definitionHash, workflow.definitionHash);
  assert.throws(
    () =>
      workflows.importWorkflow({ ...edited, definitionHash: "0".repeat(64) }),
    /does not match the definition/,
  );
  assert.throws(
    () => workflows.importWorkflow({ formatVersion: 99 }),
    /formatVersion 1/,
  );
  assert.throws(
    () =>
      workflows.importWorkflow({
        ...edited,
        definition: { ...edited.definition, triggers: ["telepathy"] },
      }),
    /Unknown trigger/,
  );

  const published = workflows.publish(workflow.id, 2);
  assert.equal(published.status, "active");
  assert.equal(published.version, 2);
  assert.ok(published.publishedAt);
  assert.equal(workflows.versions(workflow.id).length, 2);
  assert.ok(workflows.versions(workflow.id)[0].publishedAt);

  // Quotas and permitted triggers are enforced at dispatch.
  assert.equal(
    workflows.checkDispatch(workflow.id, { trigger: "manual" }).allowed,
    true,
  );
  const byWebhook = workflows.checkDispatch(workflow.id, {
    trigger: "webhook",
  });
  assert.equal(byWebhook.allowed, false);
  assert.match(byWebhook.reason, /not permitted/);

  // Rollback creates version 3 from version 1 and publishes it.
  const rolledBack = workflows.rollback(workflow.id, 1);
  assert.equal(rolledBack.version, 3);
  assert.equal(rolledBack.status, "active");
  assert.equal(rolledBack.definitionHash, workflow.definitionHash);
  assert.equal(workflows.versions(workflow.id).length, 3);
  assert.equal(
    workflows.exportWorkflow(workflow.id, { version: 1 }).definitionHash,
    workflow.definitionHash,
  );
  assert.throws(() => workflows.version(workflow.id, 9), /version 9 not found/);
});

test("a template is never instantiated with its placeholders unfilled", async () => {
  const { workflows, workspace } = setup();
  const { listTemplates, templateInputKeys, getTemplate } =
    await import("../packages/core/src/workflows/templates/index.js");
  // Every listed template says which inputs it needs.
  const agency = listTemplates().find((t) => t.id === "agency-delivery");
  assert.deepEqual(agency.inputKeys, ["client", "deliverable"]);
  assert.deepEqual(templateInputKeys(getTemplate("bug-clinic")), ["issue"]);

  // Observed: setup's one-click "Create tasks" sent no inputs and produced
  // tasks titled "Scope the brief for {{client}}: {{deliverable}}".
  const before = workspace.snapshot().tasks.length;
  assert.throws(
    () =>
      workflows.instantiate(workspace.id, "agency-delivery", { inputs: {} }),
    (error) =>
      error.status === 400 && /client, deliverable/.test(error.message),
  );
  assert.throws(
    () =>
      workflows.instantiate(workspace.id, "agency-delivery", {
        inputs: { client: "Acme", deliverable: "   " },
      }),
    (error) => error.status === 400 && /deliverable/.test(error.message),
  );
  assert.equal(
    workspace.snapshot().tasks.length,
    before,
    "nothing was created",
  );

  const workflow = workflows.instantiate(workspace.id, "agency-delivery", {
    inputs: { client: "Acme", deliverable: "Landing page" },
  });
  assert.ok(workflow.tasks.every((task) => !/\{\{/.test(task.title)));
});
