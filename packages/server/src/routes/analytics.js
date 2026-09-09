import { InputError } from "../../../core/src/TaskStore.js";

/**
 * GET /api/analytics?workspace=&since=   → Analytics.summary()
 * GET /api/analytics/export?format=csv|json&workspace=&since=
 * Requires services.analytics. Order relative to workspaces.js does not matter.
 */
export default async function analyticsRoutes(ctx) {
  const { method, path, query, send, res, services } = ctx;
  if (method !== "GET" || !path.startsWith("/api/analytics")) return false;
  const analytics = services.analytics;
  if (!analytics) throw new InputError("Analytics are not available", 503);
  const opts = {
    workspaceId: query.get("workspace") || null,
    since: Number(query.get("since")) || 0,
  };
  if (path === "/api/analytics") {
    send(200, analytics.summary(opts));
    return true;
  }
  if (path === "/api/analytics/export") {
    const format = query.get("format") || "json";
    const result = analytics.export(format, opts);
    res.writeHead(200, {
      "Content-Type": result.contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="agent-space-analytics.${format}"`,
    });
    res.end(result.body);
    return true;
  }
  return false;
}
