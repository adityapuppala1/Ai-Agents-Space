// Living office (roadmap §3 and §13): every rule the scene encodes lives in
// apps/web/src/office/data.js, which imports neither three nor the DOM.
import test from "node:test";
import assert from "node:assert/strict";
import {
  qaScreen,
  pipelinePanels,
  pipelineTone,
  serviceMap,
  artifactChips,
  reviewChips,
  handoffFor,
  handoffCard,
  messageFor,
  hostChip,
  roleAccessory,
  pronouns,
  showLabel,
  orderByTeam,
  teamGroups,
  avoidCollisions,
  blendFactor,
  blendInto,
  idleVariation,
  IDLE_VARIATIONS,
  previewLines,
  maskPrivate,
  clean,
  basename,
  roundCamera,
  sameCamera,
  validCamera,
  presentationStop,
  defaultCameraPath,
  hoverPreview,
  formatElapsed,
  lightingFor,
  avatarDetailPreset,
  activityOf,
  activityLabel,
  providerLabel,
  statusTone,
} from "../apps/web/src/office/data.js";

test("QA screen shows reported counts and never invents a number", () => {
  const empty = qaScreen({ qaLabel: "QA station" });
  assert.deepEqual(empty.lines, ["QA station", "no test output yet"]);
  assert.equal(empty.hasResults, false);

  const running = qaScreen({
    testers: [{ id: "a", name: "Nova", runId: "run-1" }],
    testResults: {},
  });
  assert.equal(running.hasResults, false);
  assert.ok(running.lines.includes("no test output yet"));
  assert.ok(running.lines.includes("Nova"));

  const reported = qaScreen({
    testers: [
      { id: "a", name: "Nova", runId: "run-1" },
      { id: "b", name: "Sage", runId: "run-2" },
    ],
    testResults: {
      "run-1": { passed: 12, failed: 0, total: 12, updatedAt: 10 },
      "run-2": { passed: 3, failed: 2, total: 5, updatedAt: 99 },
    },
  });
  assert.equal(reported.hasResults, true);
  assert.equal(reported.runId, "run-2", "the newest result wins");
  assert.equal(reported.lines[0], "3 passed · 2 failed");
  assert.equal(reported.lines[1], "5 tests reported");
  assert.equal(reported.lines[2], "from Sage's test output");
  assert.equal(reported.tone, "fail");

  const partial = qaScreen({
    testers: [{ id: "a", name: "Nova", runId: "run-1" }],
    testResults: { "run-1": { passed: 4, updatedAt: 1 } },
  });
  assert.equal(partial.lines[0], "4 passed");
  assert.equal(partial.lines[1], "total not reported");
  assert.equal(partial.tone, "pass");
});

test("pipeline panels come from recorded build events, in order", () => {
  assert.deepEqual(pipelinePanels([]), [
    {
      id: null,
      title: "Pipeline",
      status: "none",
      detail: "no build events recorded",
    },
  ]);
  assert.equal(pipelineTone([]), "none");

  const events = [
    {
      id: "e1",
      kind: "build",
      status: "passed",
      label: "build #12",
      timestamp: 1,
    },
    {
      id: "e2",
      kind: "check",
      status: "running",
      label: "tests",
      timestamp: 5,
    },
    {
      id: "e3",
      kind: "deploy",
      status: "failed",
      label: "deploy prod",
      timestamp: 3,
    },
  ];
  const panels = pipelinePanels(events, 2);
  assert.deepEqual(
    panels.map((p) => p.id),
    ["e3", "e2"],
    "sorted by timestamp, last two kept",
  );
  assert.equal(panels[0].status, "failed");
  assert.equal(panels[0].detail, "deploy · failed");
  assert.equal(pipelineTone(events), "failed");
});

test("service map: providers and hosts are nodes, active runs are edges", () => {
  const map = serviceMap([
    { id: "a", provider: "claude-code", runStatus: "running" },
    { id: "b", provider: "claude-code", runStatus: "running" },
    { id: "c", provider: "codex", runStatus: "completed" },
    { id: "d", runStatus: "running" },
  ]);
  assert.deepEqual(map.nodes.map((n) => n.id).sort(), [
    "provider:claude-code",
    "provider:codex",
    "runner:local",
  ]);
  assert.equal(map.edges.length, 1);
  assert.equal(map.edges[0].runs, 2, "two concurrent runs on one edge");
  assert.equal(serviceMap([]).empty, true);
});

test("review chips link at most three real artifacts", () => {
  const artifacts = {
    a: [
      { id: "x1", title: "diff", kind: "diff" },
      { id: "x2", title: "tests", kind: "test-output" },
    ],
    b: [{ id: "y1", title: "summary", kind: "message" }],
  };
  assert.deepEqual(
    artifactChips(artifacts, "a", 1).map((c) => c.id),
    ["x1"],
  );
  assert.deepEqual(artifactChips(artifacts, "missing"), []);
  const chips = reviewChips(
    [{ id: "a", name: "Nova" }, { id: "b" }],
    artifacts,
  );
  assert.deepEqual(
    chips.map((c) => c.id),
    ["x1", "x2", "y1"],
  );
  assert.equal(chips[0].agentName, "Nova");
  assert.equal(reviewChips([{ id: "a" }], null).length, 0);
});

