import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createServices } from "../packages/core/src/services.js";
import { openDatabase } from "../packages/core/src/db.js";
import {
  IncidentService,
  assertDispatchAllowed,
} from "../packages/core/src/ops/Incident.js";
import { BackupService } from "../packages/core/src/ops/Backup.js";
import { HealthService, THRESHOLDS } from "../packages/core/src/ops/Health.js";
import { DiagnosticsService } from "../packages/core/src/ops/Diagnostics.js";
import {
  RetentionService,
  DAY_MS,
  validateRetention,
} from "../packages/core/src/ops/Retention.js";
import opsRoutes from "../packages/server/src/routes/ops.js";

const TEMP_DIRS = [];
function tempDir(prefix = "agent-space-ops-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of TEMP_DIRS.splice(0))
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
});

/**
 * A services container with a fake run worker. Nothing here launches a real
 * provider CLI and no provider home is read.
 */
function setup({ dbPath } = {}) {
  const services = createServices({
    demo: false,
    disableObservation: true,
    dbPath: dbPath ?? ":memory:",
    detect: async () => [],
  });
  const cancelled = [];
  services.runWorker = {
    cancelled,
    fail: new Set(),
    async cancel(runId) {
      if (services.runWorker.fail.has(runId))
        throw new Error("Run is not attached to this server");
      cancelled.push(runId);
      services.recorder.setStatus(runId, "cancelled", {
        summary: "cancelled by the operator",
      });
    },
    providerHealth: () => ({}),
  };
  services.incidents = new IncidentService(services);
  services.health = new HealthService(services);
  services.retention = new RetentionService(services);
  const record = services.hub.create({ name: "Ops", rootPath: tempDir() });
  const workspace = services.hub.get(record.id);
  const agent = workspace.createAgent({
    name: "Claude Code",
    role: "Coding assistant",
  });
  agentCounter = 0;
  return { services, workspace, agent, cancelled };
}

let agentCounter = 0;
/** Each run needs its own agent: one profile may hold only one active run. */
function makeRun(services, workspace, agent, { status = "running" } = {}) {
  const worker =
    agentCounter === 0
      ? agent
      : workspace.createAgent({
          name: `Claude Code ${agentCounter + 1}`,
          role: "Coding assistant",
        });
  agentCounter += 1;
  const run = services.recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: worker.id,
    mode: "managed",
    provider: "claude-code",
    createTask: { title: "Ops task", source: "managed" },
    status,
  });
  return run;
}

// ------------------------------------------------------------- incidents

test("stop-all sets the flag, refuses dispatch, and requests cancellation", async () => {
  const { services, workspace, agent, cancelled } = setup();
  const run = makeRun(services, workspace, agent);

  assert.equal(services.incidents.isDispatchStopped(), false);
  assert.doesNotThrow(() => assertDispatchAllowed(services));

  const stop = await services.incidents.stopAll({
    actor: "alice",
    reason: "prod incident",
  });
  assert.equal(stop.dispatchStopped, true);
  assert.equal(stop.stoppedBy, "alice");
  assert.equal(stop.reason, "prod incident");
  assert.deepEqual(cancelled, [run.id]);
  assert.equal(services.incidents.isDispatchStopped(), true);
  assert.equal(
    services.settings.get("ops.dispatchStopped", false),
    true,
    "the flag is persisted in settings so any component can read it",
  );

  assert.throws(
    () => assertDispatchAllowed(services),
    (error) =>
      error.status === 409 && /stopped by an operator/i.test(error.message),
  );

  services.incidents.resume({ actor: "alice" });
  assert.equal(services.incidents.isDispatchStopped(), false);
  assert.doesNotThrow(() => assertDispatchAllowed(services));

  const actions = services.audit.list({ limit: 20 }).map((e) => e.action);
  assert.ok(actions.includes("ops.stopAll"));
  assert.ok(actions.includes("ops.resume"));
  await services.close();
});

