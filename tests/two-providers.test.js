import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServices } from "../packages/core/src/services.js";
import { RunRecorder } from "../packages/core/src/runs/RunRecorder.js";
import { createRunWorker } from "../packages/core/src/runs/RunWorker.js";
import { listWorktrees } from "../packages/core/src/runs/worktree.js";
import { DEFAULT_POLICY } from "../packages/core/src/contracts.js";

/**
 * The end-to-end gate from roadmap section 18: ONE scenario that runs two
 * providers into two workspaces, writing concurrently in separate worktrees,
 * then reviews the output and rejects an unauthorized target.
 *
 * Separate tests already cover each clause; the point of this file is that they
 * hold together at the same time, which is where isolation bugs actually live.
 * Both providers are the fake CLIs, so nothing is spent and nothing is claimed
 * about a real Codex account.
 */

const fakeCli = (name) =>
  fileURLToPath(new URL(`./fixtures/fake-cli/${name}`, import.meta.url));
const q = (value) => `"${value}"`;
const fakeEnv = {
  ...process.env,
  AGENT_SPACE_BIN_CLAUDE_CODE: `${q(process.execPath)} ${q(fakeCli("claude.js"))}`,
  AGENT_SPACE_BIN_CODEX: `${q(process.execPath)} ${q(fakeCli("codex.js"))}`,
};

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
      /* Windows may still hold a handle */
    }
  });
  return dir;
}

function gitRepo(t, name) {
  const dir = tempDir(t, `agent-space-${name}-`);
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args],
      { cwd: dir, stdio: "ignore" },
    );
  git("init", "-q");
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
  return dir;
}

