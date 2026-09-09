// Agent avatars: procedural figures, activity → pose/indicator mapping,
// walking transitions (a visual transition only, never a state) and the
// short completion celebration.
import * as THREE from "three";
import { builders, textTexture } from "./scene.js";

/** UI vocabulary from docs/ARCHITECTURE.md §6. */
export const ACTIVITY_LABELS = {
  IDLE: "Available",
  ANALYZING: "Planning",
  CODING: "Coding",
  RESEARCHING: "Researching",
  TESTING: "Testing",
  DEBUGGING: "Debugging",
  REVIEWING: "Reviewing",
  COMMANDING: "Running command",
  MESSAGING: "Messaging",
  DELEGATING: "Delegating",
  WAITING_APPROVAL: "Needs approval",
  BLOCKED: "Blocked",
  ERROR: "Error",
  STALE: "Stale",
};

export const PROVIDER_LABELS = {
  "claude-code": "Claude Code",
  codex: "Codex",
  copilot: "Copilot",
  cursor: "Cursor",
  gemini: "Gemini",
};

const KNOWN = new Set(Object.keys(ACTIVITY_LABELS));

/** Activity with fallback to the legacy `state` field. */
export function activityOf(agent) {
  if (!agent) return "IDLE";
  if (agent.activity && KNOWN.has(agent.activity)) return agent.activity;
  if (agent.state && KNOWN.has(agent.state)) return agent.state;
  return "IDLE";
}

export function activityLabel(agent) {
  return ACTIVITY_LABELS[activityOf(agent)] ?? "Available";
}

/** Provider badge text; never relies on colour alone. */
export function providerLabel(agent) {
  if (agent?.provider && PROVIDER_LABELS[agent.provider])
    return PROVIDER_LABELS[agent.provider];
  if (agent?.runMode === "simulated") return "Demo";
  return "Manual";
}

/** Non-colour status class used by the label dot (matches existing .dot classes). */
export function statusTone(agent) {
  const a = activityOf(agent);
  if (a === "ERROR") return "red";
  if (a === "BLOCKED" || a === "WAITING_APPROVAL") return "amber";
  if (a === "IDLE" || a === "STALE") return "gray";
  return "green";
}

const TYPING = new Set(["CODING", "COMMANDING", "DEBUGGING"]);
const TALKING = new Set(["MESSAGING", "DELEGATING"]);
const FOCUSED = new Set(["RESEARCHING", "ANALYZING", "TESTING", "REVIEWING"]);

const SKINS = [
  "#e5bd9f",
  "#bd8e74",
  "#e3b995",
  "#d6a889",
  "#a87961",
  "#ecc8a8",
];
const HAIRS = [
  "#60534b",
  "#343e50",
  "#493d38",
  "#8f704b",
  "#48413f",
  "#665645",
];

export const WALK_MS = 800;

