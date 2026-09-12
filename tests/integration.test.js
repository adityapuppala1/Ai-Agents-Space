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
import {
  signPayload,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  EVENT_ID_HEADER,
} from "../packages/core/src/webhooks/WebhookService.js";
import { classifyFailure } from "../packages/core/src/runs/retry.js";

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
    // Webhook signing secrets live in the environment and are referenced by
    // NAME from the endpoint row; the value is never written to the database.
    TEST_WEBHOOK_SECRET: "s3cr3t-for-tests",
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
  // Wave 2 appended migrations; the contract is "at least the v2 schema".
  assert.ok(health.data.schemaVersion >= 2);
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
    // Wave 2: every new module is composed in dependency order.
    "graph",
    "budget",
    "queue",
    "retry",
    "checkpoints",
    "dryRun",
    "suggest",
    "webhooks",
    "incidents",
    "backup",
    "health",
    "diagnostics",
    "retention",
    "search",
  ])
    assert.ok(services[key], `services.${key} attached`);
  // Modules that were planned but not delivered stay undefined rather than
  // being faked; every consumer guards with optional chaining.
  await services.ready;

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
    ["GET", "/api/ops/health"],
    ["GET", "/api/ops/status"],
    ["GET", "/api/ops/dispatch-allowed"],
    ["GET", "/api/audit/verify"],
    ["GET", "/api/webhooks/endpoints"],
    ["GET", "/api/webhooks/deliveries"],
    ["GET", "/api/search?q=demo"],
    ["GET", "/api/search/kinds"],
    ["GET", "/api/workspaces/demo/checkpoints"],
    ["GET", "/api/workspaces/demo/inbox"],
    ["GET", "/api/workspaces/demo/supervisor"],
    ["GET", "/api/workspaces/demo/validate"],
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
  // Wave 2 global-channel sections: counts and top-N only, never full tables.
  assert.deepEqual(Object.keys(payload.inbox.urgency).sort(), [
    "failedRuns",
    "oldestApprovalAgeMs",
    "overdueApprovals",
    "pendingReviews",
    "questions",
  ]);
  assert.equal(payload.inbox.urgency.oldestApprovalAgeMs, null);
  assert.ok(payload.providers && typeof payload.providers.health === "object");
  assert.ok(Array.isArray(payload.providers.outages));
  assert.equal(payload.providers.breakersOpen, 0);
  assert.equal(payload.operations.dispatchStopped, false);
  assert.equal(payload.operations.unacknowledgedStops, 0);
  assert.ok(["ok", "degraded", "down"].includes(payload.health.status));
  assert.ok(Array.isArray(payload.health.alerts));
  assert.ok(
    payload.health.alerts.length <= 5,
    "the global payload carries at most the top 5 alerts",
  );
  assert.equal(payload.settings["observation.enabled"], true);
  assert.equal(payload.settings["ui.graphics"], "auto");
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
  // Wave 2 snapshot additions the UI needs.
  assert.ok(
    snapshot.agents.every((agent) => typeof agent.team === "string"),
    "every agent carries a team name (the profile field, else the role)",
  );
  assert.equal(worker.team, worker.role);
  assert.ok(
    snapshot.runs.every((run) => "tests" in run),
    "runs report test results explicitly, null meaning none were recorded",
  );
  assert.ok(snapshot.runs.every((run) => run.tests === null));
  assert.ok(
    snapshot.tasks.every(
      (task) =>
        "contract" in task &&
        "branch" in task &&
        "reviewer" in task &&
        "repairOf" in task,
    ),
  );
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

