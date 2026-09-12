import test from "node:test";
import assert from "node:assert/strict";
import {
  describeOutcome,
  describePlan,
  roomMessagePlan,
} from "../apps/web/src/hooks/roomMessage.js";

/**
 * Saying one thing to everybody in a room. Each member has its own run, so
 * this is several actions and some will be refused — the rules that matter
 * are that the refusals are shown before sending, and that a partial success
 * is reported as one.
 */

const agent = (id, name) => ({ id, name });
const entries = [
  { agent: agent("a", "Ana"), runId: "r1", reply: { can: true } },
  {
    agent: agent("b", "Ben"),
    runId: "r2",
    reply: { can: false, reason: "This run is still working." },
  },
  { agent: agent("c", "Cass"), runId: null },
];

test("the room is split into who will hear it and who will not", () => {
  const plan = roomMessagePlan(entries);
  assert.deepEqual(
    plan.willReceive.map((entry) => entry.name),
    ["Ana"],
  );
  assert.deepEqual(
    plan.cannot.map((entry) => [entry.name, entry.reason]),
    [
      ["Ben", "This run is still working."],
      ["Cass", "has no run to continue."],
    ],
  );
});

test("a refusal keeps the server's own words, so the two cannot disagree", () => {
  const plan = roomMessagePlan([
    {
      agent: agent("d", "Dev"),
      runId: "r4",
      reply: { can: false, reason: "Copilot cannot resume a session." },
    },
  ]);
  assert.equal(plan.cannot[0].reason, "Copilot cannot resume a session.");
  // No answer from the server is still a refusal, never an assumed yes.
  const silent = roomMessagePlan([{ agent: agent("e", "Eve"), runId: "r5" }]);
  assert.equal(silent.willReceive.length, 0);
  assert.equal(silent.cannot.length, 1);
});

test("the sentence above the button counts honestly", () => {
  assert.equal(
    describePlan(roomMessagePlan(entries)),
    "1 of 3 will receive this; the rest cannot be messaged.",
  );
  assert.equal(
    describePlan(roomMessagePlan([entries[0]])),
    "1 member will receive this.",
  );
  assert.equal(
    describePlan(
      roomMessagePlan([entries[0], { ...entries[0], agent: agent("z", "Zed") }]),
    ),
    "All 2 members will receive this.",
  );
  assert.equal(
    describePlan(roomMessagePlan([entries[1]])),
    "Nobody here can be messaged: the one member would refuse it.",
  );
  assert.equal(describePlan(roomMessagePlan([])), "Nobody is in this room.");
});

test("a partial success is reported as a partial success", () => {
  assert.equal(
    describeOutcome([
      { name: "Ana", ok: true },
      { name: "Ben", ok: false, error: "409" },
      { name: "Cass", ok: false },
    ]),
    "Sent to 1; 2 refused: Ben, Cass.",
  );
  assert.equal(
    describeOutcome([{ name: "Ana", ok: true }]),
    "Sent to 1 agent; it starts a new attempt.",
  );
  assert.equal(
    describeOutcome([
      { name: "Ana", ok: true },
      { name: "Ben", ok: true },
    ]),
    "Sent to 2 agents; each starts a new attempt.",
  );
  assert.equal(
    describeOutcome([{ name: "Ben", ok: false }]),
    "Nothing was sent. Ben refused it.",
  );
  assert.equal(describeOutcome([]), "Nothing was sent.");
});

test("a member with no agent record is skipped rather than guessed at", () => {
  const plan = roomMessagePlan([{ runId: "r9", reply: { can: true } }, null]);
  assert.equal(plan.willReceive.length, 0);
  assert.equal(plan.cannot.length, 0);
});
