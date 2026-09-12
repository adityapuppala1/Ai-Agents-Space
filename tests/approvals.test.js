import test from "node:test";
import assert from "node:assert/strict";
import { createServices } from "../packages/core/src/services.js";
import { RunRecorder } from "../packages/core/src/runs/RunRecorder.js";
import { Settings } from "../packages/core/src/settings/Settings.js";
import { Audit } from "../packages/core/src/audit/Audit.js";
import { Policy } from "../packages/core/src/policy/Policy.js";
import {
  ApprovalService,
  payloadHash,
} from "../packages/core/src/approvals/ApprovalService.js";
import approvalRoutes from "../packages/server/src/routes/approvals.js";

function setup({ now } = {}) {
  let clock = 1_000_000;
  const time = now ?? (() => clock);
  const services = createServices({ demo: false });
  services.settings = new Settings(services.db);
  services.audit = new Audit(services.db, { now: time });
  services.policy = new Policy(services, { now: time });
  services.recorder = new RunRecorder(services, { broadcastIntervalMs: 1 });
  services.approvals = new ApprovalService(services, {
    now: time,
    defaultTtlMs: 60_000,
    sweepMs: 1_000_000,
  });
  const workspace = services.hub.get(
    services.hub.create({ name: "Approvals", rootPath: "C:\\work" }).id,
  );
  const agent = workspace.createAgent({
    name: "Codex",
    role: "Coding assistant",
  });
  const run = services.recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agent.id,
    mode: "managed",
    provider: "codex",
    providerSessionId: "thread-1",
    createTask: { title: "Approve me" },
  });
  const globals = [];
  services.bus.on("global", () => globals.push(1));
  return {
    services,
    workspace,
    agent,
    run,
    globals,
    advance: (ms) => (clock += ms),
  };
}

test("request creates a pending approval bound to a payload hash and records the run event", () => {
  const { services, run, globals } = setup();
  const approval = services.approvals.request({
    runId: run.id,
    kind: "command",
    payload: { command: "git push origin main", token: "secret" },
    reason: "git push needs approval",
    rule: "command.risky.git-push",
    provider: "codex",
    providerRef: "call-1",
  });
  assert.equal(approval.status, "pending");
  assert.equal(approval.workspaceId, run.workspaceId);
  assert.equal(approval.taskId, run.taskId);
  assert.equal(approval.action, "git push origin main");
  assert.equal(approval.payload.token, "[redacted]");
  assert.equal(
    approval.payload._hash,
    payloadHash({ command: "git push origin main", token: "[redacted]" }),
  );
  assert.equal(approval.expiresAt, approval.requestedAt + 60_000);
  assert.ok(globals.length >= 1);
  const updated = services.recorder.get(run.id);
  assert.equal(updated.status, "waiting_approval");
  assert.equal(updated.activity, "WAITING_APPROVAL");
  const events = services.recorder.events(run.id);
  const req = events.find((e) => e.kind === "approval.request");
  assert.ok(req);
  assert.equal(req.data.approvalId, approval.id);
  assert.equal(req.provenance, "system");
  const audit = services.audit.list({
    runId: run.id,
    action: "approval.request",
  });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].policyDecision, "ask");
  assert.equal(audit[0].details.payload.token, "[redacted]");
  assert.throws(
    () => services.approvals.request({ kind: "command", payload: {} }),
    (e) => e.status === 400,
  );
  assert.throws(
    () => services.approvals.request({ runId: "nope", kind: "command" }),
    (e) => e.status === 404,
  );
  assert.throws(
    () => services.approvals.request({ runId: run.id, kind: "weird" }),
    (e) => e.status === 400,
  );
});

