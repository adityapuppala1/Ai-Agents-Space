import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServices } from "../packages/core/src/services.js";
import { RunRecorder } from "../packages/core/src/runs/RunRecorder.js";
import { createRunWorker } from "../packages/core/src/runs/RunWorker.js";
import { DEFAULT_POLICY } from "../packages/core/src/contracts.js";

/**
 * Two things seen on real Claude Code runs on 2026-09-15.
 *
 * Launched together under a limit of two, the second run was queued with
 * "workspace already runs 2 managed runs" while one existed, and waited until
 * the first one ended. A launch is recorded as running before it finishes
 * starting, and was counted a second time as a launch in flight.
 *
 * And a manual placeholder opened when an agent was assigned outlived the real
 * run that replaced it, so after the run ended the agent went back to
 * "coding" on the strength of a run that never did anything.
 */

const fakeCli = (name) =>
  fileURLToPath(new URL(`./fixtures/fake-cli/${name}`, import.meta.url));
const q = (value) => `"${value}"`;
const fakeEnv = {
  ...process.env,
  AGENT_SPACE_BIN_CLAUDE_CODE: `${q(process.execPath)} ${q(fakeCli("claude.js"))}`,
};
delete fakeEnv.AGENT_SPACE_BIN_CURSOR;

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    try {
      rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    } catch {
      /* Windows may hold a handle briefly */
    }
  });
  return dir;
}

function gitRepo(t) {
  const dir = tempDir(t, "agent-space-slots-");
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args],
      { cwd: dir, stdio: "ignore" },
    );
  git("init", "-q");
  writeFileSync(join(dir, "README.md"), "# fixture repo\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
  return dir;
}

function setup(t, { policy = null } = {}) {
  const services = createServices({ demo: false });
  const originalClose = services.close;
  let closed = false;
  services.close = async () => {
    if (closed) return;
    closed = true;
    await originalClose();
  };
  const repo = gitRepo(t);
  const dataDir = tempDir(t, "agent-space-slots-data-");
  const workspace = services.hub.get(
    services.hub.create({ name: "Slots", rootPath: repo }).id,
  );
  if (policy)
    services.db
      .prepare("UPDATE workspaces SET policy = ? WHERE id = ?")
      .run(JSON.stringify(policy), workspace.id);
  const recorder = new RunRecorder(services, { broadcastIntervalMs: 1 });
  const worker = createRunWorker(services, { recorder, env: fakeEnv, dataDir });
  t.after(async () => {
    await worker.close();
    recorder.flush();
    await services.close();
  });
  const task = (title) =>
    workspace.create({ title, description: "Hold still" });
  return { services, workspace, recorder, worker, task };
}

test("two runs launched together both start when the limit allows two", async (t) => {
  const { workspace, recorder, worker, task } = setup(t, {
    policy: { ...DEFAULT_POLICY, maxConcurrentRuns: 2 },
  });
  // One agent per run, as in the run that showed this: an agent cannot hold
  // two runs at once, so sharing one would fail for a reason unrelated to
  // slots and prove nothing about them.
  const agent = (name) =>
    workspace.createAgent({ name, role: "Builder", provider: "claude-code" });
  const [forge, probe, quill] = ["Forge", "Probe", "Quill"].map(agent);
  const launch = (title, who) =>
    worker.start({
      workspaceId: workspace.id,
      taskId: task(title).id,
      provider: "claude-code",
      agentId: who.id,
      prompt: `HANG ${title}`,
    });

  const [a, b] = await Promise.all([
    launch("One", forge),
    launch("Two", probe),
  ]);
  assert.deepEqual([a.status, b.status], ["running", "running"]);
  assert.ok(
    !recorder.events(b.id).some((e) => /^Queued:/.test(e.message ?? "")),
    "the second launch was queued behind a slot that was free",
  );
  assert.equal(worker.activeSlots(workspace.id), 2);

  // A third really is over the limit, and says how many are running.
  const c = await launch("Three", quill);
  assert.equal(c.status, "queued");
  assert.ok(
    recorder
      .events(c.id)
      .some((e) =>
        /Queued: workspace already runs 2 managed runs/.test(e.message ?? ""),
      ),
    JSON.stringify(recorder.events(c.id).map((e) => e.message)),
  );

  await worker.cancel(c.id);
  await worker.cancel(a.id);
  await worker.cancel(b.id);
  await worker.wait(a.id, 20000);
  await worker.wait(b.id, 20000);
});

test("a managed run closes the manual placeholder it replaces", async (t) => {
  const { services, workspace, worker } = setup(t);
  const agent = workspace.createAgent({
    name: "Forge",
    role: "Builder",
    provider: "claude-code",
  });
  // Manual work first: this opens a placeholder, as it should.
  const created = workspace.create({
    title: "Started by hand",
    description: "quick",
    agentId: agent.id,
  });
  const placeholder = workspace.activeRun(created.id);
  assert.equal(placeholder.mode, "manual");

  const run = await worker.start({
    workspaceId: workspace.id,
    taskId: created.id,
    provider: "claude-code",
    agentId: agent.id,
    prompt: "quick",
  });
  const row = services.db
    .prepare("SELECT status, ended_at FROM runs WHERE id = ?")
    .get(placeholder.id);
  assert.equal(row.status, "cancelled");
  assert.ok(row.ended_at, "the placeholder ended when the real run began");

  const done = await worker.wait(run.id, 20000);
  assert.equal(done.status, "completed");
  // Once the real run has ended, the placeholder must not come back.
  assert.equal(workspace.activeRun(created.id), null);
  const shown = workspace.snapshot().agents.find((a) => a.id === agent.id);
  assert.equal(shown.state, "IDLE");
  assert.equal(shown.activityProvenance, "system");
});
