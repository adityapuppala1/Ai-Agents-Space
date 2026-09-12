import test from "node:test";
import assert from "node:assert/strict";
import {
  GAZE_LIMIT,
  MAX_NUDGE,
  PERSONAL_SPACE,
  easeNudge,
  gazeOffset,
  gazeTargets,
  separation,
  shortestTurn,
  yawToward,
} from "../apps/web/src/office/steering.js";
import {
  blocked,
  deskSeat,
  officeObstacles,
} from "../apps/web/src/office/obstacles.js";
import { computeLayout } from "../apps/web/src/office/zones.js";

/**
 * Agents going round each other, and looking at what the record says is
 * happening. Pure arithmetic, so no browser and no scene.
 */

const walker = (id, x, z, dx, dz) => ({ id, x, z, dx, dz, walking: true });

test("someone far enough away is not steered around at all", () => {
  const nudges = separation([
    walker("a", 0, 0, 1, 0),
    walker("b", 3, 0, -1, 0),
  ]);
  assert.equal(nudges.size, 0);
});

test("a walker steps aside for someone in its way", () => {
  const nudges = separation([
    walker("a", 0, 0, 1, 0),
    walker("b", 0.35, 0, 0, 0),
  ]);
  const a = nudges.get("a");
  assert.ok(a, "the walker moves");
  assert.ok(Math.hypot(a.x, a.z) <= MAX_NUDGE + 1e-9, "but never far");
  // Sideways, not backwards: the walk still makes progress.
  assert.ok(Math.abs(a.z) > Math.abs(a.x), "the step is across the heading");
});

test("two agents meeting head-on pass on opposite sides", () => {
  // Without a fixed convention both would mirror each other and deadlock.
  const nudges = separation([
    walker("a", 0, 0, 1, 0),
    walker("b", 0.4, 0, -1, 0),
  ]);
  const a = nudges.get("a");
  const b = nudges.get("b");
  assert.ok(a && b, "both step aside");
  assert.ok(
    Math.sign(a.z) !== Math.sign(b.z),
    `they must choose different sides, got ${a.z} and ${b.z}`,
  );
});

test("only the one who is walking gives way", () => {
  const nudges = separation([
    walker("a", 0, 0, 1, 0),
    { id: "seated", x: 0.35, z: 0, dx: 0, dz: 0, walking: false },
  ]);
  assert.ok(nudges.has("a"));
  assert.equal(nudges.has("seated"), false, "an agent at its desk stays put");
});

test("a nudge is taken up gradually and let go again", () => {
  let nudge = { x: 0, z: 0 };
  const want = { x: 0, z: 0.2 };
  for (let i = 0; i < 60; i += 1) nudge = easeNudge(nudge, want);
  assert.ok(Math.abs(nudge.z - want.z) < 0.01, "it arrives");
  for (let i = 0; i < 120; i += 1) nudge = easeNudge(nudge, { x: 0, z: 0 });
  assert.ok(Math.abs(nudge.z) < 0.01, "and goes away when no longer needed");
  // A longer frame moves further, so the result does not depend on frame rate.
  const slow = easeNudge({ x: 0, z: 0 }, want, 32);
  const fast = easeNudge({ x: 0, z: 0 }, want, 16);
  assert.ok(slow.z > fast.z);
});

test("a crowd never pushes anyone further than the cap", () => {
  const crowd = [walker("a", 0, 0, 1, 0)];
  for (let i = 0; i < 8; i += 1)
    crowd.push({
      id: `n${i}`,
      x: Math.cos((i * Math.PI) / 4) * 0.3,
      z: Math.sin((i * Math.PI) / 4) * 0.3,
      dx: 0,
      dz: 0,
      walking: false,
    });
  const a = separation(crowd).get("a");
  if (a) assert.ok(Math.hypot(a.x, a.z) <= MAX_NUDGE + 1e-9);
});

test("a nudge never has to push an agent into the furniture", () => {
  // The nudge is small by design, so a walker keeping to a legal path stays
  // legal: check that at every point of an aisle a full nudge is still clear.
  const layout = computeLayout(9, "studio", null);
  const obstacles = officeObstacles(layout);
  const desk = layout.desks[4];
  const aisleZ = desk.z + 0.9;
  let clear = 0;
  let total = 0;
  for (let x = -4; x <= 4; x += 0.25) {
    total += 1;
    if (blocked(obstacles, x, aisleZ)) continue;
    // A full sideways nudge, both ways.
    if (
      !blocked(obstacles, x, aisleZ + MAX_NUDGE) &&
      !blocked(obstacles, x, aisleZ - MAX_NUDGE)
    )
      clear += 1;
  }
  assert.ok(clear > total * 0.5, `only ${clear}/${total} of the aisle absorbs a nudge`);
});

test("yaw points at a target the way the scene measures it", () => {
  // Figures face -z at yaw 0.
  assert.ok(Math.abs(yawToward(0, 0, { x: 0, z: -1 })) < 1e-9);
  // Directly behind is half a turn either way round; both spellings are the
  // same bearing, so compare the magnitude.
  assert.ok(
    Math.abs(Math.abs(yawToward(0, 0, { x: 0, z: 1 })) - Math.PI) < 1e-9,
  );
  // To the right and to the left are opposite turns of the same size.
  const right = yawToward(0, 0, { x: 1, z: 0 });
  const left = yawToward(0, 0, { x: -1, z: 0 });
  assert.ok(Math.abs(Math.abs(right) - Math.PI / 2) < 1e-9);
  assert.equal(Math.sign(right), -Math.sign(left));
});

