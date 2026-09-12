import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
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

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]", "::1"];
const LOOPBACK_ADDRESSES = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
const HOOK_PATH = "/api/hooks/claude-code";

function allowedHost(host) {
  try {
    return LOOPBACK_HOSTS.includes(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

/** True when the TCP peer is this machine (not just a spoofable Host header). */
function loopbackSocket(req) {
  return LOOPBACK_ADDRESSES.includes(req.socket?.remoteAddress ?? "");
}

function sameSecret(given, expected) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(String(expected ?? ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Whether the process binds to something other than loopback. */
export function remoteBind(host) {
  return host !== undefined && !LOOPBACK_HOSTS.includes(host);
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
  const allowRemote = options.allowRemote ?? remoteBind(process.env.HOST);
  if (allowRemote && !token)
    throw new Error(
      "HOST is not loopback; set AGENT_SPACE_TOKEN before accepting remote clients (every API route would otherwise be open to the network)",
    );

  const authorized = (req, url) => {
    if (!token) return true;
    const header = req.headers.authorization ?? "";
    if (header.startsWith("Bearer ") && sameSecret(header.slice(7), token))
      return true;
    if (sameSecret(url.searchParams.get("token"), token)) return true;
    return false;
  };
  // The Claude Code hook runs on this machine with no credential of its
  // own; in token mode a hook POST from a loopback peer is accepted so the
  // policy keeps applying (it can only record and ask, never launch).
  const localHook = (req, url) =>
    req.method === "POST" &&
    url.pathname === HOOK_PATH &&
    loopbackSocket(req) &&
    allowedHost(req.headers.host);
  const hostOk = (req) =>
    allowedHost(req.headers.host) || (allowRemote && !!token);
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
      if (
        url.pathname.startsWith("/api/") &&
        !authorized(req, url) &&
        !localHook(req, url)
      )
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
              // No 'unsafe-inline' anywhere, for scripts or styles. The
              // interface never needs it: React applies a style prop through
              // CSSOM rather than a style attribute, nothing calls
              // setAttribute("style") or assigns cssText, and the built
              // index.html carries no <style> tag. Verified by the route
              // audit, which renders every route at every viewport in both
              // themes and fails on a console error — which is how a refused
              // inline style announces itself.
              "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'",
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
    // A malformed request-target must not become an uncaught exception.
    socket.on("error", () => {});
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return socket.destroy();
    }
    try {
      const channel = url.searchParams.get("channel");
      const workspaceId =
        url.searchParams.get("workspace") ?? DEMO_WORKSPACE_ID;
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
    } catch (error) {
      console.error(error);
      socket.destroy();
    }
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
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });
    ws.on("error", () => ws.terminate());
    if (ws.channel === "global")
      deliver(ws, "global:snapshot", services.globalSnapshot());
    else deliver(ws, "workspace:snapshot", hub.snapshot(ws.workspaceId));
  });
  const timer = setInterval(() => hub.tick(), 8000);
  timer.unref();
  // Heartbeat: half-open clients (sleep, network switch) are reaped instead
  // of lingering until the OS TCP timeout.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, 30000);
  heartbeat.unref();
  server.on("close", () => {
    clearInterval(timer);
    clearInterval(heartbeat);
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