/** Creates a figure for `agent`. Geometry/materials are tracked by `res`. */
export function createFigure(agent, index, res) {
  const { box, cylinder, sphere, plane } = builders(res);
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const accent = res.material(agent.color ?? "#8aa8bd");
  const skin = res.material(SKINS[index % SKINS.length]);
  const hair = res.material(HAIRS[index % HAIRS.length]);
  const dark = res.material("#303f51");

  const torso = cylinder(0.23, 0.27, 0.52, accent, 0, 1.02, 0, body);
  const head = sphere(0.255, skin, 0, 1.52, 0, body);
  const cap = sphere(0.26, hair, 0, 1.62, 0.04, body);
  cap.scale.y = 0.65;
  if (index % 3 === 1) box(0.44, 0.34, 0.17, hair, 0, 1.45, 0.2, body);
  const arms = {};
  const legs = {};
  for (const side of ["L", "R"]) {
    const dx = side === "L" ? -0.28 : 0.28;
    const shoulder = new THREE.Group();
    shoulder.position.set(dx, 1.22, 0);
    body.add(shoulder);
    const arm = cylinder(0.065, 0.075, 0.4, accent, 0, -0.22, 0, shoulder);
    void arm;
    sphere(0.075, skin, 0, -0.45, 0, shoulder);
    arms[side] = shoulder;
    const hip = new THREE.Group();
    hip.position.set(dx * 0.57, 0.66, 0);
    body.add(hip);
    box(0.16, 0.36, 0.17, dark, 0, -0.2, 0, hip);
    box(0.18, 0.1, 0.3, dark, 0, -0.42, -0.06, hip);
    legs[side] = hip;
  }
  const ring = new THREE.Mesh(
    res.ring(0.47, 0.5),
    res.track(
      new THREE.MeshBasicMaterial({
        color: agent.color ?? "#8aa8bd",
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.3,
      }),
    ),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.025;
  group.add(ring);

  // Indicators above the head. Distinct shapes, not only colours.
  const indicators = new THREE.Group();
  indicators.position.y = 2.05;
  group.add(indicators);
  const blocked = sphere(
    0.14,
    res.material("#c6a064", { emissive: "#c6a064", emissiveIntensity: 0.4 }),
    0,
    0,
    0,
    indicators,
  );
  const stale = sphere(0.14, res.material("#9aa4ae"), 0, 0, 0, indicators);
  stale.scale.set(1, 0.4, 1);
  const error = new THREE.Mesh(
    res.octahedron(0.17),
    res.material("#c8524a", { emissive: "#c8524a", emissiveIntensity: 0.5 }),
  );
  indicators.add(error);
  const badgeTexture = textTexture(res, {
    lines: ["?", "approval"],
    bg: "#fff4d6",
    fg: "#7a5a12",
    w: 128,
    h: 96,
    bold: "bold 40px sans-serif",
    mono: "14px sans-serif",
  });
  const badge = plane(
    0.5,
    0.38,
    res.track(
      new THREE.MeshBasicMaterial({
        map: badgeTexture,
        side: THREE.DoubleSide,
      }),
    ),
    0.35,
    0.1,
    0,
    indicators,
  );
  const celebrate = sphere(
    0.1,
    res.material("#77a98b", { emissive: "#77a98b", emissiveIntensity: 0.6 }),
    0,
    0.05,
    0,
    indicators,
  );
  for (const m of [blocked, stale, error, badge, celebrate]) m.visible = false;

  group.traverse((obj) => {
    if (obj.isMesh) obj.userData.agentId = agent.id;
  });
  return {
    id: agent.id,
    group,
    body,
    parts: {
      torso,
      head,
      arms,
      legs,
      ring,
      indicators,
      blocked,
      stale,
      error,
      badge,
      celebrate,
    },
    pos: new THREE.Vector3(),
    from: new THREE.Vector3(),
    to: new THREE.Vector3(),
    walkStart: 0,
    walkMs: 0,
    walking: false,
    yaw: 0,
    targetYaw: 0,
    placed: false,
    activity: "IDLE",
    zone: "desk",
    prev: null,
    celebrateUntil: 0,
    clustered: false,
    seed: index * 1.37,
  };
}

/**
 * Applies a new agent snapshot: starts a walk when the destination changed,
 * flips indicators, and reports whether a completion celebration is due.
 */
export function applyAgentState(fig, agent, target, { now, reducedMotion }) {
  const activity = activityOf(agent);
  const previous = fig.prev;
  fig.activity = activity;
  fig.zone = target.zone;
  const dest = new THREE.Vector3(target.x, 0.08, target.z);
  if (!fig.placed) {
    fig.pos.copy(dest);
    fig.group.position.copy(dest);
    fig.yaw = fig.targetYaw = target.facing;
    fig.group.rotation.y = fig.yaw;
    fig.placed = true;
  } else if (
    fig.to.distanceToSquared(dest) > 0.0004 ||
    (!fig.walking && fig.pos.distanceToSquared(dest) > 0.0004)
  ) {
    fig.from.copy(fig.pos);
    fig.walkStart = now;
    fig.walkMs = reducedMotion ? 0 : WALK_MS;
    fig.walking = fig.walkMs > 0;
    if (!fig.walking) {
      fig.pos.copy(dest);
      fig.group.position.copy(dest);
    }
  }
  fig.to.copy(dest);
  fig.targetYaw = target.facing;

  const p = fig.parts;
  p.blocked.visible = activity === "BLOCKED";
  p.stale.visible = activity === "STALE";
  p.error.visible = activity === "ERROR";
  p.badge.visible = activity === "WAITING_APPROVAL";

  let completed = false;
  if (previous) {
    const wasActive = !["IDLE", "BLOCKED", "ERROR", "STALE"].includes(
      previous.activity,
    );
    const finished =
      agent.runStatus === "completed" ||
      previous.runStatus === "completed" ||
      (agent.completed ?? 0) > (previous.completed ?? 0);
    completed = wasActive && activity === "IDLE" && finished;
  }
  fig.prev = {
    activity,
    runStatus: agent.runStatus ?? null,
    completed: agent.completed ?? 0,
  };
  return completed;
}

const tmpDir = new THREE.Vector3();

/** Per-frame animation. `time` in ms. */
export function animateFigure(
  fig,
  time,
  { reducedMotion, running, selected, walkingDone },
) {
  const p = fig.parts;
  const s = fig.seed;
  // Walking transition.
  if (fig.walking) {
    const t = Math.min(1, (time - fig.walkStart) / fig.walkMs);
    const e = t * t * (3 - 2 * t);
    fig.pos.lerpVectors(fig.from, fig.to, e);
    fig.group.position.copy(fig.pos);
    tmpDir.subVectors(fig.to, fig.from);
    if (tmpDir.lengthSq() > 0.001) fig.yaw = Math.atan2(-tmpDir.x, -tmpDir.z);
    const swing = Math.sin(time * 0.02) * 0.6;
    p.legs.L.rotation.x = swing;
    p.legs.R.rotation.x = -swing;
    p.arms.L.rotation.x = -swing * 0.6;
    p.arms.R.rotation.x = swing * 0.6;
    if (t >= 1) {
      fig.walking = false;
      fig.pos.copy(fig.to);
      fig.group.position.copy(fig.pos);
      walkingDone?.(fig);
    }
  } else {
    fig.yaw = fig.targetYaw;
    p.legs.L.rotation.x = 0;
    p.legs.R.rotation.x = 0;
    pose(fig, time, reducedMotion, running);
  }
  // Shortest-arc yaw interpolation.
  let d = fig.yaw - fig.group.rotation.y;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  fig.group.rotation.y += reducedMotion ? d : d * 0.25;

  p.ring.material.opacity = selected ? 1 : 0.3;
  p.ring.scale.setScalar(selected ? 1.3 : 1);
  const bob = reducedMotion ? 0 : Math.sin(time * 0.004 + s) * 0.04;
  p.indicators.position.y = 2.05 + bob;
  p.badge.rotation.y = reducedMotion ? 0 : Math.sin(time * 0.003) * 0.3;
  if (p.error.visible && !reducedMotion) p.error.rotation.y = time * 0.003;
  p.celebrate.visible = fig.celebrateUntil > time;
}

function pose(fig, time, reducedMotion, running) {
  const p = fig.parts;
  const a = fig.activity;
  const motion = !reducedMotion && running !== false;
  const s = fig.seed;
  let armL = 0;
  let armR = 0;
  let headX = 0;
  let headY = 0;
  let bodyX = 0;
  if (TYPING.has(a)) {
    armL = -1.15 + (motion ? Math.sin(time * 0.02 + s) * 0.06 : 0);
    armR = -1.15 + (motion ? Math.cos(time * 0.02 + s) * 0.06 : 0);
    headX = 0.12;
    bodyX = motion ? Math.sin(time * 0.005 + s) * 0.02 : 0;
  } else if (TALKING.has(a)) {
    armL = -0.4;
    armR = motion ? -0.9 + Math.sin(time * 0.006 + s) * 0.35 : -0.9;
    headY = motion ? Math.sin(time * 0.003 + s) * 0.18 : 0;
    headX = motion ? Math.sin(time * 0.009 + s) * 0.05 : 0;
  } else if (FOCUSED.has(a)) {
    armL = -0.8;
    armR = -0.8;
    headX = 0.18;
    headY = motion ? Math.sin(time * 0.0015 + s) * 0.25 : 0;
  } else if (a === "WAITING_APPROVAL") {
    armL = -0.2;
    armR = Math.PI * 0.95;
  } else if (a === "IDLE") {
    armL = -0.1;
    armR = -0.1;
    headY = motion ? Math.sin(time * 0.001 + s) * 0.35 : 0.2;
    bodyX = 0.05;
  } else {
    // BLOCKED / STALE / ERROR: still, arms down, indicator does the talking.
    armL = 0.05;
    armR = 0.05;
    headX = -0.08;
  }
  p.arms.L.rotation.x = armL;
  p.arms.R.rotation.x = armR;
  p.head.rotation.set(headX, headY, 0);
  fig.body.rotation.x = bodyX;
  fig.body.scale.y =
    motion && a === "IDLE" ? 1 + Math.sin(time * 0.002 + s) * 0.01 : 1;
}

/** Short particle burst (≤ 1 s). Caller skips it under reducedMotion / low graphics. */
export function createCelebration(position, color, now) {
  const count = 36;
  const positions = new Float32Array(count * 3);
  const velocities = [];
  for (let i = 0; i < count; i++) {
    positions[i * 3] = position.x;
    positions[i * 3 + 1] = position.y + 1.9;
    positions[i * 3 + 2] = position.z;
    const angle = Math.random() * Math.PI * 2;
    const speed = 1.2 + Math.random() * 1.8;
    velocities.push(
      new THREE.Vector3(
        Math.cos(angle) * speed,
        2.2 + Math.random() * 1.6,
        Math.sin(angle) * speed,
      ),
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: color ?? "#77a98b",
    size: 0.12,
    transparent: true,
    opacity: 1,
  });
  const points = new THREE.Points(geometry, material);
  const born = now;
  const life = 900;
  return {
    points,
    update(time, dt) {
      const age = time - born;
      if (age > life) return false;
      const arr = geometry.attributes.position.array;
      for (let i = 0; i < count; i++) {
        const v = velocities[i];
        v.y -= 6 * dt;
        arr[i * 3] += v.x * dt;
        arr[i * 3 + 1] += v.y * dt;
        arr[i * 3 + 2] += v.z * dt;
      }
      geometry.attributes.position.needsUpdate = true;
      material.opacity = 1 - age / life;
      return true;
    },
    dispose() {
      points.parent?.remove(points);
      geometry.dispose();
      material.dispose();
    },
  };
}
