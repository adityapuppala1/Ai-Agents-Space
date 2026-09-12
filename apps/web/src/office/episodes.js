// Moments: the short scenes the office plays for recorded interactions between
// agents. A handoff sends the giver to the receiver's desk, they face each
// other, a document passes between them, and the giver goes back. A message
// is the same meeting without the document. A kickoff gathers a newly
// deployed team round the meeting table. (Subagent helpers are not moments:
// they stand beside their parent while the delegation is open; Office.jsx.)
//
// Every moment is started by a recorded event and plays once. Walking is a
// visual transition, never a claim that anything moved (roadmap §3). Events
// older than EPISODE_FRESH_MS when the office first sees them do not play: a
// handoff from an hour ago is history, and the Timeline has it. Pure module:
// no three, no DOM, so node:test covers it.

/** Only interactions this recent when first seen start a moment. */
export const EPISODE_FRESH_MS = 90_000;

/** How long each moment lasts, start to finish. */
export const EPISODE_MS = Object.freeze({
  handoff: 6500,
  message: 5000,
  kickoff: 6200,
});

/**
 * When the office first opens, only interactions this recent start a moment:
 * opening the page is not the moment a handoff from a minute ago happened.
 */
export const FIRST_LOOK_MS = 20_000;

/** At most this many members gather round the table for a kickoff. */
export const KICKOFF_MAX = 8;

/** Share of a moment spent walking there, exchanging, and walking back. */
const APPROACH = 0.24;
const EXCHANGE_END = 0.76;

/** Distance the giver stands from the receiver, in world units. */
const MEET_DISTANCE = 0.78;

