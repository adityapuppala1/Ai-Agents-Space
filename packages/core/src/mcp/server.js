/**
 * Agent Space MCP server — JSON-RPC 2.0 over newline-delimited stdio.
 *
 * The wire protocol is implemented by hand (no packages, per the project
 * rules): one JSON object per line on stdin, one JSON object per line on
 * stdout. NOTHING but protocol frames may reach stdout — every log line goes
 * to stderr — because an MCP client parses stdout strictly.
 *
 * Methods implemented:
 *   initialize                 → protocolVersion, capabilities, serverInfo
 *   notifications/initialized  → notification, no response
 *   ping                       → {}
 *   tools/list, tools/call
 *   resources/list, resources/templates/list, resources/read
 * Anything else answers JSON-RPC error -32601 (method not found).
 *
 * Honesty rules that shape this module:
 *  - The server never opens the SQLite file. It talks to a RUNNING Agent Space
 *    over HTTP, so it cannot contend for the database lock and cannot see or
 *    change anything the HTTP API would not allow. Server-side policy,
 *    approvals and audit therefore apply unchanged.
 *  - A tool that fails answers with `isError: true` and the real message from
 *    the server; failures are never reported as empty results.
 *  - The gated tool (decide_approval) is refused unless the server setting
 *    says otherwise; see tools.js.
 */
import { TOOLS, findTool, toolDescriptors } from "./tools.js";
import {
  DEFAULT_DOCS_DIR,
  RESOURCES,
  RESOURCE_TEMPLATES,
  readResource,
} from "./resources.js";

export const SERVER_NAME = "agent-space";
/** Protocol revisions this server speaks; the first is the default. */
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

/** Largest single newline-delimited frame the server will buffer. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export const JSONRPC_ERRORS = Object.freeze({
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
});

function result(id, value) {
  return { jsonrpc: "2.0", id, result: value };
}

function failure(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error };
}

/**
 * Builds the server.
 *
 * options:
 *   client   required — { get(path), post(path, body) } HTTP bridge
 *   version  server version string reported in initialize
 *   tools    tool list (tests inject their own)
 *   docsDir  repository docs directory for the document resources
 *   log      stderr logger; never write to stdout from here
 */