test("a stop stays unacknowledged until the run reaches a terminal status", async () => {
  const { services, workspace, agent } = setup();
  const run = makeRun(services, workspace, agent);
  services.runWorker.fail.add(run.id); // an offline worker never receives it

  const stop = await services.incidents.stopAll({ actor: "ops" });
  assert.equal(stop.cancellationFailed.length, 1);
  assert.equal(stop.unacknowledged.length, 1);
  assert.equal(stop.unacknowledged[0].runId, run.id);
  assert.equal(stop.unacknowledged[0].provider, "claude-code");
  assert.equal(stop.unacknowledged[0].status, "running");

  // Still unacknowledged on a later read.
  assert.equal(services.incidents.status().unacknowledged.length, 1);

  // Resuming dispatch does not acknowledge anything.
  services.incidents.resume({ actor: "ops" });
  assert.equal(services.incidents.status().unacknowledged.length, 1);

  services.recorder.setStatus(run.id, "completed", { summary: "done" });
  const after = services.incidents.status();
  assert.equal(after.unacknowledged.length, 0, "terminal status acknowledges");
  await services.close();
});

test("revoking a connection disables it and cancels its runs", async () => {
  const { services, workspace, agent, cancelled } = setup();
  const now = Date.now();
  services.db
    .prepare(
      `INSERT INTO connections (id, provider, alias, host, capabilities, created_at, status, enabled, observe, updated_at)
       VALUES (?, ?, ?, 'local', '{}', ?, 'ready', 1, 1, ?)`,
    )
    .run("conn-1", "claude-code", "default", now, now);
  const run = makeRun(services, workspace, agent);
  services.db
    .prepare("UPDATE runs SET connection_id = ? WHERE id = ?")
    .run("conn-1", run.id);

  const result = await services.incidents.revokeConnection("conn-1", {
    actor: "alice",
    reason: "token leaked",
  });
  assert.equal(result.enabled, false);
  assert.equal(result.observe, false);
  assert.deepEqual(result.cancelledRuns, [run.id]);
  assert.deepEqual(cancelled, [run.id]);
  assert.match(result.nextStep, /Rotate or sign out/);

  const row = services.db
    .prepare("SELECT enabled, observe FROM connections WHERE id = ?")
    .get("conn-1");
  assert.equal(row.enabled, 0);
  assert.equal(row.observe, 0);

  const status = services.incidents.status();
  assert.equal(status.revokedConnections[0].connectionId, "conn-1");
  assert.equal(status.revokedConnections[0].reason, "token leaked");
  assert.ok(
    services.audit
      .list({ limit: 20 })
      .some((entry) => entry.action === "ops.connection.revoke"),
  );
  await assert.rejects(
    services.incidents.revokeConnection("missing", { actor: "a" }),
    (error) => error.status === 404,
  );
  await services.close();
});

test("quarantining a runner marks the host unavailable and can release it", async () => {
  const { services } = setup();
  const result = services.incidents.quarantineRunner("build-01", {
    actor: "ops",
    reason: "disk failure",
  });
  assert.equal(result.quarantined, true);
  assert.equal(
    services.incidents.isQuarantined("BUILD-01"),
    true,
    "case-insensitive",
  );
  assert.equal(services.incidents.status().quarantinedHosts.length, 1);

  services.incidents.quarantineRunner("build-01", {
    actor: "ops",
    release: true,
  });
  assert.equal(services.incidents.isQuarantined("build-01"), false);
  assert.equal(services.incidents.status().quarantinedHosts.length, 0);
  assert.throws(() => services.incidents.quarantineRunner("  "));
  await services.close();
});

// ---------------------------------------------------------------- backup