function toMs(value) {
  if (typeof value === "number") return value;
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * New moments to start for `interactions` (choreography interactions:
 * { id, kind, fromAgentId, toAgentId, label, timestamp }). Each id plays once
 * (`played` remembers it); an agent already in a moment (`busy`) waits for
 * the next one rather than being pulled two ways. Interactions without a
 * time, or older than `fresh` when first seen, are marked played silently.
 */
export function planEpisodes({
  interactions = [],
  now = Date.now(),
  played = new Set(),
  busy = new Set(),
  fresh = EPISODE_FRESH_MS,
} = {}) {
  const started = [];
  const taken = new Set(busy);
  const ordered = [...(interactions ?? [])]
    .filter((item) => item?.id != null && !played.has(item.id))
    .sort((a, b) => (toMs(a.timestamp) ?? 0) - (toMs(b.timestamp) ?? 0));
  for (const item of ordered) {
    const at = toMs(item.timestamp);
    if (at === null || now - at > fresh) {
      played.add(item.id);
      continue;
    }
    if (!EPISODE_MS[item.kind] || item.kind === "kickoff") {
      played.add(item.id);
      continue;
    }
    if (
      !item.fromAgentId ||
      !item.toAgentId ||
      item.fromAgentId === item.toAgentId
    ) {
      played.add(item.id);
      continue;
    }
    if (taken.has(item.fromAgentId) || taken.has(item.toAgentId)) continue;
    taken.add(item.fromAgentId);
    taken.add(item.toAgentId);
    played.add(item.id);
    started.push({
      id: item.id,
      kind: item.kind,
      fromAgentId: item.fromAgentId,
      toAgentId: item.toAgentId,
      label: item.label ?? null,
      artifact: item.artifact ?? null,
      detail: item.detail ?? null,
      simulated: item.simulated === true,
      evidenceId: item.evidenceId ?? item.id,
      startAt: now,
      duration: EPISODE_MS[item.kind],
    });
  }
  return started;
}

/**
 * Kickoffs to start for recorded team events ({ id, members: [agentId],
 * label, timestamp, simulated }). The members the office knows gather round
 * the meeting table; a member already in another moment sits this one out.
 * A team with fewer than two members to gather has no kickoff. Same
 * freshness and play-once rules as planEpisodes.
 */
export function planKickoffs({
  teams = [],
  known = null,
  now = Date.now(),
  played = new Set(),
  busy = new Set(),
  fresh = EPISODE_FRESH_MS,
} = {}) {
  const started = [];
  const taken = new Set(busy);
  for (const team of teams ?? []) {
    if (team?.id == null || played.has(team.id)) continue;
    played.add(team.id);
    const at = toMs(team.timestamp);
    if (at === null || now - at > fresh) continue;
    const members = [...new Set(team.members ?? [])]
      .filter((id) => id && (!known || known.has(id)) && !taken.has(id))
      .slice(0, KICKOFF_MAX);
    if (members.length < 2) continue;
    for (const id of members) taken.add(id);
    started.push({
      id: team.id,
      kind: "kickoff",
      members,
      label: team.label ?? null,
      simulated: team.simulated === true,
      evidenceId: team.evidenceId ?? team.id,
      startAt: now,
      duration: EPISODE_MS.kickoff,
    });
  }
  return started;
}

/**
 * Where `count` members stand round a zone's table: spread over the zone's
 * slots (each already faces the table), never two on one slot.
 */
export function huddleSpots(zone, count) {
  const slots = zone?.slots ?? [];
  const n = Math.min(Math.max(0, count), slots.length);
  if (!n) return [];
  if (n === 1) return [slots[Math.floor(slots.length / 2)]];
  const out = [];
  for (let i = 0; i < n; i++)
    out.push(slots[Math.round((i * (slots.length - 1)) / (n - 1))]);
  return out;
}

/** Everyone a moment involves: both ends of a meeting, or a whole huddle. */
export function episodeAgents(episode) {
  if (!episode) return [];
  if (episode.kind === "kickoff") return episode.members ?? [];
  return [episode.fromAgentId, episode.toAgentId].filter(Boolean);
}

/**
 * Where a moment is at `now`: "approach" (the giver walks over), "exchange"
 * (facing each other; the document passes), "return" (the giver walks back)
 * or "done". `t` runs 0..1 within the phase.
 */
export function episodePhase(episode, now) {
  if (!episode) return { phase: "done", t: 1 };
  const elapsed = Math.max(0, now - episode.startAt);
  const share = elapsed / Math.max(1, episode.duration);
  if (share >= 1) return { phase: "done", t: 1 };
  if (share < APPROACH) return { phase: "approach", t: share / APPROACH };
  if (share < EXCHANGE_END)
    return {
      phase: "exchange",
      t: (share - APPROACH) / (EXCHANGE_END - APPROACH),
    };
  return { phase: "return", t: (share - EXCHANGE_END) / (1 - EXCHANGE_END) };
}

/** Yaw that turns a figure at (ax, az) to face (bx, bz); yaw 0 faces -z. */
export function facingToward(ax, az, bx, bz) {
  return Math.atan2(-(bx - ax), -(bz - az));
}

/**
 * The spot the giver walks to: beside the receiver, on the giver's side, so
 * they meet face to face without standing inside each other or the desk.
 */
export function meetingSpot(giver, receiver, distance = MEET_DISTANCE) {
  const dx = giver.x - receiver.x;
  const dz = giver.z - receiver.z;
  const length = Math.hypot(dx, dz);
  // Coming from straight behind the monitor, step round to the front.
  const ux = length > 0.001 ? dx / length : 0;
  const uz = length > 0.001 ? dz / length : 1;
  const x = receiver.x + ux * distance;
  const z = receiver.z + Math.max(uz, 0.35) * distance;
  return {
    x,
    z,
    facing: facingToward(x, z, receiver.x, receiver.z),
    receiverFacing: facingToward(receiver.x, receiver.z, x, z),
  };
}

/**
 * Where a helper stands beside its parent: the n-th helper of a parent gets
 * the n-th slot in a small arc behind the desk chair, so several subagents
 * never stack on one spot.
 */
export function helperSpot(parent, index = 0) {
  // Clear of the parent's chair (which shares its colour) and in front of
  // the desk, toward the viewer.
  const slots = [
    [-0.95, 0.95],
    [0.95, 0.95],
    [-1.2, 1.55],
    [1.2, 1.55],
    [0, 1.75],
  ];
  const [ox, oz] = slots[index % slots.length];
  // Behind the parent whichever way it faces: at a desk it faces the monitor
  // (yaw 0); at a conference table it faces the table.
  const yaw = Number.isFinite(parent.facing) ? parent.facing : 0;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const x = parent.x + ox * c + oz * s;
  const z = parent.z - ox * s + oz * c;
  return { x, z, facing: facingToward(x, z, parent.x, parent.z) };
}
