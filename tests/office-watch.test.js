import test from "node:test";
import assert from "node:assert/strict";
import {
  WATCH_AHEAD,
  WATCH_LIFT,
  facingOf,
  shoulderPolarAngle,
  shoulderView,
} from "../apps/web/src/office/watch.js";
import { deskSeat } from "../apps/web/src/office/obstacles.js";
import { computeLayout } from "../apps/web/src/office/zones.js";

/**
 * Standing behind an agent to see what it is working on. Pure arithmetic, so
 * the geometry is checked without a browser or a scene.
 */

const near = (a, b, tolerance = 1e-9) => Math.abs(a - b) < tolerance;

test("facing follows the scene's own yaw convention", () => {
  // Yaw 0 looks down -z.
  const ahead = facingOf(0);
  assert.ok(near(ahead.x, 0));
  assert.ok(near(ahead.z, -1));
  // A quarter turn looks down -x, matching atan2(-dx, -dz).
  const quarter = facingOf(Math.PI / 2);
  assert.ok(near(quarter.x, -1));
  assert.ok(near(quarter.z, 0));
  // Facing is always a unit vector, so distances mean what they say.
  for (const yaw of [0, 0.7, 2.2, -1.9, Math.PI]) {
    const f = facingOf(yaw);
    assert.ok(near(Math.hypot(f.x, f.z), 1));
  }
});

test("the camera stands behind the agent and looks past it", () => {
  const agent = { x: 3, z: -2, yaw: 0 };
  const view = shoulderView(agent);
  const facing = facingOf(agent.yaw);

  // The target is in front of the agent: that is where its screen is.
  const toTarget = {
    x: view.target.x - agent.x,
    z: view.target.z - agent.z,
  };
  assert.ok(
    toTarget.x * facing.x + toTarget.z * facing.z > 0,
    "the camera looks at what the agent is facing",
  );
  assert.ok(near(Math.hypot(toTarget.x, toTarget.z), WATCH_AHEAD));

  // The camera itself is behind the agent, and above it.
  const toCamera = {
    x: view.position.x - agent.x,
    z: view.position.z - agent.z,
  };
  assert.ok(
    toCamera.x * facing.x + toCamera.z * facing.z < 0,
    "the camera is behind the agent, not in front of it",
  );
  assert.ok(view.position.y > view.target.y, "and above what it looks at");
});

test("turning the agent carries the view round with it", () => {
  const seen = [];
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const view = shoulderView({ x: 0, z: 0, yaw });
    seen.push(`${view.position.x.toFixed(2)},${view.position.z.toFixed(2)}`);
  }
  assert.equal(
    new Set(seen).size,
    4,
    "each facing gives its own vantage point",
  );
  // The height never changes as it turns: only the bearing does.
  const heights = [0, 1, 2, 3].map(
    (i) => shoulderView({ x: 0, z: 0, yaw: i }).position.y,
  );
  assert.ok(heights.every((h) => near(h, heights[0])));
});

test("the angle stays inside what the orbit controls allow", () => {
  // camera.js clamps polar angle to [0.25, 1.22]; a view outside that would
  // be silently corrected into a different one.
  const angle = shoulderPolarAngle(WATCH_LIFT);
  assert.ok(angle > 0.25 && angle < 1.22, `polar angle ${angle} is out of range`);
});

test("the camera sits well clear of the floor it is looking at", () => {
  // Orthographic, so distance is not about size — it is about not slicing
  // through the room with the near plane.
  const view = shoulderView({ x: 0, z: 0, yaw: 0 });
  const span = Math.hypot(
    view.position.x - view.target.x,
    view.position.y - view.target.y,
    view.position.z - view.target.z,
  );
  assert.ok(span > 10, `camera is only ${span.toFixed(1)} units back`);
});

test("watching an agent at its desk looks at the desk, not the wall", () => {
  const layout = computeLayout(9, "studio", null);
  const desk = layout.desks[4];
  const seat = deskSeat(desk);
  // A seated agent faces its monitor, which is on the far (-z) side.
  const view = shoulderView({ x: seat.x, z: seat.z, yaw: seat.facing });
  assert.ok(
    view.target.z < seat.z,
    "the view looks toward the desk the agent is sitting at",
  );
  assert.ok(near(view.target.x, desk.x));
});

test("nobody selected is nothing to watch", () => {
  assert.equal(shoulderView(null), null);
  assert.equal(shoulderView({ x: Number.NaN, z: 0 }), null);
  // A figure with no recorded yaw still gives a usable view rather than NaN.
  const view = shoulderView({ x: 1, z: 1 });
  assert.ok(Number.isFinite(view.position.x) && Number.isFinite(view.target.z));
});
