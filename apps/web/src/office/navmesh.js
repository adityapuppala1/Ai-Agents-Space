// Getting from one place on the floor to another without walking through
// the furniture.
//
// The floor becomes a coarse grid of free and blocked cells, A* crosses it,
// and the result is then pulled straight: any waypoint whose neighbours can
// already see each other is dropped. What comes out is two to five straight
// legs — exactly the shape office/avatars.js followRoute() already accepts,
// so routing is a better set of waypoints rather than a new kind of motion.
//
// The grid is rebuilt when the office changes shape, not per frame, and a
// search runs once when a walk starts. Nothing here imports three.js.

import {
  FIGURE_RADIUS,
  blocked,
  clearance,
  floorBounds,
  nearestClear,
  segmentClear,
} from "./obstacles.js";

/**
 * Grid resolution. The narrowest real gap on a default floor is the aisle
 * between two desk columns (desk pitch 2.3 less a 1.9 desktop leaves 0.4),
 * so cells have to be small enough to notice a gap that size at all.
 */
export const CELL = 0.35;

/** A path may not wander further than this multiple of the direct distance. */
const MAX_DETOUR = 4;

/**
 * How strongly a path prefers open floor. Cells within this distance of an
 * obstacle cost more, so an agent walks down the middle of an aisle rather
 * than scraping a desk corner — without ever making a narrow gap impassable.
 */
const COMFORT = 0.45;
const COMFORT_COST = 0.9;

/**
 * Precomputes the walkable grid for a floor. `obstacles` is the list from
 * officeObstacles(); pass the same list to findPath so the two agree.
 */
export function buildNavGrid(layout, obstacles, options = {}) {
  const { pad = FIGURE_RADIUS, cell = CELL } = options;
  const bounds = floorBounds(layout, pad);
  const cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cell) + 1);
  const rows = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / cell) + 1);
  const free = new Uint8Array(cols * rows);
  const extra = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const x = bounds.minX + c * cell;
      const z = bounds.minZ + r * cell;
      const i = r * cols + c;
      if (blocked(obstacles, x, z, pad)) continue;
      free[i] = 1;
      const room = clearance(obstacles, x, z);
      // Tight but legal cells stay usable, merely less attractive.
      extra[i] =
        room < COMFORT ? COMFORT_COST * (1 - Math.max(0, room) / COMFORT) : 0;
    }
  }
  return { cols, rows, cell, minX: bounds.minX, minZ: bounds.minZ, free, extra, pad, bounds };
}

const worldX = (grid, c) => grid.minX + c * grid.cell;
const worldZ = (grid, r) => grid.minZ + r * grid.cell;

function cellOf(grid, x, z) {
  const c = Math.round((x - grid.minX) / grid.cell);
  const r = Math.round((z - grid.minZ) / grid.cell);
  return {
    c: Math.max(0, Math.min(grid.cols - 1, c)),
    r: Math.max(0, Math.min(grid.rows - 1, r)),
  };
}

/** The nearest free cell to (x, z), searched outward. Null when none is. */
function nearestFreeCell(grid, x, z) {
  const start = cellOf(grid, x, z);
  if (grid.free[start.r * grid.cols + start.c]) return start;
  for (let ring = 1; ring < Math.max(grid.cols, grid.rows); ring += 1) {
    for (let dr = -ring; dr <= ring; dr += 1) {
      for (let dc = -ring; dc <= ring; dc += 1) {
        // Only the ring's edge is new.
        if (Math.abs(dr) !== ring && Math.abs(dc) !== ring) continue;
        const r = start.r + dr;
        const c = start.c + dc;
        if (r < 0 || c < 0 || r >= grid.rows || c >= grid.cols) continue;
        if (grid.free[r * grid.cols + c]) return { c, r };
      }
    }
  }
  return null;
}

/** Smallest binary heap keyed by f-score. */
function heap() {
  const items = [];
  const score = [];
  return {
    get size() {
      return items.length;
    },
    push(item, f) {
      items.push(item);
      score.push(f);
      let i = items.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (score[parent] <= score[i]) break;
        [items[parent], items[i]] = [items[i], items[parent]];
        [score[parent], score[i]] = [score[i], score[parent]];
        i = parent;
      }
    },
    pop() {
      const top = items[0];
      const lastItem = items.pop();
      const lastScore = score.pop();
      if (items.length) {
        items[0] = lastItem;
        score[0] = lastScore;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let small = i;
          if (l < items.length && score[l] < score[small]) small = l;
          if (r < items.length && score[r] < score[small]) small = r;
          if (small === i) break;
          [items[small], items[i]] = [items[i], items[small]];
          [score[small], score[i]] = [score[i], score[small]];
          i = small;
        }
      }
      return top;
    },
  };
}

