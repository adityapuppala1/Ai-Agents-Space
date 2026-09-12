import { InputError } from "../TaskStore.js";
import {
  normalizeOfficeLayout,
  officeLayoutChanges,
} from "./OfficeLayout.js";

export const VISUAL_PRESET_KIND = "agent-space-visual-preset";
// 2 added `layout`: the rooms a workspace moved or renamed and the
// furniture it placed. Version 1 documents still import; they simply say
// nothing about the layout, and the workspace keeps the one it has.
export const VISUAL_PRESET_VERSION = 2;
const SUPPORTED_VERSIONS = Object.freeze([1, 2]);
export const VISUAL_THEMES = Object.freeze([
  "studio",
  "operations",
  "garden",
  "midnight",
  "sandstone",
  "data-lab",
  "research-library",
  "creative-studio",
]);

export const VISUAL_SETTING_KEYS = Object.freeze({
  graphics: { key: "ui.graphics", values: ["auto", "low", "medium", "high"] },
  labelDensity: {
    key: "ui.office.labelDensity",
    values: ["auto", "all", "active", "none"],
  },
  avatarDetail: {
    key: "ui.office.avatarDetail",
    values: ["auto", "low", "medium", "high"],
  },
  lighting: {
    key: "ui.office.lighting",
    values: ["day", "evening", "focus"],
  },
  ambientSound: { key: "ui.office.ambientSound", values: [true, false] },
});

const SETTING_BY_KEY = new Map(
  Object.values(VISUAL_SETTING_KEYS).map((entry) => [entry.key, entry]),
);
const SHORT_SETTING_KEYS = new Map(
  Object.entries(VISUAL_SETTING_KEYS).map(([name, entry]) => [name, entry]),
);

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new InputError(`${field} must be an object`);
  return value;
}

function text(value, field, max = 80) {
  if (typeof value !== "string" || !value.trim())
    throw new InputError(`${field} is required`);
  const clean = value.trim();
  if (clean.length > max)
    throw new InputError(`${field} must be under ${max} characters`);
  return clean;
}

function normalizedSettings(input = {}) {
  object(input, "settings");
  const out = {};
  for (const [rawKey, value] of Object.entries(input)) {
    const entry = SHORT_SETTING_KEYS.get(rawKey) ?? SETTING_BY_KEY.get(rawKey);
    if (!entry) throw new InputError(`settings.${rawKey} is not allowed`);
    if (!entry.values.includes(value))
      throw new InputError(`settings.${rawKey} has an unsupported value`);
    out[entry.key] = value;
  }
  return out;
}

/** Strictly validates a data-only, portable visual preset. */
export function normalizeVisualPreset(input) {
  const source = object(input, "preset");
  for (const key of Object.keys(source)) {
    if (!["kind", "version", "name", "theme", "settings", "layout"].includes(key))
      throw new InputError(`preset has unknown key ${key}`);
  }
  if (source.kind !== VISUAL_PRESET_KIND)
    throw new InputError(`kind must be ${VISUAL_PRESET_KIND}`);
  if (!SUPPORTED_VERSIONS.includes(source.version))
    throw new InputError(
      `version must be one of ${SUPPORTED_VERSIONS.join(", ")}`,
    );
  const theme = text(source.theme, "theme", 40);
  if (!VISUAL_THEMES.includes(theme))
    throw new InputError(`theme must be one of ${VISUAL_THEMES.join(", ")}`);
  const preset = {
    kind: VISUAL_PRESET_KIND,
    version: VISUAL_PRESET_VERSION,
    name: text(source.name, "name"),
    theme,
    settings: normalizedSettings(source.settings ?? {}),
  };
  // Absent means "says nothing about the layout"; present replaces it.
  if (source.layout !== undefined)
    preset.layout = normalizeOfficeLayout(source.layout);
  return preset;
}

/** Builds a normalized export document from current visual state. */
export function makeVisualPreset({ name, theme, settings = {}, layout }) {
  return normalizeVisualPreset({
    kind: VISUAL_PRESET_KIND,
    version: VISUAL_PRESET_VERSION,
    name,
    theme,
    settings,
    ...(layout === undefined ? {} : { layout }),
  });
}

/** Returns only fields whose next value differs from the current visual state. */
export function diffVisualPreset(current, preset) {
  const normalized = normalizeVisualPreset(preset);
  const currentTheme = current?.theme ?? "studio";
  const currentSettings = current?.settings ?? {};
  const changes = [];
  if (currentTheme !== normalized.theme)
    changes.push({ key: "theme", from: currentTheme, to: normalized.theme });
  for (const [key, value] of Object.entries(normalized.settings)) {
    if (currentSettings[key] !== value)
      changes.push({ key, from: currentSettings[key] ?? null, to: value });
  }
  if (normalized.layout !== undefined)
    changes.push(...officeLayoutChanges(current?.layout, normalized.layout));
  return changes;
}
