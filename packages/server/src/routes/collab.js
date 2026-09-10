import { InputError } from "../../../core/src/TaskStore.js";
import { Handover } from "../../../core/src/collab/Handover.js";
import { Decisions } from "../../../core/src/collab/Decisions.js";

/**
 * Human collaboration routes (roadmap §12): handover briefs and decision
 * history.
 *
 *   POST   /api/workspaces/:id/handover/preview {taskId?, runId?}
 *          builds a brief from stored records without saving it
 *   POST   /api/workspaces/:id/handover         {taskId?, runId?}
 *          builds and stores version 1
 *   GET    /api/workspaces/:id/handover         ?taskId=&runId=
 *   GET    /api/handover/:id                    latest version
 *   PUT    /api/handover/:id                    {body, editedBy?}  → new version
 *   POST   /api/handover/:id/refresh            regenerates the baseline
 *   GET    /api/handover/:id/history            every version, oldest first
 *
 *   GET    /api/decisions?workspace=&run=&approval=
 *   GET    /api/workspaces/:id/decisions
 *   GET    /api/runs/:id/decisions
 *
 * MUST be registered in routes/index.js BEFORE workspaces.js, because that
 * module owns the generic /api/workspaces/:id prefix.
 *
 * The services are attached on first use when the container did not compose
 * them, so the routes work in any build that has migration 8 applied.
 */
export default async function collabRoutes(ctx) {
  const { method, path, query, send, body, services, actor } = ctx;

  const wsHandover = path.match(
    /^\/api\/workspaces\/([^/]+)\/handover(\/preview)?$/,
  );
  if (wsHandover) {
    const handover = requireHandover(services);
    const workspaceId = decodeURIComponent(wsHandover[1]);
    services.hub.get(workspaceId);
    const preview = Boolean(wsHandover[2]);
    if (method === "GET" && !preview) {
      send(
        200,
        handover.list({
          workspaceId,
          taskId: query.get("taskId") || null,
          runId: query.get("runId") || null,
        }),
      );
      return true;
    }
    if (method === "POST") {
      const input = (await body(65536)) ?? {};
      const args = {
        workspaceId,
        taskId: input.taskId ?? null,
        runId: input.runId ?? null,
      };
      send(
        preview ? 200 : 201,
        preview
          ? handover.build(args)
          : handover.create({
              ...args,
              author: input.author ?? actor ?? "system",
            }),
      );
      return true;
    }
    return false;
  }

  const brief = path.match(/^\/api\/handover\/([^/]+)(\/history|\/refresh)?$/);
  if (brief) {
    const handover = requireHandover(services);
    const id = decodeURIComponent(brief[1]);
    const rest = brief[2] ?? "";
    if (method === "GET" && rest === "") {
      send(200, handover.get(id));
      return true;
    }
    if (method === "GET" && rest === "/history") {
      send(200, handover.history(id));
      return true;
    }
    if (method === "POST" && rest === "/refresh") {
      send(200, handover.refresh({ id, author: actor ?? "system" }));
      return true;
    }
    if ((method === "PUT" || method === "PATCH") && rest === "") {
      const input = (await body(262144)) ?? {};
      send(
        200,
        handover.save({
          id,
          body: input.body,
          editedBy: input.editedBy ?? actor ?? "local-user",
        }),
      );
      return true;
    }
    return false;
  }

  if (path === "/api/decisions" && method === "GET") {
    send(
      200,
      requireDecisions(services).history({
        workspaceId: query.get("workspace") || null,
        runId: query.get("run") || null,
        approvalId: query.get("approval") || null,
      }),
    );
    return true;
  }

  const wsDecisions = path.match(/^\/api\/workspaces\/([^/]+)\/decisions$/);
  if (wsDecisions && method === "GET") {
    const workspaceId = decodeURIComponent(wsDecisions[1]);
    services.hub.get(workspaceId);
    send(
      200,
      requireDecisions(services).history({
        workspaceId,
        runId: query.get("run") || null,
      }),
    );
    return true;
  }

  const runDecisions = path.match(/^\/api\/runs\/([^/]+)\/decisions$/);
  if (runDecisions && method === "GET") {
    send(
      200,
      requireDecisions(services).history({
        runId: decodeURIComponent(runDecisions[1]),
      }),
    );
    return true;
  }

  return false;
}

function requireHandover(services) {
  if (!services.db)
    throw new InputError("Handover briefs are not available", 503);
  services.decisions ??= new Decisions(services);
  services.handover ??= new Handover(services);
  return services.handover;
}

function requireDecisions(services) {
  if (!services.db)
    throw new InputError("Decision history is not available", 503);
  services.decisions ??= new Decisions(services);
  return services.decisions;
}
