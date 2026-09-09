import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname, sep } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { InputError } from "../../core/src/TaskStore.js";
import { DEMO_WORKSPACE_ID } from "../../core/src/WorkspaceHub.js";
import { createServices } from "../../core/src/services.js";
import { routes as defaultRoutes } from "./routes/index.js";

const webRoot = fileURLToPath(
  new URL("../../../apps/web/dist/", import.meta.url),
);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
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

async function readBody(req, limit = 16384) {
  if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json")
    throw new InputError("Use application/json", 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit)
      throw new InputError(`Request exceeds ${limit / 1024} KB`, 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new InputError("Malformed JSON");
  }
}

/**
 * Local HTTP + WebSocket server.
 *
 * options: { db, dbPath, demo, services, routes, token, allowRemote }
 *  - services: a pre-built container from createServices(); otherwise one is
 *    created from db/dbPath/demo.
 *  - token: when set, every request and socket must carry
 *    `Authorization: Bearer <token>` or `?token=` (shared/remote mode).
 *  - allowRemote: accept non-loopback Host headers (requires token).
 *
 * WebSocket channels:
 *  - /ws?workspace=<id>   → { event: "workspace:snapshot", payload }
 *  - /ws?channel=global   → { event: "global:snapshot", payload }
 */
export function createWorkspaceServer(options = {}) {
  const services =
    options.services ??
    createServices({
      db: options.db,
      dbPath: options.dbPath,
      demo: options.demo,
    });
  const { hub, db, bus } = services;
  const routes = options.routes ?? defaultRoutes;
  const token = options.token ?? process.env.AGENT_SPACE_TOKEN ?? null;
  const allowRemote =
    options.allowRemote ??
    (process.env.HOST !== undefined && process.env.HOST !== "127.0.0.1");

  const authorized = (req, url) => {
    if (!token) return true;
    const header = req.headers.authorization ?? "";
    if (header === `Bearer ${token}`) return true;
    if (url.searchParams.get("token") === token) return true;
    return false;
  };
  const hostOk = (req) =>
    allowedHost(req.headers.host) || (allowRemote && token);
  const originOk = (req) => {
    if (!req.headers.origin) return true;
    if (req.headers.origin === `http://${req.headers.host}`) return true;
    if (req.headers.origin === `https://${req.headers.host}`) return true;
    return false;
  };

  const server = createServer(async (req, res) => {
    const send = (status, data, headers = {}) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...headers,
      });
      res.end(JSON.stringify(data));
    };
    let url;
    try {
      url = new URL(req.url, "http://localhost");
      if (!hostOk(req)) throw new InputError("Host not allowed", 403);
      if (!originOk(req)) throw new InputError("Origin not allowed", 403);
      if (url.pathname.startsWith("/api/") && !authorized(req, url))
        throw new InputError("Unauthorized", 401);
      let parsedBody;
      const ctx = {
        req,
        res,
        method: req.method,
        path: url.pathname,
        url,
        query: url.searchParams,
        send,
        body: async (limit) => (parsedBody ??= await readBody(req, limit)),
        services,
        hub,
        db,
        bus,
        actor: token ? "token" : "local-user",
      };
      for (const route of routes) {
        if (await route(ctx)) return;
      }
      if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
        const target = resolve(
          webRoot,
          "." +
            decodeURIComponent(
              url.pathname === "/" ? "/index.html" : url.pathname,
            ),
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
              url.pathname === "/"
                ? "Build the web app with npm run build first."
                : "File not found",
          });
        }
      }
      return send(404, { error: "Route not found" });
    } catch (error) {
      if (!(error instanceof InputError)) console.error(error);
      if (!res.headersSent)
        send(error instanceof InputError ? error.status : 500, {
          error:
            error instanceof InputError
              ? error.message
              : "Internal server error",
        });
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16384 });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    const channel = url.searchParams.get("channel");
    const workspaceId = url.searchParams.get("workspace") ?? DEMO_WORKSPACE_ID;
    if (
      !hostOk(req) ||
      url.pathname !== "/ws" ||
      !originOk(req) ||
      !authorized(req, url) ||
      (channel !== "global" && !hub.has(workspaceId))
    )
      return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.channel = channel === "global" ? "global" : "workspace";
      ws.workspaceId = ws.channel === "workspace" ? workspaceId : null;
      wss.emit("connection", ws, req);
    });
  });
  const deliver = (ws, event, payload) => {
    if (ws.bufferedAmount > 1024 * 1024) return ws.terminate();
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ event, payload }));
  };
  const broadcastWorkspace = (workspaceId, snapshot) => {
    const payload = { ...snapshot, workspaces: hub.list() };
    for (const ws of wss.clients)
      if (ws.channel === "workspace" && ws.workspaceId === workspaceId)
        deliver(ws, "workspace:snapshot", payload);
  };
  const broadcastAllWorkspaces = () => {
    const cache = new Map();
    for (const ws of wss.clients) {
      if (ws.channel !== "workspace") continue;
      if (!cache.has(ws.workspaceId)) {
        try {
          cache.set(ws.workspaceId, hub.snapshot(ws.workspaceId));
        } catch {
          continue;
        }
      }
      deliver(ws, "workspace:snapshot", cache.get(ws.workspaceId));
    }
  };
  let globalTimer = null;
  const broadcastGlobal = () => {
    // Coalesce bursts of global changes into one broadcast per tick.
    if (globalTimer) return;
    globalTimer = setTimeout(() => {
      globalTimer = null;
      let payload;
      try {
        payload = services.globalSnapshot();
      } catch (error) {
        console.error(error);
        return;
      }
      for (const ws of wss.clients)
        if (ws.channel === "global") deliver(ws, "global:snapshot", payload);
    }, 50);
    globalTimer.unref?.();
  };
  const forceWorkspace = (workspaceId) => {
    try {
      broadcastWorkspace(workspaceId, hub.get(workspaceId).snapshot());
    } catch {
      /* unknown workspace */
    }
  };
  hub.on("change", broadcastWorkspace);
  hub.on("workspaces", () => {
    broadcastAllWorkspaces();
    broadcastGlobal();
  });
  bus.on("global", broadcastGlobal);
  bus.on("workspace", forceWorkspace);
  wss.on("connection", (ws) => {
    ws.on("error", () => ws.terminate());
    if (ws.channel === "global")
      deliver(ws, "global:snapshot", services.globalSnapshot());
    else deliver(ws, "workspace:snapshot", hub.snapshot(ws.workspaceId));
  });
  const timer = setInterval(() => hub.tick(), 8000);
  timer.unref();
  server.on("close", () => {
    clearInterval(timer);
    clearTimeout(globalTimer);
    hub.removeListener("change", broadcastWorkspace);
    bus.removeListener("global", broadcastGlobal);
    bus.removeListener("workspace", forceWorkspace);
    wss.close();
    services.close();
  });
  const close = server.close.bind(server);
  server.close = (callback) => {
    for (const ws of wss.clients) ws.terminate();
    return close(callback);
  };
  server.hub = hub;
  server.services = services;
  return server;
}
