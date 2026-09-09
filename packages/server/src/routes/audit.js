import { InputError } from "../../../core/src/TaskStore.js";

/**
 * Audit log (read-only). Register BEFORE routes/workspaces.js.
 *   GET /api/audit?limit=&workspace=&run=&action=&since=
 *   GET /api/audit/verify              → hash-chain verification
 *   GET /api/audit/export?format=csv|json&workspace=&since=&until=
 *
 * The export is a download; the verification is a small JSON document saying
 * whether the chain is intact and, if not, the first sequence number that does
 * not match. Rows written before schema v5 have no hash and are counted
 * separately as `unchained` rather than claimed as verified.
 */
export default async function auditRoutes(ctx) {
  const { method, path, query, send, res, services, actor } = ctx;
  if (!path.startsWith("/api/audit")) return false;
  if (method !== "GET") return false;
  if (!services.audit) throw new InputError("Audit log is not enabled", 503);
  const audit = services.audit;

  const filter = {
    workspaceId: query.get("workspace") || null,
    runId: query.get("run") || null,
    action: query.get("action") || null,
    since: query.get("since") ? Number(query.get("since")) : null,
    until: query.get("until") ? Number(query.get("until")) : null,
  };

  // Stays an array: existing clients and tests read it directly. The chain
  // state is a separate document at /api/audit/verify.
  if (path === "/api/audit") {
    send(
      200,
      audit.list({
        limit: query.get("limit") ? Number(query.get("limit")) : 200,
        ...filter,
      }),
    );
    return true;
  }

  if (path === "/api/audit/verify") {
    if (typeof audit.verify !== "function")
      throw new InputError("This build has no tamper-evident audit log", 503);
    send(200, audit.verify());
    return true;
  }

  if (path === "/api/audit/export") {
    if (typeof audit.export !== "function")
      throw new InputError("This build cannot export the audit log", 503);
    const format = (query.get("format") || "json").toLowerCase();
    if (!["csv", "json"].includes(format))
      throw new InputError("format must be csv or json");
    const result = audit.export(format, {
      ...filter,
      limit: query.get("limit") ? Number(query.get("limit")) : 50000,
    });
    try {
      services.audit.record({
        actor,
        action: "audit.export",
        details: { format, filter },
      });
    } catch {
      /* exporting must not fail because the audit write failed */
    }
    res.writeHead(200, {
      "Content-Type": result.contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
    });
    res.end(result.body);
    return true;
  }

  return false;
}
