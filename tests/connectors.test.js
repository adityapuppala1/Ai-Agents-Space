import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServices } from "../packages/core/src/services.js";
import {
  Connectors,
  createConnectors,
  CONNECTOR_IDS,
  AVAILABILITY,
  workspaceRoots,
} from "../packages/core/src/connectors/Connectors.js";
import connectorRoutes from "../packages/server/src/routes/connectors.js";

/** `which` stub: resolves only the names given, like PATH would. */
function fakeWhich(found = {}) {
  return async (name) => found[name] ?? null;
}

function call(services, method, path) {
  return new Promise((resolve, reject) => {
    const url = new URL(`http://localhost${path}`);
    const ctx = {
      method,
      path: url.pathname,
      url,
      query: url.searchParams,
      services,
      hub: services.hub,
      db: services.db,
      bus: services.bus,
      actor: "test",
      body: async () => undefined,
      send: (status, data) => resolve({ status, data }),
    };
    connectorRoutes(ctx)
      .then((handled) => {
        if (!handled) resolve({ status: 0, handled: false });
      })
      .catch(reject);
  });
}

test("connectors report git, filesystem and github with honest availability", async () => {
  const services = createServices({ demo: false, optional: false });
  const dir = mkdtempSync(join(tmpdir(), "connector-root-"));
  try {
    services.hub.create({ name: "Rooted", rootPath: dir });
    services.hub.create({ name: "Missing", rootPath: join(dir, "gone") });
    const connectors = new Connectors(services, {
      env: {},
      which: fakeWhich({}),
    });
    const list = await connectors.list();
    assert.deepEqual(
      list.map((c) => c.id),
      CONNECTOR_IDS,
    );
    for (const connector of list) {
      assert.ok(AVAILABILITY.includes(connector.availability));
      assert.ok(connector.detail.length > 0);
      // An unavailable connector must say how to fix it, and never claim writes.
      if (connector.availability !== "available") assert.ok(connector.fix);
      assert.deepEqual(connector.writes, []);
    }
    const filesystem = list.find((c) => c.id === "filesystem");
    assert.equal(filesystem.availability, "available");
    assert.deepEqual(filesystem.scope.length, 1);
    assert.equal(filesystem.missingRoots.length, 1);

    // No git and no gh on this fake PATH: both must say so, not go quiet.
    assert.equal(list.find((c) => c.id === "git").availability, "unavailable");
    const github = list.find((c) => c.id === "github");
    assert.equal(github.availability, "unavailable");
    assert.match(github.detail, /not on PATH/);
    assert.equal(github.version, null);
  } finally {
    await services.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a GitHub token variable is credited by presence and never read", async () => {
  const services = createServices({ demo: false, optional: false });
  try {
    const connectors = new Connectors(services, {
      env: { GITHUB_TOKEN: "ghp_secret_value" },
      which: fakeWhich({}),
    });
    const github = await connectors.get("github");
    // No gh binary, so it is still unavailable, but the token is acknowledged
    // without its value ever appearing in the payload.
    assert.equal(github.availability, "unavailable");
    assert.ok(!JSON.stringify(github).includes("ghp_secret_value"));
  } finally {
    await services.close();
  }
});

test("workspaceRoots survives a hub that cannot be listed", () => {
  assert.deepEqual(workspaceRoots({}), []);
  assert.deepEqual(
    workspaceRoots({
      hub: {
        list() {
          throw new Error("db closed");
        },
      },
    }),
    [],
  );
});

test("the route lists connectors, serves one, and 404s an unknown id", async () => {
  const services = createServices({ demo: false, optional: false });
  try {
    createConnectors(services, { env: {}, which: fakeWhich({}) });
    const all = await call(services, "GET", "/api/connectors");
    assert.equal(all.status, 200);
    assert.equal(all.data.count, 3);
    assert.deepEqual(
      all.data.connectors.map((c) => c.id),
      CONNECTOR_IDS,
    );

    const one = await call(services, "GET", "/api/connectors/git");
    assert.equal(one.status, 200);
    assert.equal(one.data.id, "git");

    await assert.rejects(
      () => call(services, "GET", "/api/connectors/slack"),
      /Unknown connector: slack/,
    );
  } finally {
    await services.close();
  }
});

test("a build without the module answers 503 instead of an empty list", async () => {
  const services = createServices({ demo: false, optional: false });
  try {
    services.connectors = undefined;
    await assert.rejects(
      () => call(services, "GET", "/api/connectors"),
      /not available in this container/,
    );
  } finally {
    await services.close();
  }
});
