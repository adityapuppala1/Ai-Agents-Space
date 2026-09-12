import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_OFFICE_LAYOUT,
  MAX_OFFICE_PROPS,
  OFFICE_PROP_KINDS,
  OFFICE_ZONE_IDS,
  isEmptyOfficeLayout,
  normalizeOfficeLayout,
  officeLayoutChanges,
} from "../packages/core/src/visual/OfficeLayout.js";

/**
 * The office a workspace arranges for itself: rooms moved and renamed,
 * furniture placed. Coordinates are fractions of the floor, so the layout
 * survives the floor growing with the team.
 */

test("an arranged office keeps only rooms, furniture and fractions", () => {
  const layout = normalizeOfficeLayout({
    zones: {
      qa: { x: 0.5004, z: -0.25, label: "  Test lab  " },
      meeting: { x: -1, z: 1 },
    },
    props: [
      { kind: "sofa", x: 0.2, z: 0.3, rotation: Math.PI * 2.5 },
      { kind: "plant", x: -0.4, z: 0.1 },
    ],
  });
  assert.deepEqual(layout.zones.qa, { x: 0.5, z: -0.25, label: "Test lab" });
  assert.deepEqual(layout.zones.meeting, { x: -1, z: 1 });
  assert.equal(layout.props.length, 2);
  // A turn and a half round is half a turn.
  assert.ok(Math.abs(layout.props[0].rotation - Math.PI * 0.5) < 0.002);
  assert.equal(layout.props[1].rotation, 0);
  // Nothing arranged is the theme's own layout.
  assert.deepEqual(normalizeOfficeLayout(null), { zones: {}, props: [] });
  assert.equal(isEmptyOfficeLayout(null), true);
  assert.equal(isEmptyOfficeLayout(EMPTY_OFFICE_LAYOUT), true);
  assert.equal(isEmptyOfficeLayout(layout), false);
});

test("an arranged office refuses anything that is not a room or a piece", () => {
  const bad = (input, message) =>
    assert.throws(() => normalizeOfficeLayout(input), message);
  bad({ zones: { kitchen: { x: 0, z: 0 } } }, /kitchen is not a room/);
  bad({ desks: [] }, /layout has unknown key desks/);
  bad({ zones: { qa: { x: 0, z: 0, rootPath: "C:\\x" } } }, /unknown key rootPath/);
  bad({ zones: { qa: { x: 1.5, z: 0 } } }, /between -1 and 1/);
  bad({ zones: { qa: { x: "left", z: 0 } } }, /must be a number/);
  bad({ props: [{ kind: "helipad", x: 0, z: 0 }] }, /is not furniture/);
  bad({ props: [{ kind: "plant", x: 0, z: 0, agentId: "a1" }] }, /unknown key agentId/);
  bad({ props: {} }, /must be a list/);
  bad(
    {
      props: Array.from({ length: MAX_OFFICE_PROPS + 1 }, () => ({
        kind: "plant",
        x: 0,
        z: 0,
      })),
    },
    new RegExp(`at most ${MAX_OFFICE_PROPS} pieces`),
  );
  bad({ zones: { qa: { x: 0, z: 0, label: "x".repeat(25) } } }, /under 24 characters/);
  // Every catalogue piece is placeable, and every room is movable.
  for (const kind of Object.keys(OFFICE_PROP_KINDS))
    assert.equal(
      normalizeOfficeLayout({ props: [{ kind, x: 0, z: 0 }] }).props[0].kind,
      kind,
    );
  for (const id of OFFICE_ZONE_IDS)
    assert.ok(normalizeOfficeLayout({ zones: { [id]: { x: 0, z: 0 } } }).zones[id]);
});

test("a layout change says how many rooms moved and how much furniture there is", () => {
  const current = {
    zones: { qa: { x: 0.2, z: 0 } },
    props: [{ kind: "plant", x: 0, z: 0 }],
  };
  assert.deepEqual(officeLayoutChanges(current, current), []);
  assert.deepEqual(
    officeLayoutChanges(current, {
      zones: { qa: { x: 0.2, z: 0 }, review: { x: -0.3, z: 0.1 } },
      props: [],
    }),
    [
      { key: "layout.rooms", from: "1 arranged", to: "2 arranged (review)" },
      { key: "layout.furniture", from: "1 pieces", to: "0 pieces" },
    ],
  );
  // A rename counts as a change to that room.
  assert.deepEqual(
    officeLayoutChanges(current, {
      zones: { qa: { x: 0.2, z: 0, label: "Test lab" } },
      props: current.props,
    }),
    [{ key: "layout.rooms", from: "1 arranged", to: "1 arranged (qa)" }],
  );
});

test("the browser's furniture catalogue matches the one the server enforces", async () => {
  const web = await import("../apps/web/src/office/propKinds.js");
  const { DRAWN_PROP_KINDS } = await import(
    "../apps/web/src/office/props.js"
  ).catch(() => ({ DRAWN_PROP_KINDS: null }));
  assert.deepEqual(
    Object.keys(web.OFFICE_PROP_KINDS),
    Object.keys(OFFICE_PROP_KINDS),
  );
  for (const [id, piece] of Object.entries(OFFICE_PROP_KINDS))
    assert.deepEqual(web.OFFICE_PROP_KINDS[id], piece, `${id} differs`);
  assert.equal(web.MAX_OFFICE_PROPS, MAX_OFFICE_PROPS);
  // Every kind the server accepts can actually be drawn.
  if (DRAWN_PROP_KINDS)
    assert.deepEqual([...DRAWN_PROP_KINDS].sort(), Object.keys(OFFICE_PROP_KINDS).sort());
});

test("work goes to the room serving it, or to the desk when no room does", async () => {
  const { computeLayout, zoneForActivity, roomNames } = await import(
    "../apps/web/src/office/zones.js"
  );
  const plain = computeLayout(6, "studio", null);
  assert.equal(zoneForActivity("TESTING", plain), "qa");
  assert.equal(zoneForActivity("MESSAGING", plain), "meeting");
  assert.equal(zoneForActivity("CODING", plain), "desk");

  // The two rooms trade functions: testing now happens in the meeting room.
  const swap = {
    zones: {
      qa: { x: 0, z: -0.7, does: "meeting" },
      meeting: { x: 0.4, z: -0.7, does: "qa" },
    },
  };
  const swapped = computeLayout(6, "studio", swap);
  assert.equal(zoneForActivity("TESTING", swapped), "meeting");
  assert.equal(zoneForActivity("MESSAGING", swapped), "qa");
  assert.equal(swapped.functionAt.qa, "meeting");
  assert.equal(swapped.arranged, true);

  // A room serving nothing sends that work back to the desks.
  const off = computeLayout(6, "studio", {
    zones: { qa: { x: 0, z: -0.7, does: "none" } },
  });
  assert.equal(zoneForActivity("TESTING", off), "desk");
  assert.equal(off.functionAt.qa, undefined);

  // A room is called after the function it serves, unless it was named.
  const theme = {
    rooms: { qa: "QA station", meeting: "Meeting area", review: "Review table" },
  };
  const names = roomNames(theme, swap);
  assert.equal(names.meeting, "QA station", "the meeting slot is the QA room");
  assert.equal(names.qa, "Meeting area");
  assert.equal(names.review, "Review table", "untouched rooms keep their name");
  assert.equal(
    roomNames(theme, { zones: { qa: { x: 0, z: 0, does: "none" } } }).qa,
    "Open space",
  );
  assert.equal(
    roomNames(theme, { zones: { qa: { x: 0, z: 0, does: "meeting", label: "War room" } } }).qa,
    "War room",
  );
});
