import test from "node:test";
import assert from "node:assert/strict";
import {
  EPISODE_FRESH_MS,
  EPISODE_MS,
  KICKOFF_MAX,
  episodeAgents,
  episodePhase,
  facingToward,
  helperSpot,
  huddleSpots,
  meetingSpot,
  planEpisodes,
  planKickoffs,
} from "../apps/web/src/office/episodes.js";
import {
  relayLabel,
  relayName,
  relayPresence,
  workflowRelays,
} from "../apps/web/src/office/relay.js";
import { isOnFloor } from "../apps/web/src/office/presence.js";
import { activityLabel } from "../apps/web/src/office/data.js";
import { buildChoreography } from "../apps/web/src/office/choreography.js";

/**
 * Moments are played only for recorded interactions, once each, and only
 * while they are news.
 */

const handoff = (id, at, from = "atlas", to = "nova") => ({
  id,
  kind: "handoff",
  fromAgentId: from,
  toAgentId: to,
  label: "Architecture brief",
  timestamp: at,
});

test("a fresh recorded handoff plays once; an old one never does", () => {
  const now = 1_000_000;
  const played = new Set();
  const first = planEpisodes({
    interactions: [
      handoff("h1", now - 5_000),
      handoff("old", now - EPISODE_FRESH_MS - 1),
    ],
    now,
    played,
  });
  assert.deepEqual(
    first.map((episode) => episode.id),
    ["h1"],
  );
  assert.equal(first[0].duration, EPISODE_MS.handoff);
  // Both are now remembered: neither plays again.
  assert.ok(played.has("h1") && played.has("old"));
  assert.deepEqual(
    planEpisodes({ interactions: [handoff("h1", now)], now, played }),
    [],
  );
});

test("an agent already in a moment waits instead of being pulled two ways", () => {
  const now = 2_000_000;
  const played = new Set();
  const started = planEpisodes({
    interactions: [
      handoff("a", now - 3000, "atlas", "nova"),
      handoff("b", now - 2000, "nova", "pixel"),
      handoff("c", now - 1000, "echo", "sage"),
    ],
    now,
    played,
  });
  assert.deepEqual(
    started.map((episode) => episode.id),
    ["a", "c"],
  );
  // "b" is not dropped: it plays once Nova is free.
  assert.equal(played.has("b"), false);
  assert.deepEqual(
    planEpisodes({
      interactions: [handoff("b", now - 2000, "nova", "pixel")],
      now: now + 100,
      played,
    }).map((episode) => episode.id),
    ["b"],
  );
});

test("interactions without both agents, or with no time, never play", () => {
  const played = new Set();
  const started = planEpisodes({
    interactions: [
      {
        id: "x",
        kind: "handoff",
        fromAgentId: "atlas",
        toAgentId: null,
        timestamp: 10,
      },
      {
        id: "y",
        kind: "handoff",
        fromAgentId: "atlas",
        toAgentId: "atlas",
        timestamp: 10,
      },
      { id: "z", kind: "handoff", fromAgentId: "atlas", toAgentId: "nova" },
      {
        id: "w",
        kind: "gossip",
        fromAgentId: "atlas",
        toAgentId: "nova",
        timestamp: 10,
      },
    ],
    now: 20,
    played,
  });
  assert.deepEqual(started, []);
  assert.equal(played.size, 4);
});

test("a moment walks there, exchanges, walks back, then ends", () => {
  const episode = { startAt: 0, duration: 1000 };
  assert.equal(episodePhase(episode, 100).phase, "approach");
  assert.equal(episodePhase(episode, 500).phase, "exchange");
  assert.equal(episodePhase(episode, 900).phase, "return");
  assert.equal(episodePhase(episode, 1000).phase, "done");
  const mid = episodePhase(episode, 500);
  assert.ok(mid.t > 0 && mid.t < 1);
});

test("the giver meets the receiver face to face, beside and in front of the desk", () => {
  const receiver = { x: 0, z: 0 };
  const spot = meetingSpot({ x: 3, z: 0 }, receiver);
  assert.ok(Math.hypot(spot.x - receiver.x, spot.z - receiver.z) > 0.5);
  // Never behind the monitor (-z), where the desk is.
  assert.ok(spot.z > 0);
  // Facing each other: the two yaws differ by half a turn.
  const turn = Math.abs(spot.facing - spot.receiverFacing);
  assert.ok(Math.abs(turn - Math.PI) < 1e-6);
  assert.ok(Math.abs(facingToward(0, 0, 0, -1)) < 1e-9, "yaw 0 faces -z");
});

