// Agent avatars: procedural figures, role accessories, activity -> pose
// mapping with cross-faded blending, walking transitions (a visual transition
// only, never a state), seeded idle variations, the talking indicator, the
// delivered-artifact chip and the short completion celebration.
import * as THREE from "three";
import { builders, textTexture } from "./scene.js";
import { GAZE_BLEND, gazeOffset } from "./steering.js";
import {
  ACTIVITY_LABELS,
  PROVIDER_LABELS,
  activityOf,
  activityLabel,
  providerLabel,
  providerGlyph,
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
  providerGlyph,
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
/** Walking pace in world units per second, and the longest a walk may take. */
export const WALK_SPEED = 2.3;
const WALK_MAX_MS = 4500;

/** A walk through a room's door is longer than a straight one; it may take this long. */
export const ROUTE_MAX_MS = 9000;

/** How long a walk of `distance` takes: at least `min`, at walking pace. */
export function walkDuration(distance, min = WALK_MS, max = WALK_MAX_MS) {
  return Math.min(
    max,
    Math.max(min, (Math.max(0, distance) / WALK_SPEED) * 1000),
  );
}

/**
 * Sends a figure that has just started a walk along `waypoints` (through a
 * conference room's door and round its table; office/conference.js) to the
 * place it was already going. It stays one walk: eased once as it sets off
 * and once as it arrives, timed by the length of the whole route. No
 * waypoints: the straight walk stands.
 */
export function followRoute(fig, waypoints = [], { walkMs = WALK_MS } = {}) {
  fig.route = null;
  if (!fig.walking || !waypoints.length) return;
  const points = [
    { x: fig.from.x, z: fig.from.z },
    ...waypoints.map((point) => ({ x: point.x, z: point.z })),
    { x: fig.to.x, z: fig.to.z },
  ];
  const lengths = [0];
  for (let i = 1; i < points.length; i++)
    lengths.push(
      lengths[i - 1] +
        Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z),
    );
  fig.route = { points, lengths, total: lengths[lengths.length - 1] };
  fig.walkMs = walkDuration(fig.route.total, walkMs, ROUTE_MAX_MS);
}

/** Where a routed walk is at `share` (0..1 of its length), and which way it heads. */
export function routePoint(route, share, outPos, outDir) {
  const d = Math.max(0, Math.min(1, share)) * route.total;
  const { points, lengths } = route;
  let i = 1;
  while (i < points.length - 1 && lengths[i] < d) i++;
  const a = points[i - 1];
  const b = points[i];
  const span = lengths[i] - lengths[i - 1];
  const t = span > 0 ? (d - lengths[i - 1]) / span : 1;
  outPos.set(a.x + (b.x - a.x) * t, 0.08, a.z + (b.z - a.z) * t);
  outDir?.set(b.x - a.x, 0, b.z - a.z);
  return outPos;
}
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

  // Runtime insignia: each supported provider gets a different chest shape.
  // The nearby accessible label still names the provider; this geometry makes
  // identity visible in the 3D figure without relying on colour alone.
  const glyph = providerGlyph(agent);
  const providerMark = new THREE.Group();
  providerMark.position.set(-0.1, 1.08, -0.255);
  body.add(providerMark);
  const glyphMaterial = res.material("#edf4fb", {
    emissive: "#8fb6d6",
    emissiveIntensity: 0.18,
  });
  if (glyph === "bars") {
    for (const x of [-0.06, 0, 0.06])
      box(0.025, 0.11, 0.018, glyphMaterial, x, 0, 0, providerMark);
  } else if (glyph === "ring") {
    providerMark.add(new THREE.Mesh(res.ring(0.045, 0.072, 18), glyphMaterial));
  } else if (glyph === "cube") {
    box(0.11, 0.11, 0.025, glyphMaterial, 0, 0, 0, providerMark);
  } else if (glyph === "pointer") {
    const pointer = new THREE.Mesh(res.cone(0.07, 0.13), glyphMaterial);
    pointer.rotation.x = Math.PI / 2;
    providerMark.add(pointer);
  } else if (glyph === "diamond") {
    const diamond = new THREE.Mesh(res.octahedron(0.075), glyphMaterial);
    providerMark.add(diamond);
  }
  providerMark.visible = glyph !== null;

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
  // Cached by colour, not tracked per figure: agents come and go all day, and
  // an untracked material per figure is never released until the whole scene
  // is disposed.
  const ring = new THREE.Mesh(
    res.ring(0.47, 0.5),
    res.cached(
      `figure-ring:${baseColor}`,
      () =>
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
  // The approval badge is identical for every agent, so exactly one texture
  // and one material exist for the whole scene.
  const badgeMaterial = res.cached("figure-approval-badge", () => {
    const texture = textTexture(res, {
      lines: ["?", "approval"],
      bg: "#fff4d6",
      fg: "#7a5a12",
      w: 128,
      h: 96,
      bold: "bold 40px sans-serif",
      mono: "14px sans-serif",
    });
    return new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.DoubleSide,
    });
  });
  const badge = plane(0.5, 0.38, badgeMaterial, 0.35, 0.1, 0, indicators);
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
  return figureRecord(agent, index, {
    group,
    body,
    detail: options.detail ?? "medium",
    styleKey: styleKeyOf(style, agent),
    tier: "full",
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
      providerMark,
    },
  });
}

