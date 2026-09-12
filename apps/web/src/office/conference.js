// The conference wing: glass-walled rooms beside the office floor, one per
// team that meets there, each with a round table and a chair per seat.
// Pure (no three, no DOM): room geometry, who sits where, and the routes in
// and out through each room's door, so node:test covers every rule.
//
// Coordinates are the office's: x across the room, z toward the viewer; the
// main floor is centred on the origin and open on its +x and +z sides, which
// is where the camera looks from, so the wing is built on the +x side.

/** Seats a room can hold; a larger team fills a room and the rest keep their desks. */
export const ROOM_CAPACITY = 16;

/** Rooms are built with one of these seat counts, so a joiner rarely reshuffles. */
const SEAT_BUCKETS = [6, 10, 16];

/** Distance round the chair ring given to each seat (world units). */
const SEAT_SPACING = 0.74;

/** Gap between the office floor and the wing, and the aisle between columns. */
const CORRIDOR = 0.9;
/** Gap between two rooms in one column. */
const ROOM_GAP = 0.6;

/** Walking lane round the chairs. */
const LANE = 0.62;

/**
 * Every room stands in a square slot this wide (the largest room's side),
 * so a room keeps its place while others open and close round it.
 */
const SLOT = 6;

/** Slots in the wing: the open rooms plus any the agents are still leaving. */
export const MAX_SLOTS = 6;

/** Seats for a room of `members`: the smallest bucket that fits them. */
export function seatCount(members) {
  const n = Math.max(1, Math.min(ROOM_CAPACITY, members));
  return SEAT_BUCKETS.find((bucket) => bucket >= n) ?? ROOM_CAPACITY;
}

/** Yaw that turns a figure at (ax, az) to face (bx, bz); yaw 0 faces -z. */
function facingToward(ax, az, bx, bz) {
  return Math.atan2(-(bx - ax), -(bz - az));
}

/** Rows of slots in one column beside a floor `depth` deep. */
function rowsFor(depth) {
  return Math.max(1, Math.floor((depth + 2 + ROOM_GAP) / (SLOT + ROOM_GAP)));
}

/**
 * Geometry for each room: rooms = [{ key, memberIds, slot? }] (from roomPlan
 * in scale.js; `slot` keeps a room where it was, and defaults to its index).
 * → [{ key, slot, column, seats: [{ index, x, z, facing, angle }], x, z
 * (centre), side, tableRadius, chairRadius, laneRadius, door: { approach,
 * outside, inside }, bounds }].
 *
 * The first column's doors open on the corridor beside the floor. A later
 * column is reached along the front of the wing and up the aisle between
 * columns (`door.approach`), so nobody walks through another room's glass.
 */
export function conferenceLayout(rooms = [], layout = {}) {
  const width = layout.width ?? 14.5;
  const depth = layout.depth ?? 10.7;
  const rows = rowsFor(depth);
  const firstColumn = width / 2 + CORRIDOR;
  const front =
    -depth / 2 + rows * SLOT + (rows - 1) * ROOM_GAP + CORRIDOR / 2;
  return rooms.map((room, index) => {
    const slot = Number.isInteger(room.slot) ? room.slot : index;
    const columnIndex = Math.floor(slot / rows);
    const column = firstColumn + columnIndex * (SLOT + CORRIDOR);
    const top = -depth / 2 + (slot % rows) * (SLOT + ROOM_GAP);
    const n = seatCount(room.memberIds?.length ?? 0);
    const chairRadius = Math.max(1.25, (n * SEAT_SPACING) / (2 * Math.PI));
    const tableRadius = chairRadius - 0.5;
    const side = Math.min(SLOT, Math.max(5, 2 * (chairRadius + LANE + 0.5)));
    const cx = column + side / 2;
    const cz = top + side / 2;
    const seats = [];
    for (let i = 0; i < n; i++) {
      // Half a step round, so no chair stands in the doorway.
      const angle = ((i + 0.5) * 2 * Math.PI) / n;
      const x = cx + chairRadius * Math.cos(angle);
      const sz = cz + chairRadius * Math.sin(angle);
      seats.push({
        index: i,
        x,
        z: sz,
        angle,
        facing: facingToward(x, sz, cx, cz),
      });
    }
    const aisle = column - CORRIDOR / 2;
    return {
      key: room.key,
      slot,
      column: columnIndex,
      x: cx,
      z: cz,
      side,
      tableRadius,
      chairRadius,
      laneRadius: chairRadius + LANE,
      seats,
      door: {
        approach: columnIndex
          ? [
              { x: firstColumn - CORRIDOR / 2, z: front },
              { x: aisle, z: front },
            ]
          : [],
        outside: { x: aisle, z: cz },
        inside: { x: column + 0.55, z: cz },
      },
      bounds: {
        minX: column,
        maxX: column + side,
        minZ: top,
        maxZ: top + side,
      },
    };
  });
}

/** The main floor and every room, for the camera to fit. */
export function sceneBounds(layout = {}, rooms = []) {
  const width = layout.width ?? 14.5;
  const depth = layout.depth ?? 10.7;
  const bounds = {
    minX: -width / 2,
    maxX: width / 2,
    minZ: -depth / 2,
    maxZ: depth / 2,
  };
  for (const room of rooms) {
    bounds.minX = Math.min(bounds.minX, room.bounds.minX);
    bounds.maxX = Math.max(bounds.maxX, room.bounds.maxX);
    bounds.minZ = Math.min(bounds.minZ, room.bounds.minZ);
    bounds.maxZ = Math.max(bounds.maxZ, room.bounds.maxZ);
  }
  return bounds;
}

