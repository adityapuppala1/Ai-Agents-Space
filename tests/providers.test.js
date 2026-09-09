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
import { CAPABILITIES, PROVIDER_IDS } from "../packages/core/src/contracts.js";
import {
  normalizePath,
  samePath,
  isWithin,
  expandHome,
  providerHome,
  slugForClaudeProject,
  basenameOf,
} from "../packages/core/src/util/paths.js";
import {
  REGISTRY,
  COMPATIBILITY,
  capabilityMatrix,
  compareVersions,
  compatibility,
  listProviders,
  binaryOverrideEnvName,
} from "../packages/core/src/providers/registry.js";
import {
  detectProviders,
  detectProvider,
  clearDetectionCache,
  parseVersion,
  parseCommandLine,
  pickExecutable,
  runCommand,
} from "../packages/core/src/providers/detect.js";
import { ConnectionService } from "../packages/core/src/connections/ConnectionService.js";
import connectionRoutes from "../packages/server/src/routes/connections.js";

const win = process.platform === "win32";

function tempDir(t, label = "providers") {
  const dir = mkdtempSync(join(tmpdir(), `agent-space-${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Builds an environment that never touches real provider homes: every home
 * env var points at a fresh temp dir and PATH contains only `binDir`.
 */
function isolatedEnv(t, { binDir, overrides = {} } = {}) {
  const homes = tempDir(t, "homes");
  const env = { ...process.env };
  delete env.PATH;
  delete env.Path;
  delete env.path;
  env.PATH = binDir ?? tempDir(t, "empty-bin");
  if (win) env.Path = env.PATH;
  env.HOME = homes;
  env.USERPROFILE = homes;
  for (const id of PROVIDER_IDS) {
    const home = join(homes, id);
    mkdirSync(home, { recursive: true });
    env[REGISTRY[id].homeEnv] = home;
    delete env[binaryOverrideEnvName(id)];
  }
  return Object.assign(env, overrides);
}

/** Writes a stub CLI that prints `output` (a .cmd on win32, sh script elsewhere). */
function stubCli(binDir, name, output) {
  if (win) {
    writeFileSync(
      join(binDir, `${name}.cmd`),
      `@echo off\r\necho ${output}\r\n`,
    );
  } else {
    const file = join(binDir, name);
    writeFileSync(file, `#!/bin/sh\necho "${output}"\n`);
    chmodSync(file, 0o755);
  }
}

function nodeScript(dir, name, source) {
  const file = join(dir, name);
  writeFileSync(file, source);
  return `"${process.execPath}" "${file}"`;
}

// ---------------------------------------------------------------- paths

test("normalizePath, samePath, isWithin handle Windows paths", () => {
  assert.equal(
    normalizePath("C:\\xampp\\htdocs\\Ai_Agents_View\\", { platform: "win32" }),
    "c:/xampp/htdocs/Ai_Agents_View",
  );
  assert.equal(normalizePath("C:\\", { platform: "win32" }), "c:/");
  assert.equal(normalizePath("/", { platform: "linux" }), "/");
  assert.equal(
    normalizePath("/home//me/project/", { platform: "linux" }),
    "/home/me/project",
  );
  assert.equal(
    normalizePath("\\\\server\\share\\x", { platform: "win32" }),
    "//server/share/x",
  );
  assert.equal(normalizePath(null), "");
  assert.ok(samePath("C:\\Work\\App", "c:/work/app/", { platform: "win32" }));
  assert.ok(!samePath("/a/B", "/a/b", { platform: "linux" }));
  assert.ok(
    isWithin("C:\\Work\\App\\src\\x.js", "c:/work/app", { platform: "win32" }),
  );
  assert.ok(isWithin("c:/work/app", "C:\\Work\\App", { platform: "win32" }));
  assert.ok(!isWithin("c:/work/app2", "c:/work/app", { platform: "win32" }));
  assert.ok(!isWithin("c:/work", "c:/work/app", { platform: "win32" }));
  assert.ok(!isWithin("", "c:/work", { platform: "win32" }));
});

test("expandHome, providerHome, slug, basename", () => {
  assert.equal(expandHome("~/x", "C:\\Users\\me"), "C:\\Users\\me/x");
  assert.equal(expandHome("~", "/home/me"), "/home/me");
  assert.equal(expandHome("~\\y", "C:\\U"), "C:\\U\\y");
  assert.equal(expandHome("/abs"), "/abs");
  const env = { HOME: "C:\\Users\\me", USERPROFILE: "C:\\Users\\me" };
  assert.equal(
    providerHome("claude-code", env, { platform: "win32" }),
    "c:/Users/me/.claude",
  );
  assert.equal(
    providerHome(
      "codex",
      { ...env, CODEX_HOME: "D:\\codex-home\\" },
      { platform: "win32" },
    ),
    "d:/codex-home",
  );
  assert.throws(() => providerHome("nope", env));
  assert.equal(
    slugForClaudeProject("C:\\xampp\\htdocs\\Ai_Agents_View"),
    "c--xampp-htdocs-Ai-Agents-View",
  );
  assert.equal(slugForClaudeProject("/home/me/proj.x"), "-home-me-proj-x");
  assert.equal(basenameOf("C:\\work\\App\\", { platform: "win32" }), "App");
  assert.equal(basenameOf("c:/", { platform: "win32" }), "");
  assert.equal(basenameOf("/a/b/c.txt"), "c.txt");
});

// ------------------------------------------------------------- registry

test("registry covers every provider with an honest capability matrix", () => {
  for (const id of PROVIDER_IDS) {
    assert.ok(REGISTRY[id], `registry has ${id}`);
    assert.ok(REGISTRY[id].docsUrl.startsWith("https://"));
    const matrix = capabilityMatrix(id);
    assert.deepEqual(Object.keys(matrix), CAPABILITIES);
    for (const value of Object.values(matrix))
      assert.ok(
        ["verified", "unsupported", "unknown", "experimental"].includes(value),
      );
  }
  assert.equal(REGISTRY["claude-code"].launchVerified, true);
  assert.equal(REGISTRY.copilot.launchVerified, true);
  assert.equal(REGISTRY.codex.launchVerified, "format-verified");
  assert.equal(REGISTRY.cursor.launchVerified, false);
  // Gemini: flags read from the CLI's own --help, no authenticated run seen.
  assert.equal(REGISTRY.gemini.launchVerified, "flags-verified");
  // Claude approve depends on the hook bridge.
  assert.equal(capabilityMatrix("claude-code").approve, "unknown");
  assert.equal(
    capabilityMatrix("claude-code", { hooksInstalled: true }).approve,
    "verified",
  );
  assert.equal(capabilityMatrix("claude-code").fork, "unsupported");
  assert.equal(capabilityMatrix("codex").launch, "experimental");
  assert.equal(capabilityMatrix("copilot").approve, "unsupported");
  assert.equal(capabilityMatrix("cursor").observe, "experimental");
  assert.equal(capabilityMatrix("cursor").launch, "unsupported");
  // Gemini: launch flags verified from --help, storage layout real, nothing
  // else observed → experimental for those two, unknown everywhere else.
  const gemini = capabilityMatrix("gemini");
  assert.equal(gemini.launch, "experimental");
  assert.equal(gemini.observe, "experimental");
  for (const [key, value] of Object.entries(gemini))
    if (!["launch", "observe"].includes(key))
      assert.ok(
        ["unknown", "unsupported"].includes(value),
        `gemini.${key} is ${value}`,
      );
  assert.equal(compareVersions("2.1.266", "2.0.0"), 1);
  assert.equal(compareVersions("0.152.1", "0.152.1"), 0);
  assert.equal(compareVersions("1.0", "1.0.5"), -1);
  assert.equal(
    binaryOverrideEnvName("claude-code"),
    "AGENT_SPACE_BIN_CLAUDE_CODE",
  );
  const listed = listProviders();
  assert.equal(listed.length, PROVIDER_IDS.length);
  assert.equal(listed[0].capabilities.approve, "unknown");
  assert.ok(listed.every((p) => p.compatibility));
});

test("compatibility reports tested versions honestly, never guessing", () => {
  const win = { platform: "win32" };
  assert.equal(
    compatibility("claude-code", "2.1.266", win).supported,
    true,
    "a version we actually exercised",
  );
  const newer = compatibility("claude-code", "2.9.0", win);
  assert.equal(newer.supported, "untested");
  assert.match(newer.reason, /has not been tested here/);
  const old = compatibility("claude-code", "1.4.0", win);
  assert.equal(old.supported, false);
  assert.match(old.reason, /older than 2\.0\.0/);
  // No version reported → untested, never "supported".
  assert.equal(compatibility("codex", null, win).supported, "untested");
  // Another OS: only Windows has been exercised.
  assert.equal(
    compatibility("codex", "0.152.1", { platform: "linux" }).supported,
    "untested",
  );
  // cursor-agent has never run here, so no version can be supported.
  const cursor = compatibility("cursor", "3.14.27", win);
  assert.equal(cursor.supported, "untested");
  assert.match(cursor.reason, /never been exercised/);
  const gemini = compatibility("gemini", "0.59.0", win);
  assert.equal(gemini.supported, true);
  assert.match(gemini.notes, /not authenticated/i);
  assert.deepEqual(COMPATIBILITY.gemini.testedOS, ["win32"]);
});

// ------------------------------------------------------------ detection

test("parseVersion and parseCommandLine", () => {
  assert.equal(parseVersion("2.1.266 (Claude Code)"), "2.1.266");
  assert.equal(parseVersion("codex-cli 0.152.1"), "0.152.1");
  assert.equal(parseVersion("v1.0.80\n"), "1.0.80");
  assert.equal(parseVersion("1.2.3-beta.1"), "1.2.3-beta.1");
  assert.equal(parseVersion("no version here"), null);
  assert.deepEqual(parseCommandLine('node "C:\\my dir\\claude.js" --flag'), [
    "node",
    "C:\\my dir\\claude.js",
    "--flag",
  ]);
  assert.deepEqual(parseCommandLine("  "), []);
});

test("detects a stub CLI on PATH and reports version + auth hint", async (t) => {
  clearDetectionCache();
  const binDir = tempDir(t, "bin");
  stubCli(binDir, "claude", "2.1.266 (Claude Code)");
  stubCli(binDir, "codex", "codex-cli 0.152.1");
  const env = isolatedEnv(t, { binDir });
  writeFileSync(join(env.CLAUDE_CONFIG_DIR, ".credentials.json"), "{}");
  const entries = await detectProviders({ env, force: true });
  assert.equal(entries.length, PROVIDER_IDS.length);
  const claude = entries.find((e) => e.provider === "claude-code");
  assert.equal(claude.found, true);
  assert.equal(claude.version, "2.1.266");
  assert.match(claude.binaryPath, /claude/i);
  assert.equal(claude.authHint, "logged-in-likely");
  assert.equal(claude.homeExists, true);
  assert.equal(claude.error, null);
  assert.equal(samePath(claude.homePath, env.CLAUDE_CONFIG_DIR), true);
  const codex = entries.find((e) => e.provider === "codex");
  assert.equal(codex.found, true);
  assert.equal(codex.version, "0.152.1");
  assert.equal(codex.authHint, "no-credentials-file");
  const copilot = entries.find((e) => e.provider === "copilot");
  assert.equal(copilot.found, false);
  assert.equal(copilot.binaryPath, null);
  assert.equal(copilot.version, null);
  assert.equal(copilot.authHint, "unknown");
  assert.ok(typeof claude.probedAt === "number");
});

test("AGENT_SPACE_BIN_<PROVIDER> override runs a node script for the version probe", async (t) => {
  clearDetectionCache();
  const dir = tempDir(t, "override");
  const command = nodeScript(
    dir,
    "copilot.js",
    "console.log(process.argv.includes('--version') ? '1.0.80' : 'nope');",
  );
  const env = isolatedEnv(t, {
    overrides: { AGENT_SPACE_BIN_COPILOT: command },
  });
  const entry = await detectProvider("copilot", { env });
  assert.equal(entry.found, true);
  assert.equal(entry.override, true);
  assert.equal(entry.version, "1.0.80");
  assert.equal(entry.binaryPath, command);
  assert.equal(entry.error, null);
});

test("a hanging version probe is killed and reported, never awaited forever", async (t) => {
  clearDetectionCache();
  const dir = tempDir(t, "hang");
  const command = nodeScript(dir, "gemini.js", "setInterval(() => {}, 1000);");
  const env = isolatedEnv(t, {
    overrides: { AGENT_SPACE_BIN_GEMINI: command },
  });
  const started = Date.now();
  const entry = await detectProvider("gemini", { env, versionTimeoutMs: 300 });
  assert.ok(Date.now() - started < 5000);
  assert.equal(entry.found, true);
  assert.equal(entry.version, null);
  assert.match(entry.error, /timed out/);
});

test("runCommand can be cancelled through an AbortSignal", async (t) => {
  const dir = tempDir(t, "abort");
  const file = join(dir, "sleep.js");
  writeFileSync(file, "setInterval(() => {}, 1000);");
  const controller = new AbortController();
  const promise = runCommand(process.execPath, [file], {
    timeoutMs: 10_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  const result = await promise;
  assert.equal(result.aborted, true);
  assert.equal(result.error, "cancelled");
});

test("missing binaries and failing lookups are reported per provider", async (t) => {
  clearDetectionCache();
  const env = isolatedEnv(t);
  const entries = await detectProviders({ env, force: true });
  for (const entry of entries) {
    assert.equal(entry.found, false, entry.provider);
    assert.equal(entry.error, null, entry.provider);
  }
  const failing = await detectProviders({
    env,
    force: true,
    which: async () => {
      throw new Error("where exploded");
    },
  });
  assert.ok(failing.every((e) => /where exploded/.test(e.error)));
  assert.ok(failing.every((e) => e.found === false));
});

test("detection results are cached for 60 s per environment", async (t) => {
  clearDetectionCache();
  const env = isolatedEnv(t);
  let calls = 0;
  const which = async () => {
    calls += 1;
    return null;
  };
  let clock = 1_000_000;
  const now = () => clock;
  const first = await detectProviders({ env, which, now });
  const lookups = calls;
  assert.ok(lookups > 0);
  const second = await detectProviders({ env, which, now });
  assert.equal(calls, lookups, "cached: no new lookups");
  assert.equal(second, first);
  clock += 59_000;
  await detectProviders({ env, which, now });
  assert.equal(calls, lookups);
  clock += 2_000;
  await detectProviders({ env, which, now });
  assert.equal(calls, lookups * 2, "expired after 60 s");
  await detectProviders({ env, which, now, force: true });
  assert.equal(calls, lookups * 3, "force bypasses the cache");
  const other = isolatedEnv(t, { overrides: { AGENT_SPACE_BIN_CODEX: "x" } });
  await detectProviders({ env: other, which, now, providers: ["copilot"] });
  assert.equal(calls, lookups * 3 + 1, "different env → separate cache entry");
});

// ---------------------------------------------------- ConnectionService

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
      probedAt: 123,
      ...(overrides[provider] ?? {}),
    }));
}

