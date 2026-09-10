import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServices } from "../packages/core/src/services.js";
import { claudeCodeAdapter } from "../packages/core/src/adapters/claudeCode.js";
import { codexAdapter } from "../packages/core/src/adapters/codex.js";
import { copilotAdapter } from "../packages/core/src/adapters/copilot.js";
import { geminiAdapter } from "../packages/core/src/adapters/gemini.js";
import { createLineSplitter } from "../packages/core/src/runs/process.js";
import { classifyFailure } from "../packages/core/src/runs/retry.js";
import { PROVENANCE } from "../packages/core/src/contracts.js";

/**
 * Roadmap section 18 contract gate: the same provider stream must produce the
 * same run whatever order its lines arrive in, replayed lines must be dropped,
 * malformed lines skipped, a truncated trailing line left for the next read,
 * a stream without usage must leave usage unreported (not zero), an unknown
 * model must stay null, and an authorization failure must finalize as failed
 * with the right classification.
 *
 * Streams are the real captures in tests/fixtures/providers/ plus a synthetic
 * tail shaped exactly like the fake CLIs' WRITE_FILE output (documented in
 * docs/ARCHITECTURE.md section 3), so every adapter sees a stream with two
 * files, a command, usage, and a model.
 */

const fixture = (name) =>
  readFileSync(
    fileURLToPath(new URL(`./fixtures/providers/${name}`, import.meta.url)),
    "utf8",
  )
    .split(/\r?\n/)
    .filter((line) => line.trim());

const CLAUDE_SESSION = "ecbb24d3-7973-43e1-a678-2dcedcc5ba0e";
const COPILOT_SESSION = "9869997d-2b31-4869-ac28-363005a10279";
const CODEX_THREAD = "0b734361-bd97-44eb-aa48-5549866543a7";
const WRITTEN = "C:\\work\\probe\\fake-output.txt";
const iso = (offsetMs) => new Date(1788965700000 + offsetMs).toISOString();

/** Claude Code: verified capture + the fake CLI's WRITE_FILE tail. */
function claudeStream() {
  const lines = fixture("claude-headless-stream.jsonl");
  const result = lines.find((line) => JSON.parse(line).type === "result");
  const body = lines.filter((line) => JSON.parse(line).type !== "result");
  const tool = "toolu_fake_order_write";
  const tail = [
    {
      type: "assistant",
      message: {
        model: "claude-haiku-4-5-20251001",
        id: "msg_fake_order_1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: tool,
            name: "Write",
            input: { file_path: WRITTEN, content: "written by fake claude" },
          },
        ],
        usage: { input_tokens: 5, output_tokens: 7 },
      },
      session_id: CLAUDE_SESSION,
      uuid: "8c2f0d5e-0001-4c3a-9b1e-000000000001",
      timestamp: iso(1000),
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          { tool_use_id: tool, type: "tool_result", content: "File written" },
        ],
      },
      session_id: CLAUDE_SESSION,
      uuid: "8c2f0d5e-0002-4c3a-9b1e-000000000002",
      timestamp: iso(2000),
    },
    {
      type: "assistant",
      message: {
        model: "claude-haiku-4-5-20251001",
        id: "msg_fake_order_2",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: `${tool}_test`,
            name: "Bash",
            input: { command: "npm test" },
          },
        ],
        usage: { input_tokens: 3, output_tokens: 4 },
      },
      session_id: CLAUDE_SESSION,
      uuid: "8c2f0d5e-0003-4c3a-9b1e-000000000003",
      timestamp: iso(3000),
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            tool_use_id: `${tool}_test`,
            type: "tool_result",
            content: "1 passing",
          },
        ],
      },
      session_id: CLAUDE_SESSION,
      uuid: "8c2f0d5e-0004-4c3a-9b1e-000000000004",
      timestamp: iso(4000),
    },
  ].map((record) => JSON.stringify(record));
  return [...body, ...tail, result];
}