test("backup and restore drill round trip with matching row counts", async () => {
  const dir = tempDir("agent-space-backup-");
  const dbPath = join(dir, "live", "agent-space.db");
  const { services, workspace, agent } = setup({ dbPath });
  makeRun(services, workspace, agent);
  services.audit.record({ actor: "ops", action: "seed" });

  const backups = new BackupService(services);
  const outPath = join(dir, "backup-1.db");
  const result = backups.backup({ outPath, actor: "ops" });
  assert.equal(result.path, outPath);
  assert.ok(result.bytes > 0);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.ok(result.manifest.counts.runs >= 1);
  assert.ok(result.manifest.schemaVersion >= 5);
  assert.ok(existsSync(result.manifestPath));

  // Backups never overwrite.
  assert.throws(
    () => backups.backup({ outPath }),
    (error) => error.status === 409,
  );

  // Restore refuses to write over the live database.
  assert.throws(
    () => backups.restore({ inPath: outPath, targetPath: dbPath }),
    (error) => error.status === 409 && /Stop Agent Space/i.test(error.message),
  );

  const restored = backups.restore({
    inPath: outPath,
    targetPath: join(dir, "restored.db"),
    actor: "ops",
  });
  assert.match(restored.message, /must be restarted/);
  const check = openDatabase(join(dir, "restored.db"));
  assert.equal(
    check.prepare("SELECT COUNT(*) AS n FROM runs").get().n,
    result.manifest.counts.runs,
  );
  check.close();

  const drill = backups.drill({ actor: "ops" });
  assert.equal(drill.ok, true, JSON.stringify(drill.mismatches));
  assert.equal(drill.mismatches.length, 0);
  assert.ok(drill.checked.runs.ok);
  assert.ok(drill.checked.audit_log.expected >= 1);
  assert.equal(typeof drill.durationMs, "number");
  assert.equal(
    existsSync(drill.directory),
    false,
    "drill cleans up after itself",
  );

  // The live database is untouched by the drill.
  assert.equal(
    services.db.prepare("SELECT COUNT(*) AS n FROM runs").get().n,
    result.manifest.counts.runs,
  );
  assert.ok(
    services.audit
      .list({ limit: 20 })
      .some((entry) => entry.action === "ops.restoreDrill"),
  );
  await services.close();
});

test("a corrupted backup fails hash validation and provider homes are refused", async () => {
  const dir = tempDir("agent-space-backup-bad-");
  const { services } = setup({ dbPath: join(dir, "live.db") });
  const backups = new BackupService(services, {
    env: { ...process.env, CLAUDE_CONFIG_DIR: join(dir, "claude-home") },
  });
  const outPath = join(dir, "backup.db");
  backups.backup({ outPath });

  const manifestPath = `${outPath}.manifest.json`;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.sha256 = "0".repeat(64);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  assert.throws(
    () => backups.restore({ inPath: outPath, targetPath: join(dir, "out.db") }),
    (error) => error.status === 409 && /hash mismatch/i.test(error.message),
  );

  assert.throws(
    () => backups.backup({ outPath: join(dir, "claude-home", "steal.db") }),
    (error) => error.status === 400 && /home directory/i.test(error.message),
  );
  await services.close();
});

// ---------------------------------------------------------------- health

test("health snapshot reports queue, db, and alerts with fixes", async () => {
  const dir = tempDir("agent-space-health-");
  const { services, workspace, agent } = setup({
    dbPath: join(dir, "live.db"),
  });
  makeRun(services, workspace, agent);
  makeRun(services, workspace, agent, { status: "queued" });

  const snapshot = services.health.snapshot();
  assert.ok(["ok", "degraded", "down"].includes(snapshot.status));
  assert.equal(snapshot.db.writable, true);
  assert.ok(snapshot.db.sizeBytes > 0);
  assert.equal(typeof snapshot.db.walBytes, "number");
  assert.ok(snapshot.schemaVersion >= 5);
  assert.equal(snapshot.queue.active, 1);
  assert.equal(snapshot.queue.queued, 1);
  assert.equal(snapshot.queue.byWorkspace[workspace.id], 2);
  assert.equal(snapshot.queue.byProvider["claude-code"], 2);
  assert.equal(typeof snapshot.observation.enabled, "boolean");
  assert.equal(snapshot.observation.running, false);
  assert.equal(snapshot.approvals.pending, 0);
  assert.equal(snapshot.approvals.oldestPendingMs, null);
  assert.ok(Array.isArray(snapshot.alerts));
  for (const alert of snapshot.alerts) {
    assert.ok(["info", "warn", "critical"].includes(alert.level));
    for (const field of ["code", "title", "detail", "fix"])
      assert.equal(typeof alert[field], "string");
  }
  await services.close();
});