const DIAGONAL = Math.SQRT2;
const STEPS = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, DIAGONAL],
  [1, -1, DIAGONAL],
  [-1, 1, DIAGONAL],
  [-1, -1, DIAGONAL],
];

/**
 * Waypoints from `from` to `to` that touch nothing, as world positions and
 * **excluding both ends** — which is what followRoute() expects.
 *
 * Returns [] when the straight line is already clear, and null when no route
 * exists at all. A caller that gets null should walk straight rather than
 * freeze: being briefly wrong about a desk is better than an agent that
 * never arrives.
 */
export function findPath(grid, obstacles, from, to, options = {}) {
  const pad = options.pad ?? grid.pad ?? FIGURE_RADIUS;
  if (segmentClear(obstacles, from.x, from.z, to.x, to.z, pad)) return [];

  const startCell = nearestFreeCell(grid, from.x, from.z);
  const goalCell = nearestFreeCell(grid, to.x, to.z);
  if (!startCell || !goalCell) return null;

  const { cols, rows, cell } = grid;
  const total = cols * rows;
  const startIndex = startCell.r * cols + startCell.c;
  const goalIndex = goalCell.r * cols + goalCell.c;
  if (startIndex === goalIndex) return [];

  const direct = Math.hypot(to.x - from.x, to.z - from.z);
  const budget = Math.max(direct * MAX_DETOUR, cell * 8);

  const g = new Float32Array(total).fill(Infinity);
  const cameFrom = new Int32Array(total).fill(-1);
  const done = new Uint8Array(total);
  const open = heap();

  const octile = (c, r) => {
    const dc = Math.abs(c - goalCell.c);
    const dr = Math.abs(r - goalCell.r);
    return (Math.max(dc, dr) + (DIAGONAL - 1) * Math.min(dc, dr)) * cell;
  };

  g[startIndex] = 0;
  open.push(startIndex, octile(startCell.c, startCell.r));

  let found = false;
  while (open.size) {
    const current = open.pop();
    if (done[current]) continue;
    done[current] = 1;
    if (current === goalIndex) {
      found = true;
      break;
    }
    if (g[current] > budget) continue;
    const cc = current % cols;
    const cr = (current - cc) / cols;
    for (const [dc, dr, weight] of STEPS) {
      const nc = cc + dc;
      const nr = cr + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const next = nr * cols + nc;
      if (!grid.free[next] || done[next]) continue;
      // No cutting a corner between two blocked cells.
      if (dc !== 0 && dr !== 0) {
        if (!grid.free[cr * cols + nc] || !grid.free[nr * cols + cc]) continue;
      }
      const step = weight * cell + grid.extra[next] * cell;
      const tentative = g[current] + step;
      if (tentative >= g[next]) continue;
      g[next] = tentative;
      cameFrom[next] = current;
      open.push(next, tentative + octile(nc, nr));
    }
  }
  if (!found) return null;

  // Walk the chain back, then pull it straight.
  const cells = [];
  for (let i = goalIndex; i !== -1; i = cameFrom[i]) cells.push(i);
  cells.reverse();
  const points = cells.map((i) => {
    const c = i % cols;
    const r = (i - c) / cols;
    return { x: worldX(grid, c), z: worldZ(grid, r) };
  });
  return simplify(obstacles, from, to, points, pad);
}

/**
 * Drops every waypoint that is not needed: from the current anchor, keep the
 * furthest point still in clear sight, and start again from there. What is
 * left are the corners the agent actually has to turn.
 */
function simplify(obstacles, from, to, points, pad) {
  const all = [from, ...points, to];
  const kept = [];
  let anchor = 0;
  while (anchor < all.length - 1) {
    let furthest = anchor + 1;
    for (let i = all.length - 1; i > anchor; i -= 1) {
      const a = all[anchor];
      const b = all[i];
      if (segmentClear(obstacles, a.x, a.z, b.x, b.z, pad)) {
        furthest = i;
        break;
      }
    }
    if (furthest < all.length - 1) kept.push(all[furthest]);
    anchor = furthest;
  }
  return kept.map((p) => ({ x: p.x, z: p.z }));
}

/**
 * The whole job for one walk: a legal destination and the way to it.
 * Returns `{ goal, waypoints }`, where `goal` may have been nudged out of
 * something solid, and `waypoints` is [] for a clear straight line.
 */
export function routeTo(grid, obstacles, from, to, options = {}) {
  const pad = options.pad ?? grid.pad ?? FIGURE_RADIUS;
  const goal = nearestClear(obstacles, grid.bounds, to.x, to.z, pad);
  const waypoints = findPath(grid, obstacles, from, goal, { pad });
  return { goal, waypoints: waypoints ?? [] };
}
