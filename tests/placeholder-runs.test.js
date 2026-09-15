import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../packages/core/src/db.js";
import { WorkspaceHub } from "../packages/core/src/WorkspaceHub.js";
import { cardProgress, runsByTask } from "../apps/web/src/hooks/viewLogic.js";

/**
 * Assigning an agent opens a "manual" run, so manual work shows as in progress
 * with the profile's working style — labelled as the profile's, not reported.
 *
 * On a task bound to a provider that placeholder tells a lie. A real managed
 * run owns that task's lifecycle, and until one starts nothing is executing.
 * Seen live on 2026-09-15 with three Claude Code tasks: every card read
 * "In progress · 0%", the workspace switcher said "3 running" while one run
 * executed, agents stood on the floor "coding", and stop-all listed the
 * placeholders as runs it could never cancel.
 *
 * A task is provider work when it names a provider, or when a managed or
 * observed run has executed it.
 */

function setup() {
  const hub = new WorkspaceHub(openDatabase(), { demo: false });
  const workspace = hub.get(
    hub.create({ name: "Provider work", rootPath: "C:\\work\\provider" }).id,
  );
  const agent = workspace.createAgent({
    name: "Forge",
    role: "Builder",
    provider: "claude-code",
  });
  const listed = () => hub.list().find((w) => w.id === workspace.id);
  let seq = 0;
  const insertRun = (task, { mode, status, endedAt = null }) => {
    seq += 1;
    const id = `run-${mode}-${seq}`;
    const now = Date.now();
    hub.db
      .prepare(
        `INSERT INTO runs (id, workspace_id, task_id, agent_id, agent_snapshot, provider, requested_model, status, started_at, ended_at, mode, title, last_event_at)
         VALUES (?, ?, ?, ?, '{}', ?, NULL, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        task.workspaceId ?? workspace.id,
        task.id,
        agent.id,
        mode === "manual" ? "manual" : "claude-code",
        status,
        now,
        endedAt,
        mode,
        task.title,
        now,
      );
    return id;
  };
  return { hub, workspace, agent, listed, insertRun };
}

const agentIn = (workspace, agent) =>
  workspace.snapshot().agents.find((a) => a.id === agent.id);

test("assigning an agent to a provider-bound task opens no run", () => {
  const { workspace, agent } = setup();
  const task = workspace.create({
    title: "Build slugify",
    agentId: agent.id,
    provider: "claude-code",
  });
  assert.equal(task.status, "IN_PROGRESS");
  assert.equal(workspace.activeRun(task.id), null);
  assert.deepEqual(
    workspace.snapshot().runs.filter((r) => r.taskId === task.id),
    [],
  );
  const shown = agentIn(workspace, agent);
  assert.equal(shown.taskId, task.id);
  // Assigned, not executing: nothing reports any activity, so none is shown.
  assert.equal(shown.state, "IDLE");
  assert.equal(shown.activityProvenance, "system");
  assert.equal(shown.runStatus, null);
});

test("assigning a provider-bound task later opens no run either", () => {
  const { workspace, agent } = setup();
  const queued = workspace.create({
    title: "Write tests",
    provider: "claude-code",
  });
  workspace.assign(queued.id, agent.id);
  assert.equal(workspace.activeRun(queued.id), null);
});

test("manual work still opens its placeholder, labelled as the profile's", () => {
  const { workspace, agent } = setup();
  const task = workspace.create({ title: "Manual work", agentId: agent.id });
  const run = workspace.activeRun(task.id);
  assert.equal(run.mode, "manual");
  assert.equal(run.status, "running");
  assert.equal(agentIn(workspace, agent).activityProvenance, "profile");
});

test("a provider-bound task counts as running only while a run executes", () => {
  const { hub, workspace, agent, listed, insertRun } = setup();
  const task = workspace.create({
    title: "Build slugify",
    agentId: agent.id,
    provider: "claude-code",
  });
  assert.equal(listed().activeRuns, 0, "assigned but not launched");
  const runId = insertRun(task, { mode: "managed", status: "running" });
  assert.equal(listed().activeRuns, 1, "a run is executing");
  hub.db
    .prepare("UPDATE runs SET status = 'completed', ended_at = ? WHERE id = ?")
    .run(Date.now(), runId);
  assert.equal(listed().activeRuns, 0, "finished, waiting for review");
});

test("manual work in progress still counts, as it always did", () => {
  const { workspace, agent, listed } = setup();
  workspace.create({ title: "Manual work", agentId: agent.id });
  assert.equal(listed().activeRuns, 1);
});

test("a task a managed run executed is provider work even without a provider field", () => {
  const { workspace, agent, listed, insertRun } = setup();
  // A task can be launched with an explicit provider it does not store.
  const task = workspace.create({ title: "Launched with a provider" });
  workspace.store.assign(task.id, agent.id);
  insertRun(task, {
    mode: "managed",
    status: "completed",
    endedAt: Date.now(),
  });
  assert.equal(listed().activeRuns, 0);
  assert.equal(agentIn(workspace, agent).state, "IDLE");
  assert.equal(agentIn(workspace, agent).activityProvenance, "system");
});

test("placeholders already left on provider work are closed once, with a record", () => {
  const { hub, workspace, agent, insertRun } = setup();
  // A placeholder written before this fix, on a provider-bound task.
  const bound = workspace.create({
    title: "Build slugify",
    provider: "claude-code",
  });
  workspace.store.assign(bound.id, agent.id);
  const stale = insertRun(bound, { mode: "manual", status: "running" });
  // Genuine manual work elsewhere keeps its placeholder.
  const other = hub.get(hub.create({ name: "Manual" }).id);
  const writer = other.createAgent({ name: "Nia", role: "Writer" });
  const manual = other.create({ title: "Manual work", agentId: writer.id });
  const kept = other.activeRun(manual.id).id;

  const closed = hub.closeProviderPlaceholders();
  assert.deepEqual(
    closed.map((entry) => entry.runId),
    [stale],
  );
  const row = hub.db
    .prepare("SELECT status, ended_at FROM runs WHERE id = ?")
    .get(stale);
  assert.equal(row.status, "cancelled");
  assert.ok(row.ended_at, "the placeholder has ended");
  assert.equal(
    hub.db.prepare("SELECT status FROM runs WHERE id = ?").get(kept).status,
    "running",
    "manual work was left alone",
  );
  const record = hub.db
    .prepare("SELECT message, provenance FROM events WHERE run_id = ?")
    .all(stale);
  assert.ok(
    record.some(
      (e) => /placeholder/i.test(e.message) && e.provenance === "system",
    ),
    JSON.stringify(record),
  );
  assert.deepEqual(
    hub.closeProviderPlaceholders(),
    [],
    "running it again changes nothing",
  );
  assert.equal(agentIn(workspace, agent).state, "IDLE");
});

test("a provider task with no run says it has not launched, never 0%", () => {
  const bound = { status: "IN_PROGRESS", progress: 0, provider: "claude-code" };
  assert.equal(cardProgress(bound, null), "Not launched");
  // A placeholder left over from before does not make it look started.
  assert.equal(
    cardProgress(bound, { mode: "manual", status: "running" }),
    "Not launched",
  );
  // Manual work keeps its percentage.
  assert.equal(
    cardProgress({ status: "IN_PROGRESS", progress: 30 }, null),
    "30%",
  );
});

test("a task that did run reports its real run, not a left-over placeholder", () => {
  const task = {
    id: "t1",
    status: "IN_PROGRESS",
    progress: 0,
    provider: "claude-code",
  };
  // Newest first, as the snapshot sends them. An older server left the
  // placeholder open after the managed run had finished.
  const runs = [
    {
      id: "managed",
      taskId: "t1",
      mode: "managed",
      status: "completed",
      startedAt: "2026-09-15T05:28:25.000Z",
      endedAt: "2026-09-15T05:29:13.000Z",
    },
    {
      id: "placeholder",
      taskId: "t1",
      mode: "manual",
      status: "running",
      startedAt: "2026-09-15T04:14:15.000Z",
      endedAt: null,
    },
  ];
  const run = runsByTask(runs).get("t1");
  assert.equal(run.id, "managed");
  assert.equal(cardProgress(task, run), "Completed 48s");
});

test("among runs of the same kind, the live one still wins", () => {
  const retried = [
    { id: "retry", taskId: "t1", mode: "managed", status: "running" },
    {
      id: "first",
      taskId: "t1",
      mode: "managed",
      status: "failed",
      endedAt: "2026-09-15T05:00:00.000Z",
    },
  ];
  assert.equal(runsByTask(retried).get("t1").id, "retry");
  const reordered = [
    {
      id: "ended",
      taskId: "t1",
      mode: "managed",
      status: "completed",
      endedAt: "2026-09-15T05:00:00.000Z",
    },
    { id: "live", taskId: "t1", mode: "observed", status: "running" },
  ];
  assert.equal(runsByTask(reordered).get("t1").id, "live");
  // Manual work on its own keeps the behaviour it always had.
  const manual = [{ id: "m", taskId: "t2", mode: "manual", status: "running" }];
  assert.equal(runsByTask(manual).get("t2").id, "m");
});
