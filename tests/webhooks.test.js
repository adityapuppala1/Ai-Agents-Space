import test from "node:test";
import assert from "node:assert/strict";
import { createServices } from "../packages/core/src/services.js";
import {
  WebhookService,
  signPayload,
  backoffMs,
  sanitizePayload,
  OUTBOUND_EVENTS,
  MAX_ATTEMPTS,
  FRESHNESS_MS,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  EVENT_ID_HEADER,
} from "../packages/core/src/webhooks/WebhookService.js";

const SECRET = "shhh-not-in-the-database";

function setup() {
  const services = createServices({ demo: false, disableObservation: true });
  const audits = [];
  services.audit = { record: (entry) => audits.push(entry) };
  const clock = { now: 1_700_000_000_000 };
  const sent = [];
  const outcomes = [];
  const webhooks = new WebhookService(services, {
    now: () => clock.now,
    resolveSecret: (ref) => (ref === "AGENT_SPACE_TEST_SECRET" ? SECRET : null),
    send: async (request) => {
      sent.push(request);
      return outcomes.shift() ?? { ok: true, status: 200 };
    },
  });
  services.webhooks = webhooks;
  return { services, webhooks, clock, sent, outcomes, audits };
}

function post(webhooks, endpointId, body, { timestamp, secret = SECRET } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return webhooks.receive(endpointId, {
    rawBody: raw,
    headers: {
      [SIGNATURE_HEADER]: signPayload(secret, timestamp, raw),
      [TIMESTAMP_HEADER]: String(timestamp),
    },
  });
}

test("inbound webhooks: good signature, bad signature, replay, and duplicate", () => {
  const { webhooks, clock } = setup();
  const endpoint = webhooks.createEndpoint({
    name: "CI hook",
    direction: "inbound",
    secretRef: "AGENT_SPACE_TEST_SECRET",
  });
  // The secret itself is never exposed by the API.
  assert.equal(endpoint.secretRef, "AGENT_SPACE_TEST_SECRET");
  assert.equal(endpoint.hasSecret, true);
  assert.ok(!JSON.stringify(endpoint).includes(SECRET));

  const good = post(
    webhooks,
    endpoint.id,
    { id: "evt-1", state: "green" },
    {
      timestamp: clock.now,
    },
  );
  assert.equal(good.ok, true);
  assert.equal(good.status, 200);
  assert.equal(good.externalId, "evt-1");

  const bad = webhooks.receive(endpoint.id, {
    rawBody: JSON.stringify({ id: "evt-2" }),
    headers: {
      [SIGNATURE_HEADER]: "sha256=deadbeef",
      [TIMESTAMP_HEADER]: String(clock.now),
    },
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 401);
  assert.match(bad.reason, /signature did not verify/);

  const wrongSecret = post(
    webhooks,
    endpoint.id,
    { id: "evt-3" },
    {
      timestamp: clock.now,
      secret: "guessed",
    },
  );
  assert.equal(wrongSecret.status, 401);

  // Same signed bytes again → replay.
  const replayed = post(
    webhooks,
    endpoint.id,
    { id: "evt-1", state: "green" },
    {
      timestamp: clock.now,
    },
  );
  assert.equal(replayed.status, 409);
  assert.equal(replayed.replay, true);
  assert.match(replayed.reason, /replay/);

  // Same external id, different body → duplicate, not an error.
  const duplicate = post(
    webhooks,
    endpoint.id,
    { id: "evt-1", state: "red" },
    {
      timestamp: clock.now,
    },
  );
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.ok, false);

  // Stale timestamp → outside the replay window.
  const stale = post(
    webhooks,
    endpoint.id,
    { id: "evt-9" },
    {
      timestamp: clock.now - FRESHNESS_MS - 1000,
    },
  );
  assert.equal(stale.status, 409);
  assert.match(stale.reason, /replay window/);

  // Missing headers.
  const bare = webhooks.receive(endpoint.id, {
    rawBody: "{}",
    headers: {},
  });
  assert.equal(bare.status, 400);

  const inbox = webhooks.inbox({ endpointId: endpoint.id });
  assert.ok(inbox.length >= 4);
  assert.equal(inbox.filter((row) => row.signatureOk).length >= 1, true);
  assert.ok(!JSON.stringify(inbox).includes(SECRET));

  // An unknown secret ref cannot be verified, and nothing is guessed.
  const orphan = webhooks.createEndpoint({
    name: "No secret here",
    direction: "inbound",
    secretRef: "MISSING_REF",
  });
  const refused = post(
    webhooks,
    orphan.id,
    { id: "x" },
    {
      timestamp: clock.now,
    },
  );
  assert.equal(refused.status, 503);
  assert.throws(
    () => webhooks.createEndpoint({ name: "no ref", direction: "inbound" }),
    /needs a secretRef/,
  );
});