test("visual preset preview is read-only and apply changes only visual workspace fields", async (t) => {
  const { api } = await boot(t, { demo: false });
  const created = await api("POST", "/api/workspaces", { name: "Visual source" });
  const id = created.data.id;
  const preset = {
    kind: "agent-space-visual-preset",
    version: 1,
    name: "Night shift",
    theme: "midnight",
    settings: { graphics: "high", lighting: "focus", labelDensity: "active" },
  };
  const before = await api("GET", `/api/workspaces/${id}`);
  const preview = await api("POST", `/api/workspaces/${id}/visual-preset/preview`, { preset });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.changes.length, 4);
  assert.equal((await api("GET", `/api/workspaces/${id}`)).data.theme, before.data.theme);
  const applied = await api("POST", `/api/workspaces/${id}/visual-preset/apply`, { preset });
  assert.equal(applied.status, 200);
  assert.equal(applied.data.workspace.theme, "midnight");
  assert.deepEqual(applied.data.workspace.settings.visual, {
    "ui.graphics": "high",
    "ui.office.lighting": "focus",
    "ui.office.labelDensity": "active",
  });
  const rejected = await api("POST", `/api/workspaces/${id}/visual-preset/preview`, {
    preset: { ...preset, policy: { autonomy: "full" } },
  });
  assert.equal(rejected.status, 400);
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
  // The profile's working style, not a report: clients show "in progress".
  assert.equal(agent.activityProvenance, "profile");
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

test("operations: health, stop-all halts every dispatch path, backup drill, retention sweep, audit chain", async (t) => {
  const { services, api, cleanup } = await boot(t, { demo: false });
  const root = tempDir(cleanup, "ops-repo");
  const workspaceId = (
    await api("POST", "/api/workspaces", { name: "Ops", rootPath: root })
  ).data.id;
  const taskId = (
    await api("POST", `/api/workspaces/${workspaceId}/tasks`, {
      title: "Say hello",
      provider: "claude-code",
    })
  ).data.id;

  // Health snapshot: every section present, alerts carry a plain-language fix.
  const health = await api("GET", "/api/ops/health");
  assert.equal(health.status, 200);
  assert.ok(["ok", "degraded", "down"].includes(health.data.status));
  assert.ok(health.data.db.writable);
  assert.ok(health.data.schemaVersion >= 2);
  for (const key of ["queue", "providers", "observation", "approvals"])
    assert.ok(key in health.data, `health.${key}`);
  for (const alert of health.data.alerts)
    assert.ok(alert.level && alert.code && alert.title && alert.fix);

  // A POST that changes operational state needs an explicit confirmation.
  assert.equal((await api("POST", "/api/ops/stop-all", {})).status, 400);

  const stopped = await api("POST", "/api/ops/stop-all", {
    confirm: true,
    reason: "integration drill",
  });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.data.dispatchStopped, true);
  assert.equal(
    (await api("GET", "/api/ops/dispatch-allowed")).data.allowed,
    false,
  );
  // The guard is server-side: the API refuses, and so does the worker itself.
  const refused = await api(
    "POST",
    `/api/workspaces/${workspaceId}/tasks/${taskId}/run`,
    { provider: "claude-code", prompt: "hi" },
  );
  assert.equal(refused.status, 409, JSON.stringify(refused.data));
  assert.match(refused.data.error, /stopped by an operator/i);
  await assert.rejects(
    () =>
      services.runWorker.start({
        workspaceId,
        taskId,
        provider: "claude-code",
      }),
    /stopped by an operator/i,
  );
  const stoppedSnapshot = services.globalSnapshot();
  assert.equal(stoppedSnapshot.operations.dispatchStopped, true);
  assert.equal(stoppedSnapshot.operations.reason, "integration drill");

  const resumed = await api("POST", "/api/ops/resume", { confirm: true });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data.dispatchStopped, false);
  assert.equal(
    (await api("GET", "/api/ops/dispatch-allowed")).data.allowed,
    true,
  );

  // Backup + restore drill. The live database is never overwritten.
  const backupDir = tempDir(cleanup, "backup");
  const outPath = path.join(backupDir, "agent-space.sqlite");
  const backup = await api("POST", "/api/ops/backup", {
    confirm: true,
    outPath,
    label: "integration",
  });
  assert.equal(backup.status, 200, JSON.stringify(backup.data));
  assert.ok(fs.existsSync(backup.data.path));
  assert.ok(fs.existsSync(backup.data.manifestPath));
  assert.ok(backup.data.manifest.schemaVersion >= 2);
  assert.equal(backup.data.sha256.length, 64);
  const drill = await api("POST", "/api/ops/restore-drill", {
    confirm: true,
    tmpDir: tempDir(cleanup, "drill"),
  });
  assert.equal(drill.status, 200, JSON.stringify(drill.data));
  assert.equal(drill.data.ok, true);

  // Retention: disabled by default, previewed before it deletes anything.
  const retention = await api("GET", "/api/ops/retention");
  assert.equal(retention.status, 200);
  assert.equal(retention.data.policy.enabled, false);
  const set = await api("PUT", "/api/ops/retention", {
    enabled: true,
    eventsDays: 1,
    runsDays: null,
    auditDays: null,
  });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  assert.equal(set.data.policy.enabled, true);
  assert.equal(set.data.policy.eventsDays, 1);
  const dry = await api("POST", "/api/ops/retention/sweep", {
    confirm: true,
    dryRun: true,
  });
  assert.equal(dry.status, 200);
  assert.equal(dry.data.deleted, false, "a dry run deletes nothing");
  const sweep = await api("POST", "/api/ops/retention/sweep", {
    confirm: true,
  });
  assert.equal(sweep.status, 200);
  assert.notEqual(sweep.data.deleted, false);
  assert.ok(
    services.audit.list({ action: "ops.retention.sweep" }).length >= 1,
    "every sweep is audited",
  );

  // The audit hash chain still verifies after all of the above.
  const verify = await api("GET", "/api/audit/verify");
  assert.equal(verify.status, 200);
  assert.equal(verify.data.ok, true, JSON.stringify(verify.data));
  assert.ok(verify.data.count > 0);
});

