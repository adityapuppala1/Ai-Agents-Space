// Office scale (roadmap §13): the rules that keep a large team readable and
// cheap to draw. scale.js imports neither three nor the DOM; instancing.js
// imports three only, so both are importable here without a JSX build.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  CLUSTER_THRESHOLD,
  CLUSTER_SLOTS,
  ROOM_MIN,
  MAX_ROOMS,
  isInactive,
  roomPlan,
  activitySummary,
  screenPlan,
  figureTier,
} from "../apps/web/src/office/scale.js";
import {
  INSTANCE_CHUNK,
  DESK_PART_COUNT,
  DESK_MESHES_PER_AGENT,
  createInstancedField,
  buildDeskField,
  buildCrowdField,
  agentAt,
} from "../apps/web/src/office/instancing.js";
import {
  Resources,
  adaptiveGraphics,
  resolveGraphics,
  lowerGraphics,
} from "../apps/web/src/office/scene.js";
import { computeLayout } from "../apps/web/src/office/zones.js";
import {
  createCrowdFigure,
  applyAgentState,
  animateFigure,
  walkDuration,
  WALK_MS,
} from "../apps/web/src/office/avatars.js";

const agent = (id, activity = "IDLE") => ({
  id,
  name: `Agent ${id}`,
  color: "#4a7dd0",
  activity,
});

test("adaptive graphics respects screen, capability, and manual choices", () => {
  assert.deepEqual(adaptiveGraphics({ width: 500 }), {
    preset: "low",
    reason: "compact viewport",
  });
  assert.equal(
    adaptiveGraphics({ width: 1440, hardwareConcurrency: 12, deviceMemory: 16 })
      .preset,
    "high",
  );
  assert.deepEqual(resolveGraphics("high", { width: 500 }), {
    preset: "high",
    reason: "manual",
  });
  assert.equal(
    resolveGraphics("auto", { width: 1440 }, "medium").preset,
    "medium",
  );
  assert.equal(lowerGraphics("high"), "medium");
  assert.equal(lowerGraphics("medium"), "low");
});
const idle = (count, prefix = "i") =>
  Array.from({ length: count }, (_, i) => agent(`${prefix}${i}`));

/** Materials the desk field expects from themeMaterials(). */
function deskMaterials(res) {
  return {
    base: res.material("#c9d2db"),
    wood: res.material("#c8a06a"),
    metal: res.material("#9aa4ae"),
    dark: res.material("#303f51"),
    mat: res.material("#dfe6ed"),
  };
}
const PALETTE = { accent: "#4a7dd0", screenBg: "#1d2733", screenFg: "#dbe7f2" };

// A working team: large teams on a crowded floor meet in a conference room.
const team = (count, name, activity = "CODING", prefix = name) =>
  Array.from({ length: count }, (_, i) => ({
    ...agent(`${prefix}${i}`, activity),
    team: name,
  }));

test("on a crowded floor each large team gets a conference room; nobody is hidden", () => {
  const agents = [
    ...team(12, "Backend"),
    ...team(3, "Design"),
    { ...agent("blocked", "BLOCKED"), team: "Backend" },
    { ...agent("approval", "WAITING_APPROVAL"), team: "Backend" },
  ];
  const plan = roomPlan(agents);
  assert.equal(plan.reason, "meeting");
  assert.equal(plan.rooms.length, 1, "Design (3) is below ROOM_MIN");
  const [room] = plan.rooms;
  assert.equal(room.key, "team:Backend");
  assert.equal(room.kind, "team");
  assert.equal(room.memberIds.length, 14, "attention states sit with the team");
  assert.deepEqual(room.activities, {
    CODING: 12,
    BLOCKED: 1,
    WAITING_APPROVAL: 1,
  });
  // Nobody is hidden: every agent stays drawn.
  assert.deepEqual(plan.clustered, []);
  assert.equal(plan.visible.length, agents.length);
  assert.equal(plan.roomOf.get("blocked"), "team:Backend");
  assert.equal(ROOM_MIN, 4);
});

