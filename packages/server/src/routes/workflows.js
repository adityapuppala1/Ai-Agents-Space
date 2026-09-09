import { InputError } from "../../../core/src/TaskStore.js";
import {
  listTemplates,
  getTemplate,
} from "../../../core/src/workflows/templates/index.js";

/**
 * Templates, workflows, and the task dependency graph.
 * Register BEFORE routes/workspaces.js (uses /api/workspaces/:id/... paths).
 * Requires services.workflows (WorkflowService) whose `.graph` is a TaskGraph.
 */
export default async function workflowRoutes(ctx) {
  const { method, path, send, body, services, actor } = ctx;
  if (!path.startsWith("/api/")) return false;

  if (method === "GET" && path === "/api/templates") {
    send(200, listTemplates());
    return true;
  }
  const template = path.match(/^\/api\/templates\/([^/]+)$/);
  if (method === "GET" && template) {
    send(200, getTemplate(decodeURIComponent(template[1])));
    return true;
  }

  const workflows = services.workflows;
  const graph = workflows?.graph ?? services.graph;

  const workflow = path.match(/^\/api\/workflows\/([^/]+)(\/archive)?$/);
  if (workflow) {
    if (!workflows) throw new InputError("Workflows are not available", 503);
    if (method === "GET" && !workflow[2]) {
      send(200, workflows.get(workflow[1]));
      return true;
    }
    if (method === "POST" && workflow[2]) {
      send(200, workflows.archive(workflow[1], { actor }));
      return true;
    }
  }

  const scoped = path.match(
    /^\/api\/workspaces\/([^/]+)\/(workflows|graph|tasks\/([^/]+)\/dependencies|tasks\/ready)$/,
  );
  if (!scoped) return false;
  const workspaceId = scoped[1];
  const rest = scoped[2];

  if (rest === "workflows") {
    if (!workflows) throw new InputError("Workflows are not available", 503);
    if (method === "GET") {
      send(200, workflows.list(workspaceId));
      return true;
    }
    if (method === "POST") {
      const input = (await body(65536)) ?? {};
      if (!input.templateId) throw new InputError("templateId is required");
      send(
        201,
        workflows.instantiate(workspaceId, input.templateId, {
          inputs: input.inputs ?? {},
          provider: input.provider ?? null,
          agentByRole: input.agentByRole ?? {},
          actor,
        }),
      );
      return true;
    }
  }
  if (!graph) throw new InputError("Task graph is not available", 503);
  if (method === "GET" && rest === "graph") {
    send(200, graph.graph(workspaceId));
    return true;
  }
  if (method === "GET" && rest === "tasks/ready") {
    services.hub.get(workspaceId);
    send(200, graph.ready(workspaceId));
    return true;
  }
  if (method === "PATCH" && scoped[3]) {
    const input = (await body()) ?? {};
    send(
      200,
      graph.setDependencies(workspaceId, scoped[3], input.dependsOn ?? [], {
        actor,
      }),
    );
    return true;
  }
  return false;
}
