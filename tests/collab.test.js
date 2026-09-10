import test from "node:test";
import assert from "node:assert/strict";
import { createServices } from "../packages/core/src/services.js";
import { RunRecorder } from "../packages/core/src/runs/RunRecorder.js";
import { Settings } from "../packages/core/src/settings/Settings.js";
import { Audit } from "../packages/core/src/audit/Audit.js";
import { ApprovalService } from "../packages/core/src/approvals/ApprovalService.js";
import { Handover } from "../packages/core/src/collab/Handover.js";
import { Decisions } from "../packages/core/src/collab/Decisions.js";
import collabRoutes from "../packages/server/src/routes/collab.js";

function setup(t) {
  let clock = 3_000_000;
  const now = () => clock;
  const services = createServices({ demo: false });
  t.after(() => services.close());
  services.settings ??= new Settings(services.db);
  services.audit ??= new Audit(services.db, { now });
  services.recorder = new RunRecorder(services, { broadcastIntervalMs: 1 });
  services.decisions = new Decisions(services, { now });
  services.approvals = new ApprovalService(services, {
    now,
    defaultTtlMs: 600_000,
    sweepMs: 1_000_000,
  });
  services.handover = new Handover(services, { now });
  const workspace = services.hub.get(
    services.hub.create({ name: "Collab", rootPath: "C:\\work" }).id,
  );
  const agent = workspace.createAgent({
    name: "Claude Code",
    role: "Coding assistant",
  });
  const run = services.recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agent.id,
    mode: "managed",
    provider: "claude-code",
    providerSessionId: "session-1",
    createTask: { title: "Ship the login fix" },
  });
  services.db
    .prepare(
      "UPDATE tasks SET assigned_agent_id = ?, deliverable = ? WHERE id = ?",
    )
    .run(agent.id, "A reviewed patch", run.taskId);
  return {
    services,
    workspace,
    agent,
    run,
    advance: (ms) => (clock += ms),
    now,
  };
}

