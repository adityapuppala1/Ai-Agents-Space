/**
 * Run queue with round-robin fairness, per-provider circuit breakers, and
 * rate-limit parking.
 *
 * Honesty rules (docs/ARCHITECTURE.md §0):
 *   - A breaker only opens on evidence: consecutive failures classified
 *     `transport` or `provider-error` inside a window. Auth failures and
 *     user cancellations never open it, because they are not outages.
 *   - A parked provider carries the reason and, when the provider gave one,
 *     the reset time it reported. When it gave none we say the cooldown is
 *     ours ("best effort"), never that the provider promised it.
 *
 * This module holds no database state; RunWorker owns persistence.
 */

const BREAKER_CLASSES = new Set(["transport", "provider-error"]);

/**
 * parseResetTime(value, now) → epoch ms | null
 *
 * Understands: epoch seconds/ms (Claude `rate_limit_event.resetsAt`), an ISO
 * timestamp, and the human "try again at 11:33 PM" that Codex prints. Anything
 * else returns null so the caller falls back to a fixed cooldown.
 */
export function parseResetTime(value, now = Date.now()) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) return value; // already milliseconds
    if (value > 1e9) return value * 1000; // epoch seconds
    return null;
  }
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d{10}$/.test(text)) return Number(text) * 1000;
  if (/^\d{13}$/.test(text)) return Number(text);
  const iso = Date.parse(text);
  if (!Number.isNaN(iso) && /\d{4}-\d{2}-\d{2}/.test(text)) return iso;
  const clock = text.match(
    /try again (?:at|after)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i,
  );
  if (clock) {
    let hours = Number(clock[1]);
    const minutes = Number(clock[2] ?? 0);
    const meridiem = clock[3]?.toLowerCase();
    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
    const target = new Date(now);
    target.setHours(hours, minutes, 0, 0);
    let stamp = target.getTime();
    if (stamp <= now) stamp += 24 * 60 * 60 * 1000;
    return stamp;
  }
  const relative = text.match(/in\s+(\d+)\s*(second|minute|hour)s?/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const ms =
      unit === "second" ? 1000 : unit === "minute" ? 60_000 : 3_600_000;
    return now + amount * ms;
  }
  return null;
}

export class RunQueue {
  /**
   * new RunQueue({
   *   maxConcurrentPerWorkspace = 2,
   *   fairness = "round-robin",
   *   failureThreshold = 3,      // consecutive failures that open a breaker
   *   windowMs = 5 * 60_000,     // failures older than this stop counting
   *   cooldownMs = 60_000,       // open → half-open
   *   rateLimitCooldownMs = 15 * 60_000, // used when no reset time is given
   *   now = Date.now,
   * })
   */
  constructor(options = {}) {
    this.maxConcurrentPerWorkspace = options.maxConcurrentPerWorkspace ?? 2;
    this.fairness = options.fairness ?? "round-robin";
    this.failureThreshold = options.failureThreshold ?? 3;
    this.windowMs = options.windowMs ?? 5 * 60_000;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.rateLimitCooldownMs = options.rateLimitCooldownMs ?? 15 * 60_000;
    this.now = options.now ?? Date.now;
    this.queues = new Map(); // workspaceId → entry[]
    this.breakers = new Map(); // provider → breaker state
    this.order = []; // workspace ids in round-robin order
    this.cursor = 0;
  }

  // ------------------------------------------------------------- queueing

