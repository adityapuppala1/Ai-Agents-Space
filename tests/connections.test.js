import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServices } from "../packages/core/src/services.js";
import { PROVIDER_IDS } from "../packages/core/src/contracts.js";
import {
  REGISTRY,
  binaryOverrideEnvName,
} from "../packages/core/src/providers/registry.js";
import {
  detectProviders,
  clearDetectionCache,
  categorizeDetection,
  remediationFor,
  authExpiryFor,
  ERROR_CATEGORIES,
  GEMINI_AUTH_FIX,
} from "../packages/core/src/providers/detect.js";
import {
  ConnectionService,
  CONNECTION_KINDS,
  sanitizeEnv,
} from "../packages/core/src/connections/ConnectionService.js";
import { plan, apply } from "../packages/core/src/connections/migration.js";
import {
  geminiAdapter,
  AUTONOMY_APPROVAL_MODE,
  parseErrorEnvelope,
} from "../packages/core/src/adapters/gemini.js";
import {
  cursorAdapter,
  CURSOR_LAUNCH_REFUSAL,
} from "../packages/core/src/adapters/cursor.js";
import connectionRoutes from "../packages/server/src/routes/connections.js";

const win = process.platform === "win32";

function tempDir(t, label = "connections") {
  const dir = mkdtempSync(join(tmpdir(), `agent-space-${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Stub CLI that prints `output`; never a real provider binary. */
function stubCli(binDir, name, output) {
  if (win)
    writeFileSync(
      join(binDir, `${name}.cmd`),
      `@echo off\r\necho ${output}\r\n`,
    );
  else {
    const file = join(binDir, name);
    writeFileSync(file, `#!/bin/sh\necho "${output}"\n`);
    chmodSync(file, 0o755);
  }
}

/** Environment whose provider homes are all fresh temp dirs. */
function isolatedEnv(t, { binDir, overrides = {} } = {}) {
  const homes = tempDir(t, "homes");
  const env = { ...process.env };
  delete env.PATH;
  delete env.Path;
  delete env.path;
  for (const name of [
    "GEMINI_API_KEY",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GOOGLE_GENAI_USE_GCA",
  ])
    delete env[name];
  env.PATH = binDir ?? tempDir(t, "empty-bin");
  if (win) env.Path = env.PATH;
  env.HOME = homes;
  env.USERPROFILE = homes;
  const homePaths = {};
  for (const id of PROVIDER_IDS) {
    const home = join(homes, id);
    mkdirSync(home, { recursive: true });
    env[REGISTRY[id].homeEnv] = home;
    homePaths[id] = home;
    delete env[binaryOverrideEnvName(id)];
  }
  return { env: Object.assign(env, overrides), homes: homePaths };
}

function fakeDetect(overrides = {}) {
  return async ({ providers }) =>
    providers.map((provider) => ({
      provider,
      found: false,
      binaryPath: null,
      version: null,
      homePath: `c:/homes/${provider}`,
      homeExists: false,
      authHint: "unknown",
      override: false,
      error: null,
      probedAt: 1000,
      ...(overrides[provider] ?? {}),
    }));
}

const readyClaude = {
  found: true,
  binaryPath: "c:/bin/claude.exe",
  version: "2.1.266",
  homeExists: true,
  authHint: "logged-in-likely",
};

function serviceWith(detect, options = {}) {
  const services = createServices({ demo: false, ...options });
  services.connections = new ConnectionService(services, { detect });
  return services;
}

// ------------------------------------------------------------- aliases

test("extra aliases can be created, listed, and removed without clobbering detection", async () => {
  const services = serviceWith(fakeDetect({ "claude-code": readyClaude }));
  const connections = services.connections;
  await connections.refresh();
  const created = connections.create({
    provider: "claude-code",
    alias: "work",
    host: "workstation-2",
    owner: "ada",
    allowedWorkspaces: ["ws-1", "ws-1", "ws-2"],
  });
  assert.equal(created.id, "claude-code-work");
  assert.equal(created.alias, "work");
  assert.equal(created.kind, "coding-runtime");
  assert.equal(created.host, "workstation-2");
  assert.equal(created.owner, "ada");
  assert.deepEqual(created.allowedWorkspaces, ["ws-1", "ws-2"]);
  assert.equal(
    created.status,
    "unknown",
    "a user-created alias claims nothing until it is probed",
  );
  assert.equal(created.errorCategory, null);
  assert.equal(created.authExpiresAt, null);

  // The same (provider, alias) twice is refused.
  assert.throws(
    () => connections.create({ provider: "claude-code", alias: "work" }),
    /already has a connection/,
  );

  // A refresh re-detects the default alias and leaves the user alias alone.
  await connections.refresh();
  const after = connections.get("claude-code-work");
  assert.equal(after.status, "unknown");
  assert.equal(after.host, "workstation-2");
  assert.equal(after.owner, "ada");
  assert.equal(connections.get("claude-code-default").status, "ready");
  assert.equal(
    connections.list().filter((c) => c.provider === "claude-code").length,
    2,
  );

  // Editing the alias, kind, and host goes through update().
  const patched = connections.update("claude-code-work", {
    host: "workstation-3",
    kind: "coding-runtime",
    owner: "grace",
  });
  assert.equal(patched.host, "workstation-3");
  assert.equal(patched.owner, "grace");

  // A run using the connection blocks removal; nothing is deleted.
  const workspace = services.hub.get(services.hub.create({ name: "W" }).id);
  const agent = workspace.createAgent({ name: "A", role: "Dev" });
  const task = workspace.create({ title: "T", priority: "medium" });
  services.db
    .prepare(
      `INSERT INTO runs (id, workspace_id, task_id, agent_id, agent_snapshot, connection_id, provider, status, started_at, mode)
       VALUES ('run-1', ?, ?, ?, '{}', 'claude-code-work', 'claude-code', 'completed', 1, 'managed')`,
    )
    .run(workspace.id, task.task?.id ?? task.id, agent.id);
  assert.throws(() => connections.remove("claude-code-work"), /used by 1 run/);
  services.db.prepare("DELETE FROM runs WHERE id = 'run-1'").run();
  assert.deepEqual(connections.remove("claude-code-work"), {
    removed: "claude-code-work",
  });
  assert.throws(() => connections.get("claude-code-work"), /not found/);
  assert.equal(
    services.db
      .prepare(
        "SELECT COUNT(*) AS n FROM connection_probes WHERE connection_id = 'claude-code-work'",
      )
      .get().n,
    0,
  );
  await services.close();
});

test("connection kinds are validated and non-runtime kinds are labelled, never launched", async () => {
  const services = serviceWith(fakeDetect());
  const connections = services.connections;
  await connections.refresh();
  assert.deepEqual(CONNECTION_KINDS, [
    "coding-runtime",
    "model-api",
    "local-model-server",
    "external-agent-service",
    "workflow-engine",
  ]);
  for (const kind of CONNECTION_KINDS) {
    const row = connections.create({
      provider: "gemini",
      alias: `k-${kind}`,
      kind,
    });
    assert.equal(row.kind, kind);
  }
  assert.throws(
    () => connections.create({ provider: "gemini", alias: "x", kind: "robot" }),
    /kind must be one of/,
  );
  assert.throws(
    () => connections.create({ provider: "nope", alias: "x" }),
    /provider must be one of/,
  );
  assert.throws(
    () =>
      connections.create({ provider: "gemini", alias: "not a valid alias" }),
    /alias must be/,
  );
  assert.throws(
    () => connections.update("gemini-k-model-api", { kind: "robot" }),
    /kind must be one of/,
  );
  const doctor = connections
    .doctor()
    .filter((item) => /is recorded as/.test(item.title));
  assert.equal(doctor.length, CONNECTION_KINDS.length - 1);
  assert.ok(
    doctor.every((item) => /cannot launch runs/.test(item.detail)),
    "kinds other than coding-runtime never claim they can run",
  );
  await services.close();
});

test("credential-looking environment overrides are refused, never stored", async () => {
  assert.deepEqual(sanitizeEnv(undefined), { env: {}, refusedEnv: [] });
  const clean = sanitizeEnv({ GEMINI_HOME: "c:/tmp/g", API_KEY: "sk-123" });
  assert.deepEqual(clean.env, { GEMINI_HOME: "c:/tmp/g" });
  assert.deepEqual(clean.refusedEnv, ["API_KEY"]);
  const services = serviceWith(fakeDetect());
  const row = services.connections.create({
    provider: "codex",
    alias: "second",
    env: { CODEX_HOME: "c:/tmp/c", OPENAI_TOKEN: "secret-value" },
  });
  assert.deepEqual(row.details.env, { CODEX_HOME: "c:/tmp/c" });
  assert.deepEqual(row.details.refusedEnv, ["OPENAI_TOKEN"]);
  for (const stored of services.db.prepare("SELECT * FROM connections").all())
    assert.ok(!/secret-value/.test(stored.details));
  await services.close();
});

// ------------------------------------------------------- error categories

test("error categories are derived from what was actually found", async (t) => {
  clearDetectionCache();
  const binDir = tempDir(t, "bin");
  stubCli(binDir, "claude", "2.1.266");
  stubCli(binDir, "codex", "codex-cli 0.152.1");
  stubCli(binDir, "gemini", "0.59.0");
  const { env, homes } = isolatedEnv(t, { binDir });
  // Claude is signed in (existence only); Codex and Gemini are not.
  writeFileSync(join(homes["claude-code"], ".credentials.json"), "{}");

  const entries = await detectProviders({ env, force: true });
  const byId = Object.fromEntries(entries.map((e) => [e.provider, e]));
  const category = (id) => categorizeDetection(byId[id], { env });

  assert.equal(category("claude-code").category, null, "logged in → healthy");
  assert.equal(category("codex").category, "not-logged-in");
  assert.match(category("codex").detail, /No credential file/);
  assert.match(category("codex").remediation, /complete the sign-in/);

  const gemini = category("gemini");
  assert.equal(gemini.category, "not-logged-in");
  assert.match(gemini.detail, /settings\.json/);
  assert.equal(
    gemini.remediation,
    GEMINI_AUTH_FIX,
    "the fix text is the CLI's own wording",
  );

  // Copilot and cursor-agent are not on this PATH at all.
  assert.equal(category("copilot").category, "not-installed");
  assert.match(category("copilot").remediation, /Install GitHub Copilot CLI/);
  assert.equal(category("cursor").category, "not-installed");

  // An auth environment variable is enough for Gemini.
  clearDetectionCache();
  const withKey = { ...env, GEMINI_API_KEY: "x" };
  const [geminiEntry] = await detectProviders({
    env: withKey,
    force: true,
    providers: ["gemini"],
  });
  assert.equal(geminiEntry.authHint, "logged-in-likely");
  assert.equal(
    categorizeDetection(geminiEntry, { env: withKey }).category,
    null,
  );

  // Once ~/.gemini/settings.json exists the file signal is enough.
  clearDetectionCache();
  writeFileSync(join(homes.gemini, "settings.json"), "{}");
  const [settled] = await detectProviders({
    env,
    force: true,
    providers: ["gemini"],
  });
  assert.equal(categorizeDetection(settled, { env }).category, null);

  // Probe failures map to their own categories.
  const base = { provider: "codex", found: true, version: "0.152.1" };
  assert.equal(
    categorizeDetection({
      ...base,
      error: "version probe: timed out after 8000 ms",
    }).category,
    "timeout",
  );
  assert.equal(
    categorizeDetection({ ...base, error: "spawn EACCES" }).category,
    "permission-denied",
  );
  assert.equal(
    categorizeDetection({ ...base, error: "You have hit your usage limit" })
      .category,
    "rate-limited",
  );
  assert.equal(
    categorizeDetection({ ...base, error: "version probe exited with code 1" })
      .category,
    "binary-unrunnable",
  );
  assert.equal(
    categorizeDetection({
      provider: "codex",
      found: true,
      version: "0.1.0",
      authHint: "logged-in-likely",
    }).category,
    "version-unsupported",
  );
  for (const value of ERROR_CATEGORIES)
    assert.ok(remediationFor(value, "codex").length > 20);
  // Auth expiry is never invented: no supported provider publishes one.
  assert.equal(authExpiryFor("gemini", byId.gemini), null);
});

test("connection rows carry the category, remediation, and last success", async () => {
  const services = serviceWith(
    fakeDetect({
      "claude-code": readyClaude,
      gemini: {
        found: true,
        binaryPath: "c:/bin/gemini.cmd",
        version: "0.59.0",
        homeExists: true,
        authHint: "no-credentials-file",
      },
    }),
  );
  const connections = services.connections;
  await connections.refresh();
  const gemini = connections.get("gemini-default");
  assert.equal(gemini.errorCategory, "not-logged-in");
  assert.equal(gemini.remediation, GEMINI_AUTH_FIX);
  assert.equal(gemini.lastSuccessAt, null);
  assert.equal(gemini.authExpiresAt, null);
  const claude = connections.get("claude-code-default");
  assert.equal(claude.errorCategory, null);
  assert.equal(claude.lastSuccessAt, 1000, "a healthy probe is a success");

  connections.markEvent("gemini", 5000);
  const afterEvent = connections.get("gemini-default");
  assert.equal(afterEvent.lastEventAt, 5000);
  assert.equal(
    afterEvent.lastSuccessAt,
    5000,
    "a real provider event is the strongest health signal",
  );

  const health = connections.health("gemini-default");
  assert.equal(health.errorCategory, "not-logged-in");
  assert.equal(health.remediation, GEMINI_AUTH_FIX);
  assert.equal(health.authExpiresAt, null);
  assert.match(health.authExpiryNote, /always empty/i);
  assert.equal(health.compatibility.supported, true);
  assert.ok(health.probes.length >= 1);
  await services.close();
});

test("probe history keeps only the newest 20 entries per connection", async () => {
  let tick = 0;
  const services = createServices({ demo: false });
  const connections = new ConnectionService(services, {
    detect: fakeDetect({ "claude-code": readyClaude }),
    now: () => 1,
  });
  services.connections = connections;
  await connections.refresh();
  // Each probe writes one history row; only 20 survive.
  for (let i = 0; i < 25; i += 1) {
    tick += 1;
    connections.detect = fakeDetect({
      "claude-code": { ...readyClaude, probedAt: 1000 + tick },
    });
    await connections.probe("claude-code-default");
  }
  const probes = connections.probes("claude-code-default");
  assert.equal(probes.length, 20);
  assert.equal(probes[0].probedAt, 1000 + tick, "newest first");
  assert.equal(probes.at(-1).probedAt, 1000 + tick - 19);
  assert.ok(probes.every((p) => p.ok === true && p.category === null));
  assert.equal(
    services.db
      .prepare(
        "SELECT COUNT(*) AS n FROM connection_probes WHERE connection_id = 'claude-code-default'",
      )
      .get().n,
    20,
  );
  // A failing probe records its category and remediation.
  connections.detect = fakeDetect({
    "claude-code": { found: false, probedAt: 9999 },
  });
  await connections.probe("claude-code-default");
  const [latest] = connections.probes("claude-code-default");
  assert.equal(latest.ok, false);
  assert.equal(latest.category, "not-installed");
  assert.match(latest.remediation, /Install Claude Code/);
  await services.close();
});

// ------------------------------------------------------------- migration

function migrationFixture() {
  const services = serviceWith(fakeDetect({ "claude-code": readyClaude }));
  const workspace = services.hub.get(
    services.hub.create({ name: "Migrate", rootPath: "c:/repo" }).id,
  );
  const agent = workspace.createAgent({
    name: "Nova",
    role: "Frontend developer",
    instructions: "Keep components small.",
    model: "claude-sonnet-4",
    provider: "claude-code",
  });
  services.db
    .prepare("UPDATE agent_profiles SET skills = ? WHERE id = ?")
    .run(JSON.stringify(["react", "css"]), agent.id);
  const created = workspace.create({
    title: "Port the header",
    priority: "high",
  });
  const task = created.task ?? created;
  return { services, workspace, agent, task };
}

test("migration plan lists what carries over and never promises parity", async () => {
  const { services, workspace, agent } = migrationFixture();
  const migration = plan({
    services,
    connections: services.connections,
    agentId: agent.id,
    workspaceId: workspace.id,
    targetProvider: "gemini",
  });
  assert.equal(migration.from, "claude-code");
  assert.equal(migration.to, "gemini");
  const fields = migration.compatible.map((entry) => entry.field);
  assert.ok(
    ["name", "role", "instructions", "color"].every((f) => fields.includes(f)),
  );
  assert.ok(fields.includes("skills"));
  assert.deepEqual(
    migration.compatible.find((e) => e.field === "skills").value,
    ["react", "css"],
  );
  assert.ok(migration.unsupported.some((e) => e.field === "model"));
  assert.equal(migration.contextCarried.rootPath, "c:/repo");
  assert.equal(migration.contextCarried.name, "Nova");
  assert.ok(
    migration.warnings.includes(
      "behaviour will differ; hidden state does not transfer",
    ),
  );
  assert.ok(
    migration.warnings.some((w) => /not transferred/i.test(w)),
    "hidden state is called out",
  );
  assert.equal(migration.capabilities.launch, "experimental");
  await services.close();
});

test("migration apply copies the profile, audits it, and can launch a run", async () => {
  const { services, workspace, agent, task } = migrationFixture();
  const launches = [];
  services.runWorker = {
    start: async (input) => {
      launches.push(input);
      return { id: "run-42", status: "running", provider: input.provider };
    },
  };
  const result = await apply({
    services,
    connections: services.connections,
    agentId: agent.id,
    workspaceId: workspace.id,
    targetProvider: "codex",
    taskId: task.id,
    launch: true,
    actor: "tester",
  });
  assert.equal(result.created, true);
  assert.equal(result.profile.provider, "codex");
  assert.equal(result.profile.name, "Nova (Codex)");
  assert.equal(result.profile.role, "Frontend developer");
  assert.equal(result.profile.instructions, "Keep components small.");
  assert.deepEqual(result.profile.skills, ["react", "css"]);
  assert.equal(result.run.id, "run-42");
  assert.deepEqual(launches, [
    {
      workspaceId: workspace.id,
      taskId: task.id,
      agentId: result.profile.id,
      provider: "codex",
      actor: "tester",
    },
  ]);
  assert.ok(
    result.warnings.includes(
      "behaviour will differ; hidden state does not transfer",
    ),
  );
  const audit = services.audit
    .list({ limit: 20 })
    .find((entry) => entry.action === "connection.migrate");
  assert.ok(audit, "the migration is audited");
  assert.equal(audit.details.to, "codex");
  assert.ok(audit.details.fieldsCopied.includes("instructions"));

  // Applying twice updates the same profile instead of creating a second one.
  const again = await apply({
    services,
    connections: services.connections,
    agentId: agent.id,
    workspaceId: workspace.id,
    targetProvider: "codex",
  });
  assert.equal(again.created, false);
  assert.equal(again.profile.id, result.profile.id);
  assert.equal(again.run, null);
  assert.equal(
    workspace.profiles.list().filter((p) => p.provider === "codex").length,
    1,
  );
  await services.close();
});

// ---------------------------------------------------------- gemini adapter

test("gemini adapter builds the verified command line for every autonomy", () => {
  const binary = { command: "gemini", args: [] };
  const build = (policy, extra = {}) =>
    geminiAdapter.build({
      prompt: "do the thing",
      binary,
      cwd: "C:\\repo",
      policy,
      sessionId: "11111111-2222-3333-4444-555555555555",
      ...extra,
    });
  assert.deepEqual(AUTONOMY_APPROVAL_MODE, {
    propose: "plan",
    scoped: "auto_edit",
    sandbox: "yolo",
  });
  for (const [autonomy, mode] of Object.entries(AUTONOMY_APPROVAL_MODE)) {
    const built = build({ autonomy });
    assert.deepEqual(built.args, [
      "-p",
      "do the thing",
      "-o",
      "stream-json",
      "--approval-mode",
      mode,
      "--session-id",
      "11111111-2222-3333-4444-555555555555",
    ]);
    assert.equal(built.cwd, "C:\\repo");
  }
  const full = build(
    { autonomy: "scoped" },
    { model: "gemini-2.5-pro", extraDirs: ["C:\\docs", "C:\\notes"] },
  );
  assert.deepEqual(full.args.slice(4), [
    "--approval-mode",
    "auto_edit",
    "-m",
    "gemini-2.5-pro",
    "--include-directories",
    "C:\\docs,C:\\notes",
    "--session-id",
    "11111111-2222-3333-4444-555555555555",
  ]);
  const resumed = build({ autonomy: "scoped" }, { resumeSessionId: "latest" });
  assert.ok(resumed.args.includes("-r"));
  assert.equal(resumed.args[resumed.args.indexOf("-r") + 1], "latest");
  assert.ok(
    !resumed.args.includes("--session-id"),
    "a resumed run keeps the provider's session id",
  );
  assert.ok(
    !full.args.includes("--skip-trust") && !full.args.includes("-y"),
    "folder trust is never skipped automatically",
  );
  assert.equal(geminiAdapter.capabilities.launch, "experimental");
  assert.equal(geminiAdapter.capabilities.stream, "unknown");
});

test("gemini's real auth-error envelope becomes a failed run with the fix text", () => {
  const line = JSON.stringify({
    session_id: "0e3f9d5c-1a2b-4c3d-9e8f-7a6b5c4d3e2f",
    error: {
      type: "Error",
      message:
        "Please set an Auth method in your C:\\Users\\dev\\.gemini\\settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA",
      code: 41,
    },
  });
  const envelope = parseErrorEnvelope(line);
  assert.equal(envelope.category, "not-logged-in");
  assert.equal(envelope.code, 41);
  const state = {};
  const events = geminiAdapter.parse(line, state);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "error");
  assert.equal(events[0].data.errorCategory, "not-logged-in");
  assert.match(events[0].data.fix, /GEMINI_API_KEY/);
  assert.equal(state.sessionId, "0e3f9d5c-1a2b-4c3d-9e8f-7a6b5c4d3e2f");

  const final = geminiAdapter.finalize(state, 41);
  assert.equal(final.status, "failed", "never completed");
  assert.equal(final.errorCategory, "not-logged-in");
  assert.match(final.error, /not signed in/);
  assert.match(final.fix, /GEMINI_API_KEY/);
  assert.equal(final.sessionId, "0e3f9d5c-1a2b-4c3d-9e8f-7a6b5c4d3e2f");

  // Exit 41 alone (the envelope only reaches stderr) is enough.
  const blind = geminiAdapter.finalize({}, 41);
  assert.equal(blind.status, "failed");
  assert.equal(blind.errorCategory, "not-logged-in");

  // A normal stream still finalizes normally.
  const ok = { sessionId: "s1", model: "gemini-2.5-pro" };
  assert.equal(geminiAdapter.finalize(ok, 0).status, "completed");
});

