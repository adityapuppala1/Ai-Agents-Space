import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  createObserver,
  filesFromPatch,
  readStateDb,
} from "../packages/core/src/observe/codex.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures", "providers");
const THREAD_ID = "01a07fc8-378b-7e10-ae86-9cac64bb6077";
const GUARDIAN_ID = "0f0f0f0f-1111-7e10-ae86-9cac64bb6077";
const ROLLOUT_NAME = `rollout-2026-09-08T06-53-49-${THREAD_ID}.jsonl`;

function line(record) {
  return JSON.stringify(record) + "\n";
}

/** Builds a fake ~/.codex laid out exactly like the real one. */
function makeHome({ index = true, guardian = true, stateDb = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-space-codex-"));
  const dayDir = path.join(home, "sessions", "2026", "09", "08");
  fs.mkdirSync(dayDir, { recursive: true });
  const rollout = path.join(dayDir, ROLLOUT_NAME);
  fs.copyFileSync(path.join(fixtures, "codex-rollout.jsonl"), rollout);
  let guardianPath = null;
  if (guardian) {
    guardianPath = path.join(
      dayDir,
      `rollout-2026-09-08T07-00-00-${GUARDIAN_ID}.jsonl`,
    );
    fs.writeFileSync(
      guardianPath,
      [
        line({
          timestamp: "2026-09-08T07:00:00.000Z",
          ordinal: 0,
          type: "session_meta",
          payload: {
            id: GUARDIAN_ID,
            cwd: "C:\\xampp\\htdocs\\example-suite\\ExampleApp",
            originator: "Codex Desktop",
            cli_version: "0.153.4",
            source: { subagent: { kind: "review" } },
            thread_source: "guardian_review",
            model_provider: "openai",
          },
        }),
        line({
          timestamp: "2026-09-08T07:00:01.000Z",
          ordinal: 1,
          type: "event_msg",
          payload: { type: "task_started", turn_id: "g-1" },
        }),
      ].join(""),
    );
  }
  if (index) {
    fs.writeFileSync(
      path.join(home, "session_index.jsonl"),
      line({
        id: THREAD_ID,
        thread_name: "Resolve merge conflicts after pulling main",
        updated_at: "2026-09-08T08:35:10.352Z",
      }),
    );
  }
  if (stateDb) {
    const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
    db.exec(`CREATE TABLE threads (
      id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER,
      source TEXT, model_provider TEXT, cwd TEXT, title TEXT, sandbox_policy TEXT,
      approval_mode TEXT, tokens_used INTEGER, has_user_event INTEGER, archived INTEGER,
      archived_at INTEGER)`);
    db.prepare(
      "INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, approval_mode, tokens_used, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      THREAD_ID,
      rollout,
      1788850223,
      1788856510,
      "vscode",
      "openai",
      "C:\\xampp\\htdocs\\example-suite\\ExampleApp",
      "Title from state db",
      "on-request",
      4242,
      0,
    );
    db.close();
  }
  // auth.json must never be read; its presence must not break anything.
  fs.writeFileSync(path.join(home, "auth.json"), '{"token":"SECRET"}');
  return { home, rollout, guardianPath, dayDir };
}

test("filesFromPatch extracts every file header from an apply_patch input", () => {
  const files = filesFromPatch(
    [
      "*** Begin Patch",
      "*** Add File: database/seeds/_demo/master_seed.sql",
      "+-- content",
      "*** Update File: src/app.js",
      "@@ -1 +1 @@",
      "*** Delete File: old.txt",
      "*** End Patch",
    ].join("\n"),
  );
  assert.deepEqual(files, [
    { action: "add", path: "database/seeds/_demo/master_seed.sql" },
    { action: "update", path: "src/app.js" },
    { action: "delete", path: "old.txt" },
  ]);
  assert.deepEqual(filesFromPatch(null), []);
});

test("scanSessions discovers rollouts, titles from the index, and flags guardian sessions", () => {
  const { home, rollout, guardianPath } = makeHome();
  const observer = createObserver({ home, env: {}, now: () => Date.now() });
  assert.equal(observer.provider, "codex");
  const sessions = observer.scanSessions();
  assert.equal(sessions.length, 2);
  const main = sessions.find((s) => s.sessionId === THREAD_ID);
  assert.ok(main);
  assert.equal(main.provider, "codex");
  assert.equal(main.sourcePath, rollout);
  assert.equal(main.cwd, "C:\\xampp\\htdocs\\example-suite\\ExampleApp");
  assert.equal(main.title, "Resolve merge conflicts after pulling main");
  assert.equal(main.startedAt, Date.parse("2026-09-08T06:50:23.142Z"));
  assert.ok(main.updatedAt >= Date.parse("2026-09-08T08:35:10.352Z"));
  assert.equal(main.model, "gpt-5.6-sol");
  assert.equal(main.isSubagent, false);
  assert.equal(main.entrypoint, "Codex Desktop");
  assert.equal(main.cliVersion, "0.153.4");
  assert.equal(main.pid, null);
  assert.equal(
    main.live,
    false,
    "fixture mtime is old and last turn completed",
  );
  assert.equal(main.usageTotal.total_tokens, 31415);

  const guardian = sessions.find((s) => s.sessionId === GUARDIAN_ID);
  assert.ok(guardian);
  assert.equal(guardian.sourcePath, guardianPath);
  assert.equal(guardian.isSubagent, true);
  assert.equal(guardian.threadSource, "guardian_review");
  assert.equal(guardian.title, "Codex guardian review");
});

test("title falls back to the state db, then the first prompt; unreadable db is ignored", () => {
  const { home } = makeHome({ index: false, guardian: false, stateDb: true });
  const observer = createObserver({ home, env: {} });
  const [session] = observer.scanSessions();
  assert.equal(session.title, "Title from state db");
  assert.equal(session.tokensUsed, 4242);
  assert.equal(session.approvalPolicy, "on-request");

  // Corrupt db: fall back to the rollout's first prompt.
  fs.writeFileSync(path.join(home, "state_5.sqlite"), "not a database");
  const fallback = createObserver({ home, env: {} }).scanSessions()[0];
  assert.ok(fallback.title.startsWith("Can u check my code base"));
  assert.ok(fallback.title.length <= 80);
  assert.equal(
    fallback.tokensUsed,
    31415,
    "tokens from token_count when db is unreadable",
  );
  assert.equal(readStateDb(path.join(home, "state_5.sqlite")).size, 0);
  assert.equal(readStateDb(path.join(home, "missing.sqlite")).size, 0);
});

test("live detection needs a fresh mtime and an open turn", () => {
  const { home, rollout } = makeHome({ guardian: false });
  let clock = Date.now();
  const observer = createObserver({ home, env: {}, now: () => clock });
  const fresh = new Date(clock);
  fs.utimesSync(rollout, fresh, fresh);
  let [session] = observer.scanSessions();
  assert.equal(session.live, false, "last task_started already completed");
  assert.equal(session.turnOpen, false);

  fs.appendFileSync(
    rollout,
    line({
      timestamp: new Date(clock).toISOString(),
      ordinal: 800,
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: "turn-live",
        started_at: Math.floor(clock / 1000),
      },
    }),
  );
  fs.utimesSync(rollout, fresh, fresh);
  [session] = observer.scanSessions();
  assert.equal(session.live, true);
  assert.equal(session.turnOpen, true);
  assert.equal(session.openTurnId, "turn-live");
  assert.equal(observer.isLive(session), true);

  // Time passes without writes: no longer live even though the turn is open.
  clock += 121_000;
  assert.equal(observer.isLive(session), false);
  assert.equal(observer.scanSessions()[0].live, false);

  // Turn completes: not live regardless of freshness.
  clock -= 121_000;
  fs.appendFileSync(
    rollout,
    line({
      timestamp: new Date(clock).toISOString(),
      ordinal: 801,
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-live",
        last_agent_message: "Done.",
      },
    }),
  );
  fs.utimesSync(rollout, fresh, fresh);
  assert.equal(observer.isLive(session), false);
  assert.equal(observer.scanSessions()[0].turnOpen, false);

  // A fresh observer (server restart) reaches the same conclusion from disk.
  assert.equal(
    createObserver({ home, env: {}, now: () => clock }).scanSessions()[0].live,
    false,
  );
});

