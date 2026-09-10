import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServices } from "../packages/core/src/services.js";
import {
  Connectors,
  createConnectors,
  CONNECTOR_IDS,
  AVAILABILITY,
  workspaceRoots,
} from "../packages/core/src/connectors/Connectors.js";
import connectorRoutes from "../packages/server/src/routes/connectors.js";
import { safeArgument } from "../packages/core/src/connectors/git.js";
import {
  assertShellSafe,
  runCommand,
} from "../packages/core/src/providers/detect.js";

/** `which` stub: resolves only the names given, like PATH would. */
function fakeWhich(found = {}) {
  return async (name) => found[name] ?? null;
}

function call(services, method, path) {
  return new Promise((resolve, reject) => {
    const url = new URL(`http://localhost${path}`);
    const ctx = {
      method,
      path: url.pathname,
      url,
      query: url.searchParams,
      services,
      hub: services.hub,
      db: services.db,
      bus: services.bus,
      actor: "test",
      body: async () => undefined,
      send: (status, data) => resolve({ status, data }),
    };
    connectorRoutes(ctx)
      .then((handled) => {
        if (!handled) resolve({ status: 0, handled: false });
      })
      .catch(reject);
  });
}

test("connectors report git, filesystem and github with honest availability", async () => {
  const services = createServices({ demo: false, optional: false });
  const dir = mkdtempSync(join(tmpdir(), "connector-root-"));
  try {
    services.hub.create({ name: "Rooted", rootPath: dir });
    services.hub.create({ name: "Missing", rootPath: join(dir, "gone") });
    const connectors = new Connectors(services, {
      env: {},
      which: fakeWhich({}),
    });
    const list = await connectors.list();
    assert.deepEqual(
      list.map((c) => c.id),
      CONNECTOR_IDS,
    );
    for (const connector of list) {
      assert.ok(AVAILABILITY.includes(connector.availability));
      assert.ok(connector.detail.length > 0);
      // An unavailable connector must say how to fix it, and never claim writes.
      if (connector.availability !== "available") assert.ok(connector.fix);
      assert.deepEqual(connector.writes, []);
    }
    const filesystem = list.find((c) => c.id === "filesystem");
    assert.equal(filesystem.availability, "available");
    assert.deepEqual(filesystem.scope.length, 1);
    assert.equal(filesystem.missingRoots.length, 1);

    // No git and no gh on this fake PATH: both must say so, not go quiet.
    assert.equal(list.find((c) => c.id === "git").availability, "unavailable");
    const github = list.find((c) => c.id === "github");
    assert.equal(github.availability, "unavailable");
    assert.match(github.detail, /not on PATH/);
    assert.equal(github.version, null);
  } finally {
    await services.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a GitHub token variable is credited by presence and never read", async () => {
  const services = createServices({ demo: false, optional: false });
  try {
    const connectors = new Connectors(services, {
      env: { GITHUB_TOKEN: "ghp_secret_value" },
      which: fakeWhich({}),
    });
    const github = await connectors.get("github");
    // No gh binary, so it is still unavailable, but the token is acknowledged
    // without its value ever appearing in the payload.
    assert.equal(github.availability, "unavailable");
    assert.ok(!JSON.stringify(github).includes("ghp_secret_value"));
  } finally {
    await services.close();
  }
});

test("workspaceRoots survives a hub that cannot be listed", () => {
  assert.deepEqual(workspaceRoots({}), []);
  assert.deepEqual(
    workspaceRoots({
      hub: {
        list() {
          throw new Error("db closed");
        },
      },
    }),
    [],
  );
});

test("the route lists connectors, serves one, and 404s an unknown id", async () => {
  const services = createServices({ demo: false, optional: false });
  try {
    createConnectors(services, { env: {}, which: fakeWhich({}) });
    const all = await call(services, "GET", "/api/connectors");
    assert.equal(all.status, 200);
    assert.equal(all.data.count, 3);
    assert.deepEqual(
      all.data.connectors.map((c) => c.id),
      CONNECTOR_IDS,
    );

    const one = await call(services, "GET", "/api/connectors/git");
    assert.equal(one.status, 200);
    assert.equal(one.data.id, "git");

    await assert.rejects(
      () => call(services, "GET", "/api/connectors/slack"),
      /Unknown connector: slack/,
    );
  } finally {
    await services.close();
  }
});

test("a build without the module answers 503 instead of an empty list", async () => {
  const services = createServices({ demo: false, optional: false });
  try {
    services.connectors = undefined;
    await assert.rejects(
      () => call(services, "GET", "/api/connectors"),
      /not available in this container/,
    );
  } finally {
    await services.close();
  }
});

/* ------------------------------------------------------------------ *
 * Connector foundation: filesystem, Git, GitHub (packages/core/src/connectors)
 *
 * These exercise the read/write side of the connector interface against a
 * real temporary Git repository and a STUB `gh` binary. The real GitHub API
 * is never called: github.js only ever runs the command in
 * AGENT_SPACE_BIN_GH, which the tests point at a local script.
 * ------------------------------------------------------------------ */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { ConnectorRegistry } from "../packages/core/src/connectors/index.js";
import { createFilesystemConnector } from "../packages/core/src/connectors/filesystem.js";
import { createGitConnector } from "../packages/core/src/connectors/git.js";
import { createGithubConnector } from "../packages/core/src/connectors/github.js";

/** A temporary Git repository with one commit. Returns its path. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "connector-git-"));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: dir,
      stdio: "pipe",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    });
  git("init", "-b", "main");
  git("config", "user.email", "tester@example.invalid");
  git("config", "user.name", "Connector Test");
  writeFileSync(join(dir, "README.md"), "hello\nworld\n");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "index.js"), "export const one = 1;\n");
  writeFileSync(join(dir, ".env"), "SECRET=do-not-read\n");
  git("add", "README.md", "src/index.js");
  git("commit", "-m", "first commit");
  return dir;
}

/** Writes a stub `gh` and returns the AGENT_SPACE_BIN_GH value for it. */
function stubGh(dir, { authenticated = true } = {}) {
  const file = join(dir, "gh-stub.mjs");
  writeFileSync(
    file,
    [
      "const args = process.argv.slice(2);",
      "const out = (value) => process.stdout.write(JSON.stringify(value));",
      'if (args[0] === "--version") { process.stdout.write("gh version 2.60.0 (2026-01-01)\\n"); process.exit(0); }',
      'if (args[0] === "auth" && args[1] === "status") {',
      `  if (${authenticated}) { process.stdout.write("Logged in to github.com account tester\\n"); process.exit(0); }`,
      '  process.stderr.write("You are not logged into any GitHub hosts.\\n"); process.exit(1);',
      "}",
      'if (args[0] === "issue" && args[1] === "list") { out([{ number: 7, title: "Flaky test", state: "OPEN" }]); process.exit(0); }',
      'if (args[0] === "pr" && args[1] === "list") { out([{ number: 12, title: "Add connectors", isDraft: true }]); process.exit(0); }',
      'if (args[0] === "pr" && args[1] === "checks") { out([{ name: "build", state: "SUCCESS", link: "https://example.invalid/1" }]); process.exit(0); }',
      'if (args[0] === "api") { out({ total_count: 1, check_runs: [{ name: "unit", status: "completed", conclusion: "success" }] }); process.exit(0); }',
      'if (args[0] === "pr" && args[1] === "create") {',
      '  if (!args.includes("--draft")) { process.stderr.write("stub expected --draft\\n"); process.exit(3); }',
      '  process.stdout.write("https://github.com/example/repo/pull/13\\n"); process.exit(0);',
      "}",
      'process.stderr.write("stub: unsupported " + args.join(" ") + "\\n");',
      "process.exit(9);",
      "",
    ].join("\n"),
  );
  return `"${process.execPath}" "${file}"`;
}

function connectorServices(rootPath) {
  const services = createServices({ demo: false, optional: false });
  const workspace = services.hub.create({ name: "Repo", rootPath });
  return { services, workspaceId: workspace.id };
}

test("filesystem connector lists, reads and diffs inside the workspace root only", async () => {
  const dir = makeRepo();
  const { services, workspaceId } = connectorServices(dir);
  try {
    const fs = createFilesystemConnector(services);
    assert.equal((await fs.detect()).available, true);
    const capabilities = await fs.capabilities();
    assert.deepEqual(capabilities.writes, []);

    const listing = await fs.read("list", { workspaceId, path: "." });
    const names = listing.entries.map((entry) => entry.name);
    assert.ok(names.includes("README.md"));
    assert.ok(names.includes("src"));
    // .env is a secret path: it is skipped, and the skip is reported.
    assert.ok(!names.includes(".env"));
    assert.equal(listing.skippedSecrets, 1);

    const file = await fs.read("read", { workspaceId, path: "README.md" });
    assert.equal(file.content, "hello\nworld\n");
    assert.equal(file.truncated, false);
    const capped = await fs.read("read", {
      workspaceId,
      path: "README.md",
      maxBytes: 4,
    });
    assert.equal(capped.content, "hell");
    assert.equal(capped.truncated, true);

    const diff = await fs.read("diff", {
      workspaceId,
      path: "README.md",
      content: "hello\nthere\n",
    });
    assert.equal(diff.changed, true);
    assert.equal(diff.linesRemoved, 1);
    assert.equal(diff.linesAdded, 1);
    assert.match(diff.diff, /-world/);
    assert.match(diff.diff, /\+there/);

    // Escaping the root and reading a credential file are both refused.
    await assert.rejects(
      () => fs.read("read", { workspaceId, path: "../outside.txt" }),
      /outside the workspace folder root/,
    );
    await assert.rejects(
      () => fs.read("read", { workspaceId, path: ".env" }),
      /credential file/,
    );
    await assert.rejects(
      () => fs.write("create", { workspaceId }),
      /read-only/,
    );
  } finally {
    await services.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git connector reports status, branch, log, diff, worktrees and remotes read-only", async () => {
  const dir = makeRepo();
  const { services, workspaceId } = connectorServices(dir);
  try {
    const git = createGitConnector(services);
    const detected = await git.detect();
    if (!detected.available) {
      // Honest degradation is the contract when git is missing.
      assert.match(detected.reason, /git/i);
      return;
    }
    const status = await git.read("status", { workspaceId });
    assert.equal(status.branch, "main");
    // .env is untracked, so the tree is not clean — and we say so truthfully.
    assert.ok(status.files.some((file) => file.path === ".env"));

    const branch = await git.read("branch", { workspaceId });
    assert.equal(branch.current, "main");
    assert.ok(branch.branches.some((entry) => entry.name === "main"));

    const log = await git.read("log", { workspaceId, limit: 5 });
    assert.equal(log.commits.length, 1);
    assert.equal(log.commits[0].subject, "first commit");
    assert.equal(log.commits[0].author, "Connector Test");

    writeFileSync(join(dir, "README.md"), "hello\nagain\n");
    const diff = await git.read("diff", { workspaceId });
    assert.match(diff.diff, /\+again/);

    const blame = await git.read("blame", {
      workspaceId,
      file: "src/index.js",
    });
    assert.equal(blame.lines[0].author, "Connector Test");

    const worktrees = await git.read("worktrees", { workspaceId });
    assert.equal(worktrees.worktrees.length, 1);
    const remotes = await git.read("remotes", { workspaceId });
    assert.deepEqual(remotes.remotes, []);

    await assert.rejects(
      () => git.read("push", { workspaceId }),
      /Unknown git read op/,
    );
    await assert.rejects(
      () => git.write("commit", { workspaceId }),
      /read-only/,
    );
    // An argument that git would read as an option is refused before spawning.
    await assert.rejects(
      () => git.read("log", { workspaceId, ref: "--exec=calc.exe" }),
      /may not start with/,
    );
  } finally {
    await services.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git connector degrades honestly when the binary is missing", async () => {
  const dir = makeRepo();
  const { services, workspaceId } = connectorServices(dir);
  try {
    const git = createGitConnector(services, {
      which: async () => null,
      env: {},
    });
    const detected = await git.detect();
    assert.equal(detected.available, false);
    assert.match(detected.reason, /not on PATH/);
    const capabilities = await git.capabilities();
    assert.equal(capabilities.status, "unavailable");
    await assert.rejects(
      () => git.read("status", { workspaceId }),
      /Git is not usable on this machine/,
    );
  } finally {
    await services.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("github connector reads through a stubbed gh CLI and refuses writes without an approval", async () => {
  const dir = makeRepo();
  const { services, workspaceId } = connectorServices(dir);
  try {
    const github = createGithubConnector(services, {
      env: { ...process.env, AGENT_SPACE_BIN_GH: stubGh(dir) },
    });
    const detected = await github.detect();
    assert.equal(detected.available, true);
    assert.equal(detected.authenticated, true);
    assert.equal(detected.version, "2.60.0");

    const issues = await github.read("issues", { workspaceId, limit: 5 });
    assert.equal(issues.count, 1);
    assert.equal(issues.issues[0].number, 7);
    const prs = await github.read("prs", { workspaceId });
    assert.equal(prs.pullRequests[0].number, 12);
    const checks = await github.read("checks", { workspaceId });
    assert.equal(checks.checks[0].state, "SUCCESS");
    const runs = await github.read("checkRuns", { workspaceId, ref: "main" });
    assert.equal(runs.checkRuns[0].conclusion, "success");

    // The only write refuses outright without an APPROVED approval.
    await assert.rejects(
      () => github.write("createDraftPr", { workspaceId, title: "x" }),
      /needs an approved approval/,
    );
    await assert.rejects(
      () =>
        github.write(
          "createDraftPr",
          { workspaceId, title: "x" },
          { approval: { id: "a", status: "pending" } },
        ),
      /needs an approved approval/,
    );
  } finally {
    await services.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("github connector says why it cannot be used when gh is unauthenticated or missing", async () => {
  const dir = makeRepo();
  const { services, workspaceId } = connectorServices(dir);
  try {
    const loggedOut = createGithubConnector(services, {
      env: {
        ...process.env,
        AGENT_SPACE_BIN_GH: stubGh(dir, { authenticated: false }),
      },
    });
    const detected = await loggedOut.detect();
    assert.equal(detected.available, false);
    assert.equal(detected.authenticated, false);
    assert.match(detected.reason, /no account is logged in/);
    await assert.rejects(
      () => loggedOut.read("issues", { workspaceId }),
      /GitHub is not available: the GitHub CLI is installed but no account/,
    );

    const missing = createGithubConnector(services, {
      env: {},
      which: async () => null,
    });
    const gone = await missing.detect();
    assert.equal(gone.available, false);
    assert.match(gone.reason, /not on PATH/);
    const capabilities = await missing.capabilities();
    assert.deepEqual(capabilities.writes, ["createDraftPr"]);
    assert.equal(capabilities.status, "unavailable");
  } finally {
    await services.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Route call with a JSON body, for the registry endpoints. */
function callBody(services, method, path, input) {
  return new Promise((resolve, reject) => {
    const url = new URL(`http://localhost${path}`);
    const ctx = {
      method,
      path: url.pathname,
      url,
      query: url.searchParams,
      services,
      hub: services.hub,
      db: services.db,
      bus: services.bus,
      actor: "local-user",
      body: async () => input,
      send: (status, data) => resolve({ status, data }),
    };
    connectorRoutes(ctx)
      .then((handled) => {
        if (!handled) resolve({ status: 0, handled: false });
      })
      .catch(reject);
  });
}

/** A managed run to hang a connector-write approval on. */
function makeRun(services, workspaceId) {
  const workspace = services.hub.get(workspaceId);
  const agent = workspace.profiles.list()[0];
  return services.recorder.ensureRun({
    workspaceId,
    agentId: agent.id,
    mode: "managed",
    provider: "claude-code",
    cwd: workspace.record.rootPath,
    createTask: { title: "Open a draft pull request", source: "test" },
  });
}

test("a connector write needs both a permissive policy and an approved approval", async () => {
  const dir = makeRepo();
  const { services, workspaceId } = connectorServices(dir);
  try {
    const registry = new ConnectorRegistry(services, {
      env: { ...process.env, AGENT_SPACE_BIN_GH: stubGh(dir) },
    });
    const run = makeRun(services, workspaceId);

    // 1. The default policy denies `git push`, and a draft PR is a push.
    await assert.rejects(
      () =>
        registry.write(
          "github",
          "createDraftPr",
          { workspaceId, runId: run.id, title: "Add connectors" },
          { actor: "tester" },
        ),
      /Workspace policy denies .git push./,
    );

    // 2. With the deny lifted the call still refuses to act: it opens an
    //    approval and returns it, having sent nothing to GitHub.
    services.policy.setForWorkspace(workspaceId, { deniedCommands: [] });
    const pending = await registry.write(
      "github",
      "createDraftPr",
      { workspaceId, runId: run.id, title: "Add connectors", body: "why" },
      { actor: "tester" },
    );
    assert.equal(pending.status, "pending");
    assert.equal(pending.approval.status, "pending");
    assert.equal(pending.approval.payload.connector, "github");
    assert.equal(pending.approval.payload.command, "git push");

    // 3. A pending approval is not enough.
    await assert.rejects(
      () =>
        registry.write(
          "github",
          "createDraftPr",
          { workspaceId, runId: run.id, title: "Add connectors", body: "why" },
          { approvalId: pending.approval.id },
        ),
      /is pending, not approved/,
    );

    services.approvals.decide(pending.approval.id, {
      decision: "approve",
      actor: "local-user",
    });

    // 4. The approval binds to the exact request: changing the title refuses.
    await assert.rejects(
      () =>
        registry.write(
          "github",
          "createDraftPr",
          { workspaceId, runId: run.id, title: "Something else", body: "why" },
          { approvalId: pending.approval.id },
        ),
      /payload hash mismatch/,
    );

    const done = await registry.write(
      "github",
      "createDraftPr",
      { workspaceId, runId: run.id, title: "Add connectors", body: "why" },
      { approvalId: pending.approval.id, actor: "tester" },
    );
    assert.equal(done.status, "done");
    assert.equal(done.result.draft, true);
    assert.equal(done.result.url, "https://github.com/example/repo/pull/13");
    const audited = services.audit
      .list({ limit: 50 })
      .some((entry) => entry.action === "connector.write.github.createDraftPr");
    assert.equal(audited, true);

    // Read-only connectors have no write at all.
    await assert.rejects(
      () => registry.write("git", "commit", { workspaceId, runId: run.id }),
      /does not support the write/,
    );
  } finally {
    await services.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checks read through GitHub for the current branch and degrade honestly", async () => {
  const dir = makeRepo();
  const { services, workspaceId } = connectorServices(dir);
  try {
    const registry = new ConnectorRegistry(services, {
      env: { ...process.env, AGENT_SPACE_BIN_GH: stubGh(dir) },
    });
    const checks = await registry.checks(workspaceId);
    if (checks.available) {
      assert.equal(checks.provider, "github");
      assert.equal(checks.branch, "main");
      assert.equal(checks.checks[0].name, "build");
    } else {
      // Only acceptable when git itself is missing on this machine.
      assert.match(checks.reason, /branch could not be read/);
    }

    const withoutGh = new ConnectorRegistry(services, {
      env: {},
      which: async () => null,
    });
    const degraded = await withoutGh.checks(workspaceId);
    assert.equal(degraded.available, false);
    assert.match(degraded.reason, /not on PATH/);
    assert.deepEqual(degraded.checks, []);
  } finally {
    await services.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("routes expose capabilities, scoped reads, gated writes and workspace checks", async () => {
  const dir = makeRepo();
  const { services, workspaceId } = connectorServices(dir);
  try {
    services.connectorRegistry = new ConnectorRegistry(services, {
      env: { ...process.env, AGENT_SPACE_BIN_GH: stubGh(dir) },
    });

    const capabilities = await callBody(
      services,
      "GET",
      "/api/connectors/filesystem/capabilities",
    );
    assert.equal(capabilities.status, 200);
    assert.deepEqual(capabilities.data.writes, []);

    const read = await callBody(
      services,
      "POST",
      "/api/connectors/filesystem/read",
      {
        op: "list",
        params: { workspaceId, path: "." },
      },
    );
    assert.equal(read.status, 200);
    assert.ok(read.data.result.entries.some((entry) => entry.name === "src"));

    // A read outside the root is refused by the server, not hidden by the UI.
    await assert.rejects(
      () =>
        callBody(services, "POST", "/api/connectors/filesystem/read", {
          op: "read",
          params: { workspaceId, path: "..\\escape.txt" },
        }),
      /outside the workspace folder root/,
    );

    // Writes must be confirmed and are then policy-checked server-side.
    await assert.rejects(
      () =>
        callBody(services, "POST", "/api/connectors/github/write", {
          op: "createDraftPr",
          params: { workspaceId, title: "x" },
        }),
      /must be confirmed/,
    );
    await assert.rejects(
      () =>
        callBody(services, "POST", "/api/connectors/github/write", {
          op: "createDraftPr",
          params: { workspaceId, runId: "nope", title: "x" },
          confirm: true,
        }),
      /Workspace policy denies/,
    );

    services.policy.setForWorkspace(workspaceId, { deniedCommands: [] });
    const run = makeRun(services, workspaceId);
    const pending = await callBody(
      services,
      "POST",
      "/api/connectors/github/write",
      {
        op: "createDraftPr",
        params: { workspaceId, runId: run.id, title: "From the API" },
        confirm: true,
      },
    );
    assert.equal(pending.status, 202);
    assert.equal(pending.data.status, "pending");

    const checks = await callBody(
      services,
      "GET",
      `/api/workspaces/${workspaceId}/checks`,
    );
    assert.equal(checks.status, 200);
    assert.equal(typeof checks.data.available, "boolean");
    assert.equal(checks.data.provider, "github");

    const unknown = await callBody(
      services,
      "GET",
      "/api/connectors/jira/capabilities",
    ).catch((error) => error);
    assert.match(String(unknown.message ?? unknown), /Unknown connector/);
  } finally {
    await services.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("connector arguments can never become cmd.exe syntax", async () => {
  // safeArgument used to allow every shell metacharacter, and runCommand
  // quoted only arguments containing whitespace. On a host where git/gh
  // resolves to a .cmd shim (scoop, npm, chocolatey) that combination let a
  // ref such as "main&calc.exe" run a second command through cmd.exe.
  for (const bad of [
    "main&whoami",
    "main|whoami",
    "a>b",
    "%USERPROFILE%",
    'a"b',
    "a^b",
    "a;b",
    "a`b",
    "a$b",
  ])
    assert.throws(
      () => safeArgument(bad, "ref"),
      (error) => error.status === 400,
      `${bad} must be refused`,
    );
  assert.equal(safeArgument("feature/login-fix", "ref"), "feature/login-fix");
  assert.equal(safeArgument("src/app (copy).js", "file"), "src/app (copy).js");

  // Second line of defence: even an argument that reached runCommand with a
  // metacharacter is quoted rather than concatenated raw.
  assert.throws(() => assertShellSafe(['a"b']), /cmd\.exe interprets/);
  const result = await runCommand(
    process.execPath,
    ["-e", "console.log(process.argv[1])", "main&whoami"],
    { shell: true, timeoutMs: 15000 },
  );
  assert.equal(result.code, 0, result.error ?? result.stderr);
  assert.equal(result.stdout.trim(), "main&whoami");
});
