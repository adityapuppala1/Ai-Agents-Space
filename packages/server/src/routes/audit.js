import { InputError } from "../../../core/src/TaskStore.js";

/**
 * Audit log (read-only).
 *   GET /api/audit?limit=&workspace=&run=&action=&since=
 */
export default async function auditRoutes(ctx) {
  const { method, path, query, send, services } = ctx;
  if (path !== "/api/audit" || method !== "GET") return false;
  if (!services.audit) throw new InputError("Audit log is not enabled", 503);
  send(
    200,
    services.audit.list({
      limit: query.get("limit") ? Number(query.get("limit")) : 200,
      workspaceId: query.get("workspace") || null,
      runId: query.get("run") || null,
      action: query.get("action") || null,
      since: query.get("since") ? Number(query.get("since")) : null,
    }),
  );
  return true;
}
