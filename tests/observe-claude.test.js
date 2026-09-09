import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createObserver,
  cleanPromptText,
  slugForCwd,
  summarizeTranscript,
} from "../packages/core/src/observe/claudeCode.js";
import {
  readNewLines,
  parseJsonLine,
  fileStat,
} from "../packages/core/src/observe/jsonl.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures", "providers");
const SESSION_ID = "ce11cc5e-2683-42ee-9cd7-5a482281ff3e";
const SLUG = "c--xampp-htdocs-Ai-Agents-View";

/** Builds a fake ~/.claude laid out exactly like the real one. */
function makeHome({ registry = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-space-claude-"));
  const projectDir = path.join(home, "projects", SLUG);
  fs.mkdirSync(projectDir, { recursive: true });
  const transcript = path.join(projectDir, `${SESSION_ID}.jsonl`);
  fs.copyFileSync(
    path.join(fixtures, "claude-code-transcript.jsonl"),
    transcript,
  );
  // Subagent transcript: must not be listed as a session of its own.
  const subDir = path.join(projectDir, SESSION_ID);
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(
    path.join(subDir, "agent-1234.jsonl"),
    JSON.stringify({
      type: "user",
      uuid: "sub-1",
      isSidechain: true,
      timestamp: "2026-09-09T14:06:00.000Z",
      sessionId: SESSION_ID,
      message: { role: "user", content: "subagent prompt" },
    }) + "\n",
  );
  if (registry) {
    fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
    fs.copyFileSync(
      path.join(fixtures, "claude-session-registry.json"),
      path.join(home, "sessions", "99999.json"),
    );
    // Token sibling that must never be read.
    fs.writeFileSync(path.join(home, "sessions", "99999.abcd.key"), "SECRET");
  }
  fs.writeFileSync(
    path.join(home, "history.jsonl"),
    [
      JSON.stringify({
        display: "/graphify",
        timestamp: 1788962744385,
        project: "c:\\xampp\\htdocs\\Ai_Agents_View",
        sessionId: SESSION_ID,
      }),
      JSON.stringify({
        display: "Fix the failing test in persistence.test.js",
        timestamp: 1788962000000,
        project: "c:\\xampp\\htdocs\\Other",
        sessionId: "other-session",
      }),
    ].join("\n") + "\n",
  );
  return { home, transcript, projectDir };
}

function line(record) {
  return JSON.stringify(record) + "\n";
}

test("jsonl tailer reads complete lines from an offset and tolerates partial lines", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-space-jsonl-"));
  const file = path.join(dir, "log.jsonl");
  fs.writeFileSync(file, '{"a":1}\r\nnot json\n{"b":2}\n{"partial":');
  const first = readNewLines(file, 0);
  assert.equal(first.lines.length, 3);
  assert.deepEqual(parseJsonLine(first.lines[0].line), { a: 1 });
  assert.equal(parseJsonLine(first.lines[1].line), null);
  assert.equal(first.lines[0].offset, 0);
  assert.equal(first.lines[2].offset, '{"a":1}\r\nnot json\n'.length);
  assert.equal(first.offset, '{"a":1}\r\nnot json\n{"b":2}\n'.length);
  assert.equal(first.eof, true);
  // Nothing new until the partial line is completed.
  const again = readNewLines(file, first.offset);
  assert.equal(again.lines.length, 0);
  assert.equal(again.offset, first.offset);
  fs.appendFileSync(file, "true}\n");
  const third = readNewLines(file, first.offset);
  assert.equal(third.lines.length, 1);
  assert.deepEqual(parseJsonLine(third.lines[0].line), { partial: true });
  assert.equal(third.offset, fs.statSync(file).size);
  // Rotated / truncated file restarts from 0.
  fs.writeFileSync(file, '{"c":3}\n');
  const rotated = readNewLines(file, third.offset);
  assert.equal(rotated.reset, true);
  assert.equal(rotated.lines.length, 1);
  assert.equal(fileStat(path.join(dir, "missing.jsonl")), null);
  assert.deepEqual(readNewLines(path.join(dir, "missing.jsonl"), 5).lines, []);
});

