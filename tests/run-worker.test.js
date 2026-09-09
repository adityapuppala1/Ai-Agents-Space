import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServices } from "../packages/core/src/services.js";
import { RunRecorder } from "../packages/core/src/runs/RunRecorder.js";
import {
  RunWorker,
  createRunWorker,
  CANCEL_MESSAGE,
  DISCONNECTED_ERROR,
  SHUTDOWN_ERROR,
} from "../packages/core/src/runs/RunWorker.js";
import { listWorktrees } from "../packages/core/src/runs/worktree.js";
import { rangeIsStale } from "../packages/core/src/runs/outputScope.js";
import { DEFAULT_POLICY } from "../packages/core/src/contracts.js";
import { createWorkspaceServer } from "../packages/server/src/server.js";
import runRoutes from "../packages/server/src/routes/runs.js";
import workspaceRoutes from "../packages/server/src/routes/workspaces.js";

const fakeCli = (name) =>
  fileURLToPath(new URL(`./fixtures/fake-cli/${name}`, import.meta.url));
const q = (value) => `"${value}"`;
const fakeEnv = {
  ...process.env,
  AGENT_SPACE_BIN_CLAUDE_CODE: `${q(process.execPath)} ${q(fakeCli("claude.js"))}`,
  AGENT_SPACE_BIN_CODEX: `${q(process.execPath)} ${q(fakeCli("codex.js"))}`,
  AGENT_SPACE_BIN_COPILOT: `${q(process.execPath)} ${q(fakeCli("copilot.js"))}`,
  AGENT_SPACE_BIN_GEMINI: `${q(process.execPath)} ${q(fakeCli("gemini.js"))}`,
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
  const dir = tempDir(t, "agent-space-repo-");
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args],
      {
        cwd: dir,
        stdio: "ignore",
      },
    );
  git("init", "-q");
  writeFileSync(join(dir, "README.md"), "# fixture repo\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
  return dir;
}

function setup(
  t,
  { policy = null, extraServices = {}, workerOptions = {} } = {},
) {
  const services = createServices({ demo: false });
  Object.assign(services, extraServices);
  // The HTTP server also closes services on shutdown; make it idempotent.
  const originalClose = services.close;
  let closed = false;
  services.close = async () => {
    if (closed) return;
    closed = true;
    await originalClose();
  };
  const repo = gitRepo(t);
  const dataDir = tempDir(t, "agent-space-data-");
  const workspace = services.hub.get(
    services.hub.create({ name: "Runner", rootPath: repo }).id,
  );
  if (policy)
    services.db
      .prepare("UPDATE workspaces SET policy = ? WHERE id = ?")
      .run(JSON.stringify(policy), workspace.id);
  const recorder = new RunRecorder(services, { broadcastIntervalMs: 1 });
  const worker = createRunWorker(services, {
    recorder,
    env: fakeEnv,
    dataDir,
    ...workerOptions,
  });
  t.after(async () => {
    await worker.close();
    recorder.flush();
    await services.close();
  });
  const task = (title = "Write a file", extra = {}) => {
    const created = workspace.create({
      title,
      description: "Create fake-output.txt",
    });
    if (Object.keys(extra).length) {
      const sets = Object.keys(extra)
        .map((k) => `${k} = ?`)
        .join(", ");
      services.db
        .prepare(`UPDATE tasks SET ${sets} WHERE id = ?`)
        .run(...Object.values(extra), created.id);
    }
    return created;
  };
  return { services, workspace, repo, dataDir, recorder, worker, task };
}