test("handoffs and messages are only ever what was recorded", () => {
  const handoffs = [
    {
      id: "h1",
      fromAgentId: "a",
      toAgentId: "b",
      taskTitle: "Ship it",
      timestamp: 1,
    },
    {
      id: "h2",
      fromAgentId: "b",
      toAgentId: "c",
      taskTitle: "Review it",
      timestamp: 9,
    },
  ];
  assert.equal(handoffFor(handoffs, "a").role, "from");
  assert.equal(handoffFor(handoffs, "c").role, "to");
  assert.equal(handoffFor(handoffs, "zz"), null);
  const card = handoffCard(handoffs, [
    { id: "b", name: "Sage" },
    { id: "c", name: "Orbit" },
  ]);
  assert.deepEqual(card.lines, ["Handoff", "Sage → Orbit", "Review it"]);
  assert.equal(handoffCard([], []), null);

  assert.equal(messageFor(null, "a"), null);
  assert.equal(messageFor({ a: { summary: "" } }, "a"), null);
  const message = messageFor(
    { a: { summary: "asked for a review", attribution: "Claude Code" } },
    "a",
  );
  assert.equal(message.summary, "asked for a review");
  assert.equal(message.attribution, "Claude Code");
});

test("host chip appears only for non-local hosts", () => {
  assert.equal(hostChip({ host: "local" }), null);
  assert.equal(hostChip({}), null);
  assert.equal(hostChip({ host: "build-box-2" }), "build-box-2");
});

test("role accessories are geometry hints, overridable per avatar", () => {
  assert.equal(roleAccessory({ role: "DevOps engineer" }), "hardhat");
  assert.equal(roleAccessory({ role: "QA analyst" }), "glasses");
  assert.equal(roleAccessory({ role: "Research lead" }), "headset");
  assert.equal(roleAccessory({ role: "Coding assistant" }), null);
  assert.equal(
    roleAccessory({ role: "QA analyst" }, { accessory: "headset" }),
    "headset",
  );
  assert.equal(pronouns({ pronouns: "they/them" }), "they/them");
  assert.equal(pronouns(null), null);
});

test("label density hides only what it should", () => {
  const busy = { id: "a", activity: "CODING" };
  const idle = { id: "b", activity: "IDLE" };
  assert.equal(showLabel(idle, "all"), true);
  assert.equal(showLabel(idle, "active"), false);
  assert.equal(showLabel(busy, "active"), true);
  assert.equal(showLabel(idle, "active", "b"), true, "selection always shows");
  assert.equal(showLabel(busy, "none"), false);
  assert.equal(showLabel(busy, "none", "a"), true);
});

test("team grouping puts team mates on adjacent desks", () => {
  const agents = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const teams = { a: "Platform", c: "Platform", b: "Growth" };
  assert.deepEqual(
    orderByTeam(agents, teams).map((a) => a.id),
    ["b", "a", "c", "d"],
  );
  assert.deepEqual(
    orderByTeam(agents, null).map((a) => a.id),
    ["a", "b", "c", "d"],
  );
  const groups = teamGroups(orderByTeam(agents, teams), teams);
  // Only real groupings are labelled: "Growth" has a single member, so it is
  // dropped rather than stacking a redundant caption over that agent.
  assert.deepEqual(groups, [{ team: "Platform", agentIds: ["a", "c"] }]);
  assert.deepEqual(
    teamGroups(agents, { a: "Solo", b: "Alone" }),
    [],
    "every team of one means nothing to label",
  );
});

test("collision avoidance steers around taken slots, deterministically", () => {
  const free = avoidCollisions({ x: 2, z: 2, facing: 0 }, [{ x: 9, z: 9 }]);
  assert.equal(free.steered, false);
  assert.equal(free.x, 2);
  assert.equal(free.facing, 0, "facing is preserved");
  const taken = [{ x: 0, z: 0 }];
  const a = avoidCollisions({ x: 0, z: 0 }, taken);
  const b = avoidCollisions({ x: 0, z: 0 }, taken);
  assert.equal(a.steered, true);
  assert.deepEqual(a, b, "same input, same nudge");
  assert.ok(Math.hypot(a.x, a.z) >= 0.7);
});

test("pose blending cross-fades over about 250 ms", () => {
  assert.equal(blendFactor(250), 1);
  assert.equal(blendFactor(125), 0.5);
  assert.equal(blendFactor(0), 0);
  const pose = { armL: 0, armR: 0, label: "keep" };
  blendInto(pose, { armL: 1, armR: -1, label: "ignored" }, 0.5);
  assert.equal(pose.armL, 0.5);
  assert.equal(pose.armR, -0.5);
  assert.equal(pose.label, "keep", "non-numeric keys are left alone");
});

