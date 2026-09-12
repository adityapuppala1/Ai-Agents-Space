import test from "node:test";
import assert from "node:assert/strict";
import { createServices } from "../packages/core/src/services.js";
import {
  TaskGraph,
  checkGraph,
  deniedProvidersFor,
} from "../packages/core/src/workflows/TaskGraph.js";
import {
  WorkflowService,
  definitionHash,
} from "../packages/core/src/workflows/WorkflowService.js";
import { createWorkspaceServer } from "../packages/server/src/server.js";
import { validateContract } from "../packages/core/src/workflows/contracts.js";
import {
  stepsToNodes,
  applyEdit,
  applyEdits,
  definitionEdges,
  diffDefinitions,
} from "../packages/core/src/workflows/editor.js";

/**
 * The visual workflow editor's backend: the extracted graph checks, the pure
 * edit operations, and the save path that turns an edited definition into a
 * new reviewable version of the same file format.
 *
 * The editor never gets its own copy of cycle / unreachable / missing-input /
 * permission-conflict detection: every assertion below goes through the same
 * `checkGraph` the database path uses.
 */

function setup() {
  const services = createServices({ demo: false });
  const audits = [];
  services.audit = { record: (entry) => audits.push(entry) };
  const graph = new TaskGraph(services);
  const workflows = new WorkflowService(services, { graph });
  services.workflows = workflows;
  const workspace = services.hub.get(
    services.hub.create({ name: "Editor", rootPath: "C:/work/editor" }).id,
  );
  return { services, graph, workflows, workspace, audits };
}

function bugClinic(workflows, workspace) {
  return workflows.instantiate(workspace.id, "bug-clinic", {
    inputs: { issue: "Leak" },
  });
}

const NEW_STEP = {
  key: "triage",
  title: "Triage the report",
  role: "investigator",
  instructions: "Read the report and decide whether it reproduces at all.",
  deliverable: "A triage note",
};

/* ------------------------------------------------------------------ */
/* The extraction did not change what the database path reports        */
/* ------------------------------------------------------------------ */

test("the extracted checks report the same problems as the stored-graph path", () => {
  const { services, graph, workspace } = setup();
  const a = workspace.create({ title: "A" });
  const b = workspace.create({ title: "B" });
  const lonely = workspace.create({ title: "Needs input" });
  const scoped = workspace.create({ title: "Codex step" });
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
  services.db
    .prepare("UPDATE tasks SET provider = ? WHERE id = ?")
    .run("codex", scoped.id);
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
  const codes = report.problems.map((problem) => problem.code);
  for (const code of [
    "cycle",
    "unreachable",
    "missing-input",
    "permission-conflict",
  ])
    assert.ok(codes.includes(code), `expected a ${code} problem`);
  assert.deepEqual(
    report.problems
      .filter((problem) => problem.code === "unreachable")
      .map((problem) => problem.taskId)
      .sort(),
    [a.id, b.id].sort(),
  );

  // The scoping helper is the same one the graph uses.
  const denied = deniedProvidersFor(services.connections.list(), workspace.id);
  assert.match(denied.get("codex"), /not allowed in this workspace/);
  assert.equal(deniedProvidersFor([], workspace.id).size, 0);
});

/* ------------------------------------------------------------------ */
/* A definition validates through exactly the same checks              */
/* ------------------------------------------------------------------ */

test("a definition's steps project onto the node shape the graph checks", () => {
  const { workflows, workspace } = setup();
  const workflow = bugClinic(workflows, workspace);
  const definition = workflow.definition;
  const nodes = stepsToNodes(definition);

  assert.equal(nodes.length, definition.steps.length);
  for (const [index, node] of nodes.entries()) {
    const step = definition.steps[index];
    assert.equal(node.id, step.key);
    assert.deepEqual(node.dependsOn, step.dependsOn);
    assert.deepEqual(node.contract, validateContract(step.contract));
    assert.deepEqual(node.context.inputs, definition.inputs);
  }

  const report = checkGraph(nodes);
  assert.deepEqual(report, {
    ok: true,
    problems: [],
    checked: definition.steps.length,
  });
});

test("an edge that closes a loop is reported as a cycle and refuses to save", () => {
  const { workflows, workspace } = setup();
  const workflow = bugClinic(workflows, workspace);
  const looped = applyEdit(workflow.definition, {
    op: "add-edge",
    from: "regression",
    to: "reproduce",
  });

  const report = workflows.validateDraft(workflow.id, looped);
  assert.equal(report.ok, false);
  const cycle = report.problems.find((problem) => problem.code === "cycle");
  assert.ok(cycle, "expected a cycle problem");
  for (const key of ["reproduce", "diagnose", "fix", "regression"])
    assert.match(cycle.detail, new RegExp(key));

  assert.throws(() => workflows.saveDefinition(workflow.id, looped), /cycle/);
  assert.equal(workflows.get(workflow.id).version, 1, "nothing was written");
  assert.equal(workflows.versions(workflow.id).length, 1);
});

