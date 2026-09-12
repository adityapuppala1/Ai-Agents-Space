// Scale rules for a large team: which teams meet in a conference room, which
// desks keep a live monitor texture, and which figures drop to the cheap
// crowd tier. Pure: imports neither three nor the DOM so `node --test` can
// import it directly, the same rule data.js follows.
import { activityOf } from "./data.js";
import { relayName } from "./relay.js";
import { ROOM_CAPACITY } from "./conference.js";

/**
 * A large team moves into a conference room only when more than this many
 * agents stand on the floor. It must stay above the size of the demo
 * workspace (6 default agents, 7 once office-controls.spec.js adds "Vector").
 */
export const CLUSTER_THRESHOLD = 16;

/** The smallest role team that gets a conference room on a crowded floor. */
export const ROOM_MIN = 4;

/** Rooms the wing holds at once. */
export const MAX_ROOMS = 3;

/** Standing slots in each zone (break area, meeting table, …). */
export const CLUSTER_SLOTS = 8;

/**
 * Only "Idle" is inactive. BLOCKED, ERROR, STALE and WAITING_APPROVAL are
 * attention states; an agent in one keeps its indicator wherever it sits.
 */
export const INACTIVE_ACTIVITIES = new Set(["IDLE"]);

export function isInactive(agent) {
  return INACTIVE_ACTIVITIES.has(activityOf(agent));
}

/**
 * Who meets in a conference room (office/conference.js builds the rooms).
 * Nobody is hidden or shrunk: a room is a place a team works together.
 *   1. A team relay someone is working on (office/relay.js): its members on
 *      the floor sit together, in step order, so the baton passes round the
 *      table.
 *   2. On a crowded floor (more than `threshold` agents), each role team of
 *      `minTeam` or more.
 *   3. A role team the user invited (`invited`, keys "team:<name>"), crowded
 *      or not, of two or more.
 * A room the user sent back to their desks (`atDesks`, by key) is skipped.
 * `holding` (agent ids a moment holds on the floor) keeps a relay member
 * whose step just finished at the table until its handoff has played.
 * Relay rooms come first, then the largest teams, up to `maxRooms`; a
 * room seats `capacity` and the rest keep their desks.
 *
 * → { rooms: [{ key, kind, title, memberIds, overflow, size, activities }],
 *     roomOf: Map agentId -> room key, eligible: [key], roomed, reason,
 *     clustered: [], clusteredSet, visible } (clustered stays empty: the
 *     scene hides no one).
 */
export function roomPlan(
  agents = [],
  {
    relays = [],
    teamOf = (agent) => agent?.team ?? agent?.role ?? null,
    threshold = CLUSTER_THRESHOLD,
    minTeam = ROOM_MIN,
    atDesks = new Set(),
    invited = new Set(),
    holding = new Set(),
    maxRooms = MAX_ROOMS,
    capacity = ROOM_CAPACITY,
  } = {},
) {
  const present = new Map(agents.map((agent) => [agent.id, agent]));
  const candidates = [];
  for (const relay of relays ?? []) {
    const live = relay.steps.some(
      (step) => step.state === "active" || step.state === "blocked",
    );
    if (!live) continue;
    const ids = [];
    // A member whose step is done keeps its chair while a moment holds it
    // (`holding`: the handoff it just recorded plays across the table);
    // then it leaves.
    for (const step of relay.steps)
      if (
        (step.state !== "done" || holding.has(step.agentId)) &&
        step.agentId &&
        present.has(step.agentId) &&
        !ids.includes(step.agentId)
      )
        ids.push(step.agentId);
    if (ids.length < 2) continue;
    candidates.push({
      key: `workflow:${relay.workflowId}`,
      kind: "workflow",
      title: relayName(relay),
      memberIds: ids,
    });
  }
  const crowded = agents.length > threshold;
  const teams = new Map();
  for (const agent of agents) {
    const team = teamOf(agent);
    if (!team) continue;
    const list = teams.get(team) ?? [];
    list.push(agent.id);
    teams.set(team, list);
  }
  const teamCandidates = [];
  for (const [team, ids] of teams) {
    const key = `team:${team}`;
    const big = crowded && ids.length >= minTeam;
    const asked = invited.has(key) && ids.length >= 2;
    if (big || asked)
      teamCandidates.push({ key, kind: "team", title: team, memberIds: ids });
  }
  teamCandidates.sort(
    (a, b) =>
      b.memberIds.length - a.memberIds.length || a.title.localeCompare(b.title),
  );
  candidates.push(...teamCandidates);
  const eligible = candidates.map((candidate) => candidate.key);
  const rooms = [];
  const roomOf = new Map();
  for (const candidate of candidates) {
    if (rooms.length >= maxRooms) break;
    if (atDesks.has(candidate.key)) continue;
    const free = candidate.memberIds.filter((id) => !roomOf.has(id));
    if (free.length < 2) continue;
    const seated = free.slice(0, capacity);
    const activities = {};
    for (const id of seated) {
      const activity = activityOf(present.get(id));
      activities[activity] = (activities[activity] ?? 0) + 1;
      roomOf.set(id, candidate.key);
    }
    rooms.push({
      key: candidate.key,
      kind: candidate.kind,
      title: candidate.title,
      memberIds: seated,
      overflow: free.length - seated.length,
      size: candidate.memberIds.length,
      activities,
    });
  }
  let reason = "no-room";
  if (rooms.length) reason = "meeting";
  else if (eligible.length) reason = "at-desks";
  return {
    rooms,
    roomOf,
    eligible,
    roomed: roomOf.size,
    reason,
    clustered: [],
    clusteredSet: new Set(),
    visible: agents.map((agent) => agent.id),
  };
}

