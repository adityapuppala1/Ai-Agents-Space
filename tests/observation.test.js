import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServices } from "../packages/core/src/services.js";
import { RunRecorder } from "../packages/core/src/runs/RunRecorder.js";
import {
  ObservationService,
  liveSessionsSummary,
  providerHome,
} from "../packages/core/src/observe/ObservationService.js";
import {
  ensureProviderAgent,
  isWithin,
  normalizePath,
  resolveWorkspaceForCwd,
  samePath,
} from "../packages/core/src/observe/mapping.js";
import sessionRoutes from "../packages/server/src/routes/sessions.js";

const WIN = process.platform === "win32";
const ROOT = WIN ? "C:\\work\\store" : "/work/store";
const SUB = WIN ? "C:\\work\\store\\apps\\web" : "/work/store/apps/web";
const OTHER = WIN ? "D:\\repos\\Toolkit" : "/repos/Toolkit";

/** Minimal observer double implementing the module B/C interface. */
function fakeObserver(provider) {
  const sessions = new Map();
  return {
    provider,
    sessions,
    add(session) {
      const record = {
        provider,
        live: true,
        events: [],
        offset: 0,
        ended: false,
        startedAt: 1000,
        updatedAt: 1000,
        ...session,
      };
      sessions.set(record.sessionId, record);
      return record;
    },
    push(sessionId, ...events) {
      sessions.get(sessionId).events.push(...events);
    },
    scanSessions() {
      return [...sessions.values()].map(({ events, offset, ended, ...s }) => s);
    },
    readEvents(session, offset) {
      const record = sessions.get(session.sessionId);
      const events = record.events.slice(offset);
      return { events, offset: record.events.length, ended: record.ended };
    },
    isLive(session) {
      return sessions.get(session.sessionId).live;
    },
  };
}

function ev(id, kind, extra = {}) {
  return {
    providerEventId: id,
    kind,
    summary: extra.summary ?? `${kind} ${id}`,
    timestamp: extra.timestamp ?? 9_900,
    provenance: "provider",
    ...extra,
  };
}

function setup(t, options = {}) {
  const services = createServices({ demo: true });
  services.recorder = new RunRecorder(services, { broadcastIntervalMs: 1 });
  const clock = { now: 10_000 };
  const observer = fakeObserver("claude-code");
  const service = new ObservationService(services, {
    observers: [observer, ...(options.observers ?? [])],
    now: () => clock.now,
    staleAfterMs: 1000,
    endAfterMs: 5000,
    log: { warn() {}, debug() {} },
    ...options.serviceOptions,
  });
  t.after(() => services.close());
  return { services, service, observer, clock };
}

test("path helpers normalize separators and case on win32", () => {
  assert.ok(isWithin(SUB, ROOT));
  assert.ok(isWithin(ROOT, ROOT));
  assert.ok(!isWithin(ROOT, SUB));
  assert.ok(!isWithin(OTHER, ROOT));
  if (WIN) {
    assert.ok(samePath("c:/work/store/", "C:\\Work\\Store"));
    assert.equal(normalizePath("C:/Work/Store/"), "c:\\work\\store");
  } else {
    assert.ok(samePath("/work/store/", "/work/store"));
  }
});

test("providerHome honours env overrides and defaults", () => {
  assert.equal(
    providerHome("claude-code", { CLAUDE_CONFIG_DIR: "X:\\cfg" }),
    "X:\\cfg",
  );
  assert.match(providerHome("codex", {}), /\.codex$/);
  assert.equal(providerHome("nope", {}), null);
});

