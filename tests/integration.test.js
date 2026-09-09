import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { createServices } from "../packages/core/src/services.js";
import { createWorkspaceServer } from "../packages/server/src/server.js";
import { createObserver as createClaudeObserver } from "../packages/core/src/observe/claudeCode.js";
import { createObserver as createCopilotObserver } from "../packages/core/src/observe/copilot.js";
import { PROVIDER_IDS } from "../packages/core/src/contracts.js";

/**
 * Backend integration: the full service container behind the real route
 * table. Provider homes are temp copies of the fixtures, detection is faked,
 * and the managed run uses the fake Claude CLI. Nothing here touches real
 * provider directories or binaries.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures", "providers");
const fakeCli = (name) => path.join(here, "fixtures", "fake-cli", name);
const q = (value) => `"${value}"`;

const CLAUDE_SESSION = "ce11cc5e-2683-42ee-9cd7-5a482281ff3e";
const CLAUDE_SLUG = "c--xampp-htdocs-Ai-Agents-View";
const CLAUDE_PID = 99999;
const COPILOT_SESSION = "9869997d-2b31-4869-ac28-363005a10279";
const COPILOT_CWD = "C:\\work\\probe\\copilot";

function tempDir(cleanup, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-space-${prefix}-`));
  cleanup.push(() => {
    try {
      fs.rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    } catch {
      /* Windows may hold a handle briefly */
    }
  });
  return dir;
}

/** ~/.claude laid out like the real one: registry, transcript, history. */
function makeClaudeHome(cleanup) {
  const home = tempDir(cleanup, "claude");
  const projectDir = path.join(home, "projects", CLAUDE_SLUG);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.copyFileSync(
    path.join(fixtures, "claude-code-transcript.jsonl"),
    path.join(projectDir, `${CLAUDE_SESSION}.jsonl`),
  );
  fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
  fs.copyFileSync(
    path.join(fixtures, "claude-session-registry.json"),
    path.join(home, "sessions", `${CLAUDE_PID}.json`),
  );
  // Token sibling that must never be read.
  fs.writeFileSync(
    path.join(home, "sessions", `${CLAUDE_PID}.abcd.key`),
    "SECRET",
  );
  fs.writeFileSync(
    path.join(home, "history.jsonl"),
    JSON.stringify({
      display: "graphify",
      timestamp: 1788962744385,
      project: "c:\\xampp\\htdocs\\Ai_Agents_View",
      sessionId: CLAUDE_SESSION,
    }) + "\n",
  );
  return home;
}

/** ~/.copilot with one finished headless session (workspace.yaml + events). */
function makeCopilotHome(cleanup) {
  const home = tempDir(cleanup, "copilot");
  const dir = path.join(home, "session-state", COPILOT_SESSION);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(dir, "workspace.yaml"),
    [
      `id: ${COPILOT_SESSION}`,
      `cwd: ${COPILOT_CWD}`,
      "client_name: github/cli",
      "name: Read the file hello.txt then reply OK",
      `created_at: ${now}`,
      `updated_at: ${now}`,
      "",
    ].join("\r\n"),
  );
  const start = JSON.stringify({
    type: "session.start",
    data: {
      sessionId: COPILOT_SESSION,
      version: 1,
      producer: "copilot-agent",
      copilotVersion: "1.0.80",
      context: { cwd: COPILOT_CWD },
    },
    id: "171f1b9c-dc33-43c1-ab2d-54b5142255c6",
    timestamp: now,
    parentId: null,
  });
  const lines = fs
    .readFileSync(path.join(fixtures, "copilot-headless-stream.jsonl"), "utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  fs.writeFileSync(
    path.join(dir, "events.jsonl"),
    [start, ...lines].join("\n") + "\n",
  );
  return home;
}

/** Detection double: Claude Code "installed and logged in", the rest missing. */
async function fakeDetect({ providers = PROVIDER_IDS } = {}) {
  return providers.map((provider) =>
    provider === "claude-code"
      ? {
          provider,
          found: true,
          binaryPath: "C:\\fake\\claude.exe",
          binaryName: "claude",
          version: "2.1.258",
          versionOutput: "2.1.258 (Claude Code) [fake]",
          homePath: "C:\\fake\\.claude",
          homeExists: true,
          authHint: "logged-in-likely",
          override: true,
          error: null,
          probedAt: Date.now(),
        }
      : {
          provider,
          found: false,
          binaryPath: null,
          binaryName: null,
          version: null,
          versionOutput: null,
          homePath: null,
          homeExists: false,
          authHint: "unknown",
          override: false,
          error: null,
          probedAt: Date.now(),
        },
  );
}

