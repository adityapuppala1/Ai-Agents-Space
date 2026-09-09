#!/usr/bin/env node
/**
 * Agent Space CLI. Zero dependencies: uses global fetch and WebSocket
 * (Node 22+). Talks to a running server (`npm start`).
 *
 * Exit codes: 0 ok, 1 error, 2 usage. `hook claude-code` always exits 0 so a
 * failure on our side never blocks Claude Code.
 */
import { stdin, stdout, stderr, env, argv } from "node:process";

const USAGE = `agent-space <command> [options]

Commands
  workspaces                         List workspaces
  tasks [ws]                         List tasks (default workspace: demo)
  task create <ws> --title T [--description D] [--priority P] [--provider P] [--agent ID]
  run <ws> <taskId> [--provider P] [--prompt TEXT] [--model M]
  runs [ws]                          List runs
  inbox                              Pending approvals and attention items
  approve <approvalId> [--note N]    Approve a pending request
  deny <approvalId> [--note N]       Deny a pending request
  doctor                             Connection diagnostics and server health
  sessions [--live]                  Observed provider sessions
  templates                          Workflow templates
  workflow start <ws> <templateId> [--input key=value ...] [--provider P]
  graph <ws>                         Task dependency graph
  analytics [--workspace ws] [--since ms]
  watch <ws>                         Stream run/agent changes (Ctrl+C to stop)
  hook claude-code [--timeout S]     Claude Code hook bridge (stdin -> server -> stdout)
  hook install|uninstall|status      Manage the Claude Code hook

Options
  --url URL      Server URL (env AGENT_SPACE_URL, default http://127.0.0.1:5173)
  --token T      Bearer token (env AGENT_SPACE_TOKEN)
  --json         Machine-readable output
  -h, --help     Show this help
`;

function parseArgs(args) {
  const positional = [];
  const options = { input: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      let value = eq === -1 ? undefined : arg.slice(eq + 1);
      if (value === undefined) {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          value = next;
          i++;
        } else value = true;
      }
      if (key === "input") options.input.push(value);
      else options[key] = value;
    } else if (arg === "-h") options.help = true;
    else positional.push(arg);
  }
  return { positional, options };
}

class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