test("poll auto-creates a workspace from the cwd and a provider agent", async (t) => {
  const { services, service, observer } = setup(t);
  observer.add({ sessionId: "s1", cwd: OTHER, title: "Fix login" });
  observer.push(
    "s1",
    ev("e1", "prompt", { summary: "Fix the login bug" }),
    ev("e2", "tool.start", { tool: "Edit", file: join(OTHER, "auth.js") }),
  );
  const result = await service.poll();
  assert.equal(result.sessions, 1);
  assert.equal(result.events, 2);

  const workspaces = services.hub.list();
  const created = workspaces.find((w) => w.name === "Toolkit");
  assert.ok(created, "workspace named after the folder");
  assert.equal(created.rootPath, OTHER);
  assert.equal(
    services.db
      .prepare("SELECT auto_created FROM workspaces WHERE id = ?")
      .get(created.id).auto_created,
    1,
  );
  const runtime = services.hub.get(created.id);
  const snapshot = runtime.snapshot();
  const agent = snapshot.agents.find((a) => a.name === "Claude Code");
  assert.ok(agent);
  assert.equal(agent.role, "Coding assistant");
  assert.equal(agent.color, "#d97757");
  assert.equal(
    services.db
      .prepare("SELECT provider, auto_created FROM agent_profiles WHERE id = ?")
      .get(agent.id).provider,
    "claude-code",
  );
  const task = snapshot.tasks.find((x) => x.source === "observed");
  assert.ok(task);
  assert.equal(task.title, "Fix login");
  assert.equal(task.assignedAgentId, agent.id);
  const run = services.recorder.find({
    provider: "claude-code",
    providerSessionId: "s1",
  });
  assert.equal(run.mode, "observed");
  assert.equal(run.status, "running");
  assert.equal(run.activity, "CODING");
  assert.equal(run.currentFile, join(OTHER, "auth.js"));

  const live = service.liveSessions();
  assert.equal(live.length, 1);
  assert.equal(live[0].id, "claude-code:s1");
  assert.equal(live[0].workspaceId, created.id);
  assert.equal(live[0].agentName, "Claude Code");
  assert.equal(live[0].runId, run.id);
  const summary = liveSessionsSummary(services);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].activity, "CODING");
  assert.equal(summary[0].workspaceName, "Toolkit");
  assert.equal(summary[0].live, true);
});

test("sessions inside an existing workspace root reuse it; deepest root wins", async (t) => {
  const { services, service, observer } = setup(t);
  const store = services.hub.create({ name: "Storefront", rootPath: ROOT });
  const web = services.hub.create({ name: "Web", rootPath: SUB });
  observer.add({ sessionId: "root", cwd: join(ROOT, "packages") });
  observer.add({ sessionId: "deep", cwd: join(SUB, "src") });
  await service.poll();
  const byId = Object.fromEntries(service.sessions().map((s) => [s.id, s]));
  assert.equal(byId["claude-code:root"].workspaceId, store.id);
  assert.equal(byId["claude-code:deep"].workspaceId, web.id);
  assert.equal(
    services.hub.list().filter((w) => w.kind === "project").length,
    2,
    "no extra workspaces were created",
  );
  const record = resolveWorkspaceForCwd(services, ROOT.toUpperCase());
  assert.equal(record.id, store.id);
});

test("without autoCreate sessions land in the Observed workspace, never demo", async (t) => {
  const { services, service, observer } = setup(t);
  services.settings = {
    get(key, fallback) {
      return key === "observation.autoCreateWorkspaces" ? false : fallback;
    },
  };
  observer.add({ sessionId: "x", cwd: OTHER });
  observer.add({ sessionId: "nocwd", cwd: null });
  await service.poll();
  for (const session of service.sessions()) {
    assert.equal(session.workspaceId, "observed");
  }
  const observed = services.hub.get("observed").record;
  assert.equal(observed.name, "Observed sessions");
  assert.equal(observed.kind, "project");
  const demo = services.hub.get("demo").snapshot();
  assert.ok(demo.tasks.every((task) => task.source === "demo"));
  assert.ok(demo.runs.every((run) => run.provider === "simulated"));
  assert.throws(
    () => ensureProviderAgent(services, "demo", "claude-code"),
    /demo workspace/,
  );
});

