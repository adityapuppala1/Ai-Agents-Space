import test from "node:test";
import assert from "node:assert/strict";
import {
  ROOM_CAPACITY,
  assignSeats,
  conferenceLayout,
  inRoom,
  laptopSpot,
  routeBetween,
  routeIn,
  routeOut,
  sceneBounds,
  seatCount,
  spreadSeats,
} from "../apps/web/src/office/conference.js";

/**
 * The conference wing: rooms beside the office floor, a chair per seat
 * round a table, and routes through each room's door.
 */

const layout = { width: 14.5, depth: 10.7 };
const room = (key, n) => ({
  key,
  memberIds: Array.from({ length: n }, (_, i) => `${key}${i}`),
});

test("rooms stand beside the open side of the floor, never on it or on each other", () => {
  const rooms = conferenceLayout(
    [room("a", 4), room("b", 12), room("c", 16)],
    layout,
  );
  assert.equal(rooms.length, 3);
  for (const r of rooms) {
    assert.ok(r.bounds.minX > layout.width / 2, `${r.key} is off the floor`);
    assert.ok(r.tableRadius > 0.5);
    assert.ok(r.chairRadius > r.tableRadius);
    assert.ok(r.laneRadius > r.chairRadius);
    // The lane fits inside the walls.
    assert.ok(r.x - r.laneRadius > r.bounds.minX);
    assert.ok(r.x + r.laneRadius < r.bounds.maxX);
  }
  for (let i = 0; i < rooms.length; i++)
    for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i].bounds;
      const b = rooms[j].bounds;
      const overlap =
        a.minX < b.maxX &&
        b.minX < a.maxX &&
        a.minZ < b.maxZ &&
        b.minZ < a.maxZ;
      assert.equal(overlap, false, `${rooms[i].key} overlaps ${rooms[j].key}`);
    }
  const bounds = sceneBounds(layout, rooms);
  assert.equal(bounds.minX, -layout.width / 2);
  assert.ok(bounds.maxX >= Math.max(...rooms.map((r) => r.bounds.maxX)));
});

test("seats come in a few sizes, face the table, and never share a spot", () => {
  assert.equal(seatCount(3), 6);
  assert.equal(seatCount(7), 10);
  assert.equal(seatCount(40), ROOM_CAPACITY);
  const [r] = conferenceLayout([room("a", 9)], layout);
  assert.equal(r.seats.length, 10);
  const spots = new Set(
    r.seats.map((s) => `${s.x.toFixed(2)},${s.z.toFixed(2)}`),
  );
  assert.equal(spots.size, 10);
  for (const seat of r.seats) {
    // Facing the centre: a step along the facing lands nearer the table.
    const step = {
      x: seat.x - Math.sin(seat.facing) * 0.1,
      z: seat.z - Math.cos(seat.facing) * 0.1,
    };
    assert.ok(
      Math.hypot(step.x - r.x, step.z - r.z) <
        Math.hypot(seat.x - r.x, seat.z - r.z),
    );
    const laptop = laptopSpot(r, seat);
    assert.ok(Math.hypot(laptop.x - r.x, laptop.z - r.z) < r.tableRadius);
  }
});

test("members keep their seats; a newcomer takes the first free one", () => {
  const first = assignSeats(new Map(), ["a", "b", "c"], 6);
  assert.deepEqual(
    [...first.entries()],
    [
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ],
  );
  const next = assignSeats(first, ["c", "d", "a"], 6);
  assert.equal(next.get("a"), 0);
  assert.equal(next.get("c"), 2);
  assert.equal(next.get("d"), 1, "b left; d takes the free seat");
  // No more seats than chairs.
  assert.equal(assignSeats(new Map(), ["a", "b", "c"], 2).size, 2);
});

test("a small team spreads round the table: a pair sits face to face", () => {
  const [r] = conferenceLayout([room("a", 2)], layout);
  const pair = spreadSeats(2, r.seats.length);
  assert.equal(pair.length, 2);
  const [a, b] = pair.map((i) => r.seats[i]);
  const across = Math.abs(
    Math.atan2(Math.sin(a.angle - b.angle), Math.cos(a.angle - b.angle)),
  );
  assert.ok(Math.abs(across - Math.PI) < 1e-9, "opposite each other");
  assert.equal(new Set(spreadSeats(5, 10)).size, 5, "never two on one chair");
  assert.deepEqual(spreadSeats(0, 6), []);
  // Newcomers take the spread seats first; members keep theirs.
  const seated = assignSeats(new Map(), ["x", "y"], 6, pair);
  assert.deepEqual([seated.get("x"), seated.get("y")], pair);
  const joined = assignSeats(seated, ["x", "y", "z"], 6, spreadSeats(3, 6));
  assert.equal(joined.get("x"), seated.get("x"));
  assert.equal(joined.get("y"), seated.get("y"));
  assert.ok(!pair.includes(joined.get("z")));
  // No chair stands in the doorway.
  for (const seat of r.seats)
    assert.ok(Math.abs(seat.z - r.door.inside.z) > 0.2 || seat.x > r.x);
});

