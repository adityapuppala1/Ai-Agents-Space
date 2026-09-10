// Agent avatars: procedural figures, role accessories, activity -> pose
// mapping with cross-faded blending, walking transitions (a visual transition
// only, never a state), seeded idle variations, the talking indicator, the
// delivered-artifact chip and the short completion celebration.
import * as THREE from "three";
import { builders, textTexture } from "./scene.js";
import {
  ACTIVITY_LABELS,
  PROVIDER_LABELS,
  activityOf,
  activityLabel,
  providerLabel,
  statusTone,
  avatarDetailPreset,
  blendFactor,
  blendInto,
  idleVariation,
  roleAccessory,
  BLEND_MS,
} from "./data.js";

// Re-exported so existing importers (Office.jsx) keep one entry point.
export {
  ACTIVITY_LABELS,
  PROVIDER_LABELS,
  activityOf,
  activityLabel,
  providerLabel,
  statusTone,
  roleAccessory,
  BLEND_MS,
};

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
const DELIVERY_MS = 2600;

/** Outfit tint for a style name; falls back to the agent colour. */
function outfitColor(style, fallback) {
  const outfits = {
    hoodie: "#5c6f86",
    shirt: fallback,
    labcoat: "#e8eef3",
    vest: "#3f4d5f",
    jacket: "#46586d",
  };
  if (!style?.outfit) return fallback;
  return outfits[String(style.outfit)] ?? fallback;
}

/**
 * Creates a figure for `agent`. Geometry/materials are tracked by `res`.
 * `options.style` = { outfit, accessory, hairColor, pronouns } (avatarStyles),
 * `options.detail` = "low" | "medium" | "high".
 */