test("several helpers never share a spot beside their parent", () => {
  const parent = { x: 1, z: 1 };
  const spots = [0, 1, 2, 3, 4].map((i) => helperSpot(parent, i));
  assert.equal(new Set(spots.map((s) => `${s.x},${s.z}`)).size, 5);
  // Each faces its parent.
  for (const spot of spots)
    assert.ok(
      Math.abs(spot.facing - facingToward(spot.x, spot.z, parent.x, parent.z)) <
        1e-9,
    );
});

test("a workflow relay says who holds the baton and who waits on whom", async () => {
  const { workflowRelays, waitingLinks } =
    await import("../apps/web/src/office/relay.js");
  const agents = [
    { id: "atlas", name: "Atlas" },
    { id: "nova", name: "Nova" },
    { id: "pixel", name: "Pixel" },
  ];
  const task = (id, status, dependsOn, agent) => ({
    id,
    title: id,
    status,
    dependsOn,
    assignedAgentId: agent,
    workflowId: "wf1",
    templateId: "feature-delivery",
  });
  const tasks = [
    task("test", "QUEUE", ["build"], "pixel"),
    task("plan", "COMPLETED", [], "atlas"),
    task("build", "IN_PROGRESS", ["plan"], "nova"),
    { id: "solo", title: "solo", status: "QUEUE", dependsOn: [] },
  ];
  const [relay] = workflowRelays(tasks, agents);
  // Dependency order, whatever order the tasks came in.
  assert.deepEqual(
    relay.steps.map((step) => [step.taskId, step.state]),
    [
      ["plan", "done"],
      ["build", "active"],
      ["test", "waiting"],
    ],
  );
  assert.deepEqual(relay.holders, ["nova"]);
  assert.equal(relay.done, 1);
  assert.equal(relay.total, 3);
  const [link] = waitingLinks([relay]);
  assert.equal(link.fromAgentId, "pixel");
  assert.equal(link.toAgentId, "nova");
  assert.match(link.label, /Pixel waits for Nova/);
  // A finished workflow drops out; a one-step "workflow" is not a relay.
  assert.deepEqual(
    workflowRelays(
      tasks.map((t) => ({ ...t, status: "COMPLETED" })),
      agents,
    ),
    [],
  );
});

test("a recorded team kickoff gathers the known members once, while it is news", () => {
  const now = 5_000_000;
  const played = new Set();
  const known = new Set(["atlas", "nova", "echo"]);
  const team = {
    id: "team-1",
    members: ["atlas", "nova", "ghost", "echo"],
    label: "Team assembled",
    timestamp: now - 2000,
  };
  const [kickoff] = planKickoffs({ teams: [team], known, now, played });
  assert.equal(kickoff.kind, "kickoff");
  // A member the office does not know is left out, never drawn.
  assert.deepEqual(kickoff.members, ["atlas", "nova", "echo"]);
  assert.equal(kickoff.duration, EPISODE_MS.kickoff);
  assert.deepEqual(episodeAgents(kickoff), ["atlas", "nova", "echo"]);
  assert.deepEqual(planKickoffs({ teams: [team], known, now, played }), []);
  // Old news, or a team of one to gather with, plays nothing.
  assert.deepEqual(
    planKickoffs({
      teams: [{ ...team, id: "old", timestamp: now - EPISODE_FRESH_MS - 1 }],
      known,
      now,
      played,
    }),
    [],
  );
  assert.deepEqual(
    planKickoffs({
      teams: [{ ...team, id: "solo", members: ["atlas", "ghost"] }],
      known,
      now,
      played,
    }),
    [],
  );
  // Members already in another moment sit this one out.
  const busy = planKickoffs({
    teams: [{ ...team, id: "busy" }],
    known,
    now,
    played,
    busy: new Set(["nova"]),
  });
  assert.deepEqual(busy[0].members, ["atlas", "echo"]);
});

test("a huddle spreads its members round the table, never two on one slot", () => {
  const slots = Array.from({ length: 8 }, (_, i) => ({
    x: i,
    z: 0,
    facing: 0,
  }));
  const zone = { slots };
  assert.deepEqual(
    huddleSpots(zone, 3).map((spot) => spot.x),
    [0, 4, 7],
  );
  const all = huddleSpots(zone, 12);
  assert.equal(all.length, 8);
  assert.equal(new Set(all.map((spot) => spot.x)).size, 8);
  assert.ok(KICKOFF_MAX <= slots.length);
  assert.deepEqual(huddleSpots({ slots: [] }, 3), []);
});

