/**
 * Failure classification and bounded retry policy for managed runs.
 *
 * Honesty rules (docs/ARCHITECTURE.md §0):
 *   - A failure is only called "transport" when the evidence says the
 *     provider never really started (spawn error, no events, no session id).
 *   - A run that may already have edited files or run commands is NEVER
 *     retried automatically. It goes to the decision inbox instead.
 *   - Every automatic retry and every refusal is recorded as a `status`
 *     event so the timeline shows who decided what and why.
 *
 * Nothing here talks to the database; RunWorker feeds it the run's events.
 */

export const FAILURE_CLASSES = [
  "transport",
  "rate-limit",
  "auth",
  "usage-limit",
  "provider-error",
  "user-cancelled",
  "side-effects-possible",
  "unknown",
];

export const SIDE_EFFECT_REVIEW_REASON =
  "the previous attempt may already have changed files; review before retrying";

/** Classes retried automatically unless the workspace policy says otherwise. */
export const DEFAULT_RETRYABLE_CLASSES = Object.freeze([
  "transport",
  "rate-limit",
]);

const AUTH_PATTERN =
  /not logged in|unauthorized|401|Please set an Auth method|Please run \/login|invalid api key|authentication (failed|required)|re-?authenticate/i;
const RATE_LIMIT_PATTERN =
  /rate limit|rate_limit|429|usage limit|quota|premium request|too many requests/i;
const BUDGET_PATTERN =
  /token budget exceeded|budget exceeded|daily (run|token) budget/i;
const CANCEL_PATTERN =
  /cancelled by user|canceled by user|interrupted by user|user cancelled|sigint|turn_aborted/i;
const TRANSPORT_PATTERN =
  /\b(ENOENT|EPIPE|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EACCES|EAGAIN)\b|socket hang up|spawn \S+ (ENOENT|EACCES)|could not start|broken pipe|stream closed unexpectedly/i;

const SIDE_EFFECT_KINDS = new Set([
  "file.edit",
  "file.write",
  "command",
  "test",
]);

/** Events that prove the provider really produced output. */
const PROVIDER_PROGRESS_KINDS = new Set([
  "session.start",
  "turn.start",
  "prompt",
  "message",
  "reasoning",
  "tool.start",
  "tool.end",
  "file.read",
  "file.edit",
  "file.write",
  "search",
  "web",
  "command",
  "test",
  "usage",
  "complete",
]);

function textOf(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value instanceof Error)
    return [value.code, value.message].filter(Boolean).join(" ");
  if (typeof value === "object") {
    const parts = [value.code, value.message, value.error, value.reason]
      .filter((part) => typeof part === "string" || typeof part === "number")
      .map(String);
    return parts.join(" ");
  }
  return String(value);
}

function eventText(event) {
  if (!event || typeof event !== "object") return "";
  const parts = [event.summary, event.message];
  const data = event.data;
  if (data && typeof data === "object") {
    for (const key of ["error", "message", "text", "reason", "output", "type"])
      if (typeof data[key] === "string") parts.push(data[key]);
    if (data.error && typeof data.error === "object")
      parts.push(textOf(data.error));
  }
  return parts.filter(Boolean).join(" ");
}

/**
 * Whether the failing attempt may already have changed something outside
 * Agent Space. `certain` needs a completed edit; anything else that touched
 * the filesystem or the shell is `possible`.
 */
export function sideEffectsOf(events = []) {
  let level = "none";
  for (const event of events ?? []) {
    const kind = event?.kind;
    if (!SIDE_EFFECT_KINDS.has(kind)) continue;
    if (
      (kind === "file.edit" || kind === "file.write") &&
      (event?.data?.applied === true || event?.data?.status === "completed")
    )
      return "certain";
    level = "possible";
  }
  return level;
}

/**
 * classifyFailure({ exitCode, error, events, adapter, sessionId, cancelled,
 *                   spawnError, stderr, timedOut })
 *   → { class, retryable, reason, sideEffects }
 *
 * `retryable` already accounts for side effects: a run that may have written
 * files is never retryable automatically, whatever its class.
 */
