import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createMcpServer } from "../packages/core/src/mcp/server.js";
import { DECISION_SETTING, TOOLS } from "../packages/core/src/mcp/tools.js";
import { RESOURCES } from "../packages/core/src/mcp/resources.js";

const BIN = fileURLToPath(
  new URL("../bin/agent-space-mcp.js", import.meta.url),
);

/**
 * HTTP bridge stub. `routes` maps "METHOD /path" to a value or a function;
 * every call is recorded so a test can assert what reached the server.
 */
function stubClient(routes = {}) {
  const calls = [];
  const answer = (method, path, body) => {
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    if (!(key in routes)) throw new Error(`stub has no route for ${key}`);
    const value = routes[key];
    return typeof value === "function" ? value(body) : value;
  };
  return {
    calls,
    get: async (path) => answer("GET", path),
    post: async (path, body) => answer("POST", path, body),
  };
}

function rpc(id, method, params) {
  return { jsonrpc: "2.0", id, method, params };
}

/** Parses the JSON payload a tool result carries in its first text block. */
function toolJson(response) {
  assert.equal(
    response.result.isError,
    false,
    response.result.content?.[0]?.text,
  );
  return JSON.parse(response.result.content[0].text);
}

test("the MCP handshake answers with the protocol version, capabilities and server info", async () => {
  const server = createMcpServer({ client: stubClient(), version: "9.9.9" });
  const response = await server.handle(
    rpc(1, "initialize", {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "test-client", version: "1" },
      capabilities: {},
    }),
  );
  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, "2025-06-18");
  assert.deepEqual(response.result.capabilities, { tools: {}, resources: {} });
  assert.deepEqual(response.result.serverInfo, {
    name: "agent-space",
    version: "9.9.9",
  });

  // An unknown protocol revision is answered with the one we do speak.
  const older = await server.handle(
    rpc(2, "initialize", { protocolVersion: "1999-01-01" }),
  );
  assert.equal(older.result.protocolVersion, "2025-06-18");

  // notifications/initialized is a notification: no response, ever.
  assert.equal(server.initialized, false);
  assert.equal(
    await server.handle({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
    null,
  );
  assert.equal(server.initialized, true);
});

test("tools/list describes every tool with a JSON Schema and honest wording", async () => {
  const server = createMcpServer({ client: stubClient() });
  const response = await server.handle(rpc(3, "tools/list"));
  const tools = response.result.tools;
  assert.equal(tools.length, TOOLS.length);
  const names = tools.map((tool) => tool.name);
  for (const expected of [
    "list_workspaces",
    "list_tasks",
    "get_task",
    "create_task",
    "list_runs",
    "get_run",
    "list_live_sessions",
    "get_inbox",
    "decide_approval",
    "search_events",
    "get_analytics",
  ])
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(tool.description.length > 20);
  }
  // The two state-changing tools must say so, and be marked as such.
  const create = tools.find((tool) => tool.name === "create_task");
  assert.match(create.description, /CREATES/);
  assert.equal(create.annotations.readOnlyHint, false);
  const decide = tools.find((tool) => tool.name === "decide_approval");
  assert.match(decide.description, /mcp\.allowDecisions/);
  assert.equal(decide.annotations.readOnlyHint, false);
});

test("tools/call runs a read tool through the HTTP API", async () => {
  const client = stubClient({
    "GET /api/workspaces": [{ id: "w1", name: "Rooted" }],
    "GET /api/workspaces/w1/tasks": [
      { id: "t1", title: "Fix", status: "BLOCKED" },
      { id: "t2", title: "Ship", status: "IN_PROGRESS" },
    ],
  });
  const server = createMcpServer({ client });
  const workspaces = await server.handle(
    rpc(4, "tools/call", { name: "list_workspaces", arguments: {} }),
  );
  assert.deepEqual(toolJson(workspaces), [{ id: "w1", name: "Rooted" }]);

  const filtered = await server.handle(
    rpc(5, "tools/call", {
      name: "list_tasks",
      arguments: { workspaceId: "w1", status: "blocked" },
    }),
  );
  const payload = toolJson(filtered);
  assert.equal(payload.count, 1);
  assert.equal(payload.tasks[0].id, "t1");
});