test("a second concurrent session gets 'Claude Code 2'; a free agent is reused later", async (t) => {
  const { services, service, observer, clock } = setup(t);
  const ws = services.hub.create({ name: "Storefront", rootPath: ROOT });
  observer.add({ sessionId: "a", cwd: ROOT });
  observer.add({ sessionId: "b", cwd: ROOT });
  await service.poll();
  const names = services.hub
    .get(ws.id)
    .snapshot()
    .agents.filter((a) => a.role === "Coding assistant")
    .map((a) => a.name)
    .sort();
  assert.deepEqual(names, ["Claude Code", "Claude Code 2"]);

  // Session a ends → its agent becomes free and is reused for session c.
  observer.sessions.get("a").ended = true;
  observer.sessions.get("a").live = false;
  await service.poll();
  clock.now += 10;
  observer.add({ sessionId: "c", cwd: ROOT });
  await service.poll();
  const agents = services.hub
    .get(ws.id)
    .snapshot()
    .agents.filter((a) => a.role === "Coding assistant");
  assert.equal(agents.length, 2, "no third agent created");
  const c = service.session("claude-code:c");
  assert.equal(c.agentName, "Claude Code");
});

test("events are deduplicated, offsets advance, and the title comes from the first prompt", async (t) => {
  const { services, service, observer } = setup(t);
  services.hub.create({ name: "Storefront", rootPath: ROOT });
  observer.add({ sessionId: "s", cwd: ROOT, title: "" });
  observer.push(
    "s",
    ev("p1", "prompt", {
      summary: "Please refactor the checkout flow so that it is faster",
      data: { text: "Please refactor the checkout flow so that it is faster" },
    }),
    ev("t1", "tool.start", { tool: "Bash", data: { command: "npm test" } }),
  );
  const first = await service.poll();
  assert.equal(first.events, 2);
  let session = service.session("claude-code:s");
  assert.equal(session.sourceOffset, 2);
  assert.equal(
    session.title,
    "Please refactor the checkout flow so that it is faster",
  );
  assert.equal(session.run.title, session.title);
  const task = services.hub
    .get(session.workspaceId)
    .store.get(session.run.taskId);
  assert.equal(task.title, session.title);

  // Force a replay from offset 0 → dedup keeps the stored events unique.
  services.db
    .prepare("UPDATE observed_sessions SET source_offset = 0 WHERE id = ?")
    .run("claude-code:s");
  const again = await service.poll();
  assert.equal(again.events, 0);
  const eventCount = services.db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE run_id = ?")
    .get(session.runId).n;
  assert.equal(eventCount, 3, "session.start + 2 provider events");

  observer.push(
    "s",
    ev("t2", "tool.end", { tool: "Bash", data: { command: "npm test" } }),
  );
  const third = await service.poll();
  assert.equal(third.events, 1);
  session = service.session("claude-code:s");
  assert.equal(session.sourceOffset, 3);
  assert.equal(session.run.activity, "TESTING");
});

test("runs go stale without events and return to running on new events; ended sessions complete", async (t) => {
  const { services, service, observer, clock } = setup(t);
  const ws = services.hub.create({ name: "Storefront", rootPath: ROOT });
  observer.add({ sessionId: "s", cwd: ROOT, startedAt: 9000, updatedAt: 9000 });
  observer.push("s", ev("e1", "message", { timestamp: 9500 }));
  await service.poll();
  let run = services.recorder.find({
    provider: "claude-code",
    providerSessionId: "s",
  });
  assert.equal(run.status, "running");

  clock.now = 12_000; // 2.5 s after the last event > staleAfterMs (1 s)
  await service.poll();
  run = services.recorder.get(run.id);
  assert.equal(run.status, "stale");
  assert.equal(run.activity, "STALE");

  observer.push(
    "s",
    ev("e2", "tool.start", { tool: "Read", timestamp: 12_000 }),
  );
  await service.poll();
  run = services.recorder.get(run.id);
  assert.equal(run.status, "running");
  assert.equal(run.activity, "RESEARCHING");

  observer.sessions.get("s").ended = true;
  observer.sessions.get("s").live = false;
  await service.poll();
  run = services.recorder.get(run.id);
  assert.equal(run.status, "completed");
  assert.ok(run.endedAt);
  const task = services.hub.get(ws.id).store.get(run.taskId);
  assert.equal(task.status, "COMPLETED");
  const session = service.session("claude-code:s");
  assert.equal(session.live, false);
  assert.ok(session.endedAt);
  assert.equal(service.liveSessions().length, 0);

  // Not live and silent for longer than endAfterMs also completes.
  observer.add({
    sessionId: "quiet",
    cwd: ROOT,
    startedAt: 12_000,
    updatedAt: 12_000,
  });
  await service.poll();
  observer.sessions.get("quiet").live = false;
  clock.now = 12_000 + 5001;
  await service.poll();
  const quiet = service.session("claude-code:quiet");
  assert.equal(quiet.run.status, "completed");
});

