import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServices } from "../packages/core/src/services.js";
import {
  validateManifest,
  diffPermissions,
  satisfiesRange,
  compareSemver,
  parseSemver,
  checksumOf,
  EXTENSION_KINDS,
  MANIFEST_VERSION,
} from "../packages/core/src/extensions/manifest.js";
import {
  createExtensionRegistry,
  workspaceCeiling,
  permissionsExceeding,
  stripTemplate,
  SIGNATURE_MEANING,
} from "../packages/core/src/extensions/registry.js";
import {
  getTemplate,
  validateTemplate,
  CONNECTOR_VOCABULARY,
} from "../packages/core/src/workflows/templates/index.js";

function manifest(overrides = {}) {
  return {
    id: "acme-connector",
    name: "Acme tool connector",
    kind: "tool-connector",
    version: "1.2.0",
    publisher: {
      name: "Acme Ltd",
      contact: "dev@acme.example",
      url: "https://acme.example",
    },
    license: "MIT",
    compatibility: {
      agentSpace: ">=0.2.0 <1.0.0",
      os: ["win32", "linux", "darwin"],
    },
    capabilities: ["issues.read"],
    permissions: {
      filesystem: "read",
      network: [],
      shell: false,
      providers: [],
    },
    configurationSchema: {
      type: "object",
      properties: { baseUrl: { type: "string" } },
    },
    updateChannel: "stable",
    checksum: checksumOf("package-bytes"),
    ...overrides,
  };
}

function setup({ extensionSettings = null } = {}) {
  const services = createServices({ demo: false });
  const audits = [];
  services.audit = { record: (entry) => audits.push(entry) };
  const workspace = services.hub.create({
    name: "Ext",
    rootPath: "C:/work/ext",
  });
  if (extensionSettings)
    services.db
      .prepare("UPDATE workspaces SET settings = ? WHERE id = ?")
      .run(JSON.stringify({ extensions: extensionSettings }), workspace.id);
  const registry = createExtensionRegistry(services);
  return { services, registry, workspaceId: workspace.id, audits };
}

test("manifest validation covers kinds, permissions, publisher, and checksum shape", () => {
  const checked = validateManifest(manifest());
  assert.equal(checked.manifestVersion, MANIFEST_VERSION);
  assert.equal(checked.kind, "tool-connector");
  assert.equal(
    checked.executable,
    EXTENSION_KINDS["tool-connector"].executable,
  );
  assert.deepEqual(checked.permissions, {
    filesystem: "read",
    network: [],
    shell: false,
    providers: [],
  });
  assert.equal(checked.publisher.name, "Acme Ltd");

  assert.throws(
    () => validateManifest(manifest({ kind: "malware" })),
    /kind must be one of/,
  );
  assert.throws(
    () => validateManifest(manifest({ version: "1.2" })),
    /semantic version/,
  );
  assert.throws(
    () => validateManifest(manifest({ publisher: {} })),
    /publisher.name is required/,
  );
  assert.throws(
    () => validateManifest(manifest({ license: "" })),
    /license is required/,
  );
  assert.throws(
    () => validateManifest(manifest({ checksum: "sha256:nope" })),
    /checksum/,
  );
  assert.throws(
    () =>
      validateManifest(
        manifest({ compatibility: { agentSpace: ">=0.2.0", os: ["plan9"] } }),
      ),
    /unknown platform/,
  );
  assert.throws(
    () =>
      validateManifest(
        manifest({ permissions: { providers: ["mystery-cli"] } }),
      ),
    /unknown provider/,
  );
  assert.throws(
    () =>
      validateManifest(
        manifest({ configurationSchema: { type: "object", weird: 1 } }),
      ),
    /unsupported JSON Schema keyword/,
  );
  assert.throws(
    () => validateManifest(manifest({ manifestVersion: 99 })),
    /not supported/,
  );

  // A signature is always recorded with what it does and does not prove.
  const signed = validateManifest(
    manifest({
      signature: {
        publisher: "Acme Ltd",
        algorithm: "ed25519",
        value: "abc",
        keyId: "k1",
      },
    }),
  );
  assert.match(signed.signature.means, /not a safety review/);
});