const ready = {
  found: true,
  binaryPath: "c:/bin/claude.exe",
  version: "2.1.266",
  homeExists: true,
  authHint: "logged-in-likely",
};

test("ConnectionService.refresh upserts one row per provider with honest status", async () => {
  const services = createServices({ demo: false });
  const globals = [];
  services.bus.on("global", () => globals.push(1));
  const connections = new ConnectionService(services, {
    detect: fakeDetect({
      "claude-code": ready,
      codex: {
        found: true,
        binaryPath: "c:/bin/codex.exe",
        version: "0.152.1",
        authHint: "no-credentials-file",
      },
      copilot: {
        found: true,
        binaryPath: "c:/bin/copilot.cmd",
        version: "1.0.80",
        error: "version probe: timed out after 8000 ms",
      },
      cursor: { found: false, error: "lookup cursor-agent: where exploded" },
    }),
    now: () => 42,
  });
  const list = await connections.refresh();
  assert.equal(list.length, PROVIDER_IDS.length);
  assert.equal(globals.length, 1);
  const byId = Object.fromEntries(list.map((c) => [c.provider, c]));
  assert.equal(byId["claude-code"].status, "ready");
  assert.equal(byId["claude-code"].id, "claude-code-default");
  assert.equal(byId["claude-code"].alias, "default");
  assert.equal(byId["claude-code"].version, "2.1.266");
  assert.equal(byId["claude-code"].lastProbeAt, 123);
  assert.equal(byId["claude-code"].details.authHint, "logged-in-likely");
  assert.equal(byId["claude-code"].capabilities.approve, "unknown");
  assert.equal(byId.codex.status, "detected");
  assert.equal(byId.copilot.status, "error");
  assert.match(byId.copilot.error, /timed out/);
  assert.equal(byId.cursor.status, "error");
  assert.equal(byId.gemini.status, "missing");
  assert.equal(byId.gemini.enabled, true);
  assert.equal(byId.gemini.observe, true);
  // Second refresh updates in place (no duplicate rows).
  await connections.refresh();
  assert.equal(connections.list().length, PROVIDER_IDS.length);
  assert.equal(
    services.db.prepare("SELECT COUNT(*) AS n FROM connections").get().n,
    PROVIDER_IDS.length,
  );
  // Rows never contain credential contents.
  for (const row of services.db.prepare("SELECT * FROM connections").all()) {
    assert.ok(!/token|password|secret/i.test(row.details));
    assert.equal(row.auth_ref, null);
  }
});