test("a live team relay sits together in step order, before any role team", () => {
  const agents = [
    { ...agent("inv", "CODING"), team: "Investigator" },
    { ...agent("dev", "IDLE"), team: "Developer" },
    { ...agent("qa", "IDLE"), team: "QA" },
    ...team(20, "Backend"),
  ];
  const relays = [
    {
      workflowId: "wf1",
      templateId: "bug-clinic",
      steps: [
        { taskId: "1", agentId: "inv", state: "active" },
        { taskId: "2", agentId: "dev", state: "waiting" },
        { taskId: "3", agentId: "qa", state: "waiting" },
        { taskId: "4", agentId: "ghost", state: "waiting" },
      ],
    },
    {
      workflowId: "stalled",
      steps: [
        { taskId: "5", agentId: "Backend0", state: "ready" },
        { taskId: "6", agentId: "Backend1", state: "waiting" },
      ],
    },
  ];
  const plan = roomPlan(agents, { relays });
  assert.deepEqual(
    plan.rooms.map((room) => [room.key, room.title]),
    [
      ["workflow:wf1", "Bug clinic"],
      ["team:Backend", "Backend"],
    ],
  );
  assert.deepEqual(plan.rooms[0].memberIds, ["inv", "dev", "qa"]);
  // A relay nobody is working on is not a meeting.
  assert.ok(!plan.eligible.includes("workflow:stalled"));
});

test("rooms follow the user's choice: back to desks, or invited in", () => {
  const agents = [...team(10, "A"), ...team(10, "B"), ...team(3, "C")];
  const sent = roomPlan(agents, { atDesks: new Set(["team:A"]) });
  assert.deepEqual(
    sent.rooms.map((room) => room.key),
    ["team:B"],
  );
  assert.deepEqual(sent.eligible.sort(), ["team:A", "team:B"]);
  const none = roomPlan(agents, {
    atDesks: new Set(["team:A", "team:B"]),
  });
  assert.equal(none.reason, "at-desks");
  assert.equal(none.roomed, 0);
  // A quiet floor: no room unless a team is invited.
  const quiet = team(5, "Small");
  assert.equal(roomPlan(quiet).reason, "no-room");
  const invited = roomPlan(quiet, { invited: new Set(["team:Small"]) });
  assert.deepEqual(
    invited.rooms.map((room) => room.memberIds.length),
    [5],
  );
});

test("a room seats its capacity, at most three rooms open, and each agent sits in one", () => {
  const big = roomPlan(team(30, "Huge"));
  assert.equal(big.rooms[0].memberIds.length, 16);
  assert.equal(big.rooms[0].overflow, 14);
  const many = roomPlan([
    ...team(6, "A"),
    ...team(6, "B"),
    ...team(6, "C"),
    ...team(6, "D"),
  ]);
  assert.equal(many.rooms.length, MAX_ROOMS);
  const seated = many.rooms.flatMap((room) => room.memberIds);
  assert.equal(new Set(seated).size, seated.length);
});

test("a room says what its members are doing, most common first", () => {
  const room = {
    activities: { CODING: 9, TESTING: 2, REVIEWING: 1, DEBUGGING: 1 },
  };
  assert.equal(
    activitySummary(room, {
      CODING: "Coding",
      TESTING: "Testing",
      DEBUGGING: "Debugging",
      REVIEWING: "Reviewing",
    }),
    "9 Coding · 2 Testing · 1 Debugging · more",
  );
  assert.equal(activitySummary({ activities: { CODING: 3 } }), "3 CODING");
});

test("the room threshold stays above the demo workspace", () => {
  // The demo workspace has 6 default agents, 7 once office-controls.spec.js
  // adds "Vector": a threshold under 7 would move them all into a room.
  assert.ok(
    CLUSTER_THRESHOLD >= 7,
    `CLUSTER_THRESHOLD is ${CLUSTER_THRESHOLD}`,
  );
  assert.equal(CLUSTER_SLOTS, 8);
});

test("the screen budget keeps working agents live and caps the rest", () => {
  const agents = [
    ...idle(20, "a"),
    ...Array.from({ length: 10 }, (_, i) => agent(`w${i}`, "CODING")),
    ...idle(9, "b"),
    agent("chosen"),
  ];
  const plan = screenPlan(agents, { budget: 16, selectedId: "chosen" });
  assert.equal(plan.live.size, 16);
  assert.equal(plan.dim.length, agents.length - 16);
  assert.equal(plan.live.has("chosen"), true, "the selection keeps its screen");
  for (let i = 0; i < 10; i += 1)
    assert.equal(plan.live.has(`w${i}`), true, `w${i} is working`);
  assert.equal(plan.dim.includes("chosen"), false);

  const everyone = screenPlan(agents, { budget: 999 });
  assert.equal(everyone.live.size, agents.length);
  assert.deepEqual(everyone.dim, []);
});

