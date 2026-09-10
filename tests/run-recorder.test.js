import test from "node:test";
import assert from "node:assert/strict";
import { createServices } from "../packages/core/src/services.js";
import { RunRecorder } from "../packages/core/src/runs/RunRecorder.js";
import { classifyTool } from "../packages/core/src/contracts.js";

function setup() {
  const services = createServices({ demo: false });
  const recorder = new RunRecorder(services, { broadcastIntervalMs: 1 });
  const workspace = services.hub.get(
    services.hub.create({ name: "Recorder" }).id,
  );
  const agent = workspace.createAgent({
    name: "Claude Code",
    role: "Coding assistant",
  });
  return { services, recorder, workspace, agent };
}

test("ensureRun creates a task and run once per provider session and dedups events", () => {
  const { recorder, workspace, agent } = setup();
  const run = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agent.id,
    mode: "observed",
    provider: "claude-code",
    providerSessionId: "abc",
    cwd: "C:/work",
    createTask: { title: "Observed prompt" },
  });
  assert.equal(run.mode, "observed");
  assert.equal(run.status, "running");
  const again = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agent.id,
    mode: "observed",
    provider: "claude-code",
    providerSessionId: "abc",
    createTask: { title: "ignored" },
  });
  assert.equal(again.id, run.id);
  assert.equal(workspace.snapshot().tasks.length, 1);
  assert.equal(workspace.snapshot().tasks[0].source, "observed");
  assert.equal(
    workspace.snapshot().agents.find((a) => a.id === agent.id).taskId,
    run.taskId,
  );

  const first = recorder.applyEvent(run.id, {
    providerEventId: "e1",
    kind: "tool.start",
    tool: "Edit",
    file: "C:/work/app.js",
    summary: "Editing app.js",
    model: "claude-fable-5-1",
    usage: { input_tokens: 10, output_tokens: 5 },
    timestamp: 1000,
  });
  assert.ok(first);
  assert.equal(
    recorder.applyEvent(run.id, {
      providerEventId: "e1",
      kind: "tool.start",
      summary: "dup",
    }),
    null,
  );
  let updated = recorder.get(run.id);
  assert.equal(updated.activity, "CODING");
  assert.equal(updated.currentFile, "C:/work/app.js");
  assert.equal(updated.actualModel, "claude-fable-5-1");
  assert.equal(updated.usage.input_tokens, 10);
  recorder.applyEvent(run.id, {
    kind: "usage",
    summary: "usage",
    usage: { input_tokens: 5 },
  });
  assert.equal(recorder.get(run.id).usage.input_tokens, 15);
  recorder.applyEvent(run.id, {
    kind: "tool.start",
    tool: "Bash",
    data: { command: "npm test" },
    summary: "npm test",
  });
  assert.equal(recorder.get(run.id).activity, "TESTING");
  recorder.applyEvent(run.id, {
    kind: "approval.request",
    summary: "Approve git push?",
  });
  assert.equal(recorder.get(run.id).status, "waiting_approval");
  recorder.applyEvent(run.id, {
    kind: "approval.decision",
    summary: "Approved",
  });
  assert.equal(recorder.get(run.id).status, "running");
  const events = recorder.events(run.id);
  assert.ok(events.length >= 5);
  assert.equal(events[0].kind, "session.start");
  assert.equal(events[1].provenance, "provider");

  recorder.setStatus(run.id, "stale");
  assert.equal(recorder.get(run.id).activity, "STALE");
  recorder.applyEvent(run.id, { kind: "message", summary: "back" });
  assert.equal(recorder.get(run.id).status, "running");
  recorder.setStatus(run.id, "completed");
  updated = recorder.get(run.id);
  assert.equal(updated.status, "completed");
  assert.ok(updated.endedAt);
  assert.equal(workspace.snapshot().tasks[0].status, "COMPLETED");
  assert.equal(
    workspace.snapshot().agents.find((a) => a.id === agent.id).state,
    "IDLE",
  );
});

test("managed run completion leaves the task for review and failures block it", () => {
  const { recorder, workspace, agent } = setup();
  const task = workspace.create({ title: "Managed work" });
  const run = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agent.id,
    mode: "managed",
    provider: "copilot",
    taskId: task.id,
    prompt: "do it",
  });
  assert.equal(workspace.snapshot().tasks[0].status, "IN_PROGRESS");
  recorder.addArtifact(run.id, {
    kind: "diff",
    title: "Patch",
    content: "diff --git a b",
  });
  assert.equal(recorder.artifacts(run.id).length, 1);
  assert.equal(recorder.artifacts(run.id)[0].content, undefined);
  assert.equal(
    recorder.artifacts(run.id, { withContent: true })[0].content,
    "diff --git a b",
  );
  recorder.setStatus(run.id, "completed", { summary: "Done" });
  assert.equal(workspace.snapshot().tasks[0].status, "IN_PROGRESS");
  const review = JSON.parse(
    workspace.db.prepare("SELECT review FROM tasks WHERE id = ?").get(task.id)
      .review,
  );
  assert.equal(review.runId, run.id);

  const second = workspace.create({ title: "Failing work" });
  const agent2 = workspace.createAgent({
    name: "Codex",
    role: "Coding assistant",
  });
  const run2 = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agent2.id,
    mode: "managed",
    provider: "codex",
    taskId: second.id,
  });
  recorder.setStatus(run2.id, "failed", { error: "usage limit", exitCode: 1 });
  assert.equal(workspace.store.get(second.id).status, "BLOCKED");
  assert.equal(recorder.get(run2.id).error, "usage limit");
  assert.throws(
    () =>
      recorder.ensureRun({
        workspaceId: workspace.id,
        agentId: agent.id,
        mode: "managed",
        provider: "codex",
        createTask: { title: "busy agent" },
      }),
    /already working/,
  );
  assert.equal(recorder.active().length, 0);
});

test("reading a file whose name contains test is not reported as testing", () => {
  // Truthfulness: the activity shown in the office is inferred from the tool
  // call, so it must not claim a test ran when a file was merely read.
  assert.equal(
    classifyTool("Bash", { command: "sed -n '1,40p' tests/office.test.js" }),
    "COMMANDING",
  );
  assert.equal(
    classifyTool("Bash", { command: "grep -n TESTING tests/run.test.js" }),
    "RESEARCHING",
  );
  for (const command of [
    "npm test",
    "npm run test:ui",
    "node --test tests/office.test.js",
    "npx playwright test",
    "pytest -q",
    "go test ./...",
    "cargo test",
  ])
    assert.equal(
      classifyTool("Bash", { command }),
      "TESTING",
      `${command} is a test run`,
    );
});