test("hand-written semver range checks", () => {
  assert.equal(satisfiesRange("0.2.0", ">=0.2.0 <1.0.0"), true);
  assert.equal(satisfiesRange("1.0.0", ">=0.2.0 <1.0.0"), false);
  assert.equal(satisfiesRange("0.9.9", ">=0.2.0 <1.0.0"), true);
  assert.equal(satisfiesRange("1.2.3", "^1.2.0"), true);
  assert.equal(satisfiesRange("2.0.0", "^1.2.0"), false);
  assert.equal(satisfiesRange("0.3.5", "^0.3.1"), true);
  assert.equal(satisfiesRange("0.4.0", "^0.3.1"), false);
  assert.equal(satisfiesRange("1.2.9", "~1.2.3"), true);
  assert.equal(satisfiesRange("1.3.0", "~1.2.3"), false);
  assert.equal(satisfiesRange("1.5.0", "1.x"), true);
  assert.equal(satisfiesRange("2.5.0", "1.x"), false);
  assert.equal(satisfiesRange("1.2.7", "1.2.x"), true);
  assert.equal(satisfiesRange("3.1.4", "*"), true);
  assert.equal(satisfiesRange("1.0.0", "0.9.0 || >=1.0.0"), true);
  assert.equal(satisfiesRange("1.0.0", "=1.0.0"), true);
  assert.equal(compareSemver("1.0.0-beta.1", "1.0.0"), -1);
  assert.equal(compareSemver("1.0.1", "1.0.1"), 0);
  assert.equal(parseSemver("not-a-version"), null);
  assert.throws(
    () => satisfiesRange("1.0.0", "≥1"),
    /Unreadable version range|semantic version/,
  );
  assert.throws(() => satisfiesRange("bad", "*"), /Not a semantic version/);
});

test("install refuses when the manifest asks for more than the workspace allows", () => {
  const { registry, workspaceId } = setup();
  const greedy = manifest({
    id: "greedy-connector",
    permissions: {
      filesystem: "write",
      network: ["api.acme.example"],
      shell: true,
      providers: ["codex"],
    },
  });

  const preview = registry.importPreview({ manifest: greedy, workspaceId });
  assert.equal(preview.wouldBeRefused, true);
  assert.equal(preview.loadedByThisBuild, false);
  assert.deepEqual(
    preview.permissionProblems.map((problem) => problem.permission).sort(),
    ["filesystem", "network", "providers", "shell"],
  );
  assert.match(preview.signature.means, /not a safety review/);
  assert.ok(
    preview.permissionSummary.some((line) => /Filesystem: write/.test(line)),
  );

  assert.throws(
    () => registry.install({ manifest: greedy, workspaceId }),
    /Refused/,
  );

  // Opting the workspace in raises the ceiling exactly as far as it says.
  const opened = setup({
    extensionSettings: {
      allowFilesystem: "write",
      allowNetwork: ["api.acme.example"],
      allowShell: true,
      allowProviders: ["codex"],
    },
  });
  const installed = opened.registry.install({
    manifest: greedy,
    workspaceId: opened.workspaceId,
  });
  assert.equal(installed.status, "installed");
  assert.equal(installed.loaded, false);
  assert.match(installed.loadRefusedReason, /does not load or execute/);
  assert.deepEqual(installed.workspaces, [opened.workspaceId]);

  // Compatibility and OS are refused separately, with a plain reason.
  assert.throws(
    () =>
      opened.registry.install({
        manifest: manifest({
          id: "future",
          compatibility: { agentSpace: ">=9.0.0", os: ["win32"] },
        }),
        workspaceId: opened.workspaceId,
      }),
    /requires Agent Space/,
  );
  assert.throws(
    () =>
      opened.registry.install({
        manifest: manifest({
          id: "elsewhere",
          compatibility: {
            agentSpace: "*",
            os: [process.platform === "win32" ? "linux" : "win32"],
          },
        }),
        workspaceId: opened.workspaceId,
      }),
    /supports/,
  );
  assert.throws(
    () => opened.registry.install({ manifest: manifest() }),
    /workspaceId is required/,
  );
});