test("a second root is fine; a chain that never starts is unreachable", () => {
  const { workflows, workspace } = setup();
  const workflow = bugClinic(workflows, workspace);
  const withRoot = applyEdit(workflow.definition, {
    op: "add-step",
    step: NEW_STEP,
  });
  assert.equal(checkGraph(stepsToNodes(withRoot)).ok, true);

  // A loop leaves the graph with no starting step at all, so every step is
  // reported unreachable as well as part of the cycle.
  const looped = applyEdit(workflow.definition, {
    op: "add-edge",
    from: "regression",
    to: "reproduce",
  });
  const unreachable = checkGraph(stepsToNodes(looped)).problems.filter(
    (problem) => problem.code === "unreachable",
  );
  assert.deepEqual(unreachable.map((problem) => problem.taskId).sort(), [
    "diagnose",
    "fix",
    "regression",
    "reproduce",
  ]);
  assert.match(unreachable[0].detail, /dependency chain never starts/);
});

test("a required input the definition does not carry is a missing input", () => {
  const { workflows, workspace } = setup();
  const workflow = bugClinic(workflows, workspace);
  const needsSeverity = applyEdit(workflow.definition, {
    op: "add-step",
    step: {
      ...NEW_STEP,
      contract: {
        inputs: [{ key: "severity", type: "string", required: true }],
      },
    },
  });

  const missing = workflows
    .validateDraft(workflow.id, needsSeverity)
    .problems.filter((problem) => problem.code === "missing-input");
  assert.equal(missing.length, 1);
  assert.match(missing[0].detail, /required input "severity"/);

  const provided = structuredClone(needsSeverity);
  provided.inputs = { ...provided.inputs, severity: "high" };
  assert.equal(workflows.validateDraft(workflow.id, provided).ok, true);
});

test("a scoped-away provider and a denied tool are permission conflicts", () => {
  const { services, workflows, workspace } = setup();
  const workflow = bugClinic(workflows, workspace);
  services.connections = {
    list: () => [
      {
        provider: "codex",
        alias: "work",
        allowedWorkspaces: ["some-other-workspace"],
      },
    ],
  };
  const edited = applyEdits(workflow.definition, [
    { op: "add-step", step: { ...NEW_STEP, provider: "codex" } },
    {
      op: "add-step",
      step: {
        ...NEW_STEP,
        key: "publish",
        contract: { allowedTools: ["git push"] },
      },
    },
  ]);

  const problems = workflows
    .validateDraft(workflow.id, edited)
    .problems.filter((problem) => problem.code === "permission-conflict");
  const scoped = problems.find((problem) => problem.taskId === "triage");
  assert.match(scoped.detail, /not allowed in this workspace/);
  const denied = problems.find((problem) => problem.taskId === "publish");
  assert.match(denied.detail, /policy denies/);
});

/* ------------------------------------------------------------------ */
/* Pure edits                                                          */
/* ------------------------------------------------------------------ */

test("an edit never mutates the definition it was given", () => {
  const { workflows, workspace } = setup();
  const workflow = bugClinic(workflows, workspace);
  const definition = workflow.definition;
  const untouched = structuredClone(definition);

  assert.throws(
    () =>
      applyEdit(definition, {
        op: "add-step",
        step: { ...NEW_STEP, dependsOn: ["nope"] },
      }),
    /unknown step "nope"/,
  );
  const added = applyEdit(definition, { op: "add-step", step: NEW_STEP });
  assert.equal(added.steps.length, definition.steps.length + 1);
  assert.deepEqual(definition, untouched, "a successful edit clones too");

  const removed = applyEdit(added, {
    op: "remove-step",
    key: "regression",
    cascade: true,
  });
  assert.equal(added.steps.length, definition.steps.length + 1);
  assert.equal(removed.steps.length, definition.steps.length);
});

