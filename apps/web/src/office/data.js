// Pure helpers for the living office: label vocabulary, screen content derived
// from recorded data, layout grouping, collision avoidance, pose blending and
// the seeded idle schedule.
//
// This module never imports three and never touches the DOM, so every rule it
// encodes (especially "never invent a number") is unit tested in
// tests/office.test.js.

import { activityOf, MANUAL_ACTIVITY } from "./presence.js";
import { relayLabel } from "./relay.js";
import { timeAgo } from "../hooks/useApi.js";

/** UI vocabulary from docs/ARCHITECTURE.md §6. */
export const ACTIVITY_LABELS = {
  IDLE: "Idle",
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
  // A manual task: the only recorded fact is its status (see presence.js).
  MANUAL: "In progress",
};

export const PROVIDER_LABELS = {
  "claude-code": "Claude Code",
  codex: "Codex",
  copilot: "Copilot",
  cursor: "Cursor",
  gemini: "Gemini",
};

/** Activity with fallback to the legacy `state` field (see presence.js). */
export { activityOf };

export function activityLabel(agent) {
  const activity = activityOf(agent);
  // A team member whose relay step is queued says who it is waiting for
  // (office/relay.js relayPresence), not "Idle".
  if (activity === "IDLE" && agent?.relay) return relayLabel(agent.relay);
  return ACTIVITY_LABELS[activity] ?? "Idle";
}

/** Provider badge text; never relies on colour alone. */
export function providerLabel(agent) {
  if (agent?.provider && PROVIDER_LABELS[agent.provider])
    return PROVIDER_LABELS[agent.provider];
  if (agent?.runMode === "simulated") return "Demo";
  // A team member waiting on its relay step: the step's assistant, if one
  // was chosen, or "Demo" for the demo's own relay.
  if (agent?.relay?.provider && PROVIDER_LABELS[agent.relay.provider])
    return PROVIDER_LABELS[agent.relay.provider];
  if (agent?.relay?.simulated) return "Demo";
  return "Manual";
}

export const PROVIDER_GLYPHS = Object.freeze({
  "claude-code": "bars",
  codex: "ring",
  copilot: "cube",
  cursor: "pointer",
  gemini: "diamond",
});

/** Provider → a small, shape-based avatar insignia. */
export function providerGlyph(agent) {
  const provider = typeof agent === "string" ? agent : agent?.provider;
  return PROVIDER_GLYPHS[provider] ?? null;
}

/** Non-colour status class used by the label dot (matches existing .dot classes). */
export function statusTone(agent) {
  const a = activityOf(agent);
  if (a === "ERROR") return "red";
  if (a === "BLOCKED" || a === "WAITING_APPROVAL") return "amber";
  if (a === "IDLE" || a === "STALE") return "gray";
  return "green";
}