async function waitFor(check, { timeout = 10000, interval = 40 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

async function boot(t, { demo = true } = {}) {
  const cleanup = [];
  const claudeHome = makeClaudeHome(cleanup);
  const copilotHome = makeCopilotHome(cleanup);
  const emptyHome = tempDir(cleanup, "empty");
  const dataDir = tempDir(cleanup, "data");
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeHome,
    COPILOT_HOME: copilotHome,
    CODEX_HOME: path.join(emptyHome, "codex"),
    CURSOR_HOME: path.join(emptyHome, "cursor"),
    GEMINI_HOME: path.join(emptyHome, "gemini"),
    APPDATA: path.join(emptyHome, "appdata"),
    AGENT_SPACE_DATA_DIR: dataDir,
    AGENT_SPACE_BIN_CLAUDE_CODE: `${q(process.execPath)} ${q(fakeCli("claude.js"))}`,
    AGENT_SPACE_OBSERVE_INTERVAL: "60000",
  };
  for (const key of ["CODEX", "COPILOT", "CURSOR", "GEMINI"])
    delete env[`AGENT_SPACE_BIN_${key}`];
  const services = createServices({
    demo,
    env,
    port: 0,
    detect: fakeDetect,
    observers: [
      createClaudeObserver({
        home: claudeHome,
        env,
        isPidAlive: (pid) => pid === CLAUDE_PID,
      }),
      createCopilotObserver({
        home: copilotHome,
        env,
        isPidAlive: () => false,
      }),
    ],
    approvalSweepMs: 1_000_000,
    broadcastIntervalMs: 5,
    log: { warn() {}, error() {}, debug() {}, log() {} },
  });
  const server = createWorkspaceServer({ services, token: "" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await services.close();
    await new Promise((resolve) => server.close(resolve));
    for (const fn of cleanup.reverse()) fn();
  });
  const api = async (method, route, body) => {
    const response = await fetch(base + route, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: response.status, data };
  };
  return { services, server, port, base, api, env, cleanup, dataDir };
}

function globalMessage(port) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?channel=global`);
    socket.once("message", (raw) => {
      socket.close();
      resolve(JSON.parse(raw.toString()));
    });
    socket.once("error", reject);
  });
}

test("server boots with the full container: health, route precedence, global snapshot, workspace theme/policy", async (t) => {
  const { services, api, port } = await boot(t);
  const health = await api("GET", "/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.data.schemaVersion, 2);
  for (const key of [
    "settings",
    "audit",
    "policy",
    "connections",
    "recorder",
    "approvals",
    "hookBridge",
    "observation",
    "runWorker",
    "adapters",
    "workflows",
    "analytics",
    "context",
  ])
    assert.ok(services[key], `services.${key} attached`);

  await services.connections.refresh();
  const connections = await api("GET", "/api/connections");
  assert.equal(connections.status, 200);
  assert.equal(connections.data.length, PROVIDER_IDS.length);
  const claude = connections.data.find((c) => c.provider === "claude-code");
  assert.equal(claude.status, "ready");
  assert.equal(claude.version, "2.1.258");
  assert.ok(
    !JSON.stringify(connections.data).match(/auth_ref|authToken|token/i),
    "connection rows never carry credentials",
  );

  // Module routes answer before the generic workspace handler.
  const checks = [
    ["GET", "/api/providers"],
    ["GET", "/api/connections/doctor"],
    ["GET", "/api/connections/capabilities"],
    ["GET", "/api/sessions"],
    ["GET", "/api/observation/status"],
    ["GET", "/api/approvals"],
    ["GET", "/api/inbox"],
    ["GET", "/api/policy/presets"],
    ["GET", "/api/workspaces/demo/policy"],
    ["GET", "/api/hooks/claude-code/status"],
    ["GET", "/api/settings"],
    ["GET", "/api/audit"],
    ["GET", "/api/templates"],
    ["GET", "/api/workspaces/demo/workflows"],
    ["GET", "/api/workspaces/demo/graph"],
    ["GET", "/api/workspaces/demo/tasks/ready"],
    ["GET", "/api/analytics"],
    ["GET", "/api/workspaces/demo/export"],
    ["GET", "/api/workspaces/demo/workspace"],
    ["GET", "/api/workspaces/demo/tasks"],
  ];
  for (const [method, route] of checks) {
    const result = await api(method, route);
    assert.equal(result.status, 200, `${method} ${route} → ${result.status}`);
  }
  assert.equal((await api("GET", "/api/nope")).status, 404);
  assert.equal((await api("GET", "/api/workspaces/demo/nope")).status, 404);
  assert.equal(
    (await api("GET", "/api/workspaces/missing/policy")).status,
    404,
  );
  assert.equal(
    (await api("GET", "/api/workspaces/demo/policy")).data.autonomy,
    "scoped",
  );

  // Global channel snapshot.
  const message = await globalMessage(port);
  assert.equal(message.event, "global:snapshot");
  const payload = message.payload;
  assert.ok(Array.isArray(payload.workspaces));
  assert.ok(Array.isArray(payload.liveSessions));
  assert.equal(payload.connections.length, PROVIDER_IDS.length);
  assert.deepEqual(Object.keys(payload.inbox.counts).sort(), [
    "approvals",
    "questions",
    "reviews",
    "runs",
    "total",
  ]);
  assert.equal(payload.inbox.counts.total, 0);
  assert.equal(payload.settings["observation.enabled"], true);
  assert.equal(payload.settings["ui.graphics"], "medium");
  assert.equal(payload.observation.enabled, true);
  assert.equal(payload.observation.running, false);
  assert.deepEqual(payload.observation.observers, ["claude-code", "copilot"]);

  // Theme and policy through PATCH /api/workspaces/:id.
  const theme = await api("PATCH", "/api/workspaces/demo", {
    theme: "operations",
  });
  assert.equal(theme.status, 200);
  assert.equal(theme.data.theme, "operations");
  assert.equal(
    (await api("GET", "/api/workspaces/demo")).data.theme,
    "operations",
  );
  assert.equal(
    (await api("PATCH", "/api/workspaces/demo", { theme: "neon" })).status,
    400,
  );
  const policy = await api("PATCH", "/api/workspaces/demo", {
    policy: { autonomy: "propose", maxConcurrentRuns: 1 },
  });
  assert.equal(policy.status, 200);
  assert.equal(policy.data.policy.autonomy, "propose");
  assert.equal(policy.data.policy.maxConcurrentRuns, 1);
  assert.equal(
    (await api("GET", "/api/workspaces/demo/policy")).data.autonomy,
    "propose",
  );
  assert.ok(
    services.audit.list({ action: "policy.update" }).length >= 1,
    "policy writes through the hub are audited",
  );
  assert.equal(
    (await api("PATCH", "/api/workspaces/demo", { policy: { autonomy: "x" } }))
      .status,
    400,
  );
  const snapshot = (await api("GET", "/api/workspaces/demo/workspace")).data;
  assert.equal(snapshot.workspace.theme, "operations");
  assert.equal(snapshot.workspace.autoCreated, false);
  assert.equal(snapshot.workspace.policy.autonomy, "propose");
  const worker = snapshot.agents.find((a) => a.taskId);
  assert.ok(worker, "demo agents are busy");
  assert.equal(worker.runMode, "simulated");
  assert.equal(worker.runStatus, "running");
  assert.equal(worker.activityProvenance, "system");
  assert.equal(worker.provider, null);
  assert.equal(worker.autoCreated, false);
  assert.ok(typeof worker.elapsedMs === "number");
  const blocked = snapshot.agents.find((a) => a.state === "BLOCKED");
  assert.ok(blocked, "BLOCKED task wins");
  assert.ok(
    snapshot.tasks.every(
      (task) =>
        Array.isArray(task.dependsOn) &&
        typeof task.review === "object" &&
        "provider" in task &&
        "deliverable" in task,
    ),
  );
  assert.ok(snapshot.runs.every((run) => run.mode === "simulated"));
  assert.ok(snapshot.runs.every((run) => typeof run.attempt === "number"));
});

test("observation poll maps fixture sessions to workspaces, auto agents, observed runs, and events", async (t) => {
  const { services, api } = await boot(t);
  const poll = await api("POST", "/api/observation/poll");
  assert.equal(poll.status, 200);
  assert.equal(poll.data.enabled, true);
  assert.ok(poll.data.sessions >= 2, "claude + copilot sessions seen");
  assert.ok(poll.data.events > 0);
  assert.deepEqual(poll.data.errors, []);

  const live = await api("GET", "/api/sessions?live=1");
  assert.equal(live.status, 200);
  const session = live.data.find((s) => s.sessionId === CLAUDE_SESSION);
  assert.ok(session, "live Claude Code session listed");
  assert.equal(session.id, `claude-code:${CLAUDE_SESSION}`);
  assert.equal(session.live, true);
  assert.ok(session.workspaceId);
  assert.ok(session.runId);
  assert.equal(session.status, "running");

  const all = await api("GET", "/api/sessions");
  const copilot = all.data.find((s) => s.sessionId === COPILOT_SESSION);
  assert.ok(copilot, "finished Copilot session recorded");
  assert.equal(copilot.live, false);
  assert.equal(copilot.status, "completed");

  const single = await api(
    "GET",
    `/api/sessions/${encodeURIComponent(session.id)}`,
  );
  assert.equal(single.status, 200);
  assert.equal(single.data.run.mode, "observed");

  const snapshot = (
    await api("GET", `/api/workspaces/${session.workspaceId}/workspace`)
  ).data;
  assert.equal(snapshot.workspace.autoCreated, true);
  assert.equal(snapshot.workspace.name, "Ai_Agents_View");
  const agent = snapshot.agents.find((a) => a.provider === "claude-code");
  assert.ok(agent, "auto agent for the provider");
  assert.equal(agent.name, "Claude Code");
  assert.equal(agent.autoCreated, true);
  assert.equal(agent.runId, session.runId);
  assert.equal(agent.runMode, "observed");
  assert.equal(agent.runStatus, "running");
  assert.equal(typeof agent.activity, "string");
  assert.equal(agent.state, agent.activity);
  assert.equal(agent.activityProvenance, "inferred");
  assert.ok(agent.lastEventAt > 0);
  assert.ok(agent.elapsedMs >= 0);
  const task = snapshot.tasks.find((tk) => tk.id === agent.taskId);
  assert.equal(task.source, "observed");
  assert.equal(task.status, "IN_PROGRESS");
  const run = snapshot.runs.find((r) => r.id === session.runId);
  assert.equal(run.mode, "observed");
  assert.equal(run.provider, "claude-code");
  assert.ok(run.title);
  assert.ok(snapshot.events.some((e) => e.provenance === "provider"));
  assert.ok(snapshot.events.some((e) => e.tool));

  const global = services.globalSnapshot();
  assert.ok(global.liveSessions.some((s) => s.sessionId === CLAUDE_SESSION));
  assert.ok(global.workspaces.some((w) => w.id === session.workspaceId));

  // Second pass: nothing new, and hours without activity from a live pid → stale.
  const again = await api("POST", "/api/observation/poll");
  assert.equal(again.data.events, 0, "events are deduplicated");
  const stale = services.recorder.get(session.runId);
  assert.equal(stale.status, "stale");
  const later = (
    await api("GET", `/api/workspaces/${session.workspaceId}/workspace`)
  ).data;
  assert.equal(later.agents.find((a) => a.id === agent.id).state, "STALE");
  assert.ok(
    services.connections.list().find((c) => c.provider === "claude-code")
      ?.lastEventAt ?? true,
  );
});

test("a managed run launched through the API completes with the fake Claude CLI and reaches review", async (t) => {
  const { services, api, cleanup, base } = await boot(t, { demo: false });
  await services.connections.refresh();
  const root = tempDir(cleanup, "repo");
  const created = await api("POST", "/api/workspaces", {
    name: "Runner",
    rootPath: root,
  });
  assert.equal(created.status, 201);
  const workspaceId = created.data.id;

  const task = await api("POST", `/api/workspaces/${workspaceId}/tasks`, {
    title: "Say hello",
    description: "Reply with a greeting",
    provider: "claude-code",
    deliverable: "A greeting",
    target: { files: ["README.md"] },
    source: "launcher",
  });
  assert.equal(task.status, 201);
  assert.equal(task.data.provider, "claude-code");
  assert.equal(task.data.deliverable, "A greeting");
  assert.deepEqual(task.data.target, { files: ["README.md"] });
  assert.equal(task.data.source, "launcher");
  assert.deepEqual(task.data.dependsOn, []);
  assert.equal(
    (
      await api("POST", `/api/workspaces/${workspaceId}/tasks`, {
        title: "bad",
        provider: "nope",
      })
    ).status,
    400,
  );

  const launched = await api(
    "POST",
    `/api/workspaces/${workspaceId}/tasks/${task.data.id}/run`,
    { provider: "claude-code", prompt: "hello from the integration test" },
  );
  assert.equal(launched.status, 201, JSON.stringify(launched.data));
  const run = launched.data;
  assert.equal(run.mode, "managed");
  assert.equal(run.status, "running");
  assert.match(run.configSnapshot.command, /hello from the integration test/);
  assert.doesNotMatch(run.configSnapshot.command, /--bare/);

  const busy = (
    await api("GET", `/api/workspaces/${workspaceId}/workspace`)
  ).data.agents.find((a) => a.runId === run.id);
  if (busy) {
    assert.equal(busy.runMode, "managed");
    assert.equal(busy.runStatus, "running");
    assert.equal(busy.runProvider, "claude-code");
  }

  const done = await services.runWorker.wait(run.id, 20000);
  assert.equal(done.status, "completed");
  assert.equal(done.exitCode, 0);
  assert.ok(done.providerSessionId);

  const detail = await api("GET", `/api/runs/${run.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.run.status, "completed");
  assert.ok(detail.data.events.length > 2);
  assert.ok(detail.data.events.some((e) => e.provenance === "provider"));
  assert.ok(Array.isArray(detail.data.artifacts));
  assert.ok(Array.isArray(detail.data.approvals));

  const snapshot = (
    await api("GET", `/api/workspaces/${workspaceId}/workspace`)
  ).data;
  const listed = snapshot.runs.find((r) => r.id === run.id);
  assert.equal(listed.mode, "managed");
  assert.equal(listed.status, "completed");
  assert.equal(listed.attempt, 1);
  assert.ok(listed.elapsedMs >= 0);
  const reviewed = snapshot.tasks.find((tk) => tk.id === task.data.id);
  assert.equal(reviewed.status, "IN_PROGRESS");
  assert.equal(reviewed.review.status, "pending");
  assert.equal(reviewed.review.runId, run.id);
  const agent = snapshot.agents.find((a) => a.id === run.agentId);
  assert.equal(
    agent.runStatus,
    null,
    "finished runs no longer occupy the agent",
  );

  const inbox = await api("GET", "/api/inbox");
  assert.equal(inbox.status, 200);
  assert.equal(inbox.data.counts.reviews, 1);
  assert.equal(services.globalSnapshot().inbox.counts.reviews, 1);

  const review = await api("POST", `/api/runs/${run.id}/review`, {
    decision: "accept",
    note: "looks good",
  });
  assert.equal(review.status, 200);
  assert.equal(review.data.task.status, "COMPLETED");
  assert.equal((await api("GET", "/api/inbox")).data.counts.reviews, 0);

  const analytics = await api("GET", `/api/analytics?workspace=${workspaceId}`);
  assert.equal(analytics.status, 200);
  assert.equal(typeof analytics.data, "object");
  assert.ok("funnel" in analytics.data || "runs" in analytics.data);
  const csv = await fetch(
    `${base}/api/analytics/export?format=csv&workspace=${workspaceId}`,
  );
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
  assert.ok((await csv.text()).length > 0);
  assert.ok(
    services.audit
      .list({ runId: run.id })
      .some((entry) => entry.action === "run.start"),
  );
});