test("health alerts on a stopped dispatch, a stale approval, and an open breaker", async () => {
  const { services, workspace, agent } = setup();
  const run = makeRun(services, workspace, agent);
  services.runWorker.fail.add(run.id);
  await services.incidents.stopAll({ actor: "ops", reason: "maintenance" });
  services.runWorker.providerHealth = () => ({
    "claude-code": { state: "open", failures: 5 },
  });
  services.approvals = {
    pending: () => [
      { id: "a1", requestedAt: Date.now() - THRESHOLDS.approvalAgeMs - 1000 },
    ],
  };
  services.budget = { headroom: () => ({ usedFraction: 0.95, limit: 100 }) };

  const snapshot = services.health.snapshot();
  const codes = snapshot.alerts.map((alert) => alert.code);
  assert.ok(codes.includes("ops.dispatch-stopped"));
  assert.ok(codes.includes("approvals.stale"));
  assert.ok(codes.includes("provider.circuit-open"));
  assert.ok(codes.includes("budget.near-limit"));
  assert.equal(snapshot.status, "degraded");
  assert.equal(snapshot.incident.dispatchStopped, true);
  assert.equal(snapshot.approvals.pending, 1);
  await services.close();
});

test("health degrades gracefully when services are missing", async () => {
  const { services } = setup();
  services.connections = undefined;
  services.approvals = undefined;
  services.observation = undefined;
  services.runWorker = undefined;
  services.budget = undefined;
  const snapshot = services.health.snapshot();
  assert.deepEqual(snapshot.providers.connections, []);
  assert.equal(snapshot.providers.breakers, null);
  assert.equal(snapshot.observation.enabled, false);
  assert.equal(snapshot.budget, null);
  assert.equal(snapshot.status, "ok");
  await services.close();
});

// ----------------------------------------------------------- diagnostics