test("a managed Claude Code run completes with events and artifacts", async (t) => {
  const { workspace, recorder, worker, task, repo } = setup(t);
  const created = task();
  const run = await worker.start({
    workspaceId: workspace.id,
    taskId: created.id,
    provider: "claude-code",
    prompt: "WRITE_FILE please",
  });
  assert.equal(run.mode, "managed");
  assert.equal(run.status, "running");
  assert.equal(run.cwd, repo);
  assert.ok(run.pid);
  assert.match(
    run.configSnapshot.command,
    /-p "WRITE_FILE please" --output-format stream-json --verbose/,
  );
  assert.match(run.configSnapshot.command, /--permission-mode acceptEdits/);
  assert.doesNotMatch(run.configSnapshot.command, /--bare/);
  assert.equal(run.configSnapshot.policy.autonomy, "scoped");
  assert.equal(workspace.store.get(created.id).status, "IN_PROGRESS");
  assert.ok(worker.get(run.id).attached);

  const done = await worker.wait(run.id, 20000);
  assert.equal(done.status, "completed");
  assert.equal(done.exitCode, 0);
  assert.ok(done.providerSessionId, "provider session id recorded");
  assert.equal(done.actualModel, "claude-haiku-4-5-20251001");
  assert.equal(done.usage.output_tokens, 379);
  assert.equal(done.usage.reportedBy, "provider");
  assert.equal(done.cost.usd, 0.0273145);
  assert.ok(done.endedAt);
  assert.equal(worker.get(run.id).attached, false);

  const events = recorder.events(run.id);
  assert.equal(events[0].kind, "session.start");
  assert.ok(
    events.some(
      (e) => e.kind === "system" && /Launched Claude Code/.test(e.message),
    ),
  );
  const write = events.find(
    (e) => e.kind === "file.edit" && /fake-output\.txt$/.test(e.file),
  );
  assert.ok(write, "file.edit event for fake-output.txt");
  assert.equal(write.provenance, "provider");
  assert.equal(write.data.activity, "CODING");
  assert.ok(
    events.some((e) => e.kind === "test" && e.data.command === "npm test"),
  );
  assert.ok(events.some((e) => e.kind === "complete"));

  const artifacts = recorder.artifacts(run.id, { withContent: true });
  const diff = artifacts.find((a) => a.kind === "diff");
  assert.ok(diff, "diff artifact");
  assert.match(diff.content, /fake-output\.txt/);
  assert.match(diff.metadata.status, /\?\? fake-output\.txt/);
  assert.ok(
    artifacts.some(
      (a) => a.kind === "test-output" && /npm test/.test(a.content),
    ),
  );
  assert.ok(artifacts.some((a) => a.kind === "message" && a.content === "OK"));
  assert.ok(existsSync(join(repo, "fake-output.txt")));

  // Managed completion leaves the task for review instead of completing it.
  assert.equal(workspace.store.get(created.id).status, "IN_PROGRESS");
  const review = JSON.parse(
    workspace.db
      .prepare("SELECT review FROM tasks WHERE id = ?")
      .get(created.id).review,
  );
  assert.equal(review.runId, run.id);
  assert.equal(review.status, "pending");
});

test("codex and copilot fake runs produce provider events and artifacts", async (t) => {
  const { workspace, recorder, worker, task } = setup(t);
  const codexTask = task("Codex work");
  const codexRun = await worker.start({
    workspaceId: workspace.id,
    taskId: codexTask.id,
    provider: "codex",
    prompt: "WRITE_FILE via codex",
    policy: { autonomy: "propose" },
  });
  assert.match(
    codexRun.configSnapshot.command,
    /exec --json --skip-git-repo-check -C .* -s read-only "WRITE_FILE via codex"/,
  );
  const codexDone = await worker.wait(codexRun.id, 20000);
  assert.equal(codexDone.status, "completed");
  assert.ok(codexDone.providerSessionId);
  assert.equal(codexDone.usage.input_tokens, 120);
  const codexEvents = recorder.events(codexRun.id);
  assert.ok(
    codexEvents.some((e) => e.kind === "test" && e.data.exitCode === 0),
  );
  assert.ok(codexEvents.some((e) => e.kind === "file.edit"));
  assert.ok(codexEvents.some((e) => e.kind === "message"));
  assert.ok(
    recorder.artifacts(codexRun.id).some((a) => a.kind === "test-output"),
  );

  const copilotTask = task("Copilot work");
  const copilotRun = await worker.start({
    workspaceId: workspace.id,
    taskId: copilotTask.id,
    provider: "copilot",
    prompt: "WRITE_FILE via copilot",
  });
  assert.match(copilotRun.configSnapshot.command, /--allow-all-tools/);
  const copilotDone = await worker.wait(copilotRun.id, 20000);
  assert.equal(copilotDone.status, "completed");
  assert.ok(copilotDone.providerSessionId);
  assert.equal(copilotDone.actualModel, "claude-haiku-4.5");
  assert.equal(copilotDone.usage.premiumRequests, 0.33);
  const copilotEvents = recorder.events(copilotRun.id);
  assert.ok(
    copilotEvents.some((e) => e.kind === "tool.start" && e.tool === "view"),
  );
  assert.ok(
    copilotEvents.some(
      (e) => e.kind === "file.edit" && /fake-output\.txt$/.test(e.file),
    ),
  );

  const failing = task("Fails");
  const failedRun = await worker.start({
    workspaceId: workspace.id,
    taskId: failing.id,
    provider: "codex",
    prompt: "FAIL now",
  });
  const failedDone = await worker.wait(failedRun.id, 20000);
  assert.equal(failedDone.status, "failed");
  assert.match(failedDone.error, /Fake failure/);
  assert.equal(workspace.store.get(failing.id).status, "BLOCKED");
});

