import test from "node:test";
import assert from "node:assert/strict";
import { createServices } from "../packages/core/src/services.js";
import { createWorkspaceServer } from "../packages/server/src/server.js";

/**
 * A workspace's event history, a page at a time. The live snapshot carries
 * only the latest 60 events, so without this the Activity page could never
 * show anything older.
 */

async function listen(t) {
  const services = createServices({ demo: false });
  const server = createWorkspaceServer({ services, token: "" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await services.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const get = async (route) => {
    const response = await fetch(base + route);
    return { status: response.status, data: await response.json() };
  };
  return { services, get };
}

test("events page back through a workspace's whole history, newest first", async (t) => {
  const { services, get } = await listen(t);
  const workspace = services.hub.get(
    services.hub.create({ name: "History" }).id,
  );
  const other = services.hub.get(services.hub.create({ name: "Other" }).id);
  // Each task records one event; the other workspace's never mix in.
  for (let i = 0; i < 75; i++) workspace.create({ title: `Task ${i}` });
  other.create({ title: "Elsewhere" });
  const total = workspace.events({ limit: 1 }).total;
  assert.ok(total >= 75, `recorded ${total}`);

  // The snapshot stops at 60; its events now carry their sequence.
  const snapshot = workspace.snapshot();
  assert.equal(snapshot.events.length, 60);
  assert.equal(typeof snapshot.events[0].sequence, "number");

  const seen = [];
  let before = null;
  for (let page = 0; page < 10; page++) {
    const query = before ? `?before=${before}&limit=30` : "?limit=30";
    const { status, data } = await get(
      `/api/workspaces/${workspace.id}/events${query}`,
    );
    assert.equal(status, 200);
    assert.equal(data.total, total);
    // The newest sequence is read with the total, for an exact live count.
    assert.equal(data.newest, snapshot.events[0].sequence);
    seen.push(...data.events);
    if (!data.nextBefore) break;
    before = data.nextBefore;
  }
  // Every event once, in strictly descending order, none from elsewhere.
  assert.equal(seen.length, total);
  assert.equal(new Set(seen.map((event) => event.id)).size, total);
  for (let i = 1; i < seen.length; i++)
    assert.ok(seen[i - 1].sequence > seen[i].sequence);
  assert.ok(!seen.some((event) => /Elsewhere/.test(event.message ?? "")));
  // The first page is the snapshot's head.
  assert.equal(seen[0].id, snapshot.events[0].id);
  // Only the fields the live feed already shows: never the raw data column.
  assert.ok(seen.every((event) => !("data" in event)));

  // Limits are clamped; a cursor past the start is an empty last page.
  const clamped = await get(
    `/api/workspaces/${workspace.id}/events?limit=9999`,
  );
  assert.ok(clamped.data.events.length <= 500);
  const none = await get(`/api/workspaces/${workspace.id}/events?before=1`);
  assert.deepEqual(none.data.events, []);
  assert.equal(none.data.nextBefore, null);
  // An unknown workspace is not a silent empty list.
  const missing = await get("/api/workspaces/nope/events");
  assert.equal(missing.status, 404);
});
