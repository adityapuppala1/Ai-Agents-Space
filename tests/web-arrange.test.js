import test from "node:test";
import assert from "node:assert/strict";
import {
  ARRANGE_COARSE,
  setFunction,
  ARRANGE_STEP,
  ARRANGE_TURN,
  addProp,
  describeSelection,
  draftFromLayout,
  isDraftEmpty,
  layoutFromDraft,
  moveSelection,
  placeSelection,
  removeProp,
  renameSelection,
  resetDraft,
  selectionOf,
  turnSelection,
} from "../apps/web/src/hooks/arrangeLogic.js";
import { normalizeOfficeLayout } from "../packages/core/src/visual/OfficeLayout.js";

/**
 * Arranging the office: the plan view's arithmetic. What it produces has to
 * pass the server's own validation, which is the last assertion here.
 */

const defaults = {
  research: { x: -0.72, z: -0.7 },
  qa: { x: -0.36, z: -0.7 },
  review: { x: 0, z: -0.7 },
  meeting: { x: 0.36, z: -0.7 },
  breakArea: { x: 0.72, z: -0.7 },
};

test("a draft starts where the environment puts the rooms", () => {
  const draft = draftFromLayout(null, defaults);
  assert.deepEqual(Object.keys(draft.zones), Object.keys(defaults));
  assert.equal(draft.zones.qa.x, -0.36);
  assert.equal(draft.zones.qa.moved, false);
  assert.deepEqual(draft.props, []);
  // Nothing to save: the theme already says all of this.
  assert.equal(isDraftEmpty(draft, defaults), true);
  assert.deepEqual(layoutFromDraft(draft, defaults), { zones: {}, props: [] });
  // A saved layout wins over the theme, and carries its name.
  const arranged = draftFromLayout(
    { zones: { qa: { x: 0.4, z: 0.1, label: "Test lab" } }, props: [] },
    defaults,
  );
  assert.deepEqual(arranged.zones.qa, {
    x: 0.4,
    z: 0.1,
    label: "Test lab",
    does: "qa",
    moved: true,
  });
});

test("moving, turning and placing stay inside the floor", () => {
  let draft = draftFromLayout(null, defaults);
  const room = selectionOf("zone", "qa");
  draft = moveSelection(draft, room, ARRANGE_STEP, ARRANGE_COARSE);
  assert.equal(draft.zones.qa.x, -0.34);
  assert.equal(draft.zones.qa.z, -0.62);
  assert.equal(draft.zones.qa.moved, true);
  // The floor ends at 1: pushing past it stops there.
  for (let i = 0; i < 80; i += 1)
    draft = moveSelection(draft, room, ARRANGE_COARSE, ARRANGE_COARSE);
  assert.equal(draft.zones.qa.x, 1);
  assert.equal(draft.zones.qa.z, 1);
  // A drag puts it straight down, clamped the same way.
  draft = placeSelection(draft, room, -3, 0.25);
  assert.equal(draft.zones.qa.x, -1);
  assert.equal(draft.zones.qa.z, 0.25);
  // Rooms do not turn; pieces do, and wrap round.
  const before = JSON.stringify(draft.zones);
  draft = turnSelection(draft, room, ARRANGE_TURN);
  assert.equal(JSON.stringify(draft.zones), before);
});

test("furniture is placed, turned, selected and removed", () => {
  let draft = draftFromLayout(null, defaults);
  const first = addProp(draft, "sofa");
  draft = first.draft;
  assert.equal(first.selection, "prop:0");
  assert.equal(draft.props[0].kind, "sofa");
  const second = addProp(draft, "plant");
  draft = second.draft;
  assert.notEqual(
    `${draft.props[0].x},${draft.props[0].z}`,
    `${draft.props[1].x},${draft.props[1].z}`,
    "a second piece does not land on the first",
  );
  draft = turnSelection(draft, second.selection, ARRANGE_TURN * 3);
  assert.ok(Math.abs(draft.props[1].rotation - ARRANGE_TURN * 3) < 0.002);
  draft = turnSelection(draft, second.selection, -ARRANGE_TURN * 8);
  assert.ok(draft.props[1].rotation >= 0, "a turn never goes negative");
  // An office holds only so much.
  let full = draft;
  for (let i = 0; i < 30; i += 1) full = addProp(full, "plant", { max: 24 }).draft;
  assert.equal(full.props.length, 24);
  assert.equal(addProp(full, "plant", { max: 24 }).full, true);
  // Removing one selects the one before it.
  const removed = removeProp(draft, "prop:1");
  assert.equal(removed.draft.props.length, 1);
  assert.equal(removed.selection, "prop:0");
  assert.equal(removeProp({ props: [] }, null).selection, null);
});

