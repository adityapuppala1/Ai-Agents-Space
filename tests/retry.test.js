import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyFailure,
  retryPolicy,
  sideEffectsOf,
  SIDE_EFFECT_REVIEW_REASON,
  DEFAULT_RETRYABLE_CLASSES,
} from "../packages/core/src/runs/retry.js";
import { RunQueue, parseResetTime } from "../packages/core/src/runs/queue.js";

const adapter = { id: "codex", name: "Codex" };
const session = [
  { kind: "session.start", summary: "session started" },
  { kind: "message", summary: "working" },
];

test("classification table: every failure class from real provider text", () => {
  // 1. Transport: the spawn never produced a process.
  const spawn = classifyFailure({
    exitCode: null,
    spawnError: Object.assign(new Error("spawn claude ENOENT"), {
      code: "ENOENT",
    }),
    events: [],
    adapter,
  });
  assert.equal(spawn.class, "transport");
  assert.equal(spawn.retryable, true);
  assert.equal(spawn.sideEffects, "none");

  // 2. Transport: the provider exited without a single event.
  const silent = classifyFailure({ exitCode: 1, events: [], adapter });
  assert.equal(silent.class, "transport");
  assert.match(silent.reason, /without producing a single event/);

  // 3. Transport: output but no session id yet (exit before the session).
  const noSession = classifyFailure({
    exitCode: 1,
    events: [{ kind: "status", summary: "starting" }],
    adapter,
  });
  assert.equal(noSession.class, "transport");

  // 4. Rate limit: Codex prints exactly this.
  const codexLimit = classifyFailure({
    exitCode: 1,
    error: "You've hit your usage limit. Try again at 11:33 PM.",
    events: session,
    adapter,
  });
  assert.equal(codexLimit.class, "rate-limit");
  assert.equal(codexLimit.retryable, true);

  // 5. Rate limit: Claude's rate_limit_event, and Copilot premium requests.
  assert.equal(
    classifyFailure({
      exitCode: 1,
      events: [
        ...session,
        {
          kind: "status",
          summary: "rate limit reached",
          data: { type: "rate_limit_event", resetsAt: 1893456000 },
        },
      ],
      adapter,
    }).class,
    "rate-limit",
  );
  assert.equal(
    classifyFailure({
      exitCode: 1,
      error: "You have exhausted your premium request allowance",
      events: session,
      adapter,
    }).class,
    "rate-limit",
  );
  assert.equal(
    classifyFailure({
      exitCode: 1,
      error: "HTTP 429",
      events: session,
      adapter,
    }).class,
    "rate-limit",
  );

  // 6. Auth: the verified Gemini CLI message (exit 41, stderr JSON).
  const gemini = classifyFailure({
    exitCode: 41,
    events: [],
    stderr: [
      '{"session_id":"x","error":{"type":"Error","message":"Please set an Auth method in your C:\\\\Users\\\\dev\\\\.gemini\\\\settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA","code":41}}',
    ],
    adapter: { id: "gemini", name: "Gemini CLI" },
  });
  assert.equal(gemini.class, "auth");
  assert.equal(gemini.retryable, false, "re-running will not sign anyone in");
  assert.equal(
    classifyFailure({
      exitCode: 1,
      error: "Not logged in. Please run /login",
      events: session,
      adapter,
    }).class,
    "auth",
  );

  // 7. Our own budget stop.
  assert.equal(
    classifyFailure({
      exitCode: null,
      error: "token budget exceeded",
      events: session,
      adapter,
    }).class,
    "usage-limit",
  );

  // 8. User cancellation.
  const cancelled = classifyFailure({
    exitCode: null,
    cancelled: true,
    events: session,
    adapter,
  });
  assert.equal(cancelled.class, "user-cancelled");
  assert.equal(cancelled.retryable, false);

  // 9. Provider error: it ran, it spoke, it failed.
  const providerError = classifyFailure({
    exitCode: 1,
    error: "Fake failure requested by prompt",
    events: session,
    adapter,
  });
  assert.equal(providerError.class, "provider-error");
  assert.equal(providerError.retryable, false);

  // 10. Side effects beat everything retryable.
  const touched = classifyFailure({
    exitCode: 1,
    error: "socket hang up",
    events: [...session, { kind: "file.edit", file: "a.js", summary: "Edit" }],
    adapter,
  });
  assert.equal(touched.sideEffects, "possible");
  assert.equal(touched.retryable, false);
  assert.equal(
    classifyFailure({
      exitCode: 1,
      events: [
        ...session,
        { kind: "file.edit", data: { applied: true }, summary: "Edit" },
      ],
      adapter,
    }).sideEffects,
    "certain",
  );
  assert.equal(
    sideEffectsOf([{ kind: "command", summary: "npm i" }]),
    "possible",
  );
  assert.equal(sideEffectsOf(session), "none");
  assert.deepEqual([...DEFAULT_RETRYABLE_CLASSES], ["transport", "rate-limit"]);

  // 11. A run that applied a file edit demonstrably reached a model, so it is
  // never "transport" — not even when no session id was ever reported.
  const editedNoSession = classifyFailure({
    exitCode: 1,
    events: [
      { kind: "file.edit", provenance: "provider", data: { applied: true } },
    ],
    sessionId: null,
    adapter: { id: "copilot", name: "Copilot" },
  });
  assert.equal(editedNoSession.class, "side-effects-possible");
  assert.equal(editedNoSession.sideEffects, "certain");
  assert.equal(editedNoSession.retryable, false);
  assert.doesNotMatch(editedNoSession.reason, /never reached a model/);

  // The same holds for a run with no provider output at all but a recorded
  // command: "nothing was executed" would be a false statement.
  const ranCommand = classifyFailure({
    exitCode: 1,
    events: [{ kind: "command", summary: "npm i" }],
    adapter,
  });
  assert.equal(ranCommand.class, "side-effects-possible");
  assert.doesNotMatch(ranCommand.reason, /nothing was executed/);
});