test("webhooks: a signed inbound request is accepted once; a bad signature and a replay are refused", async (t) => {
  const { api, base } = await boot(t, { demo: false });
  const created = await api("POST", "/api/webhooks/endpoints", {
    name: "CI",
    direction: "inbound",
    secretRef: "TEST_WEBHOOK_SECRET",
  });
  assert.ok(
    created.status === 200 || created.status === 201,
    JSON.stringify(created.data),
  );
  const endpoint = created.data;
  assert.equal(endpoint.direction, "inbound");
  assert.equal(endpoint.secretRef, "TEST_WEBHOOK_SECRET");
  assert.ok(
    !JSON.stringify(endpoint).includes("s3cr3t-for-tests"),
    "the secret value never leaves the environment",
  );

  const secret = "s3cr3t-for-tests";
  const post = async (raw, { timestamp, signature, eventId }) => {
    const response = await fetch(`${base}/api/webhooks/${endpoint.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [TIMESTAMP_HEADER]: String(timestamp),
        ...(signature ? { [SIGNATURE_HEADER]: signature } : {}),
        ...(eventId ? { [EVENT_ID_HEADER]: eventId } : {}),
      },
      body: raw,
    });
    return { status: response.status, data: await response.json() };
  };

  const raw = JSON.stringify({ status: "green", build: 42 });
  const now = Date.now();
  const good = await post(raw, {
    timestamp: now,
    signature: signPayload(secret, now, raw),
    eventId: "build-42",
  });
  assert.equal(good.status, 200, JSON.stringify(good.data));
  assert.equal(good.data.ok, true);
  assert.equal(good.data.externalId, "build-42");
  assert.ok(good.data.inboxId);

  // Same external id again → recorded as a duplicate, never processed twice.
  const replay = await post(raw, {
    timestamp: Date.now(),
    signature: signPayload(secret, Date.now(), raw),
    eventId: "build-42",
  });
  assert.equal(replay.data.ok, false);
  assert.ok(
    replay.data.duplicate === true || replay.data.replay === true,
    JSON.stringify(replay.data),
  );

  // A forged signature is refused and still recorded, so the attempt is visible.
  const forged = await post(raw, {
    timestamp: Date.now(),
    signature: "sha256=deadbeef",
    eventId: "build-43",
  });
  assert.notEqual(forged.data.ok, true);
  const inbox = await api("GET", "/api/webhooks/inbox");
  assert.equal(inbox.status, 200);
  const entries = Array.isArray(inbox.data) ? inbox.data : inbox.data.entries;
  assert.ok(entries.length >= 2, "every request is recorded with its verdict");
  assert.ok(entries.some((entry) => entry.signatureOk === false));
});

test("search finds recorded tasks and stays honest when nothing matches", async (t) => {
  const { api, cleanup } = await boot(t, { demo: false });
  const root = tempDir(cleanup, "search-repo");
  const workspaceId = (
    await api("POST", "/api/workspaces", { name: "Searchable", rootPath: root })
  ).data.id;
  await api("POST", `/api/workspaces/${workspaceId}/tasks`, {
    title: "Refactor the payment gateway",
    description: "Split the gateway adapter into smaller modules",
    deliverable: "A smaller adapter",
  });

  const hit = await api("GET", "/api/search?q=payment%20gateway");
  assert.equal(hit.status, 200);
  assert.equal(hit.data.empty, false);
  const task = hit.data.results.find((r) => r.kind === "tasks");
  assert.ok(task, "the task is found");
  assert.equal(task.title, "Refactor the payment gateway");
  assert.equal(task.workspaceId, workspaceId);
  assert.ok(task.snippet.length > 0);
  assert.equal(typeof task.timestamp, "number");
  for (const key of [
    "kind",
    "id",
    "title",
    "snippet",
    "workspaceId",
    "runId",
    "timestamp",
  ])
    assert.ok(key in task, `result.${key}`);

  // Kind filter.
  const onlyRuns = await api("GET", "/api/search?q=payment&kinds=runs");
  assert.deepEqual(onlyRuns.data.kinds, ["runs"]);
  assert.equal(onlyRuns.data.results.length, 0);

  // Workspace scoping.
  const other = (
    await api("POST", "/api/workspaces", { name: "Other", rootPath: root })
  ).data.id;
  const scoped = await api("GET", `/api/search?q=payment&workspace=${other}`);
  assert.equal(scoped.data.empty, true);

  // Honest empty result; the note says what search does and does not do.
  const miss = await api("GET", "/api/search?q=zzz-nothing-here-zzz");
  assert.equal(miss.status, 200);
  assert.equal(miss.data.empty, true);
  assert.deepEqual(miss.data.results, []);
  assert.match(miss.data.note, /never reads file contents from disk/);

  // A LIKE wildcard in the query is a literal, not a match-everything.
  const wildcard = await api("GET", "/api/search?q=%25");
  assert.equal(wildcard.data.empty, true);
});

test("budget: a per-run token ceiling refuses the launch before anything spawns, and a failure is classified", async (t) => {
  const { services, api, cleanup } = await boot(t, { demo: false });
  await services.connections.refresh();
  const root = tempDir(cleanup, "budget-repo");
  const workspaceId = (
    await api("POST", "/api/workspaces", { name: "Budget", rootPath: root })
  ).data.id;
  const taskId = (
    await api("POST", `/api/workspaces/${workspaceId}/tasks`, {
      title: "Expensive task",
      provider: "claude-code",
    })
  ).data.id;

  // A one-token ceiling cannot be met by any prompt, so the run is refused
  // before a process is spawned. The message says what to change.
  assert.equal(
    (
      await api("PATCH", `/api/workspaces/${workspaceId}`, {
        policy: { budget: { maxTokensPerRun: 1 } },
      })
    ).status,
    200,
  );
  const before = services.recorder.active().length;
  const refused = await api(
    "POST",
    `/api/workspaces/${workspaceId}/tasks/${taskId}/run`,
    { provider: "claude-code", prompt: "a prompt that is far too long to fit" },
  );
  assert.equal(refused.status, 429, JSON.stringify(refused.data));
  assert.match(refused.data.error, /budget\.maxTokensPerRun/);
  assert.equal(services.recorder.active().length, before, "nothing spawned");

  // Headroom is reported as an estimate, never as a fact.
  const headroom = services.budget.headroom(workspaceId);
  assert.match(headroom.basis, /estimate/);

  // Failure classification is available to every caller, not only the worker.
  const auth = classifyFailure({
    exitCode: 41,
    error:
      "Please set an Auth method in your C:\\Users\\me\\.gemini\\settings.json",
    events: [],
    adapter: "gemini",
  });
  assert.equal(auth.class, "auth");
  assert.equal(auth.retryable, false);
  assert.equal(auth.sideEffects, "none");
  const transport = classifyFailure({
    exitCode: null,
    spawnError: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    events: [],
    adapter: "claude-code",
  });
  assert.ok(["transport", "provider-error"].includes(transport.class));
});

test("orchestration: a contract the run cannot meet opens a review task, and a checkpoint restores it", async (t) => {
  const { services, api, cleanup } = await boot(t, { demo: false });
  await services.connections.refresh();
  const root = tempDir(cleanup, "contract-repo");
  const workspaceId = (
    await api("POST", "/api/workspaces", { name: "Contract", rootPath: root })
  ).data.id;
  const taskId = (
    await api("POST", `/api/workspaces/${workspaceId}/tasks`, {
      title: "Ship the greeting",
      provider: "claude-code",
      deliverable: "A greeting",
    })
  ).data.id;

  // The fake Claude CLI never runs a test command, so this criterion cannot be
  // met — which is exactly the point: the contract is checked against what was
  // actually recorded.
  const contract = await api(
    "PUT",
    `/api/workspaces/${workspaceId}/tasks/${taskId}/contract`,
    { contract: { completionCriteria: ["artifact:test-output"] } },
  );
  assert.equal(contract.status, 200, JSON.stringify(contract.data));
  assert.deepEqual(contract.data.contract.completionCriteria, [
    "artifact:test-output",
  ]);

  // A checkpoint of the task state before the run.
  const checkpoint = await api(
    "POST",
    `/api/workspaces/${workspaceId}/checkpoints`,
    { kind: "manual", label: "before the run", taskId },
  );
  assert.ok(
    checkpoint.status === 200 || checkpoint.status === 201,
    JSON.stringify(checkpoint.data),
  );

  const launched = await api(
    "POST",
    `/api/workspaces/${workspaceId}/tasks/${taskId}/run`,
    { provider: "claude-code", prompt: "hello from the contract test" },
  );
  assert.equal(launched.status, 201, JSON.stringify(launched.data));
  const done = await services.runWorker.wait(launched.data.id, 20000);
  assert.equal(done.status, "completed");

  // The contract check ran on finish and opened a review with the reason.
  const review = await waitFor(async () => {
    const snapshot = (
      await api("GET", `/api/workspaces/${workspaceId}/workspace`)
    ).data;
    const task = snapshot.tasks.find((tk) => tk.id === taskId);
    return task?.review?.status === "pending" ? task : null;
  });
  assert.equal(review.review.status, "pending");
  assert.ok(
    review.review.failures?.some((failure) =>
      /artifact/.test(failure.criterion ?? ""),
    ),
    JSON.stringify(review.review),
  );
  assert.deepEqual(review.contract.completionCriteria, [
    "artifact:test-output",
  ]);
  assert.ok(
    services.audit.list({ action: "task.contract.failed" }).length >= 1,
  );

  // The inbox counts it, and the global snapshot's urgency section sees it.
  const global = services.globalSnapshot();
  assert.ok(global.inbox.counts.reviews >= 1);
  assert.ok(global.inbox.urgency.pendingReviews >= 1);

  // Restoring the checkpoint moves the task state back and says out loud that
  // file side effects are NOT rolled back.
  const restored = await api(
    "POST",
    `/api/checkpoints/${checkpoint.data.id}/restore`,
    { dryRun: false },
  );
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.ok(
    JSON.stringify(restored.data).match(/not.*(rolled back|undone)/i),
    JSON.stringify(restored.data),
  );
});

test("lineage, evaluation dimensions, and the collab/extension routes after a fake-CLI managed run", async (t) => {
  const { services, api, cleanup } = await boot(t, { demo: false });
  await services.connections.refresh();
  const root = tempDir(cleanup, "lineage-repo");
  const workspaceId = (
    await api("POST", "/api/workspaces", { name: "Lineage", rootPath: root })
  ).data.id;
  const task = (
    await api("POST", `/api/workspaces/${workspaceId}/tasks`, {
      title: "Trace me",
      provider: "claude-code",
      deliverable: "A greeting",
    })
  ).data;
  const run = (
    await api("POST", `/api/workspaces/${workspaceId}/tasks/${task.id}/run`, {
      provider: "claude-code",
      prompt: "hello lineage",
    })
  ).data;
  const done = await services.runWorker.wait(run.id, 20000);
  assert.equal(done.status, "completed");

  // Lineage: input -> run -> tool -> artifact, reachable through the
  // registered analytics route as well as the composed service.
  const lineage = await api("GET", `/api/analytics/lineage?run=${run.id}`);
  assert.equal(lineage.status, 200, JSON.stringify(lineage.data));
  const nodes = lineage.data.nodes ?? [];
  const edges = lineage.data.edges ?? [];
  assert.ok(
    nodes.some((node) => node.type === "run"),
    `no run node: ${JSON.stringify(nodes.slice(0, 5))}`,
  );
  assert.ok(edges.length > 0, "lineage edges");
  assert.ok(services.lineage, "services.lineage is composed");

  // Evaluation: five separate dimensions, and two we refuse to assert.
  const dimensions = await api("GET", "/api/evaluations/dimensions");
  assert.equal(dimensions.status, 200, JSON.stringify(dimensions.data));
  assert.ok(dimensions.data.dimensions.length >= 5);
  assert.deepEqual(dimensions.data.neverAssertedByUs, [
    "correctness",
    "security",
  ]);

  // An objective grader may not assert correctness: the API says why.
  const refused = await api("POST", "/api/evaluations", {
    runId: run.id,
    dimension: "correctness",
    verdict: "pass",
    grader: { kind: "objective", identity: "agent-space" },
  });
  assert.equal(refused.status, 400, JSON.stringify(refused.data));

  // A human verdict on the same dimension is stored as a claim with its grader.
  const recorded = await api("POST", "/api/evaluations", {
    runId: run.id,
    dimension: "correctness",
    verdict: "pass",
    grader: { kind: "human", identity: "local-user" },
    rubric: "The greeting is present",
  });
  assert.equal(recorded.status, 201, JSON.stringify(recorded.data));
  const listed = await api("GET", `/api/evaluations?run=${run.id}`);
  assert.equal(listed.data.evaluations.length, 1);
  assert.equal(listed.data.evaluations[0].grader.kind, "human");

  // Objective dimensions ARE computed from what was recorded.
  const objective = await api(
    "POST",
    `/api/runs/${run.id}/evaluate/objective`,
    {},
  );
  assert.equal(objective.status, 200, JSON.stringify(objective.data));

  // Collab routes are registered before workspaces.js: a handover brief is
  // built from stored records only.
  const brief = await api(
    "POST",
    `/api/workspaces/${workspaceId}/handover/preview`,
    { runId: run.id },
  );
  assert.equal(brief.status, 200, JSON.stringify(brief.data));
  assert.ok(brief.data.markdown.length > 0);
  const decisions = await api("GET", `/api/runs/${run.id}/decisions`);
  assert.equal(decisions.status, 200, JSON.stringify(decisions.data));

  // Extension routes are registered and claim only their own template paths;
  // GET /api/templates still belongs to workflows.js.
  const templates = await api("GET", "/api/templates");
  assert.equal(templates.status, 200);
  assert.ok((templates.data.templates ?? templates.data).length >= 13);
  const exported = await api("GET", "/api/templates/feature-delivery/export");
  assert.equal(exported.status, 200, JSON.stringify(exported.data));
  const extensions = await api("GET", "/api/extensions");
  assert.equal(extensions.status, 200, JSON.stringify(extensions.data));
  assert.ok(Array.isArray(extensions.data.extensions ?? extensions.data));
});

test("git connector reads a temp repository through the API; writes stay refused", async (t) => {
  const { services, api, cleanup } = await boot(t, { demo: false });
  const root = tempDir(cleanup, "connector-repo");
  const { execFileSync } = await import("node:child_process");
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      stdio: "ignore",
      windowsHide: true,
    });
  let hasGit = true;
  try {
    git(["init", "-b", "main"]);
    git(["config", "user.email", "test@example.invalid"]);
    git(["config", "user.name", "Agent Space Test"]);
    fs.writeFileSync(path.join(root, "README.md"), "hello\n");
    git(["add", "README.md"]);
    git(["commit", "-m", "first"]);
  } catch {
    hasGit = false;
  }

  const workspaceId = (
    await api("POST", "/api/workspaces", { name: "Repo", rootPath: root })
  ).data.id;

  const capabilities = await api("GET", "/api/connectors/git/capabilities");
  assert.equal(capabilities.status, 200, JSON.stringify(capabilities.data));
  // Writes are declared empty whether or not git is installed.
  assert.deepEqual(capabilities.data.writes, []);
  assert.ok(services.connectorRegistry, "services.connectorRegistry composed");
  if (!capabilities.data.available || !hasGit) {
    // Honest degradation: a reason, never a guessed status.
    assert.ok(capabilities.data.reason, "an unavailable connector says why");
    return;
  }

  const status = await api("POST", "/api/connectors/git/read", {
    op: "status",
    params: { workspaceId },
  });
  assert.equal(status.status, 200, JSON.stringify(status.data));
  assert.equal(status.data.result.clean, true);
  assert.equal(status.data.result.branch, "main");

  const log = await api("POST", "/api/connectors/git/read", {
    op: "log",
    params: { workspaceId, limit: 5 },
  });
  assert.equal(log.status, 200, JSON.stringify(log.data));
  assert.ok(JSON.stringify(log.data.result).includes("first"));

  // A write op the connector does not declare is refused, not attempted.
  const write = await api("POST", "/api/connectors/git/write", {
    op: "push",
    params: { workspaceId },
    confirm: true,
  });
  assert.ok(write.status >= 400, JSON.stringify(write.data));
});

test("the MCP stdio bridge answers initialize and a tool call over the HTTP API", async (t) => {
  const { api, base } = await boot(t, { demo: false });
  await api("POST", "/api/workspaces", {
    name: "Bridged",
    rootPath: path.join(os.tmpdir(), "agent-space-bridged"),
  });
  const { spawn } = await import("node:child_process");
  const script = path.join(here, "..", "bin", "agent-space-mcp.js");
  const child = spawn(process.execPath, [script, "--url", base], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => child.kill());

  let stdout = "";
  const frames = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    const lines = stdout.split("\n");
    stdout = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) frames.push(JSON.parse(line));
  });
  const frameFor = (id) =>
    waitFor(() => frames.find((frame) => frame.id === id) ?? null, {
      timeout: 15000,
    });
  const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "integration-test", version: "1" },
      capabilities: {},
    },
  });
  const initialized = await frameFor(1);
  assert.equal(initialized.result.serverInfo.name, "agent-space");
  assert.ok(initialized.result.capabilities.tools);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = await frameFor(2);
  assert.ok(tools.result.tools.length >= 11);
  assert.ok(tools.result.tools.some((tool) => tool.name === "list_workspaces"));

  send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "list_workspaces", arguments: {} },
  });
  const called = await frameFor(3);
  assert.equal(called.result.isError, false, JSON.stringify(called.result));
  assert.match(JSON.stringify(called.result.content), /Bridged/);

  // stdout carried protocol frames only: every line above parsed as JSON.
  assert.equal(stdout.trim(), "");
});
