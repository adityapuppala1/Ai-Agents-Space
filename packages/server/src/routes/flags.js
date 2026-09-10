import { InputError } from "../../../core/src/TaskStore.js";

/**
 * Feature flags and adapter canaries (roadmap §11). Register BEFORE
 * routes/workspaces.js; this module only claims /api/flags*.
 *
 * Routes:
 *   GET /api/flags                          every known flag, value, overrides
 *   PUT /api/flags/:name                    { value, workspaceId? } (audited)
 *   DELETE /api/flags/:name?workspaceId=    clears a workspace override
 *   GET /api/flags/:name/history            audit-backed change history
 *   GET /api/flags/canary/:provider         ?workspaceId=  → channel + reason
 *   PUT /api/flags/canary/:provider         { percent } | { workspaces } | null
 *                                           (refused by the compatibility gate
 *                                           when the provider is untested)
 *   GET /api/flags/gate/:provider           ?version=  → compatibility gate
 *
 * Flag names are dotted words; `canary` and `gate` are reserved prefixes.
 */
export default async function flagRoutes(ctx) {
  const { method, path, send, body, query, services, actor } = ctx;
  if (path !== "/api/flags" && !path.startsWith("/api/flags/")) return false;
  const flags = services.flags;
  if (!flags) throw new InputError("Feature flags are not available in this build", 503);

  if (path === "/api/flags") {
    if (method !== "GET") return false;
    send(200, { flags: flags.list(), registry: Object.keys(flags.registry) });
    return true;
  }

  const canary = path.match(/^\/api\/flags\/canary\/([^/]+)$/);
  if (canary) {
    const provider = canary[1];
    if (method === "GET") {
      send(200, flags.canary(provider, { workspaceId: query?.get?.("workspaceId") ?? null }));
      return true;
    }
    if (method === "PUT") {
      const input = await body();
      send(200, flags.setCanary(provider, input === undefined ? null : input, {
        actor,
        version: query?.get?.("version") ?? null,
      }));
      return true;
    }
    return false;
  }

  const gate = path.match(/^\/api\/flags\/gate\/([^/]+)$/);
  if (gate) {
    if (method !== "GET") return false;
    send(200, flags.gate(gate[1], query?.get?.("version") ?? null));
    return true;
  }

  const history = path.match(/^\/api\/flags\/([^/]+)\/history$/);
  if (history) {
    if (method !== "GET") return false;
    flags.definition(history[1].startsWith("canary.") ? "adapters.nextChannel" : history[1]);
    send(200, flags.history(history[1], { limit: query?.get?.("limit") ?? 100 }));
    return true;
  }

  const one = path.match(/^\/api\/flags\/([^/]+)$/);
  if (!one) return false;
  const name = one[1];
  if (method === "GET") {
    const workspaceId = query?.get?.("workspaceId") ?? null;
    send(200, {
      name,
      value: flags.isEnabled(name, { workspaceId }),
      global: flags.value(name),
      workspaceId,
      definition: flags.definition(name),
    });
    return true;
  }
  if (method === "PUT") {
    const input = (await body()) ?? {};
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new InputError("Expected { value, workspaceId? }");
    send(200, flags.set(name, input.value, { workspaceId: input.workspaceId ?? null, actor }));
    return true;
  }
  if (method === "DELETE") {
    send(200, flags.clear(name, { workspaceId: query?.get?.("workspaceId") ?? null, actor }));
    return true;
  }
  return false;
}
