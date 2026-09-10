import { InputError } from "../../../core/src/TaskStore.js";
import { createSavedViews } from "../../../core/src/views/SavedViews.js";

/**
 * Saved views for the Board, the Office, the shared filter set, the
 * Timeline and the Dependency Map.
 *
 *   GET    /api/workspaces/:id/views?scope=board|office|filters|timeline|deps
 *   POST   /api/workspaces/:id/views           {scope, name, state?, isDefault?}
 *   PATCH  /api/views/:id                      {name?, state?, isDefault?}
 *   DELETE /api/views/:id
 *   POST   /api/views/:id/default
 *
 * Register BEFORE routes/workspaces.js (it claims /api/workspaces/:id/views).
 * Attaches a SavedViews service on first use when the container did not
 * compose one. Analytics saved views live under /api/analytics/views and are
 * untouched.
 */
export default async function viewRoutes(ctx) {
  const { method, path, query, send, body, services, actor } = ctx;

  const scoped = path.match(/^\/api\/workspaces\/([^/]+)\/views$/);
  if (scoped) {
    const views = requireViews(services);
    const workspaceId = decodeURIComponent(scoped[1]);
    services.hub.get(workspaceId);
    if (method === "GET") {
      send(200, {
        workspaceId,
        scope: query.get("scope") || null,
        views: views.list(workspaceId, { scope: query.get("scope") || null }),
      });
      return true;
    }
    if (method === "POST") {
      const input = (await body(32 * 1024)) ?? {};
      send(
        201,
        views.create({
          workspaceId,
          scope: input.scope,
          name: input.name,
          state: input.state ?? {},
          isDefault: input.isDefault === true,
          actor,
        }),
      );
      return true;
    }
    throw new InputError("Use GET to list or POST to create a saved view", 405);
  }

  const single = path.match(/^\/api\/views\/([^/]+)(\/default)?$/);
  if (!single) return false;
  const views = requireViews(services);
  const id = decodeURIComponent(single[1]);
  if (single[2]) {
    if (method !== "POST")
      throw new InputError("Use POST to set the default view", 405);
    send(200, views.setDefault(id, { actor }));
    return true;
  }
  if (method === "GET") {
    send(200, views.get(id));
    return true;
  }
  if (method === "PATCH") {
    const input = (await body(32 * 1024)) ?? {};
    send(
      200,
      views.update(id, {
        name: input.name,
        state: input.state,
        isDefault: input.isDefault,
        actor,
      }),
    );
    return true;
  }
  if (method === "DELETE") {
    send(200, views.remove(id, { actor }));
    return true;
  }
  return false;
}

function requireViews(services) {
  if (!services.savedViews) createSavedViews(services);
  return services.savedViews;
}