test("worktree isolation runs in a git worktree that can be listed and removed", async (t) => {
  const { workspace, recorder, worker, task, repo, dataDir } = setup(t, {
    policy: { ...DEFAULT_POLICY, autonomy: "sandbox" },
  });
  const created = task("Sandboxed change");
  const run = await worker.start({
    workspaceId: workspace.id,
    taskId: created.id,
    provider: "claude-code",
    prompt: "WRITE_FILE in sandbox",
  });
  assert.equal(run.configSnapshot.isolation, "worktree");
  assert.equal(run.branch, `agent-space/${run.id}`);
  assert.ok(run.worktree.startsWith(join(dataDir, "worktrees")));
  assert.equal(run.cwd, run.worktree);
  const listed = await listWorktrees(repo);
  assert.ok(listed.some((w) => w.branch === `agent-space/${run.id}`));
  const done = await worker.wait(run.id, 20000);
  assert.equal(done.status, "completed");
  assert.ok(existsSync(join(run.worktree, "fake-output.txt")));
  assert.ok(
    !existsSync(join(repo, "fake-output.txt")),
    "main checkout untouched",
  );
  const diff = recorder
    .artifacts(run.id, { withContent: true })
    .find((a) => a.kind === "diff");
  assert.match(diff.content, /fake-output\.txt/);
  assert.equal(diff.metadata.worktree, run.worktree);
  assert.ok(
    recorder
      .events(run.id)
      .some((e) => /Created isolated worktree/.test(e.message)),
  );
  const removed = await worker.removeWorktree(run.id);
  assert.equal(removed.worktree, null);
  assert.equal(removed.context.worktreeRemoved, true);
  assert.ok(
    !(await listWorktrees(repo)).some(
      (w) => w.branch === `agent-space/${run.id}`,
    ),
  );
});

test("concurrency limit queues a second run and cancel frees the slot", async (t) => {
  const { workspace, recorder, worker, task } = setup(t, {
    policy: { ...DEFAULT_POLICY, maxConcurrentRuns: 1 },
  });
  const first = await worker.start({
    workspaceId: workspace.id,
    taskId: task("Long one").id,
    provider: "claude-code",
    prompt: "HANG forever",
  });
  assert.equal(first.status, "running");
  const second = await worker.start({
    workspaceId: workspace.id,
    taskId: task("Waits").id,
    provider: "claude-code",
    prompt: "quick",
  });
  assert.equal(second.status, "queued");
  assert.equal(second.configSnapshot.queued, true);
  assert.ok(
    recorder
      .events(second.id)
      .some((e) =>
        /Queued: workspace already runs 1 managed run/.test(e.message),
      ),
  );
  assert.equal(worker.activeCount(workspace.id), 1);

  const cancelled = await worker.cancel(first.id);
  assert.equal(cancelled.status, "cancelled");
  const events = recorder.events(first.id);
  assert.ok(events.some((e) => e.message === CANCEL_MESSAGE));
  await worker.wait(first.id, 20000);
  assert.equal(recorder.get(first.id).status, "cancelled");
  assert.ok(
    recorder
      .events(first.id)
      .some((e) => /ended after cancellation/.test(e.message)),
  );

  const secondDone = await worker.wait(second.id, 20000);
  assert.equal(secondDone.status, "completed");
  assert.equal(secondDone.configSnapshot.queued, false);
  assert.ok(
    recorder.events(second.id).some((e) => /slot freed up/.test(e.message)),
  );
  await assert.rejects(() => worker.cancel(first.id), /already cancelled/);
});

