import test from "node:test";
import assert from "node:assert/strict";
import { get } from "node:http";
import { TaskStore } from "../packages/core/src/TaskStore.js";
import { createWorkspaceServer } from "../packages/server/src/server.js";

test("tasks sort by priority and snapshots cannot mutate the store", () => {
  const store = new TaskStore();
  store.create({ title: "Low", priority: "low" });
  store.create({ title: "Urgent", priority: "critical" });
  const tasks = store.list();
  assert.equal(tasks[0].title, "Urgent");
  tasks[0].title = "Changed";
  assert.equal(store.list()[0].title, "Urgent");
});

test("task lifecycle rejects invalid transitions without partial changes", () => {
  const store = new TaskStore();
  const task = store.create({ title: "Implement office" });
  assert.throws(() => store.update(task.id, { status: "COMPLETED" }));
  store.update(task.id, { status: "IN_PROGRESS", progress: 20 });
  assert.throws(() =>
    store.update(task.id, { status: "BLOCKED", progress: -1 }),
  );
  assert.equal(store.list()[0].status, "IN_PROGRESS");
  store.update(task.id, { status: "BLOCKED" });
  store.update(task.id, { status: "IN_PROGRESS", progress: 80 });
  assert.throws(() => store.update(task.id, { progress: 40 }));
  const done = store.update(task.id, { status: "COMPLETED" });
  assert.equal(done.progress, 100);
  assert.ok(done.completedAt >= done.startedAt);
  assert.throws(() => store.update(task.id, { status: "IN_PROGRESS" }));
});

test("invalid creation inputs leave the store empty", () => {
  const store = new TaskStore();
  for (const input of [
    null,
    [],
    {},
    { title: " " },
    { title: "x", priority: "urgent" },
  ])
    assert.throws(() => store.create(input));
  assert.deepEqual(store.list(), []);
});

test("HTTP API creates, updates and lists tasks; validates input", async (t) => {
  const server = createWorkspaceServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method, data) =>
    fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  assert.equal((await fetch(base + "/api/health")).status, 200);
  const response = await request("/api/tasks", "POST", { title: "Test API" });
  assert.equal(response.status, 201);
  const task = await response.json();
  assert.equal(
    (
      await request(`/api/tasks/${task.id}`, "PATCH", {
        status: "IN_PROGRESS",
        progress: 35,
      })
    ).status,
    200,
  );
  assert.equal(
    (await (await fetch(base + "/api/tasks")).json())[0].progress,
    35,
  );
  assert.equal((await request("/api/tasks", "POST", {})).status, 400);
  assert.equal(
    (await request("/api/tasks/missing", "PATCH", { progress: 5 })).status,
    404,
  );
  assert.equal(
    (
      await fetch(base + "/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      })
    ).status,
    400,
  );
  assert.equal(
    (await request("/api/tasks", "POST", { title: "x".repeat(17000) })).status,
    413,
  );
  assert.equal(
    (
      await fetch(base + "/api/tasks", {
        headers: { Origin: "https://example.com" },
      })
    ).status,
    403,
  );
  const rejectedHostStatus = await new Promise((resolve, reject) => {
    const request = get(
      base + "/api/tasks",
      { headers: { Host: "unrelated.example" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on("error", reject);
  });
  assert.equal(rejectedHostStatus, 403);
});