test("jsonl tailer honors maxBytes and resumes at the next complete line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-space-jsonl-"));
  const file = path.join(dir, "big.jsonl");
  const records = [];
  for (let i = 0; i < 50; i++)
    records.push(JSON.stringify({ i, pad: "x".repeat(100) }));
  fs.writeFileSync(file, records.join("\n") + "\n");
  let offset = 0;
  const seen = [];
  for (let guard = 0; guard < 100; guard++) {
    const chunk = readNewLines(file, offset, { maxBytes: 500 });
    for (const { line } of chunk.lines) seen.push(parseJsonLine(line).i);
    offset = chunk.offset;
    if (chunk.eof) break;
  }
  assert.deepEqual(
    seen,
    records.map((_, i) => i),
  );
});

test("cleanPromptText strips command and IDE wrappers; slugForCwd matches Claude's folder names", () => {
  assert.equal(
    cleanPromptText(
      "<command-message>graphify</command-message>\n<command-name>/graphify</command-name>",
    ),
    "graphify\n/graphify",
  );
  assert.equal(
    cleanPromptText(
      "<ide_selection>selected code</ide_selection>Refactor this<system-reminder>hidden</system-reminder>",
    ),
    "Refactor this",
  );
  assert.equal(slugForCwd("c:\\xampp\\htdocs\\Ai_Agents_View"), SLUG);
  assert.equal(slugForCwd("/home/user/my project"), "-home-user-my-project");
});

test("scanSessions discovers the top-level transcript with registry, history, and live detection", () => {
  const { home, transcript } = makeHome();
  const alive = new Set([99999]);
  const observer = createObserver({
    home,
    env: {},
    isPidAlive: (pid) => alive.has(pid),
  });
  assert.equal(observer.provider, "claude-code");
  const sessions = observer.scanSessions();
  assert.equal(sessions.length, 1, "subagent transcript must not appear");
  const [session] = sessions;
  assert.equal(session.provider, "claude-code");
  assert.equal(session.sessionId, SESSION_ID);
  assert.equal(session.sourcePath, transcript);
  assert.equal(session.cwd.toLowerCase(), "c:\\xampp\\htdocs\\ai_agents_view");
  assert.equal(session.title, "graphify");
  assert.equal(session.pid, 99999);
  assert.equal(session.entrypoint, "claude-vscode");
  assert.equal(session.startedAt, 1788962716224);
  assert.equal(session.model, "claude-fable-5-1");
  assert.equal(session.gitBranch, "HEAD");
  assert.equal(session.isSubagent, false);
  assert.equal(session.live, true);
  assert.ok(session.updatedAt >= Date.parse("2026-09-09T14:05:54.557Z"));
  assert.equal(observer.isLive(session), true);

  alive.delete(99999);
  assert.equal(observer.isLive(session), false);
  assert.equal(observer.scanSessions()[0].live, false);
});

test("sessions without a registry entry are not live and fall back to history titles", () => {
  const { home, projectDir } = makeHome({ registry: false });
  // Second transcript with only tool traffic: title should come from history.
  const otherId = "other-session";
  fs.writeFileSync(
    path.join(projectDir, `${otherId}.jsonl`),
    line({
      type: "assistant",
      uuid: "a-1",
      timestamp: "2026-09-08T10:00:00.000Z",
      sessionId: otherId,
      cwd: "c:\\xampp\\htdocs\\Other",
      message: {
        model: "claude-sonnet-4-5",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
      },
    }),
  );
  const observer = createObserver({ home, env: {}, isPidAlive: () => true });
  const sessions = observer.scanSessions();
  assert.equal(sessions.length, 2);
  const other = sessions.find((s) => s.sessionId === otherId);
  assert.equal(other.title, "Fix the failing test in persistence.test.js");
  assert.equal(other.live, false);
  assert.equal(other.pid, null);
  assert.equal(other.model, "claude-sonnet-4-5");
  assert.equal(observer.isLive(other), false);
});

