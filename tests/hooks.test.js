import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createServices } from "../packages/core/src/services.js";
import { RunRecorder } from "../packages/core/src/runs/RunRecorder.js";
import { Settings } from "../packages/core/src/settings/Settings.js";
import { Audit } from "../packages/core/src/audit/Audit.js";
import { Policy } from "../packages/core/src/policy/Policy.js";
import { ApprovalService } from "../packages/core/src/approvals/ApprovalService.js";
import {
  createHookBridge,
  requestFromTool,
  kindForTool,
} from "../packages/core/src/hooks/claudeHookBridge.js";
import {
  install,
  uninstall,
  status,
  defaultCommand,
  isTrustedCommand,
  HOOK_EVENTS,
} from "../packages/core/src/hooks/installer.js";
import hookRoutes from "../packages/server/src/routes/hooks.js";
import settingsRoutes from "../packages/server/src/routes/settings.js";
import auditRoutes from "../packages/server/src/routes/audit.js";
import policyRoutes from "../packages/server/src/routes/policy.js";

const CWD =
  process.platform === "win32" ? "C:\\proj\\demo-app" : "/proj/demo-app";
const sep = process.platform === "win32" ? "\\" : "/";
const inside = (rel) => `${CWD}${sep}${rel}`;

function setup({ workspace = true, policy } = {}) {
  const services = createServices({ demo: false });
  services.settings = new Settings(services.db);
  services.audit = new Audit(services.db);
  services.policy = new Policy(services);
  services.recorder = new RunRecorder(services, { broadcastIntervalMs: 1 });
  services.approvals = new ApprovalService(services, { sweepMs: 1_000_000 });
  services.hookBridge = createHookBridge(services);
  let ws = null;
  if (workspace) {
    ws = services.hub.get(
      services.hub.create({ name: "Demo app", rootPath: CWD }).id,
    );
    if (policy) services.policy.setForWorkspace(ws.id, policy);
  }
  return { services, workspace: ws, bridge: services.hookBridge };
}

const hook = (event, extra = {}) => ({
  session_id: "sess-1",
  transcript_path: inside(".claude-transcript.jsonl"),
  cwd: CWD,
  hook_event_name: event,
  permission_mode: "default",
  ...extra,
});

const runFor = (services, sessionId = "sess-1") =>
  services.recorder.find({
    provider: "claude-code",
    providerSessionId: sessionId,
  });

test("request/kind mapping per Claude tool", () => {
  assert.deepEqual(requestFromTool("Bash", { command: "ls" }, CWD), {
    kind: "command",
    tool: "Bash",
    command: "ls",
    cwd: CWD,
  });
  assert.equal(requestFromTool("Edit", { file_path: "a.js" }).access, "write");
  assert.equal(requestFromTool("Read", { file_path: "a.js" }).access, "read");
  assert.equal(
    requestFromTool("NotebookEdit", { notebook_path: "n.ipynb" }).path,
    "n.ipynb",
  );
  assert.equal(
    requestFromTool("WebFetch", { url: "https://x" }).kind,
    "network",
  );
  assert.equal(requestFromTool("WebSearch", { query: "q" }).query, "q");
  assert.equal(requestFromTool("TodoWrite", {}).kind, "tool");
  assert.equal(kindForTool("Edit"), "file.edit");
  assert.equal(kindForTool("Read"), "file.read");
  assert.equal(kindForTool("Grep"), "search");
  assert.equal(kindForTool("WebSearch"), "web");
  assert.equal(kindForTool("Bash", { command: "npm test" }), "test");
  assert.equal(kindForTool("Bash", { command: "ls" }), "command");
  assert.equal(kindForTool("Task"), "delegation");
  assert.equal(kindForTool("mcp__x__y"), "tool.start");
});