/**
 * "9 Coding · 2 Testing · 1 Reviewing": what a room's members are doing,
 * most common first, at most three kinds. `labels` maps an activity to its
 * word.
 */
export function activitySummary(room, labels = {}) {
  const parts = Object.entries(room?.activities ?? {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([activity, count]) => `${count} ${labels[activity] ?? activity}`);
  if (parts.length <= 3) return parts.join(" · ");
  return `${parts.slice(0, 3).join(" · ")} · more`;
}

/**
 * Picks the desks that keep an individual monitor with its own canvas texture.
 * Every other desk shares one instanced dim screen, so a large team costs a
 * bounded number of textures instead of one per agent.
 */
export function screenPlan(agents = [], { budget, selectedId = null } = {}) {
  const cap = Number.isFinite(budget)
    ? Math.max(0, Math.floor(budget))
    : agents.length;
  const order = [];
  const seen = new Set();
  const push = (agent) => {
    if (!agent || seen.has(agent.id)) return;
    seen.add(agent.id);
    order.push(agent.id);
  };
  push(agents.find((a) => a.id === selectedId));
  // Working agents earn a live screen before resting ones: their monitor is
  // the only place the recorded file and action are shown.
  for (const agent of agents) if (!isInactive(agent)) push(agent);
  for (const agent of agents) push(agent);
  return { live: new Set(order.slice(0, cap)), dim: order.slice(cap) };
}

/**
 * "full" keeps the articulated figure; "crowd" draws a four-part instanced
 * stand-in. Anything the operator is watching, and anything that is not idle,
 * stays full whatever the crowd size.
 */
/**
 * Desk order for the agents on the floor, kept stable between snapshots: the
 * desk grid follows the array, so re-deriving it from the roster moved every
 * agent after an arrival or a departure to a new desk. Agents keep their
 * index; an arrival takes a new desk at the end; a departure's desk is taken
 * by the last agent in the list, so at most one figure walks.
 * `previous` and `present` are agent ids; `present` is in roster order.
 */
export function stableDeskOrder(previous = [], present = []) {
  const here = new Set(present);
  const order = [...previous];
  for (let i = order.length - 1; i >= 0; i--) {
    if (here.has(order[i])) continue;
    // Everything after i is still here, so the tail is someone present.
    const last = order.pop();
    if (i < order.length) order[i] = last;
  }
  const placed = new Set(order);
  for (const id of present) if (!placed.has(id)) order.push(id);
  return order;
}

export function figureTier(
  agent,
  {
    visibleFigures = 0,
    crowd = Infinity,
    selectedId = null,
    followId = null,
    hoveredId = null,
  } = {},
) {
  if (!agent) return "full";
  if (
    agent.id === selectedId ||
    agent.id === followId ||
    agent.id === hoveredId
  )
    return "full";
  if (!isInactive(agent)) return "full";
  return visibleFigures > crowd ? "crowd" : "full";
}