test("decide approves once, resolves waiters, returns run to running, audits", async () => {
  const { services, run } = setup();
  const approval = services.approvals.request({
    runId: run.id,
    kind: "command",
    payload: { command: "rm -rf build" },
  });
  const waiting = services.approvals.wait(approval.id, 10_000);
  const decided = services.approvals.decide(approval.id, {
    decision: "approve",
    actor: "alice",
    note: "fine",
  });
  assert.equal(decided.status, "approved");
  assert.equal(decided.decision, "approve");
  assert.equal(decided.decidedBy, "alice");
  assert.ok(decided.decidedAt);
  assert.equal(decided.payload._note, "fine");
  const resolved = await waiting;
  assert.equal(resolved.id, approval.id);
  assert.equal(resolved.status, "approved");
  assert.equal(services.recorder.get(run.id).status, "running");
  const decision = services.recorder
    .events(run.id)
    .find((e) => e.kind === "approval.decision");
  assert.equal(decision.provenance, "user");
  assert.match(decision.message, /Approved by alice/);
  assert.throws(
    () => services.approvals.decide(approval.id, { decision: "deny" }),
    (e) => e.status === 409,
  );
  assert.throws(
    () => services.approvals.decide("missing", { decision: "approve" }),
    (e) => e.status === 404,
  );
  assert.throws(
    () => services.approvals.decide(approval.id, { decision: "maybe" }),
    (e) => e.status === 400,
  );
  assert.equal(
    services.audit.list({ action: "approval.decide" })[0].policyDecision,
    "approve",
  );
  // wait() on an already-decided approval resolves immediately.
  assert.equal(
    (await services.approvals.wait(approval.id, 10)).status,
    "approved",
  );
});

test("deny path and payload binding", async () => {
  const { services, run } = setup();
  const approval = services.approvals.request({
    runId: run.id,
    kind: "file",
    payload: { path: "C:\\work\\a.js" },
  });
  assert.throws(
    () =>
      services.approvals.decide(approval.id, {
        decision: "approve",
        payloadHash: "stale",
      }),
    (e) => e.status === 409 && /changed/.test(e.message),
  );
  assert.equal(services.approvals.get(approval.id).status, "pending");
  const denied = services.approvals.decide(approval.id, {
    decision: "deny",
    actor: "bob",
    payloadHash: approval.payload._hash,
  });
  assert.equal(denied.status, "denied");
  assert.equal((await services.approvals.wait(approval.id)).status, "denied");
});

test("expiry: wait() times out, marks expired, decide → 410, sweep expires stale rows", async () => {
  const { services, run, advance } = setup();
  const approval = services.approvals.request({
    runId: run.id,
    kind: "network",
    payload: { url: "https://x" },
    expiresInMs: 5_000,
  });
  const outcome = await services.approvals.wait(approval.id, 20);
  assert.equal(outcome.status, "expired");
  assert.throws(
    () => services.approvals.decide(approval.id, { decision: "approve" }),
    (e) => e.status === 410,
  );
  assert.ok(
    services.recorder
      .events(run.id)
      .some(
        (e) => e.kind === "approval.decision" && e.data.decision === "expired",
      ),
  );
  assert.equal(services.audit.list({ action: "approval.expire" }).length, 1);

  const second = services.approvals.request({
    runId: run.id,
    kind: "command",
    payload: { command: "x" },
    expiresInMs: 1_000,
  });
  advance(2_000);
  assert.equal(
    services.approvals.pending().length,
    0,
    "listing applies expiry lazily",
  );
  assert.equal(services.approvals.get(second.id).status, "expired");
  const third = services.approvals.request({
    runId: run.id,
    kind: "command",
    payload: { command: "y" },
    expiresInMs: 1_000,
  });
  const waiting = services.approvals.wait(third.id, 60_000);
  advance(5_000);
  assert.equal(services.approvals.expireSweep(), 1);
  assert.equal((await waiting).status, "expired");
  assert.throws(
    () => services.approvals.decide(third.id, { decision: "deny" }),
    (e) => e.status === 410,
  );
  await assert.rejects(
    services.approvals.wait("missing"),
    (e) => e.status === 404,
  );
});

test("cancelForRun cancels pending approvals and releases waiters", async () => {
  const { services, run } = setup();
  const a = services.approvals.request({
    runId: run.id,
    kind: "command",
    payload: { command: "a" },
  });
  const b = services.approvals.request({
    runId: run.id,
    kind: "command",
    payload: { command: "b" },
  });
  const waiting = services.approvals.wait(a.id, 60_000);
  assert.equal(services.approvals.cancelForRun(run.id), 2);
  assert.equal((await waiting).status, "cancelled");
  assert.equal(services.approvals.get(b.id).status, "cancelled");
  assert.equal(services.approvals.listForRun(run.id).length, 2);
  assert.equal(services.approvals.cancelForRun(run.id), 0);
});