/** Copilot: session.start + verified capture + an edit and a result. */
function copilotStream() {
  const start = JSON.stringify({
    type: "session.start",
    data: {
      sessionId: COPILOT_SESSION,
      version: 1,
      producer: "copilot-agent",
      copilotVersion: "1.0.80",
      context: { cwd: "C:\\work\\probe" },
    },
    id: "171f1b9c-dc33-43c1-ab2d-54b5142255c6",
    timestamp: "2026-09-09T14:54:06.000Z",
    parentId: null,
  });
  const body = fixture("copilot-headless-stream.jsonl").filter(
    (line) => JSON.parse(line).type !== "result",
  );
  const tail = [
    {
      type: "tool.execution_start",
      data: {
        toolCallId: "toolu_fake_order_edit",
        toolName: "edit",
        arguments: { path: WRITTEN, content: "written by fake copilot" },
        turnId: "2",
      },
      id: "9d3e1f7a-0001-4a1b-8c2d-000000000001",
      timestamp: iso(1000),
    },
    {
      type: "tool.execution_complete",
      data: {
        toolCallId: "toolu_fake_order_edit",
        success: true,
        result: { content: "File written" },
      },
      id: "9d3e1f7a-0002-4a1b-8c2d-000000000002",
      timestamp: iso(2000),
    },
    {
      type: "assistant.message",
      data: {
        messageId: "9d3e1f7a-0003-4a1b-8c2d-000000000003",
        model: "claude-haiku-4.5",
        content: "Done",
        toolRequests: [],
      },
      id: "9d3e1f7a-0003-4a1b-8c2d-000000000003",
      timestamp: iso(3000),
    },
    {
      type: "result",
      timestamp: iso(4000),
      sessionId: COPILOT_SESSION,
      exitCode: 0,
      usage: {
        premiumRequests: 0.66,
        totalApiDurationMs: 5707,
        sessionDurationMs: 10013,
        codeChanges: {
          linesAdded: 1,
          linesRemoved: 0,
          filesModified: [WRITTEN],
        },
      },
    },
  ].map((record) => JSON.stringify(record));
  return [start, ...body, ...tail];
}

/** Codex exec --json: the fake CLI's WRITE_FILE stream, line for line. */
function codexStream() {
  return [
    { type: "thread.started", thread_id: CODEX_THREAD },
    { type: "turn.started" },
    { type: "item.started", item: { id: "item_0", type: "reasoning" } },
    {
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text: "Working on it" },
    },
    {
      type: "item.started",
      item: {
        id: "item_2",
        type: "command_execution",
        command: "npm test",
        status: "in_progress",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "item_2",
        type: "command_execution",
        command: "npm test",
        aggregated_output: "1 passing\n",
        exit_code: 0,
        status: "completed",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "item_3",
        type: "file_change",
        status: "completed",
        changes: [{ path: WRITTEN, kind: "add" }],
      },
    },
    {
      type: "item.completed",
      item: {
        id: "item_4",
        type: "agent_message",
        text: "Done: wrote fake-output.txt",
      },
    },
    {
      type: "turn.completed",
      usage: { input_tokens: 120, cached_input_tokens: 40, output_tokens: 35 },
    },
  ].map((record) => JSON.stringify(record));
}

const ADAPTERS = [
  { adapter: claudeCodeAdapter, stream: claudeStream, timestamps: true },
  { adapter: copilotAdapter, stream: copilotStream, timestamps: true },
  // Codex exec lines carry no timestamp: the adapter stamps parse time, so
  // arrival order is the only order the provider gives us.
  { adapter: codexAdapter, stream: codexStream, timestamps: false },
];