test("readEvents maps transcript lines to normalized events with stable ids", () => {
  const { home } = makeHome();
  const observer = createObserver({ home, env: {}, isPidAlive: () => true });
  const [session] = observer.scanSessions();
  const first = observer.readEvents(session, 0);
  assert.equal(first.eof, true);
  assert.equal(first.ended, false, "live session is not ended");
  assert.equal(first.offset, fs.statSync(session.sourcePath).size);
  const { events } = first;

  for (const event of events) {
    assert.equal(event.provider, "claude-code");
    assert.equal(event.sessionId, SESSION_ID);
    assert.ok(event.providerEventId, "every event has a stable id");
    assert.ok(event.summary.length <= 120);
    assert.ok(["provider", "user"].includes(event.provenance));
    assert.equal(typeof event.timestamp, "number");
    assert.ok(
      !JSON.stringify(event).includes("thinking"),
      "no thinking text stored",
    );
  }

  const prompt = events.find((e) => e.kind === "prompt");
  assert.equal(prompt.summary, "graphify");
  assert.equal(prompt.provenance, "user");
  assert.equal(prompt.providerEventId, "9b40275c-184f-46aa-b046-481f010557fa");
  assert.equal(prompt.timestamp, Date.parse("2026-09-09T14:05:44.385Z"));

  const toolStart = events.find((e) => e.kind === "tool.start");
  assert.equal(toolStart.tool, "Bash");
  assert.equal(toolStart.model, "claude-fable-5-1");
  assert.ok(toolStart.summary.startsWith("Ran: cat "));
  assert.ok(toolStart.data.input.command.includes("extraction-spec.md"));

  const command = events.find((e) => e.kind === "command");
  assert.equal(command.tool, "Bash");
  assert.ok(command.summary.startsWith("Ran: cat "));
  assert.notEqual(command.providerEventId, toolStart.providerEventId);

  const toolEnd = events.find((e) => e.kind === "tool.end");
  assert.equal(toolEnd.providerEventId, "0b33b81d-ee07-43c7-a8a5-2baa863a0397");
  assert.equal(toolEnd.data.toolUseId, "toolu_01WVWAN7VJw2ky8ZLVT8dM95");
  assert.equal(toolEnd.data.isError, false);
  assert.ok(toolEnd.data.outputPreview.includes("Ai_Agents_View"));

  const message = events.find((e) => e.kind === "message");
  assert.ok(message.summary.startsWith("I'll run the full graphify pipeline"));
  assert.equal(message.model, "claude-fable-5-1");

  const usage = events.filter((e) => e.kind === "usage");
  assert.equal(usage.length, 2, "one usage event per assistant message id");
  assert.equal(usage[0].model, "claude-fable-5-1");
  assert.deepEqual(usage[0].usage, {
    input_tokens: 32,
    output_tokens: 1263,
    cache_read_input_tokens: 60201,
    cache_creation_input_tokens: 1504,
  });
  assert.equal(usage[0].providerEventId, "msg_011Ceszedf9ZTCAaunTUWaT8:usage");
  assert.equal(usage[0].provenance, "provider");

  // Stable ids: reading again from the start yields the same ids in order.
  const again = observer.readEvents(session, 0);
  assert.deepEqual(
    again.events.map((e) => e.providerEventId),
    events.map((e) => e.providerEventId),
  );
  const ids = new Set(events.map((e) => e.providerEventId));
  assert.equal(ids.size, events.length, "ids are unique within a transcript");
});