test("PreToolUse Read → allow, run auto-created in the workspace matching cwd, event recorded with provenance", async () => {
  const { services, workspace, bridge } = setup();
  const result = await bridge.handleHook(
    hook("PreToolUse", {
      tool_name: "Read",
      tool_input: { file_path: inside("src\\index.js") },
      tool_use_id: "toolu_1",
    }),
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(result.body.hookSpecificOutput.permissionDecision, "allow");
  assert.match(
    result.body.hookSpecificOutput.permissionDecisionReason,
    /file\.in-scope/,
  );
  const run = runFor(services);
  assert.ok(run);
  assert.equal(run.workspaceId, workspace.id);
  assert.equal(run.mode, "observed");
  assert.equal(run.cwd, CWD);
  assert.equal(run.status, "running");
  const agent = workspace.profiles.get(run.agentId);
  assert.equal(agent.name, "Claude Code");
  const row = services.db
    .prepare("SELECT provider, auto_created FROM agent_profiles WHERE id = ?")
    .get(agent.id);
  assert.equal(row.provider, "claude-code");
  assert.equal(row.auto_created, 1);
  const events = services.recorder.events(run.id);
  const read = events.find((e) => e.kind === "file.read");
  assert.ok(read);
  assert.equal(read.provenance, "provider");
  assert.equal(read.tool, "Read");
  assert.equal(read.providerEventId, "hook:sess-1:toolu_1:pre");
  assert.equal(read.data.activity, "RESEARCHING");
  assert.equal(read.data.policy.decision, "allow");
  assert.equal(services.recorder.get(run.id).activity, "RESEARCHING");
  // Duplicate delivery is deduped by providerEventId.
  await bridge.handleHook(
    hook("PreToolUse", {
      tool_name: "Read",
      tool_input: { file_path: inside("src\\index.js") },
      tool_use_id: "toolu_1",
    }),
  );
  assert.equal(
    services.recorder.events(run.id).filter((e) => e.kind === "file.read")
      .length,
    1,
  );
  const task = workspace.store.get(run.taskId);
  assert.equal(task.source, "observed");
  assert.equal(task.status, "IN_PROGRESS");
});

test("PreToolUse Bash 'git push' under scoped → ask → approve in another tick → allow", async () => {
  const { services, bridge } = setup({
    policy: { autonomy: "scoped", deniedCommands: [] },
  });
  services.settings.set("hooks.claudeCode.timeoutSeconds", 60);
  const pending = bridge.handleHook(
    hook("PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: "git push origin main", description: "push" },
      tool_use_id: "toolu_2",
    }),
  );
  await new Promise((r) => setTimeout(r, 5));
  const inbox = services.approvals.inbox();
  assert.equal(inbox.counts.approvals, 1);
  const approval = inbox.approvals[0];
  assert.equal(approval.kind, "command");
  assert.equal(approval.provider, "claude-code");
  assert.equal(approval.providerRef, "sess-1");
  assert.equal(approval.payload.command, "git push origin main");
  assert.equal(approval.payload.tool_name, "Bash");
  assert.match(approval.reason, /git push/);
  assert.ok(approval.expiresAt - approval.requestedAt <= 55_000);
  const run = runFor(services);
  assert.equal(services.recorder.get(run.id).status, "waiting_approval");
  services.approvals.decide(approval.id, {
    decision: "approve",
    actor: "alice",
    note: "go",
  });
  const result = await pending;
  assert.equal(result.body.hookSpecificOutput.permissionDecision, "allow");
  assert.match(
    result.body.hookSpecificOutput.permissionDecisionReason,
    /approved in Agent Space by alice: go/,
  );
  assert.equal(services.recorder.get(run.id).status, "running");
  const kinds = services.recorder.events(run.id).map((e) => e.kind);
  assert.ok(kinds.includes("command"));
  assert.ok(kinds.includes("approval.request"));
  assert.ok(kinds.includes("approval.decision"));
});

