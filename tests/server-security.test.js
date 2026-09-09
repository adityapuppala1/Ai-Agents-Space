import test from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { createServices } from "../packages/core/src/services.js";
import {
  createWorkspaceServer,
  remoteBind,
} from "../packages/server/src/server.js";

async function listen(t, options = {}) {
  const services = createServices({ demo: false });
  const server = createWorkspaceServer({ services, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    server,
    services,
    base: `http://127.0.0.1:${server.address().port}`,
  };
}

test("a malformed WebSocket upgrade target is rejected without crashing the server", async (t) => {
  const { server, base } = await listen(t);
  const port = server.address().port;
  const request = [
    "GET http://[ HTTP/1.1",
    "Host: 127.0.0.1",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ].join("\r\n");
  await new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(request));
    socket.on("data", () => {});
    socket.on("error", () => resolve());
    socket.on("close", () => resolve());
    const timer = setTimeout(() => {
      socket.destroy();
      resolve();
    }, 1000);
    timer.unref();
  });
  // Still alive and serving.
  const response = await fetch(base + "/api/health");
  assert.equal(response.status, 200);
  // A well-formed but unauthorized upgrade is also just closed.
  await new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () =>
      socket.write(request.replace("http://[", "/ws?workspace=missing")),
    );
    socket.on("error", () => resolve());
    socket.on("close", () => resolve());
  });
  assert.equal((await fetch(base + "/api/health")).status, 200);
});

test("binding to a non-loopback host without AGENT_SPACE_TOKEN is refused", async () => {
  assert.equal(remoteBind(undefined), false);
  assert.equal(remoteBind("127.0.0.1"), false);
  assert.equal(remoteBind("localhost"), false);
  assert.equal(remoteBind("0.0.0.0"), true);
  assert.equal(remoteBind("192.168.1.5"), true);
  const services = createServices({ demo: false });
  try {
    assert.throws(
      () => createWorkspaceServer({ services, allowRemote: true }),
      /AGENT_SPACE_TOKEN/,
    );
    assert.throws(
      () => createWorkspaceServer({ services, allowRemote: true, token: "" }),
      /AGENT_SPACE_TOKEN/,
    );
  } finally {
    await services.close();
  }
});

test("token mode: every API route needs the bearer token, except the local Claude Code hook POST", async (t) => {
  const { base } = await listen(t, { token: "s3cret" });
  const api = (path, init = {}) => fetch(base + path, init);
  assert.equal((await api("/api/workspaces")).status, 401);
  assert.equal(
    (
      await api("/api/workspaces", {
        headers: { Authorization: "Bearer wrong" },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await api("/api/workspaces", {
        headers: { Authorization: "Bearer s3cre" },
      })
    ).status,
    401,
    "prefix of the token",
  );
  assert.equal(
    (
      await api("/api/workspaces", {
        headers: { Authorization: "Bearer s3cret" },
      })
    ).status,
    200,
  );
  assert.equal((await api("/api/workspaces?token=s3cret")).status, 200);
  // The hook has no credential of its own; from this machine it is accepted
  // so policy keeps applying (it can only record and ask).
  const hook = await api("/api/hooks/claude-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "hook-local-1",
      cwd: process.cwd(),
    }),
  });
  assert.equal(hook.status, 200);
  // Only that one path: the installer still needs the token.
  const install = await api("/api/hooks/claude-code/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(install.status, 401);
  assert.equal((await api("/api/hooks/claude-code/status")).status, 401);
});