test("readEvents maps rollout lines to normalized events with stable ids", () => {
  const { home, rollout } = makeHome({ guardian: false });
  const observer = createObserver({ home, env: {} });
  const [session] = observer.scanSessions();
  const result = observer.readEvents(session, 0);
  assert.equal(result.eof, true);
  // Codex writes no "session ended" record; an idle rollout between turns
  // is not an end. The ObservationService infers it from inactivity.
  assert.equal(result.ended, false);
  assert.equal(result.live, false);
  assert.equal(result.offset, fs.statSync(rollout).size);
  const { events } = result;

  for (const event of events) {
    assert.equal(event.provider, "codex");
    assert.equal(event.sessionId, THREAD_ID);
    assert.ok(
      event.providerEventId.startsWith(`${THREAD_ID}:`),
      event.providerEventId,
    );
    assert.ok(event.summary.length <= 120, event.summary);
    assert.equal(typeof event.timestamp, "number");
    assert.ok(["provider", "user"].includes(event.provenance));
  }
  const text = JSON.stringify(events);
  assert.ok(!text.includes("encrypted_content"), "reasoning is never stored");
  assert.ok(
    !text.includes("gAAAAAB"),
    "encrypted reasoning payload never stored",
  );
  assert.ok(!text.includes("base_instructions"));

  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds, [
    "turn.start",
    "status", // turn_context
    "prompt",
    "command", // custom_tool_call exec
    "tool.end",
    "usage",
    "command", // function_call wait
    "tool.end",
    "status", // thread_settings_applied
    "turn.end",
    "command", // function_call exec_command
    "command", // function_call write_stdin
    "tool.start", // apply_patch
    "file.edit",
  ]);

  const turnStart = events[0];
  assert.equal(turnStart.providerEventId, `${THREAD_ID}:1`);
  assert.equal(turnStart.data.turnId, "01a07fcb-5e94-7c63-9b48-4003bbf24f9a");
  assert.equal(turnStart.timestamp, Date.parse("2026-09-08T06:53:49.824Z"));

  const context = events[1];
  assert.equal(context.data.approvalPolicy, "on-request");
  assert.equal(context.data.cwd, "C:\\xampp\\htdocs\\example-suite\\ExampleApp");
  assert.equal(context.data.sandbox, "workspace-write");

  const prompt = events[2];
  assert.equal(prompt.provenance, "user");
  assert.ok(prompt.summary.startsWith("Can u check my code base"));
  assert.equal(prompt.providerEventId, `${THREAD_ID}:9`);

  const exec = events[3];
  assert.equal(exec.tool, "exec");
  assert.ok(exec.summary.startsWith("Ran: Get-Content RTK.md"), exec.summary);
  assert.ok(exec.data.cmd.includes("git status --short --branch"));

  const execEnd = events[4];
  assert.equal(execEnd.tool, "exec");
  assert.equal(execEnd.summary, "Finished exec");
  assert.equal(execEnd.data.callId, "call_rYAV07Zcb2dbGW5YVQcpRuaw");

  const usage = events[5];
  assert.equal(usage.providerEventId, `${THREAD_ID}:15`);
  assert.deepEqual(usage.usage, {
    input_tokens: 31274,
    cached_input_tokens: 19072,
    cache_write_input_tokens: 0,
    output_tokens: 141,
    reasoning_output_tokens: 0,
    total_tokens: 31415,
  });
  assert.equal(usage.data.total.total_tokens, 31415);
  assert.equal(usage.data.modelContextWindow, 258400);

  const wait = events[6];
  assert.equal(wait.tool, "wait");
  assert.equal(wait.summary, "Waited for command output");
  assert.equal(events[7].tool, "wait");

  const settings = events[8];
  assert.equal(settings.model, "gpt-5.6-sol");
  assert.equal(settings.summary, "Model: gpt-5.6-sol");
  assert.equal(settings.data.approvalPolicy, "on-request");

  const turnEnd = events[9];
  assert.equal(turnEnd.providerEventId, `${THREAD_ID}:400`);
  assert.ok(turnEnd.summary.startsWith("Resolved all three merge conflicts"));
  assert.ok(turnEnd.summary.length <= 120);

  const execCommand = events[10];
  assert.equal(execCommand.tool, "exec_command");
  assert.ok(execCommand.summary.startsWith("Ran: Get-Content -Raw"));
  assert.equal(
    execCommand.data.workdir,
    "C:\\xampp\\htdocs\\example-suite\\ExampleApp",
  );
  assert.equal(
    execCommand.model,
    "gpt-5.6-sol",
    "model carried from thread settings",
  );

  assert.equal(events[11].tool, "write_stdin");
  assert.equal(events[11].summary, "Sent input to a running command");

  const patch = events[12];
  assert.equal(patch.tool, "apply_patch");
  assert.equal(
    patch.summary,
    "Applied patch to database/seeds/_demo/master_seed.sql",
  );
  assert.equal(patch.providerEventId, `${THREAD_ID}:722:tool`);
  const edit = events[13];
  assert.equal(edit.kind, "file.edit");
  assert.equal(edit.summary, "Added database/seeds/_demo/master_seed.sql");
  assert.equal(
    edit.file,
    "C:\\xampp\\htdocs\\example-suite\\ExampleApp\\database\\seeds\\_demo\\master_seed.sql",
  );
  assert.equal(edit.providerEventId, `${THREAD_ID}:722:file:0`);

  // Stable ids across calls.
  const again = observer.readEvents(session, 0);
  assert.deepEqual(
    again.events.map((e) => e.providerEventId),
    events.map((e) => e.providerEventId),
  );
  assert.equal(
    new Set(kinds.map((_, i) => events[i].providerEventId)).size,
    events.length,
  );
});

