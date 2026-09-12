import test from "node:test";
import assert from "node:assert/strict";
import {
  diffVisualPreset,
  makeVisualPreset,
  normalizeVisualPreset,
  VISUAL_THEMES,
} from "../packages/core/src/visual/VisualPreset.js";

test("visual presets normalize only the portable visual vocabulary", () => {
  const preset = normalizeVisualPreset({
    kind: "agent-space-visual-preset",
    version: 1,
    name: " Midnight incident room ",
    theme: "midnight",
    settings: { graphics: "high", lighting: "focus", ambientSound: false },
  });
  // A version 1 document still imports; it simply says nothing about the
  // office layout, so the workspace keeps the one it has.
  assert.deepEqual(preset, {
    kind: "agent-space-visual-preset",
    version: 2,
    name: "Midnight incident room",
    theme: "midnight",
    settings: {
      "ui.graphics": "high",
      "ui.office.lighting": "focus",
      "ui.office.ambientSound": false,
    },
  });
  assert.throws(
    () => normalizeVisualPreset({ ...preset, theme: "neon" }),
    /theme must be one of/,
  );
  assert.throws(
    () => normalizeVisualPreset({ ...preset, policy: { autonomy: "full" } }),
    /unknown key policy/,
  );
  assert.throws(
    () =>
      normalizeVisualPreset({
        ...preset,
        settings: { rootPath: "C:\\private" },
      }),
    /settings.rootPath is not allowed/,
  );
});

test("visual preset export and diff preserve only changed visual fields", () => {
  const preset = makeVisualPreset({
    name: "Ops desk",
    theme: "operations",
    settings: { "ui.graphics": "low", "ui.office.labelDensity": "active" },
  });
  assert.equal(preset.theme, "operations");
  assert.deepEqual(
    diffVisualPreset(
      {
        theme: "studio",
        settings: {
          "ui.graphics": "medium",
          "ui.office.labelDensity": "active",
        },
      },
      preset,
    ),
    [
      { key: "theme", from: "studio", to: "operations" },
      { key: "ui.graphics", from: "medium", to: "low" },
    ],
  );
});

test("every shipped office environment is portable", () => {
  assert.deepEqual(VISUAL_THEMES, [
    "studio",
    "operations",
    "garden",
    "midnight",
    "sandstone",
    "data-lab",
    "research-library",
    "creative-studio",
  ]);
  for (const theme of VISUAL_THEMES) {
    const preset = makeVisualPreset({
      name: `${theme} workspace`,
      theme,
      settings: { graphics: "auto", labelDensity: "active" },
    });
    assert.equal(preset.theme, theme);
  }
});

test("a preset carries the office a workspace arranged, or says nothing about it", () => {
  const arranged = makeVisualPreset({
    name: "Arranged studio",
    theme: "studio",
    settings: {},
    layout: {
      zones: { qa: { x: 0.5, z: -0.2, label: " Test lab " } },
      props: [{ kind: "plant", x: 0.1, z: 0.2 }],
    },
  });
  assert.deepEqual(arranged.layout, {
    zones: { qa: { x: 0.5, z: -0.2, label: "Test lab" } },
    props: [{ kind: "plant", x: 0.1, z: 0.2, rotation: 0 }],
  });
  // Round trip: an exported preset imports unchanged.
  assert.deepEqual(normalizeVisualPreset(arranged), arranged);
  // No layout key at all: the workspace keeps its own arrangement.
  const quiet = makeVisualPreset({ name: "Quiet", theme: "studio" });
  assert.equal("layout" in quiet, false);
  // The diff says what the layout would do, and only when it says something.
  assert.deepEqual(
    diffVisualPreset({ theme: "studio", settings: {}, layout: null }, arranged),
    [
      { key: "layout.rooms", from: "0 arranged", to: "1 arranged (qa)" },
      { key: "layout.furniture", from: "0 pieces", to: "1 pieces" },
    ],
  );
  assert.deepEqual(
    diffVisualPreset({ theme: "studio", settings: {}, layout: null }, quiet),
    [],
  );
  assert.throws(
    () => normalizeVisualPreset({ ...arranged, layout: { rooms: {} } }),
    /layout has unknown key rooms/,
  );
});