/** Basename of a path (both separators, tolerant of null). */
export function basename(file) {
  if (!file) return "";
  const parts = String(file).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

const ABSOLUTE_PATH =
  /(?:[A-Za-z]:\\|\\\\|\/(?:home|Users|users|var|opt|mnt)\/)[^\s"'`,;)]*/g;

/**
 * Replaces absolute paths with their basename so presentation mode never shows
 * a private location. Text that carries no path is returned unchanged.
 */
export function maskPrivate(text) {
  if (!text) return "";
  return String(text).replace(ABSOLUTE_PATH, (match) => {
    const name = basename(match);
    return name ? `…${name.length > 28 ? name.slice(0, 28) : name}` : "…";
  });
}

const CONTROL_CHARS = new RegExp("[\u0000-\u001f\u007f]+", "g");

/** Trims a single display line and strips control characters. */
export function clean(text, max = 42) {
  if (text == null) return "";
  const flat = String(text)
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(1, max - 1))}…`;
}

const finite = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;

/**
 * Content for the QA station screen. Counts are only ever the ones reported by
 * a run's test output; with nothing recorded the screen says so instead of
 * inventing numbers.
 *
 * @param {{ testers?: {id,name,runId}[], testResults?: object,
 *   qaLabel?: string, mask?: boolean }} input
 * @returns {{ lines: string[], hasResults: boolean, tone: 'pass'|'fail'|'none', runId: string|null }}
 */
export function qaScreen({
  testers = [],
  testResults = null,
  qaLabel = "QA station",
  mask = false,
} = {}) {
  const results = [];
  for (const tester of testers) {
    const r = tester?.runId ? testResults?.[tester.runId] : null;
    if (!r) continue;
    if (!finite(r.passed) && !finite(r.failed) && !finite(r.total)) continue;
    results.push({ tester, result: r });
  }
  results.sort(
    (a, b) => (b.result.updatedAt ?? 0) - (a.result.updatedAt ?? 0) || 0,
  );
  const names = testers.map((t) => clean(t?.name, 22)).filter(Boolean);
  if (!results.length) {
    return {
      lines: names.length
        ? ["tests running", ...names.slice(0, 3), "no test output yet"]
        : [qaLabel, "no test output yet"],
      hasResults: false,
      tone: "none",
      runId: null,
    };
  }
  const { tester, result } = results[0];
  const passed = finite(result.passed) ? result.passed : null;
  const failed = finite(result.failed) ? result.failed : null;
  const total = finite(result.total) ? result.total : null;
  const unknown = finite(result.unknown) ? result.unknown : null;
  const counts = [];
  if (passed != null) counts.push(`${passed} passed`);
  if (failed != null) counts.push(`${failed} failed`);
  const who = clean(mask ? maskPrivate(tester?.name) : tester?.name, 22);
  // "pass" is a claim about evidence, not the absence of a failure. Green is
  // only shown when every recognised test command reported an exit code
  // (result.reported). Incomplete evidence — or nothing usable parsed at all —
  // is "none", the same neutral tone as no output.
  let tone = "none";
  if (failed) tone = "fail";
  else if (result.reported === true && failed === 0) tone = "pass";
  return {
    lines: [
      counts.length ? counts.join(" · ") : "test output recorded",
      total != null ? `${total} tests reported` : "total not reported",
      unknown ? `${unknown} reported no exit code` : null,
      who ? `from ${who}'s test output` : "from the run's test output",
    ].filter(Boolean),
    hasResults: true,
    tone,
    runId: tester?.runId ?? null,
  };
}

const BUILD_STATUS_ORDER = ["failed", "running", "queued", "passed"];

/**
 * The operations pipeline wall: the last few recorded build/deploy events with
 * their real statuses. Empty input produces one honest panel.
 */
export function pipelinePanels(buildEvents = [], count = 4, { mask } = {}) {
  const list = Array.isArray(buildEvents) ? buildEvents.filter(Boolean) : [];
  if (!list.length)
    return [
      {
        id: null,
        title: "Pipeline",
        status: "none",
        detail: "no build events recorded",
      },
    ];
  const sorted = [...list].sort(
    (a, b) => toTime(a.timestamp) - toTime(b.timestamp),
  );
  return sorted.slice(-count).map((event) => ({
    id: event.id ?? null,
    title: clean(
      mask
        ? maskPrivate(event.label ?? event.kind)
        : (event.label ?? event.kind),
      22,
    ),
    kind: event.kind ?? "build",
    status: clean(event.status ?? "unknown", 18),
    detail: `${clean(event.kind ?? "build", 10)} · ${clean(event.status ?? "unknown", 14)}`,
    timestamp: event.timestamp ?? null,
  }));
}

/** Worst status among the recorded build events, for the wall's tone. */
export function pipelineTone(buildEvents = []) {
  const statuses = (buildEvents ?? [])
    .map((e) => String(e?.status ?? "").toLowerCase())
    .filter(Boolean);
  if (!statuses.length) return "none";
  for (const level of BUILD_STATUS_ORDER)
    if (statuses.some((s) => s.includes(level))) return level;
  return "unknown";
}

function toTime(value) {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
}

const ACTIVE_RUN_STATUSES = new Set([
  "running",
  "queued",
  "waiting_approval",
  "blocked",
]);

/**
 * Service map for the operations theme: providers and execution hosts are
 * nodes, active runs are edges. Nothing is invented: an agent with no provider
 * contributes no provider node.
 */
