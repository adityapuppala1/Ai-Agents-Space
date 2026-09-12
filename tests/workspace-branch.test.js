import test from "node:test";
import assert from "node:assert/strict";
import { createServices } from "../packages/core/src/services.js";
import { RunRecorder } from "../packages/core/src/runs/RunRecorder.js";

/**
 * Which branch an agent's work is on, and whether it is isolated.
 *
 * Every comparable tool isolates agents in git worktrees, and "which branch
 * is this one on?" is the first thing their users ask. The run has recorded
 * it since the execution layer shipped; the snapshot never passed it on, so
 * nothing could show it.
 */

function setup() {
  const services = createServices({ demo: false });
  const recorder = new RunRecorder(services, { broadcastIntervalMs: 1 });
  const workspace = services.hub.get(
    services.hub.create({ name: "Branches" }).id,
  );
  const agent = workspace.createAgent({
    name: "Claude Code",
    role: "Coding assistant",
  });
  return { services, recorder, workspace, agent };
}

const agentIn = (workspace, agentId) =>
  workspace.snapshot().agents.find((entry) => entry.id === agentId);

test("an agent working in a worktree says which branch, and that it is isolated", () => {
  const { recorder, workspace, agent } = setup();
  const run = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agent.id,
    mode: "managed",
    provider: "claude-code",
    providerSessionId: "s-isolated",
    cwd: "C:/work/wt",
    createTask: { title: "Fix the login redirect" },
  });
  recorder.update(run.id, {
    branch: "agent-space/run-1",
    worktree: "C:/work/data/worktrees/run-1",
  });

  const snapshot = agentIn(workspace, agent.id);
  assert.equal(snapshot.branch, "agent-space/run-1");
  assert.equal(snapshot.isolated, true);
});

test("an agent working in your own tree says the branch, and that it is not isolated", () => {
  const { recorder, workspace, agent } = setup();
  const run = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agent.id,
    mode: "managed",
    provider: "claude-code",
    providerSessionId: "s-inline",
    cwd: "C:/work",
    createTask: { title: "Tidy the readme" },
  });
  recorder.update(run.id, { branch: "main" });

  const snapshot = agentIn(workspace, agent.id);
  assert.equal(snapshot.branch, "main");
  assert.equal(
    snapshot.isolated,
    false,
    "no worktree means the run shares your working tree",
  );
});

test("no branch recorded is null, never a guess at main", () => {
  const { recorder, workspace, agent } = setup();
  recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agent.id,
    mode: "observed",
    provider: "claude-code",
    providerSessionId: "s-none",
    cwd: "C:/work",
    createTask: { title: "Observed session" },
  });
  const snapshot = agentIn(workspace, agent.id);
  assert.equal(snapshot.branch, null);
  assert.equal(snapshot.isolated, false);
});

test("an agent with no run at all carries neither", () => {
  const { workspace, agent } = setup();
  const snapshot = agentIn(workspace, agent.id);
  assert.equal(snapshot.branch, null);
  assert.equal(snapshot.isolated, false);
});