test("PreToolUse deny paths: denied list, out-of-scope file, secret file, propose write, denied decision", async () => {
  const { services, bridge } = setup();
  const denied = await bridge.handleHook(
    hook("PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: "git push --force" },
      tool_use_id: "t1",
    }),
  );
  assert.equal(denied.body.hookSpecificOutput.permissionDecision, "deny");
  assert.match(
    denied.body.hookSpecificOutput.permissionDecisionReason,
    /command\.denied/,
  );
  const outside = await bridge.handleHook(
    hook("PreToolUse", {
      tool_name: "Edit",
      tool_input: {
        file_path:
          process.platform === "win32" ? "C:\\Windows\\hosts" : "/etc/hosts",
      },
      tool_use_id: "t2",
    }),
  );
  assert.equal(outside.body.hookSpecificOutput.permissionDecision, "deny");
  const secret = await bridge.handleHook(
    hook("PreToolUse", {
      tool_name: "Read",
      tool_input: { file_path: inside(".env") },
      tool_use_id: "t3",
    }),
  );
  assert.equal(secret.body.hookSpecificOutput.permissionDecision, "deny");
  assert.match(
    secret.body.hookSpecificOutput.permissionDecisionReason,
    /file\.secret/,
  );
  assert.equal(services.audit.list({ action: "hook.deny" }).length, 3);

  const run = runFor(services);
  services.policy.setForWorkspace(run.workspaceId, { autonomy: "propose" });
  const write = await bridge.handleHook(
    hook("PreToolUse", {
      tool_name: "Write",
      tool_input: { file_path: inside("new.js"), content: "x" },
      tool_use_id: "t4",
    }),
  );
  assert.equal(write.body.hookSpecificOutput.permissionDecision, "deny");
  assert.match(
    write.body.hookSpecificOutput.permissionDecisionReason,
    /file\.write\.forbidden/,
  );

  services.policy.setForWorkspace(run.workspaceId, {
    autonomy: "scoped",
    deniedCommands: [],
  });
  const pending = bridge.handleHook(
    hook("PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: "rm -rf dist" },
      tool_use_id: "t5",
    }),
  );
  await new Promise((r) => setTimeout(r, 5));
  const [approval] = services.approvals.pending();
  services.approvals.decide(approval.id, { decision: "deny", actor: "bob" });
  const result = await pending;
  assert.equal(result.body.hookSpecificOutput.permissionDecision, "deny");
  assert.match(
    result.body.hookSpecificOutput.permissionDecisionReason,
    /denied in Agent Space by bob/,
  );
});

test("PreToolUse ask with no decision → expiry → deny", async () => {
  const { services, bridge } = setup({ policy: { deniedCommands: [] } });
  services.approvals = new ApprovalService(services, { sweepMs: 1_000_000 });
  services.settings.set("hooks.claudeCode.timeoutSeconds", 10);
  // 10 s − 5 s = 5 s is the wait budget; shrink it for the test by expiring early.
  const original = services.approvals.wait.bind(services.approvals);
  services.approvals.wait = (id) => original(id, 20);
  const result = await bridge.handleHook(
    hook("PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: "git push" },
      tool_use_id: "t6",
    }),
  );
  assert.equal(result.body.hookSpecificOutput.permissionDecision, "deny");
  assert.match(
    result.body.hookSpecificOutput.permissionDecisionReason,
    /expired/,
  );
  assert.equal(services.approvals.pending().length, 0);
  assert.equal(services.approvals.list()[0].status, "expired");
});

test("passThroughAllow returns an empty decision so Claude Code keeps its own prompts", async () => {
  const { services, bridge } = setup();
  services.settings.set("hooks.claudeCode.passThroughAllow", true);
  const result = await bridge.handleHook(
    hook("PreToolUse", {
      tool_name: "Grep",
      tool_input: { pattern: "x" },
      tool_use_id: "t7",
    }),
  );
  assert.deepEqual(result.body, {});
  assert.ok(
    services.recorder
      .events(runFor(services).id)
      .some((e) => e.kind === "search"),
  );
});

