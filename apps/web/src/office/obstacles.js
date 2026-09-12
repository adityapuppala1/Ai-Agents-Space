// What an agent is not allowed to walk through.
//
// Every rectangle here is derived from the geometry the scene actually draws
// — the desk parts in office/instancing.js, the room anchors in
// office/zones.js, the furniture radii in office/propKinds.js — so the map
// cannot drift from what a viewer sees. If a desk changes shape, this file
// changes with it or the tests fail.
//
// Coordinates are world units: x across the floor, z toward the viewer, the
// back wall at -depth/2. Everything is axis-aligned, which is true of every
// piece of furniture the office builds and makes the tests arithmetic rather
// than geometry. Nothing here imports three.js, reads an agent, or touches a
// run: it is a description of the room.

import { OFFICE_PROP_KINDS } from "./propKinds.js";

/**
 * How much room a figure needs around itself. The avatar's torso is a 0.23
 * radius cylinder (office/avatars.js) and its shoulders reach a little
 * further; 0.3 keeps a walking agent's arms clear of a desk edge rather than
 * clipping it by a few centimetres.
 */
export const FIGURE_RADIUS = 0.3;

/**
 * The desk, as instancing.js builds it. `dz` is the offset from the desk
 * anchor to the centre of the part; the anchor is what layout.desks holds.
 *
 * The top is 1.9 x 0.95 centred 0.35 behind the anchor, which means the
 * anchor itself lies *under* the desk. An agent sent to the bare anchor
 * therefore stands inside its own desk — use deskSeat() instead.
 */
export const DESK_TOP = { w: 1.9, d: 0.95, dz: -0.35 };

/**
 * The chair: seat, back and the bars under it, taken together.
 *
 * A chair is deliberately *not* solid. Every chair is the destination of the
 * agent whose desk it belongs to, so treating chairs as obstacles would make
 * every seat in the office unreachable, or force a different obstacle map per
 * agent. A chair is also knee-high and gets pushed in and out — an agent
 * passing through one reads as ordinary, where an agent passing through a
 * desktop does not. It is exported because deskSeat() and the tests need its
 * measurements.
 */
export const DESK_CHAIR = { w: 0.64, d: 0.72, dz: 0.79 };

/** Where an agent stands or sits to use a desk: the chair's own centre. */
export const DESK_SEAT_DZ = 0.75;

/**
 * A room's central furniture — the research desk, the QA bench, the review
 * table. The room itself is open floor an agent stands in: only its middle
 * is solid. Kept deliberately smaller than the slot ring in computeLayout()
 * (slots sit about 1.0 out), so every slot stays reachable.
 */
export const ZONE_CORE = { w: 1.2, d: 0.7, dz: 0.0 };

/** Furniture you walk over rather than around. */
const WALKABLE_PROPS = new Set(["rug"]);

/**
 * Where an agent belongs at `desk`: the chair, facing the monitor.
 * `facing` follows the scene's convention that yaw 0 looks down -z.
 */
export function deskSeat(desk) {
  return {
    x: desk.x,
    z: desk.z + DESK_SEAT_DZ,
    facing: desk.facing ?? 0,
  };
}

function rect(x, z, w, d, kind, id) {
  return { x, z, hw: w / 2, hd: d / 2, kind, id };
}

/**
 * Every solid thing on the floor of `layout` (the value computeLayout()
 * returns), as padded-on-demand rectangles.
 *
 * `options.desks` can be false for a floor drawn without the desk field.
 */
export function officeObstacles(layout, options = {}) {
  const { desks = true } = options;
  const out = [];
  if (desks)
    (layout.desks ?? []).forEach((desk, index) => {
      out.push(
        rect(
          desk.x,
          desk.z + DESK_TOP.dz,
          DESK_TOP.w,
          DESK_TOP.d,
          "desk",
          index,
        ),
      );
    });

  for (const zone of Object.values(layout.zones ?? {})) {
    // A room serving nothing is not built, so there is nothing to walk into.
    if (zone.does === "none") continue;
    out.push(
      rect(zone.x, zone.z + ZONE_CORE.dz, ZONE_CORE.w, ZONE_CORE.d, "room", zone.id),
    );
  }

  for (const prop of layout.props ?? []) {
    if (WALKABLE_PROPS.has(prop.kind)) continue;
    const radius = OFFICE_PROP_KINDS[prop.kind]?.radius ?? 0.4;
    // Furniture is catalogued by radius; a square of that half-extent is the
    // honest reading of "this much floor is taken", and never smaller than
    // the drawn piece.
    out.push(rect(prop.x, prop.z, radius * 2, radius * 2, "prop", prop.index));
  }
  return out;
}