/**
 * The movement and status bookkeeping every figure carries, whatever tier it
 * is drawn at. Crowd figures share it exactly, so promoting one to the full
 * tier resumes from the position and walk state it already had.
 */
function figureRecord(agent, index, extra) {
  return {
    id: agent.id,
    group: null,
    body: null,
    parts: null,
    detail: "medium",
    styleKey: "",
    tier: "full",
    ...extra,
    pos: new THREE.Vector3(),
    from: new THREE.Vector3(),
    to: new THREE.Vector3(),
    walkStart: 0,
    walkMs: 0,
    walking: false,
    yaw: 0,
    targetYaw: 0,
    // Yaw actually drawn: the full tier writes it onto the group, the crowd
    // tier hands it to the instanced field, so both smooth the same way.
    renderYaw: 0,
    placed: false,
    activity: "IDLE",
    zone: "desk",
    prev: null,
    celebrateUntil: 0,
    deliverUntil: 0,
    talking: false,
    // Set by the scene while a moment plays (office/episodes.js): the pose to
    // strike, and the spot that replaces the activity's destination.
    gesture: null,
    episode: null,
    // The activity's own destination, kept so a moment can walk back to it.
    home: null,
    // A team member whose relay step is queued behind someone else's.
    waiting: false,
    seed: index * 1.37,
    // Blended pose state (cross-faded over BLEND_MS between activities).
    pose: {
      armL: 0,
      armR: 0,
      headX: 0,
      headY: 0,
      bodyX: 0,
      bodyY: 0,
      bodyScaleY: 1,
      legL: 0,
      legR: 0,
    },
    // Seated at a conference table (office/conference.js): the scene sets it
    // when the figure has reached its chair.
    atSeat: false,
    // The waypoints of the current walk, when it goes through a room door
    // (followRoute); null for a straight walk.
    route: null,
    // Where this figure is looking, and how far its head has turned so far.
    // Only a colleague the record says is speaking earns a glance
    // (office/steering.js gazeTargets); null means eyes front.
    lookAt: null,
    gaze: 0,
    // How far it has stepped aside for someone in its way this frame.
    nudge: { x: 0, z: 0 },
  };
}

/**
 * Crowd tier: a resting agent with no scene graph of its own. It is drawn by
 * the instanced crowd field from pos, renderYaw and colour, so it has no limbs
 * and no indicators - which is why only IDLE agents nobody is watching are
 * ever put in this tier.
 */
export function createCrowdFigure(agent, index, options = {}) {
  return figureRecord(agent, index, {
    detail: options.detail ?? "medium",
    styleKey: styleKeyOf(options.style ?? null, agent),
    tier: "crowd",
  });
}