test("the diagnostics bundle is redacted and lists what it removed", async () => {
  const dir = tempDir("agent-space-diag-");
  const { services, workspace, agent } = setup({
    dbPath: join(dir, "live.db"),
  });
  const run = makeRun(services, workspace, agent);
  const home = homedir();
  services.recorder.applyEvent(run.id, {
    kind: "file.edit",
    provenance: "provider",
    summary: "edited a secret file",
    tool: "Edit",
    file: join(home, "projects", "secret-plans.txt"),
    data: { prompt: "do not leak me", token: "sk-live-abcdef1234567890" },
    timestamp: Date.now(),
  });
  services.db
    .prepare(
      `INSERT INTO connections (id, provider, alias, host, capabilities, created_at, status, binary_path, auth_ref, enabled, observe, updated_at)
       VALUES (?, ?, 'default', 'local', '{}', ?, 'ready', ?, ?, 1, 1, ?)`,
    )
    .run(
      "conn-diag",
      "claude-code",
      Date.now(),
      join(home, ".local", "bin", "claude.exe"),
      "ghp_abcdefghijklmnopqrst",
      Date.now(),
    );
  services.audit.record({
    actor: "ops",
    action: "connection.probe",
    details: { authToken: "sk-live-abcdef1234567890" },
  });

  const diagnostics = new DiagnosticsService(services);
  const out = join(dir, "bundle");
  const bundle = diagnostics.bundle({ outPath: out, actor: "ops" });
  assert.equal(bundle.path, out);
  assert.equal(bundle.files.length, 2);
  assert.ok(bundle.redaction.length >= 5, "the report lists its redactions");

  const text = readFileSync(join(out, "summary.json"), "utf8");
  assert.ok(!text.includes(home), "the user home never appears verbatim");
  assert.ok(text.includes("<home>"), "home paths are masked");
  assert.ok(!text.includes("sk-live-abcdef1234567890"), "no api key");
  assert.ok(!text.includes("ghp_abcdefghijklmnopqrst"), "no github token");
  assert.ok(!text.includes("do not leak me"), "no prompt text");
  assert.ok(
    !text.includes("secret-plans.txt".slice(0, 0) + home),
    "no abs path",
  );

  const parsed = JSON.parse(text);
  assert.equal(parsed.kind, "agent-space-diagnostics");
  assert.equal(
    parsed.events[0].file,
    "secret-plans.txt",
    "paths are basenames",
  );
  assert.equal(parsed.events[0].data, undefined, "event payloads are dropped");
  assert.equal(parsed.connections[0].id, "conn-diag");
  assert.equal(parsed.connections[0].authRef, undefined);
  assert.equal(parsed.connections[0].authHint, undefined);
  assert.ok(parsed.schema.migrations.length >= 2);
  assert.ok(parsed.runtime.node.startsWith("v"));
  assert.ok(Array.isArray(parsed.redaction));

  const readme = readFileSync(join(out, "REDACTIONS.txt"), "utf8");
  assert.match(readme, /Removed from this bundle/);

  // A second bundle in the same folder is refused rather than silently merged.
  assert.throws(
    () => diagnostics.bundle({ outPath: out }),
    (error) => error.status === 409,
  );

  const withoutEvents = diagnostics.bundle({
    outPath: join(dir, "bundle-2"),
    includeEvents: false,
  });
  assert.equal(withoutEvents.summary.events.length, 0);
  assert.ok(
    withoutEvents.redaction.some((line) => /Events excluded/.test(line)),
  );
  await services.close();
});

// ------------------------------------------------------------- retention

test("retention policy validation", () => {
  const policy = validateRetention({ enabled: true, eventsDays: 30 });
  assert.equal(policy.enabled, true);
  assert.equal(policy.eventsDays, 30);
  assert.equal(policy.auditDays, 730, "unspecified fields keep the default");
  assert.equal(validateRetention({ runsDays: null }).runsDays, null);
  assert.throws(() => validateRetention({ eventsDays: 0 }));
  assert.throws(() => validateRetention({ eventsDays: 1.5 }));
  assert.throws(() => validateRetention({ enabled: "yes" }));
  assert.throws(() => validateRetention({ nope: 1 }));
  assert.throws(() => validateRetention(null));
});

test("preview counts what a sweep would delete without deleting it", async () => {
  const { services, workspace, agent } = setup();
  const now = Date.now();
  const old = now - 400 * DAY_MS;
  const finished = makeRun(services, workspace, agent);
  services.recorder.setStatus(finished.id, "completed", { summary: "done" });
  services.db
    .prepare("UPDATE runs SET started_at = ?, ended_at = ? WHERE id = ?")
    .run(old, old, finished.id);
  services.db
    .prepare("UPDATE tasks SET status = 'COMPLETED' WHERE id = ?")
    .run(finished.taskId);
  services.db
    .prepare("UPDATE events SET timestamp = ? WHERE run_id = ?")
    .run(old, finished.id);

  services.retention.setPolicy(
    {
      enabled: true,
      eventsDays: 30,
      runsDays: 90,
      auditDays: 30,
      artifactsDays: 30,
    },
    { actor: "ops" },
  );
  const before = services.db.prepare("SELECT COUNT(*) AS n FROM runs").get().n;
  const preview = services.retention.preview({ now });
  assert.ok(preview.counts.runs >= 1);
  assert.equal(
    services.db.prepare("SELECT COUNT(*) AS n FROM runs").get().n,
    before,
    "preview deletes nothing",
  );
  assert.equal(preview.policy.eventsDays, 30);
  await services.close();
});

