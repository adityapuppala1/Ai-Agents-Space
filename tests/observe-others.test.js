import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createObserver as createCopilot } from "../packages/core/src/observe/copilot.js";
import {
  createObserver as createCursor,
  capabilityNote as cursorNote,
} from "../packages/core/src/observe/cursor.js";
import { createObserver as createGemini } from "../packages/core/src/observe/gemini.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(
  here,
  "fixtures",
  "providers",
  "copilot-headless-stream.jsonl",
);
const SESSION_ID = "9869997d-2b31-4869-ac28-363005a10279";
const CWD = "C:\\work\\probe\\copilot";

function tempHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agent-space-${prefix}-`));
}

const fixtureLines = fs
  .readFileSync(FIXTURE, "utf8")
  .split(/\r?\n/)
  .filter(Boolean);

const sessionStartLine = JSON.stringify({
  type: "session.start",
  data: {
    sessionId: SESSION_ID,
    version: 1,
    producer: "copilot-agent",
    copilotVersion: "1.0.80",
    context: { cwd: CWD },
  },
  id: "171f1b9c-dc33-43c1-ab2d-54b5142255c6",
  timestamp: "2026-09-09T14:54:06.035Z",
  parentId: null,
});

/** Writes a Copilot session-state dir with workspace.yaml + events.jsonl. */
function writeCopilotSession(
  home,
  { lines = fixtureLines, id = SESSION_ID } = {},
) {
  const dir = path.join(home, "session-state", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "workspace.yaml"),
    [
      `id: ${id}`,
      `cwd: ${CWD}`,
      "client_name: github/cli",
      "name: Read the file hello.txt in the current directory using a tool, then reply with exactly the word OK.",
      "user_named: false",
      "summary_count: 0",
      "created_at: 2026-09-09T14:54:06.000Z",
      "updated_at: 2026-09-09T14:54:10.143Z",
      "",
    ].join("\r\n"),
  );
  const events = path.join(dir, "events.jsonl");
  fs.writeFileSync(events, [sessionStartLine, ...lines].join("\n") + "\n");
  return { dir, events };
}

function setMtime(file, ms) {
  fs.utimesSync(file, new Date(ms), new Date(ms));
}

// ---------------------------------------------------------------------------
// Copilot
// ---------------------------------------------------------------------------

test("copilot: returns no sessions when the home does not exist", () => {
  const observer = createCopilot({
    home: path.join(tempHome("copilot-missing"), "nope"),
    now: () => 0,
    isPidAlive: () => false,
  });
  assert.equal(observer.provider, "copilot");
  assert.deepEqual(observer.scanSessions(), []);
  const read = observer.readEvents(
    { sessionId: "x", sourcePath: path.join(observer.home, "missing.jsonl") },
    0,
  );
  assert.deepEqual(read, { events: [], offset: 0, ended: false });
});

test("copilot: scanSessions reads workspace.yaml and merges session-store.db", () => {
  const home = tempHome("copilot");
  const { events } = writeCopilotSession(home);
  const mtime = Date.parse("2026-09-09T14:54:16.100Z");
  setMtime(events, mtime);

  const db = new DatabaseSync(path.join(home, "session-store.db"));
  db.exec(
    "CREATE TABLE sessions ( id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT, summary TEXT, created_at TEXT, updated_at TEXT )",
  );
  db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)").run(
    SESSION_ID,
    CWD,
    "octo/repo",
    "github",
    "main",
    "Read hello.txt",
    "2026-09-09T14:54:06.000Z",
    "2026-09-09T14:54:16.000Z",
  );
  db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)").run(
    "db-only-session",
    "C:\\work\\other",
    null,
    null,
    "feature/x",
    "Older session only in the store",
    "2026-09-01T10:00:00.000Z",
    "2026-09-01T10:05:00.000Z",
  );
  db.close();

  const observer = createCopilot({
    home,
    now: () => mtime + 10_000,
    isPidAlive: () => false,
  });
  const sessions = observer.scanSessions();
  assert.equal(sessions.length, 2);
  const [main, dbOnly] = sessions;
  assert.equal(main.provider, "copilot");
  assert.equal(main.sessionId, SESSION_ID);
  assert.equal(main.cwd, CWD);
  assert.match(main.title, /^Read the file hello\.txt/);
  assert.equal(main.entrypoint, "github/cli");
  assert.equal(main.sourcePath, events);
  assert.equal(main.startedAt, Date.parse("2026-09-09T14:54:06.000Z"));
  assert.ok(main.updatedAt >= Date.parse("2026-09-09T14:54:10.143Z"));
  assert.equal(main.gitBranch, "main");
  assert.equal(main.metadata.repository, "octo/repo");
  assert.equal(main.isSubagent, false);
  // Last event is `result` → ended even though the file is fresh.
  assert.equal(main.live, false);

  assert.equal(dbOnly.sessionId, "db-only-session");
  assert.equal(dbOnly.cwd, "C:\\work\\other");
  assert.equal(dbOnly.gitBranch, "feature/x");
  assert.equal(dbOnly.metadata.source, "session-store");
  assert.equal(dbOnly.live, false);
});

test("copilot: live when the events file is fresh and not ended, or a logged pid is alive", () => {
  const home = tempHome("copilot-live");
  // Drop the trailing result + assistant.idle so the last record is a usage checkpoint.
  const withoutResult = fixtureLines.filter(
    (line) =>
      !line.includes('"type":"result"') &&
      !line.includes('"type":"assistant.idle"'),
  );
  const { events } = writeCopilotSession(home, { lines: withoutResult });
  const mtime = Date.parse("2026-09-09T14:54:16.100Z");
  setMtime(events, mtime);

  const fresh = createCopilot({
    home,
    now: () => mtime + 30_000,
    isPidAlive: () => false,
  });
  const session = fresh.scanSessions()[0];
  assert.equal(session.live, true, "fresh file without result is live");
  assert.equal(fresh.isLive(session), true);

  const stale = createCopilot({
    home,
    now: () => mtime + 91_000,
    isPidAlive: () => false,
  });
  assert.equal(
    stale.scanSessions()[0].live,
    false,
    "older than 90 s → not live",
  );

  // assistant.idle as the last record means "waiting for input", not working.
  const idleHome = tempHome("copilot-idle");
  const idleFile = writeCopilotSession(idleHome, {
    lines: fixtureLines.filter((line) => !line.includes('"type":"result"')),
  }).events;
  setMtime(idleFile, mtime);
  const idle = createCopilot({
    home: idleHome,
    now: () => mtime + 30_000,
    isPidAlive: () => false,
  });
  assert.equal(
    idle.scanSessions()[0].live,
    false,
    "idle → not live without a pid",
  );

  // A process log naming the session with a live pid keeps it live.
  fs.mkdirSync(path.join(home, "logs"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "logs", "process-1788965645226-4242.log"),
    `2026-09-09T14:54:06.000Z [INFO] Starting session ${SESSION_ID}\n`,
  );
  fs.writeFileSync(
    path.join(home, "logs", "process-1788965645226-9999.log"),
    "2026-09-09T14:54:06.000Z [INFO] unrelated process\n",
  );
  const seenPids = [];
  const withPid = createCopilot({
    home,
    now: () => mtime + 60 * 60 * 1000,
    isPidAlive: (pid) => {
      seenPids.push(pid);
      return pid === 4242;
    },
  });
  const viaPid = withPid.scanSessions()[0];
  assert.equal(viaPid.live, true);
  assert.equal(viaPid.pid, 4242);
  assert.ok(seenPids.includes(4242));

  const deadPid = createCopilot({
    home,
    now: () => mtime + 60 * 60 * 1000,
    isPidAlive: () => false,
  });
  assert.equal(deadPid.scanSessions()[0].live, false);
  assert.equal(deadPid.scanSessions()[0].pid, null);
});

test("copilot: readEvents maps the headless stream vocabulary", () => {
  const home = tempHome("copilot-events");
  const { events: file } = writeCopilotSession(home);
  const observer = createCopilot({
    home,
    now: () => Date.parse("2026-09-09T14:54:20.000Z"),
    isPidAlive: () => false,
  });
  const [session] = observer.scanSessions();
  const { events, offset, ended } = observer.readEvents(session, 0);
  assert.equal(ended, true, "result event ends the session");
  assert.equal(offset, fs.statSync(file).size);
  assert.ok(events.length > 0);

  for (const event of events) {
    assert.equal(event.provider, "copilot");
    assert.equal(event.sessionId, SESSION_ID);
    assert.ok(event.providerEventId, "every event has a providerEventId");
    assert.ok(Number.isFinite(event.timestamp));
    assert.ok(typeof event.summary === "string" && event.summary.length <= 120);
    assert.ok(["provider", "user"].includes(event.provenance));
  }
  const ids = events.map((e) => e.providerEventId);
  assert.equal(new Set(ids).size, ids.length, "providerEventIds are unique");

  const kinds = events.map((e) => e.kind);
  for (const skipped of ["reasoning"]) assert.ok(!kinds.includes(skipped));
  assert.ok(
    !events.some((e) => /delta|idle|mcp|skills/.test(JSON.stringify(e.data))),
    "ephemeral/delta records are not emitted",
  );

  const start = events.find((e) => e.kind === "session.start");
  assert.equal(start.cwd, CWD);
  assert.equal(start.data.version, "1.0.80");
  assert.equal(start.providerEventId, "171f1b9c-dc33-43c1-ab2d-54b5142255c6");

  const prompt = events.find((e) => e.kind === "prompt");
  assert.equal(prompt.provenance, "user");
  assert.match(prompt.summary, /^Read the file hello\.txt/);
  assert.ok(
    prompt.providerEventId.startsWith("741f456d"),
    "prompt keeps the record id",
  );

  const autoMode = events.find(
    (e) => e.kind === "status" && /Auto mode/.test(e.summary),
  );
  assert.equal(autoMode.model, "claude-haiku-4.5");
  const modelCall = events.find(
    (e) => e.kind === "status" && /Calling model/.test(e.summary),
  );
  assert.equal(modelCall.model, "claude-haiku-4.5");

  const toolStarts = events.filter((e) => e.kind === "tool.start");
  assert.ok(
    toolStarts.length >= 2,
    "toolRequests and execution_start both map",
  );
  const exec = toolStarts.find((e) => e.data.requested !== true);
  assert.equal(exec.tool, "view");
  assert.ok(exec.file.endsWith("hello.txt"));
  assert.ok(
    exec.providerEventId.startsWith("36ff04fe"),
    "tool.start keeps the record id",
  );
  assert.equal(exec.model, "claude-haiku-4.5");
  const requested = toolStarts.find((e) => e.data.requested === true);
  assert.equal(requested.tool, "view");
  assert.equal(requested.data.toolCallId, "toolu_014NmnsXJ5b5LMeaW6Q4cvcs");

  const read = events.find((e) => e.kind === "file.read");
  assert.equal(read.tool, "view");
  assert.ok(read.file.endsWith("hello.txt"));

  const end = events.find((e) => e.kind === "tool.end");
  assert.equal(end.tool, "view");
  assert.ok(end.file.endsWith("hello.txt"));
  assert.equal(end.data.success, true);
  assert.equal(end.data.toolCallId, "toolu_014NmnsXJ5b5LMeaW6Q4cvcs");

  const messages = events.filter((e) => e.kind === "message");
  assert.equal(
    messages.length,
    1,
    "empty assistant.message content is not a message",
  );
  assert.equal(messages[0].summary, "OK");
  assert.equal(messages[0].model, "claude-haiku-4.5");

  assert.equal(events.filter((e) => e.kind === "turn.start").length, 2);
  assert.equal(events.filter((e) => e.kind === "turn.end").length, 2);

  const usages = events.filter((e) => e.kind === "usage");
  assert.equal(usages.length, 2, "usage_checkpoint and result.usage");
  const checkpoint = usages.find((e) => e.data.checkpoint === true);
  assert.equal(checkpoint.usage, null, "running totals are never summed");
  assert.equal(checkpoint.data.totalPremiumRequests, 0.33);
  const resultUsage = usages.find((e) => e.usage?.premiumRequests != null);
  assert.equal(resultUsage.usage.premiumRequests, 0.33);
  assert.equal(resultUsage.usage.sessionDurationMs, 10013);
  assert.deepEqual(resultUsage.usage.codeChanges.filesModified, []);
  assert.ok(
    resultUsage.providerEventId.startsWith(`${file}:`),
    "result has no id → path:offset",
  );

  const sessionEnd = events.find((e) => e.kind === "session.end");
  assert.equal(sessionEnd.data.exitCode, 0);
  assert.equal(events[events.length - 1].kind, "session.end");
});

test("copilot: failed tool completion becomes an error event and commands classify", () => {
  const observer = createCopilot({
    home: tempHome("copilot-map"),
    now: () => 1000,
    isPidAlive: () => false,
  });
  const session = { sessionId: "s1", cwd: CWD };
  const { mapRecord } = observer._internal;
  const start = mapRecord(
    {
      type: "tool.execution_start",
      id: "a1",
      timestamp: "2026-09-09T14:54:14.629Z",
      data: {
        toolCallId: "call-1",
        toolName: "powershell",
        arguments: { command: "npm test" },
        turnId: "0",
      },
    },
    session,
    "fallback",
  );
  assert.deepEqual(
    start.map((e) => e.kind),
    ["tool.start", "test"],
  );
  assert.equal(start[1].tool, "powershell");
  assert.equal(start[1].data.command, "npm test");
  const done = mapRecord(
    {
      type: "tool.execution_complete",
      id: "a2",
      timestamp: "2026-09-09T14:54:15.000Z",
      data: {
        toolCallId: "call-1",
        success: false,
        result: { content: "Exit code 1: tests failed" },
      },
    },
    session,
    "fallback",
  );
  assert.equal(done.length, 1);
  assert.equal(done[0].kind, "error");
  assert.equal(done[0].tool, "powershell");
  assert.match(done[0].summary, /powershell failed/);

  const edit = mapRecord(
    {
      type: "tool.execution_start",
      id: "a3",
      timestamp: "2026-09-09T14:54:16.000Z",
      data: {
        toolCallId: "call-2",
        toolName: "edit",
        arguments: { path: "C:/work/a.js" },
      },
    },
    session,
    "fallback",
  );
  assert.equal(edit[1].kind, "file.edit");
  assert.equal(edit[1].file, path.normalize("C:/work/a.js"));
  const grep = mapRecord(
    {
      type: "tool.execution_start",
      id: "a4",
      timestamp: "2026-09-09T14:54:16.000Z",
      data: {
        toolCallId: "call-3",
        toolName: "grep",
        arguments: { pattern: "foo" },
      },
    },
    session,
    "fallback",
  );
  assert.equal(grep[1].kind, "search");
  const fetch = mapRecord(
    {
      type: "tool.execution_start",
      id: "a5",
      timestamp: "2026-09-09T14:54:16.000Z",
      data: {
        toolCallId: "call-4",
        toolName: "web_fetch",
        arguments: { url: "https://x" },
      },
    },
    session,
    "fallback",
  );
  assert.equal(fetch[1].kind, "web");
  const mcp = mapRecord(
    {
      type: "tool.execution_start",
      id: "a6",
      timestamp: "2026-09-09T14:54:16.000Z",
      data: {
        toolCallId: "call-5",
        toolName: "github-mcp-server-list_issues",
        arguments: {},
      },
    },
    session,
    "fallback",
  );
  assert.deepEqual(
    mcp.map((e) => e.kind),
    ["tool.start"],
  );

  assert.deepEqual(
    mapRecord(
      { type: "assistant.reasoning_delta", id: "z", data: {} },
      session,
      "f",
    ),
    [],
  );
  assert.deepEqual(
    mapRecord(
      { type: "assistant.idle", id: "z", ephemeral: true, data: {} },
      session,
      "f",
    ),
    [],
  );
  const failedResult = mapRecord(
    { type: "result", timestamp: "2026-09-09T14:54:16.004Z", exitCode: 2 },
    session,
    "C:\\x\\events.jsonl:10",
  );
  assert.equal(failedResult.length, 1);
  assert.equal(failedResult[0].kind, "error");
  assert.equal(failedResult[0].providerEventId, "C:\\x\\events.jsonl:10");
});

test("copilot: readEvents is incremental and tolerates a partial trailing line", () => {
  const home = tempHome("copilot-incremental");
  const half = Math.floor(fixtureLines.length / 2);
  const { events: file } = writeCopilotSession(home, {
    lines: fixtureLines.slice(0, half),
  });
  const observer = createCopilot({
    home,
    now: () => Date.now(),
    isPidAlive: () => false,
  });
  const [session] = observer.scanSessions();

  const first = observer.readEvents(session, 0);
  assert.equal(first.ended, false);
  assert.equal(first.offset, fs.statSync(file).size);
  const firstCount = first.events.length;
  assert.ok(firstCount > 0);

  // Nothing new → nothing returned, offset unchanged.
  const again = observer.readEvents(session, first.offset);
  assert.deepEqual(again, { events: [], offset: first.offset, ended: false });

  // Append the rest, but leave the last line without its newline.
  const rest = fixtureLines.slice(half);
  const lastLine = rest[rest.length - 1];
  fs.appendFileSync(file, rest.slice(0, -1).join("\n") + "\n");
  const partial = lastLine.slice(0, 40);
  fs.appendFileSync(file, partial);
  const second = observer.readEvents(session, first.offset);
  assert.ok(second.events.length > 0);
  assert.equal(
    second.offset,
    fs.statSync(file).size - Buffer.byteLength(partial),
    "partial trailing line is not consumed",
  );
  assert.equal(second.ended, false, "result line not complete yet");

  fs.appendFileSync(file, lastLine.slice(40) + "\n");
  const third = observer.readEvents(session, second.offset);
  assert.equal(third.offset, fs.statSync(file).size);
  assert.equal(third.ended, true);
  assert.ok(third.events.some((e) => e.kind === "session.end"));

  // All ids across the three reads are unique (safe for RunRecorder dedup).
  const ids = [...first.events, ...second.events, ...third.events].map(
    (e) => e.providerEventId,
  );
  assert.equal(new Set(ids).size, ids.length);

  // Corrupt/non-JSON noise is skipped without stalling the offset.
  fs.appendFileSync(file, "not json at all\r\n");
  const fourth = observer.readEvents(session, third.offset);
  assert.equal(fourth.events.length, 0);
  assert.equal(fourth.offset, fs.statSync(file).size);
  assert.equal(fourth.ended, true, "last parsable event is still result");
});

test("copilot: parseFlatYaml handles quotes, CRLF, and typed scalars", () => {
  const { parseFlatYaml } = createCopilot({ home: tempHome("yaml") })._internal;
  const parsed = parseFlatYaml(
    'id: abc\r\ncwd: "C:\\\\work\\\\x"\r\nuser_named: false\r\nsummary_count: 2\r\ngit_root: ~\r\n# comment\r\nname: a: b\r\n',
  );
  assert.equal(parsed.id, "abc");
  assert.equal(parsed.cwd, "C:\\\\work\\\\x");
  assert.equal(parsed.user_named, false);
  assert.equal(parsed.summary_count, 2);
  assert.equal(parsed.git_root, null);
  assert.equal(parsed.name, "a: b");
});

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

test("cursor: absent storage → not installed, no sessions, no events", () => {
  const root = tempHome("cursor-missing");
  const observer = createCursor({
    home: path.join(root, ".cursor"),
    appData: path.join(root, "AppData"),
    env: {},
  });
  assert.equal(observer.provider, "cursor");
  const sessions = observer.scanSessions();
  assert.deepEqual([...sessions], []);
  assert.equal(sessions.metadata.installed, false);
  assert.equal(sessions.metadata.experimental, true);
  assert.equal(sessions.metadata.cliRequired, "cursor-agent");
  assert.equal(observer.status().capabilities.observe, "experimental");
  assert.match(cursorNote, /cursor-agent/);
  assert.deepEqual(observer.readEvents({ sessionId: "x" }, 5), {
    events: [],
    offset: 5,
    ended: true,
  });
  assert.equal(observer.isLive({ sessionId: "x" }), false);
});

test("cursor: reads conversation_summaries read-only and labels everything experimental", () => {
  const root = tempHome("cursor");
  const home = path.join(root, ".cursor");
  fs.mkdirSync(path.join(home, "ai-tracking"), { recursive: true });
  const dbPath = path.join(home, "ai-tracking", "ai-code-tracking.db");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE conversation_summaries ( conversationId TEXT PRIMARY KEY, title TEXT, tldr TEXT, overview TEXT, summaryBullets TEXT, model TEXT, mode TEXT, updatedAt INTEGER NOT NULL )",
  );
  db.prepare("INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?)").run(
    "conv-1",
    "Fix login bug",
    "Fixed it",
    null,
    null,
    "gpt-5",
    "agent",
    1_760_000_000_000,
  );
  db.close();
  const before = fs.statSync(dbPath).mtimeMs;

  const observer = createCursor({
    home,
    appData: path.join(root, "AppData"),
    env: {},
  });
  const sessions = observer.scanSessions();
  assert.equal(sessions.metadata.installed, true);
  assert.equal(sessions.length, 1);
  const [session] = sessions;
  assert.equal(session.provider, "cursor");
  assert.equal(session.sessionId, "conv-1");
  assert.equal(session.title, "Fix login bug");
  assert.equal(session.model, "gpt-5");
  assert.equal(session.live, false);
  assert.equal(session.updatedAt, 1_760_000_000_000);
  assert.equal(session.metadata.experimental, true);
  assert.equal(session.sourcePath, dbPath);
  assert.deepEqual(observer.readEvents(session, 0), {
    events: [],
    offset: 0,
    ended: true,
  });
  assert.equal(
    fs.statSync(dbPath).mtimeMs,
    before,
    "database is never written",
  );

  // Installation detected via IDE storage even without ~/.cursor.
  const ideRoot = tempHome("cursor-ide");
  fs.mkdirSync(
    path.join(ideRoot, "AppData", "Cursor", "User", "globalStorage"),
    {
      recursive: true,
    },
  );
  fs.writeFileSync(
    path.join(
      ideRoot,
      "AppData",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    ),
    "",
  );
  const ideOnly = createCursor({
    home: path.join(ideRoot, ".cursor"),
    appData: path.join(ideRoot, "AppData"),
    env: {},
  });
  assert.equal(ideOnly.status().installed, true);
  assert.deepEqual([...ideOnly.scanSessions()], []);
});

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

test("gemini: absent storage → empty; Antigravity detected as unsupported", () => {
  const home = path.join(tempHome("gemini-missing"), ".gemini");
  const observer = createGemini({ home, env: {}, now: () => 0 });
  assert.equal(observer.provider, "gemini");
  let sessions = observer.scanSessions();
  assert.deepEqual([...sessions], []);
  assert.equal(sessions.metadata.installed, false);
  assert.equal(sessions.metadata.antigravity.detected, false);
  assert.equal(sessions.metadata.unverified, true);

  fs.mkdirSync(path.join(home, "antigravity", "conversations"), {
    recursive: true,
  });
  sessions = observer.scanSessions();
  assert.deepEqual(
    [...sessions],
    [],
    "Antigravity data never becomes sessions",
  );
  assert.equal(sessions.metadata.antigravity.detected, true);
  assert.equal(sessions.metadata.antigravity.supported, false);
  assert.equal(sessions.metadata.installed, false);
  assert.deepEqual(
    observer.readEvents({ sessionId: "x", sourcePath: null }, 3),
    {
      events: [],
      offset: 3,
      ended: false,
    },
  );
});

test("gemini: parses a minimal chats json defensively and maps parts to events", () => {
  const home = path.join(tempHome("gemini"), ".gemini");
  const chats = path.join(home, "tmp", "abc123hash", "chats");
  fs.mkdirSync(chats, { recursive: true });
  const file = path.join(chats, "session-2026-09-09T14-00-deadbeef.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      sessionId: "gem-1",
      projectHash: "abc123hash",
      startTime: "2026-09-09T14:00:00.000Z",
      lastUpdated: "2026-09-09T14:01:00.000Z",
      messages: [
        {
          id: "m1",
          role: "user",
          timestamp: "2026-09-09T14:00:00.000Z",
          parts: [{ text: "Read README.md and summarize it" }],
        },
        {
          id: "m2",
          role: "model",
          model: "gemini-2.5-pro",
          timestamp: "2026-09-09T14:00:05.000Z",
          parts: [
            { text: "Sure, reading it now." },
            {
              functionCall: {
                name: "read_file",
                args: { file_path: "C:/proj/README.md" },
              },
            },
          ],
          tokens: { input: 120, output: 30, total: 150 },
        },
        {
          role: "user",
          timestamp: "2026-09-09T14:00:06.000Z",
          parts: [
            {
              functionResponse: {
                name: "read_file",
                response: { output: "# Hi" },
              },
            },
          ],
        },
        {
          type: "gemini",
          timestamp: "2026-09-09T14:00:09.000Z",
          content: "It says hi.",
          toolCalls: [
            {
              id: "call-9",
              name: "run_shell_command",
              args: { command: "npm test" },
              status: "success",
              result: "ok",
            },
          ],
        },
      ],
    }),
  );
  setMtime(file, Date.parse("2026-09-09T14:01:00.000Z"));

  const observer = createGemini({
    home,
    env: {},
    now: () => Date.parse("2026-09-09T14:01:30.000Z"),
  });
  const sessions = observer.scanSessions();
  assert.equal(sessions.metadata.installed, true);
  assert.equal(sessions.length, 1);
  const [session] = sessions;
  assert.equal(session.sessionId, "gem-1");
  assert.equal(session.title, "Read README.md and summarize it");
  assert.equal(session.startedAt, Date.parse("2026-09-09T14:00:00.000Z"));
  assert.equal(session.updatedAt, Date.parse("2026-09-09T14:01:00.000Z"));
  assert.equal(session.model, "gemini-2.5-pro");
  assert.equal(session.metadata.unverified, true);
  assert.equal(session.metadata.projectHash, "abc123hash");
  assert.equal(session.live, true, "modified 30 s ago → inferred live");

  const { events, offset, ended } = observer.readEvents(session, 0);
  assert.equal(offset, 4);
  assert.equal(ended, false);
  for (const event of events) {
    assert.equal(event.provider, "gemini");
    assert.equal(event.sessionId, "gem-1");
    assert.equal(event.data.unverified, true);
    assert.ok(event.providerEventId);
  }
  const ids = events.map((e) => e.providerEventId);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    events.map((e) => e.kind),
    [
      "prompt",
      "message",
      "tool.start",
      "file.read",
      "usage",
      "tool.end",
      "message",
      "tool.start",
      "test",
      "tool.end",
    ],
  );
  assert.equal(events[0].provenance, "user");
  assert.equal(events[1].model, "gemini-2.5-pro");
  assert.equal(events[2].tool, "read_file");
  assert.equal(events[2].file, path.normalize("C:/proj/README.md"));
  assert.equal(events[2].activity, "RESEARCHING");
  assert.deepEqual(events[4].usage, { input: 120, output: 30, total: 150 });
  assert.equal(events[6].summary, "It says hi.");
  assert.equal(events[7].data.toolCallId, "call-9");
  assert.equal(events[8].activity, "TESTING");

  // Incremental: offset is the message index; nothing new → nothing returned.
  const again = observer.readEvents(session, offset);
  assert.deepEqual(again.events, []);
  assert.equal(again.offset, 4);

  // Stale file → not live and ended.
  const later = createGemini({
    home,
    env: {},
    now: () => Date.parse("2026-09-09T15:00:00.000Z"),
  });
  assert.equal(later.scanSessions()[0].live, false);
  assert.equal(later.readEvents(session, 4).ended, true);
});

test("gemini: logs.json prompts become sessions when no chat file exists; bare arrays parse", () => {
  const home = path.join(tempHome("gemini-logs"), ".gemini");
  const project = path.join(home, "tmp", "hash2");
  fs.mkdirSync(path.join(project, "chats"), { recursive: true });
  fs.writeFileSync(
    path.join(project, "logs.json"),
    JSON.stringify([
      {
        sessionId: "log-1",
        messageId: 0,
        type: "user",
        message: "first prompt",
        timestamp: "2026-09-09T10:00:00.000Z",
      },
      {
        sessionId: "log-1",
        messageId: 1,
        type: "user",
        message: "second prompt",
        timestamp: "2026-09-09T10:01:00.000Z",
      },
      {
        sessionId: "arr-1",
        messageId: 0,
        type: "user",
        message: "covered by chat",
        timestamp: "2026-09-09T10:02:00.000Z",
      },
    ]),
  );
  fs.writeFileSync(
    path.join(project, "chats", "arr-1.json"),
    JSON.stringify([
      { role: "user", parts: [{ text: "hello" }] },
      { role: "model", parts: [{ text: "hi" }] },
    ]),
  );
  fs.writeFileSync(path.join(project, "chats", "broken.json"), "{ not json");

  const observer = createGemini({ home, env: {}, now: () => 0 });
  const sessions = observer.scanSessions();
  assert.deepEqual(sessions.map((s) => s.sessionId).sort(), ["arr-1", "log-1"]);
  const logSession = sessions.find((s) => s.sessionId === "log-1");
  assert.equal(logSession.metadata.source, "logs.json");
  assert.equal(logSession.title, "first prompt");
  const logRead = observer.readEvents(logSession, 0);
  assert.deepEqual(
    logRead.events.map((e) => [e.kind, e.summary]),
    [
      ["prompt", "first prompt"],
      ["prompt", "second prompt"],
    ],
  );
  assert.equal(logRead.offset, 3);

  const arr = sessions.find((s) => s.sessionId === "arr-1");
  assert.equal(arr.metadata.source, "chats");
  const arrRead = observer.readEvents(arr, 0);
  assert.deepEqual(
    arrRead.events.map((e) => e.kind),
    ["prompt", "message"],
  );
});