test("adding a step refuses a duplicate key, a bad key and an unknown role", () => {
  const { workflows, workspace } = setup();
  const workflow = bugClinic(workflows, workspace);
  const definition = workflow.definition;
  const bad = (step) => () => applyEdit(definition, { op: "add-step", step });

  assert.throws(bad({ ...NEW_STEP, key: "reproduce" }), /already exists/);
  assert.throws(bad({ ...NEW_STEP, key: "Triage Me" }), /must be lower-case/);
  assert.throws(
    bad({ ...NEW_STEP, role: "wizard" }),
    /role "wizard" is unknown/,
  );
  assert.throws(bad({ ...NEW_STEP, title: "" }), /title must be a non-empty/);
  assert.throws(
    () => applyEdit(definition, { op: "add-step" }),
    /needs a step object/,
  );
  assert.throws(
    () => applyEdit(definition, { op: "teleport-step" }),
    /Unknown edit/,
  );

  // A new step gets the contract shape the save path demands.
  const added = applyEdit(definition, { op: "add-step", step: NEW_STEP });
  const step = added.steps.at(-1);
  assert.equal(step.contract.timeoutMs, 900000);
  assert.deepEqual(step.acceptance, ["final-message-non-empty"]);
  assert.deepEqual(step.contract.completionCriteria, [
    "final-message-non-empty",
  ]);
});

test("removing a step refuses while others depend on it, and cascades on request", () => {
  const { workflows, workspace } = setup();
  const workflow = bugClinic(workflows, workspace);
  const definition = workflow.definition;

  assert.throws(
    () => applyEdit(definition, { op: "remove-step", key: "diagnose" }),
    /cannot be removed while fix depends on it/,
  );
  const cascaded = applyEdit(definition, {
    op: "remove-step",
    key: "diagnose",
    cascade: true,
  });
  assert.equal(
    cascaded.steps.some((step) => step.key === "diagnose"),
    false,
  );
  assert.equal(
    definitionEdges(cascaded).some(
      (edge) => edge.from === "diagnose" || edge.to === "diagnose",
    ),
    false,
  );
  assert.deepEqual(
    cascaded.steps.find((step) => step.key === "fix").dependsOn,
    [],
  );
});

test("edges are added and removed, and a diff reads like a review", () => {
  const { workflows, workspace } = setup();
  const workflow = bugClinic(workflows, workspace);
  const definition = workflow.definition;

  assert.throws(
    () => applyEdit(definition, { op: "add-edge", from: "fix", to: "fix" }),
    /cannot depend on itself/,
  );
  assert.throws(
    () => applyEdit(definition, { op: "add-edge", from: "ghost", to: "fix" }),
    /not in this workflow/,
  );
  assert.throws(
    () =>
      applyEdit(definition, { op: "add-edge", from: "diagnose", to: "fix" }),
    /already waits for/,
  );
  assert.throws(
    () =>
      applyEdit(definition, {
        op: "remove-edge",
        from: "reproduce",
        to: "fix",
      }),
    /does not wait for/,
  );

  const edited = applyEdits(definition, [
    { op: "add-step", step: { ...NEW_STEP, dependsOn: ["reproduce"] } },
    { op: "add-edge", from: "triage", to: "diagnose" },
    { op: "remove-edge", from: "reproduce", to: "diagnose" },
  ]);
  const diff = diffDefinitions(definition, edited);
  assert.deepEqual(diff.addedSteps, ["triage"]);
  assert.deepEqual(diff.removedSteps, []);
  assert.deepEqual(diff.changedSteps, []);
  assert.deepEqual(diff.addedEdges, [
    { from: "triage", to: "diagnose" },
    { from: "reproduce", to: "triage" },
  ]);
  assert.deepEqual(diff.removedEdges, [{ from: "reproduce", to: "diagnose" }]);
});

/* ------------------------------------------------------------------ */
/* Saving: a new version of the same file format                       */
/* ------------------------------------------------------------------ */

test("an edited graph round-trips through the versioned export unchanged", () => {
  const { workflows, workspace } = setup();
  const workflow = bugClinic(workflows, workspace);
  const edited = applyEdits(workflow.definition, [
    { op: "add-step", step: { ...NEW_STEP, dependsOn: ["reproduce"] } },
    { op: "add-edge", from: "triage", to: "diagnose" },
    { op: "remove-edge", from: "reproduce", to: "diagnose" },
  ]);

  const saved = workflows.saveDefinition(workflow.id, edited, {
    actor: "local-user",
  });
  assert.equal(saved.version, 2);
  assert.equal(saved.status, "draft");
  assert.equal(saved.publishedAt, null);
  // #recompute() rewrites the row status from the task state, so the durable
  // "nobody signed this off" signal is published_at, not status.
  assert.equal(workflows.definitionGraph(workflow.id).publishedAt, null);
  assert.equal(workflows.definitionGraph(workflow.id).version, 2);

  const exported = workflows.exportWorkflow(workflow.id);
  assert.equal(exported.formatVersion, 1);
  assert.deepEqual(exported.definition, edited);
  assert.equal(exported.definitionHash, definitionHash(edited));
  assert.equal(
    JSON.stringify(exported),
    JSON.stringify(workflows.exportWorkflow(workflow.id)),
    "the exported document is byte-identical on every call",
  );
  assert.doesNotThrow(() => workflows.importWorkflow(exported));

  // The previous version is intact and still hashes to what it did.
  const versions = workflows.versions(workflow.id);
  assert.ok(versions.length >= 2);
  assert.equal(
    workflows.version(workflow.id, 1).definitionHash,
    workflow.definitionHash,
  );
});

