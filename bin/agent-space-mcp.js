#!/usr/bin/env node
/**
 * agent-space-mcp — exposes a RUNNING Agent Space over the Model Context
 * Protocol on stdio.
 *
 * Usage (the MCP client starts this process; you rarely run it by hand):
 *   node bin/agent-space-mcp.js [--url http://127.0.0.1:4173] [--token <t>]
 * Environment: AGENT_SPACE_URL (default http://127.0.0.1:4173),
 *              AGENT_SPACE_TOKEN (only when the server runs in shared mode).
 *
 * Design rules:
 *  - This process NEVER opens the SQLite file. Everything goes through the
 *    HTTP API of a running server, so it cannot contend for the database lock
 *    and cannot bypass server-side policy, approvals or audit.
 *  - stdout carries JSON-RPC frames and nothing else. Every diagnostic goes to
 *    stderr, including the startup banner and every failure.
 *  - A missing server is reported as a tool error with the URL that was tried,
 *    not as an empty result.
 *
 * Add it to a client (nothing below is written by Agent Space; you run it):
 *   Claude Code:
 *     claude mcp add agent-space -- node "<repo>\\bin\\agent-space-mcp.js"
 *   Codex (~/.codex/config.toml):
 *     [mcp_servers.agent-space]
 *     command = "node"
 *     args = ["<repo>\\bin\\agent-space-mcp.js"]
 *     env = { AGENT_SPACE_URL = "http://127.0.0.1:4173" }
 *   Copilot CLI:
 *     copilot --additional-mcp-config <path-to>\\agent-space-mcp.json
 *     where the file holds
 *     { "mcpServers": { "agent-space": { "type": "local", "command": "node",
 *       "args": ["<repo>\\bin\\agent-space-mcp.js"],
 *       "env": { "AGENT_SPACE_URL": "http://127.0.0.1:4173" } } } }
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createMcpServer } from "../packages/core/src/mcp/server.js";

const DEFAULT_URL = "http://127.0.0.1:4173";

/** Reads --url/--token from argv, falling back to the environment. */
export function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    url: env.AGENT_SPACE_URL || DEFAULT_URL,
    token: env.AGENT_SPACE_TOKEN || null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url" && argv[i + 1]) options.url = argv[(i += 1)];
    else if (arg.startsWith("--url=")) options.url = arg.slice(6);
    else if (arg === "--token" && argv[i + 1]) options.token = argv[(i += 1)];
    else if (arg.startsWith("--token=")) options.token = arg.slice(8);
  }
  options.url = options.url.replace(/\/+$/, "");
  return options;
}

/** Minimal HTTP bridge to the Agent Space API. Never logs the token. */
export function createHttpClient({ url, token, fetchImpl = fetch } = {}) {
  const base = String(url ?? DEFAULT_URL).replace(/\/+$/, "");
  async function request(method, path, body) {
    const target = `${base}${path}`;
    const headers = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let response;
    try {
      response = await fetchImpl(target, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(
        `No Agent Space answered at ${base} (${error?.message ?? error}). Start it with "npm start" or point AGENT_SPACE_URL at the running server.`,
      );
    }
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text.slice(0, 2000) };
      }
    }
    if (!response.ok)
      throw new Error(
        `${method} ${path} → ${response.status}: ${payload?.error ?? payload?.raw ?? response.statusText}`,
      );
    return payload;
  }
  return {
    base,
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body ?? {}),
  };
}

function packageVersion() {
  try {
    const file = fileURLToPath(new URL("../package.json", import.meta.url));
    return JSON.parse(readFileSync(file, "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function main() {
  const options = parseArgs();
  const log = {
    debug: (message) => process.stderr.write(`${message}\n`),
    error: (message) => process.stderr.write(`${message}\n`),
  };
  const server = createMcpServer({
    client: createHttpClient(options),
    version: packageVersion(),
    log,
  });
  log.debug(
    `[agent-space-mcp] serving MCP on stdio against ${options.base ?? options.url}${options.token ? " (token auth)" : ""}`,
  );
  await server.serve({ input: process.stdin, output: process.stdout });
}

const invokedDirectly = (() => {
  // win32: compare normalized, case-insensitively — argv[1] casing varies.
  if (!process.argv[1]) return false;
  const here = fileURLToPath(import.meta.url).replaceAll("\\", "/");
  const started = resolve(process.argv[1]).replaceAll("\\", "/");
  return here.toLowerCase() === started.toLowerCase();
})();

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`[agent-space-mcp] ${error?.stack ?? error}
`);
    process.exitCode = 1;
  });
}