test("the crowd tier only takes resting agents nobody is watching", () => {
  const resting = agent("rest");
  const busy = agent("busy", "TESTING");
  const opts = { visibleFigures: 40, crowd: 24 };
  assert.equal(figureTier(resting, opts), "crowd");
  assert.equal(figureTier(busy, opts), "full");
  assert.equal(figureTier(resting, { ...opts, selectedId: "rest" }), "full");
  assert.equal(figureTier(resting, { ...opts, followId: "rest" }), "full");
  assert.equal(figureTier(resting, { ...opts, hoveredId: "rest" }), "full");
  assert.equal(
    figureTier(resting, { visibleFigures: 24, crowd: 24 }),
    "full",
    "at the cap the figure keeps its limbs",
  );
});

test("100 desks are drawn as chunked instanced parts, not 1 700 meshes", () => {
  const res = new Resources();
  const group = new THREE.Group();
  const agents = idle(100);
  const layout = computeLayout(agents.length);
  const desks = buildDeskField(group, {
    layout,
    agents,
    res,
    mat: deskMaterials(res),
    palette: PALETTE,
    liveScreens: new Set(agents.map((a) => a.id)),
  });
  const meshes = desks.field.meshes();
  const chunks = Math.ceil(agents.length / INSTANCE_CHUNK);
  assert.equal(chunks, 5);
  assert.equal(DESK_PART_COUNT, 13);
  assert.equal(meshes.length, DESK_PART_COUNT * chunks);
  for (const mesh of meshes) {
    assert.equal(mesh.isInstancedMesh, true);
    assert.ok(mesh.count <= INSTANCE_CHUNK * 4, `count ${mesh.count}`);
    assert.ok(mesh.boundingSphere, "each chunk keeps its own bounding sphere");
  }
  // The per-agent loop this replaces built one mesh per shape per agent.
  assert.equal(DESK_MESHES_PER_AGENT, 16);
  assert.equal(DESK_MESHES_PER_AGENT * agents.length, 1600);
  assert.ok(meshes.length < DESK_MESHES_PER_AGENT * agents.length);
  desks.dispose();
  res.dispose();
});

test("a raycast hit on a batched desk still resolves to its agent", () => {
  const res = new Resources();
  const group = new THREE.Group();
  const agents = idle(100);
  const layout = computeLayout(agents.length);
  const desks = buildDeskField(group, {
    layout,
    agents,
    res,
    mat: deskMaterials(res),
    palette: PALETTE,
    liveScreens: new Set(),
  });
  const frames = desks.field
    .meshes()
    .filter((mesh) => Array.isArray(mesh.userData.instanceAgents));
  assert.equal(frames.length, 5);
  assert.equal(agentAt({ object: frames[0], instanceId: 3 }), agents[3].id);
  assert.equal(agentAt({ object: frames[1], instanceId: 0 }), agents[24].id);
  assert.equal(agentAt({ object: frames[4], instanceId: 3 }), agents[99].id);
  assert.equal(agentAt({ object: frames[0], instanceId: 99 }), null);
  assert.equal(agentAt({ object: new THREE.Group(), instanceId: 0 }), null);
  assert.equal(agentAt(null), null);
  desks.dispose();
  res.dispose();
});

test("only budgeted desks allocate a monitor texture", () => {
  const res = new Resources();
  const group = new THREE.Group();
  const agents = idle(100);
  const layout = computeLayout(agents.length);
  const live = new Set(agents.slice(0, 16).map((a) => a.id));
  let built = 0;
  const desks = buildDeskField(group, {
    layout,
    agents,
    res,
    mat: deskMaterials(res),
    palette: PALETTE,
    liveScreens: live,
    screenMaterial: () => {
      built += 1;
      return { material: new THREE.MeshBasicMaterial(), texture: null };
    },
  });
  assert.equal(built, 16);
  assert.equal(desks.monitors.size, 16);
  assert.equal(desks.monitors.has(agents[0].id), true);
  assert.equal(desks.monitors.has(agents[50].id), false);
  // The 84 dim desks share one instanced screen part, one mesh per chunk.
  assert.equal(desks.field.meshes().length, DESK_PART_COUNT * 5 + 5);
  desks.dispose();
  res.dispose();
});

test("disposing a field frees its instance buffers and nothing else", () => {
  const res = new Resources();
  const group = new THREE.Group();
  const geometry = res.box(1, 1, 1);
  const material = res.material("#ffffff");
  const field = createInstancedField(group, { chunk: 4, count: 10 });
  field.part("body", geometry, material, { colored: true });
  field.set("body", 0, { x: 1, y: 2, z: 3, color: "#ff0000" });
  field.commit();
  assert.equal(group.children.length, 3);
  field.dispose();
  assert.equal(group.children.length, 0);
  assert.deepEqual(field.meshes(), []);
  // Resources still owns these: a theme rebuild must not free them.
  assert.ok(geometry.attributes.position);
  assert.equal(material.color.getHexString(), "ffffff");
  res.dispose();
});