test("inbox composes approvals, broken runs, and pending reviews with counts", () => {
  const { services, workspace, run } = setup();
  services.approvals.request({
    runId: run.id,
    kind: "question",
    payload: { question: "Which branch?" },
  });
  const failAgent = workspace.createAgent({
    name: "Codex 2",
    role: "Coding assistant",
  });
  const failed = services.recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: failAgent.id,
    mode: "managed",
    provider: "codex",
    providerSessionId: "thread-2",
    createTask: { title: "Broken" },
  });
  services.recorder.setStatus(failed.id, "failed", { error: "exit 1" });
  const otherAgent = workspace.createAgent({
    name: "Copilot",
    role: "Coding assistant",
  });
  const stale = services.recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: otherAgent.id,
    mode: "managed",
    provider: "copilot",
    providerSessionId: "s3",
    createTask: { title: "Quiet" },
  });
  services.recorder.setStatus(stale.id, "stale");
  // A session the user started in their own terminal is not a decision here:
  // Agent Space cannot retry, cancel or approve it, and an interactive session
  // goes quiet whenever its user steps away. It stays on Live sessions.
  const watcher = workspace.createAgent({
    name: "Claude Code",
    role: "Coding assistant",
  });
  const observed = services.recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: watcher.id,
    mode: "observed",
    provider: "claude-code",
    providerSessionId: "s5",
    createTask: { title: "Terminal session" },
  });
  services.recorder.setStatus(observed.id, "stale");
  const reviewAgent = workspace.createAgent({
    name: "Gemini",
    role: "Coding assistant",
  });
  const reviewed = services.recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: reviewAgent.id,
    mode: "managed",
    provider: "gemini",
    providerSessionId: "s4",
    createTask: { title: "Review me" },
  });
  services.recorder.setStatus(reviewed.id, "completed");
  const inbox = services.approvals.inbox();
  assert.equal(inbox.counts.approvals, 1);
  assert.equal(inbox.counts.questions, 1);
  assert.equal(inbox.questions[0].kind, "question");
  assert.deepEqual(inbox.runs.map((r) => r.status).sort(), ["failed", "stale"]);
  assert.equal(inbox.runs.find((r) => r.status === "failed").error, "exit 1");
  assert.equal(
    inbox.runs.some((r) => r.id === observed.id),
    false,
  );
  assert.equal(inbox.reviews.length, 1);
  assert.equal(inbox.reviews[0].runId, reviewed.id);
  assert.equal(inbox.reviews[0].title, "Review me");
  assert.equal(inbox.counts.total, 4);
  assert.equal(
    services.approvals.inbox({ workspaceId: "demo" }).counts.total,
    0,
  );
});

test("routes: list, get, decide, inbox through the ctx contract", async () => {
  const { services, run } = setup();
  const approval = services.approvals.request({
    runId: run.id,
    kind: "command",
    payload: { command: "git push" },
  });
  const call = async (method, path, input, search = "") => {
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
    const handled = await approvalRoutes(ctx);
    return { handled, ...out };
  };
  const list = await call("GET", "/api/approvals", null, "status=pending");
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 1);
  assert.equal((await call("GET", "/api/inbox")).data.counts.approvals, 1);
  assert.equal(
    (await call("GET", `/api/approvals/${approval.id}`)).data.id,
    approval.id,
  );
  const decided = await call("POST", `/api/approvals/${approval.id}/decide`, {
    decision: "approve",
    note: "ok",
  });
  assert.equal(decided.status, 200);
  assert.equal(decided.data.status, "approved");
  assert.equal(decided.data.decidedBy, "local-user");
  assert.equal((await call("GET", "/api/workspaces/x")).handled, false);
  await assert.rejects(
    call("GET", "/api/approvals/nope"),
    (e) => e.status === 404,
  );
});