/** Identity of the visual style so the caller can rebuild on a change. */
export function styleKeyOf(style, agent) {
  return [
    style?.outfit ?? "",
    style?.accessory ?? roleAccessory(agent, null) ?? "",
    style?.hairColor ?? "",
    providerGlyph(agent) ?? "",
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
    fig.group?.position.copy(dest);
    fig.yaw = fig.targetYaw = fig.renderYaw = target.facing;
    if (fig.group) fig.group.rotation.y = fig.yaw;
    fig.placed = true;
  } else if (
    fig.to.distanceToSquared(dest) > 0.0004 ||
    (!fig.walking && fig.pos.distanceToSquared(dest) > 0.0004)
  ) {
    fig.from.copy(fig.pos);
    fig.walkStart = now;
    fig.walkMs = reducedMotion
      ? 0
      : walkDuration(fig.pos.distanceTo(dest), walkMs);
    fig.walking = fig.walkMs > 0;
    // A new walk goes straight unless the caller routes it (followRoute).
    fig.route = null;
    if (!fig.walking) {
      fig.pos.copy(dest);
      fig.group?.position.copy(dest);
    }
  }
  fig.to.copy(dest);
  fig.targetYaw = target.facing;

  // A crowd-tier figure has no meshes to flip; it is never in a state that
  // needs an indicator, and it keeps every other field so a promotion is
  // seamless.
  const p = fig.parts;
  if (p) {
    p.blocked.visible = activity === "BLOCKED";
    p.stale.visible = activity === "STALE";
    p.error.visible = activity === "ERROR";
    p.badge.visible = activity === "WAITING_APPROVAL";
  }
  fig.talking =
    !!talking && (TALKING.has(activity) || activity === "MESSAGING");
  if (p) p.talk.visible = fig.talking;

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
  const target = p
    ? poseTarget(fig, time * rate, reducedMotion, running)
    : null;
  // Walking transition.
  if (fig.walking) {
    const t = Math.min(1, (time - fig.walkStart) / fig.walkMs);
    const e = t * t * (3 - 2 * t);
    if (fig.route) routePoint(fig.route, e, fig.pos, tmpDir);
    else {
      fig.pos.lerpVectors(fig.from, fig.to, e);
      tmpDir.subVectors(fig.to, fig.from);
    }
    fig.group?.position.copy(fig.pos);
    if (tmpDir.lengthSq() > 0.001) fig.yaw = Math.atan2(-tmpDir.x, -tmpDir.z);
    if (t >= 1) {
      fig.walking = false;
      fig.route = null;
      fig.pos.copy(fig.to);
      fig.group?.position.copy(fig.pos);
      walkingDone?.(fig);
    }
  } else {
    fig.yaw = fig.targetYaw;
  }
  // Shortest-arc yaw interpolation.
  let dYaw = fig.yaw - fig.renderYaw;
  dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
  fig.renderYaw += reducedMotion ? dYaw : dYaw * 0.25;
  if (fig.group) fig.group.rotation.y = fig.renderYaw;
  if (!p) return;
  blendInto(fig.pose, target, k);
  const pose = fig.pose;
  p.arms.L.rotation.x = pose.armL;
  p.arms.R.rotation.x = pose.armR;
  p.legs.L.rotation.x = pose.legL;
  p.legs.R.rotation.x = pose.legR;
  // A glance at whoever the record says is speaking. Nothing else earns one:
  // an agent never turns to look at something that was not recorded.
  const wantGaze = fig.lookAt
    ? gazeOffset(fig.pos.x, fig.pos.z, fig.renderYaw, fig.lookAt)
    : 0;
  const gazeK = reducedMotion ? 1 : Math.min(1, GAZE_BLEND * (dtMs / 16));
  fig.gaze += (wantGaze - (fig.gaze ?? 0)) * gazeK;
  p.head.rotation.set(pose.headX, pose.headY + fig.gaze, 0);
  fig.body.rotation.x = pose.bodyX;
  fig.body.scale.y = pose.bodyScaleY;
  fig.body.position.y = pose.bodyY;

  p.ring.material.opacity = selected ? 1 : 0.3;
  p.ring.scale.setScalar(selected ? 1.3 : 1);
  const bob = reducedMotion ? 0 : Math.sin(time * 0.004 + s) * 0.04;
  // Indicators ride with the head, seated or standing.
  p.indicators.position.y = 2.05 + pose.bodyY + bob;
  p.badge.rotation.y = reducedMotion ? 0 : Math.sin(time * 0.003) * 0.3;
  if (p.error.visible && !reducedMotion) p.error.rotation.y = time * 0.003;
  p.celebrate.visible = fig.celebrateUntil > time;
  p.delivery.visible = fig.deliverUntil > time;
  // A moment (office/episodes.js) shows who is speaking; otherwise only a
  // recorded message does.
  p.talk.visible = fig.talking || fig.gesture === "talk";
  if (p.talk.visible && !reducedMotion) {
    p.talkDots.forEach((dot, i) => {
      const wave = Math.sin(time * 0.009 + i * 1.1 + s);
      dot.scale.setScalar(0.8 + Math.max(0, wave) * 0.7);
    });
  } else if (p.talk.visible) {
    p.talkDots.forEach((dot) => dot.scale.setScalar(1));
  }
}