  enqueue({ workspaceId, runId, priority = 0, provider = null } = {}) {
    if (!runId) throw new Error("enqueue needs a runId");
    const key = workspaceId ?? "";
    const entry = {
      runId,
      workspaceId: key,
      provider,
      priority: Number.isFinite(priority) ? priority : 0,
      enqueuedAt: this.now(),
    };
    const queue = this.queues.get(key) ?? [];
    queue.push(entry);
    // Higher priority first, then first-in-first-out.
    queue.sort(
      (a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt,
    );
    this.queues.set(key, queue);
    if (!this.order.includes(key)) this.order.push(key);
    return entry;
  }

  remove(runId) {
    for (const [key, queue] of this.queues) {
      const index = queue.findIndex((entry) => entry.runId === runId);
      if (index >= 0) {
        const [entry] = queue.splice(index, 1);
        if (!queue.length) this.queues.delete(key);
        return entry;
      }
    }
    return null;
  }

  has(runId) {
    for (const queue of this.queues.values())
      if (queue.some((entry) => entry.runId === runId)) return true;
    return false;
  }

  size(workspaceId = null) {
    if (workspaceId !== null)
      return (this.queues.get(workspaceId) ?? []).length;
    let total = 0;
    for (const queue of this.queues.values()) total += queue.length;
    return total;
  }

  list(workspaceId = null) {
    if (workspaceId !== null) return [...(this.queues.get(workspaceId) ?? [])];
    return [...this.queues.values()].flat();
  }

  /**
   * next({ canStart }) → the next entry that may run, or null.
   *
   * Round-robin across workspaces: the cursor advances past the workspace
   * that was served last, so a workspace with a hundred queued runs can never
   * starve a workspace with one. `canStart(entry)` is the caller's admission
   * check (concurrency, policy); providers whose breaker is open are skipped.
   */
  next({ canStart = () => true } = {}) {
    const keys = this.order.filter(
      (key) => (this.queues.get(key) ?? []).length,
    );
    if (!keys.length) return null;
    const start = this.cursor % keys.length;
    for (let step = 0; step < keys.length; step++) {
      const key = keys[(start + step) % keys.length];
      const queue = this.queues.get(key) ?? [];
      for (const entry of queue) {
        if (entry.provider && !this.available(entry.provider).ok) continue;
        if (!canStart(entry)) continue;
        this.remove(entry.runId);
        this.cursor = (start + step + 1) % Math.max(keys.length, 1);
        return entry;
      }
    }
    return null;
  }

  // ------------------------------------------------------ circuit breakers

  breaker(provider) {
    let state = this.breakers.get(provider);
    if (!state) {
      state = {
        provider,
        state: "closed",
        consecutiveFailures: 0,
        firstFailureAt: null,
        lastFailureAt: null,
        openedAt: null,
        cooldownUntil: null,
        lastError: null,
        parkedUntil: null,
        parkReason: null,
        parkSource: null,
        probeInFlight: false,
      };
      this.breakers.set(provider, state);
    }
    return state;
  }

  /** Moves an open breaker to half-open once its cooldown has passed. */
  #refresh(state, now = this.now()) {
    if (state.parkedUntil && now >= state.parkedUntil) {
      state.parkedUntil = null;
      state.parkReason = null;
      state.parkSource = null;
    }
    if (
      state.state === "open" &&
      state.cooldownUntil !== null &&
      now >= state.cooldownUntil
    ) {
      state.state = "half-open";
      state.probeInFlight = false;
    }
    return state;
  }

  /** available(provider) → { ok, state, until, reason } */
  available(provider) {
    if (!provider)
      return { ok: true, state: "closed", until: null, reason: null };
    const now = this.now();
    const state = this.#refresh(this.breaker(provider), now);
    if (state.parkedUntil && now < state.parkedUntil)
      return {
        ok: false,
        state: state.state,
        until: state.parkedUntil,
        reason: state.parkReason,
      };
    if (state.state === "open")
      return {
        ok: false,
        state: "open",
        until: state.cooldownUntil,
        reason:
          state.lastError ??
          `${provider} failed ${state.consecutiveFailures} times in a row`,
      };
    if (state.state === "half-open" && state.probeInFlight)
      return {
        ok: false,
        state: "half-open",
        until: null,
        reason: `${provider} is being probed by one run before more are started`,
      };
    return { ok: true, state: state.state, until: null, reason: null };
  }

  /** Called when a run for this provider actually starts. */
  beginAttempt(provider) {
    if (!provider) return;
    const state = this.#refresh(this.breaker(provider));
    if (state.state === "half-open") state.probeInFlight = true;
  }

  recordSuccess(provider) {
    if (!provider) return null;
    const state = this.breaker(provider);
    state.state = "closed";
    state.consecutiveFailures = 0;
    state.firstFailureAt = null;
    state.openedAt = null;
    state.cooldownUntil = null;
    state.probeInFlight = false;
    state.lastError = null;
    return state;
  }