test("a failing tool reports the server's reason instead of an empty result", async () => {
  const client = {
    get: async () => {
      throw new Error("No Agent Space answered at http://127.0.0.1:4173");
    },
    post: async () => {
      throw new Error("unused");
    },
  };
  const server = createMcpServer({ client });
  const response = await server.handle(
    rpc(6, "tools/call", { name: "list_workspaces", arguments: {} }),
  );
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /No Agent Space answered/);
});

test("decide_approval is refused while mcp.allowDecisions is off, and audited as mcp when on", async () => {
  const off = stubClient({ "GET /api/settings": { "ui.graphics": "medium" } });
  const refused = await createMcpServer({ client: off }).handle(
    rpc(7, "tools/call", {
      name: "decide_approval",
      arguments: { approvalId: "a1", decision: "approve" },
    }),
  );
  assert.equal(refused.result.isError, true);
  assert.match(
    refused.result.content[0].text,
    /mcp\.allowDecisions is not enabled/,
  );
  // Nothing was decided: only the settings read reached the server.
  assert.deepEqual(
    off.calls.map((call) => call.path),
    ["/api/settings"],
  );

  const on = stubClient({
    "GET /api/settings": { [DECISION_SETTING]: true },
    "POST /api/approvals/a1/decide": (body) => ({
      id: "a1",
      status: "approved",
      decidedBy: `local-user:${body.actor}`,
      note: body.note,
    }),
  });
  const allowed = await createMcpServer({ client: on }).handle(
    rpc(8, "tools/call", {
      name: "decide_approval",
      arguments: { approvalId: "a1", decision: "approve", note: "looks safe" },
    }),
  );
  const decided = toolJson(allowed);
  assert.equal(decided.decidedBy, "mcp");
  assert.equal(decided.approval.status, "approved");
  const post = on.calls.find((call) => call.method === "POST");
  assert.deepEqual(post.body, {
    decision: "approve",
    note: "looks safe",
    actor: "mcp",
  });
});

test("resources/list and resources/read serve the architecture document as text", async () => {
  const server = createMcpServer({ client: stubClient() });
  const list = await server.handle(rpc(9, "resources/list"));
  assert.deepEqual(
    list.result.resources.map((resource) => resource.uri),
    RESOURCES.map((resource) => resource.uri),
  );
  assert.ok(
    list.result.resources.some(
      (resource) => resource.uri === "agent-space://docs/architecture",
    ),
  );

  const templates = await server.handle(rpc(10, "resources/templates/list"));
  assert.deepEqual(
    templates.result.resourceTemplates.map((t) => t.uriTemplate),
    ["agent-space://workspace/{id}/snapshot", "agent-space://run/{id}"],
  );

  const read = await server.handle(
    rpc(11, "resources/read", { uri: "agent-space://docs/architecture" }),
  );
  const contents = read.result.contents[0];
  assert.equal(contents.uri, "agent-space://docs/architecture");
  assert.equal(contents.mimeType, "text/markdown");
  assert.match(contents.text, /Agent Space architecture brief/);

  const roadmap = await server.handle(
    rpc(12, "resources/read", { uri: "agent-space://docs/roadmap-status" }),
  );
  assert.match(roadmap.result.contents[0].text, /Roadmap status/);
});