test("cursor refuses to launch with the exact reason and a fix link", () => {
  assert.equal(
    CURSOR_LAUNCH_REFUSAL,
    "cursor-agent is not installed; the Cursor IDE launcher cannot run headless tasks",
  );
  assert.throws(
    () =>
      cursorAdapter.build({
        prompt: "hi",
        binary: { command: "cursor", args: [] },
        cwd: "C:\\repo",
        policy: { autonomy: "scoped" },
      }),
    (error) => {
      assert.equal(error.message, CURSOR_LAUNCH_REFUSAL);
      assert.equal(error.status, 409);
      assert.match(error.fix, /^https:\/\/docs\.cursor\.com/);
      return true;
    },
  );
  assert.equal(cursorAdapter.capabilities.launch, "unsupported");
});

// ---------------------------------------------------------------- routes

function call(services, method, path, { body, query = "" } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`http://localhost${path}${query}`);
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
      body: async () => body,
      send: (status, data) => resolve({ status, data }),
    };
    connectionRoutes(ctx)
      .then((handled) => {
        if (!handled) resolve({ status: 0, handled: false });
      })
      .catch(reject);
  });
}

test("routes create, delete, list probes, report compatibility, and migrate", async () => {
  const { services, workspace, agent, task } = migrationFixture();
  await services.connections.refresh();
  services.runWorker = {
    start: async (input) => ({ id: "run-7", provider: input.provider }),
  };

  const created = await call(services, "POST", "/api/connections", {
    body: {
      provider: "codex",
      alias: "second",
      kind: "model-api",
      host: "lab",
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.id, "codex-second");
  assert.equal(created.data.kind, "model-api");

  const probes = await call(
    services,
    "GET",
    "/api/connections/claude-code-default/probes",
  );
  assert.equal(probes.status, 200);
  assert.ok(probes.data.length >= 1);
  assert.equal(probes.data[0].ok, true);

  const compat = await call(services, "GET", "/api/connections/compatibility");
  assert.deepEqual(Object.keys(compat.data), PROVIDER_IDS);
  assert.equal(compat.data["claude-code"].supported, true);
  const one = await call(services, "GET", "/api/connections/compatibility", {
    query: "?provider=gemini&version=0.1.0",
  });
  assert.equal(one.data.supported, false);

  const planned = await call(
    services,
    "POST",
    "/api/connections/codex-default/migrate",
    { body: { agentId: agent.id, workspaceId: workspace.id } },
  );
  assert.equal(planned.status, 200);
  assert.equal(planned.data.to, "codex");
  assert.ok(planned.data.compatible.length);
  assert.equal(planned.data.profile, undefined, "a plan changes nothing");

  const applied = await call(
    services,
    "POST",
    "/api/connections/codex-default/migrate",
    {
      body: {
        agentId: agent.id,
        workspaceId: workspace.id,
        taskId: task.id,
        launch: true,
      },
      query: "?apply=1",
    },
  );
  assert.equal(applied.data.profile.provider, "codex");
  assert.equal(applied.data.run.id, "run-7");

  const removed = await call(
    services,
    "DELETE",
    "/api/connections/codex-second",
  );
  assert.deepEqual(removed.data, { removed: "codex-second" });
  assert.throws(() => services.connections.get("codex-second"), /not found/);
  await services.close();
});