test("retry backoff is bounded, jittered from an injected random, and never retries side effects", () => {
  const rules = retryPolicy({ policy: {}, random: () => 0.5 });
  assert.equal(rules.maxAttempts, 2);
  // 1000 * 2 ** attempt, jitter 0.8 + 0.5 * 0.4 = 1.0
  assert.equal(rules.backoffMs(1), 2000);
  assert.equal(rules.backoffMs(2), 4000);
  assert.equal(rules.backoffMs(10), 30_000, "capped at 30 s");
  assert.equal(retryPolicy({ random: () => 0 }).backoffMs(1), 1600, "-20 %");
  assert.equal(
    retryPolicy({ random: () => 0.999999 }).backoffMs(1),
    2400,
    "+20 %",
  );

  const transport = classifyFailure({ exitCode: 1, events: [], adapter });
  const first = rules.shouldRetry({ classification: transport, attempt: 1 });
  assert.equal(first.retry, true);
  assert.equal(first.delayMs, 2000);
  const spent = rules.shouldRetry({ classification: transport, attempt: 2 });
  assert.equal(spent.retry, false);
  assert.match(spent.reason, /attempt 2 of 2/);

  const withSideEffects = classifyFailure({
    exitCode: 1,
    events: [{ kind: "file.edit", summary: "Edit" }],
    adapter,
  });
  const refused = rules.shouldRetry({
    classification: withSideEffects,
    attempt: 1,
  });
  assert.equal(refused.retry, false);
  assert.equal(refused.reason, SIDE_EFFECT_REVIEW_REASON);

  const disabled = retryPolicy({ policy: { retry: { maxAttempts: 0 } } });
  assert.equal(
    disabled.shouldRetry({ classification: transport, attempt: 1 }).retry,
    false,
  );

  // Fallback to another provider needs explicit policy permission.
  assert.equal(rules.fallbackProvider("codex"), null);
  const withFallback = retryPolicy({
    policy: {
      retry: { allowFallback: true, fallbackProviders: ["codex", "copilot"] },
    },
  });
  assert.equal(withFallback.fallbackProvider("codex"), "copilot");
});

test("circuit breaker opens after consecutive failures, half-opens, and closes on success", () => {
  let now = 1_000_000;
  const queue = new RunQueue({
    now: () => now,
    failureThreshold: 3,
    cooldownMs: 60_000,
  });
  const transport = { class: "transport", reason: "no output" };
  assert.equal(queue.available("codex").ok, true);
  queue.recordFailure("codex", transport, { error: "ENOENT" });
  queue.recordFailure("codex", transport);
  assert.equal(
    queue.available("codex").ok,
    true,
    "two failures is not an outage",
  );
  queue.recordFailure("codex", transport);
  const open = queue.available("codex");
  assert.equal(open.ok, false);
  assert.equal(open.state, "open");
  assert.equal(open.until, now + 60_000);
  assert.equal(queue.providerHealth()[0].consecutiveFailures, 3);
  assert.equal(queue.outage()[0].provider, "codex");

  now += 60_001;
  const half = queue.available("codex");
  assert.equal(half.ok, true, "cooldown passed: one probe is allowed");
  assert.equal(half.state, "half-open");
  queue.beginAttempt("codex");
  assert.equal(queue.available("codex").ok, false, "only one probe at a time");
  queue.recordFailure("codex", transport);
  assert.equal(
    queue.available("codex").state,
    "open",
    "a failed probe re-opens",
  );

  now += 60_001;
  queue.beginAttempt("codex");
  queue.recordSuccess("codex");
  const closed = queue.available("codex");
  assert.equal(closed.ok, true);
  assert.equal(closed.state, "closed");
  assert.equal(queue.outage().length, 0);

  // Auth failures say nothing about provider health.
  queue.recordFailure("gemini", { class: "auth" });
  queue.recordFailure("gemini", { class: "auth" });
  queue.recordFailure("gemini", { class: "auth" });
  assert.equal(queue.available("gemini").ok, true);
});

