import test from "node:test";
import assert from "node:assert/strict";
import { createServices } from "../packages/core/src/services.js";
import {
  createSavedViews,
  SavedViews,
  VIEW_SCOPES,
  MAX_STATE_BYTES,
} from "../packages/core/src/views/SavedViews.js";
import viewRoutes from "../packages/server/src/routes/views.js";

function setup(t) {
  const services = createServices({ demo: false });
  t.after(() => services.close?.());
  const workspace = services.hub.create({ name: "Views" });
  const views = createSavedViews(services);
  assert.equal(services.savedViews, views, "factory attaches the service");
  assert.ok(views instanceof SavedViews);
  return { services, workspace, views };
}

test("saved views: create, list by scope, get, update, remove, with audit", (t) => {
  const { services, workspace, views } = setup(t);
  const board = views.create({
    workspaceId: workspace.id,
    scope: "board",
    name: "My lanes",
    state: { groupBy: "provider", collapsed: ["DONE"] },
    actor: "local-user",
  });
  assert.equal(board.scope, "board");
  assert.equal(board.isDefault, false);
  assert.deepEqual(board.state, { groupBy: "provider", collapsed: ["DONE"] });
  const office = views.create({
    workspaceId: workspace.id,
    scope: "office",
    name: "Overhead",
    state: { camera: { x: 0, y: 12, z: 0 } },
  });
  views.create({
    workspaceId: workspace.id,
    scope: "filters",
    name: "Only Claude",
    state: { provider: ["claude-code"] },
  });
  assert.equal(views.list(workspace.id).length, 3);
  assert.deepEqual(
    views.list(workspace.id, { scope: "office" }).map((v) => v.id),
    [office.id],
  );
  assert.equal(views.get(board.id).name, "My lanes");

  const updated = views.update(board.id, {
    name: "Lanes v2",
    state: { groupBy: "role" },
  });
  assert.equal(updated.name, "Lanes v2");
  assert.deepEqual(updated.state, { groupBy: "role" });
  assert.ok(updated.updatedAt >= board.updatedAt);
  assert.equal(
    views.update(board.id, { isDefault: true }).isDefault,
    true,
    "update can flip default",
  );

  assert.deepEqual(views.remove(office.id), {
    id: office.id,
    removed: true,
    workspaceId: workspace.id,
  });
  assert.throws(() => views.get(office.id), /not found/i);
  assert.equal(views.list(workspace.id).length, 2);

  const actions = services.audit
    .list({ workspaceId: workspace.id })
    .map((row) => row.action);
  for (const action of ["view.create", "view.update", "view.delete"])
    assert.ok(actions.includes(action), `${action} audited`);

  // Another workspace sees nothing of this one.
  const other = services.hub.create({ name: "Other" });
  assert.equal(views.list(other.id).length, 0);
  assert.throws(() => views.list("nope"), /Workspace not found/);
  // The analytics table is untouched.
  assert.equal(
    services.db.prepare("SELECT COUNT(*) AS n FROM analytics_saved_views").get()
      .n,
    0,
  );
});

test("saved views: one default per workspace and scope", (t) => {
  const { workspace, views } = setup(t);
  const a = views.create({
    workspaceId: workspace.id,
    scope: "timeline",
    name: "A",
    isDefault: true,
  });
  const b = views.create({
    workspaceId: workspace.id,
    scope: "timeline",
    name: "B",
  });
  const depsDefault = views.create({
    workspaceId: workspace.id,
    scope: "deps",
    name: "Deps",
    isDefault: true,
  });
  assert.equal(views.get(a.id).isDefault, true);
  const promoted = views.setDefault(b.id);
  assert.equal(promoted.isDefault, true);
  assert.equal(views.get(a.id).isDefault, false, "previous default cleared");
  assert.equal(
    views.get(depsDefault.id).isDefault,
    true,
    "a different scope keeps its default",
  );
  assert.equal(views.list(workspace.id, { scope: "timeline" })[0].id, b.id);
  const c = views.create({
    workspaceId: workspace.id,
    scope: "timeline",
    name: "C",
    isDefault: true,
  });
  assert.equal(views.get(b.id).isDefault, false);
  assert.equal(views.get(c.id).isDefault, true);
});