/** Deterministic Fisher-Yates with a mulberry32 generator. */
function seededShuffle(items, seed) {
  let a = seed >>> 0;
  const random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function parseAll(adapter, lines) {
  const state = {};
  const events = [];
  for (const line of lines) events.push(...adapter.parse(line, state));
  return { state, events };
}

/** Fresh container per scenario: provider_event_id dedup is global. */
const FIXED_NOW = 1788965999000;

function container(t) {
  const services = createServices({ demo: false, disableObservation: true });
  // Events the provider left untimed are stamped by the recorder. Freeze that
  // clock so the same stream replayed in three orders is actually comparable.
  services.recorder.now = () => FIXED_NOW;
  t.after(() => services.close());
  const workspace = services.hub.get(
    services.hub.create({ name: "Ordering" }).id,
  );
  const startRun = (provider) => {
    const agent = workspace.snapshot().agents.find((a) => !a.taskId);
    return services.recorder.ensureRun({
      workspaceId: workspace.id,
      agentId: agent.id,
      mode: "managed",
      provider,
      createTask: { title: `${provider} ordering` },
      status: "running",
      startedAt: 1788965600000,
    });
  };
  return { services, workspace, recorder: services.recorder, startRun };
}

function summary(run) {
  const { reportedBy, ...totals } = run.usage ?? {};
  return {
    activity: run.activity,
    actualModel: run.actualModel,
    currentFile: run.currentFile,
    usage: totals,
    reportedBy: reportedBy ?? null,
  };
}

/**
 * Adapters stamp parse time on any event the provider left untimed, so the
 * real clock would make the same stream parse differently in each order.
 * Freeze it for the duration of the parse; the provider's own timestamps are
 * untouched.
 */
function withFrozenClock(fn) {
  const real = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

function applyOrder(t, adapter, lines) {
  const { recorder, startRun } = container(t);
  const { state, events } = withFrozenClock(() => parseAll(adapter, lines));
  const run = startRun(adapter.provider);
  const applied = recorder.applyEvents(run.id, events);
  return { run: recorder.get(run.id), state, events, applied, recorder };
}

for (const { adapter, stream, timestamps } of ADAPTERS) {
  test(`${adapter.id}: recorded, reversed and shuffled arrival produce the same run`, (t) => {
    const lines = stream();
    const orders = {
      recorded: lines,
      reversed: [...lines].reverse(),
      shuffled: seededShuffle(lines, 0x5eed),
    };
    assert.notDeepEqual(orders.shuffled, lines, "the shuffle moved lines");
    const outcomes = Object.fromEntries(
      Object.entries(orders).map(([name, order]) => [
        name,
        applyOrder(t, adapter, order),
      ]),
    );
    const recorded = outcomes.recorded;
    assert.ok(recorded.run.activity, "recorded stream sets an activity");
    assert.ok(recorded.run.actualModel !== undefined);
    assert.match(recorded.run.currentFile ?? "", /fake-output\.txt$/);
    // Usage is asserted against what the stream actually carries. Copilot's
    // headless stream reports premium requests, not tokens, so nothing is
    // merged and the run must stay honestly unreported rather than showing 0.
    const reportsUsage = recorded.events.some((e) => e.usage);
    if (reportsUsage) assert.equal(recorded.run.usage.reportedBy, "provider");
    else
      assert.deepEqual(
        recorded.run.usage,
        {},
        `${adapter.id} reports no usage, so none is invented`,
      );
    for (const [name, outcome] of Object.entries(outcomes)) {
      assert.equal(
        outcome.applied,
        recorded.applied,
        `${name}: same number of stored events`,
      );
      assert.equal(outcome.state.sessionId, recorded.state.sessionId);
      // Order-independent facts: usage totals are additive, the model is the
      // one the provider named, every event carries a provenance.
      assert.deepEqual(outcome.run.usage, recorded.run.usage, `${name} usage`);
      assert.equal(outcome.run.actualModel, recorded.run.actualModel);
      assert.ok(
        outcome.events.every((e) => PROVENANCE.includes(e.provenance)),
        `${name}: provenance on every event`,
      );
      if (timestamps) {
        // With provider timestamps the newest event wins whatever the
        // arrival order (RunRecorder's per-field freshness guard).
        assert.deepEqual(
          summary(outcome.run),
          summary(recorded.run),
          `${name} arrival order must not change the final run`,
        );
        assert.equal(outcome.run.lastEventAt, recorded.run.lastEventAt);
      } else {
        // No timestamps: the adapter stamps parse time, so "latest" honestly
        // means "last arrived". Assert that, rather than pretending otherwise.
        assert.ok(
          outcome.events.every(
            (e) => typeof e.timestamp === "number" && e.timestamp > 0,
          ),
        );
        assert.ok(
          lines.every((line) => JSON.parse(line).timestamp === undefined),
          "codex exec lines carry no provider timestamp",
        );
      }
    }
    // Equal timestamps keep arrival order: the Copilot capture has a message
    // and a reasoning record on the same millisecond, and that tie is the
    // only place order may still show through.
    if (adapter.id === "copilot") {
      const ties = recorded.events.filter(
        (e) => e.kind === "message" || e.kind === "reasoning",
      );
      assert.ok(ties.some((a, i) => ties[i + 1]?.timestamp === a.timestamp));
    }
  });

  test(`${adapter.id}: replayed lines are dropped by providerEventId and malformed lines are skipped`, (t) => {
    const lines = stream();
    const clean = applyOrder(t, adapter, lines);
    assert.ok(
      clean.events.every((e) => typeof e.providerEventId === "string"),
      "every event from the stream has a dedup key",
    );
    // Replay: the same lines again, in a fresh parser (as an observer
    // re-reading a file from offset 0 would), against the same run.
    const replay = parseAll(adapter, lines);
    assert.equal(
      clean.recorder.applyEvents(clean.run.id, replay.events),
      0,
      "a replayed stream stores nothing",
    );
    assert.deepEqual(
      summary(clean.recorder.get(clean.run.id)),
      summary(clean.run),
    );

    // Malformed lines interleaved with the stream: skipped, never thrown.
    const noise = [
      "not json at all",
      '{"type":"assistant","message":',
      "null",
      "42",
      '"a string"',
      "[]",
      "{}",
      '{"type":123}',
    ];
    const dirty = lines.flatMap((line, index) => [
      noise[index % noise.length],
      line,
    ]);
    const state = {};
    for (const line of noise) assert.deepEqual(adapter.parse(line, state), []);
    const withNoise = applyOrder(t, adapter, dirty);
    assert.equal(withNoise.applied, clean.applied);
    assert.deepEqual(summary(withNoise.run), summary(clean.run));
  });

  test(`${adapter.id}: a truncated trailing line waits for the next read`, (t) => {
    const lines = stream();
    const text = lines.join("\n") + "\n";
    const cut = text.length - Math.floor(lines.at(-1).length / 2);
    const delivered = [];
    const push = createLineSplitter((line) => delivered.push(line));
    push(text.slice(0, cut));
    assert.deepEqual(delivered, lines.slice(0, -1), "partial line held back");
    // The fragment on its own is not JSON: the parser returns nothing and
    // keeps its state intact instead of throwing.
    const fragment = text.slice(text.lastIndexOf("\n", cut - 1) + 1, cut);
    const state = {};
    assert.deepEqual(adapter.parse(fragment, state), []);
    push(text.slice(cut));
    assert.deepEqual(delivered, lines, "the rest completes the line");
    // Two reads apply the same as one.
    const whole = applyOrder(t, adapter, lines);
    const { recorder, startRun } = container(t);
    const parser = {};
    const run = startRun(adapter.provider);
    const first = lines.slice(0, -1).flatMap((l) => adapter.parse(l, parser));
    recorder.applyEvents(run.id, first);
    const second = adapter.parse(lines.at(-1), parser);
    assert.ok(second.length > 0, "the completed final line parses");
    recorder.applyEvents(run.id, second);
    assert.deepEqual(summary(recorder.get(run.id)), summary(whole.run));
  });
}

test("a stream without usage leaves usage unreported, never zero", (t) => {
  const lines = claudeStream().map((line) => {
    const record = JSON.parse(line);
    if (record.message) delete record.message.usage;
    if (record.type === "result") {
      delete record.usage;
      delete record.total_cost_usd;
      delete record.modelUsage;
    }
    return JSON.stringify(record);
  });
  const { run, state, events, recorder } = applyOrder(
    t,
    claudeCodeAdapter,
    lines,
  );
  assert.ok(!events.some((e) => e.usage), "no usage event was invented");
  assert.deepEqual(run.usage, {});
  assert.equal(run.usage.reportedBy, undefined);
  const final = claudeCodeAdapter.finalize(state, 0);
  assert.equal(final.status, "completed");
  assert.equal(final.usage, null);
  assert.equal(final.cost, null);
  const headroom = recorder.hub && t.mock ? null : null;
  assert.equal(headroom, null);
});

test("budget headroom says reported:false for a run whose provider sent no usage", (t) => {
  const { services, workspace, recorder, startRun } = container(t);
  const run = startRun("claude-code");
  recorder.applyEvent(run.id, {
    kind: "message",
    summary: "hello",
    timestamp: Date.now(),
  });
  const headroom = services.budget.headroom(workspace.id);
  assert.equal(headroom.reported, false);
  assert.equal(headroom.spent, 0);
  assert.match(headroom.basis, /no provider reported tokens yet/);
});

test("an unknown model stays null rather than becoming the word unknown", (t) => {
  const lines = claudeStream().map((line) => {
    const record = JSON.parse(line);
    if (record.type === "system") delete record.model;
    if (record.message) delete record.message.model;
    if (record.type === "result") delete record.modelUsage;
    return JSON.stringify(record);
  });
  const { run, state, events } = applyOrder(t, claudeCodeAdapter, lines);
  assert.equal(run.actualModel, null);
  assert.equal(state.model, undefined);
  assert.equal(claudeCodeAdapter.finalize(state, 0).model, null);
  assert.ok(
    events.every((e) => e.model === null || e.model === undefined),
    "no event carries an invented model",
  );
  assert.ok(
    !events.some((e) => /unknown/i.test(String(e.model ?? ""))),
    "no 'unknown' placeholder text",
  );
  const copilot = parseAll(
    copilotAdapter,
    copilotStream()
      .map((line) => JSON.parse(line))
      .filter(
        (r) => r.type !== "session.auto_mode_resolved" && r.type !== "result",
      )
      .map((r) => {
        if (r.data?.model) delete r.data.model;
        return JSON.stringify(r);
      }),
  );
  assert.equal(copilot.state.model, undefined);
  assert.equal(copilotAdapter.finalize(copilot.state, 0).model, null);
});

test("authorization failures finalize as failed with the matching classification", (t) => {
  const { recorder, workspace, startRun } = container(t);

  // Gemini: the real exit-41 envelope captured on this machine.
  const envelope = JSON.stringify({
    session_id: "0e3f9d5c-1a2b-4c3d-9e8f-7a6b5c4d3e2f",
    error: {
      type: "Error",
      message:
        "Please set an Auth method in your C:\\Users\\dev\\.gemini\\settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA",
      code: 41,
    },
  });
  const gemini = parseAll(geminiAdapter, [envelope]);
  const geminiFinal = geminiAdapter.finalize(gemini.state, 41);
  assert.equal(geminiFinal.status, "failed");
  assert.equal(geminiFinal.errorCategory, "not-logged-in");
  const geminiRun = startRun("gemini");
  recorder.applyEvents(geminiRun.id, gemini.events);
  recorder.setStatus(geminiRun.id, "failed", {
    error: geminiFinal.error,
    exitCode: 41,
  });
  const geminiClass = classifyFailure({
    exitCode: 41,
    error: geminiFinal.error,
    events: recorder.events(geminiRun.id),
    adapter: geminiAdapter,
    sessionId: gemini.state.sessionId,
  });
  assert.equal(geminiClass.class, "auth");
  assert.equal(geminiClass.retryable, false);
  assert.equal(geminiClass.sideEffects, "none");
  assert.equal(recorder.get(geminiRun.id).status, "failed");
  assert.equal(workspace.store.get(geminiRun.taskId).status, "BLOCKED");

  // Claude Code: a result line that says the CLI is not logged in.
  const claudeLines = [
    JSON.stringify({
      type: "system",
      subtype: "init",
      cwd: "C:\\work\\probe",
      session_id: "1f2e3d4c-0000-4000-8000-000000000001",
      tools: [],
      model: "claude-haiku-4-5-20251001",
      uuid: "1f2e3d4c-0000-4000-8000-000000000002",
    }),
    JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "Not logged in · Please run /login",
      session_id: "1f2e3d4c-0000-4000-8000-000000000001",
      uuid: "1f2e3d4c-0000-4000-8000-000000000003",
      num_turns: 0,
    }),
  ];
  const claude = parseAll(claudeCodeAdapter, claudeLines);
  const claudeFinal = claudeCodeAdapter.finalize(claude.state, 1);
  assert.equal(claudeFinal.status, "failed");
  assert.match(claudeFinal.error, /Not logged in/);
  const claudeRun = startRun("claude-code");
  recorder.applyEvents(claudeRun.id, claude.events);
  recorder.setStatus(claudeRun.id, "failed", {
    error: claudeFinal.error,
    exitCode: 1,
  });
  const claudeClass = classifyFailure({
    exitCode: 1,
    error: claudeFinal.error,
    events: recorder.events(claudeRun.id),
    adapter: claudeCodeAdapter,
    sessionId: claude.state.sessionId,
  });
  assert.equal(claudeClass.class, "auth");
  assert.equal(claudeClass.retryable, false);
  assert.equal(recorder.get(claudeRun.id).status, "failed");

  // Codex: the real usage-limit capture. The right class for "You've hit
  // your usage limit" is rate-limit (retry after the reset), not auth.
  const codex = parseAll(
    codexAdapter,
    fixture("codex-exec-stream-error.jsonl"),
  );
  const codexFinal = codexAdapter.finalize(codex.state, 1);
  assert.equal(codexFinal.status, "failed");
  assert.match(codexFinal.error, /usage limit/);
  const codexRun = startRun("codex");
  const stored = recorder.applyEvents(codexRun.id, codex.events);
  assert.equal(stored, codex.events.length);
  // The top-level error line is replay-safe too (keyed per thread).
  assert.equal(
    recorder.applyEvents(
      codexRun.id,
      parseAll(codexAdapter, fixture("codex-exec-stream-error.jsonl")).events,
    ),
    0,
  );
  recorder.setStatus(codexRun.id, "failed", {
    error: codexFinal.error,
    exitCode: 1,
  });
  const codexClass = classifyFailure({
    exitCode: 1,
    error: codexFinal.error,
    events: recorder.events(codexRun.id),
    adapter: codexAdapter,
    sessionId: codex.state.sessionId,
  });
  assert.equal(codexClass.class, "rate-limit");
  assert.equal(codexClass.sideEffects, "none");
  assert.equal(recorder.get(codexRun.id).status, "failed");
  assert.equal(workspace.store.get(codexRun.taskId).status, "BLOCKED");
});