test("a draft saves only what differs, and the server accepts it", () => {
  let draft = draftFromLayout(null, defaults);
  draft = moveSelection(draft, selectionOf("zone", "review"), 0.1, 0.4);
  draft = renameSelection(draft, selectionOf("zone", "review"), "  War room ");
  draft = addProp(draft, "whiteboard").draft;
  const layout = layoutFromDraft(draft, defaults);
  assert.deepEqual(Object.keys(layout.zones), ["review"], "only the room moved");
  assert.equal(layout.zones.review.label, "War room");
  assert.equal(layout.props.length, 1);
  // The server's own validation is the contract this has to meet.
  assert.deepEqual(normalizeOfficeLayout(layout), {
    zones: {
      review: {
        x: layout.zones.review.x,
        z: layout.zones.review.z,
        label: "War room",
      },
    },
    props: layout.props,
  });
  // Reset gives the environment's layout back.
  assert.equal(isDraftEmpty(resetDraft(defaults), defaults), true);
});

test("the editor says what it just did", () => {
  let draft = draftFromLayout(null, defaults);
  assert.equal(describeSelection(draft, null), "Nothing selected");
  assert.equal(
    describeSelection(draft, selectionOf("zone", "qa"), { qa: "QA station" }),
    "QA station at -0.36, -0.70, for QA station",
  );
  draft = renameSelection(draft, selectionOf("zone", "qa"), "Test lab");
  assert.match(
    describeSelection(draft, selectionOf("zone", "qa"), { qa: "QA station" }),
    /^Test lab at/,
  );
  const placed = addProp(draft, "lamp");
  assert.match(
    describeSelection(placed.draft, placed.selection),
    /^lamp at .*turned 0 degrees$/,
  );
});

test("a room can be given another function, and the room that had it swaps", () => {
  let draft = draftFromLayout(null, defaults);
  const meeting = selectionOf("zone", "meeting");
  // The meeting room becomes the QA station; the QA room takes meetings.
  draft = setFunction(draft, meeting, "qa");
  assert.equal(draft.zones.meeting.does, "qa");
  assert.equal(draft.zones.qa.does, "meeting");
  const swapped = layoutFromDraft(draft, defaults);
  assert.deepEqual(swapped.zones.meeting, { x: 0.36, z: -0.7, does: "qa" });
  assert.deepEqual(swapped.zones.qa, { x: -0.36, z: -0.7, does: "meeting" });
  // The server accepts a swap and refuses a half one.
  assert.deepEqual(normalizeOfficeLayout(swapped).zones, swapped.zones);
  assert.throws(
    () => normalizeOfficeLayout({ zones: { meeting: { x: 0, z: 0, does: "qa" } } }),
    /must give up qa/,
  );
  // A room can serve nothing: that work happens at the desks.
  draft = setFunction(draft, selectionOf("zone", "review"), "none");
  assert.equal(draft.zones.review.does, "none");
  assert.equal(
    layoutFromDraft(draft, defaults).zones.review.does,
    "none",
  );
  // Back to its own function, and the draft says nothing again.
  let plain = draftFromLayout(null, defaults);
  plain = setFunction(plain, meeting, "qa");
  plain = setFunction(plain, meeting, "meeting");
  assert.equal(isDraftEmpty(plain, defaults), true);
});