test("update validates fields, probe records last_probe_at, markEvent sets last_event_at", async () => {
  const services = createServices({ demo: false });
  let probeCount = 0;
  const connections = new ConnectionService(services, {
    detect: async (opts) => {
      probeCount += 1;
      return fakeDetect({ "claude-code": ready })(opts);
    },
    now: () => 500,
  });
  await connections.refresh();
  const id = "claude-code-default";
  const updated = connections.update(id, {
    enabled: false,
    observe: false,
    owner: "dev",
    allowedWorkspaces: ["demo", "demo", "ws-1"],
  });
  assert.equal(updated.enabled, false);
  assert.equal(updated.observe, false);
  assert.equal(updated.owner, "dev");
  assert.deepEqual(updated.allowedWorkspaces, ["demo", "ws-1"]);
  assert.equal(updated.updatedAt, 500);
  assert.throws(
    () => connections.update(id, { enabled: "yes" }),
    /true or false/,
  );
  assert.throws(() => connections.update(id, { alias: "bad alias!" }), /alias/);
  assert.throws(
    () => connections.update(id, { status: "ready" }),
    /Unknown field/,
  );
  assert.throws(
    () => connections.update(id, { allowedWorkspaces: "demo" }),
    /array/,
  );
  assert.throws(() => connections.update(id, {}), /Nothing to update/);
  assert.throws(
    () => connections.update("nope", { enabled: true }),
    /not found/,
  );
  assert.equal(connections.update(id, { alias: "work" }).alias, "work");
  assert.equal(connections.get(id).alias, "work");
  // Detection state survives a user update and a probe keeps user fields.
  const probesBefore = probeCount;
  const probed = await connections.probe(id);
  assert.equal(probeCount, probesBefore + 1);
  assert.equal(probed.lastProbeAt, 123);
  assert.equal(probed.enabled, false);
  assert.equal(probed.alias, "work");
  assert.equal(probed.status, "ready");
  connections.markEvent("claude-code", 900);
  assert.equal(connections.get(id).lastEventAt, 900);
  connections.markEvent("claude-code", 800);
  assert.equal(connections.get(id).lastEventAt, 900, "never moves backwards");
  assert.equal(connections.forProvider("claude-code", "work").id, id);
  assert.equal(connections.forProvider("claude-code"), null);
});