test("routes: a declared non-human actor needs mcp.allowDecisions", async () => {
  const { services, run } = setup();
  const call = async (approvalId, input) => {
    let out;
    const ctx = {
      method: "POST",
      path: `/api/approvals/${approvalId}/decide`,
      query: new URLSearchParams(""),
      send: (status, data) => (out = { status, data }),
      body: async () => input,
      services,
      hub: services.hub,
      db: services.db,
      bus: services.bus,
      actor: "local-user",
    };
    await approvalRoutes(ctx);
    return out;
  };
  const make = () =>
    services.approvals.request({
      runId: run.id,
      kind: "command",
      payload: { command: "git push" },
    });

  // The MCP tool refuses this in the client process; the server has to refuse
  // it too, or plain curl decides the approval the gate was meant to protect.
  const gated = make();
  await assert.rejects(
    () => call(gated.id, { decision: "approve", actor: "mcp" }),
    (error) =>
      error.status === 403 && /mcp\.allowDecisions/.test(error.message),
  );
  assert.equal(services.approvals.get(gated.id).status, "pending");

  // A person deciding is untouched by the gate.
  const human = make();
  assert.equal(
    (await call(human.id, { decision: "approve" })).data.status,
    "approved",
  );

  services.settings.set("mcp.allowDecisions", true);
  const allowed = make();
  const decided = await call(allowed.id, { decision: "approve", actor: "mcp" });
  assert.equal(decided.data.status, "approved");
  assert.equal(decided.data.decidedBy, "local-user:mcp");

  // Control characters in the actor never reach the audit log, whose hash
  // chain and CSV export both treat the field as plain text.
  const clean = make();
  const messy = await call(clean.id, {
    decision: "approve",
    actor: "mcp\napproval.decide",
  });
  assert.ok(!messy.data.decidedBy.includes("\n"));
});

test("urgency ranks blocking, risky, old, high-priority approvals first", () => {
  const { services, workspace, run, advance } = setup();
  // A low-urgency question on a run that is not blocked.
  const other = workspace.createAgent({
    name: "Idle",
    role: "Coding assistant",
  });
  const idleRun = services.recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: other.id,
    mode: "observed",
    provider: "copilot",
    providerSessionId: "s-idle",
    createTask: { title: "Quiet work", priority: "low" },
  });
  services.recorder.setStatus(idleRun.id, "completed");
  const question = services.approvals.request({
    runId: idleRun.id,
    kind: "question",
    payload: { question: "Which branch?" },
  });
  assert.equal(services.approvals.urgency(question).level, "normal");

  // A risky command blocking a live run whose task is critical.
  services.db
    .prepare("UPDATE tasks SET priority = 'critical' WHERE id = ?")
    .run(run.taskId);
  const risky = services.approvals.request({
    runId: run.id,
    kind: "command",
    payload: { command: "git push origin main" },
    rule: "command.risky.git-push",
    reason: "push needs approval",
  });
  const urgency = services.approvals.urgency(risky);
  assert.equal(urgency.level, "critical");
  assert.equal(urgency.blocking, true);
  assert.equal(urgency.risk, "high");
  assert.equal(urgency.taskPriority, "critical");
  assert.match(urgency.reason, /blocks a waiting_approval run/);

  const inbox = services.approvals.inbox();
  assert.equal(inbox.approvals[0].id, risky.id, "most urgent first");
  assert.equal(inbox.approvals[0].urgency.level, "critical");
  assert.equal(inbox.approvals[0].proposedAction.type, "command");
  assert.equal(
    inbox.approvals[0].proposedAction.command,
    "git push origin main",
  );
  assert.ok(
    inbox.approvals[0].affectedResources.some(
      (r) => r.type === "run" && r.value === run.id,
    ),
  );
  assert.equal(inbox.urgencyCounts.critical, 1);
  assert.equal(inbox.approvals.at(-1).id, question.id);

  // Age alone lifts a plain approval.
  advance(45 * 60 * 1000);
  assert.notEqual(services.approvals.urgency(question).level, "critical");
  assert.ok(services.approvals.urgency(question).ageMs >= 45 * 60 * 1000);
});