test("old sessions that are not live are stored as history without a run", async (t) => {
  const { services, service, observer, clock } = setup(t);
  services.hub.create({ name: "Storefront", rootPath: ROOT });
  clock.now = 100_000;
  observer.add({
    sessionId: "old",
    cwd: ROOT,
    live: false,
    startedAt: 1000,
    updatedAt: 2000,
  });
  await service.poll();
  const session = service.session("claude-code:old");
  assert.equal(session.runId, null);
  assert.equal(session.endedAt, 2000);
  assert.equal(session.status, "ended");
  assert.equal(service.sessions({ live: true }).length, 0);
  assert.equal(
    services.db
      .prepare("SELECT COUNT(*) AS n FROM runs WHERE mode = 'observed'")
      .get().n,
    0,
    "history rows never create runs",
  );
});

test("subagent sessions are skipped and observe=0 connections are honoured", async (t) => {
  const codex = fakeObserver("codex");
  const { services, service, observer } = setup(t, { observers: [codex] });
  services.hub.create({ name: "Storefront", rootPath: ROOT });
  observer.add({ sessionId: "main", cwd: ROOT });
  observer.add({ sessionId: "sub", cwd: ROOT, isSubagent: true });
  codex.add({ sessionId: "thread", cwd: ROOT });
  const rows = [
    { provider: "claude-code", observe: 1, enabled: 1 },
    { provider: "codex", observe: 0, enabled: 1 },
  ];
  const marks = [];
  services.connections = {
    list: () => rows,
    markEvent: (provider) => marks.push(provider),
  };
  observer.push("main", ev("m1", "message"));
  const result = await service.poll();
  assert.deepEqual(result.skipped, ["codex"]);
  const ids = service.sessions().map((s) => s.id);
  assert.deepEqual(ids, ["claude-code:main"]);
  assert.deepEqual(marks, ["claude-code"]);

  rows[1].observe = 1;
  await service.poll();
  assert.ok(service.sessions().some((s) => s.id === "codex:thread"));
  const codexAgent = services.hub
    .get(service.session("codex:thread").workspaceId)
    .snapshot()
    .agents.find((a) => a.name === "Codex");
  assert.equal(codexAgent.color, "#10a37f");
});

test("settings observation.enabled=false pauses polling", async (t) => {
  const { services, service, observer } = setup(t);
  let enabled = false;
  services.settings = {
    get: (key, fallback) =>
      key === "observation.enabled" ? enabled : fallback,
  };
  observer.add({ sessionId: "s", cwd: ROOT });
  const off = await service.poll();
  assert.equal(off.enabled, false);
  assert.equal(service.sessions().length, 0);
  assert.equal(service.status().enabled, false);
  enabled = true;
  const on = await service.poll();
  assert.equal(on.enabled, true);
  assert.equal(service.sessions().length, 1);
});

test("observer errors are caught per observer and reported in status", async (t) => {
  const broken = {
    provider: "gemini",
    scanSessions() {
      throw new Error("storage unreadable");
    },
    readEvents() {
      return { events: [], offset: 0, ended: false };
    },
    isLive() {
      return false;
    },
  };
  const { service, observer } = setup(t, { observers: [broken] });
  observer.add({ sessionId: "ok", cwd: ROOT });
  const result = await service.poll();
  assert.equal(result.sessions, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /storage unreadable/);
  const status = service.status();
  assert.deepEqual(status.observers, ["claude-code", "gemini"]);
  assert.equal(status.sessionCounts.live, 1);
  assert.ok(status.lastPollAt);
});