test("Claude Code hook bridge: git push under scoped policy asks, an API approval allows it, SessionEnd completes the run", async (t) => {
  const { services, api, cleanup } = await boot(t, { demo: false });
  const root = tempDir(cleanup, "hooked");
  const workspaceId = (
    await api("POST", "/api/workspaces", { name: "Hooked", rootPath: root })
  ).data.id;
  const policy = await api("PUT", `/api/workspaces/${workspaceId}/policy`, {
    autonomy: "scoped",
    deniedCommands: [],
  });
  assert.equal(policy.status, 200);
  assert.equal(
    (
      await api("PUT", "/api/settings", {
        "hooks.claudeCode.timeoutSeconds": 60,
      })
    ).status,
    200,
  );
  const hook = (event, extra = {}) => ({
    session_id: "sess-integration-1",
    transcript_path: path.join(root, "transcript.jsonl"),
    cwd: root,
    hook_event_name: event,
    permission_mode: "default",
    ...extra,
  });

  const pending = api(
    "POST",
    "/api/hooks/claude-code",
    hook("PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: "git push origin main" },
      tool_use_id: "toolu_integration_1",
    }),
  );
  const inbox = await waitFor(async () => {
    const result = await api("GET", "/api/inbox");
    return result.data.counts.approvals >= 1 ? result.data : null;
  });
  const approval = inbox.approvals[0];
  assert.equal(approval.kind, "command");
  assert.equal(approval.provider, "claude-code");
  assert.equal(approval.payload.command, "git push origin main");
  assert.equal(approval.workspaceId, workspaceId);
  assert.match(approval.reason, /git push/);

  const waiting = (await api("GET", `/api/workspaces/${workspaceId}/workspace`))
    .data;
  const agent = waiting.agents.find((a) => a.provider === "claude-code");
  assert.ok(agent, "hook auto-created a Claude Code agent");
  assert.equal(agent.state, "WAITING_APPROVAL");
  assert.equal(agent.runStatus, "waiting_approval");
  assert.equal(agent.runMode, "observed");
  assert.equal(services.globalSnapshot().inbox.counts.approvals, 1);
  assert.equal(services.globalSnapshot().inbox.approvals[0].id, approval.id);

  const decided = await api("POST", `/api/approvals/${approval.id}/decide`, {
    decision: "approve",
    note: "ship it",
  });
  assert.equal(decided.status, 200);
  assert.equal(decided.data.status, "approved");
  const result = await pending;
  assert.equal(result.status, 200);
  assert.equal(result.data.hookSpecificOutput.permissionDecision, "allow");
  assert.match(
    result.data.hookSpecificOutput.permissionDecisionReason,
    /approved in Agent Space by .*ship it/,
  );
  assert.equal(
    (
      await api("POST", `/api/approvals/${approval.id}/decide`, {
        decision: "deny",
      })
    ).status,
    409,
  );
  const run = services.recorder.find({
    provider: "claude-code",
    providerSessionId: "sess-integration-1",
  });
  assert.equal(run.status, "running");
  assert.ok(
    services.audit.list({ action: "approval.decide" }).length >= 1,
    "decisions are audited",
  );
  assert.equal(
    (await api("GET", `/api/audit?run=${run.id}`)).data.some(
      (entry) => entry.action === "approval.request",
    ),
    true,
  );

  const denied = await api(
    "POST",
    "/api/hooks/claude-code",
    hook("PreToolUse", {
      tool_name: "Read",
      tool_input: { file_path: path.join(root, ".env") },
      tool_use_id: "toolu_integration_2",
    }),
  );
  assert.equal(denied.data.hookSpecificOutput.permissionDecision, "deny");
  assert.match(
    denied.data.hookSpecificOutput.permissionDecisionReason,
    /file\.secret/,
  );

  const ended = await api(
    "POST",
    "/api/hooks/claude-code",
    hook("SessionEnd", { reason: "exit" }),
  );
  assert.equal(ended.status, 200);
  assert.deepEqual(ended.data, {});
  assert.equal(services.recorder.get(run.id).status, "completed");
  const after = (await api("GET", `/api/workspaces/${workspaceId}/workspace`))
    .data;
  assert.equal(
    after.tasks.find((tk) => tk.id === run.taskId).status,
    "COMPLETED",
  );
  assert.equal(after.agents.find((a) => a.id === agent.id).state, "IDLE");
});