test("a rate limit parks the provider until the reported reset time", () => {
  let now = Date.parse("2026-09-10T20:00:00Z");
  const queue = new RunQueue({ now: () => now, rateLimitCooldownMs: 900_000 });
  const resetsAt = Math.floor(now / 1000) + 3600;
  queue.recordFailure(
    "claude-code",
    { class: "rate-limit", reason: "rate limit reached" },
    { resetAt: resetsAt },
  );
  const parked = queue.available("claude-code");
  assert.equal(parked.ok, false);
  assert.equal(parked.until, resetsAt * 1000);
  assert.equal(queue.outage()[0].basis, "provider-reported");
  assert.equal(queue.wakeAt(), resetsAt * 1000);
  now = resetsAt * 1000 + 1;
  assert.equal(queue.available("claude-code").ok, true);

  // No reset time given: our own cooldown, labelled as ours.
  queue.recordFailure("codex", { class: "rate-limit" }, {});
  assert.equal(queue.available("codex").until, now + 900_000);
  assert.equal(queue.outage()[0].basis, "best-effort cooldown");
});

test("parseResetTime understands epoch seconds, ISO stamps, and Codex clock text", () => {
  const now = Date.parse("2026-09-10T20:00:00");
  assert.equal(parseResetTime(1893456000, now), 1893456000 * 1000);
  assert.equal(parseResetTime(1893456000000, now), 1893456000000);
  assert.equal(
    parseResetTime("2026-09-10T21:00:00.000Z", now),
    Date.parse("2026-09-10T21:00:00.000Z"),
  );
  const clock = parseResetTime(
    "You've hit your usage limit. Try again at 11:33 PM.",
    now,
  );
  assert.equal(new Date(clock).getHours(), 23);
  assert.equal(new Date(clock).getMinutes(), 33);
  assert.ok(clock > now);
  // A time that already passed today rolls over to tomorrow.
  const morning = parseResetTime("try again at 9:00 AM", now);
  assert.ok(morning > now);
  assert.equal(parseResetTime("in 5 minutes", now), now + 5 * 60_000);
  assert.equal(parseResetTime("soon", now), null);
  assert.equal(parseResetTime(null, now), null);
});

test("round-robin fairness: one busy workspace cannot starve another", () => {
  const queue = new RunQueue({ fairness: "round-robin" });
  for (const runId of ["a1", "a2", "a3"])
    queue.enqueue({ workspaceId: "busy", runId, provider: "codex" });
  queue.enqueue({ workspaceId: "quiet", runId: "b1", provider: "codex" });
  const order = [];
  let entry;
  while ((entry = queue.next())) order.push(entry.runId);
  assert.deepEqual(order, ["a1", "b1", "a2", "a3"]);
  assert.equal(queue.size(), 0);

  // Priority wins inside a workspace; fairness still alternates.
  const second = new RunQueue({});
  second.enqueue({ workspaceId: "w1", runId: "low", priority: 0 });
  second.enqueue({ workspaceId: "w1", runId: "high", priority: 3 });
  second.enqueue({ workspaceId: "w2", runId: "other" });
  assert.deepEqual(
    [second.next().runId, second.next().runId, second.next().runId],
    ["high", "other", "low"],
  );

  // A provider whose breaker is open is skipped, not lost.
  const third = new RunQueue({ failureThreshold: 1, cooldownMs: 10_000 });
  third.enqueue({ workspaceId: "w", runId: "codex-run", provider: "codex" });
  third.enqueue({
    workspaceId: "w",
    runId: "claude-run",
    provider: "claude-code",
  });
  third.recordFailure("codex", { class: "transport" });
  assert.equal(third.next().runId, "claude-run");
  assert.equal(third.next(), null, "the parked provider's run stays queued");
  assert.equal(third.size(), 1);
  assert.equal(third.remove("codex-run").runId, "codex-run");

  // canStart is the caller's admission check (concurrency limits).
  const fourth = new RunQueue({});
  fourth.enqueue({ workspaceId: "w", runId: "r1" });
  assert.equal(fourth.next({ canStart: () => false }), null);
  assert.equal(fourth.has("r1"), true);
});