/**
 * Poses for the moments in office/episodes.js, set on `fig.gesture` by the
 * scene while one plays: hand a document over, take it, hold it, speak,
 * listen (a slow nod). `wait` is a team member whose relay step is queued.
 */
const GESTURES = {
  carry(pose) {
    pose.armR = 0.95;
  },
  give(pose) {
    pose.armR = 1.45;
    pose.armL = 0.15;
    pose.bodyX = -0.06;
  },
  receive(pose) {
    pose.armL = 1.3;
    pose.armR = 1.3;
    pose.bodyX = -0.03;
  },
  hold(pose) {
    pose.armR = 1.1;
    pose.armL = 0.2;
  },
  talk(pose, motion, time, s) {
    pose.armL = 0.35;
    pose.armR = motion ? 0.9 + Math.sin(time * 0.006 + s) * 0.35 : 0.9;
  },
  listen(pose, motion, time, s) {
    pose.armL = 0.15;
    pose.armR = 0.15;
    pose.bodyX = motion ? -0.02 + Math.sin(time * 0.004 + s) * 0.025 : -0.02;
  },
  wait(pose) {
    // Arms folded in front: both forearms raised across the chest.
    pose.armL = 0.62;
    pose.armR = 0.58;
    pose.bodyX = 0.03;
  },
};

/**
 * A subagent working for an agent: a small, translucent helper in its
 * parent's colour with a lit visor, so it reads as part of that agent and
 * never as another agent profile.
 */
