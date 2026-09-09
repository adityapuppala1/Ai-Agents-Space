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
    mode: "observed",
    provider: "copilot",
    providerSessionId: "s3",
    createTask: { title: "Quiet" },
  });
  services.recorder.setStatus(stale.id, "stale");
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