test("large backlogs start near the end and record a system notice", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-space-observe-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "transcript.jsonl");
  const line = JSON.stringify({ type: "x", pad: "y".repeat(90) }) + "\n";
  writeFileSync(file, line.repeat(50)); // ~5 KB
  const { services, service, observer } = setup(t, {
    serviceOptions: { initialBacklogBytes: 1024 },
  });
  services.hub.create({ name: "Storefront", rootPath: ROOT });
  let seenOffset = null;
  observer.readEvents = (session, offset) => {
    seenOffset = offset;
    return { events: [], offset, ended: false };
  };
  observer.add({ sessionId: "big", cwd: ROOT, sourcePath: file });
  await service.poll();
  assert.ok(seenOffset > 0 && seenOffset < 50 * line.length);
  assert.equal(seenOffset % line.length, 0, "offset is line-aligned");
  const session = service.session("claude-code:big");
  const events = services.recorder.events(session.runId);
  assert.ok(
    events.some((e) =>
      /Joined an existing session; earlier activity not replayed/.test(
        e.message,
      ),
    ),
  );
  assert.ok(events.every((e) => e.provenance !== "inferred"));
});

test("attach() re-maps a session to another workspace with a fresh run", async (t) => {
  const { services, service, observer } = setup(t);
  const a = services.hub.create({ name: "A", rootPath: ROOT });
  const b = services.hub.create({ name: "B", rootPath: OTHER });
  observer.add({ sessionId: "s", cwd: ROOT, title: "Move me" });
  observer.push("s", ev("e1", "message"));
  await service.poll();
  const before = service.session("claude-code:s");
  assert.equal(before.workspaceId, a.id);
  const oldRunId = before.runId;

  assert.throws(() => service.attach("claude-code:s", "demo"), /demo/);
  assert.throws(() => service.attach("claude-code:missing", b.id), /not found/);

  const after = service.attach("claude-code:s", b.id);
  assert.equal(after.workspaceId, b.id);
  assert.notEqual(after.runId, oldRunId);
  assert.equal(after.run.workspaceId, b.id);
  assert.equal(after.run.providerSessionId, "s");
  const old = services.recorder.get(oldRunId);
  assert.equal(old.status, "cancelled");
  assert.equal(old.providerSessionId, null);
  assert.equal(
    services.hub.get(a.id).store.get(old.taskId).status,
    "COMPLETED",
  );
  assert.ok(
    services.hub
      .get(b.id)
      .snapshot()
      .agents.some((x) => x.name === "Claude Code"),
  );

  // Later polls keep the manual mapping and feed the new run.
  observer.push("s", ev("e2", "tool.start", { tool: "Write", file: "x.js" }));
  await service.poll();
  const again = service.session("claude-code:s");
  assert.equal(again.workspaceId, b.id);
  assert.equal(again.runId, after.runId);
  assert.equal(again.run.activity, "CODING");
  assert.equal(services.recorder.get(oldRunId).status, "cancelled");
});

test("start() polls immediately and stop() clears the timer", async (t) => {
  const { service, observer } = setup(t, {
    serviceOptions: { intervalMs: 5 },
  });
  observer.add({ sessionId: "s", cwd: ROOT });
  service.start();
  assert.equal(service.running, true);
  await service.polling;
  assert.equal(service.sessions().length, 1);
  service.stop();
  assert.equal(service.running, false);
});

test("session routes serve sessions, status, poll, and attach", async (t) => {
  const { services, service, observer } = setup(t);
  services.observation = service;
  const b = services.hub.create({ name: "B", rootPath: OTHER });
  observer.add({ sessionId: "s", cwd: ROOT });
  const call = async (method, path, input) => {
    const url = new URL(path, "http://localhost");
    let out;
    const handled = await sessionRoutes({
      method,
      path: url.pathname,
      url,
      query: url.searchParams,
      send: (status, data) => (out = { status, data }),
      body: async () => input,
      services,
      hub: services.hub,
      db: services.db,
      bus: services.bus,
      actor: "test",
    });
    return { handled, ...out };
  };
  assert.equal((await call("GET", "/api/workspaces")).handled, false);
  const poll = await call("POST", "/api/observation/poll");
  assert.equal(poll.status, 200);
  assert.equal(poll.data.sessions, 1);
  const status = await call("GET", "/api/observation/status");
  assert.equal(status.data.enabled, true);
  assert.deepEqual(status.data.observers, ["claude-code"]);
  const list = await call("GET", "/api/sessions?live=1");
  assert.equal(list.data.length, 1);
  const one = await call("GET", "/api/sessions/claude-code%3As");
  assert.equal(one.status, 200);
  assert.equal(one.data.id, "claude-code:s");
  const attach = await call("POST", "/api/sessions/claude-code:s/attach", {
    workspaceId: b.id,
  });
  assert.equal(attach.status, 200);
  assert.equal(attach.data.workspaceId, b.id);
  await assert.rejects(call("GET", "/api/sessions/nope"), /not found/);
  services.observation = null;
  const missing = await call("GET", "/api/sessions");
  assert.equal(missing.status, 503);
});

