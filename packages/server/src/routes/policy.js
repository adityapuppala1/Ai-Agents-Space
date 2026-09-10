import { InputError } from "../../../core/src/TaskStore.js";

/**
 * Workspace policy routes. Register BEFORE routes/workspaces.js because it
 * uses /api/workspaces/:id/policy sub-paths.
 *   GET  /api/policy/presets
 *   GET  /api/workspaces/:id/policy            (includes dualApprovalFor, escalateAfterMs,
 *                                               escalationReviewer, allowedModels,
 *                                               allowedProviders, allowedDestinations)
 *   PUT  /api/workspaces/:id/policy            (partial merge, validated in Policy.validatePolicy)
 *   POST /api/workspaces/:id/policy/preview    { request, runId? } → evaluation + access lists
 *   POST /api/workspaces/:id/policy/launch     { provider?, isolation?, model?, connectionId? } → evaluateLaunch
 */
export default async function policyRoutes(ctx) {
  const { method, path, send, body, services, actor } = ctx;
  const policy = services.policy;
  if (method === "GET" && path === "/api/policy/presets") {
    if (!policy) throw new InputError("Policy engine is not enabled", 503);
    send(200, policy.presets());
    return true;
  }
  const scoped = path.match(
    /^\/api\/workspaces\/([^/]+)\/policy(\/preview|\/launch)?$/,
  );
  if (!scoped) return false;
  if (!policy) throw new InputError("Policy engine is not enabled", 503);
  const workspaceId = decodeURIComponent(scoped[1]);
  const sub = scoped[2] ?? "";
  if (method === "GET" && !sub) {
    send(200, policy.forWorkspace(workspaceId));
    return true;
  }
  if ((method === "PUT" || method === "PATCH") && !sub) {
    send(200, policy.setForWorkspace(workspaceId, await body(), { actor }));
    return true;
  }
  if (method === "POST" && sub === "/preview") {
    const input = (await body()) ?? {};
    if (!input.request || typeof input.request !== "object")
      throw new InputError("Provide a request object to preview");
    send(
      200,
      policy.preview(workspaceId, input.request, {
        runId: input.runId ?? null,
      }),
    );
    return true;
  }
  if (method === "POST" && sub === "/launch") {
    const input = (await body()) ?? {};
    for (const key of ["provider", "isolation", "model", "connectionId"])
      if (
        input[key] !== undefined &&
        input[key] !== null &&
        (typeof input[key] !== "string" || input[key].length > 200)
      )
        throw new InputError(`${key} must be a short string`);
    send(
      200,
      policy.evaluateLaunch({
        workspaceId,
        provider: input.provider ?? null,
        isolation: input.isolation ?? null,
        model: input.model ?? null,
        connectionId: input.connectionId ?? null,
      }),
    );
    return true;
  }
  return false;
}
