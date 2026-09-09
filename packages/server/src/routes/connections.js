import { InputError } from "../../../core/src/TaskStore.js";

/**
 * Provider registry and connection routes. Requires `services.connections`
 * (ConnectionService); responds 503 when it is not attached.
 *
 *   GET    /api/providers
 *   GET    /api/connections
 *   POST   /api/connections                       create an extra alias
 *   POST   /api/connections/refresh
 *   GET    /api/connections/doctor
 *   GET    /api/connections/capabilities
 *   GET    /api/connections/compatibility
 *   GET    /api/connections/:id
 *   PATCH  /api/connections/:id
 *   DELETE /api/connections/:id
 *   POST   /api/connections/:id/probe
 *   GET    /api/connections/:id/probes
 *   GET    /api/connections/:id/health
 *   GET    /api/connections/:id/migration-preview?agentId=&workspaceId=
 *   POST   /api/connections/:id/migrate[?apply=1]  plan, or apply the plan
 */
export default async function connectionRoutes(ctx) {
  const { method, path, send, body, query, services, actor } = ctx;
  if (path !== "/api/providers" && !path.startsWith("/api/connections"))
    return false;
  const connections = services.connections;
  if (!connections) {
    send(503, { error: "Connections service is not available" });
    return true;
  }

  if (method === "GET" && path === "/api/providers") {
    send(200, connections.providers());
    return true;
  }
  if (path === "/api/connections" && method === "GET") {
    send(200, connections.list());
    return true;
  }
  if (path === "/api/connections" && method === "POST") {
    send(
      201,
      connections.create({
        ...(await body()),
        actor: actor ?? "local-user",
      }),
    );
    return true;
  }
  if (path === "/api/connections/refresh" && method === "POST") {
    send(200, await connections.refresh({ force: true }));
    return true;
  }
  if (path === "/api/connections/doctor" && method === "GET") {
    if (query.get("refresh") === "1")
      await connections.refresh({ force: true });
    send(200, connections.doctor());
    return true;
  }
  if (path === "/api/connections/capabilities" && method === "GET") {
    send(200, connections.allCapabilities());
    return true;
  }
  if (path === "/api/connections/compatibility" && method === "GET") {
    const provider = query.get("provider");
    if (provider) {
      const version = query.get("version");
      send(200, connections.compatibility(provider, version ?? undefined));
      return true;
    }
    send(200, connections.allCompatibility());
    return true;
  }
  const scoped = path.match(/^\/api\/connections\/([^/]+)(\/[^/]+)?$/);
  if (!scoped) return false;
  const id = decodeURIComponent(scoped[1]);
  const action = scoped[2] ?? "";
  if (!action && method === "GET") {
    send(200, connections.get(id));
    return true;
  }
  if (!action && method === "PATCH") {
    send(200, connections.update(id, await body()));
    return true;
  }
  if (!action && method === "DELETE") {
    send(200, connections.remove(id, { actor: actor ?? "local-user" }));
    return true;
  }
  if (action === "/probe" && method === "POST") {
    send(200, await connections.probe(id));
    return true;
  }
  if (action === "/probes" && method === "GET") {
    send(200, connections.probes(id));
    return true;
  }
  if (action === "/health" && method === "GET") {
    send(200, connections.health(id));
    return true;
  }
  if (action === "/migration-preview" && method === "GET") {
    const connection = connections.get(id);
    const agentId = query.get("agentId");
    const workspaceId = query.get("workspaceId");
    if (!agentId || !workspaceId)
      throw new InputError("agentId and workspaceId are required");
    send(
      200,
      connections.migrationPreview(
        { workspaceId, agentId },
        connection.provider,
      ),
    );
    return true;
  }
  if (action === "/migrate" && method === "POST") {
    const connection = connections.get(id);
    const payload = (await body()) ?? {};
    const apply = query.get("apply") === "1" || payload.apply === true;
    const result = await connections.migrate({
      agentId: payload.agentId,
      workspaceId: payload.workspaceId ?? null,
      targetProvider: payload.targetProvider ?? connection.provider,
      taskId: payload.taskId ?? null,
      launch: payload.launch === true,
      apply,
      actor: actor ?? "local-user",
    });
    send(200, result);
    return true;
  }
  return false;
}
