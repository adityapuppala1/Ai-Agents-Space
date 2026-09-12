import test from "node:test";
import assert from "node:assert/strict";
import {
  agentDirectory,
  agentSections,
  AGENT_SECTIONS,
} from "../apps/web/src/hooks/viewLogic.js";
import {
  portraitScene,
  portraitFps,
  SCREEN_TONES,
} from "../apps/web/src/office/portrait.js";

/**
 * The Agents page: sections of cards, each with the agent's office figure in
 * 3D. The figure's pose and props come from recorded state only.
 */

const agent = (id, extra = {}) => ({
  id,
  name: `Agent ${id}`,
  color: "#4a7dd0",
  ...extra,
});

test("the page groups the team: needs attention, working now, ready for work", () => {
  const agents = [
    agent("idle1", { state: "IDLE" }),
    agent("blocked", { state: "BLOCKED" }),
    agent("coder", { activity: "CODING", activeProviderRun: true }),
    agent("idle2", { state: "IDLE" }),
  ];
  const { rows } = agentDirectory(agents);
  const sections = agentSections(rows);
  assert.deepEqual(
    sections.map((section) => [section.id, section.rows.length]),
    [
      ["attention", 1],
      ["working", 1],
      ["idle", 2],
    ],
  );
  assert.equal(sections[0].title, "Needs attention");
  // Empty sections are left out.
  assert.deepEqual(
    agentSections(agentDirectory([agent("a", { state: "IDLE" })]).rows).map(
      (section) => section.id,
    ),
    ["idle"],
  );
  assert.deepEqual(agentSections([]), []);
  assert.deepEqual(
    AGENT_SECTIONS.map((section) => section.id),
    ["attention", "working", "idle"],
  );
});

test("a portrait sits at its laptop only while there is recorded work", () => {
  const coding = portraitScene(agent("c", { activity: "CODING" }), "working");
  assert.equal(coding.seated, true);
  assert.equal(coding.laptop, true);
  assert.equal(coding.typing, true);
  assert.equal(coding.tone, "typing");
  const idle = portraitScene(agent("i", { state: "IDLE" }), "idle");
  assert.equal(idle.seated, false, "no work: standing, no laptop out");
  assert.equal(idle.laptop, false);
  assert.equal(idle.typing, false);
  // Reading work sits without typing; attention states say so.
  const testing = portraitScene(agent("t", { activity: "TESTING" }), "working");
  assert.equal(testing.typing, false);
  assert.equal(testing.tone, "reading");
  const approval = portraitScene(
    agent("a", { activity: "WAITING_APPROVAL" }),
    "attention",
  );
  assert.equal(approval.attention, true);
  assert.equal(approval.tone, "approval");
  assert.ok(SCREEN_TONES[approval.tone]);
  // The key moves only when the drawing must change.
  assert.equal(
    portraitScene(agent("c", { activity: "CODING" }), "working").key,
    coding.key,
  );
  assert.notEqual(
    portraitScene(agent("c", { activity: "TESTING" }), "working").key,
    coding.key,
  );
});

test("working portraits redraw more often than idle ones, and never under reduced motion", () => {
  const working = portraitScene(agent("w", { activity: "CODING" }), "working");
  const idle = portraitScene(agent("i", { state: "IDLE" }), "idle");
  assert.ok(portraitFps(working) > portraitFps(idle));
  assert.ok(portraitFps(idle) > 0);
  assert.equal(portraitFps(working, { reducedMotion: true }), 0);
});