test("retry creates attempt 2 linked by parent_run_id and input resumes the provider session", async (t) => {
  const { workspace, recorder, worker, task } = setup(t);
  const created = task("Flaky");
  const first = await worker.start({
    workspaceId: workspace.id,
    taskId: created.id,
    provider: "claude-code",
    prompt: "FAIL first",
  });
  await assert.rejects(() => worker.retry(first.id), /still running/);
  const failed = await worker.wait(first.id, 20000);
  assert.equal(failed.status, "failed");
  assert.equal(failed.exitCode, 1);
  assert.equal(workspace.store.get(created.id).status, "BLOCKED");

  const second = await worker.retry(first.id, { prompt: "second try" });
  assert.equal(second.attempt, 2);
  assert.equal(second.parentRunId, first.id);
  assert.equal(second.taskId, created.id);
  assert.equal(second.agentId, first.agentId);
  assert.equal(workspace.store.get(created.id).status, "IN_PROGRESS");
  const secondDone = await worker.wait(second.id, 20000);
  assert.equal(secondDone.status, "completed");
  assert.ok(secondDone.providerSessionId);

  await assert.rejects(() => worker.input(second.id, ""), /text is required/);
  const third = await worker.input(second.id, "please continue");
  assert.equal(third.attempt, 3);
  assert.equal(third.parentRunId, second.id);
  assert.match(
    third.configSnapshot.command,
    new RegExp(`--resume ${secondDone.providerSessionId}`),
  );
  assert.equal(
    third.configSnapshot.resumeSessionId,
    secondDone.providerSessionId,
  );
  const thirdDone = await worker.wait(third.id, 20000);
  assert.equal(thirdDone.status, "completed");
  // The session id already belongs to attempt 2; attempt 3 keeps it in its snapshot.
  assert.equal(thirdDone.providerSessionId, null);
  assert.equal(
    thirdDone.configSnapshot.providerSessionId,
    secondDone.providerSessionId,
  );
  assert.equal(thirdDone.configSnapshot.resumedFromRun, second.id);
  const message = recorder
    .artifacts(third.id, { withContent: true })
    .find((a) => a.kind === "message");
  assert.match(
    message.content,
    new RegExp(`Resumed ${secondDone.providerSessionId}`),
  );

  const gemini = await worker.start({
    workspaceId: workspace.id,
    taskId: task("Gemini").id,
    provider: "gemini",
    prompt: "hello",
  });
  const geminiDone = await worker.wait(gemini.id, 20000);
  assert.equal(geminiDone.status, "completed");
  await assert.rejects(
    () => worker.input(gemini.id, "more"),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /does not support resuming/);
      return true;
    },
  );
});

test("reconcile marks managed runs left running by a previous process as disconnected", async (t) => {
  const { workspace, recorder, worker } = setup(t);
  const agent = workspace.snapshot().agents[0];
  const orphan = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agent.id,
    mode: "managed",
    provider: "codex",
    createTask: { title: "Left behind" },
    status: "running",
  });
  const observed = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: workspace.snapshot().agents[1].id,
    mode: "observed",
    provider: "claude-code",
    providerSessionId: "obs-1",
    createTask: { title: "Observed" },
  });
  const affected = worker.reconcile();
  assert.deepEqual(
    affected.map((r) => r.id),
    [orphan.id],
  );
  const run = recorder.get(orphan.id);
  assert.equal(run.status, "disconnected");
  assert.equal(run.error, DISCONNECTED_ERROR);
  assert.equal(recorder.get(observed.id).status, "running");
  assert.equal(workspace.store.get(orphan.taskId).status, "BLOCKED");
  await assert.rejects(() => worker.cancel(orphan.id), /already disconnected/);
  const retried = await worker.retry(orphan.id);
  assert.equal(retried.parentRunId, orphan.id);
  assert.ok(
    recorder
      .events(orphan.id)
      .some((e) => /Retrying a disconnected run/.test(e.message)),
  );
  const done = await worker.wait(retried.id, 20000);
  assert.equal(done.status, "completed");
});

test("policy gates: observe-only refuses, unknown provider and missing binary are rejected", async (t) => {
  const audit = [];
  const { workspace, worker, task, services } = setup(t, {
    extraServices: {
      policy: {
        forWorkspace: () => ({ ...DEFAULT_POLICY, autonomy: "observe-only" }),
        evaluateLaunch: ({ provider }) => ({
          allowed: false,
          reason: `observe-only workspace cannot launch ${provider}`,
        }),
      },
      audit: { record: (entry) => audit.push(entry) },
    },
  });
  const created = task("Blocked by policy");
  await assert.rejects(
    () =>
      worker.start({
        workspaceId: workspace.id,
        taskId: created.id,
        provider: "claude-code",
      }),
    (error) => {
      assert.equal(error.status, 403);
      assert.match(
        error.message,
        /observe-only workspace cannot launch claude-code/,
      );
      return true;
    },
  );
  assert.equal(audit.at(-1).action, "run.refused");
  assert.equal(audit.at(-1).policyDecision, "deny");
  assert.equal(workspace.store.get(created.id).status, "QUEUE");
  services.policy = null;
  await assert.rejects(
    () =>
      worker.start({
        workspaceId: workspace.id,
        taskId: created.id,
        provider: "nope",
      }),
    /Unknown provider/,
  );
  await assert.rejects(
    () =>
      worker.start({
        workspaceId: workspace.id,
        taskId: created.id,
        provider: "cursor",
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /cursor-agent is not installed/);
      return true;
    },
  );
  // Prompt built from the task when none is given, with the policy timeout enforced.
  const run = await worker.start({
    workspaceId: workspace.id,
    taskId: created.id,
    provider: "claude-code",
    policy: { timeoutMs: 400 },
    prompt: "HANG until timeout",
  });
  const done = await worker.wait(run.id, 20000);
  assert.equal(done.status, "failed");
  assert.equal(done.error, "timed out");
  assert.ok(
    audit.some(
      (entry) => entry.action === "run.start" && entry.runId === run.id,
    ),
  );
  assert.ok(audit.some((entry) => entry.action === "run.timeout"));
  const built = await worker.start({
    workspaceId: workspace.id,
    taskId: task("Describe the API", { deliverable: "A markdown doc" }).id,
    provider: "claude-code",
  });
  assert.match(
    built.prompt,
    /^Describe the API\n\nCreate fake-output\.txt\n\nDeliverable: A markdown doc/,
  );
  await worker.wait(built.id, 20000);
});

