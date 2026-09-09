import { InputError } from "../../../core/src/TaskStore.js";
import {
  exportWorkspace,
  importWorkspace,
} from "../../../core/src/export/manifest.js";

/**
 * GET  /api/workspaces/:id/export        → portable manifest
 * POST /api/workspaces/import {manifest, name, rootPath?}
 * Register BEFORE routes/workspaces.js (the import path would otherwise be
 * read as workspace id "import").
 */
export default async function exportRoutes(ctx) {
  const { method, path, send, body, services, actor } = ctx;
  if (method === "POST" && path === "/api/workspaces/import") {
    const input = (await body(1024 * 1024)) ?? {};
    if (!input.manifest) throw new InputError("manifest is required");
    const result = importWorkspace(services, input.manifest, {
      name: input.name,
      rootPath: input.rootPath ?? null,
    });
    services.audit?.record?.({
      actor,
      action: "workspace.import",
      target: result.workspace.id,
      workspaceId: result.workspace.id,
      details: { tasks: result.tasks, agents: result.agents },
    });
    send(201, result);
    return true;
  }
  const match = path.match(/^\/api\/workspaces\/([^/]+)\/export$/);
  if (match && method === "GET") {
    services.audit?.record?.({
      actor,
      action: "workspace.export",
      target: match[1],
      workspaceId: match[1],
    });
    send(200, exportWorkspace(services, match[1]));
    return true;
  }
  return false;
}
