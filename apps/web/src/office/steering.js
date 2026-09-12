// How agents behave around each other: not walking through a colleague, and
// looking at whatever the record says is worth looking at.
//
// The navigation grid (office/navmesh.js) is blind to anything that moves —
// it plans against the furniture, once, when a walk starts. People are the
// part it cannot plan for, so they are handled here instead, per frame, as a
// small sideways nudge on top of the planned path.
//
// Everything here is pure: plain records in, plain records out, no three.js
// and no scene. The caller applies the result.

/**
 * How close a neighbour has to be before an agent gives way at full
 * strength. Inside this, it is already uncomfortably close.
 */
export const PERSONAL_SPACE = 0.62;

/**
 * How far ahead an agent notices someone and starts to drift aside.
 *
 * This is deliberately much larger than PERSONAL_SPACE. Two agents walking
 * at each other close at twice the 2.3 units/second walking pace, so waiting
 * until they are already crowded leaves about eight frames to move — which
 * reads as two people teleporting apart at the last moment. Reacting early
 * and gently is both what people do and what looks right.
 */
export const AWARENESS = 2;

/** How far off its path a nudge may ever push an agent. */
export const MAX_NUDGE = 0.24;

/** How quickly a nudge is taken up and let go, per 16 ms frame. */
export const NUDGE_BLEND = 0.14;

/**
 * How far the head turns before the body would have to. Roughly 69 degrees,
 * which is about the limit of a comfortable glance.
 */
export const GAZE_LIMIT = 1.2;

/** How quickly a glance lands, per 16 ms frame. */
export const GAZE_BLEND = 0.08;

const EPSILON = 1e-4;

function normalise(x, z) {
  const length = Math.hypot(x, z);
  if (length < EPSILON) return null;
  return { x: x / length, z: z / length };
}

/**
 * Where each walking agent should step aside to, given everyone's position.
 *
 * `people` is `[{ id, x, z, dx, dz, walking }]`, where (dx, dz) is the
 * direction it is heading. Only walking agents are steered: someone standing
 * or sitting keeps its place and is walked around, which is both simpler and
 * truer — an agent at its desk has no reason to shuffle.
 *
 * Returns a Map of id → `{ x, z }`, the desired sideways offset. Agents not
 * in the map want no offset.
 */
export function separation(people, options = {}) {
  const space = options.space ?? PERSONAL_SPACE;
  const notice = Math.max(options.awareness ?? AWARENESS, space);
  const max = options.max ?? MAX_NUDGE;
  const out = new Map();
  for (const self of people) {
    if (!self.walking) continue;
    let pushX = 0;
    let pushZ = 0;
    const heading = normalise(self.dx ?? 0, self.dz ?? 0);
    for (const other of people) {
      if (other === self || other.id === self.id) continue;
      const toX = other.x - self.x;
      const toZ = other.z - self.z;
      const distance = Math.hypot(toX, toZ);
      if (distance >= notice || distance < EPSILON) continue;
      // Full strength once inside personal space, easing in from the moment
      // the other agent is noticed.
      const strength =
        distance <= space
          ? 1
          : (notice - distance) / Math.max(EPSILON, notice - space);

      // Step sideways, not backwards: the part of "away from them" that is
      // across the direction of travel. Going straight back would undo the
      // walk; going across it keeps the agent moving and still clears.
      const awayX = -toX;
      const awayZ = -toZ;
      let lateral = null;
      if (heading) {
        const along = awayX * heading.x + awayZ * heading.z;
        lateral = normalise(
          awayX - along * heading.x,
          awayZ - along * heading.z,
        );
      }
      if (!lateral) {
        // Dead ahead, or standing still: pass on the right, the same way
        // every time, so two agents meeting head-on choose opposite sides
        // instead of mirroring each other into a deadlock.
        lateral = heading
          ? { x: heading.z, z: -heading.x }
          : (normalise(awayX, awayZ) ?? { x: 1, z: 0 });
      }
      pushX += lateral.x * strength;
      pushZ += lateral.z * strength;
    }
    if (pushX === 0 && pushZ === 0) continue;
    const length = Math.hypot(pushX, pushZ);
    const scale = Math.min(max, length * max) / length;
    out.set(self.id, { x: pushX * scale, z: pushZ * scale });
  }
  return out;
}

/** Moves `current` toward `want` by `blend`, scaled for the frame length. */
export function easeNudge(current, want, dtMs = 16, blend = NUDGE_BLEND) {
  const k = Math.min(1, blend * (dtMs / 16));
  return {
    x: current.x + (want.x - current.x) * k,
    z: current.z + (want.z - current.z) * k,
  };
}

/** The shortest signed way round from `from` to `to`, in radians. */
export function shortestTurn(from, to) {
  const delta = to - from;
  return Math.atan2(Math.sin(delta), Math.cos(delta));
}

/**
 * The yaw that points a figure standing at (x, z) toward `target`.
 * Follows the scene's convention that yaw 0 looks down -z.
 */
export function yawToward(x, z, target) {
  return Math.atan2(-(target.x - x), -(target.z - z));
}

/**
 * How far the head should turn to look at `target`, relative to the body it
 * sits on. Beyond the comfortable limit the head stops and the rest of the
 * turn is simply not made — an agent does not crane round to look at
 * something behind it.
 *
 * Returns 0 when there is nothing to look at, or when it is too far round.
 */
export function gazeOffset(x, z, bodyYaw, target, limit = GAZE_LIMIT) {
  if (!target) return 0;
  const dx = target.x - x;
  const dz = target.z - z;
  if (Math.hypot(dx, dz) < EPSILON) return 0;
  const turn = shortestTurn(bodyYaw, yawToward(x, z, target));
  // Further round than the neck goes: look ahead instead of half-turning at
  // something the agent cannot see.
  if (Math.abs(turn) > limit + 0.35) return 0;
  const capped = Math.max(-limit, Math.min(limit, turn));
  // Normalise -0 away: it is harmless in a rotation but surprising in a test
  // and in any comparison that uses Object.is.
  return capped === 0 ? 0 : capped;
}

/**
 * Who each agent should be looking at.
 *
 * The only thing that earns a glance is a colleague the record says is
 * speaking — a recorded message, not an inference. `people` is
 * `[{ id, x, z, talking, place }]`, where `place` groups agents that can
 * plausibly see each other (a conference room key, or null for the floor).
 *
 * Returns a Map of id → `{ x, z }`. An agent that is speaking, or that has
 * nobody to look at, is absent from the map and keeps its head forward.
 */
export function gazeTargets(people, options = {}) {
  const reach = options.reach ?? 6;
  const speakers = people.filter((p) => p.talking);
  if (!speakers.length) return new Map();
  const out = new Map();
  for (const self of people) {
    if (self.talking) continue;
    let best = null;
    let bestDistance = Infinity;
    for (const speaker of speakers) {
      if (speaker.id === self.id) continue;
      // Only people in the same place: nobody looks through a wall, and an
      // agent across an open floor is too far away to be looking at anyone.
      if ((speaker.place ?? null) !== (self.place ?? null)) continue;
      const distance = Math.hypot(speaker.x - self.x, speaker.z - self.z);
      if (distance > reach || distance >= bestDistance) continue;
      bestDistance = distance;
      best = speaker;
    }
    if (best) out.set(self.id, { x: best.x, z: best.z });
  }
  return out;
}