test("members of a live relay stand waiting; a stalled relay puts nobody on the floor", () => {
  const agents = [
    { id: "a", name: "Atlas" },
    { id: "n", name: "Nova" },
    { id: "e", name: "Echo" },
  ];
  const tasks = [
    {
      id: "1",
      title: "Plan",
      status: "IN_PROGRESS",
      workflowId: "w",
      assignedAgentId: "a",
    },
    {
      id: "2",
      title: "Build",
      status: "QUEUE",
      workflowId: "w",
      assignedAgentId: "n",
      dependsOn: ["1"],
    },
    {
      id: "3",
      title: "Check",
      status: "QUEUE",
      workflowId: "w",
      assignedAgentId: "e",
      dependsOn: ["2"],
      templateId: "bug-clinic",
    },
  ];
  const relays = workflowRelays(tasks, agents);
  const waiting = relayPresence(relays);
  assert.deepEqual([...waiting.keys()].sort(), ["e", "n"]);
  assert.equal(relayLabel(waiting.get("n")), "Waiting for Atlas");
  assert.equal(relayLabel(waiting.get("e")), "Waiting for Nova");
  assert.equal(relayName(relays[0]), "Bug clinic");
  assert.equal(relayName({}), "Team relay");
  // On the floor, and saying why, only because the relay is live.
  const nova = {
    id: "n",
    name: "Nova",
    state: "IDLE",
    relay: waiting.get("n"),
  };
  assert.equal(isOnFloor(nova), true);
  assert.equal(activityLabel(nova), "Waiting for Atlas");
  assert.equal(isOnFloor({ id: "n", state: "IDLE" }), false);
  // Nobody working on it: nobody stands waiting.
  const stalled = tasks.map((task) =>
    task.id === "1" ? { ...task, status: "COMPLETED" } : task,
  );
  const stalledPresence = relayPresence(workflowRelays(stalled, agents));
  assert.deepEqual([...stalledPresence.keys()], []);
  // A step whose dependencies are done but that nobody started is "ready".
  const ready = relayPresence(
    workflowRelays(
      [
        ...stalled.filter((task) => task.id !== "3"),
        { ...tasks[2], status: "IN_PROGRESS", assignedAgentId: "e" },
      ],
      agents,
    ),
  );
  assert.equal(relayLabel(ready.get("n")), "Ready to start");
});

test("the office draws the six newest handoffs, not the six oldest", () => {
  const agents = [
    { id: "a", name: "Atlas" },
    { id: "n", name: "Nova" },
  ];
  // Events arrive newest first.
  const handoffs = Array.from({ length: 9 }, (_, i) => ({
    id: `h${9 - i}`,
    fromAgentId: "a",
    toAgentId: "n",
    taskTitle: `Step ${9 - i}`,
    timestamp: 1000 + (9 - i),
    simulated: i === 0,
  }));
  const { interactions } = buildChoreography({ agents, handoffs });
  assert.deepEqual(
    interactions.map((item) => item.id),
    ["h4", "h5", "h6", "h7", "h8", "h9"],
  );
  assert.equal(interactions.at(-1).simulated, true);
});

test("desks stay put while agents come and go; at most one figure moves", async () => {
  const { stableDeskOrder } = await import("../apps/web/src/office/scale.js");
  // First look: roster order.
  let order = stableDeskOrder([], ["a", "b", "c", "d"]);
  assert.deepEqual(order, ["a", "b", "c", "d"]);
  // An arrival in the middle of the roster takes a new desk at the end.
  order = stableDeskOrder(order, ["a", "e", "b", "c", "d"]);
  assert.deepEqual(order, ["a", "b", "c", "d", "e"]);
  // A departure: the last agent takes the free desk, nobody else moves.
  order = stableDeskOrder(order, ["a", "c", "d", "e"]);
  assert.deepEqual(order, ["a", "e", "c", "d"]);
  // The last agent leaving moves nobody.
  assert.deepEqual(stableDeskOrder(order, ["a", "e", "c"]), ["a", "e", "c"]);
  // Everyone leaving, and several at once.
  assert.deepEqual(stableDeskOrder(order, []), []);
  assert.deepEqual(stableDeskOrder(["a", "b", "c", "d", "e"], ["b", "e"]), [
    "e",
    "b",
  ]);
});
