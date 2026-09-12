/**
 * Signed webhooks in both directions (roadmap §10, "Webhooks / HTTP: signed
 * requests, deduplication, replay protection, bounded retries").
 *
 * Inbound  — POST /api/webhooks/:endpointId with an HMAC-SHA256 signature
 *            over `${timestamp}.${rawBody}`. A request is accepted only when
 *            the signature verifies, the timestamp is inside the freshness
 *            window, the signature/payload has not been seen before, and the
 *            external id is new. Everything received is recorded in
 *            `webhook_inbox` with the verdict.
 * Outbound — the same signature over the same string, exponential backoff,
 *            at most 5 attempts, every attempt written to
 *            `webhook_deliveries`.
 *
 * Secrets: `secret_ref` NAMES the ENVIRONMENT VARIABLE the shared secret
 * lives in. It is deliberately not resolvable from the settings table: those
 * are readable over HTTP. The secret itself is never stored by this module,
 * never returned by any API, never logged, and never included in an event.
 *
 * Payloads: ids, statuses, titles and timestamps only. Prompts, file
 * contents, tokens and credentials are never sent.
 */

import {
  createHmac,
  randomUUID,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { InputError } from "../TaskStore.js";
import {
  assertDeliverable,
  guardedLookup,
  privateTargetsAllowed,
} from "./target.js";

export const DIRECTIONS = ["inbound", "outbound"];

/** Events Agent Space will send outbound. Nothing else is ever delivered. */
export const OUTBOUND_EVENTS = [
  "run.completed",
  "run.failed",
  "approval.requested",
  "task.review.pending",
  "workflow.completed",
];

export const SIGNATURE_HEADER = "x-agent-space-signature";
export const TIMESTAMP_HEADER = "x-agent-space-timestamp";
export const EVENT_ID_HEADER = "x-agent-space-event-id";
export const EVENT_HEADER = "x-agent-space-event";

/** A signed request older (or newer) than this is refused as a replay. */
export const FRESHNESS_MS = 5 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const BACKOFF_BASE_MS = 30 * 1000;

export function signPayload(secret, timestamp, rawBody) {
  return `sha256=${createHmac("sha256", String(secret))
    .update(`${timestamp}.${String(rawBody)}`)
    .digest("hex")}`;
}

export function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a ?? ""));
  const right = Buffer.from(String(b ?? ""));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function payloadHash(rawBody) {
  return createHash("sha256")
    .update(String(rawBody ?? ""))
    .digest("hex");
}

/** Delay before attempt N (1-based): 30s, 60s, 120s, 240s. */
export function backoffMs(attempt, base = BACKOFF_BASE_MS) {
  return base * 2 ** Math.max(0, attempt - 1);
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function rowToEndpoint(row) {
  return {
    id: row.id,
    name: row.name,
    direction: row.direction,
    url: row.url ?? null,
    // The ref is the NAME of a secret, never the secret.
    secretRef: row.secret_ref ?? null,
    hasSecret: !!row.secret_ref,
    events: parseJson(row.events, []),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    lastDeliveryAt: row.last_delivery_at ?? null,
    failureCount: row.failure_count ?? 0,
  };
}

function rowToDelivery(row) {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    eventId: row.event_id,
    event: row.event ?? "",
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at ?? null,
    responseCode: row.response_code ?? null,
    error: row.error ?? null,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at ?? null,
    payload: parseJson(row.payload, {}),
  };
}

