import test from "node:test";
import assert from "node:assert/strict";
import {
  DESK_TOP,
  FIGURE_RADIUS,
  blocked,
  blockerAt,
  clearance,
  deskSeat,
  floorBounds,
  nearestClear,
  officeObstacles,
  segmentClear,
} from "../apps/web/src/office/obstacles.js";
import {
  buildNavGrid,
  findPath,
  routeTo,
} from "../apps/web/src/office/navmesh.js";
import { computeLayout } from "../apps/web/src/office/zones.js";

/**
 * Walking round the furniture instead of through it. Everything here is
 * arithmetic on a computed layout, so node:test covers it without a browser
 * or a scene — the same split the rest of office/ uses.
 */

const layoutOf = (count = 9, profile = "studio", arranged = null) =>
  computeLayout(count, profile, arranged);

/** Samples along a path, including the two ends. */
function samples(from, waypoints, to, step = 0.06) {
  const points = [from, ...waypoints, to];
  const out = [];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const span = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(span / step));
    for (let s = 0; s <= n; s += 1)
      out.push({ x: a.x + ((b.x - a.x) * s) / n, z: a.z + ((b.z - a.z) * s) / n });
  }
  return out;
}

test("a desk anchor is inside its own desk, and the seat is not", () => {
  const layout = layoutOf(9);
  const obstacles = officeObstacles(layout);
  const desk = layout.desks[4];

  // The regression this whole module exists for: agents were sent to the
  // bare desk anchor, which the desktop covers, so they stood in the desk.
  assert.equal(
    blocked(obstacles, desk.x, desk.z),
    true,
    "the desk anchor is under the desktop",
  );
  const seat = deskSeat(desk);
  assert.equal(
    blocked(obstacles, seat.x, seat.z),
    false,
    "the chair is clear of the desktop",
  );
  assert.equal(seat.x, desk.x);
  assert.ok(seat.z > desk.z, "the seat is in front of the desk");
  // Clear of the desktop's own edge by more than a figure's width.
  const deskFrontZ = desk.z + DESK_TOP.dz + DESK_TOP.d / 2;
  assert.ok(seat.z - deskFrontZ > FIGURE_RADIUS);
});

test("the obstacle map is built from what the office actually draws", () => {
  const layout = layoutOf(6);
  const obstacles = officeObstacles(layout);
  const kinds = new Set(obstacles.map((o) => o.kind));
  assert.deepEqual([...kinds].sort(), ["desk", "room"]);
  assert.equal(
    obstacles.filter((o) => o.kind === "desk").length,
    layout.desks.length,
  );
  // A chair is never solid: every chair is some agent's destination.
  assert.equal(obstacles.some((o) => o.kind === "chair"), false);
  // Desks can be left out for a floor drawn without them.
  assert.equal(
    officeObstacles(layout, { desks: false }).some((o) => o.kind === "desk"),
    false,
  );
});

test("furniture takes floor by its catalogued radius, and a rug does not", () => {
  const arranged = {
    zones: {},
    props: [
      { kind: "sofa", x: 0.5, z: 0.5, rotation: 0 },
      { kind: "rug", x: -0.5, z: 0.5, rotation: 0 },
    ],
  };
  const layout = layoutOf(4, "studio", arranged);
  const obstacles = officeObstacles(layout);
  const props = obstacles.filter((o) => o.kind === "prop");
  assert.equal(props.length, 1, "the rug is walked over, not around");
  // The sofa's catalogue radius is 0.95.
  assert.equal(props[0].hw, 0.95);
  const sofa = layout.props[0];
  assert.equal(blocked(obstacles, sofa.x, sofa.z), true);
  const rug = layout.props[1];
  assert.equal(blockerAt(obstacles, rug.x, rug.z)?.kind ?? null, null);
});

test("a room a workspace turned off is not something to walk around", () => {
  const on = layoutOf(6);
  const room = on.zones.research;
  assert.equal(blocked(officeObstacles(on), room.x, room.z), true);
  const off = layoutOf(6, "studio", {
    zones: { research: { x: room.x / (on.width / 2 - 0.7), z: room.z / (on.depth / 2 - 0.6), does: "none" } },
    props: [],
  });
  const cleared = officeObstacles(off);
  assert.equal(
    cleared.some((o) => o.kind === "room" && o.id === "research"),
    false,
    "a room serving nothing is not built, so nothing blocks there",
  );
});