test("request-change records the decision, keeps the run waiting, and reaches the inbox", () => {
  const { services, run } = setup();
  const approval = services.approvals.request({
    runId: run.id,
    kind: "file",
    payload: { path: "C:\work\app.js", diff: "--- a\n+++ b\n+one\n-two\n" },
  });
  assert.equal(services.recorder.get(run.id).status, "waiting_approval");
  const outcome = services.approvals.decide(approval.id, {
    decision: "request-change",
    actor: "alice",
    note: "scope it to one file",
  });
  assert.equal(outcome.status, "pending", "the approval is still open");
  assert.equal(outcome.stillWaiting, true);
  assert.equal(outcome.changeRequests.length, 1);
  assert.equal(outcome.changeRequests[0].actor, "alice");
  assert.equal(
    services.recorder.get(run.id).status,
    "waiting_approval",
    "the run is not resumed",
  );
  assert.ok(
    !services.recorder
      .events(run.id)
      .some(
        (e) =>
          e.kind === "approval.decision" &&
          e.data?.decision === "request-change",
      ),
    "a change request is not an approval.decision",
  );
  const row = services.db
    .prepare(
      "SELECT * FROM decision_history WHERE approval_id = ? ORDER BY created_at",
    )
    .all(approval.id);
  assert.equal(row.length, 1);
  assert.equal(row[0].decision, "request-change");
  assert.equal(row[0].actor, "alice");

  const inbox = services.approvals.inbox();
  assert.equal(inbox.urgencyCounts.changeRequests, 1);
  assert.deepEqual(Object.keys(inbox.counts).sort(), [
    "approvals",
    "questions",
    "reviews",
    "runs",
    "total",
  ]);
  assert.equal(inbox.changeRequests[0].note, "scope it to one file");
  assert.equal(inbox.approvals[0].proposedAction.type, "diff");
  assert.equal(inbox.approvals[0].proposedAction.diffSummary.added, 1);
  assert.equal(inbox.approvals[0].proposedAction.diffSummary.removed, 1);

  // Approve still works afterwards and resumes the run.
  const approved = services.approvals.decide(approval.id, {
    decision: "approve",
    actor: "alice",
  });
  assert.equal(approved.status, "approved");
  assert.equal(services.recorder.get(run.id).status, "running");
  assert.equal(services.approvals.inbox().urgencyCounts.changeRequests, 0);
  assert.throws(
    () =>
      services.approvals.decide(approval.id, { decision: "request-change" }),
    (e) => e.status === 409,
  );
});

/* ---------- roadmap section 11: dual approval and escalation ---------- */