export function classifyFailure(input = {}) {
  const {
    exitCode = null,
    error = null,
    events = [],
    adapter = null,
    sessionId = null,
    cancelled = false,
    spawnError = null,
    stderr = [],
    timedOut = false,
    retryableClasses = DEFAULT_RETRYABLE_CLASSES,
  } = input;
  const list = Array.isArray(events) ? events : [];
  const sideEffects = sideEffectsOf(list);
  const haystack = [
    textOf(error),
    textOf(spawnError),
    ...(Array.isArray(stderr) ? stderr.map(String) : [String(stderr ?? "")]),
    ...list.map(eventText),
  ]
    .filter(Boolean)
    .join("\n");
  const providerName = adapter?.name ?? adapter?.id ?? "the provider";
  // Only the provider's own records prove the provider did something: the
  // recorder writes a `system` session.start for every managed run, and that
  // is our bookkeeping, not evidence that a model was reached.
  const fromProvider = list.filter(
    (event) => (event?.provenance ?? "provider") === "provider",
  );
  const sawProviderOutput = fromProvider.some((event) =>
    PROVIDER_PROGRESS_KINDS.has(event?.kind),
  );
  const sawSession =
    !!sessionId ||
    fromProvider.some((event) => event?.kind === "session.start");

  const decide = (className, reason) => {
    const classRetryable =
      retryableClasses.includes(className) && !cancelled && !timedOut;
    return {
      class: className,
      retryable: classRetryable && sideEffects === "none",
      reason,
      sideEffects,
    };
  };

  if (cancelled || CANCEL_PATTERN.test(haystack))
    return decide(
      "user-cancelled",
      "The run was cancelled; side effects already made are not undone.",
    );
  if (timedOut)
    return decide(
      "provider-error",
      `${providerName} was stopped after the policy timeout; it may have been mid-way through its work.`,
    );
  if (BUDGET_PATTERN.test(haystack))
    return decide(
      "usage-limit",
      "A configured budget stopped the run; raise the budget or split the task.",
    );
  if (AUTH_PATTERN.test(haystack))
    return decide(
      "auth",
      `${providerName} is not authenticated; sign in with the provider's own CLI, then run again.`,
    );
  if (RATE_LIMIT_PATTERN.test(haystack))
    return decide(
      "rate-limit",
      `${providerName} reported a rate or usage limit; waiting before another attempt.`,
    );
  // Recorded side effects come FIRST. A run that applied a file edit or ran a
  // command demonstrably reached a model, so it can never be "transport" —
  // whose reason text says in so many words that the request never got there.
  if (sideEffects !== "none")
    return {
      class: "side-effects-possible",
      retryable: false,
      reason: SIDE_EFFECT_REVIEW_REASON,
      sideEffects,
    };
  if (
    spawnError ||
    TRANSPORT_PATTERN.test(haystack) ||
    !sawProviderOutput ||
    !sawSession
  )
    return decide(
      "transport",
      spawnError
        ? `${providerName} could not be started (${textOf(spawnError) || "spawn failed"}).`
        : !sawProviderOutput
          ? `${providerName} exited (code ${exitCode ?? "unknown"}) without producing a single event, so nothing was executed.`
          : !sawSession
            ? `${providerName} exited before it reported a session id, so the request never reached a model.`
            : `${providerName} failed with a transport error.`,
    );
  if (exitCode !== null && exitCode !== 0)
    return decide(
      "provider-error",
      `${providerName} reported an error (exit code ${exitCode}).`,
    );
  return decide(
    "unknown",
    `${providerName} failed for an unrecognized reason.`,
  );
}

/**
 * retryPolicy({ policy, random }) → bounded automatic retry rules.
 *
 * `policy.retry` (workspace policy or per-task executionPolicy) may carry
 * `{ maxAttempts, retryableClasses, allowFallback, fallbackProviders }`.
 * `maxAttempts: 0` disables automatic retries entirely.
 *
 * `random` is injected so tests assert an exact backoff; Math.random is only
 * the default for production code.
 */
export function retryPolicy({ policy = {}, random = Math.random } = {}) {
  const raw = policy?.retry ?? {};
  const maxAttempts =
    Number.isInteger(raw.maxAttempts) && raw.maxAttempts >= 0
      ? raw.maxAttempts
      : 2;
  const retryableClasses = Array.isArray(raw.retryableClasses)
    ? raw.retryableClasses.filter((name) => FAILURE_CLASSES.includes(name))
    : [...DEFAULT_RETRYABLE_CLASSES];
  const allowFallback = raw.allowFallback === true;
  const fallbackProviders = Array.isArray(raw.fallbackProviders)
    ? raw.fallbackProviders.filter((id) => typeof id === "string" && id)
    : [];

  function backoffMs(attempt) {
    const step = Number.isFinite(attempt) && attempt > 0 ? attempt : 1;
    const base = Math.min(30_000, 1000 * 2 ** step);
    // ±20 % jitter so parallel runs do not retry in lockstep.
    const jitter = 0.8 + random() * 0.4;
    return Math.max(0, Math.round(base * jitter));
  }

  /**
   * shouldRetry({ classification, attempt }) → { retry, delayMs, reason }
   * `attempt` is the attempt number that just failed (1-based).
   */
  function shouldRetry({ classification, attempt = 1 } = {}) {
    if (!classification)
      return { retry: false, delayMs: 0, reason: "no failure classification" };
    if (maxAttempts === 0)
      return {
        retry: false,
        delayMs: 0,
        reason: "automatic retries are disabled by the workspace policy",
      };
    if (classification.sideEffects !== "none")
      return {
        retry: false,
        delayMs: 0,
        reason: SIDE_EFFECT_REVIEW_REASON,
      };
    if (!retryableClasses.includes(classification.class))
      return {
        retry: false,
        delayMs: 0,
        reason: `failures classified “${classification.class}” are not retried automatically`,
      };
    if (attempt >= maxAttempts)
      return {
        retry: false,
        delayMs: 0,
        reason: `attempt ${attempt} of ${maxAttempts}: the automatic retry budget is spent`,
      };
    return {
      retry: true,
      delayMs: backoffMs(attempt),
      reason: `attempt ${attempt} of ${maxAttempts} failed (${classification.class})`,
    };
  }

  /**
   * A different provider is only proposed when the policy explicitly permits
   * fallback; otherwise the answer is null and the run waits for a person.
   */
  function fallbackProvider(provider) {
    if (!allowFallback) return null;
    return fallbackProviders.find((id) => id !== provider) ?? null;
  }

  return {
    maxAttempts,
    retryableClasses,
    allowFallback,
    fallbackProviders,
    backoffMs,
    shouldRetry,
    fallbackProvider,
  };
}