test("install cannot widen permissions for a workspace already opted in", () => {
  // Workspace A is read-only; workspace B allows shell and any network.
  const strict = setup();
  const relaxed = setup({
    extensionSettings: { allowShell: true, allowNetwork: ["*"] },
  });
  // Both registries share nothing, so opt workspace B into the SAME registry
  // as A by raising B's ceiling on A's services.
  const workspaceB = strict.services.hub.create({
    name: "Relaxed",
    rootPath: "C:/work/relaxed",
  });
  strict.services.db
    .prepare("UPDATE workspaces SET settings = ? WHERE id = ?")
    .run(
      JSON.stringify({ extensions: { allowShell: true, allowNetwork: ["*"] } }),
      workspaceB.id,
    );
  relaxed.services.close?.();

  const modest = manifest({ id: "x.tool" });
  const first = strict.registry.install({
    manifest: modest,
    workspaceId: strict.workspaceId,
  });
  assert.deepEqual(first.workspaces, [strict.workspaceId]);

  const greedy = manifest({
    id: "x.tool",
    version: "1.3.0",
    permissions: {
      filesystem: "read",
      network: ["*"],
      shell: true,
      providers: [],
    },
  });
  // install() into the permissive workspace would REPLACE the stored manifest
  // for workspace A too, so A's ceiling has to be checked as well.
  assert.throws(
    () =>
      strict.registry.install({ manifest: greedy, workspaceId: workspaceB.id }),
    (error) =>
      error.status === 403 &&
      /already installed in workspace/.test(error.message),
  );
  const stored = strict.registry.get("x.tool");
  assert.equal(stored.manifest.permissions.shell, false);
  assert.deepEqual(stored.workspaces, [strict.workspaceId]);

  // The same manifest still installs into the second workspace unchanged.
  const shared = strict.registry.install({
    manifest: modest,
    workspaceId: workspaceB.id,
  });
  assert.deepEqual(
    shared.workspaces.sort(),
    [strict.workspaceId, workspaceB.id].sort(),
  );
});

test("an update is staged with a permission diff that must be accepted", () => {
  const { registry, workspaceId, audits } = setup({
    extensionSettings: {
      allowNetwork: ["api.acme.example", "cdn.acme.example"],
    },
  });
  registry.install({
    manifest: manifest({ permissions: { filesystem: "read" } }),
    workspaceId,
  });

  const next = manifest({
    version: "1.3.0",
    permissions: {
      filesystem: "read",
      network: ["api.acme.example"],
      shell: false,
      providers: [],
    },
  });
  const diff = diffPermissions(
    validateManifest(manifest()),
    validateManifest(next),
  );
  assert.equal(diff.escalates, true);
  assert.deepEqual(diff.added.network, ["api.acme.example"]);
  assert.match(diff.summary.join(" "), /New network destinations/);

  const staged = registry.update("acme-connector", next);
  assert.equal(
    staged.manifest.version,
    "1.2.0",
    "the live manifest does not change yet",
  );
  assert.equal(staged.pending.manifest.version, "1.3.0");
  assert.equal(staged.pending.requiresAcceptance, true);
  assert.equal(staged.pending.permissionDiff.escalates, true);

  assert.throws(
    () => registry.acceptUpdate("acme-connector"),
    /must be accepted explicitly/,
  );
  const applied = registry.acceptUpdate("acme-connector", {
    acceptedPermissions: true,
  });
  assert.equal(applied.manifest.version, "1.3.0");
  assert.equal(applied.pinnedVersion, "1.3.0");
  assert.equal(applied.pending, null);

  // Pinning keeps a known version; an unknown one is refused.
  assert.equal(registry.pin("acme-connector", "1.3.0").pinnedVersion, "1.3.0");
  assert.throws(() => registry.pin("acme-connector", "9.9.9"), /not recorded/);
  assert.throws(
    () => registry.pin("acme-connector", "nine"),
    /semantic version/,
  );

  // A staged update that exceeds the workspace ceiling is refused on accept.
  registry.update(
    "acme-connector",
    manifest({ version: "1.4.0", permissions: { shell: true } }),
  );
  assert.throws(
    () =>
      registry.acceptUpdate("acme-connector", { acceptedPermissions: true }),
    /more than workspace/,
  );
  assert.equal(registry.rejectUpdate("acme-connector").pending, null);

  // An extension may not change kind under the same id.
  assert.throws(
    () => registry.update("acme-connector", manifest({ kind: "visual-theme" })),
    /cannot change kind/,
  );

  assert.ok(audits.some((entry) => entry.action === "extension.update.staged"));
  assert.ok(
    audits.some((entry) => entry.action === "extension.update.accepted"),
  );
});