test("observer cursors persist in session metadata and are handed back on the next poll", async (t) => {
  const seen = [];
  const observer = fakeObserver("claude-code");
  const base = observer.readEvents.bind(observer);
  observer.readEvents = (session, offset, options) => {
    seen.push(options);
    return {
      ...base(session, offset),
      cursor: { "subagents/agent-1.jsonl": seen.length * 10 },
    };
  };
  const { service } = setup(t, {
    observers: [observer],
    serviceOptions: { observers: [observer], initialBacklogBytes: 4096 },
  });
  observer.add({ sessionId: "s", cwd: ROOT });
  observer.push("s", ev("e1", "prompt", { summary: "hello" }));
  await service.poll();
  assert.deepEqual(seen[0], { cursor: null, initialBacklogBytes: 4096 });
  assert.deepEqual(service.session("claude-code:s").metadata.cursor, {
    "subagents/agent-1.jsonl": 10,
  });
  await service.poll();
  assert.deepEqual(seen[1].cursor, { "subagents/agent-1.jsonl": 10 });
  assert.deepEqual(service.session("claude-code:s").metadata.cursor, {
    "subagents/agent-1.jsonl": 20,
  });
  // Observers without a cursor leave the metadata untouched.
  observer.readEvents = base;
  await service.poll();
  assert.deepEqual(service.session("claude-code:s").metadata.cursor, {
    "subagents/agent-1.jsonl": 20,
  });
});

test("an idle session is ended by inference (labelled as such) and a resumed run revives its task", async (t) => {
  const { services, service, observer, clock } = setup(t);
  services.hub.create({ name: "Rollouts", rootPath: ROOT });
  observer.add({
    sessionId: "cx",
    cwd: ROOT,
    startedAt: 9000,
    updatedAt: 9000,
    live: false,
  });
  observer.push("cx", ev("c1", "turn.end", { timestamp: 9500 }));
  await service.poll();
  let run = services.recorder.find({
    provider: "claude-code",
    providerSessionId: "cx",
  });
  assert.equal(
    run.status,
    "running",
    "no provider end signal: the run stays open between turns",
  );
  clock.now = 9500 + 5001; // endAfterMs (5 s) past the last event
  await service.poll();
  run = services.recorder.get(run.id);
  assert.equal(run.status, "completed");
  assert.match(run.summary, /inferred/);
  assert.doesNotMatch(run.summary, /reported by the provider/);
  const store = services.hub.get(run.workspaceId).store;
  assert.equal(store.get(run.taskId).status, "COMPLETED");

  // The person types again: the session resumes with a live turn.
  observer.sessions.get("cx").live = true;
  observer.push(
    "cx",
    ev("c2", "command", { tool: "exec_command", timestamp: clock.now }),
  );
  await service.poll();
  run = services.recorder.get(run.id);
  assert.equal(run.status, "running");
  assert.equal(run.endedAt, null);
  assert.equal(store.get(run.taskId).status, "IN_PROGRESS");
  const agent = services.hub
    .get(run.workspaceId)
    .snapshot()
    .agents.find((a) => a.id === run.agentId);
  assert.equal(agent.taskId, run.taskId);
  assert.equal(agent.runId, run.id);
  assert.notEqual(agent.state, "IDLE");
  assert.equal(service.liveSessions().length, 1);
});