export function createHelperFigure(color, res) {
  const group = new THREE.Group();
  const shell = res.material(color, {
    transparent: true,
    opacity: 0.92,
    emissive: color,
    emissiveIntensity: 0.28,
  });
  const light = res.material("#f4f8fc", {
    emissive: "#dfeaf6",
    emissiveIntensity: 0.4,
  });
  const visor = res.material("#1f2c3a", {
    emissive: color,
    emissiveIntensity: 0.9,
  });
  const base = new THREE.Mesh(res.cylinder(0.17, 0.2, 0.08, 16), light);
  base.position.y = 0.3;
  const torso = new THREE.Mesh(res.cylinder(0.15, 0.18, 0.4, 14), shell);
  torso.position.y = 0.56;
  const head = new THREE.Mesh(res.sphere(0.17), light);
  head.position.y = 0.92;
  const eyes = new THREE.Mesh(res.box(0.22, 0.06, 0.05), visor);
  eyes.position.set(0, 0.94, -0.14);
  const antenna = new THREE.Mesh(res.sphere(0.04), visor);
  antenna.position.y = 1.13;
  const ring = new THREE.Mesh(
    res.ring(0.26, 0.3, 28),
    res.material(color, {
      emissive: color,
      emissiveIntensity: 0.5,
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  group.add(base, torso, head, eyes, antenna, ring);
  return group;
}

/**
 * The document passed at a handoff: a sheet with a coloured header band
 * and two lines of "text". Shared geometry, one small group per moment.
 */
export function createDocumentToken(res, band = 0x8868d8) {
  const group = new THREE.Group();
  const sheet = new THREE.Mesh(
    res.box(0.2, 0.26, 0.016),
    res.material("#f6f2e8", { emissive: "#f6f2e8", emissiveIntensity: 0.12 }),
  );
  const header = new THREE.Mesh(
    res.box(0.2, 0.05, 0.02),
    res.material(band, { emissive: band, emissiveIntensity: 0.5 }),
  );
  header.position.y = 0.105;
  const ink = res.material("#51606f");
  const line1 = new THREE.Mesh(res.box(0.14, 0.014, 0.02), ink);
  line1.position.set(0, 0.03, 0);
  const line2 = new THREE.Mesh(res.box(0.1, 0.014, 0.02), ink);
  line2.position.set(-0.02, -0.02, 0);
  group.add(sheet, header, line1, line2);
  return group;
}

/**
 * Sitting at a conference table: the body lowered onto the chair, legs
 * forward under the table, and the arms doing what the agent's recorded
 * activity says: typing on the laptop, a hand on the trackpad while
 * reading, talking with the hands, a raised hand for an approval, arms
 * folded while waiting its turn, hands in the lap when blocked. A moment's
 * gesture (give, receive, talk, listen) takes the arms, seated.
 */
function seatedPose(pose, fig, a, motion, time, s) {
  pose.bodyY = -0.22;
  pose.legL = 1.42;
  pose.legR = 1.42;
  const wave = (speed, phase = 0) =>
    motion ? Math.sin(time * speed + s + phase) : 0;
  const gesture = GESTURES[fig.gesture];
  if (gesture) {
    gesture(pose, motion, time, s);
    pose.bodyY = -0.22;
    pose.legL = 1.42;
    pose.legR = 1.42;
    return pose;
  }
  if (TYPING.has(a) || a === "MANUAL") {
    const pace = a === "MANUAL" ? 0.3 : 1;
    pose.armL = 1.05 + wave(0.022) * 0.07 * pace;
    pose.armR = 1.05 + wave(0.022, 1.7) * 0.07 * pace;
    pose.bodyX = -0.05 + wave(0.004) * 0.015;
  } else if (TALKING.has(a)) {
    pose.armL = 0.55;
    pose.armR = 0.85 + wave(0.006) * 0.35;
    pose.bodyX = -0.03;
  } else if (FOCUSED.has(a)) {
    // Reading: one hand on the trackpad, now and then a scroll.
    pose.armR = 0.95 + Math.max(0, wave(0.0025)) * 0.12;
    pose.armL = 0.3;
    pose.bodyX = -0.07;
  } else if (a === "WAITING_APPROVAL") {
    pose.armL = 0.3;
    pose.armR = Math.PI * 0.92;
  } else if (a === "IDLE") {
    // Waiting for a colleague's step: sitting back, arms folded.
    pose.armL = 0.62;
    pose.armR = 0.58;
    pose.bodyX = 0.07 + wave(0.0012) * 0.02;
  } else {
    // BLOCKED / ERROR / STALE: hands in the lap; the indicator says why.
    pose.armL = 0.25;
    pose.armR = 0.25;
    pose.bodyX = 0.02;
  }
  return pose;
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
    bodyY: 0,
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
    // Carrying the document to a handoff: that arm stays forward.
    if (fig.gesture === "carry" || fig.gesture === "hold") pose.armR = 0.95;
    return pose;
  }
  if (fig.atSeat) return seatedPose(pose, fig, a, motion, time, s);
  const gesture = GESTURES[fig.gesture];
  if (gesture) {
    gesture(pose, motion, time, s);
    return pose;
  }
  if (fig.waiting && a === "IDLE") {
    GESTURES.wait(pose, motion, time, s);
    return pose;
  }
  // A positive arm angle swings the hand forward: figures face -z (yaw 0 is
  // the monitor), and a shoulder turned by +x carries the hand to -z. The
  // earlier negative angles reached behind the figure.
  if (TYPING.has(a)) {
    pose.armL = 1.15 + (motion ? Math.sin(time * 0.02 + s) * 0.06 : 0);
    pose.armR = 1.15 + (motion ? Math.cos(time * 0.02 + s) * 0.06 : 0);
    pose.headX = 0.12;
    pose.bodyX = motion ? Math.sin(time * 0.005 + s) * 0.02 : 0;
  } else if (TALKING.has(a)) {
    pose.armL = 0.4;
    pose.armR = motion ? 0.9 + Math.sin(time * 0.006 + s) * 0.35 : 0.9;
    pose.headY = motion ? Math.sin(time * 0.003 + s) * 0.18 : 0;
    pose.headX = motion ? Math.sin(time * 0.009 + s) * 0.05 : 0;
  } else if (FOCUSED.has(a)) {
    pose.armL = 0.8;
    pose.armR = 0.8;
    pose.headX = 0.18;
    pose.headY = motion ? Math.sin(time * 0.0015 + s) * 0.25 : 0;
  } else if (a === "WAITING_APPROVAL") {
    pose.armL = 0.2;
    pose.armR = Math.PI * 0.95;
  } else if (a === "IDLE") {
    pose.armL = 0.1;
    pose.armR = 0.1;
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
    pose.armL = 0.1 + swell * 2.4;
    pose.armR = 0.1 + swell * 2.4;
    pose.headX = -0.22 * swell;
    pose.bodyScaleY = 1 + swell * 0.03;
  } else if (kind === "sip") {
    pose.armR = 0.1 + swell * 1.9;
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
