import { InputError } from "../../../core/src/TaskStore.js";
import { CAPABILITIES, PROVIDERS } from "../../../core/src/contracts.js";
import {
  SENSITIVITY_LABELS,
  SENSITIVITY_LEVELS,
  VENDORS,
  vendorOf,
} from "../../../core/src/routing/router.js";

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
  // GET /api/routing: the words routing uses (sensitivity labels, vendors,
  // and which vendor each assistant sends work to).
  if (method === "GET" && path === "/api/routing") {
    send(200, {
      levels: SENSITIVITY_LEVELS,
      labels: SENSITIVITY_LABELS,
      vendors: VENDORS,
      providers: Object.entries(PROVIDERS).map(([id, provider]) => ({
        id,
        name: provider.name,
        vendor: provider.vendor ?? null,
        vendorId: vendorOf(id),
      })),
      capabilities: CAPABILITIES,
    });
    return true;
  }
  // POST /api/workspaces/:id/route { taskId?, requires?, sensitivity?,
  // allowExperimental? } → each assistant ranked, with the checks that
  // decided it. Read-only: nothing is started or changed.
  const route = path.match(/^\/api\/workspaces\/([^/]+)\/route$/);
  if (route && method === "POST") {
    if (!services.router) throw new InputError("Routing is not enabled", 503);
    const input = (await body()) ?? {};
    const requires = input.requires ?? [];
    if (
      !Array.isArray(requires) ||
      !requires.every((item) => CAPABILITIES.includes(item))
    )
      throw new InputError(
        `requires must list capabilities from: ${CAPABILITIES.join(", ")}`,
      );
    const sensitivity = input.sensitivity ?? null;
    if (sensitivity !== null && !SENSITIVITY_LEVELS.includes(sensitivity))
      throw new InputError(
        `sensitivity must be one of ${SENSITIVITY_LEVELS.join(", ")}`,
      );
    send(
      200,
      services.router.rank({
        workspaceId: decodeURIComponent(route[1]),
        taskId: typeof input.taskId === "string" ? input.taskId : null,
        requires,
        sensitivity,
        allowExperimental: input.allowExperimental !== false,
      }),
    );
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
