import { InputError } from "../../../core/src/TaskStore.js";
import { DEMO_WORKSPACE_ID } from "../../../core/src/WorkspaceHub.js";
import { schemaVersion } from "../../../core/src/db.js";

/**
 * Workspace, task, agent, run, and demo routes. Returns true when handled.
 * Unscoped legacy routes (/api/tasks, /api/workspace, /api/demo) target the
 * demo workspace or the one named by ?workspace=<id>.
 */
export default async function workspaceRoutes(ctx) {
  const { method, path, url, send, body, hub, db } = ctx;

  if (method === "GET" && path === "/api/health") {
    send(200, {
      status: "ok",
      mode: hub.get(DEMO_WORKSPACE_ID).demoRunning ? "demo" : "manual",
      taskCount: hub.get(DEMO_WORKSPACE_ID).store.list().length,
      workspaces: hub.list().length,
      schemaVersion: schemaVersion(db),
    });
    return true;
  }
  if (path === "/api/workspaces") {
    if (method === "GET") {
      send(
        200,
        hub.list({ includeArchived: url.searchParams.get("archived") === "1" }),
      );
      return true;
    }
    if (method === "POST") {
      send(201, hub.create(await body()));
      return true;
    }
  }
  const scoped = path.match(/^\/api\/workspaces\/([^/]+)(\/.*)?$/);
  if (scoped && !scoped[2]) {
    if (method === "GET") {
      send(200, hub.get(scoped[1]).record);
      return true;
    }
    if (method === "PATCH") {
      send(200, hub.update(scoped[1], await body()));
      return true;
    }
  }
  if (scoped && method === "POST" && scoped[2] === "/archive") {
    send(200, hub.archive(scoped[1]));
    return true;
  }
  if (scoped && method === "POST" && scoped[2] === "/restore") {
    send(200, hub.restore(scoped[1]));
    return true;
  }
  if (!path.startsWith("/api/")) return false;

  const workspaceId = scoped
    ? scoped[1]
    : (url.searchParams.get("workspace") ?? DEMO_WORKSPACE_ID);
  const rest = scoped ? scoped[2] : path.slice("/api".length);
  const legacy = /^\/(workspace|tasks|runs|demo|agents)(\/|$)/.test(rest);
  if (!scoped && !legacy) return false;
  const workspace = hub.get(workspaceId);
  ctx.workspace = workspace;
  ctx.rest = rest;

  if (method === "GET" && rest === "/workspace") {
    send(200, hub.snapshot(workspace.id));
    return true;
  }
  if (method === "GET" && rest === "/tasks") {
    send(200, workspace.store.list());
    return true;
  }
  if (method === "POST" && rest === "/tasks") {
    send(201, workspace.create(await body()));
    return true;
  }
  if (method === "GET" && rest === "/runs") {
    send(200, workspace.runs());
    return true;
  }
  if (method === "POST" && rest === "/demo") {
    const input = await body();
    if (input?.action === "reset") workspace.loadDemo();
    else workspace.setDemo(input?.running);
    send(200, hub.snapshot(workspace.id));
    return true;
  }
  const assignment = rest.match(/^\/tasks\/([^/]+)\/assign$/);
  if (method === "POST" && assignment) {
    send(200, workspace.assign(assignment[1], (await body())?.agentId));
    return true;
  }
  const task = rest.match(/^\/tasks\/([^/]+)$/);
  if (method === "PATCH" && task) {
    send(200, workspace.update(task[1], await body()));
    return true;
  }
  if (method === "GET" && rest === "/agents") {
    send(
      200,
      workspace.profiles.list({
        includeArchived: url.searchParams.get("archived") === "1",
      }),
    );
    return true;
  }
  if (method === "POST" && rest === "/agents") {
    send(201, workspace.createAgent(await body()));
    return true;
  }
  const agent = rest.match(/^\/agents\/([^/]+)$/);
  if (method === "PATCH" && agent) {
    send(200, workspace.updateAgent(agent[1], await body()));
    return true;
  }
  const agentAction = rest.match(
    /^\/agents\/([^/]+)\/(duplicate|archive|restore)$/,
  );
  if (method === "POST" && agentAction) {
    const [, id, verb] = agentAction;
    const result =
      verb === "duplicate"
        ? workspace.duplicateAgent(id)
        : verb === "archive"
          ? workspace.archiveAgent(id)
          : workspace.restoreAgent(id);
    send(verb === "duplicate" ? 201 : 200, result);
    return true;
  }
  return false;
}

export { InputError };