test("lifecycle events: SessionStart, UserPromptSubmit titles the task, PostToolUse, Stop, SubagentStop, Notification, PreCompact, SessionEnd", async () => {
  const { services, workspace, bridge } = setup();
  assert.deepEqual(
    (await bridge.handleHook(hook("SessionStart", { source: "startup" }))).body,
    {},
  );
  const run = runFor(services);
  assert.ok(run);
  assert.match(workspace.store.get(run.taskId).title, /Claude Code session/);
  await bridge.handleHook(
    hook("UserPromptSubmit", {
      prompt:
        "Fix the login bug in auth.js so that expired tokens are rejected cleanly and tests pass again",
    }),
  );
  const task = workspace.store.get(run.taskId);
  assert.ok(task.title.startsWith("Fix the login bug in auth.js"));
  assert.ok(task.title.length <= 80);
  assert.equal(services.recorder.get(run.id).title, task.title);
  await bridge.handleHook(
    hook("UserPromptSubmit", { prompt: "second prompt" }),
  );
  assert.equal(
    workspace.store.get(run.taskId).title,
    task.title,
    "only the first prompt titles the task",
  );
  await bridge.handleHook(
    hook("PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: "node --test" },
      tool_use_id: "t8",
    }),
  );
  await bridge.handleHook(
    hook("PostToolUse", {
      tool_name: "Bash",
      tool_input: { command: "node --test" },
      tool_use_id: "t8",
      tool_response: { stdout: "ok", is_error: false },
    }),
  );
  await bridge.handleHook(
    hook("PostToolUse", {
      tool_name: "Edit",
      tool_input: { file_path: inside("a.js") },
      tool_use_id: "t9",
      tool_response: { is_error: true, error: "no such file" },
    }),
  );
  await bridge.handleHook(hook("Stop", { stop_hook_active: false }));
  await bridge.handleHook(hook("SubagentStop", { agent_type: "explore" }));
  await bridge.handleHook(
    hook("Notification", {
      message: "Claude needs your permission to use Bash",
      notification_type: "permission_prompt",
    }),
  );
  await bridge.handleHook(hook("PreCompact", { trigger: "auto" }));
  const events = services.recorder.events(run.id);
  const kinds = events.map((e) => e.kind);
  for (const k of [
    "session.start",
    "prompt",
    "test",
    "tool.end",
    "error",
    "turn.end",
    "delegation",
    "status",
  ])
    assert.ok(kinds.includes(k), `missing ${k} in ${kinds.join(",")}`);
  assert.equal(events.filter((e) => e.kind === "prompt").length, 2);
  assert.equal(
    events.find((e) => e.kind === "tool.end").providerEventId,
    "hook:sess-1:t8:post",
  );
  assert.equal(events.find((e) => e.kind === "error").data.isError, true);
  assert.ok(
    events.every((e) => e.provenance !== "inferred" || e.kind === "status"),
  );
  assert.ok(
    events
      .filter((e) => e.kind !== "session.start" && e.kind !== "status")
      .every((e) => e.provenance === "provider"),
  );

  assert.deepEqual(
    (await bridge.handleHook(hook("SessionEnd", { reason: "exit" }))).body,
    {},
  );
  const ended = services.recorder.get(run.id);
  assert.equal(ended.status, "completed");
  assert.ok(ended.endedAt);
  assert.equal(workspace.store.get(run.taskId).status, "COMPLETED");
  // A resumed session with the same id reopens the run instead of failing.
  const again = await bridge.handleHook(
    hook("SessionStart", { source: "resume" }),
  );
  assert.deepEqual(again.body, {});
  assert.equal(services.recorder.get(run.id).status, "running");
});

test("workspace resolution: auto-create from cwd, disabled → Observed sessions; concurrent sessions get a second agent", async () => {
  const { services, bridge } = setup({ workspace: false });
  const otherCwd =
    process.platform === "win32" ? "C:\\proj\\other-repo" : "/proj/other-repo";
  await bridge.handleHook(
    hook("SessionStart", { session_id: "s-a", cwd: otherCwd }),
  );
  const runA = runFor(services, "s-a");
  const ws = services.hub.list().find((w) => w.id === runA.workspaceId);
  assert.equal(ws.name, "other-repo");
  assert.equal(ws.rootPath, otherCwd);
  assert.equal(
    services.db
      .prepare("SELECT auto_created FROM workspaces WHERE id = ?")
      .get(ws.id).auto_created,
    1,
  );
  // Same cwd, second live session → same workspace, "Claude Code 2".
  await bridge.handleHook(
    hook("SessionStart", { session_id: "s-b", cwd: otherCwd.toUpperCase() }),
  );
  const runB = runFor(services, "s-b");
  assert.equal(runB.workspaceId, ws.id);
  assert.notEqual(runB.agentId, runA.agentId);
  assert.equal(
    services.hub.get(ws.id).profiles.get(runB.agentId).name,
    "Claude Code 2",
  );
  // Subfolder cwd maps into the same workspace.
  await bridge.handleHook(
    hook("SessionStart", {
      session_id: "s-c",
      cwd: `${otherCwd}${sep}packages${sep}core`,
    }),
  );
  assert.equal(runFor(services, "s-c").workspaceId, ws.id);
  // Auto-create disabled → the "observed" bucket workspace.
  services.settings.set("observation.autoCreateWorkspaces", false);
  await bridge.handleHook(
    hook("SessionStart", {
      session_id: "s-d",
      cwd: process.platform === "win32" ? "D:\\somewhere" : "/somewhere",
    }),
  );
  assert.equal(runFor(services, "s-d").workspaceId, "observed");
  assert.ok(services.hub.has("observed"));
});

