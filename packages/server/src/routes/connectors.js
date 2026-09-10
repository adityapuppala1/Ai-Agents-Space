import { InputError } from "../../../core/src/TaskStore.js";
import { createConnectorRegistry } from "../../../core/src/connectors/index.js";

/**
 * Connector routes. MUST be registered BEFORE routes/workspaces.js, because
 * this module claims `/api/workspaces/:id/checks` and workspaces.js owns the
 * generic `/api/workspaces/:id/...` prefix (it answers 404-by-fallthrough).
 *
 * Availability (probe) side — services.connectors:
 *   GET  /api/connectors                    — every data connector with honest availability
 *   GET  /api/connectors/:id                — one connector
 *   POST /api/connectors/refresh            — re-probe now (never cached)
 *
 * Read/write side — the connector registry (core/src/connectors/index.js):
 *   GET  /api/connectors/:id/capabilities   — measured reads/writes and the reason when unusable
 *   POST /api/connectors/:id/read  { op, params }
 *   POST /api/connectors/:id/write { op, params, confirm, approvalId }
 *   GET  /api/workspaces/:id/checks         — GitHub checks for the current branch
 *
 * Reads are scoped to the workspace folder root and never return secrets.
 * Writes are refused unless the workspace policy allows the equivalent command
 * AND an approved approval is bound to the exact request; without an
 * approvalId the call creates a pending approval and answers 202 without
 * touching the connector. `GET …/checks` degrades to
 * { available: false, reason } whenever gh/git is missing or unauthenticated —
 * it never reports a build state it did not read.
 */
export default async function connectorRoutes(ctx) {
  const { method, path, send, body, services, actor } = ctx;

  // /api/workspaces/:id/checks — CI status read-through (see registry.checks).
  const checks = path.match(/^\/api\/workspaces\/([^/]+)\/checks$/);
  if (checks) {
    if (method !== "GET") return false;
    send(
      200,
      await registryFor(services).checks(decodeURIComponent(checks[1])),
    );
    return true;
  }

  if (!path.startsWith("/api/connectors")) return false;

  // Registry sub-paths first: the availability handlers below only serve
  // /api/connectors and /api/connectors/:id.
  const scoped = path.match(
    /^\/api\/connectors\/([^/]+)\/(capabilities|read|write)$/,
  );
  if (scoped) {
    const id = decodeURIComponent(scoped[1]);
    const registry = registryFor(services);
    if (scoped[2] === "capabilities") {
      if (method !== "GET") return false;
      send(200, await registry.capabilities(id));
      return true;
    }
    if (method !== "POST") return false;
    const input = (await body()) ?? {};
    if (!input.op) throw new InputError("op is required");
    if (scoped[2] === "read") {
      send(200, {
        connector: id,
        op: input.op,
        result: await registry.read(id, input.op, input.params ?? {}),
      });
      return true;
    }
    if (input.confirm !== true)
      throw new InputError(
        "A connector write must be confirmed: send confirm: true together with op and params.",
        400,
      );
    const outcome = await registry.write(id, input.op, input.params ?? {}, {
      approvalId: input.approvalId ?? null,
      actor,
      reason: input.reason ?? null,
    });
    send(outcome.status === "pending" ? 202 : 200, {
      connector: id,
      op: input.op,
      ...outcome,
    });
    return true;
  }

  const connectors = services.connectors;
  if (!connectors)
    throw new InputError(
      "Connectors are not available in this container (services.connectors is not composed)",
      503,
    );

  if (method === "GET" && path === "/api/connectors") {
    const list = await connectors.list();
    send(200, { connectors: list, count: list.length });
    return true;
  }
  if (method === "POST" && path === "/api/connectors/refresh") {
    const list = await connectors.refresh();
    send(200, { connectors: list, count: list.length });
    return true;
  }
  if (method === "GET") {
    const id = path.slice("/api/connectors/".length);
    if (!id || id.includes("/")) return false;
    const connector = await connectors.get(id);
    if (!connector) throw new InputError(`Unknown connector: ${id}`, 404);
    send(200, connector);
    return true;
  }
  return false;
}

/**
 * The read/write registry. It is composed lazily so this route works whether
 * or not services.js attached `services.connectorRegistry`.
 */
function registryFor(services) {
  return services.connectorRegistry ?? createConnectorRegistry(services);
}