test("the way in and out goes through the door and round the table", () => {
  const [r] = conferenceLayout([room("a", 6)], layout);
  const seat = r.seats[0]; // across the table from the door
  const into = routeIn(r, 0);
  assert.deepEqual(into[0], r.door.outside);
  assert.deepEqual(into[1], r.door.inside);
  // Round the lane, never across the table.
  for (const point of into.slice(2))
    assert.ok(
      Math.hypot(point.x - r.x, point.z - r.z) > r.tableRadius + 0.3,
      "walks round the table",
    );
  const last = into.at(-1);
  assert.ok(Math.hypot(last.x - seat.x, last.z - seat.z) < 0.8);
  const out = routeOut(r, seat.x, seat.z);
  assert.deepEqual(out.at(-1), r.door.outside);
  assert.deepEqual(out.at(-2), r.door.inside);

  assert.ok(inRoom(r, r.x, r.z));
  assert.equal(inRoom(r, 0, 0), false);
  // Desk to seat: through the door.
  const desk = { x: 0, z: 0 };
  const toSeat = routeBetween([r], desk, seat, 0);
  assert.deepEqual(toSeat[0], r.door.outside);
  const home = routeBetween([r], seat, desk);
  assert.deepEqual(home.at(-1), r.door.outside);
  assert.deepEqual(routeBetween([r], desk, { x: 2, z: 1 }), []);
  // Seat to seat across one room: round the lane, never over the table.
  const across = routeBetween([r], seat, r.seats[3]);
  assert.ok(across.length >= 2);
  for (const point of across)
    assert.ok(Math.hypot(point.x - r.x, point.z - r.z) > r.tableRadius + 0.3);
  // A step to the next chair needs no detour.
  const near = { x: seat.x + 0.2, z: seat.z };
  assert.deepEqual(routeBetween([r], seat, near), []);
});

test("a room keeps its place while others open and close", () => {
  const both = conferenceLayout(
    [
      { ...room("a", 4), slot: 0 },
      { ...room("b", 12), slot: 1 },
    ],
    layout,
  );
  const alone = conferenceLayout([{ ...room("b", 12), slot: 1 }], layout);
  assert.deepEqual(alone[0].bounds, both[1].bounds);
  // Slots are kept like seats: by key, first free for a newcomer.
  const slots = assignSeats(new Map([["b", 1]]), ["b", "c"], 6);
  assert.equal(slots.get("b"), 1);
  assert.equal(slots.get("c"), 0);
});

test("a second column of rooms is reached along the front, not through the first", () => {
  const rooms = conferenceLayout(
    [room("a", 6), room("b", 6), room("c", 6)].map((r, slot) => ({
      ...r,
      slot,
    })),
    layout,
  );
  const [first, second, third] = rooms;
  assert.equal(first.column, 0);
  assert.equal(second.column, 0);
  assert.equal(third.column, 1);
  assert.deepEqual(first.door.approach, []);
  assert.equal(third.door.approach.length, 2);
  // The approach runs in front of every room in the first column...
  for (const point of third.door.approach) {
    assert.ok(point.z > first.bounds.maxZ && point.z > second.bounds.maxZ);
    for (const r of rooms) assert.equal(inRoom(r, point.x, point.z), false);
  }
  // ...then up the aisle between the columns, clear of both.
  const aisle = third.door.outside.x;
  assert.ok(aisle > first.bounds.maxX && aisle < third.bounds.minX);
  const route = routeIn(third, 0);
  assert.deepEqual(route.slice(0, 2), third.door.approach);
  const out = routeOut(third, third.seats[0].x, third.seats[0].z);
  assert.deepEqual(out.at(-1), third.door.approach[0]);
  // From the first room to the third: out one door, round, in the other.
  const between = routeBetween(rooms, first.seats[0], third.seats[2], 2);
  assert.ok(between.some((p) => p.x === first.door.outside.x));
  assert.ok(between.some((p) => p.x === aisle));
});
