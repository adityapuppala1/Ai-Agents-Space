import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname, sep } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { InputError, TaskStore } from "../../core/src/TaskStore.js";
import { Workspace } from "../../core/src/Workspace.js";

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

export function createWorkspaceServer(store = new TaskStore(), options = {}) {
  const workspace = new Workspace(store, options);
  const server = createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(data));
    };
    try {
      if (!allowedHost(req.headers.host))
        throw new InputError("Host not allowed", 403);
      // Reject browser requests from unrelated origins; service binds to loopback.
      if (
        req.headers.origin &&
        req.headers.origin !== `http://${req.headers.host}`
      )
        throw new InputError("Origin not allowed", 403);
      const path = new URL(req.url, "http://localhost").pathname;
      if (req.method === "GET" && path === "/api/health")
        return send(200, {
          status: "ok",
          mode: workspace.demoRunning ? "demo" : "manual",
          taskCount: store.list().length,
        });
      if (req.method === "GET" && path === "/api/workspace")
        return send(200, workspace.snapshot());
      if (req.method === "GET" && path === "/api/tasks")
        return send(200, store.list());
      if (req.method === "POST" && path === "/api/tasks")
        return send(201, workspace.create(await body(req)));
      if (req.method === "POST" && path === "/api/demo") {
        const input = await body(req);
        if (input?.action === "reset") workspace.loadDemo();
        else workspace.setDemo(input?.running);
        return send(200, workspace.snapshot());
      }
      const assignment = path.match(/^\/api\/tasks\/([^/]+)\/assign$/);
      if (req.method === "POST" && assignment)
        return send(
          200,
          workspace.assign(assignment[1], (await body(req))?.agentId),
        );
      const match = path.match(/^\/api\/tasks\/([^/]+)$/);
      if (req.method === "PATCH" && match)
        return send(200, workspace.update(match[1], await body(req)));
      if (req.method === "GET" && !path.startsWith("/api/")) {
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
      send(error instanceof InputError ? error.status : 500, {
        error:
          error instanceof InputError ? error.message : "Internal server error",
      });
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16384 });
  server.on("upgrade", (req, socket, head) => {
    if (
      !allowedHost(req.headers.host) ||
      req.url !== "/ws" ||
      (req.headers.origin &&
        req.headers.origin !== `http://${req.headers.host}`)
    )
      return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  });
  const broadcast = (snapshot) => {
    const message = JSON.stringify({
      event: "workspace:snapshot",
      payload: snapshot,
    });
    for (const ws of wss.clients) {
      if (ws.bufferedAmount > 1024 * 1024) ws.terminate();
      else if (ws.readyState === WebSocket.OPEN) ws.send(message);
    }
  };
  workspace.on("change", broadcast);
  wss.on("connection", (ws) => {
    ws.on("error", () => ws.terminate());
    ws.send(
      JSON.stringify({
        event: "workspace:snapshot",
        payload: workspace.snapshot(),
      }),
    );
  });
  const timer = setInterval(() => workspace.tick(), 8000);
  timer.unref();
  server.on("close", () => {
    clearInterval(timer);
    workspace.removeListener("change", broadcast);
    wss.close();
  });
  const close = server.close.bind(server);
  server.close = (callback) => {
    for (const ws of wss.clients) ws.terminate();
    return close(callback);
  };
  return server;
}
