import { InputError } from "../../../core/src/TaskStore.js";

/**
 * Approval + inbox routes. Register BEFORE routes/workspaces.js.
 *   GET  /api/approvals?status=pending&workspace=&run=
 *   GET  /api/approvals/:id
 *   POST /api/approvals/:id/decide { decision:'approve'|'deny', note?, payloadHash? }
 *   GET  /api/inbox?workspace=
 */
export default async function approvalRoutes(ctx) {
  const { method, path, query, send, body, services, actor } = ctx;
  if (!path.startsWith("/api/approvals") && path !== "/api/inbox") return false;
  const approvals = services.approvals;
  if (!approvals)
    throw new InputError("Approvals are not enabled on this server", 503);

  if (method === "GET" && path === "/api/inbox") {
    send(200, approvals.inbox({ workspaceId: query.get("workspace") || null }));
    return true;
  }
  if (method === "GET" && path === "/api/approvals") {
    send(
      200,
      approvals.list({
        status: query.get("status") || null,
        workspaceId: query.get("workspace") || null,
        runId: query.get("run") || null,
        limit: query.get("limit") ? Number(query.get("limit")) : 200,
      }),
    );
    return true;
  }
  const single = path.match(/^\/api\/approvals\/([^/]+)$/);
  if (method === "GET" && single) {
    send(200, approvals.get(decodeURIComponent(single[1])));
    return true;
  }
  const decide = path.match(/^\/api\/approvals\/([^/]+)\/decide$/);
  if (method === "POST" && decide) {
    const input = (await body()) ?? {};
    const approval = approvals.decide(decodeURIComponent(decide[1]), {
      decision: input.decision,
      note: input.note ?? null,
      payloadHash: input.payloadHash ?? null,
      actor: input.actor
        ? `${actor}:${String(input.actor).slice(0, 60)}`
        : actor,
    });
    send(200, approval);
    return true;
  }
  return false;
}