test("removal is refused while a run is using the extension; revocation always works", () => {
  const { services, registry, workspaceId } = setup();
  registry.install({
    manifest: manifest(),
    workspaceId,
    dependencies: [{ id: "acme-core", versionRange: "^1.0.0" }],
  });

  const inventory = registry.dependencyInventory();
  assert.equal(inventory.length, 1);
  assert.deepEqual(inventory[0].dependencies, [
    { id: "acme-core", versionRange: "^1.0.0", resolved: false },
  ]);
  assert.equal(inventory[0].loaded, false);
  assert.equal(inventory[0].signatureMeaning, SIGNATURE_MEANING);

  const runId = randomUUID();
  const workspace = services.hub.get(workspaceId);
  const task = workspace.store.create({ title: "Uses the extension" }, "test");
  const agentId = workspace.snapshot().agents[0].id;
  services.db
    .prepare(
      `INSERT INTO runs (id, task_id, agent_id, agent_snapshot, provider, workspace_id, status, started_at, mode)
       VALUES (?, ?, ?, '{}', 'claude-code', ?, 'running', ?, 'managed')`,
    )
    .run(runId, task.id, agentId, workspaceId, Date.now());
  registry.beginUse("acme-connector", runId);
  assert.equal(registry.activeUses("acme-connector").length, 1);
  assert.throws(
    () => registry.remove("acme-connector"),
    /in use by 1 active run/,
  );

  // Revoking is allowed even while the run is active: it stops future use.
  const revoked = registry.revoke("acme-connector", {
    reason: "publisher key rotated",
  });
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.revokedReason, "publisher key rotated");
  assert.throws(
    () => registry.beginUse("acme-connector", randomUUID()),
    /revoked/,
  );

  // A finished run no longer blocks removal.
  services.db
    .prepare("UPDATE runs SET status = 'completed' WHERE id = ?")
    .run(runId);
  assert.equal(registry.activeUses("acme-connector").length, 0);
  assert.deepEqual(registry.remove("acme-connector"), {
    id: "acme-connector",
    removed: true,
  });
  assert.throws(() => registry.get("acme-connector"), /not found/);
});

test("checksum verification proves integrity, never safety", () => {
  const { registry } = setup();
  const bytes = Buffer.from("package-bytes");
  const expected = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const ok = registry.verifyChecksum({ bytes, checksum: expected });
  assert.equal(ok.ok, true);
  assert.equal(ok.actual, expected);
  assert.match(ok.means, /not a safety review/);

  const tampered = registry.verifyChecksum({
    bytes: Buffer.from("other-bytes"),
    checksum: expected,
  });
  assert.equal(tampered.ok, false);
  assert.notEqual(tampered.actual, tampered.expected);
  assert.throws(
    () => registry.verifyChecksum({ bytes, checksum: "md5:xyz" }),
    /sha256/,
  );
  assert.equal(checksumOf(bytes), expected);
});

test("workspace ceilings default to read-only and observe-only workspaces get no shell", () => {
  assert.deepEqual(workspaceCeiling(), {
    filesystem: "read",
    network: [],
    shell: false,
    providers: [],
  });
  const ceiling = workspaceCeiling(
    { autonomy: "observe-only" },
    { extensions: { allowShell: true, allowNetwork: ["*.acme.example"] } },
  );
  assert.equal(ceiling.shell, false);
  assert.equal(
    permissionsExceeding(
      {
        filesystem: "read",
        network: ["api.acme.example"],
        shell: false,
        providers: [],
      },
      ceiling,
    ).length,
    0,
    "a wildcard destination covers its subdomains",
  );
  assert.equal(
    permissionsExceeding(
      {
        filesystem: "read",
        network: ["evil.example"],
        shell: false,
        providers: [],
      },
      ceiling,
    ).length,
    1,
  );
});

test("template export strips secrets, private paths, raw logs, and client data", () => {
  const { registry } = setup();
  const dirty = {
    id: "dirty",
    name: "Dirty",
    apiToken: "sk-secret-value",
    steps: [
      { key: "a", instructions: "Read C:\\Users\\dev\\secret\\notes.md" },
    ],
    logs: ["line one"],
    clientData: { customer: "Acme" },
    nested: { password: "hunter2", keep: "fine" },
  };
  const { template, removed } = stripTemplate(dirty);
  assert.equal(template.apiToken, undefined);
  assert.equal(template.logs, undefined);
  assert.equal(template.clientData, undefined);
  assert.equal(template.nested.password, undefined);
  assert.equal(template.nested.keep, "fine");
  assert.equal(template.steps[0].instructions, "Read <path removed on export>");
  assert.deepEqual(removed.map((entry) => entry.reason).sort(), [
    "client data",
    "private path",
    "raw log",
    "secret",
    "secret",
  ]);

  const exported = registry.exportTemplate("bug-clinic", { getTemplate });
  assert.equal(exported.format, "agent-space-template");
  assert.equal(exported.template.id, "bug-clinic");
  assert.deepEqual(exported.removed, []);
  assert.match(exported.checksum, /^sha256:[a-f0-9]{64}$/);
  assert.ok(validateTemplate(exported.template));
});