test("a sweep never removes an active run or an unfinished task", async () => {
  const { services, workspace, agent } = setup();
  const now = Date.now();
  const old = now - 400 * DAY_MS;

  const active = makeRun(services, workspace, agent); // still running
  const openTask = makeRun(services, workspace, agent);
  services.recorder.setStatus(openTask.id, "completed", { summary: "done" });
  const done = makeRun(services, workspace, agent);
  services.recorder.setStatus(done.id, "completed", { summary: "done" });
  services.db
    .prepare("UPDATE tasks SET status = 'COMPLETED' WHERE id = ?")
    .run(done.taskId);

  // Age everything, including the run that is still running.
  services.db
    .prepare("UPDATE runs SET started_at = ?, ended_at = ?")
    .run(old, old);
  services.db.prepare("UPDATE events SET timestamp = ?").run(old);
  services.db.prepare("UPDATE audit_log SET timestamp = ?").run(old);

  services.retention.setPolicy(
    {
      enabled: true,
      eventsDays: 30,
      runsDays: 90,
      auditDays: 30,
      artifactsDays: 30,
    },
    { actor: "ops" },
  );
  const result = services.retention.sweep({ now, actor: "ops" });
  const remaining = services.db
    .prepare("SELECT id FROM runs")
    .all()
    .map((row) => row.id);
  assert.ok(remaining.includes(active.id), "an active run is never swept");
  assert.ok(
    remaining.includes(openTask.id),
    "a run whose task is not completed is never swept",
  );
  assert.ok(
    !remaining.includes(done.id),
    "a finished run past the cutoff goes",
  );
  assert.equal(result.counts.runs, 1);
  assert.ok(
    services.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE run_id = ?")
      .get(active.id).n > 0,
    "events of a protected run survive",
  );

  const sweepAudit = services.audit
    .list({ limit: 20 })
    .find((entry) => entry.action === "ops.retention.sweep");
  assert.ok(sweepAudit, "every sweep is audited");
  assert.equal(sweepAudit.details.deleted.runs, 1);
  assert.equal(
    services.audit.verify().ok,
    true,
    "the chain survives the sweep",
  );
  await services.close();
});

test("the scheduled sweep timer starts only when retention is enabled", async () => {
  const { services } = setup();
  const retention = new RetentionService(services, { intervalMs: 60000 });
  assert.equal(retention.start(), false, "disabled by default");
  retention.setPolicy({ enabled: true }, { actor: "ops" });
  assert.equal(retention.start(), true);
  assert.ok(retention.timer);
  retention.stop();
  assert.equal(retention.timer, null);
  await services.close();
});

// ---------------------------------------------------------------- routes

function routeCall(services, method, path, bodyValue = null, search = "") {
  const state = { status: 0, data: null, headers: {}, body: "" };
  const ctx = {
    method,
    path,
    query: new URLSearchParams(search),
    send: (status, data) => {
      state.status = status;
      state.data = data;
    },
    res: {
      writeHead: (status, headers) => {
        state.status = status;
        state.headers = headers;
      },
      end: (text) => {
        state.body = text;
      },
    },
    services,
    hub: services.hub,
    db: services.db,
    bus: services.bus,
    actor: "local-user",
    body: async () => bodyValue,
  };
  return { ctx, state };
}