export function serviceMap(agents = []) {
  const nodes = new Map();
  const edges = new Map();
  for (const agent of agents ?? []) {
    if (!agent) continue;
    const providerId = agent.provider ? `provider:${agent.provider}` : null;
    if (providerId && !nodes.has(providerId))
      nodes.set(providerId, {
        id: providerId,
        kind: "provider",
        label: providerLabel(agent),
      });
    const host = clean(agent.host || "local", 18);
    const runnerId = `runner:${host.toLowerCase()}`;
    if (!nodes.has(runnerId))
      nodes.set(runnerId, { id: runnerId, kind: "runner", label: host });
    if (!providerId) continue;
    if (!ACTIVE_RUN_STATUSES.has(String(agent.runStatus ?? ""))) continue;
    const key = `${providerId}->${runnerId}`;
    const edge = edges.get(key) ?? {
      id: key,
      from: providerId,
      to: runnerId,
      runs: 0,
    };
    edge.runs += 1;
    edges.set(key, edge);
  }
  const nodeList = [...nodes.values()];
  return {
    nodes: nodeList,
    edges: [...edges.values()],
    empty: nodeList.length === 0,
  };
}

/** Up to `limit` artifact chips for an agent. */
export function artifactChips(
  artifactsByAgent,
  agentId,
  limit = 3,
  { mask = false } = {},
) {
  const list = artifactsByAgent?.[agentId];
  if (!Array.isArray(list)) return [];
  return list
    .filter((a) => a && a.id != null)
    .slice(0, limit)
    .map((a) => {
      const title = a.title ?? a.kind ?? "artifact";
      return {
        id: a.id,
        // An artifact title is usually a path, so presentation mode has to
        // mask it here too: these chips are rendered as visible text AND as a
        // DOM title, both outside the 3D scene's own masking.
        title: clean(mask ? maskPrivate(title) : title, 26),
        kind: clean(a.kind ?? "artifact", 14),
        agentId,
      };
    });
}

/** Artifact chips for whoever is at the review table (max `limit` in total). */
export function reviewChips(
  reviewers = [],
  artifactsByAgent = null,
  limit = 3,
  { mask = false } = {},
) {
  const chips = [];
  for (const agent of reviewers) {
    for (const chip of artifactChips(artifactsByAgent, agent?.id, limit, {
      mask,
    })) {
      if (chips.length >= limit) return chips;
      chips.push({
        ...chip,
        agentName: clean(mask ? maskPrivate(agent?.name) : agent?.name, 20),
      });
    }
  }
  return chips;
}

/** The most recent handoff that involves `agentId`, or null. */
export function handoffFor(handoffs, agentId) {
  if (!Array.isArray(handoffs) || agentId == null) return null;
  let best = null;
  for (const h of handoffs) {
    if (!h) continue;
    if (h.fromAgentId !== agentId && h.toAgentId !== agentId) continue;
    if (!best || toTime(h.timestamp) >= toTime(best.timestamp)) best = h;
  }
  if (!best) return null;
  return {
    ...best,
    role: best.fromAgentId === agentId ? "from" : "to",
    otherId: best.fromAgentId === agentId ? best.toAgentId : best.fromAgentId,
    taskTitle: clean(best.taskTitle, 40),
  };
}

/** A handoff older than this is history (the Timeline has it), not news. */
export const HANDOFF_WINDOW_MS = 30 * 60 * 1000;

/** "just now", "4m ago", "2h ago" for a recorded time; null when unknown. */
export const ageLabel = timeAgo;

/**
 * Card text for the meeting area, or null when nothing was recorded in the
 * last HANDOFF_WINDOW_MS. It says how long ago the handoff was, so an old one
 * never reads as happening now. A handoff without a time is not shown: its
 * age cannot be stated.
 */
