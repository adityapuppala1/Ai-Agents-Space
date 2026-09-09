import workspaceRoutes from "./workspaces.js";

/**
 * Ordered route handlers. Each receives the request context and returns true
 * when it handled the request. Add new modules here; keep workspaceRoutes
 * last among the /api handlers because it owns the generic /api/workspaces/:id
 * prefix and returns 404-by-fallthrough for unknown workspace-scoped paths.
 */
export const routes = [workspaceRoutes];