test("an unwritten instance is parked, never left at the room origin", () => {
  const group = new THREE.Group();
  const res = new Resources();
  const field = createInstancedField(group, { chunk: 4, count: 4 });
  const [mesh] = field.part("body", res.box(1, 1, 1), res.material("#ffffff"));
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(2, matrix);
  const scale = new THREE.Vector3().setFromMatrixScale(matrix);
  assert.equal(scale.lengthSq(), 0);
  field.dispose();
  res.dispose();
});

test("a crowd figure moves and promotes without a scene graph", () => {
  const fig = createCrowdFigure(agent("c1"), 2);
  assert.equal(fig.tier, "crowd");
  assert.equal(fig.group, null);
  assert.equal(fig.parts, null);
  const desk = { x: 1, z: 2, facing: 0.5, zone: "desk" };
  applyAgentState(fig, agent("c1"), desk, { now: 0, reducedMotion: false });
  assert.equal(fig.placed, true);
  assert.deepEqual(
    [fig.pos.x, fig.pos.y, fig.pos.z],
    [1, 0.08, 2],
    "placed at the desk it was given",
  );
  const away = { x: 5, z: 6, facing: 0, zone: "breakArea" };
  applyAgentState(fig, agent("c1"), away, { now: 100, reducedMotion: false });
  assert.equal(fig.walking, true);
  // A walk takes as long as the distance at walking pace.
  assert.equal(fig.walkMs, walkDuration(Math.hypot(4, 4)));
  animateFigure(fig, 500, { reducedMotion: false, running: true, dtMs: 16 });
  assert.ok(fig.pos.x > 1 && fig.pos.x < 5, "walked part of the way");
  animateFigure(fig, 100 + fig.walkMs + 1, {
    reducedMotion: false,
    running: true,
    dtMs: 16,
  });
  assert.equal(fig.walking, false);
  assert.equal(fig.pos.x, 5);
  assert.equal(fig.zone, "breakArea");
});

test("a walk's length sets its time, within a floor and a ceiling", () => {
  assert.equal(walkDuration(0), WALK_MS, "a step still takes a moment");
  assert.ok(walkDuration(6) > walkDuration(3), "further takes longer");
  assert.ok(walkDuration(500) <= 4500, "never a marathon");
  assert.equal(walkDuration(0, 250), 250);
});

test("the crowd field draws four instanced parts per resting figure", () => {
  const res = new Resources();
  const group = new THREE.Group();
  const crowd = buildCrowdField(group, res, { chunk: 8 });
  crowd.sync([]);
  assert.deepEqual(crowd.meshes(), [], "an empty crowd allocates nothing");
  const records = Array.from({ length: 10 }, (_, i) => ({
    pos: { x: i, y: 0.08, z: 0 },
    renderYaw: 0.2,
    color: "#4a7dd0",
  }));
  crowd.sync(records);
  const meshes = crowd.meshes();
  assert.equal(meshes.length, 4 * 2, "four parts over two chunks of eight");
  for (const mesh of meshes) assert.equal(mesh.isInstancedMesh, true);
  const torso = meshes[0];
  const matrix = new THREE.Matrix4();
  torso.getMatrixAt(0, matrix);
  const position = new THREE.Vector3().setFromMatrixPosition(matrix);
  assert.equal(position.x, 0);
  assert.ok(Math.abs(position.y - 1.1) < 1e-6, "torso sits on the figure");
  // Shrinking the crowd parks the leftover instances rather than drawing them.
  crowd.sync(records.slice(0, 3));
  torso.getMatrixAt(5, matrix);
  assert.equal(new THREE.Vector3().setFromMatrixScale(matrix).lengthSq(), 0);
  crowd.dispose();
  assert.deepEqual(crowd.meshes(), []);
  res.dispose();
});

test("a relay member whose handoff is playing keeps its chair until it ends", () => {
  const echo = { id: "echo", activity: "IDLE", role: "Developer" };
  const sage = { id: "sage", activity: "CODING", role: "Writer" };
  const relays = [
    {
      workflowId: "w1",
      templateId: "live-stream",
      steps: [
        { agentId: "echo", state: "done" },
        { agentId: "sage", state: "active" },
      ],
    },
  ];
  // Echo's step is done: without the moment, Sage alone has no room.
  assert.equal(roomPlan([echo, sage], { relays }).rooms.length, 0);
  // While the recorded handoff plays, both sit at the table.
  const during = roomPlan([echo, sage], {
    relays,
    holding: new Set(["echo"]),
  });
  assert.deepEqual(during.rooms[0]?.memberIds, ["echo", "sage"]);
});
