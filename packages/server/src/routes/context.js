import { InputError } from "../../../core/src/TaskStore.js";

/**
 * POST /api/workspaces/:id/context/preview {taskId?, agentId?, files[], documents[], instructions[], maxFileBytes?}
 * POST /api/workspaces/:id/context/stale   {manifest}
 * Register BEFORE routes/workspaces.js. Requires services.context.
 */
export default async function contextRoutes(ctx) {
  const { method, path, send, body, services } = ctx;
  const match = path.match(
    /^\/api\/workspaces\/([^/]+)\/context\/(preview|stale)$/,
  );
  if (!match || method !== "POST") return false;
  const context = services.context;
  if (!context)
    throw new InputError("Context manifests are not available", 503);
  const input = (await body(262144)) ?? {};
  if (match[2] === "preview") {
    send(
      200,
      context.build({
        workspaceId: match[1],
        taskId: input.taskId ?? null,
        agentId: input.agentId ?? null,
        files: input.files ?? [],
        documents: input.documents ?? [],
        instructions: input.instructions ?? [],
        maxFileBytes:
          Number.isFinite(input.maxFileBytes) && input.maxFileBytes > 0
            ? input.maxFileBytes
            : undefined,
      }),
    );
    return true;
  }
  services.hub.get(match[1]);
  send(200, context.detectStale(input.manifest, { workspaceId: match[1] }));
  return true;
}