test("readEvents is incremental and tolerates partial trailing lines", () => {
  const { home, transcript } = makeHome();
  const observer = createObserver({ home, env: {}, isPidAlive: () => true });
  const [session] = observer.scanSessions();
  const first = observer.readEvents(session, 0);
  // Subagent transcripts are folded in; hand their cursor back like the
  // ObservationService does so only the main transcript's growth shows.
  const cursor = first.cursor;

  const nothing = observer.readEvents(session, first.offset, { cursor });
  assert.equal(nothing.events.length, 0);
  assert.equal(nothing.offset, first.offset);

  const edit = {
    parentUuid: "x",
    isSidechain: false,
    type: "assistant",
    uuid: "edit-uuid-1",
    timestamp: "2026-09-09T14:07:00.000Z",
    sessionId: SESSION_ID,
    cwd: "C:\\xampp\\htdocs\\Ai_Agents_View",
    gitBranch: "main",
    message: {
      model: "claude-fable-5-1",
      id: "msg_edit",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret reasoning", signature: "sig" },
        {
          type: "tool_use",
          id: "toolu_edit",
          name: "Edit",
          input: {
            file_path:
              "C:\\xampp\\htdocs\\Ai_Agents_View\\apps\\web\\src\\App.jsx",
            old_string: "a",
            new_string: "b",
          },
        },
      ],
      usage: { input_tokens: 5, output_tokens: 7 },
    },
  };
  const text = line(edit);
  // Write only half the line: nothing should be returned yet.
  fs.appendFileSync(transcript, text.slice(0, 40));
  const partial = observer.readEvents(session, first.offset, { cursor });
  assert.equal(partial.events.length, 0);
  assert.equal(partial.offset, first.offset);
  fs.appendFileSync(transcript, text.slice(40));
  const next = observer.readEvents(session, partial.offset, { cursor });
  assert.equal(next.offset, fs.statSync(transcript).size);
  const kinds = next.events.map((e) => e.kind);
  assert.deepEqual(kinds, ["tool.start", "file.edit", "usage"]);
  const [start, fileEdit, usage] = next.events;
  assert.equal(start.tool, "Edit");
  assert.equal(
    start.file,
    "C:\\xampp\\htdocs\\Ai_Agents_View\\apps\\web\\src\\App.jsx",
  );
  assert.equal(fileEdit.summary, "Edited apps/web/src/App.jsx");
  assert.equal(fileEdit.file, start.file);
  assert.equal(fileEdit.data.gitBranch, "main");
  assert.equal(start.providerEventId, "edit-uuid-1:tool:1");
  assert.equal(fileEdit.providerEventId, "edit-uuid-1:file.edit:1");
  assert.equal(usage.providerEventId, "msg_edit:usage");
  assert.ok(!JSON.stringify(next.events).includes("secret reasoning"));
  assert.ok(!JSON.stringify(next.events).includes("signature"));

  // A matching tool_result on a later line resolves the tool name; errors map to `error`.
  fs.appendFileSync(
    transcript,
    line({
      type: "user",
      uuid: "result-uuid-1",
      timestamp: "2026-09-09T14:07:01.000Z",
      sessionId: SESSION_ID,
      cwd: "C:\\xampp\\htdocs\\Ai_Agents_View",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_edit",
            content: "String not found",
            is_error: true,
          },
        ],
      },
    }),
  );
  const errored = observer.readEvents(session, next.offset, { cursor });
  assert.equal(errored.events.length, 1);
  assert.equal(errored.events[0].kind, "error");
  assert.equal(errored.events[0].tool, "Edit");
  assert.equal(errored.events[0].summary, "Edit failed: String not found");
});