test("readEvents is incremental, tolerates partial lines, and maps tests/errors", () => {
  const { home, rollout } = makeHome({ guardian: false });
  const clock = Date.now();
  const observer = createObserver({ home, env: {}, now: () => clock });
  const [session] = observer.scanSessions();
  const first = observer.readEvents(session, 0);
  assert.equal(observer.readEvents(session, first.offset).events.length, 0);

  const started = line({
    timestamp: new Date(clock).toISOString(),
    ordinal: 900,
    type: "event_msg",
    payload: { type: "task_started", turn_id: "t-900" },
  });
  fs.appendFileSync(rollout, started.slice(0, 30));
  const partial = observer.readEvents(session, first.offset);
  assert.equal(partial.events.length, 0);
  assert.equal(partial.offset, first.offset);
  fs.appendFileSync(rollout, started.slice(30));
  const next = observer.readEvents(session, partial.offset);
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0].kind, "turn.start");
  assert.equal(next.events[0].providerEventId, `${THREAD_ID}:900`);
  fs.utimesSync(rollout, new Date(clock), new Date(clock));
  assert.equal(
    next.ended,
    false,
    "turn open + fresh file = live, so not ended",
  );

  fs.appendFileSync(
    rollout,
    [
      line({
        timestamp: new Date(clock + 1000).toISOString(),
        ordinal: 901,
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call_test",
          arguments: JSON.stringify({ cmd: "npm test", workdir: "C:\\repo" }),
        },
      }),
      line({
        timestamp: new Date(clock + 2000).toISOString(),
        ordinal: 902,
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_test",
          output: "12 passing",
        },
      }),
      line({
        timestamp: new Date(clock + 3000).toISOString(),
        ordinal: 903,
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "All tests pass.\nNext I will refactor.",
          phase: "final",
        },
      }),
      line({
        timestamp: new Date(clock + 4000).toISOString(),
        ordinal: 904,
        type: "event_msg",
        payload: { type: "user_message", message: "Great, continue" },
      }),
      line({
        timestamp: new Date(clock + 5000).toISOString(),
        ordinal: 905,
        type: "event_msg",
        payload: { type: "stream_error", message: "connection reset" },
      }),
      line({
        timestamp: new Date(clock + 6000).toISOString(),
        ordinal: 906,
        type: "response_item",
        payload: { type: "reasoning", encrypted_content: "gAAAAAB-secret" },
      }),
      // Line without an ordinal gets a path:offset id.
      line({
        timestamp: new Date(clock + 7000).toISOString(),
        type: "event_msg",
        payload: { type: "error", message: "rate limited" },
      }),
      "this is not json\n",
    ].join(""),
  );
  const tail = observer.readEvents(session, next.offset);
  const kinds = tail.events.map((e) => e.kind);
  assert.deepEqual(kinds, [
    "test",
    "tool.end",
    "message",
    "prompt",
    "error",
    "error",
  ]);
  assert.equal(tail.events[0].tool, "exec_command");
  assert.equal(tail.events[0].summary, "Ran: npm test");
  assert.equal(tail.events[1].data.outputPreview, "12 passing");
  assert.equal(tail.events[2].summary, "All tests pass.");
  assert.equal(tail.events[2].data.phase, "final");
  assert.equal(tail.events[3].summary, "Great, continue");
  assert.equal(tail.events[3].provenance, "user");
  assert.equal(tail.events[4].summary, "Stream error: connection reset");
  assert.equal(tail.events[5].summary, "Error: rate limited");
  assert.ok(tail.events[5].providerEventId.startsWith(rollout + ":"));
  assert.ok(!JSON.stringify(tail.events).includes("gAAAAAB-secret"));
  assert.equal(tail.offset, fs.statSync(rollout).size);
});