test("outbound deliveries are signed, sanitized, and bounded by backoff", async () => {
  const { webhooks, clock, sent, outcomes, audits } = setup();
  const endpoint = webhooks.createEndpoint({
    name: "Ops",
    direction: "outbound",
    url: "https://example.invalid/hooks/agent-space",
    secretRef: "AGENT_SPACE_TEST_SECRET",
    events: ["run.completed", "run.failed"],
  });
  assert.throws(
    () =>
      webhooks.createEndpoint({
        name: "bad",
        direction: "outbound",
        url: "https://example.invalid/x",
        events: ["run.exploded"],
      }),
    /Unknown outbound event/,
  );
  assert.deepEqual(OUTBOUND_EVENTS, [
    "run.completed",
    "run.failed",
    "approval.requested",
    "task.review.pending",
    "workflow.completed",
  ]);

  const queued = webhooks.emit("run.completed", {
    runId: "run-1",
    taskId: "task-1",
    workspaceId: "ws-1",
    status: "completed",
    title: "Add a search box",
    prompt: "SECRET PROMPT TEXT",
    diff: "file contents",
  });
  assert.equal(queued.deliveries.length, 1);
  // An event nobody subscribed to creates nothing.
  assert.equal(
    webhooks.emit("run.failed", { runId: "r" }).deliveries.length,
    1,
  );

  const first = await webhooks.attempt(queued.deliveries[0]);
  assert.equal(first.status, "delivered");
  assert.equal(first.attempts, 1);
  const request = sent[0];
  assert.equal(
    request.headers[SIGNATURE_HEADER],
    signPayload(SECRET, clock.now, request.body),
  );
  assert.ok(request.headers[EVENT_ID_HEADER]);
  const body = JSON.parse(request.body);
  assert.equal(body.runId, "run-1");
  assert.equal(body.title, "Add a search box");
  assert.equal(body.prompt, undefined, "prompts are never sent");
  assert.equal(body.diff, undefined, "file contents are never sent");
  assert.ok(!request.body.includes(SECRET));

  // Failures back off exponentially and stop at MAX_ATTEMPTS.
  const failing = webhooks.emit("run.failed", {
    runId: "run-2",
    status: "failed",
  });
  const deliveryId = failing.deliveries[0];
  for (let i = 0; i < MAX_ATTEMPTS + 1; i++)
    outcomes.push({ ok: false, status: 500, error: "HTTP 500" });
  const delays = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const state = await webhooks.attempt(deliveryId);
    assert.equal(state.attempts, attempt);
    if (attempt < MAX_ATTEMPTS) {
      assert.equal(state.status, "pending");
      delays.push(state.nextAttemptAt - clock.now);
      clock.now = state.nextAttemptAt;
    } else {
      assert.equal(state.status, "failed");
      assert.equal(state.nextAttemptAt, null);
    }
  }
  assert.deepEqual(delays, [
    backoffMs(1),
    backoffMs(2),
    backoffMs(3),
    backoffMs(4),
  ]);
  assert.deepEqual(delays, [30000, 60000, 120000, 240000]);
  const stopped = await webhooks.attempt(deliveryId);
  assert.equal(stopped.skipped, "attempt limit reached");
  assert.ok(audits.some((entry) => entry.action === "webhook.delivery.failed"));

  const requeued = webhooks.redeliver(deliveryId);
  assert.equal(requeued.status, "pending");
  assert.equal(requeued.attempts, 0);

  assert.equal(webhooks.deliveries({ endpointId: endpoint.id }).length, 3);
  assert.equal(webhooks.getEndpoint(endpoint.id).failureCount > 0, true);
});

test("due deliveries respect the injected clock and unsigned sends are refused", async () => {
  const { services, clock } = setup();
  const webhooks = new WebhookService(services, {
    now: () => clock.now,
    resolveSecret: () => null,
    send: async () => ({ ok: true, status: 200 }),
  });
  const endpoint = webhooks.createEndpoint({
    name: "Unsigned",
    direction: "outbound",
    url: "http://example.invalid/hook",
    secretRef: "GONE",
    events: ["workflow.completed"],
  });
  const { deliveries } = webhooks.emit("workflow.completed", {
    workflowId: "wf-1",
    status: "completed",
  });
  assert.equal(webhooks.due({}).length, 1);
  const attempted = await webhooks.attempt(deliveries[0]);
  assert.equal(attempted.status, "pending");
  assert.match(attempted.error, /not available/);

  // Not due yet at the current clock.
  assert.equal(webhooks.due({}).length, 0);
  clock.now = attempted.nextAttemptAt;
  assert.equal(webhooks.due({}).length, 1);
  const results = await webhooks.deliverDue({});
  assert.equal(results.length, 1);
  assert.equal(webhooks.getEndpoint(endpoint.id).direction, "outbound");
});

test("payload sanitization keeps ids, statuses and titles only", () => {
  const safe = sanitizePayload({
    runId: "r",
    taskId: "t",
    status: "failed",
    title: "T",
    prompt: "secret",
    cwd: "C:/private",
    token: "abc",
    usage: { input_tokens: 5 },
  });
  assert.deepEqual(safe, {
    runId: "r",
    taskId: "t",
    status: "failed",
    title: "T",
  });
});

test("endpoint CRUD validates direction, url, and events", () => {
  const { webhooks } = setup();
  assert.throws(
    () => webhooks.createEndpoint({ name: "x", direction: "sideways" }),
    /direction must be/,
  );
  assert.throws(
    () => webhooks.createEndpoint({ name: "x", direction: "outbound" }),
    /http\(s\) url/,
  );
  const endpoint = webhooks.createEndpoint({
    name: "Ops",
    direction: "outbound",
    url: "https://example.invalid/hook",
    events: ["approval.requested"],
  });
  const updated = webhooks.updateEndpoint(endpoint.id, { enabled: false });
  assert.equal(updated.enabled, false);
  assert.equal(webhooks.listEndpoints({}).length, 1);
  assert.equal(webhooks.deleteEndpoint(endpoint.id).deleted, true);
  assert.throws(() => webhooks.getEndpoint(endpoint.id), /not found/);
});
