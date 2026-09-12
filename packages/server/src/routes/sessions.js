import { InputError } from "../../../core/src/TaskStore.js";

/**
 * Observed-session routes. Register BEFORE routes/workspaces.js (it owns the
 * generic /api prefix fallthrough). Requires `services.observation`
 * (an ObservationService); responds 503 when it is not attached.
 *
 *   GET  /api/sessions?live=1        → observed sessions (live only with ?live=1)
 *   GET  /api/sessions/:id           → one session (+ its run)
 *   POST /api/sessions/:id/attach    → { workspaceId } re-map to another workspace
 *   POST /api/observation/poll       → run one poll pass now
 *   GET  /api/observation/status     → { enabled, intervalMs, observers, surfaces, lastPollAt, sessionCounts }
 */
export default async function sessionRoutes(ctx) {
  const { method, path, query, send, body, services } = ctx;
  if (!path.startsWith("/api/sessions") && !path.startsWith("/api/observation"))
    return false;
  const observation = services.observation;
  if (!observation) {
    send(503, {
      error: "Observation service is not available on this server",
    });
    return true;
  }

  if (path === "/api/observation/status" && method === "GET") {
    send(200, observation.status());
    return true;
  }
  if (path === "/api/observation/poll" && method === "POST") {
    const result = await observation.poll();
    send(200, { ...result, status: observation.status() });
    return true;
  }
  if (path === "/api/sessions" && method === "GET") {
    const live = query.get("live");
    const limit = Number.parseInt(query.get("limit") ?? "", 10);
    send(
      200,
      observation.sessions({
        live: live === "1" || live === "true" ? true : undefined,
        limit:
          Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 200,
      }),
    );
    return true;
  }
  const single = path.match(/^\/api\/sessions\/([^/]+)(\/attach)?$/);
  if (single) {
    const id = decodeURIComponent(single[1]);
    if (!single[2] && method === "GET") {
      send(200, observation.session(id));
      return true;
    }
    if (single[2] && method === "POST") {
      const input = await body();
      if (!input || typeof input !== "object")
        throw new InputError("Expected an object with workspaceId");
      send(200, observation.attach(id, input.workspaceId));
      return true;
    }
  }
  return false;
}