export function handoffCard(
  handoffs,
  agents = [],
  { mask, now = Date.now(), windowMs = HANDOFF_WINDOW_MS } = {},
) {
  if (!Array.isArray(handoffs) || !handoffs.length) return null;
  const nameOf = (id) => agents.find((a) => a?.id === id)?.name ?? null;
  const latest = [...handoffs]
    .filter((h) => h && toTime(h.timestamp) > 0)
    .filter((h) => now - toTime(h.timestamp) <= windowMs)
    .sort((a, b) => toTime(a.timestamp) - toTime(b.timestamp))
    .pop();
  if (!latest) return null;
  const from = clean(nameOf(latest.fromAgentId) ?? "unknown agent", 20);
  const to = clean(
    nameOf(latest.toAgentId) ?? latest.toLabel ?? "unknown agent",
    20,
  );
  const title = clean(
    mask ? maskPrivate(latest.taskTitle) : latest.taskTitle,
    34,
  );
  const age = ageLabel(latest.timestamp, now);
  return {
    id: latest.id ?? null,
    lines: [
      `Handoff · ${age}`,
      `${from} → ${to}`,
      title || "task title not recorded",
    ],
    from,
    to,
    title,
    age,
    at: toTime(latest.timestamp),
    timestamp: latest.timestamp ?? null,
  };
}

/**
 * The attributable message summary for an agent. Text is never invented: when
 * nothing was recorded the caller shows no bubble at all.
 */
export function messageFor(messages, agentId, { mask } = {}) {
  const entry = messages?.[agentId];
  if (!entry || !entry.summary) return null;
  const summary = clean(mask ? maskPrivate(entry.summary) : entry.summary, 90);
  if (!summary) return null;
  return {
    summary,
    attribution: clean(entry.attribution ?? "recorded message", 40),
    timestamp: entry.timestamp ?? null,
  };
}

/** Location chip shown only when the run is not on this machine. */
export function hostChip(agent) {
  const host = agent?.host;
  if (!host) return null;
  const text = String(host).trim();
  if (
    !text ||
    text.toLowerCase() === "local" ||
    text.toLowerCase() === "localhost"
  )
    return null;
  return clean(text, 20);
}

const ACCESSORY_BY_ROLE = [
  [/(devops|sre|infra|platform|ops|release|deploy)/, "hardhat"],
  [/(qa|test|quality)/, "glasses"],
  [/(research|analy|intel|scout)/, "headset"],
];

/** Role → geometry-only accessory. `avatarStyles` always wins. */
export function roleAccessory(agent, style) {
  if (style?.accessory) return String(style.accessory);
  const role = String(agent?.role ?? agent?.specialty ?? "").toLowerCase();
  if (!role) return null;
  for (const [pattern, accessory] of ACCESSORY_BY_ROLE)
    if (pattern.test(role)) return accessory;
  return null;
}

/** Pronoun chip for the scene label, or null. */
export function pronouns(style) {
  const value = style?.pronouns;
  return value ? clean(value, 14) : null;
}

/** Whether a label is drawn for this agent under the current density. */
export function showLabel(agent, density = "all", selectedId = null) {
  if (density === "none") return agent?.id != null && agent.id === selectedId;
  if (density === "active")
    return agent?.id === selectedId || activityOf(agent) !== "IDLE";
  return true;
}

/**
 * Groups agents by team so team members take adjacent desks. Agents without a
 * team keep their original relative order and come last.
 */
export function orderByTeam(agents = [], teams = null) {
  if (!teams) return agents.slice();
  const named = [];
  const rest = [];
  for (const agent of agents) {
    const team = agent ? teams[agent.id] : null;
    if (team) named.push({ agent, team: String(team) });
    else rest.push(agent);
  }
  named.sort((a, b) => (a.team < b.team ? -1 : a.team > b.team ? 1 : 0));
  return [...named.map((n) => n.agent), ...rest];
}

/** Team → the agent ids in it, in the given order. */
export function teamGroups(agents = [], teams = null) {
  if (!teams) return [];
  const map = new Map();
  for (const agent of agents) {
    const team = agent ? teams[agent.id] : null;
    if (!team) continue;
    const key = String(team);
    if (!map.has(key)) map.set(key, { team: key, agentIds: [] });
    map.get(key).agentIds.push(agent.id);
  }
  // A team of one is not a grouping: labelling it would stack a second caption
  // on top of that agent's own label and tell the reader nothing new.
  return [...map.values()].filter((group) => group.agentIds.length > 1);
}

/**
 * Steers a destination away from slots that are already taken. Deterministic:
 * the same inputs always produce the same nudge, so two frames never disagree.
 */