/** The seat angle the first member takes: back right, seen side-on from the default view. */
const FIRST_SEAT_ANGLE = (7 * Math.PI) / 4;

/**
 * The seats `members` people take round a table of `seats`, spread evenly
 * so a pair sits face to face rather than elbow to elbow, starting at the
 * back right of the table.
 */
export function spreadSeats(members, seats) {
  const n = Math.max(0, Math.min(members, seats));
  if (!n) return [];
  let start = 0;
  let best = Infinity;
  for (let i = 0; i < seats; i++) {
    const angle = ((i + 0.5) * 2 * Math.PI) / seats;
    const off = Math.abs(
      Math.atan2(
        Math.sin(angle - FIRST_SEAT_ANGLE),
        Math.cos(angle - FIRST_SEAT_ANGLE),
      ),
    );
    if (off < best - 1e-9) {
      best = off;
      start = i;
    }
  }
  const order = [];
  for (let i = 0; i < n; i++)
    order.push((start + Math.floor((i * seats) / n)) % seats);
  return order;
}

/**
 * Who sits where: members keep the seat they had; a newcomer takes the
 * first free seat of `preferred` (then any free one). `previous` is a Map
 * id -> seat index. Returns a new Map; members beyond the seats get none.
 * Rooms keep their slots the same way.
 */
export function assignSeats(
  previous = new Map(),
  memberIds = [],
  seats = 0,
  preferred = null,
) {
  const next = new Map();
  const taken = new Set();
  for (const id of memberIds) {
    const seat = previous.get(id);
    if (Number.isInteger(seat) && seat < seats && !taken.has(seat)) {
      next.set(id, seat);
      taken.add(seat);
    }
  }
  const order = [...(preferred ?? [])];
  for (let i = 0; i < seats; i++) order.push(i);
  let cursor = 0;
  for (const id of memberIds) {
    if (next.has(id)) continue;
    while (cursor < order.length && taken.has(order[cursor])) cursor += 1;
    if (cursor >= order.length) break;
    next.set(id, order[cursor]);
    taken.add(order[cursor]);
  }
  return next;
}

/** Whether (x, z) is inside a room. */
export function inRoom(room, x, z) {
  const b = room?.bounds;
  return Boolean(b) && x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
}

/** The point on a room's walking lane at `angle`. */
function lanePoint(room, angle) {
  return {
    x: room.x + room.laneRadius * Math.cos(angle),
    z: room.z + room.laneRadius * Math.sin(angle),
  };
}

/** Points on the walking lane from one angle to another, the short way round. */
function laneArc(room, from, to) {
  let delta = to - from;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  const steps = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 4)));
  const points = [];
  for (let i = 1; i <= steps; i++)
    points.push(lanePoint(room, from + (delta * i) / steps));
  return points;
}

/** The door side of the table: the lane angle nearest the door. */
const DOOR_ANGLE = Math.PI;

/** The angle of (x, z) seen from a room's centre. */
function angleIn(room, x, z) {
  return Math.atan2(z - room.z, x - room.x);
}

/**
 * Into a room: along the approach, through the door, round the lane to
 * behind the seat. The caller walks the last leg to the seat itself.
 */
export function routeIn(room, seatIndex) {
  const seat = room.seats[seatIndex];
  if (!seat) return [];
  return [
    ...room.door.approach.map((point) => ({ ...point })),
    { ...room.door.outside },
    { ...room.door.inside },
    ...laneArc(room, DOOR_ANGLE, seat.angle),
  ];
}

/** Out of a room from (x, z): round the lane to the door, out, and back along the approach. */
export function routeOut(room, x, z) {
  const angle = angleIn(room, x, z);
  return [
    lanePoint(room, angle),
    ...laneArc(room, angle, DOOR_ANGLE),
    { ...room.door.inside },
    { ...room.door.outside },
    ...[...room.door.approach].reverse().map((point) => ({ ...point })),
  ];
}

/**
 * The route between where a figure stands and where it is going, through
 * any room door on the way: [] when it can walk straight there. Within one
 * room it goes round the lane, never across the table.
 */
export function routeBetween(rooms, from, to, seatIndex = null) {
  const fromRoom = rooms.find((room) => inRoom(room, from.x, from.z));
  const toRoom = rooms.find((room) => inRoom(room, to.x, to.z));
  if (fromRoom && fromRoom === toRoom) {
    if (Math.hypot(to.x - from.x, to.z - from.z) < 0.9) return [];
    const start = angleIn(fromRoom, from.x, from.z);
    return [
      lanePoint(fromRoom, start),
      ...laneArc(fromRoom, start, angleIn(fromRoom, to.x, to.z)),
    ];
  }
  const route = [];
  if (fromRoom) route.push(...routeOut(fromRoom, from.x, from.z));
  if (toRoom) {
    if (Number.isInteger(seatIndex) && toRoom.seats[seatIndex])
      route.push(...routeIn(toRoom, seatIndex));
    else
      route.push(
        ...toRoom.door.approach.map((point) => ({ ...point })),
        { ...toRoom.door.outside },
        { ...toRoom.door.inside },
        ...laneArc(toRoom, DOOR_ANGLE, angleIn(toRoom, to.x, to.z)),
      );
  }
  return route;
}

/** Where a seated agent's laptop sits: on the table, in front of the seat. */
export function laptopSpot(room, seat) {
  const reach = room.tableRadius - 0.24;
  return {
    x: room.x + reach * Math.cos(seat.angle),
    z: room.z + reach * Math.sin(seat.angle),
    facing: seat.facing,
  };
}
