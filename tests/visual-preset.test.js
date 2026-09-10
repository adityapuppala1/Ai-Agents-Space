import test from "node:test";
import assert from "node:assert/strict";
import {
  diffVisualPreset,
  makeVisualPreset,
  normalizeVisualPreset,
} from "../packages/core/src/visual/VisualPreset.js";

test("visual presets normalize only the portable visual vocabulary", () => {
  const preset = normalizeVisualPreset({
    kind: "agent-space-visual-preset",
    version: 1,
    name: " Midnight incident room ",
    theme: "midnight",
    settings: { graphics: "high", lighting: "focus", ambientSound: false },
  });
  assert.deepEqual(preset, {
    kind: "agent-space-visual-preset",
    version: 1,
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
    () => normalizeVisualPreset({ ...preset, settings: { rootPath: "C:\\private" } }),
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
      { theme: "studio", settings: { "ui.graphics": "medium", "ui.office.labelDensity": "active" } },
      preset,
    ),
    [{ key: "theme", from: "studio", to: "operations" }, { key: "ui.graphics", from: "medium", to: "low" }],
  );
});
