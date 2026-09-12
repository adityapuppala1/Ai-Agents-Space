// Standing behind an agent to see what it is working on.
//
// The office camera is orthographic, so "getting closer" is zoom, not
// distance: the position here only sets the *direction* the scene is viewed
// from, and is deliberately far enough back that nothing clips through the
// near plane. What makes it read as over-the-shoulder is the angle — low and
// behind — and a target placed in front of the agent, where its monitor is,
// rather than on the agent itself.
//
// Pure arithmetic, no three.js, so node:test covers it.

/** How far back the camera sits. Orthographic: affects clipping, not size. */
export const WATCH_DISTANCE = 14;

/**
 * How much of the offset is upward rather than backward. 0.55 against 1.0
 * back gives a polar angle near 1.07 radians — a low shoulder angle that
 * still sits inside the orbit controls' own limit of 1.22, so entering and
 * leaving the view never fights the control that owns the camera.
 */
export const WATCH_LIFT = 0.55;

/** How far in front of the agent the camera looks: roughly its screen. */
export const WATCH_AHEAD = 1.3;

/** Height of the thing being looked at — a desk monitor, near eye level. */
export const WATCH_EYE = 1.4;

/** Zoom that fills the frame with an agent and its desk. */
export const WATCH_ZOOM = 3;

/**
 * Which way a figure faces for a given yaw.
 *
 * The scene's convention is that yaw 0 looks down -z (office/avatars.js sets
 * `yaw = atan2(-dx, -dz)` from the direction of travel), so this is that
 * relation read backwards.
 */
export function facingOf(yaw) {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}

/**
 * Where to put the camera, and what to point it at, to watch `agent` work.
 *
 * `agent` is `{ x, z, yaw }`. Returns `{ position, target }` in world units.
 * Null in, null out — a caller with nobody selected has nothing to watch.
 */
export function shoulderView(agent, options = {}) {
  if (!agent || !Number.isFinite(agent.x) || !Number.isFinite(agent.z))
    return null;
  const distance = options.distance ?? WATCH_DISTANCE;
  const lift = options.lift ?? WATCH_LIFT;
  const ahead = options.ahead ?? WATCH_AHEAD;
  const eye = options.eye ?? WATCH_EYE;
  const yaw = Number.isFinite(agent.yaw) ? agent.yaw : 0;
  const facing = facingOf(yaw);

  // What the agent is looking at, which is what we want to see too.
  const target = {
    x: agent.x + facing.x * ahead,
    y: eye,
    z: agent.z + facing.z * ahead,
  };

  // Back along the way it faces, and up. Normalised so `distance` means the
  // same thing whatever the lift is set to.
  const length = Math.hypot(1, lift);
  const back = { x: -facing.x / length, z: -facing.z / length };
  const up = lift / length;
  return {
    position: {
      x: target.x + back.x * distance,
      y: target.y + up * distance,
      z: target.z + back.z * distance,
    },
    target,
  };
}

/**
 * The angle down from vertical that `shoulderView` produces, in radians.
 * Orbit controls clamp their own polar angle, so a view outside that range
 * would be silently corrected into a different one; the tests check this
 * stays inside it.
 */
export function shoulderPolarAngle(lift = WATCH_LIFT) {
  return Math.atan2(1, lift);
}
