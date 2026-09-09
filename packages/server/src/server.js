import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname, sep } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { InputError } from "../../core/src/TaskStore.js";
import {
  WorkspaceHub,
  DEMO_WORKSPACE_ID,
} from "../../core/src/WorkspaceHub.js";
import { openDatabase, schemaVersion } from "../../core/src/db.js";

const webRoot = fileURLToPath(
  new URL("../../../apps/web/dist/", import.meta.url),
);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function allowedHost(host) {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(
      new URL(`http://${host}`).hostname,
    );
  } catch {
    return false;
  }
}

async function body(req) {
  if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json")
    throw new InputError("Use application/json", 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw new InputError("Request exceeds 16 KB", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new InputError("Malformed JSON");
  }
}

/**
 * Creates the local HTTP + WebSocket server.
 *
 * Routes are workspace-scoped under /api/workspaces/:id/... . The legacy
 * unscoped routes (/api/tasks, /api/workspace, /api/demo) target the demo
 * workspace, or the one named by a ?workspace=<id> query parameter.
 */
export function createWorkspaceServer(options = {}) {
  const ownsDatabase = !options.db;
  const db = options.db ?? openDatabase(options.dbPath ?? ":memory:");
  const hub = new WorkspaceHub(db, { demo: options.demo ?? false });

  const workspaceRoutes = (method, rest, workspace, req) => {
    const send = req.send;
    if (method === "GET" && rest === "/workspace")
      return send(200, hub.snapshot(workspace.id));
    if (method === "GET" && rest === "/tasks")
      return send(200, workspace.store.list());
    if (method === "POST" && rest === "/tasks")
      return body(req).then((input) => send(201, workspace.create(input)));
    if (method === "GET" && rest === "/runs")
      return send(200, workspace.runs());
    if (method === "POST" && rest === "/demo")
      return body(req).then((input) => {
        if (input?.action === "reset") workspace.loadDemo();
        else workspace.setDemo(input?.running);
        return send(200, hub.snapshot(workspace.id));
      });
    const assignment = rest.match(/^\/tasks\/([^/]+)\/assign$/);
    if (method === "POST" && assignment)
      return body(req).then((input) =>
        send(200, workspace.assign(assignment[1], input?.agentId)),
      );
    const task = rest.match(/^\/tasks\/([^/]+)$/);
    if (method === "PATCH" && task)
      return body(req).then((input) =>
        send(200, workspace.update(task[1], input)),
      );
    if (method === "GET" && rest === "/agents")
      return send(
        200,
        workspace.profiles.list({
          includeArchived: req.query.get("archived") === "1",
        }),
      );
    if (method === "POST" && rest === "/agents")
      return body(req).then((input) => send(201, workspace.createAgent(input)));
    const agent = rest.match(/^\/agents\/([^/]+)$/);
    if (method === "PATCH" && agent)
      return body(req).then((input) =>
        send(200, workspace.updateAgent(agent[1], input)),
      );
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
      return send(verb === "duplicate" ? 201 : 200, result);
    }
    return send(404, { error: "Route not found" });
  };

  const server = createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(data));
    };
    req.send = send;
    try {
      if (!allowedHost(req.headers.host))
        throw new InputError("Host not allowed", 403);
      // Reject browser requests from unrelated origins; service binds to loopback.
      if (
        req.headers.origin &&
        req.headers.origin !== `http://${req.headers.host}`
      )
        throw new InputError("Origin not allowed", 403);
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname;
      req.query = url.searchParams;

      if (req.method === "GET" && path === "/api/health")
        return send(200, {
          status: "ok",
          mode: hub.get(DEMO_WORKSPACE_ID).demoRunning ? "demo" : "manual",
          taskCount: hub.get(DEMO_WORKSPACE_ID).store.list().length,
          workspaces: hub.list().length,
          schemaVersion: schemaVersion(db),
        });
      if (path === "/api/workspaces") {
        if (req.method === "GET")
          return send(
            200,
            hub.list({
              includeArchived: url.searchParams.get("archived") === "1",
            }),
          );
        if (req.method === "POST")
          return send(201, hub.create(await body(req)));
      }
      const scoped = path.match(/^\/api\/workspaces\/([^/]+)(\/.*)?$/);
      if (scoped && !scoped[2]) {
        if (req.method === "GET") return send(200, hub.get(scoped[1]).record);
        if (req.method === "PATCH")
          return send(200, hub.update(scoped[1], await body(req)));
      }
      if (scoped && req.method === "POST" && scoped[2] === "/archive")
        return send(200, hub.archive(scoped[1]));
      if (scoped && req.method === "POST" && scoped[2] === "/restore")
        return send(200, hub.restore(scoped[1]));

      if (path.startsWith("/api/")) {
        const workspaceId = scoped
          ? scoped[1]
          : (url.searchParams.get("workspace") ?? DEMO_WORKSPACE_ID);
        const rest = scoped ? scoped[2] : path.slice("/api".length);
        return await workspaceRoutes(
          req.method,
          rest,
          hub.get(workspaceId),
          req,
        );
      }

      if (req.method === "GET") {
        const target = resolve(
          webRoot,
          "." + decodeURIComponent(path === "/" ? "/index.html" : path),
        );
        if (!target.startsWith(resolve(webRoot) + sep))
          return send(403, { error: "Forbidden" });
        try {
          const content = await readFile(target);
          res.writeHead(200, {
            "Content-Type": mime[extname(target)] ?? "application/octet-stream",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy":
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'",
          });
          return res.end(content);
        } catch (error) {
          if (error.code !== "ENOENT" && error.code !== "EISDIR") throw error;
          return send(404, {
            error:
              path === "/"
                ? "Build the web app with npm run build first."
                : "File not found",
          });
        }
      }
      return send(404, { error: "Route not found" });
    } catch (error) {
      if (!(error instanceof InputError)) console.error(error);
      send(error instanceof InputError ? error.status : 500, {
        error:
          error instanceof InputError ? error.message : "Internal server error",
      });
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16384 });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    const workspaceId = url.searchParams.get("workspace") ?? DEMO_WORKSPACE_ID;
    if (
      !allowedHost(req.headers.host) ||
      url.pathname !== "/ws" ||
      !hub.has(workspaceId) ||
      (req.headers.origin &&
        req.headers.origin !== `http://${req.headers.host}`)
    )
      return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.workspaceId = workspaceId;
      wss.emit("connection", ws, req);
    });
  });
  const deliver = (ws, snapshot) => {
    if (ws.bufferedAmount > 1024 * 1024) return ws.terminate();
    if (ws.readyState === WebSocket.OPEN)
      ws.send(
        JSON.stringify({ event: "workspace:snapshot", payload: snapshot }),
      );
  };
  const broadcast = (workspaceId, snapshot) => {
    const payload = { ...snapshot, workspaces: hub.list() };
    for (const ws of wss.clients)
      if (ws.workspaceId === workspaceId) deliver(ws, payload);
  };
  const broadcastAll = () => {
    const cache = new Map();
    for (const ws of wss.clients) {
      if (!cache.has(ws.workspaceId))
        cache.set(ws.workspaceId, hub.snapshot(ws.workspaceId));
      deliver(ws, cache.get(ws.workspaceId));
    }
  };
  hub.on("change", broadcast);
  hub.on("workspaces", broadcastAll);
  wss.on("connection", (ws) => {
    ws.on("error", () => ws.terminate());
    deliver(ws, hub.snapshot(ws.workspaceId));
  });
  const timer = setInterval(() => hub.tick(), 8000);
  timer.unref();
  server.on("close", () => {
    clearInterval(timer);
    hub.removeListener("change", broadcast);
    hub.removeListener("workspaces", broadcastAll);
    wss.close();
    if (ownsDatabase) db.close();
  });
  const close = server.close.bind(server);
  server.close = (callback) => {
    for (const ws of wss.clients) ws.terminate();
    return close(callback);
  };
  server.hub = hub;
  return server;
}