test("archived sessions are found and marked; CODEX_HOME env is honored; empty home is fine", () => {
  const { home, rollout } = makeHome({ guardian: false });
  const archivedDir = path.join(home, "archived_sessions", "2026", "09", "01");
  fs.mkdirSync(archivedDir, { recursive: true });
  const archivedId = "0aaaaaaa-bbbb-7e10-ae86-9cac64bb6077";
  fs.writeFileSync(
    path.join(archivedDir, `rollout-2026-09-01T10-00-00-${archivedId}.jsonl`),
    line({
      timestamp: "2026-09-01T10:00:00.000Z",
      ordinal: 0,
      type: "session_meta",
      payload: {
        id: archivedId,
        cwd: "C:\\old",
        originator: "codex_cli_rs",
        source: "cli",
      },
    }),
  );
  const observer = createObserver({ env: { CODEX_HOME: home } });
  assert.equal(observer.home, home);
  const sessions = observer.scanSessions();
  assert.equal(sessions.length, 2);
  const archived = sessions.find((s) => s.sessionId === archivedId);
  assert.equal(archived.archived, true);
  assert.equal(archived.cwd, "C:\\old");
  assert.equal(archived.title, "Codex session");
  assert.equal(archived.live, false);
  assert.equal(sessions.find((s) => s.sourcePath === rollout).archived, false);

  const empty = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-space-codex-empty-"),
  );
  assert.deepEqual(createObserver({ home: empty, env: {} }).scanSessions(), []);
});