test("capabilities honour the hook bridge status and the doctor speaks plainly", async () => {
  const services = createServices({ demo: false });
  const connections = new ConnectionService(services, {
    detect: fakeDetect({
      "claude-code": ready,
      codex: {
        found: true,
        binaryPath: "c:/bin/codex.exe",
        version: "0.100.0",
        authHint: "no-credentials-file",
      },
      copilot: {
        found: true,
        binaryPath: "c:/bin/copilot.cmd",
        version: "1.0.80",
      },
      // The IDE launcher answers --version; cursor-agent is a separate CLI.
      cursor: {
        found: true,
        binaryPath: "c:/cursor/resources/app/bin/cursor.cmd",
        binaryName: "cursor",
        version: "3.14.27",
      },
    }),
  });
  await connections.refresh();
  assert.equal(connections.get("cursor-default").status, "detected");
  assert.equal(connections.get("cursor-default").details.binaryName, "cursor");
  assert.equal(connections.capabilities("claude-code").approve, "unknown");
  assert.equal(
    connections.capabilities("claude-code", { hooksInstalled: true }).approve,
    "verified",
  );
  assert.equal(connections.can("claude-code", "launch"), true);
  assert.equal(connections.can("cursor", "launch"), false);
  assert.throws(() => connections.capabilities("nope"), /Unknown provider/);
  assert.deepEqual(Object.keys(connections.allCapabilities()), PROVIDER_IDS);

  let items = connections.doctor();
  const forProvider = (id) => items.filter((i) => i.provider === id);
  assert.ok(
    forProvider("claude-code").some(
      (i) => /hooks are not installed/i.test(i.title) && i.level === "warn",
    ),
  );
  assert.ok(forProvider("codex").some((i) => /not logged in/i.test(i.title)));
  assert.ok(
    forProvider("codex").some((i) =>
      /older than the verified version/i.test(i.title),
    ),
  );
  assert.ok(forProvider("codex").some((i) => /experimental/i.test(i.title)));
  assert.ok(forProvider("copilot").some((i) => i.level === "ok"));
  assert.ok(
    forProvider("cursor").some(
      (i) =>
        /cursor-agent is not installed/i.test(i.title) &&
        i.level === "warn" &&
        /IDE launcher/.test(i.detail) &&
        i.fix,
    ),
  );
  assert.ok(
    !forProvider("cursor").some((i) => i.level === "ok"),
    "the IDE launcher alone is never reported as ready",
  );
  assert.ok(
    forProvider("gemini").some((i) => /not installed/i.test(i.title) && i.fix),
  );
  for (const item of items) {
    assert.ok(["ok", "warn", "error"].includes(item.level));
    assert.ok(item.title && item.detail);
  }

  // Settings from module F flip the hook status; observation off is reported.
  services.settings = {
    get: (key, fallback) =>
      key === "hooks.claudeCode.installed" ? true : fallback,
  };
  connections.update("claude-code-default", { observe: false });
  items = connections.doctor();
  assert.ok(
    !forProvider("claude-code").some((i) =>
      /hooks are not installed/i.test(i.title),
    ),
  );
  assert.ok(
    forProvider("claude-code").some((i) =>
      /observation is turned off/i.test(i.title),
    ),
  );
  assert.equal(connections.capabilities("claude-code").approve, "verified");
  assert.equal(
    connections.providers().find((p) => p.id === "claude-code").capabilities
      .approve,
    "verified",
  );
});

