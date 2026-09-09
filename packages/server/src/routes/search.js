import { InputError } from "../../../core/src/TaskStore.js";
import { SEARCH_KINDS } from "../../../core/src/search/Search.js";

/**
 * GET /api/search?q=&workspace=&kinds=tasks,runs,events,artifacts,sessions&limit=
 *
 * Searches the records Agent Space already holds — never the filesystem. The
 * response is always the same shape, including when nothing matched:
 *   { query, kinds, limit, workspaceId, counts, results[], empty, note }
 *
 * GET /api/search/kinds returns the searchable kinds so a client does not have
 * to hard-code them.
 *
 * Must be registered before workspaces.js only because that module owns the
 * catch-all; /api/search does not overlap any other route prefix.
 */
export default async function searchRoutes(ctx) {
  const { method, path, query, send, services } = ctx;
  if (!path.startsWith("/api/search")) return false;
  if (method !== "GET") return false;

  if (path === "/api/search/kinds") {
    send(200, { kinds: SEARCH_KINDS });
    return true;
  }
  if (path !== "/api/search") return false;

  const search = services.search;
  if (!search)
    throw new InputError(
      "Search is not available in this container (services.search is not composed)",
      503,
    );
  send(
    200,
    search.search({
      q: query.get("q") ?? query.get("query") ?? "",
      workspaceId: query.get("workspace") || null,
      kinds: query.get("kinds"),
      limit: query.get("limit"),
    }),
  );
  return true;
}