test("saving records an edit in the audit log with the shape of the change", () => {
  const { workflows, workspace, audits } = setup();
  const workflow = bugClinic(workflows, workspace);
  workflows.saveDefinition(
    workflow.id,
    applyEdit(workflow.definition, { op: "add-step", step: NEW_STEP }),
  );
  const entry = audits.findLast((row) => row.action === "workflow.edit");
  assert.ok(entry, "expected a workflow.edit audit entry");
  assert.equal(entry.target, workflow.id);
  assert.equal(entry.details.version, 2);
  assert.deepEqual(entry.details.addedSteps, ["triage"]);
  assert.equal(entry.details.status, "draft");
});

test("a stale expected hash refuses the save and names the current version", () => {
  const { workflows, workspace } = setup();
  const workflow = bugClinic(workflows, workspace);
  const edited = applyEdit(workflow.definition, {
    op: "add-step",
    step: NEW_STEP,
  });

  let thrown = null;
  try {
    workflows.saveDefinition(workflow.id, edited, {
      expectedHash: "0".repeat(64),
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, "a stale hash must be refused");
  assert.equal(thrown.status, 409);
  assert.match(thrown.message, /version 1/);
  assert.equal(workflows.get(workflow.id).version, 1);

  const saved = workflows.saveDefinition(workflow.id, edited, {
    expectedHash: workflow.definitionHash,
  });
  assert.equal(saved.version, 2);
});

test("a workflow owned by another engine cannot be edited here", () => {
  const { workflows, workspace } = setup();
  const workflow = bugClinic(workflows, workspace);
  workflows.adopt({ workflowId: workflow.id, owner: "temporal" });

  assert.equal(workflows.definitionGraph(workflow.id).editable, false);
  assert.equal(workflows.definitionGraph(workflow.id).owner, "temporal");
  let thrown = null;
  try {
    workflows.saveDefinition(
      workflow.id,
      applyEdit(workflow.definition, { op: "add-step", step: NEW_STEP }),
    );
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown?.status, 409);
  assert.match(thrown.message, /temporal/);
});

test("the save path reuses the template rules for roles and objective acceptance", () => {
  const { workflows, workspace } = setup();
  const workflow = bugClinic(workflows, workspace);

  const badRole = structuredClone(workflow.definition);
  badRole.steps[0].role = "wizard";
  let thrown = null;
  try {
    workflows.saveDefinition(workflow.id, badRole);
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown?.status, 400);
  assert.match(thrown.message, /unknown role wizard/);

  const subjective = structuredClone(workflow.definition);
  subjective.steps[0].acceptance = ["the fix looks good"];
  assert.throws(
    () => workflows.saveDefinition(workflow.id, subjective),
    /is not objective/,
  );
  assert.equal(workflows.get(workflow.id).version, 1);
});

test("removing a step reports drift and never deletes a materialized task", () => {
  const { services, workflows, workspace } = setup();
  const workflow = bugClinic(workflows, workspace);
  const diagnoseTask = workflow.tasks.find(
    (task) => task.stepKey === "diagnose",
  );
  assert.ok(diagnoseTask);

  const before = workflows.materialization(workflow.id);
  assert.deepEqual(
    before.steps.map((step) => step.key),
    ["reproduce", "diagnose", "fix", "regression"],
  );
  assert.equal(before.orphanTasks.length, 0);
  assert.equal(before.steps[0].taskId, workflow.tasks[0].id);
  assert.match(before.note, /does not delete tasks/);

  workflows.saveDefinition(
    workflow.id,
    applyEdit(workflow.definition, {
      op: "remove-step",
      key: "diagnose",
      cascade: true,
    }),
  );

  const after = workflows.materialization(workflow.id);
  assert.equal(
    after.steps.some((step) => step.key === "diagnose"),
    false,
  );
  const orphan = after.orphanTasks.find((task) => task.stepKey === "diagnose");
  assert.ok(orphan, "the already-created task is reported as drift");
  assert.equal(orphan.taskId, diagnoseTask.id);
  assert.ok(
    services.db
      .prepare("SELECT id FROM tasks WHERE id = ?")
      .get(diagnoseTask.id),
    "the task row is still there",
  );
});

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

async function listen(t) {
  const services = createServices({ demo: false });
  const server = createWorkspaceServer({ services, token: "" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await services.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const api = async (method, route, body) => {
    const response = await fetch(base + route, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: response.status, data };
  };
  return { services, api };
}

test("HTTP: read the definition, validate a draft, and save a new version", async (t) => {
  const { services, api } = await listen(t);
  const workspaceId = services.hub.create({
    name: "Routes",
    rootPath: "C:/work/routes",
  }).id;
  const created = await api(
    "POST",
    `/api/workspaces/${workspaceId}/workflows`,
    {
      templateId: "bug-clinic",
      inputs: { issue: "Leak" },
    },
  );
  assert.equal(created.status, 201);
  const id = created.data.id;

  const definition = await api("GET", `/api/workflows/${id}/definition`);
  assert.equal(definition.status, 200);
  assert.equal(definition.data.editable, true);
  assert.deepEqual(
    definition.data.steps.map((step) => step.key),
    ["reproduce", "diagnose", "fix", "regression"],
  );
  assert.deepEqual(definition.data.edges, [
    { from: "reproduce", to: "diagnose" },
    { from: "diagnose", to: "fix" },
    { from: "fix", to: "regression" },
  ]);
  assert.deepEqual(definition.data.requiredTools.length > 0, true);

  const edited = applyEdit(definition.data.definition, {
    op: "add-step",
    step: { ...NEW_STEP, dependsOn: ["reproduce"] },
  });

  const draft = await api("POST", `/api/workflows/${id}/validate-draft`, {
    definition: edited,
  });
  assert.equal(draft.status, 200);
  assert.equal(draft.data.ok, true);
  assert.equal(draft.data.checked, 5);
  assert.equal(
    (await api("GET", `/api/workflows/${id}`)).data.version,
    1,
    "validating writes nothing",
  );

  const saved = await api("PUT", `/api/workflows/${id}/definition`, {
    definition: edited,
    expectedHash: definition.data.definitionHash,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.version, 2);
  assert.equal(saved.data.status, "draft");

  const stale = await api("PUT", `/api/workflows/${id}/definition`, {
    definition: edited,
    expectedHash: definition.data.definitionHash,
  });
  assert.equal(stale.status, 409);
  assert.match(stale.data.error, /Reload before saving/);

  const drift = await api("GET", `/api/workflows/${id}/materialization`);
  assert.equal(drift.status, 200);
  assert.equal(
    drift.data.steps.find((step) => step.key === "triage").taskId,
    null,
    "a new step has no task until the workflow is instantiated again",
  );

  // The existing actions still route.
  assert.equal((await api("GET", `/api/workflows/${id}/validate`)).status, 200);
  assert.equal((await api("GET", `/api/workflows/${id}/export`)).status, 200);
  assert.equal((await api("GET", `/api/workflows/${id}/versions`)).status, 200);

  const huge = await api("PUT", `/api/workflows/${id}/definition`, {
    definition: { ...edited, notes: "x".repeat(300000) },
  });
  assert.equal(huge.status, 413);
});

test("a proposed dependency change is checked before anything is written", () => {
  const { graph, workspace } = setup();
  const a = workspace.create({ title: "A" });
  const b = workspace.create({ title: "B" });
  graph.setDependencies(workspace.id, b.id, [a.id]);
  assert.equal(graph.validateWorkflow(workspace.id).ok, true);

  // Observed in the dependency map: "VALID" was shown for the saved graph
  // while an unsaved draft on screen would have closed a cycle.
  const report = graph.validateProposedDependencies(workspace.id, a.id, [b.id]);
  assert.equal(report.ok, false);
  assert.ok(report.problems.some((problem) => problem.code === "cycle"));
  // Checking never writes.
  const stored = graph
    .graph(workspace.id)
    .nodes.find((node) => node.id === a.id);
  assert.deepEqual(stored.dependsOn, []);

  assert.equal(
    graph.validateProposedDependencies(workspace.id, a.id, []).ok,
    true,
  );
  assert.throws(
    () => graph.validateProposedDependencies(workspace.id, "missing", []),
    (error) => error.status === 404,
  );
});