/** The walkable rectangle of the floor, already inset by a figure's width. */
export function floorBounds(layout, pad = FIGURE_RADIUS) {
  const halfW = layout.width / 2 - pad;
  const halfD = layout.depth / 2 - pad;
  return { minX: -halfW, maxX: halfW, minZ: -halfD, maxZ: halfD };
}

/** True when (x, z) is inside the floor. */
export function onFloor(bounds, x, z) {
  return (
    x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ
  );
}

/** The first thing blocking (x, z), or null when the spot is clear. */
export function blockerAt(obstacles, x, z, pad = FIGURE_RADIUS) {
  for (const o of obstacles) {
    if (
      Math.abs(x - o.x) <= o.hw + pad &&
      Math.abs(z - o.z) <= o.hd + pad
    )
      return o;
  }
  return null;
}

/** True when a figure cannot stand at (x, z). */
export function blocked(obstacles, x, z, pad = FIGURE_RADIUS) {
  return blockerAt(obstacles, x, z, pad) !== null;
}

/**
 * How far (x, z) is from the nearest obstacle edge; negative inside one.
 * The navigation grid uses this to prefer the middle of an aisle over
 * scraping a desk corner.
 */
export function clearance(obstacles, x, z) {
  let best = Infinity;
  for (const o of obstacles) {
    const dx = Math.abs(x - o.x) - o.hw;
    const dz = Math.abs(z - o.z) - o.hd;
    // Outside on both axes: true corner distance. Otherwise the larger gap.
    const d = dx > 0 && dz > 0 ? Math.hypot(dx, dz) : Math.max(dx, dz);
    if (d < best) best = d;
  }
  return best;
}

/**
 * True when the straight line from (ax, az) to (bx, bz) touches nothing.
 * This is what lets a routed path be simplified: any waypoint whose
 * neighbours can already see each other is not needed.
 */
export function segmentClear(obstacles, ax, az, bx, bz, pad = FIGURE_RADIUS) {
  for (const o of obstacles) {
    if (segmentHitsRect(ax, az, bx, bz, o, pad)) return false;
  }
  return true;
}

/** Slab test between a segment and one padded rectangle. */
function segmentHitsRect(ax, az, bx, bz, o, pad) {
  const minX = o.x - o.hw - pad;
  const maxX = o.x + o.hw + pad;
  const minZ = o.z - o.hd - pad;
  const maxZ = o.z + o.hd + pad;
  const dx = bx - ax;
  const dz = bz - az;
  let t0 = 0;
  let t1 = 1;
  // x slab, then z slab; a zero component means the segment is parallel and
  // only its constant coordinate decides.
  for (const [start, delta, lo, hi] of [
    [ax, dx, minX, maxX],
    [az, dz, minZ, maxZ],
  ]) {
    if (Math.abs(delta) < 1e-9) {
      if (start < lo || start > hi) return false;
      continue;
    }
    let near = (lo - start) / delta;
    let far = (hi - start) / delta;
    if (near > far) [near, far] = [far, near];
    if (near > t0) t0 = near;
    if (far < t1) t1 = far;
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * The nearest spot to (x, z) a figure can actually stand on, searched in
 * rings outward. Used when a goal turns out to be inside something — an
 * agent is moved to the edge of it rather than left stuck or dropped inside.
 */
export function nearestClear(obstacles, bounds, x, z, pad = FIGURE_RADIUS) {
  // A spot off the floor entirely comes back onto it first, so the ring
  // search below starts somewhere legal instead of walking the whole way in.
  const sx = Math.max(bounds.minX, Math.min(bounds.maxX, x));
  const sz = Math.max(bounds.minZ, Math.min(bounds.maxZ, z));
  if (!blocked(obstacles, sx, sz, pad)) return { x: sx, z: sz };
  const step = 0.25;
  for (let ring = 1; ring <= 24; ring += 1) {
    const r = ring * step;
    // Eight directions is enough: obstacles here are axis-aligned boxes.
    for (let i = 0; i < 8; i += 1) {
      const angle = (Math.PI * 2 * i) / 8;
      const cx = sx + Math.cos(angle) * r;
      const cz = sz + Math.sin(angle) * r;
      if (onFloor(bounds, cx, cz) && !blocked(obstacles, cx, cz, pad))
        return { x: cx, z: cz };
    }
  }
  return { x: sx, z: sz };
}