export function createMcpServer({
  client,
  version = "0.1.0",
  tools = TOOLS,
  docsDir = DEFAULT_DOCS_DIR,
  log = { debug() {}, error() {} },
} = {}) {
  if (!client || typeof client.get !== "function")
    throw new TypeError(
      "createMcpServer needs a client with get(path) and post(path, body)",
    );

  let initialized = false;

  async function callTool(id, params) {
    const name = params?.name;
    const tool = findTool(name, tools);
    if (!tool)
      return failure(
        id,
        JSONRPC_ERRORS.invalidParams,
        `Unknown tool “${name}”. Call tools/list for the ${tools.length} tools this server offers.`,
      );
    try {
      const value = await tool.handler(client, params?.arguments ?? {});
      return result(id, { ...value, isError: false });
    } catch (error) {
      // A tool failure is reported inside the result, per MCP, so the model
      // sees the real reason instead of a silent empty answer.
      log.debug?.(`[mcp] tool ${name} failed: ${error?.message ?? error}`);
      return result(id, {
        content: [
          {
            type: "text",
            text: `${name} failed: ${error?.message ?? String(error)}`,
          },
        ],
        isError: true,
      });
    }
  }

  async function readOne(id, params) {
    const uri = params?.uri;
    if (typeof uri !== "string" || !uri)
      return failure(id, JSONRPC_ERRORS.invalidParams, "uri is required");
    try {
      const contents = await readResource(uri, { client, docsDir });
      return result(id, { contents: [contents] });
    } catch (error) {
      return failure(
        id,
        JSONRPC_ERRORS.invalidParams,
        error?.message ?? String(error),
      );
    }
  }

  /** Handles one parsed JSON-RPC message. Returns a response, or null. */
  async function handle(message) {
    if (Array.isArray(message))
      return failure(
        null,
        JSONRPC_ERRORS.invalidRequest,
        "Batched JSON-RPC requests are not supported by this MCP server",
      );
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0")
      return failure(
        message?.id ?? null,
        JSONRPC_ERRORS.invalidRequest,
        'Every frame must be a JSON-RPC 2.0 object with "jsonrpc": "2.0"',
      );

    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;

    if (method === "notifications/initialized") {
      initialized = true;
      return null;
    }
    if (typeof method !== "string")
      return isNotification
        ? null
        : failure(id, JSONRPC_ERRORS.invalidRequest, "method is required");
    if (method.startsWith("notifications/")) return null;
    if (isNotification) return null;

    switch (method) {
      case "initialize": {
        const asked = params?.protocolVersion;
        return result(id, {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(asked)
            ? asked
            : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: SERVER_NAME, version },
          instructions:
            "Agent Space is a local-first command center for AI coding agents. Tools read workspaces, tasks, runs, live provider sessions, the decision inbox, recorded events and analytics; create_task changes state and decide_approval is refused unless the server setting mcp.allowDecisions is true. Every number is reported by a provider or computed from stored records — nothing is inferred.",
        });
      }
      case "ping":
        return result(id, {});
      case "tools/list":
        return result(id, { tools: toolDescriptors(tools) });
      case "tools/call":
        return callTool(id, params);
      case "resources/list":
        return result(id, { resources: RESOURCES });
      case "resources/templates/list":
        return result(id, { resourceTemplates: RESOURCE_TEMPLATES });
      case "resources/read":
        return readOne(id, params);
      default:
        return failure(
          id,
          JSONRPC_ERRORS.methodNotFound,
          `Unknown method “${method}”. This server implements: initialize, ping, tools/list, tools/call, resources/list, resources/templates/list, resources/read.`,
        );
    }
  }

  /** Handles one raw line. Returns a response object, or null for silence. */
  async function handleLine(line) {
    const text = String(line ?? "").trim();
    if (!text) return null;
    let message;
    try {
      message = JSON.parse(text);
    } catch (error) {
      return failure(
        null,
        JSONRPC_ERRORS.parse,
        `Frame is not JSON: ${error.message}`,
      );
    }
    try {
      return await handle(message);
    } catch (error) {
      log.error?.(`[mcp] internal error: ${error?.stack ?? error}`);
      return failure(
        message?.id ?? null,
        JSONRPC_ERRORS.internal,
        error?.message ?? String(error),
      );
    }
  }

  /**
   * Reads newline-delimited frames from `input` and writes responses to
   * `output`. Resolves when the input ends. Partial lines are buffered.
   */
  function serve({ input, output }) {
    return new Promise((resolve, reject) => {
      let buffer = "";
      let ended = false;
      // Frames are handled CONCURRENTLY and only the writes are serialized.
      // JSON-RPC ids correlate responses, so ordering is not required, and a
      // single chain meant a client's protocol-level ping sat unanswered
      // behind a slow tools/call until the client declared the server dead.
      const inFlight = new Set();
      const write = (response) => {
        if (response) output.write(`${JSON.stringify(response)}\n`);
      };
      const settle = () => {
        if (ended && inFlight.size === 0) resolve();
      };
      const pump = (line) => {
        const task = Promise.resolve()
          .then(() => handleLine(line))
          .then(write)
          .catch((error) => {
            log.error?.(`[mcp] frame failed: ${error?.stack ?? error}`);
          })
          .finally(() => {
            inFlight.delete(task);
            settle();
          });
        inFlight.add(task);
      };
      input.setEncoding?.("utf8");
      input.on("data", (chunk) => {
        buffer += chunk;
        // A peer that never sends a newline would otherwise grow this buffer
        // until the process dies. Refuse the oversized frame and carry on.
        if (buffer.length > MAX_FRAME_BYTES && !buffer.includes("\n")) {
          buffer = "";
          write(
            failure(
              null,
              JSONRPC_ERRORS.parse,
              `Frame exceeds ${Math.floor(MAX_FRAME_BYTES / (1024 * 1024))} MB`,
            ),
          );
          return;
        }
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          pump(line);
          index = buffer.indexOf("\n");
        }
      });
      input.on("error", reject);
      input.on("end", () => {
        if (buffer.trim()) pump(buffer);
        ended = true;
        settle();
      });
    });
  }

  return {
    name: SERVER_NAME,
    version,
    get initialized() {
      return initialized;
    },
    handle,
    handleLine,
    serve,
  };
}

export default createMcpServer;
