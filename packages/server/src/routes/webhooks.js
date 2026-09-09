import { InputError } from "../../../core/src/TaskStore.js";
import { createWebhookService } from "../../../core/src/webhooks/WebhookService.js";

/**
 * Webhook endpoints, the signed inbound receiver, and the delivery log.
 *
 * Register BEFORE routes/workspaces.js.
 *
 * Routes:
 *   GET    /api/webhooks/endpoints
 *   POST   /api/webhooks/endpoints
 *   GET    /api/webhooks/endpoints/:id
 *   PATCH  /api/webhooks/endpoints/:id
 *   DELETE /api/webhooks/endpoints/:id
 *   GET    /api/webhooks/deliveries            ?endpoint=&status=
 *   POST   /api/webhooks/deliveries/:id/redeliver
 *   POST   /api/webhooks/deliveries/deliver-due
 *   GET    /api/webhooks/inbox                 ?endpoint=
 *   POST   /api/webhooks/:endpointId           inbound receiver (signed)
 *
 * The inbound receiver reads the RAW request body itself (ctx.body() would
 * parse and discard the exact bytes the signature covers). No secret is ever
 * returned by any of these routes: an endpoint only exposes `secretRef`, the
 * NAME of the secret.
 */

const MAX_INBOUND_BYTES = 256 * 1024;

async function readRaw(req, limit = MAX_INBOUND_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit)
      throw new InputError(`Request exceeds ${limit / 1024} KB`, 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export default async function webhookRoutes(ctx) {
  const { method, path, send, body, query, req, services, actor } = ctx;
  if (!path.startsWith("/api/webhooks")) return false;
  const webhooks = services.webhooks ?? createWebhookService(services);

  /* ----------------------------- endpoints ----------------------------- */

  if (path === "/api/webhooks/endpoints") {
    if (method === "GET") {
      send(
        200,
        webhooks.listEndpoints({ direction: query?.get?.("direction") }),
      );
      return true;
    }
    if (method === "POST") {
      const input = (await body()) ?? {};
      send(201, webhooks.createEndpoint({ ...input, actor }));
      return true;
    }
    return false;
  }

  const endpoint = path.match(/^\/api\/webhooks\/endpoints\/([^/]+)$/);
  if (endpoint) {
    const id = endpoint[1];
    if (method === "GET") {
      send(200, webhooks.getEndpoint(id));
      return true;
    }
    if (method === "PATCH") {
      const input = (await body()) ?? {};
      send(200, webhooks.updateEndpoint(id, input, { actor }));
      return true;
    }
    if (method === "DELETE") {
      send(200, webhooks.deleteEndpoint(id, { actor }));
      return true;
    }
    return false;
  }

  /* ---------------------------- deliveries ----------------------------- */

  if (method === "GET" && path === "/api/webhooks/deliveries") {
    send(
      200,
      webhooks.deliveries({
        endpointId: query?.get?.("endpoint") ?? null,
        status: query?.get?.("status") ?? null,
      }),
    );
    return true;
  }
  if (method === "POST" && path === "/api/webhooks/deliveries/deliver-due") {
    send(200, await webhooks.deliverDue({}));
    return true;
  }
  const delivery = path.match(
    /^\/api\/webhooks\/deliveries\/([^/]+)\/(redeliver|attempt)$/,
  );
  if (method === "POST" && delivery) {
    if (delivery[2] === "redeliver") {
      send(200, webhooks.redeliver(delivery[1], { actor }));
      return true;
    }
    send(200, await webhooks.attempt(delivery[1]));
    return true;
  }

  if (method === "GET" && path === "/api/webhooks/inbox") {
    send(200, webhooks.inbox({ endpointId: query?.get?.("endpoint") ?? null }));
    return true;
  }

  if (method === "GET" && path === "/api/webhooks") {
    send(200, webhooks.listEndpoints({}));
    return true;
  }

  /* -------------------------- inbound receiver ------------------------- */

  const inbound = path.match(/^\/api\/webhooks\/([^/]+)$/);
  if (method === "POST" && inbound) {
    const rawBody = await readRaw(req);
    const result = webhooks.receive(inbound[1], {
      rawBody,
      headers: req.headers,
    });
    // The body is never echoed back: only the verdict and the ids.
    send(result.status ?? 200, {
      ok: result.ok === true,
      reason: result.reason ?? null,
      externalId: result.externalId ?? null,
      duplicate: result.duplicate === true,
      replay: result.replay === true,
      inboxId: result.inboxId ?? null,
    });
    return true;
  }

  return false;
}
