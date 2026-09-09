import { InputError } from "../../../core/src/TaskStore.js";

/**
 * GET /api/connectors            — every data connector with honest availability
 * GET /api/connectors/:id        — one connector
 * POST /api/connectors/refresh   — re-probe now (never cached)
 *
 * Connectors are read-only context sources (local files, Git, GitHub). This
 * route reports what was measured; it never enables anything. A build without
 * the connectors module answers 503 with the reason rather than pretending the
 * list is empty.
 */
export default async function connectorRoutes(ctx) {
  const { method, path, send, services } = ctx;
  if (!path.startsWith("/api/connectors")) return false;

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
