import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, schemaVersion } from "../packages/core/src/db.js";
import { WorkspaceHub } from "../packages/core/src/WorkspaceHub.js";
import { Workspace } from "../packages/core/src/Workspace.js";
import { TaskStore } from "../packages/core/src/TaskStore.js";
import { createWorkspaceServer } from "../packages/server/src/server.js";

function tempDb(t) {
  const dir = mkdtempSync(join(tmpdir(), "agent-space-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "workspace.sqlite");
}

test("renamed agents, workspaces, and tasks survive a restart", (t) => {
  const path = tempDb(t);
  let db = openDatabase(path);
  // Wave 2 appended migrations 3-6; the contract is "at least v2", not "exactly v2".
  assert.ok(schemaVersion(db) >= 2);
  let hub = new WorkspaceHub(db, { demo: true });
  const project = hub.create({ name: "Storefront", rootPath: "C:/work/store" });
  const runtime = hub.get(project.id);
  const nova = runtime.snapshot().agents.find((a) => a.name === "Nova");
  runtime.updateAgent(nova.id, { name: "Nova Prime", color: "#112233" });
  const task = runtime.create({ title: "Persist me", agentId: nova.id });
  db.close();

  db = openDatabase(path);
  hub = new WorkspaceHub(db, { demo: false });
  const reopened = hub.get(project.id);
  assert.equal(reopened.record.name, "Storefront");
  assert.equal(reopened.record.rootPath, "C:/work/store");
  const agent = reopened.snapshot().agents.find((a) => a.id === nova.id);
  assert.equal(agent.name, "Nova Prime");
  assert.equal(agent.color, "#112233");
  assert.equal(agent.taskId, task.id);
  assert.equal(reopened.snapshot().tasks[0].title, "Persist me");
  assert.ok(
    reopened.snapshot().events.some((e) => /Renamed Nova/.test(e.message)),
  );
  // Demo tasks were loaded in the first session and are still present.
  assert.ok(
    hub
      .get("demo")
      .snapshot()
      .tasks.some((task) => task.source === "demo"),
  );
  db.close();
});

test("workspaces never mix tasks, agents, or activity", () => {
  const hub = new WorkspaceHub(openDatabase(), { demo: true });
  const alpha = hub.get(hub.create({ name: "Alpha" }).id);
  const beta = hub.get(hub.create({ name: "Beta" }).id);
  assert.notEqual(alpha.id, beta.id);
  const alphaNova = alpha.snapshot().agents.find((a) => a.name === "Nova");
  const betaNova = beta.snapshot().agents.find((a) => a.name === "Nova");
  assert.notEqual(alphaNova.id, betaNova.id);
  alpha.create({ title: "Alpha only", agentId: alphaNova.id });
  assert.equal(beta.snapshot().tasks.length, 0);
  assert.equal(
    beta.snapshot().agents.find((a) => a.id === betaNova.id).state,
    "IDLE",
  );
  assert.throws(
    () => beta.create({ title: "Wrong roster", agentId: alphaNova.id }),
    /not found/,
  );
  assert.throws(
    () => beta.update(alpha.snapshot().tasks[0].id, { progress: 5 }),
    /not found/,
  );
  assert.equal(
    hub
      .get("demo")
      .snapshot()
      .tasks.filter((t) => t.source === "demo").length,
    7,
  );
  assert.equal(
    alpha.snapshot().tasks.filter((t) => t.source === "demo").length,
    0,
  );
  assert.ok(!beta.snapshot().events.some((e) => /Alpha only/.test(e.message)));
  const listed = hub.list();
  assert.deepEqual(
    listed.map((w) => w.kind),
    ["project", "project", "demo"],
  );
  assert.equal(listed.find((w) => w.id === alpha.id).activeRuns, 1);
});

test("demo simulation is confined to the demo workspace", () => {
  const hub = new WorkspaceHub(openDatabase(), { demo: false });
  const project = hub.get(hub.create({ name: "Real work" }).id);
  assert.throws(() => project.setDemo(true), /demo workspace/);
  assert.throws(() => project.loadDemo(), /demo workspace/);
  assert.throws(() => hub.archive("demo"), /cannot be archived/);
  const demo = hub.get("demo");
  demo.loadDemo();
  const before = demo.snapshot().tasks.find((t) => t.status === "IN_PROGRESS");
  hub.tick();
  assert.equal(
    demo.snapshot().tasks.find((t) => t.id === before.id).progress,
    before.progress + 1,
  );
  assert.equal(project.snapshot().tasks.length, 0);
});

test("runs keep a profile snapshot that later edits do not rewrite", () => {
  const workspace = new Workspace();
  const task = workspace.create({ title: "Snapshot check", agentId: "nova" });
  const run = workspace.activeRun(task.id);
  assert.equal(run.agentSnapshot.name, "Nova");
  assert.equal(run.provider, "manual");
  assert.equal(run.status, "running");
  workspace.updateAgent("nova", {
    name: "Nova Prime",
    role: "Design engineer",
  });
  assert.equal(workspace.activeRun(task.id).agentSnapshot.name, "Nova");
  assert.equal(
    workspace.snapshot().agents.find((a) => a.id === "nova").name,
    "Nova Prime",
  );
  workspace.update(task.id, { status: "BLOCKED" });
  assert.equal(workspace.activeRun(task.id).status, "blocked");
  workspace.update(task.id, { status: "IN_PROGRESS" });
  workspace.update(task.id, { status: "COMPLETED" });
  assert.equal(workspace.activeRun(task.id), null);
  const finished = workspace.runs().find((r) => r.id === run.id);
  assert.equal(finished.status, "completed");
  assert.ok(finished.endedAt >= finished.startedAt);
  assert.equal(workspace.snapshot().events[0].runId, run.id);
});

test("agent profiles can be created, edited, duplicated, archived, and restored", () => {
  const workspace = new Workspace();
  const created = workspace.createAgent({
    name: "Quill Writer",
    role: "Docs",
    color: "#AABBCC",
    provider: "codex",
    runtime: "local-cli",
    model: "gpt-workhorse",
    skills: ["Documentation", "Accessibility", "Documentation"],
    avatar: {
      outfit: "jacket",
      accessory: "glasses",
      hairColor: "#554433",
      pronouns: "they/them",
    },
  });
  assert.equal(created.initials, "QW");
  assert.equal(created.color, "#aabbcc");
  assert.deepEqual(created.skills, ["Documentation", "Accessibility"]);
  assert.deepEqual(JSON.parse(created.avatar), {
    outfit: "jacket",
    accessory: "glasses",
    hairColor: "#554433",
    pronouns: "they/them",
  });
  assert.equal(created.provider, "codex");
  assert.equal(created.model, "gpt-workhorse");
  assert.throws(() => workspace.createAgent({ role: "No name" }), /Name/);
  assert.throws(
    () => workspace.updateAgent(created.id, { color: "blue" }),
    /hex/,
  );
  assert.throws(() => workspace.updateAgent(created.id, {}), /at least one/);
  const copy = workspace.duplicateAgent(created.id);
  assert.equal(copy.name, "Quill Writer copy");
  assert.notEqual(copy.id, created.id);
  assert.deepEqual(copy.skills, created.skills);
  assert.deepEqual(JSON.parse(copy.avatar), JSON.parse(created.avatar));
  assert.throws(
    () => workspace.updateAgent(created.id, { skills: "not an array" }),
    /Skills must be an array/,
  );
  assert.throws(
    () => workspace.updateAgent(created.id, { avatar: { outfit: "spacesuit" } }),
    /outfit must be one of/,
  );
  const task = workspace.create({ title: "Busy", agentId: copy.id });
  assert.throws(() => workspace.archiveAgent(copy.id), /active work/);
  workspace.update(task.id, { status: "COMPLETED" });
  workspace.archiveAgent(copy.id);
  assert.ok(!workspace.snapshot().agents.some((a) => a.id === copy.id));
  assert.ok(
    workspace.profiles
      .list({ includeArchived: true })
      .some((a) => a.id === copy.id),
  );
  assert.throws(() => workspace.updateAgent(copy.id, { name: "x" }), /Restore/);
  assert.throws(
    () => workspace.create({ title: "Nope", agentId: copy.id }),
    /not found/,
  );
  workspace.restoreAgent(copy.id);
  assert.ok(workspace.snapshot().agents.some((a) => a.id === copy.id));
  // Store-level access stays scoped to the workspace that owns it.
  const other = new TaskStore(workspace.db, "local");
  assert.equal(other.list().length, 1);
});

test("HTTP API exposes workspaces and agents with isolation across sockets", async (t) => {
  const server = createWorkspaceServer({ demo: true });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = (path, method = "GET", data) =>
    fetch(base + path, {
      method,
      headers: data ? { "Content-Type": "application/json" } : {},
      body: data ? JSON.stringify(data) : undefined,
    }).then(async (r) => [r.status, await r.json()]);

  let [status, workspaces] = await json("/api/workspaces");
  assert.equal(status, 200);
  assert.deepEqual(
    workspaces.map((w) => w.id),
    ["demo"],
  );
  [status] = await json("/api/workspaces", "POST", { name: " " });
  assert.equal(status, 400);
  let project;
  [status, project] = await json("/api/workspaces", "POST", {
    name: "Client site",
  });
  assert.equal(status, 201);
  assert.equal(project.kind, "project");
  [status] = await json(`/api/workspaces/${project.id}`, "PATCH", {
    name: "Client site v2",
  });
  assert.equal(status, 200);
  [, workspaces] = await json("/api/workspaces");
  assert.equal(workspaces[0].name, "Client site v2");

  let [, agents] = await json(`/api/workspaces/${project.id}/agents`);
  assert.equal(agents.length, 6);
  const nova = agents.find((a) => a.name === "Nova");
  [status] = await json(
    `/api/workspaces/${project.id}/agents/${nova.id}`,
    "PATCH",
    { name: "Nova Prime" },
  );
  assert.equal(status, 200);
  [status] = await json(`/api/workspaces/${project.id}/agents`, "POST", {
    name: "Scout",
    role: "Researcher",
  });
  assert.equal(status, 201);
  [status] = await json(
    `/api/workspaces/${project.id}/agents/${nova.id}/archive`,
    "POST",
    {},
  );
  assert.equal(status, 200);
  [, agents] = await json(`/api/workspaces/${project.id}/agents`);
  assert.equal(agents.length, 6);
  assert.ok(!agents.some((a) => a.id === nova.id));
  [, agents] = await json(`/api/workspaces/${project.id}/agents?archived=1`);
  assert.equal(agents.length, 7);
  [status] = await json(
    `/api/workspaces/${project.id}/agents/${nova.id}/restore`,
    "POST",
    {},
  );
  assert.equal(status, 200);
  [status] = await json(`/api/workspaces/${project.id}/demo`, "POST", {
    running: true,
  });
  assert.equal(status, 409);
  [status] = await json(`/api/workspaces/${project.id}/tasks`, "POST", {
    title: "Scoped",
    agentId: nova.id,
  });
  assert.equal(status, 201);
  let [, snapshot] = await json(`/api/workspaces/${project.id}/workspace`);
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.runs.length, 1);
  assert.equal(snapshot.runs[0].agentSnapshot.name, "Nova Prime");
  assert.equal(snapshot.workspaces.length, 2);
  [, snapshot] = await json("/api/workspace");
  assert.ok(snapshot.tasks.every((task) => task.source === "demo"));
  [status] = await json("/api/workspaces/missing/tasks");
  assert.equal(status, 404);
  [status] = await json(`/api/workspaces/${project.id}/archive`, "POST", {});
  assert.equal(status, 200);
  [, workspaces] = await json("/api/workspaces");
  assert.deepEqual(
    workspaces.map((w) => w.id),
    ["demo"],
  );
  [, workspaces] = await json("/api/workspaces?archived=1");
  assert.equal(workspaces.length, 2);
  const [health, info] = await json("/api/health");
  assert.equal(health, 200);
  assert.ok(info.schemaVersion >= 2);
});