test("export/import round trip keeps tasks, dependencies, agents, theme, and policy", async (t) => {
  const { api } = await boot(t, { demo: false });
  const created = await api("POST", "/api/workspaces", {
    name: "Portable",
    theme: "operations",
    policy: { autonomy: "sandbox", maxConcurrentRuns: 1 },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.theme, "operations");
  assert.equal(created.data.policy.autonomy, "sandbox");
  const workspaceId = created.data.id;
  const a = (
    await api("POST", `/api/workspaces/${workspaceId}/tasks`, {
      title: "Design",
      provider: "codex",
      deliverable: "A design note",
    })
  ).data;
  const b = (
    await api("POST", `/api/workspaces/${workspaceId}/tasks`, {
      title: "Build",
      dependsOn: [a.id],
    })
  ).data;
  assert.deepEqual(b.dependsOn, [a.id]);
  assert.equal(
    (
      await api("POST", `/api/workspaces/${workspaceId}/tasks`, {
        title: "Broken",
        dependsOn: ["missing"],
      })
    ).status,
    400,
  );
  const graph = await api("GET", `/api/workspaces/${workspaceId}/graph`);
  assert.equal(graph.status, 200);
  assert.deepEqual(graph.data.edges, [{ from: a.id, to: b.id }]);

  const exported = await api("GET", `/api/workspaces/${workspaceId}/export`);
  assert.equal(exported.status, 200);
  const manifest = exported.data;
  assert.equal(manifest.version, 1);
  assert.equal(manifest.workspace.theme, "operations");
  assert.equal(manifest.workspace.policy.autonomy, "sandbox");
  assert.equal(manifest.tasks.length, 2);
  const buildIndex = manifest.tasks.findIndex((task) => task.title === "Build");
  const designIndex = manifest.tasks.findIndex(
    (task) => task.title === "Design",
  );
  assert.deepEqual(manifest.tasks[buildIndex].dependsOn, [designIndex]);
  assert.equal(manifest.tasks[designIndex].provider, "codex");
  assert.ok(!("rootPath" in manifest.workspace));

  const imported = await api("POST", "/api/workspaces/import", {
    manifest,
    name: "Portable copy",
  });
  assert.equal(imported.status, 201);
  assert.equal(imported.data.tasks, 2);
  const copyId = imported.data.workspace.id;
  assert.notEqual(copyId, workspaceId);
  const snapshot = (await api("GET", `/api/workspaces/${copyId}/workspace`))
    .data;
  assert.equal(snapshot.workspace.name, "Portable copy");
  assert.equal(snapshot.workspace.theme, "operations");
  assert.equal(snapshot.workspace.policy.autonomy, "sandbox");
  const design = snapshot.tasks.find((task) => task.title === "Design");
  const build = snapshot.tasks.find((task) => task.title === "Build");
  assert.deepEqual(build.dependsOn, [design.id]);
  assert.equal(design.provider, "codex");
  assert.equal(design.deliverable, "A design note");
  assert.equal(design.source, "import");
  assert.equal(snapshot.agents.length, 6);
});

test("Workspace snapshot: manual runs keep the profile working state; agents expose provider fields", async (t) => {
  const { services } = await boot(t, { demo: false });
  const workspace = services.hub.get(
    services.hub.create({ name: "Manual", rootPath: "C:\\work\\manual" }).id,
  );
  const codex = workspace.createAgent({
    name: "Codex",
    role: "Coding assistant",
    provider: "codex",
  });
  assert.equal(codex.provider, "codex");
  assert.equal(codex.autoCreated, false);
  assert.throws(
    () => workspace.createAgent({ name: "X", role: "Y", provider: "nope" }),
    /provider must be/,
  );
  const task = workspace.create({ title: "Manual work", agentId: codex.id });
  const snapshot = workspace.snapshot();
  const agent = snapshot.agents.find((a) => a.id === codex.id);
  assert.equal(agent.state, "CODING");
  assert.equal(agent.activityProvenance, "user");
  assert.equal(agent.runMode, "manual");
  assert.equal(agent.runStatus, "running");
  assert.equal(agent.runProvider, "manual");
  assert.equal(agent.activity, null);
  assert.equal(agent.taskTitle, "Manual work");
  assert.ok(agent.elapsedMs >= 0);
  const stored = snapshot.tasks.find((tk) => tk.id === task.id);
  assert.deepEqual(stored.dependsOn, []);
  assert.deepEqual(stored.review, {});
  assert.equal(stored.provider, null);
  assert.ok(typeof stored.updatedAt === "number");
  workspace.update(task.id, { status: "BLOCKED" });
  assert.equal(
    workspace.snapshot().agents.find((a) => a.id === codex.id).state,
    "BLOCKED",
  );
  workspace.update(task.id, { status: "IN_PROGRESS" });
  workspace.update(task.id, { status: "COMPLETED" });
  const finished = workspace.snapshot();
  assert.equal(finished.agents.find((a) => a.id === codex.id).state, "IDLE");
  assert.equal(finished.runs[0].status, "completed");
  assert.equal(finished.runs[0].mode, "manual");
  assert.equal(finished.events[0].provenance, "system");
  assert.equal(snapshot.workspace.theme, "studio");
  assert.equal(snapshot.workspace.policy.autonomy, "scoped");
});