export function createFigure(agent, index, res, options = {}) {
  const style = options.style ?? null;
  const detail = avatarDetailPreset(options.detail);
  const { box, cylinder, sphere, plane } = builders(res);
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const baseColor = agent.color ?? "#8aa8bd";
  const accent = res.material(outfitColor(style, baseColor));
  const skin = res.material(SKINS[index % SKINS.length]);
  const hair = res.material(
    style?.hairColor ? String(style.hairColor) : HAIRS[index % HAIRS.length],
  );
  const dark = res.material("#303f51");

  const torso = cylinder(0.23, 0.27, 0.52, accent, 0, 1.02, 0, body);
  const head = sphere(0.255, skin, 0, 1.52, 0, body);
  const cap = sphere(0.26, hair, 0, 1.62, 0.04, body);
  cap.scale.y = 0.65;
  if (detail.hair && index % 3 === 1)
    box(0.44, 0.34, 0.17, hair, 0, 1.45, 0.2, body);

  // Role accessory: geometry only, no assets, never colour alone.
  const accessory = detail.accessories ? roleAccessory(agent, style) : null;
  if (accessory === "hardhat") {
    const shell = res.material("#e0a63f");
    sphere(0.27, shell, 0, 1.66, 0, body).scale.set(1, 0.62, 1);
    cylinder(0.33, 0.33, 0.03, shell, 0, 1.6, 0.02, body, 18);
    box(0.2, 0.03, 0.14, shell, 0, 1.61, -0.26, body);
  } else if (accessory === "glasses") {
    const frame = res.material("#22303e");
    for (const dx of [-0.11, 0.11])
      box(0.15, 0.11, 0.02, frame, dx, 1.53, -0.235, body);
    box(0.08, 0.02, 0.02, frame, 0, 1.53, -0.235, body);
    for (const dx of [-0.19, 0.19])
      box(0.02, 0.02, 0.16, frame, dx, 1.54, -0.16, body);
  } else if (accessory === "headset") {
    const shell = res.material("#3a4a5c");
    for (const dx of [-0.24, 0.24])
      cylinder(0.09, 0.09, 0.06, shell, dx, 1.55, 0, body, 12).rotation.z =
        Math.PI / 2;
    box(0.5, 0.05, 0.06, shell, 0, 1.74, 0, body);
    box(0.02, 0.02, 0.2, shell, 0.2, 1.5, -0.14, body);
  } else if (accessory === "clipboard") {
    box(0.2, 0.26, 0.02, res.material("#d8cfae"), 0.3, 1.0, -0.18, body);
  }

  const arms = {};
  const legs = {};
  for (const side of ["L", "R"]) {
    const dx = side === "L" ? -0.28 : 0.28;
    const shoulder = new THREE.Group();
    shoulder.position.set(dx, 1.22, 0);
    body.add(shoulder);
    cylinder(0.065, 0.075, 0.4, accent, 0, -0.22, 0, shoulder);
    sphere(0.075, skin, 0, -0.45, 0, shoulder);
    arms[side] = shoulder;
    const hip = new THREE.Group();
    hip.position.set(dx * 0.57, 0.66, 0);
    body.add(hip);
    box(0.16, 0.36, 0.17, dark, 0, -0.2, 0, hip);
    if (detail.legs) box(0.18, 0.1, 0.3, dark, 0, -0.42, -0.06, hip);
    legs[side] = hip;
  }
  const ring = new THREE.Mesh(
    res.ring(0.47, 0.5),
    res.track(
      new THREE.MeshBasicMaterial({
        color: baseColor,
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

  // Talking indicator: three dots that pulse while a recorded message or
  // handoff is attributed to this agent. It never carries invented text.
  const talk = new THREE.Group();
  talk.position.set(-0.34, 0.02, 0);
  indicators.add(talk);
  const talkDots = [0, 1, 2].map((i) =>
    sphere(
      0.055,
      res.material("#f2f6fa", {
        emissive: "#dbe7f2",
        emissiveIntensity: 0.35,
      }),
      -0.13 + i * 0.13,
      0,
      0,
      talk,
    ),
  );

  // Delivered artifact: a small parcel held after a completion.
  const delivery = new THREE.Group();
  delivery.position.set(0.34, 0.92, -0.26);
  group.add(delivery);
  box(0.24, 0.2, 0.2, res.material("#c8a874"), 0, 0, 0, delivery);
  box(0.26, 0.04, 0.06, res.material("#8a6f4a"), 0, 0.05, 0, delivery);

  for (const m of [blocked, stale, error, badge, celebrate]) m.visible = false;
  talk.visible = false;
  delivery.visible = false;

  group.traverse((obj) => {
    if (obj.isMesh) obj.userData.agentId = agent.id;
  });
  return {
    id: agent.id,
    group,
    body,
    detail: options.detail ?? "medium",
    styleKey: styleKeyOf(style, agent),
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
      talk,
      talkDots,
      delivery,
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
    deliverUntil: 0,
    talking: false,
    clustered: false,
    seed: index * 1.37,
    // Blended pose state (cross-faded over BLEND_MS between activities).
    pose: {
      armL: 0,
      armR: 0,
      headX: 0,
      headY: 0,
      bodyX: 0,
      bodyScaleY: 1,
      legL: 0,
      legR: 0,
    },
  };
}

/** Identity of the visual style so the caller can rebuild on a change. */
export function styleKeyOf(style, agent) {
  return [
    style?.outfit ?? "",
    style?.accessory ?? roleAccessory(agent, null) ?? "",
    style?.hairColor ?? "",
  ].join("|");
}

/**
 * Applies a new agent snapshot: starts a walk when the destination changed,
 * flips indicators, and reports whether a completion celebration is due.
 * `extra.talking` shows the talking indicator (a recorded message exists).
 */
export function applyAgentState(
  fig,
  agent,
  target,
  { now, reducedMotion, talking = false, walkMs = WALK_MS } = {},
) {
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
    fig.walkMs = reducedMotion ? 0 : walkMs;
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
  fig.talking =
    !!talking && (TALKING.has(activity) || activity === "MESSAGING");
  p.talk.visible = fig.talking;

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
  if (completed) fig.deliverUntil = now + DELIVERY_MS;
  fig.prev = {
    activity,
    runStatus: agent.runStatus ?? null,
    completed: agent.completed ?? 0,
  };
  return completed;
}

const tmpDir = new THREE.Vector3();

/**
 * Per-frame animation. `time` in ms, `dtMs` is the frame delta used for the
 * 250 ms cross-fade between pose targets.
 */
export function animateFigure(
  fig,
  time,
  { reducedMotion, running, selected, dtMs = 16, rate = 1, walkingDone } = {},
) {
  const p = fig.parts;
  const s = fig.seed;
  const k = reducedMotion ? 1 : blendFactor(dtMs);
  // `rate` is the graphics preset's animation rate: it slows every ambient
  // oscillation without changing what the pose means.
  const target = poseTarget(fig, time * rate, reducedMotion, running);
  // Walking transition.
  if (fig.walking) {
    const t = Math.min(1, (time - fig.walkStart) / fig.walkMs);
    const e = t * t * (3 - 2 * t);
    fig.pos.lerpVectors(fig.from, fig.to, e);
    fig.group.position.copy(fig.pos);
    tmpDir.subVectors(fig.to, fig.from);
    if (tmpDir.lengthSq() > 0.001) fig.yaw = Math.atan2(-tmpDir.x, -tmpDir.z);
    if (t >= 1) {
      fig.walking = false;
      fig.pos.copy(fig.to);
      fig.group.position.copy(fig.pos);
      walkingDone?.(fig);
    }
  } else {
    fig.yaw = fig.targetYaw;
  }
  blendInto(fig.pose, target, k);
  const pose = fig.pose;
  p.arms.L.rotation.x = pose.armL;
  p.arms.R.rotation.x = pose.armR;
  p.legs.L.rotation.x = pose.legL;
  p.legs.R.rotation.x = pose.legR;
  p.head.rotation.set(pose.headX, pose.headY, 0);
  fig.body.rotation.x = pose.bodyX;
  fig.body.scale.y = pose.bodyScaleY;

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
  p.delivery.visible = fig.deliverUntil > time;
  if (p.talk.visible && !reducedMotion) {
    p.talkDots.forEach((dot, i) => {
      const wave = Math.sin(time * 0.009 + i * 1.1 + s);
      dot.scale.setScalar(0.8 + Math.max(0, wave) * 0.7);
    });
  } else if (p.talk.visible) {
    p.talkDots.forEach((dot) => dot.scale.setScalar(1));
  }
}

/** Pose targets per activity, plus the seeded idle variation. */
function poseTarget(fig, time, reducedMotion, running) {
  const a = fig.activity;
  const motion = !reducedMotion && running !== false;
  const s = fig.seed;
  const pose = {
    armL: 0,
    armR: 0,
    headX: 0,
    headY: 0,
    bodyX: 0,
    bodyScaleY: 1,
    legL: 0,
    legR: 0,
  };
  if (fig.walking) {
    const swing = motion ? Math.sin(time * 0.02) * 0.6 : 0;
    pose.legL = swing;
    pose.legR = -swing;
    pose.armL = -swing * 0.6;
    pose.armR = swing * 0.6;
    return pose;
  }
  if (TYPING.has(a)) {
    pose.armL = -1.15 + (motion ? Math.sin(time * 0.02 + s) * 0.06 : 0);
    pose.armR = -1.15 + (motion ? Math.cos(time * 0.02 + s) * 0.06 : 0);
    pose.headX = 0.12;
    pose.bodyX = motion ? Math.sin(time * 0.005 + s) * 0.02 : 0;
  } else if (TALKING.has(a)) {
    pose.armL = -0.4;
    pose.armR = motion ? -0.9 + Math.sin(time * 0.006 + s) * 0.35 : -0.9;
    pose.headY = motion ? Math.sin(time * 0.003 + s) * 0.18 : 0;
    pose.headX = motion ? Math.sin(time * 0.009 + s) * 0.05 : 0;
  } else if (FOCUSED.has(a)) {
    pose.armL = -0.8;
    pose.armR = -0.8;
    pose.headX = 0.18;
    pose.headY = motion ? Math.sin(time * 0.0015 + s) * 0.25 : 0;
  } else if (a === "WAITING_APPROVAL") {
    pose.armL = -0.2;
    pose.armR = Math.PI * 0.95;
  } else if (a === "IDLE") {
    pose.armL = -0.1;
    pose.armR = -0.1;
    pose.headY = motion ? Math.sin(time * 0.001 + s) * 0.35 : 0.2;
    pose.bodyX = 0.05;
    pose.bodyScaleY = motion ? 1 + Math.sin(time * 0.002 + s) * 0.01 : 1;
    if (motion) applyIdleVariation(pose, fig, time);
  } else {
    // BLOCKED / STALE / ERROR: still, arms down, indicator does the talking.
    pose.armL = 0.05;
    pose.armR = 0.05;
    pose.headX = -0.08;
  }
  return pose;
}

/** Stretch / sip / look-around on a seeded schedule (idle agents only). */
function applyIdleVariation(pose, fig, time) {
  const { kind, phase } = idleVariation(fig.seed, time);
  if (kind === "none") return;
  const swell = Math.sin(Math.PI * phase);
  if (kind === "stretch") {
    pose.armL = -0.1 - swell * 2.4;
    pose.armR = -0.1 - swell * 2.4;
    pose.headX = -0.22 * swell;
    pose.bodyScaleY = 1 + swell * 0.03;
  } else if (kind === "sip") {
    pose.armR = -0.1 - swell * 1.9;
    pose.headX = 0.12 * swell;
  } else if (kind === "look") {
    pose.headY = Math.sin(phase * Math.PI * 2) * 0.8;
    pose.bodyX = 0.05 - swell * 0.03;
  }
}

/** Short particle burst (<= 1 s). Caller skips it under reducedMotion / low graphics. */
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