test("unknown events, malformed payloads, and internal errors never block Claude Code", async () => {
  const { services, bridge } = setup();
  assert.deepEqual(await bridge.handleHook(hook("SomethingNew")), {
    status: 200,
    body: {},
  });
  assert.deepEqual(await bridge.handleHook(null), { status: 200, body: {} });
  assert.deepEqual(await bridge.handleHook({ hook_event_name: "PreToolUse" }), {
    status: 200,
    body: {},
  });
  services.recorder.ensureRun = () => {
    throw new Error("db exploded");
  };
  const result = await bridge.handleHook(
    hook("PreToolUse", { tool_name: "Read", tool_input: {} }),
  );
  assert.deepEqual(result, { status: 200, body: {} });
  const errors = services.audit.list({ action: "hook.error" });
  assert.equal(errors.length, 1);
  assert.match(errors[0].details.error, /db exploded/);
  assert.equal(services.audit.list({ action: "hook.invalid" }).length, 2);
});

test("installer: merges with the existing rtk hook, backs up once, status, uninstall keeps others", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-space-hooks-"));
  try {
    const settingsPath = join(dir, "settings.json");
    const original = {
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "rtk hook claude" }],
          },
        ],
      },
    };
    writeFileSync(
      settingsPath,
      "\uFEFF" + JSON.stringify(original, null, 2).replace(/\n/g, "\r\n"),
    );
    assert.equal(status(settingsPath).installed, false);
    const command = defaultCommand({ port: 5199 });
    assert.match(
      command,
      /^node ".*bin[\\/]agent-space\.js" hook claude-code --url http:\/\/127\.0\.0\.1:5199$/,
    );
    // The installed command carries the server's approval wait as --timeout
    // so the CLI never gives up (and hands the call back to Claude) first.
    assert.match(
      defaultCommand({ port: 5199, timeoutSeconds: 120 }),
      /--url http:\/\/127\.0\.0\.1:5199 --timeout 120$/,
    );
    assert.equal(isTrustedCommand(command), true);
    assert.equal(isTrustedCommand(command + " --timeout 300"), true);
    assert.equal(isTrustedCommand(command + " && calc.exe"), false);
    assert.equal(isTrustedCommand("powershell -c evil # agent-space"), false);
    const result = install({ settingsPath, command, timeoutSeconds: 120 });
    assert.equal(result.installed, true);
    assert.equal(result.complete, true);
    assert.deepEqual(result.added, HOOK_EVENTS);
    assert.ok(existsSync(settingsPath + ".agent-space.bak"));
    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(written.permissions, original.permissions);
    assert.equal(written.hooks.PreToolUse.length, 2);
    assert.deepEqual(written.hooks.PreToolUse[0], original.hooks.PreToolUse[0]);
    assert.deepEqual(written.hooks.PreToolUse[1], {
      hooks: [{ type: "command", command, timeout: 120 }],
    });
    for (const event of HOOK_EVENTS)
      assert.ok(Array.isArray(written.hooks[event]), event);
    assert.equal(
      written.hooks.PreToolUse[1].matcher,
      undefined,
      "no matcher = all tools",
    );
    // Idempotent + updates command/timeout in place.
    const again = install({
      settingsPath,
      command: command + " --json",
      timeoutSeconds: 300,
    });
    assert.deepEqual(again.added, []);
    assert.equal(again.updated.length, HOOK_EVENTS.length);
    assert.equal(
      JSON.parse(readFileSync(settingsPath, "utf8")).hooks.PreToolUse.length,
      2,
    );
    assert.equal(
      JSON.parse(
        readFileSync(settingsPath + ".agent-space.bak", "utf8").replace(
          /^\uFEFF/,
          "",
        ),
      ).hooks.PreToolUse.length,
      1,
      "backup is written once",
    );
    const st = status(settingsPath);
    assert.equal(st.installed, true);
    assert.deepEqual(st.events, HOOK_EVENTS);
    assert.equal(st.command, command + " --json");
    const removed = uninstall(settingsPath);
    assert.equal(removed.installed, false);
    assert.equal(removed.removed.length, HOOK_EVENTS.length);
    const after = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(
      after.hooks,
      original.hooks,
      "only ours removed, rtk hook kept, empty arrays pruned",
    );
    assert.deepEqual(after.permissions, original.permissions);
    // Missing file: install creates it; invalid JSON: refuses.
    const fresh = join(dir, "nested", "settings.json");
    install({ settingsPath: fresh, command });
    assert.equal(status(fresh).installed, true);
    writeFileSync(settingsPath, "{ not json");
    assert.throws(
      () => install({ settingsPath, command }),
      (e) => e.status === 409,
    );
    assert.equal(status(settingsPath).installed, false);
    assert.throws(
      () => install({ settingsPath: fresh, command: "rtk hook claude" }),
      (e) => e.status === 400,
    );
    assert.throws(
      () => install({ settingsPath: fresh, command, timeoutSeconds: 1 }),
      (e) => e.status === 400,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("routes: hook POST, status/install/uninstall, settings, audit, policy through ctx", async () => {
  const { services, workspace } = setup();
  const dir = mkdtempSync(join(tmpdir(), "agent-space-routes-"));
  const settingsPath = join(dir, "settings.json");
  // The routes only touch Claude's own config directory.
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const call = async (route, method, path, input, search = "", bodyError) => {
      let out;
      const ctx = {
        method,
        path,
        query: new URLSearchParams(search),
        send: (status, data) => (out = { status, data }),
        body: async () => {
          if (bodyError) throw bodyError;
          return input;
        },
        services,
        hub: services.hub,
        db: services.db,
        bus: services.bus,
        actor: "local-user",
      };
      const handled = await route(ctx);
      return { handled, ...out };
    };
    const decided = await call(
      hookRoutes,
      "POST",
      "/api/hooks/claude-code",
      hook("PreToolUse", {
        tool_name: "Read",
        tool_input: { file_path: inside("x.js") },
        tool_use_id: "r1",
      }),
    );
    assert.equal(decided.status, 200);
    assert.equal(decided.data.hookSpecificOutput.permissionDecision, "allow");
    const bad = await call(
      hookRoutes,
      "POST",
      "/api/hooks/claude-code",
      null,
      "",
      Object.assign(new Error("too big"), { status: 413 }),
    );
    assert.deepEqual(bad.data, {});
    assert.equal(services.audit.list({ action: "hook.badRequest" }).length, 1);

    const st = await call(
      hookRoutes,
      "GET",
      "/api/hooks/claude-code/status",
      null,
      `settingsPath=${encodeURIComponent(settingsPath)}`,
    );
    assert.equal(st.data.installed, false);
    assert.equal(st.data.bridgeAttached, true);
    assert.match(st.data.suggestedCommand, /agent-space\.js/);
    const installed = await call(
      hookRoutes,
      "POST",
      "/api/hooks/claude-code/install",
      { settingsPath, timeoutSeconds: 90 },
    );
    assert.equal(installed.data.installed, true);
    assert.match(installed.data.command, /--timeout 90$/);
    await assert.rejects(
      call(hookRoutes, "POST", "/api/hooks/claude-code/install", {
        command: 'powershell -c "evil" # agent-space',
      }),
      (e) => e.status === 403,
    );
    await assert.rejects(
      call(hookRoutes, "POST", "/api/hooks/claude-code/install", {
        settingsPath: join(tmpdir(), "elsewhere.json"),
      }),
      (e) => e.status === 403,
    );
    await assert.rejects(
      call(hookRoutes, "POST", "/api/hooks/claude-code/uninstall", {
        settingsPath: join(tmpdir(), "elsewhere.json"),
      }),
      (e) => e.status === 403,
    );
    assert.equal(services.settings.get("hooks.claudeCode.installed"), true);
    assert.equal(services.settings.get("hooks.claudeCode.timeoutSeconds"), 90);
    assert.equal(services.audit.list({ action: "hooks.install" }).length, 1);
    const removed = await call(
      hookRoutes,
      "POST",
      "/api/hooks/claude-code/uninstall",
      { settingsPath },
    );
    assert.equal(removed.data.installed, false);
    assert.equal(services.settings.get("hooks.claudeCode.installed"), false);
    assert.equal((await call(hookRoutes, "GET", "/api/other")).handled, false);

    // A webhook's shared secret may be NAMED by a settings key, an extension
    // record lives under extensions.item.*, and incident state under ops.*.
    // None of them belong in an HTTP response: GET /api/settings serves the
    // public subset, never settings.all().
    services.settings.set("webhook.github.hmac", "top-secret-hmac");
    services.settings.set("extensions.item.x", {
      permissions: { shell: true },
    });
    services.settings.set("ops.quarantinedHosts", ["runner-1"]);

    const all = await call(settingsRoutes, "GET", "/api/settings");
    assert.equal(all.data["ui.graphics"], "auto");
    assert.equal(all.data["webhook.github.hmac"], undefined);
    assert.equal(all.data["extensions.item.x"], undefined);
    assert.equal(all.data["ops.quarantinedHosts"], undefined);
    assert.ok(!JSON.stringify(all.data).includes("top-secret-hmac"));
    // UI-owned keys under a public prefix still reach the browser.
    services.settings.set("ui.office.lighting", "night");
    services.settings.set("mcp.allowDecisions", true);
    const again = await call(settingsRoutes, "GET", "/api/settings");
    assert.equal(again.data["ui.office.lighting"], "night");
    assert.equal(again.data["mcp.allowDecisions"], true);
    const put = await call(settingsRoutes, "PUT", "/api/settings", {
      "ui.graphics": "low",
      "ui.presentationMode": true,
    });
    assert.equal(put.data["ui.graphics"], "low");
    assert.equal(
      put.data["webhook.github.hmac"],
      undefined,
      "PUT echoes the public subset too",
    );
    await assert.rejects(
      call(settingsRoutes, "PUT", "/api/settings", { "ui.graphics": "nope" }),
      (e) => e.status === 400,
    );

    const audit = await call(
      auditRoutes,
      "GET",
      "/api/audit",
      null,
      "limit=5&action=settings.update",
    );
    assert.equal(audit.data.length, 1);
    assert.deepEqual(audit.data[0].details.keys, [
      "ui.graphics",
      "ui.presentationMode",
    ]);

    const presets = await call(policyRoutes, "GET", "/api/policy/presets");
    assert.equal(presets.data.length, 4);
    const got = await call(
      policyRoutes,
      "GET",
      `/api/workspaces/${workspace.id}/policy`,
    );
    assert.equal(got.data.autonomy, "scoped");
    const set = await call(
      policyRoutes,
      "PUT",
      `/api/workspaces/${workspace.id}/policy`,
      { autonomy: "sandbox" },
    );
    assert.equal(set.data.autonomy, "sandbox");
    const preview = await call(
      policyRoutes,
      "POST",
      `/api/workspaces/${workspace.id}/policy/preview`,
      { request: { kind: "network", url: "https://x" } },
    );
    assert.equal(preview.data.decision, "deny");
    assert.ok(preview.data.explanation.length >= 3);
    const launch = await call(
      policyRoutes,
      "POST",
      `/api/workspaces/${workspace.id}/policy/launch`,
      { isolation: "none" },
    );
    assert.equal(launch.data.effective.isolation, "worktree");
    assert.equal(
      (await call(policyRoutes, "GET", `/api/workspaces/${workspace.id}/tasks`))
        .handled,
      false,
    );
    await assert.rejects(
      call(
        policyRoutes,
        "POST",
        `/api/workspaces/${workspace.id}/policy/preview`,
        {},
      ),
      (e) => e.status === 400,
    );
  } finally {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("observe-only workspaces are watched, never decided for: PreToolUse yields no decision", async () => {
  const { services, bridge } = setup({ policy: { autonomy: "observe-only" } });
  for (const [tool_name, tool_input] of [
    ["Read", { file_path: inside("src\\index.js") }],
    ["Bash", { command: "git push --force" }],
    ["Edit", { file_path: inside("a.js"), old_string: "a", new_string: "b" }],
  ]) {
    const result = await bridge.handleHook(
      hook("PreToolUse", {
        tool_name,
        tool_input,
        tool_use_id: `ob-${tool_name}`,
      }),
    );
    assert.deepEqual(
      result.body,
      {},
      `${tool_name}: Claude keeps its own prompt`,
    );
  }
  const run = runFor(services);
  const bash = services.recorder.events(run.id).find((e) => e.tool === "Bash");
  assert.equal(bash.data.policy.decision, "passthrough");
  assert.equal(bash.data.policy.rule, "observe-only.passthrough");
  assert.equal(services.audit.list({ action: "hook.deny" }).length, 0);
  assert.equal(services.approvals.pending().length, 0);
});

test("approvals carry the whole command (hash included), not a flattened 2000-char preview", async () => {
  const { services, bridge } = setup({ policy: { deniedCommands: [] } });
  const command =
    "echo " + "x".repeat(2500) + "\n# second line\ngit push --force";
  const pending = bridge.handleHook(
    hook("PreToolUse", {
      tool_name: "Bash",
      tool_input: { command },
      tool_use_id: "big1",
    }),
  );
  await new Promise((r) => setTimeout(r, 5));
  const [approval] = services.approvals.pending();
  assert.equal(approval.kind, "command");
  assert.equal(
    approval.payload.command,
    command,
    "exact text, line breaks kept",
  );
  assert.equal(approval.payload.commandLength, command.length);
  assert.equal(
    approval.payload.commandSha256,
    createHash("sha256").update(command).digest("hex"),
  );
  assert.equal(approval.payload.truncated, undefined);
  assert.equal(approval.payload.tool_input.command, command);
  assert.match(approval.payload.commandPreview, /…$/);
  services.approvals.decide(approval.id, { decision: "approve", actor: "ann" });
  const result = await pending;
  assert.equal(result.body.hookSpecificOutput.permissionDecision, "allow");
  // The event log keeps only the preview.
  const run = runFor(services);
  const event = services.recorder.events(run.id).find((e) => e.tool === "Bash");
  assert.match(event.data.tool_input.command, /…\[truncated\]$/);
});

test("secret files and env dumps never leak content into events", async () => {
  const { services, bridge } = setup();
  await bridge.handleHook(
    hook("PreToolUse", {
      tool_name: "Write",
      tool_input: { file_path: inside(".env"), content: "DB_PASSWORD=hunter2" },
      tool_use_id: "w1",
    }),
  );
  await bridge.handleHook(
    hook("PostToolUse", {
      tool_name: "Read",
      tool_input: { file_path: inside(".env") },
      tool_response: "DB_PASSWORD=hunter2",
      tool_use_id: "w2",
    }),
  );
  await bridge.handleHook(
    hook("PostToolUse", {
      tool_name: "Bash",
      tool_input: { command: "cat .env" },
      tool_response: { stdout: "DB_PASSWORD=hunter2" },
      tool_use_id: "w3",
    }),
  );
  await bridge.handleHook(
    hook("PreToolUse", {
      tool_name: "Edit",
      tool_input: {
        file_path: inside("config.php"),
        old_string: "x",
        new_string: "y",
        password: "sk-live-123",
      },
      tool_use_id: "w4",
    }),
  );
  const run = runFor(services);
  const events = services.recorder.events(run.id);
  const dump = JSON.stringify(events);
  assert.doesNotMatch(dump, /hunter2/);
  assert.doesNotMatch(dump, /sk-live-123/);
  assert.equal(
    events.find((e) => e.data.toolUseId === "w1").data.tool_input.content,
    "[omitted: secret path]",
  );
  assert.equal(
    events.find((e) => e.data.toolUseId === "w2").data.responsePreview,
    "[omitted: secret path]",
  );
  assert.equal(
    events.find((e) => e.data.toolUseId === "w3").data.responsePreview,
    "[omitted: secret path]",
  );
  assert.equal(
    events.find((e) => e.data.toolUseId === "w4").data.tool_input.password,
    "[redacted]",
  );
});
