import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { Workspace } from "../packages/core/src/Workspace.js";
import { createWorkspaceServer } from "../packages/server/src/server.js";

test("assignment is exclusive, completion frees agent, and failed creation is atomic", () => {
  const workspace = new Workspace();
  const task = workspace.create({ title: "Manual work", agentId: "nova" });
  assert.equal(task.assignedAgentId, "nova");
  assert.equal(
    workspace.snapshot().agents.find((a) => a.id === "nova").state,
    "CODING",
  );
  assert.throws(
    () => workspace.create({ title: "Conflict", agentId: "nova" }),
    /already working/,
  );
  assert.equal(workspace.snapshot().tasks.length, 1);
  assert.throws(() => workspace.assign(task.id, "missing"), /not found/);
  workspace.update(task.id, { status: "COMPLETED" });
  assert.equal(
    workspace.snapshot().agents.find((a) => a.id === "nova").state,
    "IDLE",
  );
  const queued = workspace.create({ title: "Next task" });
  workspace.assign(queued.id, "nova");
  assert.equal(
    workspace.snapshot().agents.find((a) => a.id === "nova").taskId,
    queued.id,
  );
});

test("demo advances only sample tasks and reset preserves manual work and assignment", () => {
  const workspace = new Workspace(undefined, { demo: true });
  const manual = workspace.create({ title: "Real task", agentId: "sage" });
  const demo = workspace
    .snapshot()
    .tasks.find((t) => t.source === "demo" && t.status === "IN_PROGRESS");
  workspace.tick();
  assert.equal(
    workspace.snapshot().tasks.find((t) => t.id === demo.id).progress,
    demo.progress + 1,
  );
  assert.equal(
    workspace.snapshot().tasks.find((t) => t.id === manual.id).progress,
    0,
  );
  workspace.setDemo(false);
  workspace.tick();
  assert.equal(
    workspace.snapshot().tasks.find((t) => t.id === demo.id).progress,
    demo.progress + 1,
  );
  workspace.loadDemo();
  assert.equal(
    workspace.snapshot().agents.find((a) => a.id === "sage").taskId,
    manual.id,
  );
  assert.equal(
    workspace.snapshot().tasks.filter((t) => t.assignedAgentId === "sage")
      .length,
    1,
  );
  assert.throws(() => workspace.setDemo("false"), /boolean/);
});

test("two WebSocket clients receive the same mutation and reconnect gets a full snapshot", async (t) => {
  const server = createWorkspaceServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const connect = async () => {
    const socket = new WebSocket(base.replace("http:", "ws:") + "/ws");
    const [message] = await once(socket, "message");
    return { socket, snapshot: JSON.parse(message).payload };
  };
  const first = await connect(),
    second = await connect();
  assert.equal(first.snapshot.tasks.length, 0);
  const event1 = once(first.socket, "message"),
    event2 = once(second.socket, "message");
  const response = await fetch(base + "/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Synced task", agentId: "nova" }),
  });
  assert.equal(response.status, 201);
  const task = await response.json();
  const [data1] = await event1,
    [data2] = await event2;
  assert.deepEqual(JSON.parse(data1), JSON.parse(data2));
  assert.equal(JSON.parse(data1).payload.tasks[0].id, task.id);
  first.socket.close();
  const reconnected = await connect();
  assert.equal(reconnected.snapshot.tasks[0].id, task.id);
  assert.equal((await fetch(base + "/api/workspace")).status, 200);
});