/** Default HTTPS/HTTP sender using node built-ins. Injected in tests. */
export function defaultSend({
  url,
  headers,
  body,
  timeoutMs = 10000,
  allowPrivate,
}) {
  return new Promise((resolve) => {
    // Checked again here, not only when the endpoint was stored: the rule
    // depends on how this process is bound, and an endpoint saved by a
    // loopback-bound server is still in the table when it is next started
    // with HOST set.
    const permitted = allowPrivate ?? privateTargetsAllowed();
    let target;
    try {
      target = assertDeliverable(url, { allowPrivate: permitted });
    } catch (error) {
      resolve({ ok: false, status: 0, error: error.message });
      return;
    }
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(
      target,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...headers,
        },
        timeout: timeoutMs,
        // A literal address was judged above; this judges what a *name*
        // resolves to, which is the other half of the same rule.
        lookup: guardedLookup({ allowPrivate: permitted }),
      },
      (res) => {
        res.resume();
        // Without this, an error emitted on the RESPONSE stream after headers
        // arrive (a peer reset mid-body, a TLS failure during transfer) has no
        // listener, and Node rethrows it as an uncaught exception that takes
        // the whole server down.
        res.on("error", (error) =>
          resolve({
            ok: false,
            status: res.statusCode ?? 0,
            error: error.message,
          }),
        );
        res.on("end", () =>
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            error:
              res.statusCode >= 200 && res.statusCode < 300
                ? null
                : `HTTP ${res.statusCode}`,
          }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) =>
      resolve({ ok: false, status: 0, error: error.message }),
    );
    req.end(body);
  });
}

/**
 * WebhookService.
 *
 * `new WebhookService(services, { now, send, resolveSecret })`
 *  - now           clock (ms) — injected by tests to exercise backoff
 *  - send          transport ({url, headers, body}) → {ok, status, error}
 *  - resolveSecret (secretRef) → string | null
 */
export class WebhookService {
  constructor(
    services,
    { now = Date.now, send = defaultSend, resolveSecret, allowPrivateTargets } = {},
  ) {
    this.services = services;
    this.db = services.db;
    this.now = now;
    this.send = send;
    // Whether this process may deliver to loopback and private addresses. See
    // webhooks/target.js — it follows how the server is bound.
    this.allowPrivateTargets =
      allowPrivateTargets ?? privateTargetsAllowed(services.env ?? process.env);
    this.resolveSecret =
      resolveSecret ?? ((ref) => this.#defaultResolveSecret(ref));
  }

  /**
   * A shared secret is read from the environment only. It deliberately does
   * NOT fall back to the settings table: settings are reachable over HTTP and
   * through the MCP bridge, so a secret stored there would be readable by
   * anyone who can call the API (ARCHITECTURE.md §0 rule 4). Nothing here
   * writes a secret anywhere, and the value never leaves this method.
   */
  #defaultResolveSecret(ref) {
    if (!ref) return null;
    const env = this.services.env ?? process.env;
    return env[ref] ? String(env[ref]) : null;
  }

  /* ---------------------------- endpoints ---------------------------- */

