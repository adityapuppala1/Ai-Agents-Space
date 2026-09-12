import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TURNS,
  TURN_LIMIT,
  buildConversation,
  replyState,
} from "../packages/core/src/runs/conversation.js";

/**
 * Reading a chain of runs back as the exchange a person actually had.
 * Pure arithmetic over rows, so no database and no server.
 */

const run = (id, attempt, prompt, extra = {}) => ({
  id,
  attempt,
  prompt,
  startedAt: `2026-09-12T10:0${attempt}:00.000Z`,
  mode: "managed",
  provider: "claude-code",
  ...extra,
});

const message = (text, sequence) => ({
  kind: "message",
  data: { text },
  sequence,
  timestamp: "2026-09-12T10:00:30.000Z",
  provenance: "provider",
});

test("a chain of attempts reads back as one exchange", () => {
  const runs = [run("r1", 1, "Add a health check"), run("r2", 2, "Now add a test")];
  const events = {
    r1: [message("I added /health.", 4), { kind: "file.write", data: {} }],
    r2: [message("Added a test for it.", 9)],
  };
  const { turns, truncated } = buildConversation(runs, (id) => events[id]);
  assert.equal(truncated, false);
  assert.deepEqual(
    turns.map((t) => [t.role, t.text]),
    [
      ["you", "Add a health check"],
      ["agent", "I added /health."],
      ["you", "Now add a test"],
      ["agent", "Added a test for it."],
    ],
  );
  // Each turn says which attempt it belongs to, so a follow-up is visibly a
  // new attempt rather than one long session.
  assert.deepEqual(
    turns.map((t) => t.attempt),
    [1, 1, 2, 2],
  );
  assert.equal(turns[1].provenance, "provider");
  assert.equal(turns[0].provenance, "recorded");
});

test("only recorded messages become answers", () => {
  const { turns } = buildConversation([run("r1", 1, "Do the thing")], () => [
    { kind: "file.write", data: { text: "not a message" } },
    { kind: "command", message: "npm test" },
    { kind: "message", data: {} },
    { kind: "message", data: { text: "   " } },
  ]);
  assert.deepEqual(
    turns.map((t) => t.role),
    ["you"],
    "a run the provider never answered contributes no answer",
  );
});

test("a one-sided exchange is allowed, because sometimes it was", () => {
  // No prompt recorded: no question is invented for it.
  const { turns } = buildConversation([run("r1", 1, null)], () => [
    message("Started without a stored prompt.", 1),
  ]);
  assert.deepEqual(
    turns.map((t) => t.role),
    ["agent"],
  );
});

test("a very long turn is trimmed and says so", () => {
  const long = "x".repeat(TURN_LIMIT + 500);
  const { turns, trimmed } = buildConversation([run("r1", 1, long)], () => []);
  assert.equal(trimmed, true);
  assert.ok(turns[0].text.length < long.length);
  assert.match(turns[0].text, /\[trimmed: 500 more characters\]$/);
});

test("a very long exchange keeps the most recent turns", () => {
  const runs = [];
  for (let i = 1; i <= MAX_TURNS + 20; i += 1) runs.push(run(`r${i}`, i, `ask ${i}`));
  const { turns, truncated } = buildConversation(runs, () => []);
  assert.equal(truncated, true);
  assert.equal(turns.length, MAX_TURNS);
  assert.equal(turns[turns.length - 1].text, `ask ${MAX_TURNS + 20}`);
});

test("empty input is an empty conversation, not an error", () => {
  assert.deepEqual(buildConversation(), { turns: [], truncated: false, trimmed: false });
  assert.deepEqual(buildConversation([{ noId: true }], () => []).turns, []);
});

const resumable = { supportsResume: true, name: "Claude Code" };

test("a reply is offered only when the server would accept it", () => {
  const finished = run("r1", 1, "hi", { providerSessionId: "s1" });
  const ok = replyState(finished, resumable);
  assert.equal(ok.can, true);
  // The surprising part is stated rather than hidden.
  assert.match(ok.note, /new attempt/);
});

test("a run that is still working says it cannot be interrupted", () => {
  const state = replyState(
    run("r1", 1, "hi", { providerSessionId: "s1" }),
    resumable,
    { active: true },
  );
  assert.equal(state.can, false);
  assert.equal(state.pending, true);
  assert.match(state.reason, /cannot be interrupted/);
  // And it names what you can do instead.
  assert.match(state.reason, /finishes|cancelled/);
});

test("each refusal explains itself in the words the interface should use", () => {
  assert.match(replyState(null).reason, /no run/i);
  assert.match(
    replyState(run("r1", 1, "hi", { mode: "observed" }), resumable).reason,
    /outside Agent Space/,
  );
  assert.match(
    replyState(run("r1", 1, "hi", { mode: "recorded" }), resumable).reason,
    /recorded here only/,
  );
  assert.match(
    replyState(run("r1", 1, "hi", { providerSessionId: "s1" }), {
      supportsResume: false,
      name: "Copilot",
    }).reason,
    /Copilot cannot resume/,
  );
  assert.match(
    replyState(run("r1", 1, "hi"), resumable).reason,
    /No provider session id/,
  );
});