test("routes: destructive operations require an explicit confirm", async () => {
  const { services, workspace, agent } = setup();
  const run = makeRun(services, workspace, agent);

  const unconfirmed = routeCall(services, "POST", "/api/ops/stop-all", {});
  await assert.rejects(
    opsRoutes(unconfirmed.ctx),
    (error) => error.status === 400 && /confirm/.test(error.message),
  );
  assert.equal(services.incidents.isDispatchStopped(), false);

  const confirmed = routeCall(services, "POST", "/api/ops/stop-all", {
    confirm: true,
    reason: "incident 42",
  });
  assert.equal(await opsRoutes(confirmed.ctx), true);
  assert.equal(confirmed.state.data.dispatchStopped, true);
  assert.deepEqual(confirmed.state.data.cancellationRequested, [run.id]);

  const probe = routeCall(services, "GET", "/api/ops/dispatch-allowed");
  await opsRoutes(probe.ctx);
  assert.equal(probe.state.data.allowed, false);

  const status = routeCall(services, "GET", "/api/ops/status");
  assert.equal(await opsRoutes(status.ctx), true);
  assert.equal(status.state.data.dispatchStopped, true);
  assert.equal(status.state.data.reason, "incident 42");
  assert.ok(status.state.data.retention);

  const resume = routeCall(services, "POST", "/api/ops/resume", {
    confirm: true,
  });
  assert.equal(await opsRoutes(resume.ctx), true);
  assert.equal(resume.state.data.dispatchStopped, false);

  const health = routeCall(services, "GET", "/api/ops/health");
  assert.equal(await opsRoutes(health.ctx), true);
  assert.ok(health.state.data.schemaVersion >= 5);

  const unknown = routeCall(services, "GET", "/api/workspaces");
  assert.equal(await opsRoutes(unknown.ctx), false);
  await services.close();
});

test("routes: retention, quarantine, backup, drill, and diagnostics", async () => {
  const dir = tempDir("agent-space-ops-routes-");
  const { services } = setup({ dbPath: join(dir, "live.db") });

  const get = routeCall(services, "GET", "/api/ops/retention");
  assert.equal(await opsRoutes(get.ctx), true);
  assert.equal(get.state.data.policy.enabled, false);

  const put = routeCall(services, "PUT", "/api/ops/retention", {
    enabled: true,
    eventsDays: 10,
  });
  assert.equal(await opsRoutes(put.ctx), true);
  assert.equal(put.state.data.policy.eventsDays, 10);

  const sweep = routeCall(services, "POST", "/api/ops/retention/sweep", {
    confirm: true,
    dryRun: true,
  });
  assert.equal(await opsRoutes(sweep.ctx), true);
  assert.equal(sweep.state.data.deleted, false);

  const quarantine = routeCall(services, "POST", "/api/ops/quarantine", {
    confirm: true,
    host: "runner-2",
    reason: "upgrading",
  });
  assert.equal(await opsRoutes(quarantine.ctx), true);
  assert.equal(quarantine.state.data.quarantined, true);

  const backup = routeCall(services, "POST", "/api/ops/backup", {
    confirm: true,
    outPath: join(dir, "route-backup.db"),
  });
  assert.equal(await opsRoutes(backup.ctx), true);
  assert.match(backup.state.data.sha256, /^[0-9a-f]{64}$/);

  const drill = routeCall(services, "POST", "/api/ops/restore-drill", {
    confirm: true,
  });
  assert.equal(await opsRoutes(drill.ctx), true);
  assert.equal(drill.state.data.ok, true);

  const diagnostics = routeCall(
    services,
    "GET",
    "/api/ops/diagnostics",
    null,
    `outPath=${encodeURIComponent(join(dir, "diag"))}&events=0`,
  );
  assert.equal(await opsRoutes(diagnostics.ctx), true);
  assert.equal(diagnostics.state.data.summary.events.length, 0);
  assert.ok(diagnostics.state.data.redaction.length > 0);

  const actions = services.audit.list({ limit: 50 }).map((e) => e.action);
  for (const action of [
    "ops.retention.update",
    "ops.runner.quarantine",
    "ops.backup",
    "ops.restoreDrill",
    "ops.diagnostics",
  ])
    assert.ok(actions.includes(action), `${action} is audited`);
  assert.equal(services.audit.verify().ok, true);
  await services.close();
});