test("saved views: validation of scope, name and the 8 KB state limit", (t) => {
  const { workspace, views } = setup(t);
  assert.deepEqual(VIEW_SCOPES, [
    "board",
    "office",
    "filters",
    "timeline",
    "deps",
  ]);
  assert.throws(
    () =>
      views.create({
        workspaceId: workspace.id,
        scope: "analytics",
        name: "x",
      }),
    /scope must be one of/,
  );
  assert.throws(
    () =>
      views.create({ workspaceId: workspace.id, scope: "board", name: "  " }),
    /1-80 characters/,
  );
  assert.throws(
    () =>
      views.create({
        workspaceId: workspace.id,
        scope: "board",
        name: "x".repeat(81),
      }),
    /1-80 characters/,
  );
  assert.throws(
    () =>
      views.create({
        workspaceId: workspace.id,
        scope: "board",
        name: "arr",
        state: [1, 2],
      }),
    /JSON object/,
  );
  const big = { blob: "y".repeat(MAX_STATE_BYTES) };
  assert.throws(
    () =>
      views.create({
        workspaceId: workspace.id,
        scope: "board",
        name: "big",
        state: big,
      }),
    (error) => error.status === 413 && /8192 bytes/.test(error.message),
  );
  const ok = views.create({
    workspaceId: workspace.id,
    scope: "board",
    name: "fits",
    state: { blob: "y".repeat(MAX_STATE_BYTES - 20) },
  });
  assert.throws(() => views.update(ok.id, { state: big }), /8192 bytes/);
  assert.throws(() => views.get("missing"), /not found/i);
  assert.throws(() => views.setDefault("missing"), /not found/i);
});

test("routes: workspace-scoped list/create and view-scoped patch/delete/default", async (t) => {
  const { services, workspace } = setup(t);
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
    const handled = await viewRoutes(ctx);
    return { handled, ...out };
  };
  const created = await call("POST", `/api/workspaces/${workspace.id}/views`, {
    scope: "filters",
    name: "Mine",
    state: { agent: ["a1"] },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.scope, "filters");
  const second = await call("POST", `/api/workspaces/${workspace.id}/views`, {
    scope: "board",
    name: "Board",
    isDefault: true,
  });
  assert.equal(second.data.isDefault, true);

  const all = await call("GET", `/api/workspaces/${workspace.id}/views`);
  assert.equal(all.data.views.length, 2);
  const filtered = await call(
    "GET",
    `/api/workspaces/${workspace.id}/views`,
    null,
    "scope=filters",
  );
  assert.deepEqual(
    filtered.data.views.map((v) => v.name),
    ["Mine"],
  );

  const patched = await call("PATCH", `/api/views/${created.data.id}`, {
    name: "Renamed",
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.name, "Renamed");
  const asDefault = await call("POST", `/api/views/${created.data.id}/default`);
  assert.equal(asDefault.data.isDefault, true);
  const fetched = await call("GET", `/api/views/${created.data.id}`);
  assert.equal(fetched.data.isDefault, true);
  const removed = await call("DELETE", `/api/views/${created.data.id}`);
  assert.equal(removed.data.removed, true);
  assert.equal(
    (await call("GET", `/api/workspaces/${workspace.id}/views`)).data.views
      .length,
    1,
  );
  const unrelated = await call("GET", "/api/workspaces/x/tasks");
  assert.equal(unrelated.handled, false, "leaves other paths alone");
  await assert.rejects(
    call("PUT", `/api/workspaces/${workspace.id}/views`),
    (error) => error.status === 405,
  );
  await assert.rejects(
    call("GET", `/api/views/${created.data.id}`),
    /not found/i,
  );
});