  createEndpoint({
    name,
    direction = "outbound",
    url = null,
    secretRef = null,
    events = [],
    enabled = true,
    actor = "local-user",
  } = {}) {
    if (typeof name !== "string" || !name.trim() || name.length > 120)
      throw new InputError("name must be 1–120 characters");
    if (!DIRECTIONS.includes(direction))
      throw new InputError(`direction must be one of ${DIRECTIONS.join(", ")}`);
    if (direction === "outbound") {
      if (typeof url !== "string" || !/^https?:\/\//i.test(url))
        throw new InputError("An outbound endpoint needs an http(s) url");
      // Say no here rather than storing an endpoint whose every delivery will
      // fail, so the reason lands on the form the person is filling in.
      assertDeliverable(url, { allowPrivate: this.allowPrivateTargets });
    }
    if (!Array.isArray(events) || events.some((e) => typeof e !== "string"))
      throw new InputError("events must be an array of strings");
    const unknown = events.filter(
      (event) => direction === "outbound" && !OUTBOUND_EVENTS.includes(event),
    );
    if (unknown.length)
      throw new InputError(
        `Unknown outbound event(s) ${unknown.join(", ")}. Supported: ${OUTBOUND_EVENTS.join(", ")}`,
      );
    if (secretRef !== null && typeof secretRef !== "string")
      throw new InputError("secretRef must be a string naming the secret");
    if (direction === "inbound" && !secretRef)
      throw new InputError(
        "An inbound endpoint needs a secretRef so requests can be verified",
      );
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO webhook_endpoints (id, name, direction, url, secret_ref, events, enabled, created_at, failure_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        id,
        name.trim(),
        direction,
        url,
        secretRef,
        JSON.stringify(events),
        enabled ? 1 : 0,
        this.now(),
      );
    this.services.audit?.record?.({
      actor,
      action: "webhook.endpoint.create",
      target: id,
      details: { name: name.trim(), direction, events },
    });
    return this.getEndpoint(id);
  }

  getEndpoint(id) {
    const row = this.db
      .prepare("SELECT * FROM webhook_endpoints WHERE id = ?")
      .get(id);
    if (!row) throw new InputError("Webhook endpoint not found", 404);
    return rowToEndpoint(row);
  }

  listEndpoints({ direction = null } = {}) {
    const rows = direction
      ? this.db
          .prepare(
            "SELECT * FROM webhook_endpoints WHERE direction = ? ORDER BY created_at",
          )
          .all(direction)
      : this.db
          .prepare("SELECT * FROM webhook_endpoints ORDER BY created_at")
          .all();
    return rows.map(rowToEndpoint);
  }

  updateEndpoint(id, patch = {}, { actor = "local-user" } = {}) {
    const current = this.getEndpoint(id);
    const next = {
      name: patch.name ?? current.name,
      url: patch.url === undefined ? current.url : patch.url,
      secretRef:
        patch.secretRef === undefined ? current.secretRef : patch.secretRef,
      events: patch.events ?? current.events,
      enabled: patch.enabled === undefined ? current.enabled : !!patch.enabled,
    };
    if (!Array.isArray(next.events))
      throw new InputError("events must be an array of strings");
    if (current.direction === "outbound") {
      if (typeof next.url !== "string" || !/^https?:\/\//i.test(next.url))
        throw new InputError("An outbound endpoint needs an http(s) url");
      assertDeliverable(next.url, { allowPrivate: this.allowPrivateTargets });
      const unknown = next.events.filter((e) => !OUTBOUND_EVENTS.includes(e));
      if (unknown.length)
        throw new InputError(`Unknown outbound event(s) ${unknown.join(", ")}`);
    }
    this.db
      .prepare(
        "UPDATE webhook_endpoints SET name = ?, url = ?, secret_ref = ?, events = ?, enabled = ? WHERE id = ?",
      )
      .run(
        next.name,
        next.url,
        next.secretRef,
        JSON.stringify(next.events),
        next.enabled ? 1 : 0,
        id,
      );
    this.services.audit?.record?.({
      actor,
      action: "webhook.endpoint.update",
      target: id,
      details: { enabled: next.enabled, events: next.events },
    });
    return this.getEndpoint(id);
  }

  deleteEndpoint(id, { actor = "local-user" } = {}) {
    this.getEndpoint(id);
    this.db.prepare("DELETE FROM webhook_endpoints WHERE id = ?").run(id);
    this.db
      .prepare("DELETE FROM webhook_deliveries WHERE endpoint_id = ?")
      .run(id);
    this.services.audit?.record?.({
      actor,
      action: "webhook.endpoint.delete",
      target: id,
    });
    return { id, deleted: true };
  }

  /* ------------------------------ inbound ---------------------------- */

  /**
   * receive(endpointId, { rawBody, headers })
   *
   * → { ok, status, reason, inboxId, externalId, duplicate, replay }
   *
   * status is the HTTP status the route should answer with:
   *   200 accepted · 200 duplicate (already processed) · 401 bad signature
   *   409 replay · 400 malformed · 404 unknown endpoint
   */
  receive(endpointId, { rawBody = "", headers = {} } = {}) {
    const endpoint = this.getEndpoint(endpointId);
    if (endpoint.direction !== "inbound")
      throw new InputError(
        "This endpoint does not accept inbound requests",
        405,
      );
    if (!endpoint.enabled)
      return { ok: false, status: 403, reason: "endpoint is disabled" };

    const lower = {};
    for (const [key, value] of Object.entries(headers ?? {}))
      lower[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
    const signature = lower[SIGNATURE_HEADER] ?? null;
    const timestamp = Number(lower[TIMESTAMP_HEADER]);
    const hash = payloadHash(rawBody);
    const body = parseJson(rawBody, null);
    const externalId =
      lower[EVENT_ID_HEADER] ??
      (body && typeof body === "object" ? (body.id ?? null) : null);

    const record = (signatureOk, resultText, status) => {
      const id = randomUUID();
      try {
        this.db
          .prepare(
            `INSERT INTO webhook_inbox (id, source, external_id, signature_ok, received_at, payload_hash, processed_at, result)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            endpoint.id,
            externalId ? String(externalId).slice(0, 200) : null,
            signatureOk ? 1 : 0,
            this.now(),
            hash,
            this.now(),
            resultText,
          );
      } catch (error) {
        // The unique (source, external_id) index makes a concurrent duplicate
        // land here; report it as a duplicate rather than a failure.
        return {
          ok: false,
          status: 200,
          reason: "duplicate external id",
          duplicate: true,
          externalId,
          detail: error.message,
        };
      }
      return {
        ok: status === 200,
        status,
        reason: resultText,
        inboxId: id,
        externalId,
      };
    };

    const secret = this.resolveSecret(endpoint.secretRef);
    if (!secret)
      return {
        ok: false,
        status: 503,
        reason: `the secret named by "${endpoint.secretRef}" is not available on this machine`,
      };
    if (!signature || !Number.isFinite(timestamp))
      return record(
        false,
        `missing ${SIGNATURE_HEADER} or ${TIMESTAMP_HEADER}`,
        400,
      );
    const expected = signPayload(secret, timestamp, rawBody);
    if (!constantTimeEqual(signature, expected))
      return record(false, "signature did not verify", 401);
    const age = Math.abs(this.now() - timestamp);
    if (age > FRESHNESS_MS)
      return record(
        true,
        `timestamp is ${Math.round(age / 1000)}s away from now; outside the ${FRESHNESS_MS / 1000}s replay window`,
        409,
      );
    const seen = this.db
      .prepare(
        "SELECT id FROM webhook_inbox WHERE source = ? AND payload_hash = ? AND signature_ok = 1 LIMIT 1",
      )
      .get(endpoint.id, hash);
    if (seen)
      return {
        ok: false,
        status: 409,
        reason: "this exact signed payload was already received (replay)",
        replay: true,
        inboxId: seen.id,
        externalId,
      };
    if (externalId) {
      const duplicate = this.db
        .prepare(
          "SELECT id FROM webhook_inbox WHERE source = ? AND external_id = ? LIMIT 1",
        )
        .get(endpoint.id, String(externalId));
      if (duplicate)
        return {
          ok: false,
          status: 200,
          reason: "already processed (duplicate external id)",
          duplicate: true,
          inboxId: duplicate.id,
          externalId,
        };
    }
    if (body === null) return record(true, "body is not valid JSON", 400);

    const accepted = record(true, "accepted", 200);
    this.services.audit?.record?.({
      actor: "webhook",
      action: "webhook.received",
      target: endpoint.id,
      details: { externalId: externalId ?? null, accepted: true },
    });
    return { ...accepted, ok: true, body };
  }

  inbox({ endpointId = null, limit = 50 } = {}) {
    const rows = endpointId
      ? this.db
          .prepare(
            "SELECT * FROM webhook_inbox WHERE source = ? ORDER BY received_at DESC LIMIT ?",
          )
          .all(endpointId, Math.min(Number(limit) || 50, 500))
      : this.db
          .prepare(
            "SELECT * FROM webhook_inbox ORDER BY received_at DESC LIMIT ?",
          )
          .all(Math.min(Number(limit) || 50, 500));
    return rows.map((row) => ({
      id: row.id,
      source: row.source,
      externalId: row.external_id ?? null,
      signatureOk: row.signature_ok === 1,
      receivedAt: row.received_at,
      payloadHash: row.payload_hash,
      processedAt: row.processed_at ?? null,
      result: row.result ?? null,
    }));
  }

  /* ----------------------------- outbound ---------------------------- */

  /**
   * Queues one delivery per enabled endpoint subscribed to `event`.
   * The payload is sanitized here: ids, statuses, titles, timestamps.
   */
  emit(event, payload = {}) {
    if (!OUTBOUND_EVENTS.includes(event))
      throw new InputError(
        `Unknown outbound event ${event}. Supported: ${OUTBOUND_EVENTS.join(", ")}`,
      );
    const endpoints = this.listEndpoints({ direction: "outbound" }).filter(
      (endpoint) => endpoint.enabled && endpoint.events.includes(event),
    );
    const safe = sanitizePayload(payload);
    const created = [];
    for (const endpoint of endpoints) {
      const id = randomUUID();
      const eventId = payload.eventId ?? randomUUID();
      this.db
        .prepare(
          `INSERT INTO webhook_deliveries (id, endpoint_id, event_id, status, attempts, next_attempt_at, created_at, event, payload)
           VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
        )
        .run(
          id,
          endpoint.id,
          eventId,
          this.now(),
          this.now(),
          event,
          JSON.stringify({ event, id: eventId, sentAt: this.now(), ...safe }),
        );
      created.push(id);
    }
    return { event, deliveries: created };
  }

  delivery(id) {
    const row = this.db
      .prepare("SELECT * FROM webhook_deliveries WHERE id = ?")
      .get(id);
    if (!row) throw new InputError("Delivery not found", 404);
    return rowToDelivery(row);
  }

  deliveries({ endpointId = null, status = null, limit = 100 } = {}) {
    const clauses = [];
    const params = [];
    if (endpointId) {
      clauses.push("endpoint_id = ?");
      params.push(endpointId);
    }
    if (status) {
      clauses.push("status = ?");
      params.push(status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(
        `SELECT * FROM webhook_deliveries ${where} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...params, Math.min(Number(limit) || 100, 500))
      .map(rowToDelivery);
  }

  /** Deliveries whose next attempt is due. */
  due({ now = null, limit = 25 } = {}) {
    const at = now ?? this.now();
    return this.db
      .prepare(
        "SELECT * FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?",
      )
      .all(at, limit)
      .map(rowToDelivery);
  }

  /**
   * Attempts every due delivery once. Bounded at MAX_ATTEMPTS.
   *
   * Re-entrant callers share ONE pass. The caller is a fixed 30 s interval
   * while a single slow endpoint can hold a pass open for minutes: without
   * this guard the next tick re-selects the same pending rows (attempt() only
   * writes status/attempts after the send resolves), so the receiver gets
   * every event several times and `attempts` never climbs to MAX_ATTEMPTS,
   * leaving a dead endpoint retried forever. Mirrors ObservationService.poll().
   */
  deliverDue(options = {}) {
    if (this._draining) return this._draining;
    this._draining = this.#deliverDue(options).finally(() => {
      this._draining = null;
    });
    return this._draining;
  }

  async #deliverDue({ now = null, limit = 25 } = {}) {
    const results = [];
    for (const delivery of this.due({ now, limit }))
      results.push(await this.attempt(delivery.id));
    return results;
  }

  /** One signed attempt. Records the outcome and schedules the next try. */
  async attempt(deliveryId) {
    const delivery = this.delivery(deliveryId);
    const endpoint = this.getEndpoint(delivery.endpointId);
    if (delivery.status === "delivered")
      return { ...delivery, skipped: "already delivered" };
    if (delivery.attempts >= MAX_ATTEMPTS)
      return { ...delivery, skipped: "attempt limit reached" };
    const secret = this.resolveSecret(endpoint.secretRef);
    const timestamp = this.now();
    const body = JSON.stringify(delivery.payload);
    const headers = {
      [TIMESTAMP_HEADER]: String(timestamp),
      [EVENT_HEADER]: delivery.event,
      [EVENT_ID_HEADER]: delivery.eventId,
    };
    if (secret)
      headers[SIGNATURE_HEADER] = signPayload(secret, timestamp, body);
    const attempts = delivery.attempts + 1;
    let outcome;
    if (!secret && endpoint.secretRef) {
      outcome = {
        ok: false,
        status: 0,
        error: `the secret named by "${endpoint.secretRef}" is not available; the request was not sent unsigned`,
      };
    } else {
      outcome = await this.send({
        url: endpoint.url,
        headers,
        body,
        event: delivery.event,
        allowPrivate: this.allowPrivateTargets,
      });
    }
    const exhausted = !outcome.ok && attempts >= MAX_ATTEMPTS;
    const status = outcome.ok ? "delivered" : exhausted ? "failed" : "pending";
    const nextAttemptAt =
      status === "pending" ? this.now() + backoffMs(attempts) : null;
    this.db
      .prepare(
        `UPDATE webhook_deliveries SET status = ?, attempts = ?, next_attempt_at = ?,
           response_code = ?, error = ?, delivered_at = ? WHERE id = ?`,
      )
      .run(
        status,
        attempts,
        nextAttemptAt,
        outcome.status ?? null,
        outcome.ok ? null : (outcome.error ?? "delivery failed"),
        outcome.ok ? this.now() : null,
        deliveryId,
      );
    this.db
      .prepare(
        "UPDATE webhook_endpoints SET last_delivery_at = ?, failure_count = ? WHERE id = ?",
      )
      .run(
        this.now(),
        outcome.ok ? 0 : (endpoint.failureCount ?? 0) + 1,
        endpoint.id,
      );
    if (exhausted)
      this.services.audit?.record?.({
        actor: "system",
        action: "webhook.delivery.failed",
        target: endpoint.id,
        details: {
          deliveryId,
          event: delivery.event,
          attempts,
          error: outcome.error ?? null,
        },
      });
    return this.delivery(deliveryId);
  }

  /** Re-queues a failed delivery for one more bounded round of attempts. */
  redeliver(deliveryId, { actor = "local-user" } = {}) {
    const delivery = this.delivery(deliveryId);
    this.db
      .prepare(
        "UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?, error = NULL WHERE id = ?",
      )
      .run(this.now(), deliveryId);
    this.services.audit?.record?.({
      actor,
      action: "webhook.delivery.redeliver",
      target: delivery.endpointId,
      details: { deliveryId, event: delivery.event },
    });
    return this.delivery(deliveryId);
  }
}

/**
 * Strips everything that is not an id, a status, a title, or a timestamp.
 * Prompts, file contents, tokens, secrets and paths never leave the machine.
 */
export function sanitizePayload(payload = {}) {
  const allowed = [
    "workspaceId",
    "workflowId",
    "taskId",
    "runId",
    "approvalId",
    "provider",
    "status",
    "title",
    "kind",
    "attempt",
    "startedAt",
    "endedAt",
    "reviewStatus",
    "owner",
    "externalId",
  ];
  const out = {};
  for (const key of allowed) {
    const value = payload?.[key];
    if (value === undefined || value === null) continue;
    out[key] = typeof value === "string" ? value.slice(0, 200) : value;
  }
  return out;
}

export function createWebhookService(services, options = {}) {
  const webhooks = new WebhookService(services, options);
  services.webhooks = webhooks;
  return webhooks;
}