test("idle variations run on a seeded, repeatable schedule", () => {
  const first = idleVariation(1.37, 12_345);
  const again = idleVariation(1.37, 12_345);
  assert.deepEqual(first, again);
  assert.ok(IDLE_VARIATIONS.includes(first.kind));
  const kinds = new Set();
  for (let t = 0; t < 200_000; t += 1000)
    kinds.add(idleVariation(2.74, t).kind);
  assert.ok(kinds.size > 1, "the schedule varies over time");
  assert.equal(idleVariation(1, 1000, 0).kind, "none");
});

test("previews are sanitized and masked under presentation mode", () => {
  const diff = ["--- a/app.js", "", "+++ b/app.js", "@@ -1 +1 @@", "+ok"].join(
    "\n",
  );
  assert.deepEqual(previewLines(diff, { lines: 2 }), [
    "--- a/app.js",
    "+++ b/app.js",
  ]);
  assert.deepEqual(previewLines(null), []);
  const path = "C:\\Users\\dev\\secret\\app.js";
  assert.equal(maskPrivate(`edited ${path}`), "edited …app.js");
  assert.equal(maskPrivate("no path here"), "no path here");
  assert.equal(basename(path), "app.js");
  assert.equal(clean("  spaced   out  "), "spaced out");
  assert.equal(clean("x".repeat(60)).length, 42);
});

test("camera state round-trips, validates and compares", () => {
  const state = { position: [1.00049, 2, 3], target: [0, 0.3, 0], zoom: 1.25 };
  assert.equal(validCamera(state), true);
  assert.equal(validCamera({ position: [1, 2], target: [], zoom: 1 }), false);
  assert.equal(validCamera(null), false);
  assert.deepEqual(roundCamera(state).position, [1, 2, 3]);
  assert.equal(sameCamera(state, { ...state, zoom: 1.2501 }), true);
  assert.equal(sameCamera(state, { ...state, zoom: 1.4 }), false);
});

test("presentation path steps and wraps", () => {
  const path = [
    { x: 1, z: 2, label: "Desks" },
    { x: -3, z: 4, zoom: 1.4 },
  ];
  assert.equal(presentationStop(path, 0).label, "Desks");
  assert.equal(presentationStop(path, 1).zoom, 1.4);
  assert.equal(presentationStop(path, 2).index, 0, "wraps around");
  assert.equal(presentationStop(path, 3).index, 1);
  assert.equal(presentationStop([], 0), null);
  const fallback = defaultCameraPath({ zones: { qa: { x: 1, z: 2 } } });
  assert.equal(fallback.length, 2);
  assert.equal(fallback[1].label, "qa");
});

test("hover preview reports only recorded facts", () => {
  assert.equal(hoverPreview(null), null);
  const preview = hoverPreview(
    {
      name: "Nova",
      taskTitle: "Fix the parser",
      activity: "CODING",
      activityProvenance: "inferred",
      currentFile: "C:\\repo\\src\\parse.js",
      provider: "claude-code",
      host: "build-box",
      elapsedMs: 61_000,
    },
    { mask: true },
  );
  assert.equal(preview.provider, "Claude Code");
  assert.equal(preview.inferred, true);
  assert.equal(preview.file, "…parse.js", "masked under presentation mode");
  assert.equal(preview.host, "build-box");
  assert.equal(preview.elapsed, "1m 01s");
  const bare = hoverPreview({ name: "Sage" });
  assert.equal(bare.file, null);
  assert.equal(bare.elapsed, null);
  assert.equal(bare.provider, "Manual");
  assert.equal(formatElapsed(null), null);
});

test("lighting and avatar detail presets stay within the theme", () => {
  const theme = {
    light: { sky: "#fff", ground: "#999", hemi: 2, sunColor: "#ffe", sun: 3 },
  };
  assert.deepEqual(lightingFor(theme, "day"), {
    sky: "#fff",
    ground: "#999",
    hemi: 2,
    sunColor: "#ffe",
    sun: 3,
  });
  const evening = lightingFor(theme, "evening");
  assert.ok(evening.sun < 3 && evening.hemi < 2);
  assert.equal(lightingFor(theme, "nonsense").hemi, 2);
  assert.equal(avatarDetailPreset("low").accessories, false);
  assert.equal(avatarDetailPreset("high").accessories, true);
  assert.equal(avatarDetailPreset(undefined).segments, 12);
});

test("scene vocabulary matches the architecture brief", () => {
  assert.equal(activityOf({ state: "CODING" }), "CODING");
  assert.equal(activityOf({ activity: "NOT_A_THING" }), "IDLE");
  assert.equal(activityLabel({ activity: "COMMANDING" }), "Running command");
  assert.equal(providerLabel({ runMode: "simulated" }), "Demo");
  assert.equal(providerLabel({ provider: "codex" }), "Codex");
  assert.equal(statusTone({ activity: "WAITING_APPROVAL" }), "amber");
  assert.equal(statusTone({ activity: "ERROR" }), "red");
  assert.equal(statusTone({ activity: "TESTING" }), "green");
});