export function avoidCollisions(target, occupied = [], minDist = 0.72) {
  const min2 = minDist * minDist;
  const clash = (x, z) =>
    occupied.some((o) => o && (o.x - x) ** 2 + (o.z - z) ** 2 < min2);
  if (!clash(target.x, target.z)) return { ...target, steered: false };
  for (let ring = 1; ring <= 3; ring++) {
    for (let i = 0; i < 8; i++) {
      const angle = (Math.PI / 4) * i + ring * 0.31;
      const x = target.x + Math.cos(angle) * minDist * ring;
      const z = target.z + Math.sin(angle) * minDist * ring;
      if (!clash(x, z)) return { ...target, x, z, steered: true };
    }
  }
  return { ...target, steered: false };
}

/** Cross-fade duration between pose targets, in milliseconds. */
export const BLEND_MS = 250;

/** Blend factor for a frame of `dtMs`; 1 means "snap" (reduced motion). */
export function blendFactor(dtMs, ms = BLEND_MS) {
  if (!(dtMs > 0)) return 0;
  if (!(ms > 0)) return 1;
  return Math.min(1, dtMs / ms);
}

/** Lerps every numeric key of `target` into `current` (mutates `current`). */
export function blendInto(current, target, k) {
  for (const key of Object.keys(target)) {
    const to = target[key];
    if (typeof to !== "number") continue;
    const from = typeof current[key] === "number" ? current[key] : to;
    current[key] = from + (to - from) * k;
  }
  return current;
}

export const IDLE_VARIATIONS = ["none", "stretch", "sip", "look"];

function hash32(n) {
  let x = Math.floor(n) | 0;
  x = x ^ 61 ^ (x >>> 16);
  x = (x + (x << 3)) | 0;
  x = x ^ (x >>> 4);
  x = Math.imul(x, 0x27d4eb2d);
  x = x ^ (x >>> 15);
  return Math.abs(x);
}

/**
 * Seeded idle schedule: every `cycleMs` an agent performs one short variation
 * (stretch, sip, look around) chosen deterministically from its seed.
 */
export function idleVariation(seed, timeMs, cycleMs = 7000) {
  if (!(cycleMs > 0)) return { kind: "none", phase: 0 };
  const slot = Math.floor(timeMs / cycleMs);
  const kind = IDLE_VARIATIONS[hash32(slot * 31 + Math.floor(seed * 100)) % 4];
  const phase = (timeMs % cycleMs) / cycleMs;
  const window = 0.4;
  if (kind === "none" || phase > window) return { kind: "none", phase: 0 };
  return { kind, phase: phase / window };
}

/**
 * Sanitized preview of a text or diff artifact for a monitor screen. Absolute
 * paths are masked when `mask` is set (presentation mode).
 */
export function previewLines(
  text,
  { lines = 3, mask = false, width = 34 } = {},
) {
  if (!text) return [];
  return String(text)
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(0, lines)
    .map((line) => clean(mask ? maskPrivate(line) : line, width));
}

/** Rounds a camera state so tiny drifts do not spam onCameraChange. */
export function roundCamera(state) {
  if (!state) return null;
  const round = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
  return {
    position: (state.position ?? []).map(round),
    target: (state.target ?? []).map(round),
    zoom: round(state.zoom ?? 1),
  };
}

/** True when two camera states are the same to three decimals. */
export function sameCamera(a, b) {
  const x = roundCamera(a);
  const y = roundCamera(b);
  if (!x || !y) return x === y;
  return JSON.stringify(x) === JSON.stringify(y);
}

const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vcross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const vnorm = (v) => {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
};

/**
 * The room as the camera sees it from `position` looking at `target`, in
 * world units on the view plane: half its width and height, and where its
 * centre sits relative to the target (the walls make it top-heavy). Counted:
 * the floor slab, the back and left walls (3.25 high) and the head height of
 * the front row (2.2), so labels on the nearest desks stay inside the frame.
 * `bounds` ({ minX, maxX, minZ, maxZ }), when given, is the whole scene: the
 * floor plus the conference wing beside it (office/conference.js).
 */