test("live resources read through the HTTP API", async () => {
  const client = stubClient({
    "GET /api/workspaces": [{ id: "w1" }],
    "GET /api/inbox": { approvals: [], runs: [] },
    "GET /api/workspace?workspace=w1": { workspace: { id: "w1" }, tasks: [] },
    "GET /api/runs/r1": { run: { id: "r1" }, events: [] },
  });
  const server = createMcpServer({ client });
  for (const [uri, probe] of [
    ["agent-space://workspaces", /"id": "w1"/],
    ["agent-space://inbox", /approvals/],
    ["agent-space://workspace/w1/snapshot", /workspace/],
    ["agent-space://run/r1", /"id": "r1"/],
  ]) {
    const response = await server.handle(rpc(13, "resources/read", { uri }));
    assert.equal(response.result.contents[0].mimeType, "application/json");
    assert.match(response.result.contents[0].text, probe);
  }
});

test("protocol errors: unknown method, unknown tool, unknown resource, broken JSON", async () => {
  const server = createMcpServer({ client: stubClient() });

  const unknownMethod = await server.handle(rpc(14, "tools/subscribe"));
  assert.equal(unknownMethod.error.code, -32601);
  assert.match(unknownMethod.error.message, /Unknown method/);

  const unknownTool = await server.handle(
    rpc(15, "tools/call", { name: "delete_everything", arguments: {} }),
  );
  assert.equal(unknownTool.error.code, -32602);

  const unknownResource = await server.handle(
    rpc(16, "resources/read", { uri: "agent-space://nope" }),
  );
  assert.equal(unknownResource.error.code, -32602);

  const parseError = await server.handleLine("{not json");
  assert.equal(parseError.error.code, -32700);
  assert.equal(parseError.id, null);

  const notJsonRpc = await server.handleLine(
    JSON.stringify({ method: "ping" }),
  );
  assert.equal(notJsonRpc.error.code, -32600);

  // Blank lines and notifications produce no frame at all.
  assert.equal(await server.handleLine("   "), null);
  assert.equal(
    await server.handleLine(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled" }),
    ),
    null,
  );
});

test("serve() reads newline-delimited frames, including a split chunk", async () => {
  const { PassThrough } = await import("node:stream");
  const input = new PassThrough();
  const written = [];
  const output = { write: (chunk) => written.push(chunk) };
  const server = createMcpServer({ client: stubClient() });
  const done = server.serve({ input, output });
  input.write(`${JSON.stringify(rpc(1, "ping"))}\n`);
  input.write('{"jsonrpc":"2.0","id":2,"me');
  input.write('thod":"tools/list"}\n');
  input.end();
  await done;
  assert.equal(written.length, 2);
  for (const frame of written) assert.ok(frame.endsWith("\n"));
  const [ping, tools] = written.map((frame) => JSON.parse(frame));
  assert.deepEqual(ping.result, {});
  assert.equal(tools.result.tools.length, TOOLS.length);
});

test("the executable speaks JSON-RPC on stdout and nothing else", async () => {
  // A stub Agent Space: the bin must reach it over HTTP, never the database.
  const requests = [];
  const http = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ id: "w1", name: "Stub" }]));
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = http.address().port;
  const child = spawn(
    process.execPath,
    [BIN, "--url", `http://127.0.0.1:${port}`],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  child.stdin.write(`${JSON.stringify(rpc(1, "initialize", {}))}\n`);
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  child.stdin.write(
    `${JSON.stringify(rpc(2, "tools/call", { name: "list_workspaces", arguments: {} }))}\n`,
  );
  child.stdin.end();
  const code = await new Promise((resolve) => child.on("close", resolve));
  http.close();

  assert.equal(code, 0);
  const frames = stdout.split("\n").filter((line) => line.trim());
  assert.equal(frames.length, 2, `unexpected stdout: ${stdout}`);
  const parsed = frames.map((frame) => JSON.parse(frame));
  assert.equal(parsed[0].result.serverInfo.name, "agent-space");
  assert.equal(parsed[1].result.isError, false);
  assert.match(parsed[1].result.content[0].text, /Stub/);
  // The banner is on stderr, so the client's stdout parser never sees it.
  assert.match(stderr, /serving MCP on stdio/);
  assert.deepEqual(requests, ["GET /api/workspaces"]);
});
