import { isManualWork, MANUAL_ACTIVITY } from "../office/presence.js";

const THEME_COLORS = Object.freeze({
  studio: "#7fa5bd",
  operations: "#496d91",
  garden: "#6f9e7d",
  midnight: "#7565ad",
  sandstone: "#b78762",
  "data-lab": "#3d91a6",
  "research-library": "#8d6b45",
  "creative-studio": "#a44f77",
});

export function campusBuildings(workspaces = []) {
  return workspaces
    .filter((workspace) => !workspace.archivedAt)
    .map((workspace, index) => ({
      id: workspace.id,
      name: workspace.name || "Untitled workspace",
      theme: workspace.theme || "studio",
      color: THEME_COLORS[workspace.theme] ?? THEME_COLORS.studio,
      active: Math.max(0, Number(workspace.activeRuns) || 0),
      attention: Math.max(0, Number(workspace.attention) || 0),
      agents: Math.max(0, Number(workspace.agents) || 0),
      kind: workspace.kind === "demo" ? "demo" : "project",
      x: (index % 4) * 4.4 - 6.6,
      z: Math.floor(index / 4) * 4.6 - 2.3,
    }));
}

export function campusTotals(buildings = []) {
  return buildings.reduce(
    (totals, building) => ({
      workspaces: totals.workspaces + 1,
      active: totals.active + building.active,
      attention: totals.attention + building.attention,
      agents: totals.agents + building.agents,
    }),
    { workspaces: 0, active: 0, attention: 0, agents: 0 },
  );
}

/**
 * A room for every recorded activity (the `ACTIVITIES` list in
 * core/contracts.js), matching where the office floor puts that work. Only an
 * idle agent is "available"; a run whose activity was never reported says so
 * instead of being filed as free.
 */
const ROOM_FOR_ACTIVITY = Object.freeze({
  CODING: "Build studio",
  COMMANDING: "Build studio",
  DEBUGGING: "Build studio",
  TESTING: "Quality lab",
  RESEARCHING: "Research library",
  ANALYZING: "Research library",
  REVIEWING: "Review room",
  DELEGATING: "Meeting room",
  MESSAGING: "Meeting room",
  WAITING_APPROVAL: "Approval desk",
  BLOCKED: "Approval desk",
  ERROR: "Approval desk",
  STALE: "Quiet desks",
  IDLE: "Available desks",
});
const ATTENTION = new Set(["WAITING_APPROVAL", "BLOCKED", "ERROR", "STALE"]);

function roomFor(agent) {
  // A manual task reports no activity; its state is the profile's working
  // style, so it is not filed under the room that style would suggest.
  if (isManualWork(agent))
    return { activity: MANUAL_ACTIVITY, name: "Manual tasks" };
  const activity = agent.activity || agent.state || null;
  if (activity && ROOM_FOR_ACTIVITY[activity])
    return { activity, name: ROOM_FOR_ACTIVITY[activity] };
  // An agent with a run but no recognised activity is working on something
  // the provider did not describe; it is not free.
  if (agent.runId)
    return { activity: activity ?? "UNKNOWN", name: "Activity not reported" };
  return { activity: activity ?? "IDLE", name: "Available desks" };
}

export function campusRooms(snapshot = {}) {
  const rooms = new Map();
  for (const agent of snapshot.agents ?? []) {
    const { activity, name } = roomFor(agent);
    const room = rooms.get(name) ?? {
      name,
      agents: 0,
      active: 0,
      attention: 0,
      people: [],
    };
    room.agents += 1;
    if (agent.runId) room.active += 1;
    if (ATTENTION.has(activity)) room.attention += 1;
    room.people.push({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      activity,
      taskTitle: agent.taskTitle ?? null,
      provider: agent.runProvider ?? agent.provider ?? null,
    });
    rooms.set(name, room);
  }
  return [...rooms.values()].sort(
    (a, b) =>
      b.active - a.active ||
      b.attention - a.attention ||
      a.name.localeCompare(b.name),
  );
}

export function campusWorkspaceDetail(snapshot = {}) {
  const tasks = snapshot.tasks ?? [];
  const runs = snapshot.runs ?? [];
  return {
    rooms: campusRooms(snapshot),
    taskCounts: {
      queued: tasks.filter((task) => task.status === "QUEUE").length,
      working: tasks.filter((task) => task.status === "IN_PROGRESS").length,
      blocked: tasks.filter((task) => task.status === "BLOCKED").length,
      completed: tasks.filter((task) => task.status === "COMPLETED").length,
    },
    activeRuns: runs.filter((run) =>
      ["running", "waiting_approval", "queued", "cancelling"].includes(
        String(run.status).toLowerCase(),
      ),
    ).length,
  };
}
