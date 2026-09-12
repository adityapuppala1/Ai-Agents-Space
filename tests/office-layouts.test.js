import test from "node:test";
import assert from "node:assert/strict";
import {
  computeLayout,
  LAYOUT_PROFILES,
  ZONE_IDS,
} from "../apps/web/src/office/zones.js";
import { THEMES } from "../apps/web/src/office/themes.js";

test("every office theme selects a supported spatial profile", () => {
  for (const theme of Object.values(THEMES)) {
    assert.ok(LAYOUT_PROFILES.has(theme.layoutProfile), theme.id);
  }
});

test("spatial profiles keep every work zone inside the room", () => {
  for (const profile of LAYOUT_PROFILES) {
    const layout = computeLayout(12, profile);
    assert.equal(layout.profile, profile);
    assert.deepEqual(Object.keys(layout.zones), ZONE_IDS);
    for (const zone of Object.values(layout.zones)) {
      assert.ok(Math.abs(zone.x) < layout.width / 2, `${profile}:${zone.id}:x`);
      assert.ok(Math.abs(zone.z) < layout.depth / 2, `${profile}:${zone.id}:z`);
      assert.equal(zone.slots.length, 8);
    }
  }
});

test("command, courtyard and gallery profiles have distinct zone geometry", () => {
  const signature = (profile) =>
    ZONE_IDS.map((id) => {
      const zone = computeLayout(6, profile).zones[id];
      return `${zone.x.toFixed(2)},${zone.z.toFixed(2)}`;
    }).join("|");
  assert.notEqual(signature("studio"), signature("command"));
  assert.notEqual(signature("command"), signature("courtyard"));
  assert.notEqual(signature("courtyard"), signature("gallery"));
});