test("dual approval: two distinct actors resolve, the same actor twice is refused, wait() resolves only after the second", async () => {
  const { services, workspace, run, globals } = setup();
  services.policy.setForWorkspace(workspace.id, {
    dualApprovalFor: ["command"],
  });
  const approval = services.approvals.request({
    runId: run.id,
    kind: "command",
    payload: { command: "git push origin main" },
    rule: "command.risky.git-push",
  });
  assert.equal(approval.requiredDecisions, 2);
  assert.equal(approval.awaitingSecondApprover, false);
  assert.ok(
    services.recorder
      .events(run.id)
      .some((e) => /2 distinct approvers required/.test(e.message)),
  );
  let resolved = null;
  const waiting = services.approvals
    .wait(approval.id, 60_000)
    .then((a) => (resolved = a));

  const first = services.approvals.decide(approval.id, {
    decision: "approve",
    actor: "alice",
    note: "looks fine",
  });
  assert.equal(first.status, "pending");
  assert.equal(first.awaitingSecondApprover, true);
  assert.equal(first.state, "awaiting second approver");
  assert.equal(first.approvalsRecorded, 1);
  assert.equal(first.decisions.length, 1);
  assert.equal(first.decisions[0].actor, "alice");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(resolved, null, "wait() must not resolve after one approval");
  assert.equal(services.recorder.get(run.id).status, "waiting_approval");
  const partial = services.recorder
    .events(run.id)
    .find((e) => /awaiting second approver/.test(e.message));
  assert.ok(partial);
  assert.equal(partial.kind, "status");
  assert.equal(partial.provenance, "user");
  assert.equal(partial.data.stillWaiting, true);

  // The inbox and GET /decisions say a second approver is needed.
  const inbox = services.approvals.inbox({ workspaceId: workspace.id });
  assert.equal(inbox.approvals[0].awaitingSecondApprover, true);
  assert.equal(inbox.approvals[0].escalated, false);
  assert.deepEqual(inbox.awaitingSecondApprover, [approval.id]);
  assert.equal(inbox.urgencyCounts.awaitingSecondApprover, 1);
  const decisions = services.approvals.decisions(approval.id);
  assert.equal(decisions.awaitingSecondApprover, true);
  assert.equal(decisions.requiredDecisions, 2);
  assert.equal(decisions.decisions[0].decision, "approve");

  // The same actor deciding twice is refused with 409.
  assert.throws(
    () =>
      services.approvals.decide(approval.id, {
        decision: "approve",
        actor: "alice",
      }),
    (e) => e.status === 409 && /distinct approver/.test(e.message),
  );
  assert.equal(services.approvals.get(approval.id).status, "pending");

  const second = services.approvals.decide(approval.id, {
    decision: "approve",
    actor: "bob",
  });
  assert.equal(second.status, "approved");
  assert.equal(second.awaitingSecondApprover, false);
  assert.equal(second.decidedBy, "alice, bob");
  assert.equal(second.decisions.length, 2);
  await waiting;
  assert.equal(resolved.status, "approved");
  assert.equal(services.recorder.get(run.id).status, "running");
  const final = services.recorder
    .events(run.id)
    .find((e) => e.kind === "approval.decision");
  assert.deepEqual(final.data.approvers, ["alice", "bob"]);
  assert.match(final.message, /Approved by alice, bob/);
  const audits = services.audit.list({ action: "approval.decide" });
  assert.equal(audits.length, 2);
  assert.equal(audits.find((a) => a.details.partial)?.actor, "alice");
  assert.ok(globals.length >= 3);
  // GET /api/approvals/:id/decisions through the route contract.
  let out;
  const handled = await approvalRoutes({
    method: "GET",
    path: `/api/approvals/${approval.id}/decisions`,
    query: new URLSearchParams(),
    send: (status, data) => (out = { status, data }),
    body: async () => null,
    services,
    hub: services.hub,
    db: services.db,
    bus: services.bus,
    actor: "local-user",
  });
  assert.equal(handled, true);
  assert.equal(out.status, 200);
  assert.equal(out.data.approvalId, approval.id);
  assert.equal(out.data.decisions.length, 2);
  assert.equal(out.data.status, "approved");
});

test("dual approval: one deny resolves the approval as denied immediately; rule ids select it too", async () => {
  const { services, workspace, run } = setup();
  services.policy.setForWorkspace(workspace.id, {
    dualApprovalFor: ["command.risky.git-push"],
  });
  const plain = services.approvals.request({
    runId: run.id,
    kind: "command",
    payload: { command: "ls" },
    rule: "command.allowed",
  });
  assert.equal(plain.requiredDecisions, 1, "rule not listed: single approval");
  services.approvals.decide(plain.id, { decision: "approve" });

  const approval = services.approvals.request({
    runId: run.id,
    kind: "command",
    payload: { command: "git push" },
    rule: "command.risky.git-push",
  });
  assert.equal(approval.requiredDecisions, 2);
  const waiting = services.approvals.wait(approval.id, 60_000);
  services.approvals.decide(approval.id, {
    decision: "approve",
    actor: "alice",
  });
  const denied = services.approvals.decide(approval.id, {
    decision: "deny",
    actor: "bob",
    note: "not today",
  });
  assert.equal(denied.status, "denied");
  assert.equal(denied.decidedBy, "bob");
  assert.equal(denied.decisions.length, 2);
  assert.equal((await waiting).status, "denied");
  assert.throws(
    () => services.approvals.decide(approval.id, { decision: "approve" }),
    (e) => e.status === 409,
  );
  // A deny as the very first decision resolves too.
  const another = services.approvals.request({
    runId: run.id,
    kind: "command",
    payload: { command: "git push --force" },
    rule: "command.risky.git-push",
  });
  const firstDeny = services.approvals.decide(another.id, {
    decision: "deny",
    actor: "carol",
  });
  assert.equal(firstDeny.status, "denied");
  assert.equal((await services.approvals.wait(another.id)).status, "denied");
});