test("importing a template shows a preview with a permission summary and writes nothing", () => {
  const { registry } = setup();
  const exported = registry.exportTemplate("release-room", { getTemplate });
  const result = registry.importTemplate(exported, {
    validateTemplate,
    connectorVocabulary: CONNECTOR_VOCABULARY,
  });
  assert.equal(result.applied, false);
  assert.match(result.note, /Nothing was written/);
  const preview = result.preview;
  assert.equal(preview.id, "release-room");
  assert.equal(preview.valid, true);
  assert.equal(preview.steps.length, 5);
  assert.ok(
    preview.permissionSummary.some((line) => /workspace policy/.test(line)),
  );
  assert.deepEqual(
    preview.unavailableConnectors.map((entry) => entry.name),
    ["ci-cd"],
  );

  const broken = registry.importTemplate(
    { template: { id: "broken", steps: [{ key: "a", dependsOn: ["ghost"] }] } },
    { validateTemplate, connectorVocabulary: CONNECTOR_VOCABULARY },
  );
  assert.equal(broken.preview.valid, false);
  assert.match(broken.preview.problem, /unknown ghost/);
  assert.equal(broken.template, null);
});

test("extension routes list, preview, install, update, revoke, and delete", async () => {
  const { default: routes } =
    await import("../packages/server/src/routes/extensions.js");
  const { services, workspaceId } = setup({
    extensionSettings: { allowNetwork: ["api.acme.example"] },
  });
  const calls = [];
  const call = async (method, path, payload) => {
    const url = new URL(`http://localhost${path}`);
    let status = null;
    let data = null;
    const handled = await routes({
      method,
      path: url.pathname,
      url,
      query: url.searchParams,
      send: (code, value) => {
        status = code;
        data = value;
      },
      body: async () => payload,
      services,
      actor: "tester",
    });
    calls.push({ path, status });
    return { handled, status, data };
  };

  const empty = await call("GET", "/api/extensions");
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.extensions, []);
  assert.equal(empty.data.loadingSupported, false);
  assert.match(empty.data.signatureMeaning, /not a safety review/);

  const preview = await call("POST", "/api/extensions/import-preview", {
    manifest: manifest(),
    workspaceId,
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.wouldBeRefused, false);

  const installed = await call("POST", "/api/extensions", {
    manifest: manifest(),
    workspaceId,
  });
  assert.equal(installed.status, 201);
  assert.equal(installed.data.id, "acme-connector");

  const staged = await call("PATCH", "/api/extensions/acme-connector", {
    manifest: manifest({ version: "1.3.0" }),
  });
  assert.equal(staged.data.pending.manifest.version, "1.3.0");
  const accepted = await call("PATCH", "/api/extensions/acme-connector", {
    acceptUpdate: true,
    acceptedPermissions: true,
  });
  assert.equal(accepted.data.manifest.version, "1.3.0");
  await assert.rejects(
    () => call("PATCH", "/api/extensions/acme-connector", {}),
    /stage an update/,
  );

  const revoked = await call("POST", "/api/extensions/acme-connector/revoke", {
    reason: "test",
  });
  assert.equal(revoked.data.status, "revoked");

  const exported = await call("GET", "/api/templates/data-analytics/export");
  assert.equal(exported.data.template.id, "data-analytics");
  const importPreview = await call("POST", "/api/templates/import-preview", {
    template: exported.data.template,
  });
  assert.equal(importPreview.data.preview.valid, true);
  assert.equal(importPreview.data.applied, false);

  const deleted = await call("DELETE", "/api/extensions/acme-connector");
  assert.deepEqual(deleted.data, { id: "acme-connector", removed: true });

  // Paths this module does not own fall through to the next route.
  const other = await call("GET", "/api/templates");
  assert.equal(other.handled, false);
  const outside = await call("GET", "/api/workspaces");
  assert.equal(outside.handled, false);
});