export function roomExtents(
  { width, depth, bounds = null },
  position = [16, 16, 21],
  target = [0, 0.3, 0],
) {
  const forward = vnorm([
    target[0] - position[0],
    target[1] - position[1],
    target[2] - position[2],
  ]);
  const right = vnorm(vcross(forward, [0, 1, 0]));
  const up = vcross(right, forward);
  const b = bounds ?? {
    minX: -width / 2,
    maxX: width / 2,
    minZ: -depth / 2,
    maxZ: depth / 2,
  };
  const xs = [b.minX - 0.3, b.maxX + 0.3];
  const zs = [b.minZ - 0.3, b.maxZ + 0.3];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const x of xs)
    for (const z of zs) {
      const walled = x < 0 || z < 0;
      for (const y of walled ? [-0.3, 3.25] : [-0.3, 2.2]) {
        const p = [x - target[0], y - target[1], z - target[2]];
        const px = vdot(p, right);
        const py = vdot(p, up);
        minX = Math.min(minX, px);
        maxX = Math.max(maxX, px);
        minY = Math.min(minY, py);
        maxY = Math.max(maxY, py);
      }
    }
  return {
    halfWidth: (maxX - minX) / 2,
    halfHeight: (maxY - minY) / 2,
    centerX: (maxX + minX) / 2,
    centerY: (maxY + minY) / 2,
  };
}

/**
 * Pixels the overlays take from the canvas, top and bottom. On a narrow
 * canvas the room label row and the camera bar span its width, so the room is
 * fitted between them; on a wide one they sit in corners the room leaves empty.
 * Matches .office-meta and .office-bottom in styles.css (≤680px block).
 */
export function overlayInsets(canvasWidth) {
  return canvasWidth > 0 && canvasWidth < 560
    ? { top: 36, bottom: 60 }
    : { top: 0, bottom: 0 };
}

/**
 * The orthographic frustum for a canvas: { top, bottom, left, right } in
 * world units that show the whole room with a small margin inside the part of
 * the canvas the overlays leave free. On a portrait phone the width decides,
 * on a wide screen the height does. The old rule sized by room depth only, so
 * a large team's room sat in a third of the canvas. Null without a room.
 */
export function roomFrustum(extents, width, height, margin = 0.07) {
  if (!extents || !(width > 0) || !(height > 0)) return null;
  const inset = overlayInsets(width);
  const usable = Math.max(height * 0.6, height - inset.top - inset.bottom);
  const grow = 1 + margin;
  const fit = Math.max(
    extents.halfHeight * grow,
    (extents.halfWidth * grow * usable) / width,
  );
  const half = (fit * height) / usable;
  const perPixel = (2 * half) / height;
  // Centre the room in the free band, which sits (bottom - top) / 2 pixels
  // above the canvas middle.
  const offsetY = extents.centerY - ((inset.bottom - inset.top) / 2) * perPixel;
  const halfX = (half * width) / height;
  return {
    top: half + offsetY,
    bottom: -half + offsetY,
    left: -halfX + extents.centerX,
    right: halfX + extents.centerX,
  };
}

/** Validates a restored camera state before it is applied. */
export function validCamera(state) {
  if (!state || typeof state !== "object") return false;
  const ok = (arr) =>
    Array.isArray(arr) &&
    arr.length === 3 &&
    arr.every((n) => Number.isFinite(n));
  return ok(state.position) && ok(state.target) && Number.isFinite(state.zoom);
}

/**
 * The stop of a presentation camera path for `step`. A path is a list of
 * `{ x, z, zoom?, label? }`; steps wrap around.
 */
export function presentationStop(path, step = 0) {
  if (!Array.isArray(path) || !path.length) return null;
  const index = ((Math.floor(step) % path.length) + path.length) % path.length;
  const stop = path[index] ?? null;
  if (!stop) return null;
  return {
    index,
    x: Number(stop.x) || 0,
    z: Number(stop.z) || 0,
    zoom: Number.isFinite(stop.zoom) ? stop.zoom : null,
    label: clean(stop.label ?? `Stop ${index + 1}`, 30),
  };
}

/** A default path across the rooms when the caller supplies none. */
export function defaultCameraPath(layout) {
  const zones = layout?.zones ?? {};
  const stops = [{ x: 0, z: 0, label: "Room" }];
  for (const [id, zone] of Object.entries(zones))
    if (zone) stops.push({ x: zone.x, z: zone.z, label: id });
  return stops;
}