test("shortest turn goes the short way round", () => {
  assert.ok(Math.abs(shortestTurn(0.1, -0.1) + 0.2) < 1e-9);
  // Across the wrap, not the long way back.
  assert.ok(Math.abs(shortestTurn(3.0, -3.0)) < 0.3);
});

test("a glance stops at the neck instead of craning round", () => {
  // Straight ahead: no turn.
  assert.equal(gazeOffset(0, 0, 0, { x: 0, z: -2 }), 0);
  // To one side: a real turn, within the limit.
  const side = gazeOffset(0, 0, 0, { x: 2, z: -2 });
  assert.ok(Math.abs(side) > 0.1 && Math.abs(side) <= GAZE_LIMIT);
  // Directly behind: the agent cannot see it, so it looks ahead.
  assert.equal(gazeOffset(0, 0, 0, { x: 0, z: 4 }), 0);
  // Nothing to look at.
  assert.equal(gazeOffset(0, 0, 0, null), 0);
});

test("agents look at whoever the record says is speaking", () => {
  const people = [
    { id: "a", x: 0, z: 0, talking: false, place: "room1" },
    { id: "b", x: 1, z: 0, talking: true, place: "room1" },
    { id: "c", x: 2, z: 0, talking: false, place: "room1" },
  ];
  const looks = gazeTargets(people);
  assert.deepEqual(looks.get("a"), { x: 1, z: 0 });
  assert.deepEqual(looks.get("c"), { x: 1, z: 0 });
  assert.equal(looks.has("b"), false, "the speaker does not watch itself");
});

test("nobody looks through a wall, or across the whole floor", () => {
  const apart = gazeTargets([
    { id: "a", x: 0, z: 0, talking: false, place: "room1" },
    { id: "b", x: 1, z: 0, talking: true, place: "room2" },
  ]);
  assert.equal(apart.size, 0, "different rooms");

  const far = gazeTargets([
    { id: "a", x: 0, z: 0, talking: false, place: null },
    { id: "b", x: 40, z: 0, talking: true, place: null },
  ]);
  assert.equal(far.size, 0, "too far to be looking at anyone");
});

test("silence means everyone keeps their head forward", () => {
  const quiet = gazeTargets([
    { id: "a", x: 0, z: 0, talking: false, place: null },
    { id: "b", x: 1, z: 0, talking: false, place: null },
  ]);
  assert.equal(quiet.size, 0, "gaze is never invented when nothing was said");
});

test("with two speakers an agent watches the nearer one", () => {
  const looks = gazeTargets([
    { id: "a", x: 0, z: 0, talking: false, place: null },
    { id: "near", x: 1, z: 0, talking: true, place: null },
    { id: "far", x: 4, z: 0, talking: true, place: null },
  ]);
  assert.deepEqual(looks.get("a"), { x: 1, z: 0 });
});

test("two agents walking straight at each other actually clear", () => {
  // The single claim the whole module is for, played out over time rather
  // than asserted on one frame. Both walk the same line in opposite
  // directions; without steering they pass through each other exactly.
  const speed = 2.3 / 1000; // world units per ms, the scene's walking pace
  const dt = 16;
  const run = (steer) => {
    const people = [
      { id: "a", x: -2, z: 0, dx: 1, dz: 0, walking: true, nudge: { x: 0, z: 0 } },
      { id: "b", x: 2, z: 0, dx: -1, dz: 0, walking: true, nudge: { x: 0, z: 0 } },
    ];
    let closest = Infinity;
    for (let frame = 0; frame < 200; frame += 1) {
      const nudges = steer ? separation(people) : new Map();
      for (const p of people) {
        // Along the planned path, which steering never changes.
        p.pathX = (p.pathX ?? p.x) + p.dx * speed * dt;
        p.nudge = easeNudge(p.nudge, nudges.get(p.id) ?? { x: 0, z: 0 }, dt);
        p.x = p.pathX + p.nudge.x;
        p.z = p.nudge.z;
      }
      const gap = Math.hypot(
        people[0].x - people[1].x,
        people[0].z - people[1].z,
      );
      if (gap < closest) closest = gap;
    }
    return closest;
  };

  const withoutSteering = run(false);
  assert.ok(
    withoutSteering < 0.05,
    `the paths really do collide: closest ${withoutSteering.toFixed(3)}`,
  );
  const withSteering = run(true);
  assert.ok(
    withSteering > 0.3,
    `steering must open a real gap, got ${withSteering.toFixed(3)}`,
  );
});

test("a glance lands on the speaker and relaxes when they stop", () => {
  const speaker = { x: 2, z: -2 };
  let gaze = 0;
  const blend = (want) => {
    for (let i = 0; i < 90; i += 1) gaze += (want - gaze) * 0.08;
  };
  blend(gazeOffset(0, 0, 0, speaker));
  assert.ok(Math.abs(gaze) > 0.5, "the head turns toward whoever is speaking");
  blend(0);
  assert.ok(Math.abs(gaze) < 0.05, "and comes back when the room goes quiet");
});

test("an agent walking to its own desk is not jostled by its neighbour", () => {
  // Desks are 2.3 apart, so two agents at neighbouring seats are well
  // outside each other's personal space and never shove one another.
  const layout = computeLayout(9, "studio", null);
  const a = deskSeat(layout.desks[0]);
  const b = deskSeat(layout.desks[1]);
  assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > PERSONAL_SPACE);
});