test("routes: launch, inspect, artifacts, and review accept completes the task", async (t) => {
  const { workspace, worker, task, services } = setup(t);
  const server = createWorkspaceServer({
    services,
    routes: [runRoutes, workspaceRoutes],
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  };
  const created = task("Reviewed change");
  const launched = await api(
    "POST",
    `/api/workspaces/${workspace.id}/tasks/${created.id}/run`,
    {
      provider: "claude-code",
      prompt: "WRITE_FILE via http",
    },
  );
  assert.equal(launched.status, 201);
  assert.equal(launched.data.status, "running");
  const runId = launched.data.id;
  await worker.wait(runId, 20000);

  const detail = await api("GET", `/api/runs/${runId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.run.status, "completed");
  assert.equal(detail.data.run.attached, false);
  assert.ok(detail.data.events.length > 5);
  assert.ok(detail.data.artifacts.length >= 2);
  assert.equal(detail.data.artifacts[0].content, undefined);
  assert.deepEqual(detail.data.approvals, []);
  assert.equal(detail.data.capabilities.launch, "verified");

  const events = await api(
    "GET",
    `/api/runs/${runId}/events?after=${detail.data.events[2].sequence}&limit=2`,
  );
  assert.equal(events.data.events.length, 2);
  assert.equal(events.data.events[0].sequence, detail.data.events[3].sequence);

  const artifacts = await api("GET", `/api/runs/${runId}/artifacts`);
  const diff = artifacts.data.find((a) => a.kind === "diff");
  const one = await api("GET", `/api/runs/${runId}/artifacts/${diff.id}`);
  assert.match(one.data.content, /fake-output\.txt/);
  assert.equal(
    (await api("GET", `/api/runs/${runId}/artifacts/nope`)).status,
    404,
  );
  assert.equal((await api("GET", `/api/runs/missing`)).status, 404);

  const rejected = await api("POST", `/api/runs/${runId}/review`, {
    decision: "reject",
    note: "needs tests",
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.data.review.status, "rejected");
  assert.equal(rejected.data.task.status, "IN_PROGRESS");
  const accepted = await api("POST", `/api/runs/${runId}/review`, {
    decision: "accept",
    note: "looks good",
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.task.status, "COMPLETED");
  assert.equal(workspace.store.get(created.id).status, "COMPLETED");
  const review = JSON.parse(
    workspace.db
      .prepare("SELECT review FROM tasks WHERE id = ?")
      .get(created.id).review,
  );
  assert.equal(review.status, "accepted");
  assert.equal(review.note, "looks good");
  assert.equal(
    (await api("POST", `/api/runs/${runId}/review`, { decision: "maybe" }))
      .status,
    400,
  );
  assert.equal((await api("POST", `/api/runs/${runId}/cancel`)).status, 409);
  const rerun = await api(
    "POST",
    `/api/workspaces/${workspace.id}/tasks/${created.id}/run`,
    { provider: "claude-code" },
  );
  assert.equal(rerun.status, 409);
  assert.match(rerun.data.error, /Completed tasks/);
  // Workspace routes still work after ours.
  assert.equal(
    (await api("GET", `/api/workspaces/${workspace.id}/tasks`)).status,
    200,
  );
});

test("RunWorker can be constructed with defaults and exposes adapters", (t) => {
  const services = createServices({ demo: false });
  t.after(() => services.close());
  const worker = new RunWorker(services, { env: { ...fakeEnv } });
  assert.ok(worker.recorder instanceof RunRecorder);
  assert.ok(worker.adapters["claude-code"]);
  assert.equal(worker.adapterFor("codex").id, "codex");
  services.settings = { get: (key) => key === "codex.useAppServer" };
  assert.equal(worker.adapterFor("codex").id, "codex-app-server");
  assert.deepEqual(worker.reconcile(), []);
});

test("sandbox preset forces worktree isolation whatever the request or task asks for", async (t) => {
  const { workspace, recorder, worker, task, repo, services } = setup(t, {
    policy: { ...DEFAULT_POLICY, autonomy: "sandbox" },
  });
  const created = task("Escape attempt");
  const run = await worker.start({
    workspaceId: workspace.id,
    taskId: created.id,
    provider: "claude-code",
    prompt: "WRITE_FILE in sandbox",
    isolation: "none",
  });
  assert.equal(run.configSnapshot.isolation, "worktree");
  assert.equal(run.configSnapshot.requestedIsolation, "none");
  assert.ok(run.worktree, "run executes in a worktree");
  assert.notEqual(run.cwd, repo);
  assert.ok(
    recorder
      .events(run.id)
      .some((e) => /Isolation forced to a Git worktree/.test(e.message)),
  );
  assert.equal(
    services.audit.list({ action: "run.isolation.forced" }).length,
    1,
  );
  const done = await worker.wait(run.id, 20000);
  assert.equal(done.status, "completed");
  assert.ok(
    !existsSync(join(repo, "fake-output.txt")),
    "main checkout untouched",
  );
  // A task-level execution policy cannot widen it either.
  const viaTask = task("Via task policy", {
    execution_policy: JSON.stringify({ isolation: "none" }),
  });
  const second = await worker.start({
    workspaceId: workspace.id,
    taskId: viaTask.id,
    provider: "claude-code",
    prompt: "quick",
  });
  assert.equal(second.configSnapshot.isolation, "worktree");
  assert.ok(second.worktree);
  await worker.wait(second.id, 20000);
});

test("task target folders outside the workspace and allowedFolders are refused; allowed ones become --add-dir", async (t) => {
  const { workspace, recorder, worker, task, services } = setup(t);
  const elsewhere = tempDir(t, "agent-space-elsewhere-");
  const created = task("Cross-folder", {
    target: JSON.stringify({ folder: elsewhere }),
  });
  await assert.rejects(
    () =>
      worker.start({
        workspaceId: workspace.id,
        taskId: created.id,
        provider: "claude-code",
        prompt: "quick",
      }),
    (error) => {
      assert.equal(error.status, 403);
      assert.match(error.message, /outside the workspace root/);
      return true;
    },
  );
  assert.equal(recorder.list(workspace.id).length, 0, "no run row created");
  services.policy.setForWorkspace(workspace.id, {
    allowedFolders: [elsewhere],
  });
  const run = await worker.start({
    workspaceId: workspace.id,
    taskId: created.id,
    provider: "claude-code",
    prompt: "quick",
  });
  assert.deepEqual(run.configSnapshot.extraDirs, [resolve(elsewhere)]);
  assert.match(run.configSnapshot.command, /--add-dir/);
  // The hook policy agrees with what the launch granted.
  const verdict = services.policy.evaluate({
    runId: run.id,
    request: { kind: "file", tool: "Edit", path: join(elsewhere, "x.txt") },
  });
  assert.equal(verdict.decision, "allow");
  assert.equal(verdict.rule, "file.in-scope");
  await worker.wait(run.id, 20000);
});

test("close() marks attached runs disconnected so a late exit never writes to a closed database", async (t) => {
  const { workspace, recorder, worker, task } = setup(t);
  const run = await worker.start({
    workspaceId: workspace.id,
    taskId: task("Long").id,
    provider: "claude-code",
    prompt: "HANG forever",
  });
  assert.equal(run.status, "running");
  let unhandled = 0;
  const onUnhandled = () => unhandled++;
  process.on("unhandledRejection", onUnhandled);
  await worker.close();
  const after = recorder.get(run.id);
  assert.equal(after.status, "disconnected");
  assert.equal(after.error, SHUTDOWN_ERROR);
  assert.ok(after.endedAt);
  assert.equal(workspace.store.get(run.taskId).status, "BLOCKED");
  assert.equal(worker.get(run.id).attached, false);
  // The child's exit lands later and must neither throw nor change status.
  await new Promise((r) => setTimeout(r, 500));
  process.off("unhandledRejection", onUnhandled);
  assert.equal(unhandled, 0);
  assert.equal(recorder.get(run.id).status, "disconnected");
  await worker.close(); // idempotent
});

test("reconcile flags a provider process that is still alive; retry refuses until forced", async (t) => {
  const { workspace, recorder, worker } = setup(t);
  const agent = workspace.snapshot().agents[0];
  const orphan = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agent.id,
    mode: "managed",
    provider: "claude-code",
    createTask: { title: "Left behind" },
    status: "running",
    pid: process.pid,
  });
  const [affected] = worker.reconcile();
  assert.equal(affected.id, orphan.id);
  assert.equal(affected.status, "disconnected");
  assert.match(
    affected.error,
    new RegExp(`process ${process.pid} may still be running`),
  );
  assert.equal(affected.context.pidAliveAtReconcile, process.pid);
  assert.ok(
    recorder
      .events(orphan.id)
      .some((e) => /may still be running unmanaged/.test(e.message)),
  );
  await assert.rejects(
    () => worker.retry(orphan.id),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /still be running/);
      return true;
    },
  );
  const retried = await worker.retry(orphan.id, {
    force: true,
    prompt: "quick",
  });
  assert.equal(retried.parentRunId, orphan.id);
  await worker.wait(retried.id, 20000);
});

// ---------------------------------------------------------------------------
// Wave 2: bounded retries, output scoping, range pinning, document inputs.
// ---------------------------------------------------------------------------

/** A provider binary that dies without ever producing a line (transport). */
function crashCli(t) {
  const dir = tempDir(t, "agent-space-crash-");
  const file = join(dir, "crash.js");
  writeFileSync(file, "process.exit(9);\n");
  return q(process.execPath) + " " + q(file);
}

async function waitFor(check, { timeoutMs = 20000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for " + label);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("a transport failure is retried automatically once, with an audited backoff, then stops", async (t) => {
  const { services, workspace, recorder, worker, task } = setup(t, {
    // random() = 0 gives the -20 % edge of the jitter: 1000 * 2 ** 1 * 0.8.
    workerOptions: { random: () => 0 },
  });
  worker.env = { ...fakeEnv, AGENT_SPACE_BIN_GEMINI: crashCli(t) };
  const created = task("Flaky transport");
  const first = await worker.start({
    workspaceId: workspace.id,
    taskId: created.id,
    provider: "gemini",
    prompt: "hello",
  });
  const failed = await worker.wait(first.id, 20000);
  assert.equal(failed.status, "failed");

  const events = recorder.events(first.id);
  const classified = events.find((e) =>
    /Failure classified as/.test(e.message),
  );
  assert.ok(classified, "the classification is recorded as an event");
  assert.equal(classified.kind, "status");
  assert.equal(classified.data.class, "transport");
  assert.equal(classified.data.sideEffects, "none");
  const scheduled = events.find((e) =>
    /Automatic retry 2 of 2/.test(e.message),
  );
  assert.ok(scheduled, "the automatic retry is announced before it happens");
  assert.equal(scheduled.data.delayMs, 1600);
  assert.match(scheduled.message, /cannot duplicate side effects/);
  assert.ok(
    services.audit
      .list({ action: "run.retry.scheduled" })
      .some((entry) => entry.runId === first.id),
  );

  const second = await waitFor(
    () => recorder.list(workspace.id).find((r) => r.parentRunId === first.id),
    { label: "the automatic retry" },
  );
  assert.equal(second.attempt, 2);
  const secondDone = await worker.wait(second.id, 20000);
  assert.equal(secondDone.status, "failed");
  const refusal = await waitFor(
    () =>
      recorder
        .events(second.id)
        .find((e) => /No automatic retry/.test(e.message)),
    { label: "the retry budget refusal" },
  );
  assert.match(refusal.message, /attempt 2 of 2: the automatic retry budget/);
  assert.equal(
    recorder.list(workspace.id).filter((r) => r.parentRunId === second.id)
      .length,
    0,
    "bounded: no third attempt",
  );
  const health = worker.providerHealth().find((h) => h.provider === "gemini");
  assert.equal(health.consecutiveFailures, 2);
  assert.equal(health.state, "closed", "two failures is not yet an outage");
});

test("a failed run that may have edited files is never retried automatically and lands in the inbox", async (t) => {
  const { services, workspace, recorder, worker, task } = setup(t);
  const created = task("Half-written change");
  const run = await worker.start({
    workspaceId: workspace.id,
    taskId: created.id,
    // The fake CLI writes fake-output.txt and then fails.
    prompt: "WRITE_FILE then FAIL",
    provider: "claude-code",
  });
  const done = await worker.wait(run.id, 20000);
  assert.equal(done.status, "failed");
  assert.ok(existsSync(join(recorder.get(run.id).cwd, "fake-output.txt")));

  const events = recorder.events(run.id);
  const classified = events.find((e) =>
    /Failure classified as/.test(e.message),
  );
  assert.notEqual(classified.data.sideEffects, "none");
  assert.equal(classified.data.retryable, false);
  const refusal = events.find((e) => /No automatic retry/.test(e.message));
  assert.match(
    refusal.message,
    /the previous attempt may already have changed files; review before retrying/,
  );
  assert.ok(
    services.audit
      .list({ action: "run.retry.refused" })
      .some((entry) => entry.runId === run.id),
  );
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(
    recorder.list(workspace.id).filter((r) => r.parentRunId === run.id).length,
    0,
    "no automatic attempt 2",
  );
  const inbox = services.approvals.inbox({ workspaceId: workspace.id });
  assert.ok(
    inbox.runs.some((r) => r.id === run.id),
    "the failure waits for a person in the decision inbox",
  );
  // A person may still retry it deliberately.
  const manual = await worker.retry(run.id, { prompt: "quick" });
  assert.equal(manual.parentRunId, run.id);
  await worker.wait(manual.id, 20000);
});

test("a non-Git folder gets a scoped output folder that is released when it stays empty", async (t) => {
  const { services, recorder, worker, dataDir } = setup(t);
  const docs = tempDir(t, "agent-space-docs-");
  const docWorkspace = services.hub.get(
    services.hub.create({ name: "Docs", rootPath: docs }).id,
  );
  const created = docWorkspace.create({ title: "Summarize the brief" });
  const run = await worker.start({
    workspaceId: docWorkspace.id,
    taskId: created.id,
    provider: "claude-code",
    prompt: "quick",
    isolation: "worktree",
  });
  const outputDir = resolve(join(dataDir, "outputs", run.id));
  assert.equal(run.configSnapshot.outputDir, outputDir);
  assert.equal(run.worktree, null, "a document folder is not a worktree");
  assert.equal(run.cwd, docs, "the run still reads the source folder");
  assert.ok(
    run.configSnapshot.extraDirs.includes(outputDir),
    "the output folder is handed to the provider as a writable dir",
  );
  assert.match(run.configSnapshot.command, /--add-dir/);
  const scoping = recorder
    .events(run.id)
    .find((e) => /scoped to an output folder/.test(e.message));
  assert.ok(scoping);
  assert.match(scoping.message, /copied back/i);
  assert.equal(scoping.kind, "status");

  const done = await worker.wait(run.id, 20000);
  assert.equal(done.status, "completed");
  const release = recorder
    .events(run.id)
    .find((e) => /Scoped output folder/.test(e.message));
  assert.match(release.message, /was empty and has been removed/);
  assert.equal(existsSync(outputDir), false);
});

test("a code range is pinned to a git revision at launch and staleness is detectable", async (t) => {
  const { workspace, recorder, worker, task, repo, services } = setup(t);
  const created = task("Tighten the header", {
    target: JSON.stringify({
      files: ["README.md"],
      range: { file: "README.md", start: 1, end: 1 },
      documents: [{ path: "README.md", label: "The brief" }],
    }),
  });
  const run = await worker.start({
    workspaceId: workspace.id,
    taskId: created.id,
    provider: "claude-code",
  });
  const stored = JSON.parse(
    services.db.prepare("SELECT target FROM tasks WHERE id = ?").get(created.id)
      .target,
  );
  assert.match(
    stored.range.revision,
    /^git:[0-9a-f]{7,64}$/,
    "the revision is the git blob hash of the file on disk",
  );
  assert.ok(stored.range.pinnedAt);
  assert.deepEqual(stored.documents, [
    { path: "README.md", label: "The brief" },
  ]);
  const pinnedEvent = recorder
    .events(run.id)
    .find((e) => /Pinned README\.md lines 1-1/.test(e.message));
  assert.ok(pinnedEvent);
  assert.equal(pinnedEvent.data.range.revision, stored.range.revision);

  // Document inputs reach the prompt as an explicit list.
  assert.match(
    run.prompt,
    /Input documents \(read these; they are the inputs for this task\):\n- README\.md \(The brief\)/,
  );
  assert.deepEqual(run.context.documents, [
    { path: "README.md", label: "The brief" },
  ]);
  const documentEvent = recorder
    .events(run.id)
    .find((e) => /document input/.test(e.message));
  assert.ok(documentEvent);
  await worker.wait(run.id, 20000);

  // Editing the file makes the pin stale; the pin itself never changes.
  assert.equal(await rangeIsStale(stored.range, { cwd: repo }), false);
  writeFileSync(join(repo, "README.md"), "# fixture repo, edited\n");
  assert.equal(await rangeIsStale(stored.range, { cwd: repo }), true);

  // A second launch reports the staleness instead of silently repinning.
  const again = await worker.start({
    workspaceId: workspace.id,
    taskId: created.id,
    provider: "claude-code",
    prompt: "quick",
  });
  const staleEvent = recorder
    .events(again.id)
    .find((e) => /no longer matches revision/.test(e.message));
  assert.ok(staleEvent, "the stale pin is announced");
  assert.equal(
    JSON.parse(
      services.db
        .prepare("SELECT target FROM tasks WHERE id = ?")
        .get(created.id).target,
    ).range.revision,
    stored.range.revision,
    "the pin is not silently rewritten",
  );
  await worker.wait(again.id, 20000);
});