test("tool mapping covers read, search, web, test, delegation, and sidechain lines", () => {
  const { home, transcript } = makeHome();
  const observer = createObserver({ home, env: {}, isPidAlive: () => false });
  const [session] = observer.scanSessions();
  const { offset: start, cursor } = observer.readEvents(session, 0);
  const cwd = "C:\\xampp\\htdocs\\Ai_Agents_View";
  const assistant = (uuid, block, extra = {}) =>
    line({
      type: "assistant",
      uuid,
      timestamp: "2026-09-09T14:08:00.000Z",
      sessionId: SESSION_ID,
      cwd,
      isSidechain: false,
      ...extra,
      message: {
        model: "claude-fable-5-1",
        id: `msg_${uuid}`,
        role: "assistant",
        content: [block],
      },
    });
  fs.appendFileSync(
    transcript,
    [
      assistant("u1", {
        type: "tool_use",
        id: "t1",
        name: "Read",
        input: { file_path: `${cwd}\\README.md` },
      }),
      assistant("u2", {
        type: "tool_use",
        id: "t2",
        name: "Grep",
        input: { pattern: "createObserver", path: cwd },
      }),
      assistant("u3", {
        type: "tool_use",
        id: "t3",
        name: "WebFetch",
        input: { url: "https://example.com/docs" },
      }),
      assistant("u4", {
        type: "tool_use",
        id: "t4",
        name: "Bash",
        input: { command: "npm test" },
      }),
      assistant("u5", {
        type: "tool_use",
        id: "t5",
        name: "Task",
        input: { description: "Review the diff", prompt: "..." },
      }),
      assistant(
        "u6",
        {
          type: "tool_use",
          id: "t6",
          name: "Write",
          input: { file_path: "D:\\elsewhere\\notes.txt", content: "x" },
        },
        { isSidechain: true },
      ),
      line({
        type: "attachment",
        uuid: "u7",
        timestamp: "2026-09-09T14:08:01.000Z",
        sessionId: SESSION_ID,
      }),
      line({ type: "summary", summary: "ignored", leafUuid: "u8" }),
    ].join(""),
  );
  const { events, ended } = observer.readEvents(session, start, { cursor });
  assert.equal(ended, true, "dead session at eof is ended");
  const byKind = (kind) => events.filter((e) => e.kind === kind);
  assert.equal(byKind("tool.start").length, 6);
  assert.equal(byKind("file.read")[0].summary, "Read README.md");
  assert.equal(byKind("search")[0].summary, "Searched code for createObserver");
  assert.equal(byKind("web")[0].summary, "Fetched https://example.com/docs");
  const testEvent = byKind("test")[0];
  assert.equal(testEvent.summary, "Ran: npm test");
  assert.equal(testEvent.tool, "Bash");
  assert.equal(byKind("command").length, 0);
  assert.equal(byKind("delegation")[0].summary, "Delegated: Review the diff");
  const write = byKind("file.edit")[0];
  assert.equal(write.summary, "Wrote D:/elsewhere/notes.txt");
  assert.equal(write.data.sidechain, true);
  assert.equal(events.filter((e) => e.data.sidechain).length, 2);
  assert.ok(!events.some((e) => e.providerEventId?.startsWith("u7")));
});

test("summarizeTranscript is cheap and reports first prompt, model, and tool count", () => {
  const { transcript } = makeHome();
  const summary = summarizeTranscript(transcript);
  assert.equal(summary.sessionId, SESSION_ID);
  assert.equal(summary.firstPrompt, "graphify");
  assert.equal(summary.model, "claude-fable-5-1");
  assert.equal(summary.toolCallCount, 1);
  assert.equal(summary.firstTimestamp, Date.parse("2026-09-09T14:05:44.385Z"));
  const lastLine = fs
    .readFileSync(transcript, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .at(-1);
  assert.equal(
    summary.lastTimestamp,
    Date.parse(JSON.parse(lastLine).timestamp),
  );
  assert.equal(summary.gitBranch, "HEAD");
  assert.equal(summary.version, "2.1.266");
  assert.deepEqual(
    summarizeTranscript(path.join(transcript, "..", "nope.jsonl")).firstPrompt,
    null,
  );
});

test("observer resolves its home from CLAUDE_CONFIG_DIR and returns nothing for an empty home", () => {
  const home = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-space-claude-empty-"),
  );
  const observer = createObserver({
    env: { CLAUDE_CONFIG_DIR: home },
    isPidAlive: () => true,
  });
  assert.equal(observer.home, home);
  assert.deepEqual(observer.scanSessions(), []);
  const result = observer.readEvents(
    { sessionId: "x", sourcePath: path.join(home, "missing.jsonl") },
    0,
  );
  assert.deepEqual(result.events, []);
  assert.equal(
    result.ended,
    false,
    "unknown liveness is never a provider-reported end",
  );
  assert.equal(result.live, null);
});