  /**
   * recordFailure(provider, classification, { error, resetAt })
   * Only transport/provider-error failures count towards the breaker; a
   * rate limit parks the provider instead (it is a limit, not an outage).
   */
  recordFailure(provider, classification = null, options = {}) {
    if (!provider) return null;
    const now = this.now();
    const state = this.#refresh(this.breaker(provider), now);
    const className =
      typeof classification === "string"
        ? classification
        : (classification?.class ?? "unknown");
    const message =
      options.error ??
      (typeof classification === "object" ? classification?.reason : null) ??
      null;
    state.lastFailureAt = now;
    state.probeInFlight = false;
    if (message) state.lastError = String(message).slice(0, 300);

    if (className === "rate-limit") {
      const until = parseResetTime(options.resetAt, now);
      this.park(provider, {
        until: until ?? now + this.rateLimitCooldownMs,
        reason: message ?? `${provider} reported a rate or usage limit`,
        source: until ? "provider-reported" : "best-effort cooldown",
      });
      return state;
    }
    if (!BREAKER_CLASSES.has(className)) {
      // Auth problems and cancellations say nothing about provider health.
      return state;
    }
    if (
      state.firstFailureAt === null ||
      now - state.firstFailureAt > this.windowMs
    ) {
      state.firstFailureAt = now;
      state.consecutiveFailures = 0;
    }
    state.consecutiveFailures += 1;
    if (
      state.state === "half-open" ||
      state.consecutiveFailures >= this.failureThreshold
    ) {
      state.state = "open";
      state.openedAt = now;
      state.cooldownUntil = now + this.cooldownMs;
      state.probeInFlight = false;
    }
    return state;
  }

  park(
    provider,
    { until, reason = null, source = "best-effort cooldown" } = {},
  ) {
    const state = this.breaker(provider);
    state.parkedUntil = until ?? this.now() + this.rateLimitCooldownMs;
    state.parkReason = reason;
    state.parkSource = source;
    if (reason) state.lastError = String(reason).slice(0, 300);
    return state;
  }

  unpark(provider) {
    const state = this.breaker(provider);
    state.parkedUntil = null;
    state.parkReason = null;
    state.parkSource = null;
    return state;
  }

  /** providerHealth() → one row per provider the queue has seen. */
  providerHealth() {
    const now = this.now();
    return [...this.breakers.values()].map((raw) => {
      const state = this.#refresh(raw, now);
      const parked = !!state.parkedUntil && now < state.parkedUntil;
      return {
        provider: state.provider,
        state: state.state,
        consecutiveFailures: state.consecutiveFailures,
        openedAt: state.openedAt,
        cooldownUntil: state.cooldownUntil,
        lastError: state.lastError,
        parkedUntil: parked ? state.parkedUntil : null,
        parkReason: parked ? state.parkReason : null,
        parkSource: parked ? state.parkSource : null,
        queued: this.list().filter((entry) => entry.provider === state.provider)
          .length,
      };
    });
  }

  /** outage() → what the UI banner should say right now. */
  outage() {
    const now = this.now();
    const rows = [];
    for (const raw of this.breakers.values()) {
      const state = this.#refresh(raw, now);
      if (state.parkedUntil && now < state.parkedUntil)
        rows.push({
          provider: state.provider,
          reason:
            state.parkReason ??
            `${state.provider} reported a rate or usage limit`,
          since: state.lastFailureAt,
          until: state.parkedUntil,
          basis: state.parkSource ?? "best-effort cooldown",
        });
      else if (state.state === "open")
        rows.push({
          provider: state.provider,
          reason:
            state.lastError ??
            `${state.consecutiveFailures} consecutive failures`,
          since: state.openedAt,
          until: state.cooldownUntil,
          basis: "circuit breaker opened by consecutive failures",
        });
      else if (state.state === "half-open")
        rows.push({
          provider: state.provider,
          reason: `${state.provider} is on trial: the next run is a probe`,
          since: state.openedAt,
          until: null,
          basis: "circuit breaker half-open",
        });
    }
    return rows;
  }

  /** Earliest moment a parked/open provider could accept work again. */
  wakeAt() {
    const now = this.now();
    let earliest = null;
    for (const state of this.breakers.values()) {
      for (const stamp of [state.parkedUntil, state.cooldownUntil]) {
        if (!stamp || stamp <= now) continue;
        if (earliest === null || stamp < earliest) earliest = stamp;
      }
    }
    return earliest;
  }

  clear() {
    this.queues.clear();
    this.order = [];
    this.cursor = 0;
  }
}

export function createRunQueue(options = {}) {
  return new RunQueue(options);
}
