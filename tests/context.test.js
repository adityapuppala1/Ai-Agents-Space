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