test("clearance grows away from the furniture and goes negative inside it", () => {
  const layout = layoutOf(9);
  const obstacles = officeObstacles(layout);
  const desk = layout.desks[4];
  assert.ok(clearance(obstacles, desk.x, desk.z) < 0, "inside the desktop");
  const seat = deskSeat(desk);
  const atSeat = clearance(obstacles, seat.x, seat.z);
  assert.ok(atSeat > 0, "standing at the chair is outside everything");
  // The aisle between two desk rows is the roomiest spot between them: the
  // desktop in front ends 0.125 past the anchor and the next row's begins
  // 1.675 past it, so the middle of that band is about 0.9.
  assert.ok(clearance(obstacles, desk.x, desk.z + 0.9) >= atSeat);
});

test("a straight line through a desk is not clear, and one beside it is", () => {
  const layout = layoutOf(9);
  const obstacles = officeObstacles(layout);
  const desk = layout.desks[4];
  const top = { x: desk.x, z: desk.z + DESK_TOP.dz };
  assert.equal(
    segmentClear(obstacles, top.x - 3, top.z, top.x + 3, top.z),
    false,
  );
  // Along the middle of the aisle between this desk row and the next.
  const aisle = desk.z + 0.9;
  assert.equal(
    segmentClear(obstacles, desk.x - 0.2, aisle, desk.x + 0.2, aisle),
    true,
  );
});

test("a route from a desk to a room never crosses anything solid", () => {
  const layout = layoutOf(9);
  const obstacles = officeObstacles(layout);
  const grid = buildNavGrid(layout, obstacles);
  const from = deskSeat(layout.desks[0]);
  const room = layout.zones.meeting;
  const to = room.slots[3];

  const { goal, waypoints } = routeTo(grid, obstacles, from, to);
  assert.ok(waypoints.length > 0, "the straight line was not usable");
  for (const point of samples(from, waypoints, goal)) {
    const hit = blockerAt(obstacles, point.x, point.z);
    assert.equal(
      hit,
      null,
      `path passes through ${hit?.kind} ${hit?.id} at ${point.x.toFixed(2)}, ${point.z.toFixed(2)}`,
    );
  }
});

test("every desk can reach every room, and back again", () => {
  const layout = layoutOf(12);
  const obstacles = officeObstacles(layout);
  const grid = buildNavGrid(layout, obstacles);
  for (const desk of layout.desks) {
    const seat = deskSeat(desk);
    for (const id of ["research", "qa", "review", "meeting", "breakArea"]) {
      const target = layout.zones[id].slots[0];
      const out = routeTo(grid, obstacles, seat, target);
      for (const p of samples(seat, out.waypoints, out.goal, 0.12))
        assert.equal(
          blocked(obstacles, p.x, p.z),
          false,
          `desk → ${id} crosses something`,
        );
      const back = routeTo(grid, obstacles, out.goal, seat);
      for (const p of samples(out.goal, back.waypoints, back.goal, 0.12))
        assert.equal(
          blocked(obstacles, p.x, p.z),
          false,
          `${id} → desk crosses something`,
        );
    }
  }
});

test("a clear line needs no waypoints at all", () => {
  const layout = layoutOf(9);
  const obstacles = officeObstacles(layout);
  const grid = buildNavGrid(layout, obstacles);
  const seat = deskSeat(layout.desks[0]);
  const beside = { x: seat.x + 0.4, z: seat.z };
  assert.deepEqual(findPath(grid, obstacles, seat, beside), []);
});

test("a goal inside the furniture is moved to the edge, not refused", () => {
  const layout = layoutOf(9);
  const obstacles = officeObstacles(layout);
  const grid = buildNavGrid(layout, obstacles);
  const desk = layout.desks[4];
  const from = deskSeat(layout.desks[0]);

  const { goal } = routeTo(grid, obstacles, from, { x: desk.x, z: desk.z });
  assert.equal(blocked(obstacles, goal.x, goal.z), false);
  assert.ok(
    Math.hypot(goal.x - desk.x, goal.z - desk.z) < 1.5,
    "and it stays near where it was asked for",
  );
});

test("a spot outside the floor comes back inside it", () => {
  const layout = layoutOf(6);
  const obstacles = officeObstacles(layout);
  const bounds = floorBounds(layout);
  const out = nearestClear(obstacles, bounds, layout.width, layout.depth);
  assert.ok(out.x <= bounds.maxX && out.z <= bounds.maxZ);
});

test("the grid keeps the floor walkable and marks the desks", () => {
  const layout = layoutOf(9);
  const obstacles = officeObstacles(layout);
  const grid = buildNavGrid(layout, obstacles);
  let free = 0;
  for (const cell of grid.free) free += cell;
  assert.ok(free > grid.free.length * 0.4, "most of the floor is walkable");
  assert.ok(free < grid.free.length, "and the furniture is not");
  // Small enough to search cheaply on every walk.
  assert.ok(grid.free.length < 8000, `grid is ${grid.free.length} cells`);
});
