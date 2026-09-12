import test from "node:test";
import assert from "node:assert/strict";
import {
  campusBuildings,
  campusRooms,
  campusTotals,
  campusWorkspaceDetail,
} from "../apps/web/src/views/campusData.js";

test("campus buildings contain only recorded workspace summaries", () => {
  const buildings = campusBuildings([
    {
      id: "a",
      name: "Alpha",
      theme: "data-lab",
      activeRuns: 2,
      attention: 1,
      agents: 4,
    },
    { id: "gone", name: "Archived", archivedAt: 1, activeRuns: 99 },
    { id: "b", name: "Beta", theme: "unknown", activeRuns: -2, agents: "3" },
  ]);
  assert.equal(buildings.length, 2);
  assert.deepEqual(
    buildings.map(({ id, active, attention, agents }) => ({
      id,
      active,
      attention,
      agents,
    })),
    [
      { id: "a", active: 2, attention: 1, agents: 4 },
      { id: "b", active: 0, attention: 0, agents: 3 },
    ],
  );
  assert.deepEqual(campusTotals(buildings), {
    workspaces: 2,
    active: 2,
    attention: 1,
    agents: 7,
  });
});

test("campus room drill-down groups only recorded agent activity", () => {
  const snapshot = {
    agents: [
      {
        id: "a",
        name: "Ada",
        role: "Engineer",
        activity: "CODING",
        runId: "r1",
        taskTitle: "Build API",
        runProvider: "codex",
      },
      {
        id: "b",
        name: "Ben",
        role: "QA",
        state: "TESTING",
        taskTitle: "Run tests",
      },
      {
        id: "c",
        name: "Cy",
        role: "Reviewer",
        activity: "WAITING_APPROVAL",
        runId: "r2",
      },
    ],
    tasks: [
      { status: "IN_PROGRESS" },
      { status: "BLOCKED" },
      { status: "COMPLETED" },
    ],
    runs: [{ status: "running" }, { status: "completed" }],
  };
  assert.deepEqual(
    campusRooms(snapshot).map(({ name, agents, active, attention }) => ({
      name,
      agents,
      active,
      attention,
    })),
    [
      { name: "Approval desk", agents: 1, active: 1, attention: 1 },
      { name: "Build studio", agents: 1, active: 1, attention: 0 },
      { name: "Quality lab", agents: 1, active: 0, attention: 0 },
    ],
  );
  assert.deepEqual(campusWorkspaceDetail(snapshot).taskCounts, {
    queued: 0,
    working: 1,
    blocked: 1,
    completed: 1,
  });
  assert.equal(campusWorkspaceDetail(snapshot).activeRuns, 1);
});

test("every recorded activity has a room, and only an idle agent is available", () => {
  // Observed: running a command, messaging and stale agents all landed in
  // "Available desks" because the room map missed those activities.
  const snapshot = {
    agents: [
      { id: "1", name: "Cmd", activity: "COMMANDING", runId: "r1" },
      { id: "2", name: "Msg", activity: "MESSAGING", runId: "r2" },
      { id: "3", name: "Quiet", activity: "STALE", runId: "r3" },
      { id: "4", name: "Free", activity: "IDLE" },
      { id: "5", name: "Unreported", activity: null, runId: "r5" },
      { id: "6", name: "Blocked", state: "BLOCKED" },
    ],
  };
  const byName = new Map(
    campusRooms(snapshot).map((room) => [
      room.name,
      room.people.map((person) => person.name),
    ]),
  );
  assert.deepEqual(byName.get("Build studio"), ["Cmd"]);
  assert.deepEqual(byName.get("Meeting room"), ["Msg"]);
  assert.deepEqual(byName.get("Quiet desks"), ["Quiet"]);
  assert.deepEqual(byName.get("Available desks"), ["Free"]);
  assert.deepEqual(byName.get("Activity not reported"), ["Unreported"]);
  assert.deepEqual(byName.get("Approval desk"), ["Blocked"]);
  const quiet = campusRooms(snapshot).find(
    (room) => room.name === "Quiet desks",
  );
  assert.equal(quiet.attention, 1);
});
