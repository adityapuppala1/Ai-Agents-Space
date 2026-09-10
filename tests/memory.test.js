import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServices } from "../packages/core/src/services.js";
import { Settings } from "../packages/core/src/settings/Settings.js";
import {
  MemoryService,
  SHARE_USER_SCOPE_KEY,
} from "../packages/core/src/context/memory.js";
import { rank, WEIGHTS } from "../packages/core/src/context/relevance.js";
import contextRoutes from "../packages/server/src/routes/context.js";

function tempDir(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `agent-space-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup(t, { rootPath = null } = {}) {
  let clock = 2_000_000;
  const services = createServices({ demo: false });
  t.after(() => services.close());
  services.settings ??= new Settings(services.db);
  const memory = new MemoryService(services, { now: () => clock });
  services.memory = memory;
  const a = services.hub.create({ name: "Alpha", rootPath });
  const b = services.hub.create({ name: "Beta" });
  return {
    services,
    memory,
    alpha: a,
    beta: b,
    advance: (ms) => (clock += ms),
    now: () => clock,
  };
}

test("workspace memory never leaks to another workspace and user scope is opt-out", (t) => {
  const { services, memory, alpha, beta } = setup(t);
  memory.set({
    scope: "workspace",
    scopeId: alpha.id,
    key: "conventions",
    value: "Small diffs, tests first",
  });
  memory.set({
    scope: "workspace",
    scopeId: beta.id,
    key: "conventions",
    value: "Beta house style",
  });
  memory.set({ scope: "user", key: "tone", value: "Terse replies" });

  assert.equal(
    memory.get("workspace", alpha.id, "conventions").value,
    "Small diffs, tests first",
  );
  assert.equal(
    memory.list({ scope: "workspace", scopeId: alpha.id }).length,
    1,
  );
  assert.equal(
    memory.list({ scope: "workspace", scopeId: beta.id })[0].value,
    "Beta house style",
  );
  assert.equal(memory.get("workspace", beta.id, "tone"), null);

  const shared = memory.forRun({ workspaceId: alpha.id });
  assert.deepEqual(
    shared.workspace.map((m) => m.value),
    ["Small diffs, tests first"],
  );
  assert.equal(shared.user.length, 1);
  assert.equal(shared.userScopeShared, true);

  services.settings.set(SHARE_USER_SCOPE_KEY, false);
  const isolated = memory.forRun({ workspaceId: alpha.id });
  assert.equal(isolated.user.length, 0);
  assert.equal(isolated.userScopeShared, false);
  assert.equal(isolated.workspace.length, 1, "workspace scope is unaffected");

  // Scope validation.
  assert.throws(
    () => memory.set({ scope: "workspace", key: "x" }),
    /workspaceId/,
  );
  assert.throws(() => memory.set({ scope: "team", key: "x" }), /scope must be/);
  assert.throws(() => memory.set({ scope: "user" }), /key is required/);
});

test("run notes expire when the run ends, and forgetting hard-deletes", (t) => {
  const { memory, alpha, advance, now, services } = setup(t);
  memory.set({ scope: "run", scopeId: "run-1", key: "note", value: "retry 2" });
  memory.set({
    scope: "run",
    scopeId: "run-1",
    key: "ttl",
    value: "short",
    expiresAt: now() + 1000,
  });
  memory.set({ scope: "run", scopeId: "run-2", key: "note", value: "other" });
  assert.equal(memory.list({ scope: "run", scopeId: "run-1" }).length, 2);

  advance(5000);
  assert.equal(
    memory.list({ scope: "run", scopeId: "run-1" }).length,
    1,
    "expired notes are not offered",
  );
  assert.equal(memory.get("run", "run-1", "ttl"), null);
  assert.equal(memory.purgeExpired(), 1);

  assert.equal(memory.endRun("run-1"), 1, "ending the run drops its notes");
  assert.equal(memory.list({ scope: "run", scopeId: "run-1" }).length, 0);
  assert.equal(
    memory.list({ scope: "run", scopeId: "run-2" }).length,
    1,
    "another run keeps its notes",
  );

  memory.set({ scope: "workspace", scopeId: alpha.id, key: "a", value: "1" });
  memory.set({ scope: "workspace", scopeId: alpha.id, key: "b", value: "2" });
  assert.equal(memory.forget("workspace", alpha.id, "a"), 1);
  assert.equal(memory.forget("workspace", alpha.id, "a"), 0);
  assert.equal(memory.forgetAll("workspace", alpha.id), 1);
  assert.equal(
    services.db.prepare("SELECT COUNT(*) AS n FROM memories").get().n,
    1,
    "forgetting deletes rows rather than flagging them",
  );
});

test("knowledge collections version, attribute, refresh, and forget", (t) => {
  const root = tempDir(t, "knowledge");
  writeFileSync(join(root, "spec.md"), "v1 spec\n");
  const { memory, alpha, beta } = setup(t, { rootPath: root });

  const collection = memory.createCollection({
    workspaceId: alpha.id,
    name: "Product decisions",
    description: "Decisions we keep",
  });
  assert.equal(collection.version, 1);
  assert.equal(collection.access, "workspace");
  assert.throws(
    () =>
      memory.createCollection({
        workspaceId: alpha.id,
        name: "Product decisions",
      }),
    (e) => e.status === 409,
  );

  const item = memory.addItem(collection.id, {
    title: "Spec v1",
    source: join(root, "spec.md"),
    sourceUrl: "https://example.invalid/spec",
    content: "v1 spec\n",
  });
  assert.equal(item.version, 1);
  assert.ok(item.capturedAt > 0, "captured_at is stamped");
  assert.equal(item.source, join(root, "spec.md"));
  assert.equal(memory.getCollection(collection.id).version, 2, "writes bump");

  // Secrets can never be captured as a source.
  assert.throws(
    () =>
      memory.addItem(collection.id, {
        title: "Creds",
        source: join(root, ".env"),
      }),
    /secret/i,
  );

  let fresh = memory.refreshCheck(collection.id);
  assert.equal(fresh.stale, 0);
  assert.equal(fresh.items[0].state, "fresh");
  assert.ok(memory.getItem(item.id).freshnessCheckedAt > 0);

  writeFileSync(join(root, "spec.md"), "v2 spec, rewritten\n");
  fresh = memory.refreshCheck(collection.id);
  assert.equal(fresh.stale, 1);
  assert.equal(fresh.items[0].state, "changed");
  assert.match(fresh.items[0].detail, /changed since capture/);

  const updated = memory.updateItem(item.id, {
    content: "v2 spec, rewritten\n",
  });
  assert.equal(updated.version, 2);
  assert.equal(memory.refreshCheck(collection.id).stale, 0);

  // Cross-workspace reads are refused, not filtered later.
  assert.throws(
    () => memory.getCollection(collection.id, { workspaceId: beta.id }),
    (e) => e.status === 404,
  );
  assert.equal(memory.listCollections(beta.id).length, 0);

  // Forgetting: soft delete stops offering it, purge removes the content.
  assert.ok(memory.deleteItem(item.id).deletedAt > 0);
  assert.equal(memory.getCollection(collection.id).items.length, 0);
  assert.equal(memory.itemsForContext(alpha.id, [collection.id]).length, 0);
  assert.equal(memory.purgeItem(item.id).removed, 1);
  assert.throws(
    () => memory.getItem(item.id),
    (e) => e.status === 404,
  );
});

test("private collections stay out of context unless named by id", (t) => {
  const { memory, alpha } = setup(t);
  const open = memory.createCollection({
    workspaceId: alpha.id,
    name: "Shared notes",
  });
  const secret = memory.createCollection({
    workspaceId: alpha.id,
    name: "Private notes",
    access: "private",
  });
  memory.addItem(open.id, { title: "Open", content: "abc" });
  memory.addItem(secret.id, { title: "Private", content: "xyz" });
  const auto = memory.itemsForContext(alpha.id, []);
  assert.deepEqual(
    auto.map((i) => i.title),
    ["Open"],
  );
  const named = memory.itemsForContext(alpha.id, [secret.id]);
  assert.deepEqual(
    named.map((i) => i.title),
    ["Private"],
  );
  assert.ok(auto.every((i) => i.capturedAt > 0 && "source" in i));
});

test("relevance ranking is deterministic and explains every item", () => {
  const now = 1_700_000_000_000;
  const candidates = [
    { path: "C:\\work\\src\\auth\\login.js", bytes: 1200, mtimeMs: now - 1000 },
    { path: "C:\\work\\src\\auth\\logout.js", bytes: 900, mtimeMs: now - 1000 },
    { path: "C:\\work\\docs\\readme.md", bytes: 400, mtimeMs: now - 5e8 },
    { path: "C:\\work\\src\\billing\\invoice.js", bytes: 800, mtimeMs: now },
  ];
  const task = {
    title: "Fix the login redirect",
    deliverable: "login patch",
    target: { folder: "C:\\work\\src\\auth" },
  };
  const first = rank({ candidates, task, now, diffFiles: [] });
  const second = rank({
    candidates: [...candidates].reverse(),
    task,
    now,
    diffFiles: [],
  });
  assert.deepEqual(
    first.items.map((i) => [i.path, i.score]),
    second.items.map((i) => [i.path, i.score]),
    "ranking does not depend on candidate order",
  );
  assert.match(first.items[0].path, /login\.js$/);
  assert.ok(first.items.every((item) => item.why.length > 0));
  assert.equal(first.deterministic, true);
  assert.equal(first.estimateLabel, "estimate");
  assert.equal(first.weights.proximity, WEIGHTS.proximity);
  assert.match(first.items[0].why, /task target folder/);
  const readme = first.items.find((i) => i.path.endsWith("readme.md"));
  assert.ok(readme.score < first.items[0].score);
  assert.match(readme.why, /folder level|outside the task target folder/);
  assert.equal(readme.breakdown.proximity.score < 0.7, true);

  // The git diff lifts a file that the title does not mention.
  const withDiff = rank({
    candidates,
    task,
    now,
    diffFiles: ["C:\\work\\src\\billing\\invoice.js"],
  });
  const invoice = withDiff.items.find((i) => i.path.endsWith("invoice.js"));
  assert.equal(invoice.breakdown.diff.score, 1);
  assert.match(invoice.why, /changed in this run's diff/);
  assert.ok(
    invoice.score >
      first.items.find((i) => i.path.endsWith("invoice.js")).score,
  );
});

test("relevance controls: include, exclude, and labelled budgets", () => {
  const now = 1_700_000_000_000;
  const candidates = [
    { path: "C:\\work\\src\\a.js", bytes: 1000, mtimeMs: now },
    { path: "C:\\work\\src\\b.js", bytes: 1000, mtimeMs: now },
    { path: "C:\\work\\src\\c.js", bytes: 1000, mtimeMs: now },
  ];
  const budgeted = rank({ candidates, now, maxItems: 2, maxBytes: 100_000 });
  assert.equal(budgeted.included.length, 2);
  assert.equal(budgeted.excluded.length, 1);
  assert.match(budgeted.excluded[0].reason, /budget: more than maxItems/);
  assert.match(budgeted.excluded[0].why, /^Left out:/);
  assert.equal(budgeted.budgets.usedItems, 2);

  const bytes = rank({ candidates, now, maxBytes: 1500 });
  assert.equal(bytes.included.length, 1);
  assert.match(bytes.excluded[0].reason, /maxBytes/);

  const controlled = rank({
    candidates,
    now,
    include: ["C:\\work\\src\\c.js"],
    exclude: ["C:\\work\\src\\a.js"],
    maxItems: 1,
  });
  assert.equal(controlled.items[0].path, "C:\\work\\src\\c.js");
  assert.equal(controlled.items[0].included, true);
  assert.equal(controlled.items[0].reason, "included by request");
  const banned = controlled.items.find((i) => i.path.endsWith("a.js"));
  assert.equal(banned.included, false);
  assert.equal(banned.reason, "excluded by request");
  assert.equal(controlled.estimateLabel, "estimate");
});

test("routes: memory, knowledge and rank through the ctx contract", async (t) => {
  const root = tempDir(t, "routes");
  writeFileSync(join(root, "app.js"), "console.log(1)\n");
  const { services, alpha, beta } = setup(t, { rootPath: root });
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
    const handled = await contextRoutes(ctx);
    return { handled, ...out };
  };

  const created = await call("POST", `/api/workspaces/${alpha.id}/memory`, {
    key: "style",
    value: "Windows paths",
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.scope, "workspace");
  assert.equal(
    (await call("GET", `/api/workspaces/${alpha.id}/memory`)).data.entries
      .length,
    1,
  );
  assert.equal(
    (await call("GET", `/api/workspaces/${beta.id}/memory`)).data.entries
      .length,
    0,
    "another workspace sees nothing",
  );
  await call("POST", "/api/memory/user", { key: "tone", value: "terse" });
  assert.equal((await call("GET", "/api/memory/user")).data.entries.length, 1);
  const deleted = await call(
    "DELETE",
    `/api/workspaces/${alpha.id}/memory`,
    null,
    "key=style",
  );
  assert.equal(deleted.data.removed, 1);
  assert.equal(deleted.data.hardDelete, true);

  const collection = await call(
    "POST",
    `/api/workspaces/${alpha.id}/knowledge`,
    { name: "Runbook" },
  );
  assert.equal(collection.status, 201);
  const cid = collection.data.id;
  const item = await call(
    "POST",
    `/api/workspaces/${alpha.id}/knowledge/${cid}/items`,
    {
      title: "Boot",
      source: join(root, "app.js"),
      content: "console.log(1)\n",
    },
  );
  assert.equal(item.status, 201);
  assert.equal(
    (await call("POST", `/api/workspaces/${alpha.id}/knowledge/${cid}/refresh`))
      .data.stale,
    0,
  );
  assert.equal(
    (await call("GET", `/api/workspaces/${alpha.id}/knowledge`)).data[0]
      .itemCount,
    1,
  );
  const purged = await call(
    "DELETE",
    `/api/workspaces/${alpha.id}/knowledge/${cid}/items/${item.data.id}`,
    null,
    "purge=1",
  );
  assert.equal(purged.data.removed, 1);

  const ranked = await call(
    "POST",
    `/api/workspaces/${alpha.id}/context/rank`,
    {
      candidates: [{ path: join(root, "app.js"), bytes: 20 }],
      maxItems: 5,
    },
  );
  assert.equal(ranked.status, 200);
  assert.equal(ranked.data.deterministic, true);
  assert.equal(ranked.data.items.length, 1);
  assert.ok(ranked.data.items[0].why);

  assert.equal((await call("GET", "/api/workspaces/x")).handled, false);
});
