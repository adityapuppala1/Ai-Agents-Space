import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServices } from "../packages/core/src/services.js";
import {
  ContextManifest,
  hashManifest,
  normalizePath,
  isWithin,
  samePath,
} from "../packages/core/src/context/ContextManifest.js";
import { MemoryService } from "../packages/core/src/context/memory.js";
import { RunRecorder } from "../packages/core/src/runs/RunRecorder.js";

function tempDir(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `agent-space-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function gitAvailable() {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

test("path helpers normalize and compare case-insensitively on win32", () => {
  const root = resolve(tmpdir(), "Proj");
  assert.equal(
    samePath(root, root.toLowerCase()),
    process.platform === "win32",
  );
  assert.equal(isWithin(join(root, "src", "a.js"), root), true);
  assert.equal(isWithin(resolve(tmpdir(), "Projects", "a.js"), root), false);
  assert.equal(
    normalizePath(root + (process.platform === "win32" ? "\\" : "/")),
    root,
  );
});

test("manifest includes scoped files with revisions, excludes secrets, oversized, and outside-scope files", (t) => {
  const root = tempDir(t, "root");
  const outside = tempDir(t, "outside");
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "src", "app.js"),
    "export const a = 1;\n".repeat(20),
  );
  writeFileSync(join(root, ".env"), "SECRET=1\n");
  writeFileSync(join(root, "big.bin"), Buffer.alloc(5000));
  writeFileSync(join(outside, "other.js"), "x");
  writeFileSync(join(root, "id_rsa"), "key");

  const services = createServices({ demo: false });
  const workspace = services.hub.get(
    services.hub.create({ name: "Ctx", rootPath: root }).id,
  );
  const agent = workspace.createAgent({
    name: "Scout",
    role: "Researcher",
    instructions: "Prefer small diffs.",
  });
  const task = workspace.create({
    title: "Wire context",
    description: "Attach files",
  });
  services.db
    .prepare("UPDATE tasks SET deliverable = ?, target = ? WHERE id = ?")
    .run("A manifest", JSON.stringify({ files: ["src/app.js"] }), task.id);

  const context = new ContextManifest(services, { git: false });
  const manifest = context.build({
    workspaceId: workspace.id,
    taskId: task.id,
    agentId: agent.id,
    files: [
      "src/app.js",
      ".env",
      "big.bin",
      join(outside, "other.js"),
      "id_rsa",
      "missing.js",
      "src",
    ],
    instructions: ["Keep tests green."],
    documents: [{ title: "Spec", ref: "docs/spec.md", bytes: 400 }],
    maxFileBytes: 4000,
  });
  assert.equal(manifest.files.length, 1);
  const app = manifest.files[0];
  assert.equal(samePath(app.path, join(root, "src", "app.js")), true);
  assert.match(app.revision, /^mtime:\d+$/);
  assert.equal(app.bytes, 400);
  assert.equal(app.included, true);
  const reasons = Object.fromEntries(
    manifest.excluded.map((e) => [e.path.split(/[\\/]/).pop(), e.reason]),
  );
  assert.equal(reasons[".env"], "secret");
  assert.equal(reasons["id_rsa"], "secret");
  assert.equal(reasons["big.bin"], "too-large");
  assert.equal(reasons["other.js"], "outside-scope");
  assert.equal(reasons["missing.js"], "missing");
  assert.equal(reasons["src"], "not-a-file");
  assert.equal(manifest.documents[0].title, "Spec");
  assert.equal(manifest.estimateLabel, "estimate");
  const instructionBytes = Buffer.byteLength(manifest.instructions.join("\n"));
  assert.equal(manifest.totalBytes, 400 + instructionBytes + 400);
  assert.equal(manifest.estimatedTokens, Math.ceil(manifest.totalBytes / 4));
  assert.match(manifest.instructions[0], /^Workspace: Ctx \(/);
  assert.ok(manifest.instructions.includes("Prefer small diffs."));
  assert.ok(manifest.instructions.includes("Task: Wire context"));
  assert.ok(manifest.instructions.includes("Deliverable: A manifest"));
  assert.ok(manifest.instructions.includes("Keep tests green."));
  assert.match(manifest.hash, /^[0-9a-f]{64}$/);
  assert.equal(manifest.hash, hashManifest(manifest));
  // No file contents in the manifest.
  assert.ok(!JSON.stringify(manifest).includes("export const a"));
  assert.ok(!JSON.stringify(manifest).includes("SECRET=1"));

  // Stable hash for identical inputs; changes when instructions change.
  const again = context.build({
    workspaceId: workspace.id,
    taskId: task.id,
    agentId: agent.id,
    files: ["src/app.js"],
    instructions: ["Keep tests green."],
    documents: [{ title: "Spec", ref: "docs/spec.md", bytes: 400 }],
    maxFileBytes: 4000,
  });
  assert.equal(again.hash, manifest.hash);
  const different = context.build({
    workspaceId: workspace.id,
    files: ["src/app.js"],
  });
  assert.notEqual(different.hash, manifest.hash);

  // Stale detection after modifying the file.
  assert.equal(context.detectStale(manifest).stale, false);
  writeFileSync(join(root, "src", "app.js"), "changed\n");
  const later = new Date(Date.now() + 5000);
  utimesSync(join(root, "src", "app.js"), later, later);
  const stale = context.detectStale(manifest);
  assert.equal(stale.stale, true);
  assert.equal(stale.changed.length, 1);
  assert.equal(stale.changed[0].previous, app.revision);
  assert.notEqual(stale.changed[0].current, app.revision);
  rmSync(join(root, "src", "app.js"));
  assert.equal(context.detectStale(manifest).missing.length, 1);
  assert.throws(() => context.detectStale({}), /manifest.files/);
});

test("allowedFolders extend scope and a workspace without rootPath rejects relative paths", (t) => {
  const root = tempDir(t, "root2");
  const shared = tempDir(t, "shared");
  writeFileSync(join(shared, "lib.js"), "lib");
  const services = createServices({ demo: false });
  const ws = services.hub.get(
    services.hub.create({ name: "Scoped", rootPath: root }).id,
  );
  services.db
    .prepare("UPDATE workspaces SET policy = ? WHERE id = ?")
    .run(JSON.stringify({ allowedFolders: [shared] }), ws.id);
  const context = new ContextManifest(services, { git: false });
  const manifest = context.build({
    workspaceId: ws.id,
    files: [join(shared, "lib.js")],
  });
  assert.equal(manifest.files.length, 1);

  const bare = services.hub.get(services.hub.create({ name: "No root" }).id);
  const none = context.build({
    workspaceId: bare.id,
    files: ["src/app.js", join(shared, "lib.js")],
  });
  assert.equal(none.files.length, 0);
  assert.deepEqual(
    none.excluded.map((e) => e.reason),
    ["outside-scope", "outside-scope"],
  );
  assert.throws(
    () => context.build({ workspaceId: ws.id, files: "x" }),
    /arrays/,
  );
  assert.throws(
    () => context.build({ workspaceId: ws.id, taskId: "nope" }),
    /Task not found/,
  );
});

test(
  "git blob revisions are used inside a repository",
  { skip: !gitAvailable() },
  (t) => {
    const root = tempDir(t, "repo");
    execFileSync("git", ["init", "-q"], {
      cwd: root,
      stdio: "ignore",
      windowsHide: true,
    });
    writeFileSync(join(root, "a.txt"), "hello\n");
    const services = createServices({ demo: false });
    const ws = services.hub.get(
      services.hub.create({ name: "Repo", rootPath: root }).id,
    );
    const context = new ContextManifest(services);
    const manifest = context.build({ workspaceId: ws.id, files: ["a.txt"] });
    assert.match(manifest.files[0].revision, /^git:[0-9a-f]{40,64}$/);
    // Same content → same blob hash even after the mtime changes.
    const later = new Date(Date.now() + 5000);
    utimesSync(join(root, "a.txt"), later, later);
    assert.equal(context.detectStale(manifest).stale, false);
    writeFileSync(join(root, "a.txt"), "hello world\n");
    assert.equal(context.detectStale(manifest).stale, true);
  },
);

test("detectStale with a workspace never probes files outside its scope or secret files", (t) => {
  const root = tempDir(t, "root");
  const outside = tempDir(t, "outside");
  writeFileSync(join(root, "a.txt"), "a\n");
  writeFileSync(join(outside, "b.txt"), "b\n");
  writeFileSync(join(root, ".env"), "SECRET=1\n");
  const services = createServices({ demo: false });
  t.after(() => services.close());
  const workspace = services.hub.create({ name: "Scoped", rootPath: root });
  const context = new ContextManifest(services, { git: false });
  const result = context.detectStale(
    {
      files: [
        { path: join(root, "a.txt"), revision: "x" },
        { path: join(outside, "b.txt"), revision: "x" },
        { path: join(root, ".env"), revision: "x" },
        { path: join(outside, "nope.txt"), revision: "x" },
      ],
    },
    { workspaceId: workspace.id },
  );
  assert.equal(result.changed.length, 1);
  assert.equal(result.missing.length, 0, "outside paths are not probed");
  assert.deepEqual(result.excluded.map((e) => e.reason).sort(), [
    "outside-scope",
    "outside-scope",
    "secret",
  ]);
});

test("manifest carries scoped memory, knowledge attribution, and relevance reasons", (t) => {
  const root = tempDir(t, "ctx-memory");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "login.js"), "export const login = 1;\n");
  writeFileSync(join(root, "src", "billing.js"), "export const bill = 1;\n");
  writeFileSync(join(root, "notes.md"), "captured notes\n");

  const services = createServices({ demo: false });
  t.after(() => services.close());
  const memory = new MemoryService(services);
  services.memory = memory;
  const workspace = services.hub.get(
    services.hub.create({ name: "Ctx", rootPath: root }).id,
  );
  const other = services.hub.create({ name: "Other project" });
  memory.set({
    scope: "workspace",
    scopeId: workspace.id,
    key: "convention",
    value: "Prefer small diffs",
  });
  memory.set({
    scope: "workspace",
    scopeId: other.id,
    key: "convention",
    value: "SECRET OTHER PROJECT RULE",
  });
  memory.set({ scope: "user", key: "tone", value: "Be terse" });
  const collection = memory.createCollection({
    workspaceId: workspace.id,
    name: "Runbook",
  });
  memory.addItem(collection.id, {
    title: "Notes",
    source: join(root, "notes.md"),
    content: "captured notes\n",
  });

  const task = workspace.create({ title: "Fix the login redirect" });
  services.db
    .prepare("UPDATE tasks SET deliverable = ?, target = ? WHERE id = ?")
    .run("login patch", JSON.stringify({ folder: join(root, "src") }), task.id);

  const context = new ContextManifest(services, { git: false });
  const manifest = context.build({
    workspaceId: workspace.id,
    taskId: task.id,
    files: ["src/login.js", "src/billing.js"],
    knowledge: true,
    relevance: { maxItems: 5 },
  });
  assert.ok(
    manifest.instructions.some((line) => /Prefer small diffs/.test(line)),
    "workspace knowledge is attached",
  );
  assert.ok(manifest.instructions.some((line) => /Be terse/.test(line)));
  assert.ok(
    !JSON.stringify(manifest).includes("SECRET OTHER PROJECT RULE"),
    "another workspace's memory never appears",
  );
  assert.equal(manifest.memory.workspace.length, 1);
  assert.equal(manifest.memory.userScopeShared, true);
  assert.equal(manifest.knowledge.length, 1);
  assert.equal(manifest.knowledge[0].collection, "Runbook");
  assert.ok(manifest.knowledge[0].capturedAt > 0);
  assert.equal(manifest.relevance.deterministic, true);
  assert.match(manifest.files[0].path, /login\.js$/);
  assert.ok(manifest.files[0].relevance.why.length > 0);
  assert.equal(manifest.estimateLabel, "estimate");

  const budgeted = context.build({
    workspaceId: workspace.id,
    taskId: task.id,
    files: ["src/login.js", "src/billing.js"],
    relevance: { maxItems: 1 },
  });
  assert.equal(budgeted.files.length, 1);
  assert.ok(
    budgeted.excluded.some((entry) => entry.reason === "over-budget"),
    "budget exclusions are visible",
  );
});

test("a context transfer records permitted paths, never contents and never secrets", (t) => {
  const root = tempDir(t, "ctx-transfer");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "app.js"), "const answer = 42;\n");
  const services = createServices({ demo: false });
  t.after(() => services.close());
  const recorder = new RunRecorder(services, { broadcastIntervalMs: 1 });
  services.recorder = recorder;
  const workspace = services.hub.get(
    services.hub.create({ name: "Transfer", rootPath: root }).id,
  );
  const agent = workspace.createAgent({ name: "Claude Code", role: "Coding" });
  const run = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agent.id,
    mode: "managed",
    provider: "claude-code",
    providerSessionId: "transfer-1",
    createTask: { title: "Transfer" },
  });
  const context = new ContextManifest(services, { git: false });
  const manifest = context.build({
    workspaceId: workspace.id,
    files: ["src/app.js", ".env"],
  });
  const transfer = context.recordTransfer({
    runId: run.id,
    provider: "claude-code",
    host: "local",
    manifest,
  });
  assert.equal(transfer.provider, "claude-code");
  assert.equal(transfer.host, "local");
  assert.equal(transfer.fileCount, 1);
  assert.equal(transfer.manifestHash, manifest.hash);
  assert.deepEqual(transfer.details.paths, [join("src", "app.js")]);
  const serialized = JSON.stringify(transfer);
  assert.ok(!serialized.includes("const answer = 42"), "no file contents");
  assert.ok(!/\.env/.test(serialized), "no secret path");
  assert.equal(transfer.details.estimateLabel, "estimate");

  const listed = context.transfersForRun(run.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, transfer.id);
  assert.equal(
    context.transfersForWorkspace(workspace.id).length,
    1,
    "the workspace sees its own transfers",
  );
  assert.throws(
    () => context.recordTransfer({ runId: run.id, manifest: {} }),
    /manifest.files/,
  );
});

test("gateApply refuses to apply when a pinned file changed", (t) => {
  const root = tempDir(t, "ctx-gate");
  writeFileSync(join(root, "a.js"), "one\n");
  const services = createServices({ demo: false });
  t.after(() => services.close());
  const recorder = new RunRecorder(services, { broadcastIntervalMs: 1 });
  services.recorder = recorder;
  const workspace = services.hub.get(
    services.hub.create({ name: "Gate", rootPath: root }).id,
  );
  const agent = workspace.createAgent({ name: "Codex", role: "Coding" });
  const run = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agent.id,
    mode: "managed",
    provider: "codex",
    providerSessionId: "gate-1",
    createTask: { title: "Gate" },
  });
  const context = new ContextManifest(services, { git: false });
  const manifest = context.build({
    workspaceId: workspace.id,
    files: ["a.js"],
  });
  recorder.update(run.id, { context: manifest });

  const fresh = context.gateApply({ runId: run.id });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.action, "apply");
  assert.deepEqual(fresh.stale, []);

  writeFileSync(join(root, "a.js"), "two\n");
  const later = new Date(Date.now() + 5000);
  utimesSync(join(root, "a.js"), later, later);
  const gated = context.gateApply({ runId: run.id });
  assert.equal(gated.ok, false);
  assert.equal(gated.action, "re-review");
  assert.equal(gated.stale.length, 1);
  assert.equal(gated.stale[0].state, "changed");
  assert.equal(gated.stale[0].was, manifest.files[0].revision);
  assert.notEqual(gated.stale[0].now, gated.stale[0].was);
  assert.match(gated.reason, /re-review or rebase/);

  // A run with no pinned manifest is not blocked, and says why.
  const second = workspace.createAgent({ name: "Codex 2", role: "Coding" });
  const bare = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: second.id,
    mode: "managed",
    provider: "codex",
    providerSessionId: "gate-2",
    createTask: { title: "No context" },
  });
  const none = context.gateApply({ runId: bare.id });
  assert.equal(none.ok, true);
  assert.match(none.reason, /no context manifest/);
  assert.throws(
    () => context.gateApply({ runId: "missing" }),
    (e) => e.status === 404,
  );
});

test("accepting a run whose pinned inputs changed forces a re-review", async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "gate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "spec.md");
  writeFileSync(file, "original\n");

  const services = createServices({ demo: false });
  const workspace = services.hub.get(
    services.hub.create({ name: "Gate", rootPath: dir }).id,
  );
  const agent = workspace.createAgent({ name: "Codex", role: "Coding" });
  const task = workspace.create({ title: "Edit the spec" });
  const manifest = services.context.build({
    workspaceId: workspace.id,
    taskId: task.id,
    files: [file],
  });
  assert.equal(manifest.files.filter((f) => f.included).length, 1);
  assert.equal(services.context.gateApply({ manifest }).action, "apply");

  writeFileSync(file, "changed underneath the run\n");
  const gate = services.context.gateApply({ manifest });
  assert.equal(gate.action, "re-review");
  assert.equal(gate.stale.length, 1);
  assert.match(gate.stale[0].path, /spec\.md$/);
  assert.ok(agent.id);
});