test("escalation sweep marks old pending approvals with an injected clock", async () => {
  const { services, workspace, run, advance, globals } = setup();
  services.policy.setForWorkspace(workspace.id, {
    escalateAfterMs: 5 * 60 * 1000,
    escalationReviewer: "human",
  });
  const approval = services.approvals.request({
    runId: run.id,
    kind: "network",
    payload: { url: "https://example.com" },
    expiresInMs: 60 * 60 * 1000,
  });
  assert.equal(services.approvals.escalationSweep(), 0, "not old enough yet");
  advance(4 * 60 * 1000);
  assert.equal(services.approvals.escalationSweep(), 0);
  advance(2 * 60 * 1000);
  const before = globals.length;
  assert.equal(services.approvals.escalationSweep(), 1);
  assert.ok(globals.length > before, "bus global emitted");
  const escalated = services.approvals.get(approval.id);
  assert.equal(escalated.status, "pending");
  assert.equal(escalated.escalated, true);
  assert.equal(escalated.escalationLevel, 1);
  assert.ok(escalated.escalatedAt);
  assert.equal(escalated.escalationReviewer, "human");
  const urgency = services.approvals.urgency(escalated);
  assert.equal(urgency.level, "critical");
  assert.equal(urgency.escalated, true);
  const event = services.recorder
    .events(run.id)
    .find((e) => /Approval escalated \(level 1\)/.test(e.message));
  assert.ok(event);
  assert.equal(event.kind, "status");
  assert.equal(event.provenance, "system");
  assert.equal(event.data.escalationReviewer, "human");
  assert.match(event.message, /escalated to human/);
  const audit = services.audit.list({ action: "approval.escalate" });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].policyDecision, "escalated");
  assert.equal(audit[0].details.escalationLevel, 1);
  // Inbox reports it and ranks it first.
  services.approvals.request({
    runId: run.id,
    kind: "question",
    payload: { question: "later?" },
    expiresInMs: 60 * 60 * 1000,
  });
  const inbox = services.approvals.inbox({ workspaceId: workspace.id });
  assert.equal(inbox.approvals[0].id, approval.id);
  assert.equal(inbox.approvals[0].escalated, true);
  assert.equal(inbox.approvals[0].urgency.level, "critical");
  assert.deepEqual(inbox.escalated, [approval.id]);
  assert.equal(inbox.urgencyCounts.escalated, 1);
  // Not re-escalated until another escalateAfterMs passes; then level 2.
  assert.equal(services.approvals.escalationSweep(), 0);
  advance(5 * 60 * 1000);
  const swept = services.approvals.sweep();
  assert.equal(swept.escalated, 2, "the question is now old enough as well");
  assert.equal(services.approvals.get(approval.id).escalationLevel, 2);
  // Decisions still work on an escalated approval and clear it from the inbox.
  const decided = services.approvals.decide(approval.id, {
    decision: "approve",
  });
  assert.equal(decided.status, "approved");
  assert.equal(decided.escalationLevel, 2);
  assert.equal(
    services.approvals.escalationSweep(),
    0,
    "decided rows are skipped",
  );
  await services.approvals.wait(approval.id, 10);
});

test("escalation defaults to 30 minutes without a policy engine", () => {
  const { services, run, advance } = setup();
  services.policy = null;
  const approval = services.approvals.request({
    runId: run.id,
    kind: "command",
    payload: { command: "x" },
    expiresInMs: 2 * 60 * 60 * 1000,
  });
  assert.equal(approval.requiredDecisions, 1);
  advance(29 * 60 * 1000);
  assert.equal(services.approvals.escalationSweep(), 0);
  advance(2 * 60 * 1000);
  assert.equal(services.approvals.escalationSweep(), 1);
  assert.equal(services.approvals.get(approval.id).escalationReviewer, null);
});