test("two providers write concurrently into two workspaces without crossing over", async (t) => {
  const services = createServices({ demo: false });
  const recorder = new RunRecorder(services, { broadcastIntervalMs: 1 });
  const dataDir = tempDir(t, "agent-space-data-");
  const worker = createRunWorker(services, {
    recorder,
    env: fakeEnv,
    dataDir,
  });
  t.after(async () => {
    await worker.close();
    recorder.flush();
    await services.close();
  });

  // Two workspaces, each rooted at its own repository.
  const repoA = gitRepo(t, "alpha");
  const repoB = gitRepo(t, "beta");
  const alpha = services.hub.get(
    services.hub.create({ name: "Alpha", rootPath: repoA }).id,
  );
  const beta = services.hub.get(
    services.hub.create({ name: "Beta", rootPath: repoB }).id,
  );
  for (const ws of [alpha, beta])
    services.db
      .prepare("UPDATE workspaces SET policy = ? WHERE id = ?")
      .run(
        JSON.stringify({ ...DEFAULT_POLICY, maxConcurrentRuns: 2 }),
        ws.id,
      );

  const taskA = alpha.create({ title: "Alpha change" });
  const taskB = beta.create({ title: "Beta change" });

  // Start both at once, each isolated in its own worktree.
  const [runA, runB] = await Promise.all([
    worker.start({
      workspaceId: alpha.id,
      taskId: taskA.id,
      provider: "claude-code",
      prompt: "WRITE_FILE alpha",
      isolation: "worktree",
    }),
    worker.start({
      workspaceId: beta.id,
      taskId: taskB.id,
      provider: "codex",
      prompt: "WRITE_FILE beta",
      isolation: "worktree",
    }),
  ]);
  assert.equal(runA.provider, "claude-code");
  assert.equal(runB.provider, "codex");
  assert.notEqual(runA.worktree, runB.worktree);
  assert.ok(runA.worktree && runB.worktree, "each run got its own worktree");

  const [doneA, doneB] = await Promise.all([
    worker.wait(runA.id, 30000),
    worker.wait(runB.id, 30000),
  ]);
  assert.equal(doneA.status, "completed", "claude-code run completed");
  assert.equal(doneB.status, "completed", "codex run completed");

  // Provenance is per provider and never mixed.
  for (const [run, provider] of [
    [doneA, "claude-code"],
    [doneB, "codex"],
  ]) {
    const events = recorder.events(run.id);
    assert.ok(events.length > 1, `${provider} recorded events`);
    assert.ok(
      events.some((e) => e.provenance === "provider"),
      `${provider} has provider-attributed events`,
    );
    assert.equal(
      recorder.get(run.id).provider,
      provider,
      "the run keeps its own provider",
    );
  }

  // Each worktree belongs to its own repository, and the write landed there
  // rather than in the shared checkout.
  const treesA = (await listWorktrees(repoA)).map((w) => w.path);
  const treesB = (await listWorktrees(repoB)).map((w) => w.path);
  assert.ok(treesA.includes(doneA.worktree), "alpha worktree is in repo A");
  assert.ok(treesB.includes(doneB.worktree), "beta worktree is in repo B");
  assert.ok(!treesA.includes(doneB.worktree), "repo A never saw B's worktree");
  assert.ok(!treesB.includes(doneA.worktree), "repo B never saw A's worktree");
  assert.ok(
    existsSync(join(doneA.worktree, "fake-output.txt")),
    "alpha wrote inside its worktree",
  );
  assert.ok(
    !existsSync(join(repoA, "fake-output.txt")),
    "the shared checkout is untouched until the patch is reviewed",
  );

  // Artifacts stay with their own run.
  const artifactsA = recorder.artifacts(doneA.id);
  const artifactsB = recorder.artifacts(doneB.id);
  assert.ok(artifactsA.length, "alpha produced artifacts");
  assert.ok(artifactsB.length, "beta produced artifacts");
  const idsB = new Set(artifactsB.map((a) => a.id));
  assert.ok(
    artifactsA.every((a) => !idsB.has(a.id)),
    "no artifact is shared between runs",
  );
  assert.ok(
    artifactsA.every((a) => a.workspaceId === alpha.id),
    "alpha's artifacts belong to alpha",
  );

  // Reviewing one workspace leaves the other alone.
  const reviewed = alpha.store.get(taskA.id);
  assert.equal(reviewed.review.status, "pending");
  services.db
    .prepare("UPDATE tasks SET review = ? WHERE id = ?")
    .run(
      JSON.stringify({
        runId: doneA.id,
        status: "accepted",
        decidedBy: "test",
      }),
      taskA.id,
    );
  alpha.store.update(taskA.id, { status: "COMPLETED" });
  assert.equal(alpha.store.get(taskA.id).status, "COMPLETED");
  assert.equal(
    beta.store.get(taskB.id).status,
    "IN_PROGRESS",
    "accepting alpha's result does not touch beta's task",
  );
  assert.equal(beta.store.get(taskB.id).review.status, "pending");

  // A target outside the workspace root is refused before anything spawns.
  const outsider = beta.create({ title: "Out of scope" });
  services.db
    .prepare("UPDATE tasks SET target = ? WHERE id = ?")
    .run(JSON.stringify({ folder: repoA }), outsider.id);
  await assert.rejects(
    () =>
      worker.start({
        workspaceId: beta.id,
        taskId: outsider.id,
        provider: "codex",
        prompt: "WRITE_FILE elsewhere",
      }),
    (error) => {
      assert.match(String(error.message), /outside|scope|allowed|policy/i);
      return true;
    },
    "a folder belonging to another workspace is not a permitted target",
  );

  // Reconciliation after a restart must not resurrect or duplicate a finished
  // run: both are terminal, so nothing is marked disconnected.
  const disconnected = worker.reconcile();
  assert.deepEqual(disconnected, [], "no completed run is reconciled");
  assert.equal(recorder.get(doneA.id).status, "completed");
  assert.equal(recorder.get(doneB.id).status, "completed");
  const runsA = recorder.list(alpha.id);
  const runsB = recorder.list(beta.id);
  assert.equal(runsA.length, 1, "alpha has exactly one run");
  assert.equal(runsB.length, 1, "beta has exactly one run");
});