test("a handover brief is built from records and versions human edits attributably", (t) => {
  const { services, workspace, run, advance } = setup(t);
  services.approvals.request({
    runId: run.id,
    kind: "command",
    payload: { command: "npm test" },
    reason: "test command needs approval",
  });
  services.recorder.addArtifact(run.id, {
    kind: "diff",
    path: "C:\\work",
    title: "Changes (git diff)",
    content: "diff --git a/app.js b/app.js\n",
    metadata: { files: [{ path: "app.js", status: "M" }] },
  });

  const built = services.handover.build({ runId: run.id });
  assert.match(built.markdown, /# Handover brief — Ship the login fix/);
  assert.match(built.markdown, /## Decisions/);
  assert.match(built.markdown, /Changes \(git diff\)/);
  assert.match(built.markdown, /Waiting for a decision: npm test/);
  assert.equal(built.sources.approvals, 1);
  assert.ok(
    !/percent|progress bar/i.test(built.markdown),
    "the brief never invents progress",
  );

  const brief = services.handover.create({
    runId: run.id,
    author: "system",
  });
  assert.equal(brief.version, 1);
  assert.equal(brief.edited, false);
  assert.equal(brief.editedBy, null);
  assert.equal(brief.workspaceId, workspace.id);

  advance(1000);
  const edited = services.handover.save({
    id: brief.id,
    body: `${brief.body}\n\nHuman note: ask the reviewer about the redirect.`,
    editedBy: "alice",
  });
  assert.equal(edited.version, 2);
  assert.equal(edited.edited, true);
  assert.equal(edited.editedBy, "alice");
  assert.equal(
    edited.generated,
    brief.generated,
    "the generated baseline is kept next to the edit",
  );
  assert.match(edited.body, /Human note/);

  const history = services.handover.history(brief.id);
  assert.deepEqual(
    history.map((v) => [v.version, v.editedBy]),
    [
      [1, null],
      [2, "alice"],
    ],
  );
  assert.equal(services.handover.get(brief.id).version, 2);
  assert.equal(services.handover.list({ workspaceId: workspace.id }).length, 1);
  assert.throws(
    () => services.handover.save({ id: brief.id, body: "  " }),
    /body is required/,
  );
  assert.throws(
    () => services.handover.get("nope"),
    (e) => e.status === 404,
  );
  assert.equal(
    services.audit.list({ action: "handover.save" }).length,
    1,
    "human edits are auditable",
  );
});

test("decision history joins approvals, outcomes and reviews chronologically", (t) => {
  const { services, workspace, run, advance } = setup(t);
  const approval = services.approvals.request({
    runId: run.id,
    kind: "command",
    payload: { command: "git push origin main" },
    reason: "push needs approval",
  });
  advance(1000);
  services.approvals.decide(approval.id, {
    decision: "request-change",
    actor: "alice",
    note: "push to a branch instead",
  });
  advance(1000);
  services.approvals.decide(approval.id, {
    decision: "deny",
    actor: "alice",
    note: "not today",
  });
  services.db.prepare("UPDATE tasks SET review = ? WHERE id = ?").run(
    JSON.stringify({
      runId: run.id,
      status: "rejected",
      note: "needs tests",
      decidedBy: "bob",
      decidedAt: 3_010_000,
    }),
    run.taskId,
  );

  const history = services.decisions.history({ workspaceId: workspace.id });
  const shape = history.map((entry) => [
    entry.type,
    entry.decision,
    entry.actor,
  ]);
  assert.deepEqual(shape, [
    ["request", null, "claude-code"],
    ["decision", "request-change", "alice"],
    ["decision", "deny", "alice"],
    ["review", "rejected", "bob"],
  ]);
  assert.equal(history[1].note, "push to a branch instead");
  assert.ok(history.every((entry) => entry.at >= 0));
  assert.equal(
    services.decisions.history({ approvalId: approval.id }).length,
    3,
    "one approval's own thread",
  );
  assert.equal(
    services.decisions.history({ runId: "other-run" }).length,
    0,
    "another run's history stays separate",
  );
});

test("routes: handover build/save/history and decision history through the ctx contract", async (t) => {
  const { services, workspace, run } = setup(t);
  const call = async (method, path, input = null, search = "") => {
    let out;
    const ctx = {
      method,
      path,
      query: new URLSearchParams(search),
      send: (status, data) => (out = { status, data }),
      body: async () => input,
      services,
      hub: services.hub,
      db: services.db,
      bus: services.bus,
      actor: "local-user",
    };
    const handled = await collabRoutes(ctx);
    return { handled, ...out };
  };

  const preview = await call(
    "POST",
    `/api/workspaces/${workspace.id}/handover/preview`,
    { runId: run.id },
  );
  assert.equal(preview.status, 200);
  assert.match(preview.data.markdown, /Handover brief/);

  const created = await call(
    "POST",
    `/api/workspaces/${workspace.id}/handover`,
    { runId: run.id },
  );
  assert.equal(created.status, 201);
  const id = created.data.id;

  const saved = await call("PUT", `/api/handover/${id}`, {
    body: "# Edited by hand\n",
    editedBy: "alice",
  });
  assert.equal(saved.data.version, 2);
  assert.equal(saved.data.editedBy, "alice");
  assert.equal(saved.data.edited, true);

  assert.equal(
    (await call("GET", `/api/handover/${id}/history`)).data.length,
    2,
  );
  assert.equal((await call("GET", `/api/handover/${id}`)).data.version, 2);
  assert.equal(
    (await call("GET", `/api/workspaces/${workspace.id}/handover`)).data.length,
    1,
  );
  assert.equal(
    (await call("POST", `/api/handover/${id}/refresh`)).data.version,
    3,
  );

  services.approvals.request({
    runId: run.id,
    kind: "file",
    payload: { path: "C:\\work\\app.js" },
  });
  assert.equal(
    (await call("GET", `/api/runs/${run.id}/decisions`)).data.length,
    1,
  );
  assert.equal(
    (await call("GET", "/api/decisions", null, `workspace=${workspace.id}`))
      .data.length,
    1,
  );
  assert.equal(
    (await call("GET", "/api/workspaces/other/tasks")).handled,
    false,
  );
});
