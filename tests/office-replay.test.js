import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVITY_FOR_KIND,
  activityOfEvent,
  agentsAt,
  recordedAt,
  replayRange,
  timeOf,
} from "../apps/web/src/office/replay.js";
import { EVENT_KINDS } from "../packages/core/src/contracts.js";

/**
 * Reading the floor back as it was. Pure records in, records out — so the
 * rules that matter (never invent a position, never claim a live run) are
 * checked without a browser.
 */

const agents = [
  { id: "nova", name: "Nova" },
  { id: "echo", name: "Echo" },
];

const at = (iso) => Date.parse(iso);
const event = (agentId, kind, iso, extra = {}) => ({
  agentId,
  kind,
  timestamp: iso,
  ...extra,
});

const timeline = [
  event("nova", "file.read", "2026-09-12T10:00:00.000Z", { file: "a.js" }),
  event("nova", "file.edit", "2026-09-12T10:05:00.000Z", { file: "b.js" }),
  event("echo", "test", "2026-09-12T10:07:00.000Z"),
  event("nova", "command", "2026-09-12T10:10:00.000Z"),
];

test("timestamps are read as ISO strings and as epoch milliseconds", () => {
  assert.equal(timeOf("2026-09-12T10:00:00.000Z"), at("2026-09-12T10:00:00.000Z"));
  assert.equal(timeOf(1757671200000), 1757671200000);
  assert.equal(timeOf(null), null);
  assert.equal(timeOf("not a time"), null);
  assert.equal(timeOf(Number.NaN), null);
});

test("the window offered is only as wide as the evidence", () => {
  const range = replayRange(timeline);
  assert.equal(range.from, at("2026-09-12T10:00:00.000Z"));
  assert.equal(range.to, at("2026-09-12T10:10:00.000Z"));
  // Nothing recorded is nothing to replay, rather than a window of now.
  assert.equal(replayRange([]), null);
  assert.equal(replayRange(), null);
  assert.equal(replayRange([{ kind: "message" }]), null);
});

test("an agent shows the last thing it was recorded doing", () => {
  const mid = agentsAt(agents, timeline, at("2026-09-12T10:06:00.000Z"));
  const nova = mid.find((a) => a.id === "nova");
  // At 10:06 Nova's most recent event is the 10:05 edit, not the 10:10 one.
  assert.equal(nova.activity, "CODING");
  assert.equal(nova.currentFile, "b.js");
  assert.equal(nova.activityProvenance, "inferred");
});

test("nothing is interpolated: the gap shows the last event, not a guess", () => {
  const later = agentsAt(agents, timeline, at("2026-09-12T10:09:59.000Z"));
  const nova = later.find((a) => a.id === "nova");
  assert.equal(nova.activity, "CODING", "still the 10:05 edit a second before the command");
  assert.equal(nova.currentFile, "b.js");
});

test("an agent with nothing recorded yet is idle, not absent and not invented", () => {
  const early = agentsAt(agents, timeline, at("2026-09-12T09:59:00.000Z"));
  assert.equal(early.length, 2, "who exists is not a question the events answer");
  for (const agent of early) {
    assert.equal(agent.activity, "IDLE");
    assert.equal(agent.currentFile, null);
    assert.equal(agent.activityProvenance, "replay");
  }
});

test("a replayed agent never claims a live run", () => {
  const frame = agentsAt(
    [{ id: "nova", name: "Nova", activeProviderRun: true, elapsedMs: 4000, runStatus: "running", subagents: [{ id: "s" }] }],
    timeline,
    at("2026-09-12T10:10:00.000Z"),
  );
  const nova = frame[0];
  assert.equal(nova.activeProviderRun, false);
  assert.equal(nova.elapsedMs, null);
  assert.equal(nova.runStatus, null);
  assert.deepEqual(nova.subagents, []);
  // Every figure carries the mark, so the scene cannot draw it as the present.
  assert.equal(nova.replay, true);
  assert.equal(nova.replayAt, at("2026-09-12T10:10:00.000Z"));
});

test("an activity the recorder stated outright is not called inferred", () => {
  const stated = activityOfEvent({
    kind: "file.edit",
    data: { activity: "REVIEWING" },
  });
  assert.deepEqual(stated, { value: "REVIEWING", inferred: false });
  // Read from the kind instead, and said to be inferred.
  assert.deepEqual(activityOfEvent({ kind: "test" }), {
    value: "TESTING",
    inferred: true,
  });
});

test("a kind that says nothing about doing leaves the agent as it was", () => {
  // usage and status are bookkeeping, not work.
  assert.equal(activityOfEvent({ kind: "usage" }), null);
  assert.equal(activityOfEvent({ kind: "status" }), null);
  assert.equal(activityOfEvent(null), null);
  const withNoise = [
    ...timeline,
    event("nova", "usage", "2026-09-12T10:11:00.000Z"),
  ];
  const after = agentsAt(agents, withNoise, at("2026-09-12T10:12:00.000Z"));
  assert.equal(
    after.find((a) => a.id === "nova").activity,
    "COMMANDING",
    "the usage event does not blank out the command before it",
  );
});

test("every activity a kind maps to is one the office knows", () => {
  // A typo here would silently draw an agent as idle.
  const known = new Set([
    "CODING",
    "RESEARCHING",
    "ANALYZING",
    "COMMANDING",
    "TESTING",
    "MESSAGING",
    "DELEGATING",
    "WAITING_APPROVAL",
    "ERROR",
  ]);
  for (const [kind, activity] of Object.entries(ACTIVITY_FOR_KIND)) {
    assert.ok(known.has(activity), `${kind} maps to unknown activity ${activity}`);
    assert.ok(
      EVENT_KINDS.includes(kind),
      `${kind} is not a kind the recorder ever writes`,
    );
  }
});

test("a quiet minute is reported as quiet rather than as broken", () => {
  assert.equal(recordedAt(agents, timeline, at("2026-09-12T09:00:00.000Z")), 0);
  assert.equal(recordedAt(agents, timeline, at("2026-09-12T10:07:30.000Z")), 2);
});

test("ties are broken by the order the recorder wrote them", () => {
  const same = "2026-09-12T11:00:00.000Z";
  const frame = agentsAt(
    [{ id: "nova" }],
    [
      event("nova", "file.edit", same, { sequence: 1 }),
      event("nova", "test", same, { sequence: 2 }),
    ],
    at(same),
  );
  assert.equal(frame[0].activity, "TESTING", "the later sequence wins");
});