/** Hover preview card content. Every field comes from the snapshot. */
export function hoverPreview(agent, { mask = false, elapsedMs = null } = {}) {
  if (!agent) return null;
  const file = agent.currentFile
    ? clean(mask ? maskPrivate(agent.currentFile) : agent.currentFile, 44)
    : null;
  return {
    name: clean(agent.name, 28),
    task: agent.taskTitle
      ? clean(mask ? maskPrivate(agent.taskTitle) : agent.taskTitle, 52)
      : null,
    activity: activityLabel(agent),
    inferred: agent.activityProvenance === "inferred",
    manual: activityOf(agent) === MANUAL_ACTIVITY,
    file,
    provider: providerLabel(agent),
    host: hostChip(agent),
    elapsed: formatElapsed(elapsedMs ?? agent.elapsedMs),
  };
}

/** "1m 05s" style elapsed text; null when nothing was measured. */
export function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** Lighting preset → multipliers applied to the theme's light rig. */
export const LIGHTING_PRESETS = {
  day: { hemi: 1, sun: 1, sunColor: null, sky: null },
  evening: { hemi: 0.62, sun: 0.72, sunColor: "#ffd9a8", sky: "#f3d9c0" },
  focus: { hemi: 0.5, sun: 1.18, sunColor: "#ffffff", sky: "#dfe9f5" },
};

export function lightingFor(theme, preset = "day") {
  const p = LIGHTING_PRESETS[preset] ?? LIGHTING_PRESETS.day;
  const light = theme?.light ?? {};
  return {
    sky: p.sky ?? light.sky,
    ground: light.ground,
    hemi: (light.hemi ?? 1) * p.hemi,
    sunColor: p.sunColor ?? light.sunColor,
    sun: (light.sun ?? 1) * p.sun,
  };
}

/** Avatar detail presets: how much geometry a figure is worth. */
export const AVATAR_DETAIL = {
  low: { accessories: false, hair: false, legs: false, segments: 8 },
  medium: { accessories: true, hair: true, legs: true, segments: 12 },
  high: { accessories: true, hair: true, legs: true, segments: 16 },
};

export function avatarDetailPreset(name) {
  return AVATAR_DETAIL[name] ?? AVATAR_DETAIL.medium;
}

/**
 * Pushes overlapping scene labels apart vertically so an isometric cluster of
 * agents stays readable. Deterministic: labels are resolved nearest-first
 * (smallest y, then smallest x) and each one only ever moves DOWN, so the same
 * frame always produces the same layout and a label never jumps above the
 * figure it belongs to.
 *
 * @param {{id:string,x:number,y:number,w:number,h:number}[]} items screen-space boxes (centre x, top y)
 * @param {{gap?:number, maxShift?:number}} options
 * @returns {Map<string, number>} id -> adjusted y
 */
export function spreadLabels(items, { gap = 5, maxShift = 132 } = {}) {
  const out = new Map();
  if (!Array.isArray(items) || !items.length) return out;
  const sorted = [...items]
    .filter((i) => i && Number.isFinite(i.x) && Number.isFinite(i.y))
    .sort(
      (a, b) =>
        a.y - b.y || a.x - b.x || String(a.id).localeCompare(String(b.id)),
    );
  const placed = [];
  for (const item of sorted) {
    const w = item.w || 120;
    const h = item.h || 22;
    let y = item.y;
    // Repeat until this box clears every box already placed: moving down to
    // clear one can push it into another.
    for (let guard = 0; guard < 40; guard++) {
      let moved = false;
      for (const p of placed) {
        const apart = Math.abs(p.x - item.x) >= (p.w + w) / 2;
        if (apart) continue;
        if (Math.abs(p.y - y) >= (p.h + h) / 2 + gap) continue;
        const next = p.y + (p.h + h) / 2 + gap;
        if (next - item.y > maxShift) continue;
        y = next;
        moved = true;
      }
      if (!moved) break;
    }
    placed.push({ x: item.x, y, w, h });
    out.set(item.id, y);
  }
  return out;
}