test("readEvents folds subagent transcripts into the parent session with a per-file cursor", () => {
  const { home, transcript, projectDir } = makeHome();
  const observer = createObserver({ home, env: {}, isPidAlive: () => true });
  const session = observer.scanSessions()[0];
  assert.equal(session.subagentCount, 1);

  // The fixture home already holds <slug>/<sessionId>/agent-1234.jsonl.
  const first = observer.readEvents(session, 0);
  const sub = first.events.find((e) => e.providerEventId === "sub-1");
  assert.ok(sub, "subagent prompt line is folded into the parent session");
  assert.equal(sub.kind, "prompt");
  assert.equal(sub.data.sidechain, true);
  assert.equal(sub.sessionId, SESSION_ID);
  const subFile = path.join(projectDir, SESSION_ID, "agent-1234.jsonl");
  assert.deepEqual(first.cursor, {
    "agent-1234.jsonl": fs.statSync(subFile).size,
  });
  assert.equal(first.eof, true);

  // Nothing new when the cursor is handed back.
  const again = observer.readEvents(session, first.offset, {
    cursor: first.cursor,
  });
  assert.equal(again.events.length, 0);
  assert.deepEqual(again.cursor, first.cursor);

  // Workflow subagents nest deeper; lines carry the subagent id.
  const nested = path.join(
    projectDir,
    SESSION_ID,
    "subagents",
    "workflows",
    "wf_1",
  );
  fs.mkdirSync(nested, { recursive: true });
  const nestedFile = path.join(nested, "agent-a1.jsonl");
  const soon = Date.now() + 60_000;
  fs.writeFileSync(
    nestedFile,
    line({
      type: "assistant",
      uuid: "nested-1",
      isSidechain: true,
      agentId: "a1",
      timestamp: new Date(soon).toISOString(),
      sessionId: SESSION_ID,
      cwd: "C:\\xampp\\htdocs\\Ai_Agents_View",
      message: {
        model: "claude-fable-5-1",
        id: "msg_nested",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_nested",
            name: "Read",
            input: { file_path: "C:\\xampp\\htdocs\\Ai_Agents_View\\a.js" },
          },
        ],
      },
    }),
  );
  fs.utimesSync(nestedFile, new Date(soon), new Date(soon));
  const third = observer.readEvents(session, again.offset, {
    cursor: again.cursor,
  });
  const kinds = third.events.map((e) => e.kind);
  assert.deepEqual(kinds, ["tool.start", "file.read"]);
  for (const event of third.events) {
    assert.equal(event.data.sidechain, true);
    assert.equal(event.data.subagent, "a1");
  }
  assert.equal(third.events[0].providerEventId, "nested-1:tool:0");
  assert.deepEqual(Object.keys(third.cursor).sort(), [
    "agent-1234.jsonl",
    "subagents/workflows/wf_1/agent-a1.jsonl",
  ]);
  assert.equal(
    third.cursor["subagents/workflows/wf_1/agent-a1.jsonl"],
    fs.statSync(nestedFile).size,
  );
  // Only the main transcript's offset moves through `offset`.
  assert.equal(third.offset, fs.statSync(transcript).size);

  // Subagent activity counts as session activity for scanSessions().
  const rescanned = observer.scanSessions()[0];
  assert.equal(rescanned.subagentCount, 2);
  assert.ok(rescanned.updatedAt >= soon - 1000);
  assert.equal(observer.scanSessions().length, 1, "still not a session");

  // A subagent file seen for the first time with a large backlog starts near
  // its end, like the ObservationService does for the main transcript.
  const lines = [1, 2, 3].map((i) =>
    line({
      type: "user",
      uuid: `backlog-${i}`,
      isSidechain: true,
      agentId: "a2",
      timestamp: "2026-09-09T14:08:00.000Z",
      sessionId: SESSION_ID,
      message: { role: "user", content: `backlog prompt ${i}` },
    }),
  );
  const backlogFile = path.join(nested, "agent-a2.jsonl");
  fs.writeFileSync(backlogFile, lines.join(""));
  const joined = observer.readEvents(session, third.offset, {
    cursor: third.cursor,
    initialBacklogBytes: lines[2].length + 1,
  });
  assert.deepEqual(
    joined.events.map((e) => e.providerEventId),
    ["backlog-3"],
  );
  assert.equal(
    joined.cursor["subagents/workflows/wf_1/agent-a2.jsonl"],
    fs.statSync(backlogFile).size,
  );
  // Without a backlog limit the whole file is replayed.
  const replayed = observer.readEvents(session, third.offset, {
    cursor: third.cursor,
  });
  assert.equal(replayed.events.length, 3);
});