test("migrationPreview lists compatible and unsupported fields without promising parity", async () => {
  const services = createServices({ demo: false });
  const connections = new ConnectionService(services, {
    detect: fakeDetect({
      codex: { found: true, binaryPath: "x", version: "0.152.1" },
    }),
  });
  await connections.refresh();
  const workspace = services.hub.get(
    services.hub.create({ name: "Migrate" }).id,
  );
  const agent = workspace.createAgent({
    name: "Reviewer",
    role: "Code reviewer",
    instructions: "Be strict.",
    color: "#112233",
    runtime: "claude-code",
    model: "claude-sonnet-4-5",
  });
  const preview = connections.migrationPreview(
    { workspaceId: workspace.id, agentId: agent.id },
    "codex",
  );
  assert.equal(preview.from, "claude-code");
  assert.equal(preview.to, "codex");
  assert.deepEqual(
    preview.compatible.map((f) => f.field).sort(),
    ["color", "instructions", "name", "role"].sort(),
  );
  const model = preview.unsupported.find((f) => f.field === "model");
  assert.equal(model.value, "claude-sonnet-4-5");
  assert.match(model.reason, /runtime-specific/);
  assert.ok(preview.notes.some((n) => /not transferred/i.test(n)));
  assert.ok(preview.notes.some((n) => /experimental/i.test(n)));
  assert.equal(preview.targetStatus, "detected");
  assert.equal(preview.capabilities.launch, "experimental");
  assert.throws(
    () => connections.migrationPreview(agent, "nope"),
    /Unknown provider/,
  );
  assert.throws(() => connections.migrationPreview(null, "codex"), /required/);
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

test("connection routes expose providers, connections, doctor, capabilities, probe, patch, migration", async () => {
  const services = createServices({ demo: false });
  // createServices now attaches a ConnectionService; the route contract is
  // checked against a container without one.
  services.connections = null;
  assert.equal((await call(services, "GET", "/api/connections")).status, 503);
  services.connections = new ConnectionService(services, {
    detect: fakeDetect({ "claude-code": ready }),
  });
  const providers = await call(services, "GET", "/api/providers");
  assert.equal(providers.status, 200);
  assert.equal(providers.data.length, PROVIDER_IDS.length);
  const refresh = await call(services, "POST", "/api/connections/refresh");
  assert.equal(refresh.status, 200);
  assert.equal(
    refresh.data.find((c) => c.provider === "claude-code").status,
    "ready",
  );
  const list = await call(services, "GET", "/api/connections");
  assert.equal(list.data.length, PROVIDER_IDS.length);
  const one = await call(
    services,
    "GET",
    "/api/connections/claude-code-default",
  );
  assert.equal(one.data.provider, "claude-code");
  const doctor = await call(services, "GET", "/api/connections/doctor");
  assert.ok(Array.isArray(doctor.data) && doctor.data.length > 0);
  const caps = await call(services, "GET", "/api/connections/capabilities");
  assert.equal(caps.data["claude-code"].approve, "unknown");
  const probe = await call(
    services,
    "POST",
    "/api/connections/claude-code-default/probe",
  );
  assert.equal(probe.data.status, "ready");
  const patch = await call(
    services,
    "PATCH",
    "/api/connections/claude-code-default",
    { body: { observe: false } },
  );
  assert.equal(patch.data.observe, false);
  await assert.rejects(
    call(services, "PATCH", "/api/connections/claude-code-default", {
      body: { enabled: "x" },
    }),
    /true or false/,
  );
  const workspace = services.hub.get(services.hub.create({ name: "R" }).id);
  const agent = workspace.createAgent({ name: "A", role: "B", model: "gpt-5" });
  const preview = await call(
    services,
    "GET",
    "/api/connections/claude-code-default/migration-preview",
    {
      query: `?agentId=${agent.id}&workspaceId=${workspace.id}`,
    },
  );
  assert.equal(preview.data.to, "claude-code");
  assert.equal(preview.data.unsupported[0].field, "model");
  await assert.rejects(
    call(
      services,
      "GET",
      "/api/connections/claude-code-default/migration-preview",
    ),
    /required/,
  );
  assert.equal((await call(services, "GET", "/api/other")).handled, false);
  await assert.rejects(
    call(services, "DELETE", "/api/connections/x"),
    /Connection not found/,
  );
  assert.equal(
    (await call(services, "GET", "/api/connections/a/b/c")).handled,
    false,
  );
});

test("pickExecutable prefers PATHEXT executables over extension-less shims on win32", (t) => {
  const dir = tempDir(t, "shims");
  const shim = join(dir, "copilot");
  const cmd = join(dir, "copilot.cmd");
  writeFileSync(shim, '#!/bin/sh\nexec node copilot.js "$@"\n');
  writeFileSync(cmd, "@echo off\r\necho GitHub Copilot CLI 1.0.80.\r\n");
  const env = { PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  // `where` lists the shim first: Windows must still spawn the .cmd.
  assert.equal(pickExecutable([shim, cmd], { env, platform: "win32" }), cmd);
  assert.equal(pickExecutable([cmd, shim], { env, platform: "win32" }), cmd);
  // No executable extension at all: fall back to the first existing entry.
  assert.equal(pickExecutable([shim], { env, platform: "win32" }), shim);
  assert.equal(
    pickExecutable([join(dir, "missing"), shim], { env, platform: "win32" }),
    shim,
  );
  assert.equal(pickExecutable([], { env, platform: "win32" }), null);
  // POSIX keeps the first match.
  assert.equal(pickExecutable([shim, cmd], { env, platform: "linux" }), shim);
});

test(
  "win32 detection runs the .cmd shim even when `where` lists the POSIX shim first",
  { skip: !win },
  async (t) => {
    clearDetectionCache();
    const binDir = tempDir(t, "npm-bin");
    // npm writes both a POSIX shim (no extension) and a .cmd wrapper.
    writeFileSync(join(binDir, "copilot"), "#!/bin/sh\nexec node copilot.js\n");
    stubCli(binDir, "copilot", "GitHub Copilot CLI 1.0.80.");
    const env = isolatedEnv(t, { binDir });
    const entry = await detectProvider("copilot", { env });
    assert.equal(entry.found, true);
    assert.match(entry.binaryPath, /copilot\.cmd$/i);
    assert.equal(entry.version, "1.0.80");
    assert.equal(entry.error, null);
  },
);