function makeClient(options) {
  const base = String(
    options.url ?? env.AGENT_SPACE_URL ?? "http://127.0.0.1:5173",
  ).replace(/\/+$/, "");
  const token = options.token ?? env.AGENT_SPACE_TOKEN ?? null;
  const headers = () => (token ? { Authorization: `Bearer ${token}` } : {});
  async function request(method, path, data, { timeoutMs = 30000 } = {}) {
    let response;
    try {
      response = await fetch(base + path, {
        method,
        headers: {
          ...headers(),
          ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: data !== undefined ? JSON.stringify(data) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new CliError(
        `Cannot reach ${base}: ${error.cause?.message ?? error.message}. Is the server running?`,
      );
    }
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    if (!response.ok)
      throw new CliError(
        `${method} ${path} → ${response.status}: ${json?.error ?? text}`,
      );
    return json;
  }
  return {
    base,
    token,
    get: (path, opts) => request("GET", path, undefined, opts),
    post: (path, data = {}, opts) => request("POST", path, data, opts),
    patch: (path, data = {}, opts) => request("PATCH", path, data, opts),
    wsUrl(path) {
      const url = new URL(base + path);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      if (token) url.searchParams.set("token", token);
      return url.toString();
    },
  };
}

function table(rows, columns) {
  if (!rows.length) return "(none)\n";
  const cells = rows.map((row) =>
    columns.map(([, pick]) => {
      const value = typeof pick === "function" ? pick(row) : row[pick];
      return value === null || value === undefined ? "-" : String(value);
    }),
  );
  const widths = columns.map((column, i) =>
    Math.min(
      60,
      Math.max(column[0].length, ...cells.map((line) => line[i].length)),
    ),
  );
  const fmt = (line) =>
    line
      .map((cell, i) => cell.slice(0, widths[i]).padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  return (
    [
      fmt(columns.map((column) => column[0])),
      fmt(widths.map((w) => "-".repeat(w))),
      ...cells.map(fmt),
    ].join("\n") + "\n"
  );
}

function fmtTime(ms) {
  return ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) : "-";
}

function emit(options, data, human) {
  if (options.json) stdout.write(JSON.stringify(data, null, 2) + "\n");
  else stdout.write(typeof human === "function" ? human(data) : human);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function preToolUseDeny(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

/**
 * Claude Code hook bridge. An empty decision (`{}`) hands the call back to
 * Claude Code's own permission flow, so it is only printed when Agent Space
 * is not running at all. When the server answered with an error or did not
 * answer in time (an approval may still be pending in the inbox), a
 * PreToolUse is denied instead of silently falling through to "allow".
 */
async function hookClaudeCode(client, options) {
  const timeoutSeconds = Number(
    options.timeout ?? env.AGENT_SPACE_HOOK_TIMEOUT ?? 55,
  );
  const timeoutMs = Math.max(1000, timeoutSeconds * 1000 - 500);
  let payload = {};
  try {
    const raw = await readStdin();
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    stderr.write(`agent-space hook: invalid stdin JSON (${error.message})\n`);
    stdout.write("{}\n");
    return 0;
  }
  const isPreToolUse = payload?.hook_event_name === "PreToolUse";
  const failClosed = (reason) => {
    stdout.write((isPreToolUse ? preToolUseDeny(reason) : "{}") + "\n");
    return 0;
  };
  try {
    const response = await fetch(client.base + "/api/hooks/claude-code", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(client.token ? { Authorization: `Bearer ${client.token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      stderr.write(
        `agent-space hook: server responded ${response.status}: ${text.slice(0, 300)}\n`,
      );
      return failClosed(
        response.status === 401 || response.status === 403
          ? `Agent Space rejected the hook (${response.status}): the hook has no valid AGENT_SPACE_TOKEN, so policy cannot be applied`
          : `Agent Space returned ${response.status}; policy could not be applied`,
      );
    }
    let body = text.trim();
    try {
      JSON.parse(body);
    } catch {
      stderr.write("agent-space hook: server returned non-JSON; ignoring\n");
      body = "{}";
    }
    stdout.write(body + "\n");
  } catch (error) {
    stderr.write(
      `agent-space hook: ${error.cause?.message ?? error.message}\n`,
    );
    if (error.name === "TimeoutError" || error.name === "AbortError")
      return failClosed(
        `Agent Space did not answer within ${Math.round(timeoutMs / 1000)} s; the approval may still be pending in the Decision inbox`,
      );
    // Any other failure is connection-level (refused, unreachable, reset):
    // no server is there to hold a pending approval, so never block Claude.
    stdout.write("{}\n");
  }
  return 0;
}

async function watch(client, options, workspaceId) {
  if (typeof WebSocket !== "function")
    throw new CliError(
      "WebSocket is not available in this Node version (need 22+)",
    );
  const url = client.wsUrl(`/ws?workspace=${encodeURIComponent(workspaceId)}`);
  const socket = new WebSocket(url);
  const runs = new Map();
  const agents = new Map();
  const line = (text) =>
    stdout.write(
      options.json
        ? JSON.stringify(text) + "\n"
        : `${fmtTime(Date.now())}  ${typeof text === "string" ? text : text.message}\n`,
    );
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.event !== "workspace:snapshot") return;
    const snapshot = message.payload ?? {};
    const first = runs.size === 0 && agents.size === 0;
    for (const run of snapshot.runs ?? []) {
      const key = `${run.status}|${run.activity ?? ""}|${run.currentFile ?? ""}`;
      if (runs.get(run.id) !== key) {
        runs.set(run.id, key);
        if (!first)
          line({
            type: "run",
            runId: run.id,
            status: run.status,
            activity: run.activity ?? null,
            currentFile: run.currentFile ?? null,
            message: `run ${run.id.slice(0, 8)} ${run.status}${run.activity ? ` ${run.activity}` : ""}${run.currentFile ? ` ${run.currentFile}` : ""} (${run.provider})`,
          });
      }
    }
    for (const agent of snapshot.agents ?? []) {
      const key = `${agent.state}|${agent.activity ?? ""}|${agent.taskId ?? ""}`;
      if (agents.get(agent.id) !== key) {
        agents.set(agent.id, key);
        if (!first)
          line({
            type: "agent",
            agentId: agent.id,
            name: agent.name,
            state: agent.state,
            activity: agent.activity ?? null,
            taskId: agent.taskId ?? null,
            message: `${agent.name}: ${agent.state}${agent.activity ? ` (${agent.activity}, inferred)` : ""}${agent.taskId ? ` task ${agent.taskId.slice(0, 8)}` : ""}`,
          });
      }
    }
    if (first)
      line({
        type: "connected",
        workspaceId,
        runs: runs.size,
        agents: agents.size,
        message: `watching ${workspaceId}: ${runs.size} runs, ${agents.size} agents`,
      });
  });
  return new Promise((resolve) => {
    socket.addEventListener("error", () => {
      stderr.write(`Cannot connect to ${url}\n`);
      resolve(1);
    });
    socket.addEventListener("close", () => resolve(0));
  });
}

async function main() {
  const { positional, options } = parseArgs(argv.slice(2));
  const [command, ...rest] = positional;
  if (!command || options.help || command === "help") {
    stdout.write(USAGE);
    return command ? 0 : 2;
  }
  const client = makeClient(options);
  const ws = (id) => encodeURIComponent(id ?? "demo");

  switch (command) {
    case "workspaces": {
      const data = await client.get("/api/workspaces");
      emit(options, data, (rows) =>
        table(rows, [
          ["id", "id"],
          ["name", "name"],
          ["kind", "kind"],
          ["active", "activeRuns"],
          ["attention", "attention"],
          ["agents", "agents"],
          ["root", "rootPath"],
        ]),
      );
      return 0;
    }
    case "tasks": {
      const data = await client.get(`/api/workspaces/${ws(rest[0])}/tasks`);
      emit(options, data, (rows) =>
        table(rows, [
          ["id", (r) => r.id.slice(0, 8)],
          ["status", "status"],
          ["priority", "priority"],
          ["provider", "provider"],
          ["title", "title"],
        ]),
      );
      return 0;
    }
    case "task": {
      if (rest[0] !== "create" || !rest[1] || !options.title)
        throw new CliError(
          "usage: task create <ws> --title T [--provider P]",
          2,
        );
      const task = await client.post(`/api/workspaces/${ws(rest[1])}/tasks`, {
        title: String(options.title),
        description: options.description
          ? String(options.description)
          : undefined,
        priority: options.priority ? String(options.priority) : undefined,
        provider: options.provider ? String(options.provider) : undefined,
        agentId: options.agent ? String(options.agent) : undefined,
      });
      emit(options, task, (t) => `Created task ${t.id} "${t.title}"\n`);
      return 0;
    }
    case "run": {
      if (!rest[0] || !rest[1])
        throw new CliError("usage: run <ws> <taskId> [--provider P]", 2);
      const run = await client.post(
        `/api/workspaces/${ws(rest[0])}/tasks/${encodeURIComponent(rest[1])}/run`,
        {
          provider: options.provider ? String(options.provider) : undefined,
          prompt: options.prompt ? String(options.prompt) : undefined,
          model: options.model ? String(options.model) : undefined,
          agentId: options.agent ? String(options.agent) : undefined,
        },
      );
      emit(
        options,
        run,
        (r) => `Run ${r.id ?? "?"} ${r.status ?? ""} (${r.provider ?? "-"})\n`,
      );
      return 0;
    }
    case "runs": {
      const data = await client.get(`/api/workspaces/${ws(rest[0])}/runs`);
      emit(options, data, (rows) =>
        table(rows, [
          ["id", (r) => r.id.slice(0, 8)],
          ["status", "status"],
          ["provider", "provider"],
          ["mode", "mode"],
          ["model", (r) => r.actualModel ?? "not reported"],
          ["started", (r) => fmtTime(r.startedAt)],
          ["title", (r) => r.title ?? r.taskId],
        ]),
      );
      return 0;
    }
    case "inbox": {
      const data = await client.get("/api/inbox");
      emit(options, data, (inbox) => {
        const approvals = inbox.approvals ?? inbox.pending ?? [];
        const runsList = inbox.runs ?? inbox.attention ?? [];
        const reviews = inbox.reviews ?? [];
        return (
          `Approvals (${approvals.length})\n` +
          table(approvals, [
            ["id", "id"],
            ["kind", "kind"],
            ["workspace", "workspaceId"],
            ["reason", "reason"],
          ]) +
          `\nRuns needing attention (${runsList.length})\n` +
          table(runsList, [
            ["id", (r) => (r.id ?? "").slice(0, 8)],
            ["status", "status"],
            ["provider", "provider"],
            ["error", "error"],
          ]) +
          `\nReviews (${reviews.length})\n` +
          table(reviews, [
            ["task", (r) => r.id ?? r.taskId],
            ["title", "title"],
          ])
        );
      });
      return 0;
    }
    case "approve":
    case "deny": {
      if (!rest[0])
        throw new CliError(`usage: ${command} <approvalId> [--note N]`, 2);
      const data = await client.post(
        `/api/approvals/${encodeURIComponent(rest[0])}/decide`,
        {
          decision: command === "approve" ? "approve" : "deny",
          note: options.note ? String(options.note) : undefined,
        },
      );
      emit(
        options,
        data,
        (a) =>
          `${command === "approve" ? "Approved" : "Denied"} ${rest[0]} (${a.status ?? "ok"})\n`,
      );
      return 0;
    }
    case "doctor": {
      const health = await client.get("/api/health");
      let doctor = [];
      let doctorError = null;
      try {
        doctor = await client.get("/api/connections/doctor");
      } catch (error) {
        doctorError = error.message;
      }
      const data = { health, doctor, doctorError };
      emit(options, data, () => {
        let text = `Server ${client.base}: ${health.status} (${health.workspaces} workspaces, schema v${health.schemaVersion})\n`;
        if (doctorError) text += `Connections: unavailable (${doctorError})\n`;
        else
          text += table(doctor, [
            ["level", "level"],
            ["provider", "provider"],
            ["title", "title"],
            ["fix", "fix"],
          ]);
        return text;
      });
      return doctor.some?.((d) => d.level === "error") ? 1 : 0;
    }
    case "sessions": {
      const data = await client.get(
        `/api/sessions${options.live ? "?live=1" : ""}`,
      );
      emit(options, data, (rows) =>
        table(rows, [
          ["provider", "provider"],
          ["live", (r) => (r.live ? "yes" : "no")],
          ["session", (r) => String(r.sessionId ?? r.id ?? "").slice(0, 12)],
          ["cwd", "cwd"],
          ["title", "title"],
        ]),
      );
      return 0;
    }
    case "templates": {
      const data = await client.get("/api/templates");
      emit(options, data, (rows) =>
        table(rows, [
          ["id", "id"],
          ["name", "name"],
          ["priority", "priority"],
          ["steps", (t) => t.steps.length],
          ["inputs", (t) => Object.keys(t.sampleInputs ?? {}).join(",")],
        ]),
      );
      return 0;
    }
    case "workflow": {
      if (rest[0] !== "start" || !rest[1] || !rest[2])
        throw new CliError(
          "usage: workflow start <ws> <templateId> [--input key=value ...]",
          2,
        );
      const inputs = {};
      for (const pair of options.input) {
        const eq = String(pair).indexOf("=");
        if (eq === -1) throw new CliError("--input expects key=value", 2);
        inputs[String(pair).slice(0, eq)] = String(pair).slice(eq + 1);
      }
      const data = await client.post(
        `/api/workspaces/${ws(rest[1])}/workflows`,
        {
          templateId: rest[2],
          inputs,
          provider: options.provider ? String(options.provider) : null,
        },
      );
      emit(
        options,
        data,
        (w) =>
          `Workflow ${w.id} "${w.name}" created with ${w.tasks.length} tasks\n` +
          table(w.tasks, [
            ["id", (t) => t.id.slice(0, 8)],
            ["step", "stepKey"],
            ["title", "title"],
            ["deps", (t) => t.dependsOn.length],
          ]),
      );
      return 0;
    }
    case "graph": {
      if (!rest[0]) throw new CliError("usage: graph <ws>", 2);
      const data = await client.get(`/api/workspaces/${ws(rest[0])}/graph`);
      emit(
        options,
        data,
        (g) =>
          table(g.nodes, [
            ["id", (n) => n.id.slice(0, 8)],
            ["status", "status"],
            ["deps", (n) => n.dependsOn.map((d) => d.slice(0, 8)).join(",")],
            ["title", "title"],
          ]) +
          `critical path: ${g.criticalPath.map((id) => id.slice(0, 8)).join(" -> ") || "(none)"}\n`,
      );
      return 0;
    }
    case "analytics": {
      const params = new URLSearchParams();
      if (options.workspace) params.set("workspace", String(options.workspace));
      if (options.since) params.set("since", String(options.since));
      const query = params.toString();
      const data = await client.get(
        `/api/analytics${query ? `?${query}` : ""}`,
      );
      emit(options, data, (a) => {
        const f = a.funnel;
        return (
          `Funnel: created ${f.created} → dispatched ${f.dispatched} → started ${f.started} → artifact ${f.artifact} → reviewed ${f.reviewed} → accepted ${f.accepted}\n` +
          `Time (derived, ms): executing ${a.time.executingMs} (wall-clock ${a.time.wallClock.executingMs}), waiting approval ${a.time.waitingApprovalMs}, blocked ${a.time.blockedMs}, reviewing ${a.time.reviewingMs}\n` +
          table(a.byProvider, [
            ["provider", "provider"],
            ["runs", "runs"],
            ["completed", "completed"],
            ["failed", "failed"],
            [
              "tokens in",
              (p) => (p.tokens.reported ? p.tokens.input : "not reported"),
            ],
            [
              "tokens out",
              (p) => (p.tokens.reported ? p.tokens.output : "not reported"),
            ],
            [
              "cost usd",
              (p) =>
                p.costUsd.reported
                  ? p.costUsd.value
                  : p.costUsd.estimated
                    ? `~${p.costUsd.value} (estimate)`
                    : "not reported",
            ],
          ])
        );
      });
      return 0;
    }
    case "watch": {
      if (!rest[0]) throw new CliError("usage: watch <ws>", 2);
      return watch(client, options, rest[0]);
    }
    case "hook": {
      const sub = rest[0];
      if (sub === "claude-code") return hookClaudeCode(client, options);
      if (sub === "status") {
        emit(
          options,
          await client.get("/api/hooks/claude-code/status"),
          (s) =>
            `Claude Code hook: ${s.installed ? "installed" : "not installed"}${s.settingsPath ? ` (${s.settingsPath})` : ""}\n`,
        );
        return 0;
      }
      if (sub === "install" || sub === "uninstall") {
        const data = await client.post(`/api/hooks/claude-code/${sub}`, {
          timeoutSeconds: options.timeout ? Number(options.timeout) : undefined,
        });
        emit(
          options,
          data,
          (s) =>
            `Claude Code hook ${sub}ed${s.settingsPath ? ` (${s.settingsPath})` : ""}\n`,
        );
        return 0;
      }
      throw new CliError("usage: hook claude-code|install|uninstall|status", 2);
    }
    default:
      throw new CliError(`Unknown command: ${command}\n\n${USAGE}`, 2);
  }
}

// Set exitCode instead of calling exit(): exiting while a fetch socket is
// still closing can crash Node on Windows (libuv async handle assertion).
main().then(
  (code) => {
    process.exitCode = code ?? 0;
  },
  (error) => {
    stderr.write(`${error.message}\n`);
    process.exitCode = error instanceof CliError ? error.code : 1;
  },
);