test("a transcript without a registry entry is never declared ended; a registered session whose process is gone is", () => {
  const { home } = makeHome({ registry: false });
  const observer = createObserver({ home, env: {}, isPidAlive: () => false });
  const session = observer
    .scanSessions()
    .find((s) => s.sessionId === SESSION_ID);
  assert.equal(session.registered, false);
  const result = observer.readEvents(session, 0);
  assert.equal(result.eof, true);
  assert.equal(result.ended, false, "liveness unknown → not ended");
  assert.equal(result.live, null);
  assert.equal(observer.isLive(session), false);

  // Registry present and the pid dead: the provider says it is gone.
  const registered = makeHome({ registry: true });
  const dead = createObserver({
    home: registered.home,
    env: {},
    isPidAlive: () => false,
  });
  const known = dead.scanSessions().find((s) => s.sessionId === SESSION_ID);
  assert.equal(known.registered, true);
  const deadResult = dead.readEvents(known, 0);
  assert.equal(deadResult.ended, true);
  assert.equal(deadResult.live, false);

  // Registry entry seen once, then removed (Claude exited): still an end.
  const alive = new Set([99999]);
  const gone = createObserver({
    home: registered.home,
    env: {},
    isPidAlive: (pid) => alive.has(pid),
  });
  const first = gone.scanSessions().find((s) => s.sessionId === SESSION_ID);
  assert.equal(gone.readEvents(first, 0).ended, false);
  fs.rmSync(path.join(registered.home, "sessions", "99999.json"));
  alive.clear();
  const later = gone.scanSessions().find((s) => s.sessionId === SESSION_ID);
  assert.equal(later.registered, false);
  assert.equal(
    gone.readEvents(later, 0).ended,
    true,
    "was registered, now gone",
  );
});

test("scanSessions reads history.jsonl and transcripts incrementally", () => {
  const { home, transcript } = makeHome();
  const historyPath = path.join(home, "history.jsonl");
  const observer = createObserver({ home, env: {}, isPidAlive: () => true });
  observer.scanSessions();
  const { summaryCache, historyCache } = observer._internal;
  assert.equal(
    summaryCache.get(transcript).offset,
    fs.statSync(transcript).size,
  );
  assert.equal(historyCache.offset, fs.statSync(historyPath).size);
  const firstPrompt = summaryCache.get(transcript).summary.firstPrompt;
  assert.ok(firstPrompt);
  const before = summaryCache.get(transcript).summary.lineCount;

  // Append one line to each: only the new bytes are read; earlier facts stay.
  fs.appendFileSync(
    transcript,
    line({
      type: "assistant",
      uuid: "inc-1",
      timestamp: "2026-09-09T15:00:00.000Z",
      sessionId: SESSION_ID,
      message: {
        model: "claude-inc",
        id: "msg_inc",
        role: "assistant",
        content: [{ type: "text", text: "more" }],
        usage: {},
      },
    }),
  );
  fs.appendFileSync(
    historyPath,
    JSON.stringify({
      display: "Later prompt",
      timestamp: 1788970000000,
      project: "x",
      sessionId: "later",
    }) + "\n",
  );
  const bumped = new Date(Date.now() + 5000);
  fs.utimesSync(transcript, bumped, bumped);
  fs.utimesSync(historyPath, bumped, bumped);
  const session = observer
    .scanSessions()
    .find((s) => s.sessionId === SESSION_ID);
  const entry = summaryCache.get(transcript);
  assert.equal(entry.offset, fs.statSync(transcript).size);
  assert.equal(entry.summary.lineCount, before + 1, "only the new line parsed");
  assert.equal(entry.summary.firstPrompt, firstPrompt);
  assert.equal(session.model, "claude-inc");
  assert.equal(historyCache.offset, fs.statSync(historyPath).size);
  assert.ok(historyCache.titles.has("later"));
  assert.equal(historyCache.titles.get(SESSION_ID).title, "/graphify");
  // Unchanged files are not read again.
  const offsetBefore = entry.offset;
  observer.scanSessions();
  assert.equal(summaryCache.get(transcript), entry);
  assert.equal(entry.offset, offsetBefore);
});
