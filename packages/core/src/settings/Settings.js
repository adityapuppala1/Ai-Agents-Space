import { InputError } from "../TaskStore.js";

/**
 * Typed application settings stored as JSON values in the `settings` table.
 * Unknown keys are accepted (modules may register their own) but the defaults
 * below are the documented ones. Secrets never belong here.
 */
export const SETTING_DEFAULTS = Object.freeze({
  "observation.enabled": true,
  "observation.autoCreateWorkspaces": true,
  "observation.staleAfterMs": 180000,
  "hooks.claudeCode.installed": false,
  "hooks.claudeCode.timeoutSeconds": 300,
  "codex.useAppServer": false,
  "ui.presentationMode": false,
  "ui.reducedMotion": false,
  "ui.graphics": "medium",
  "budget.dailyRunLimit": null,
});

/** Keys that are safe to ship to the browser in the global snapshot. */
export const PUBLIC_SETTING_KEYS = Object.freeze([
  "observation.enabled",
  "observation.autoCreateWorkspaces",
  "observation.staleAfterMs",
  "hooks.claudeCode.installed",
  "hooks.claudeCode.timeoutSeconds",
  "codex.useAppServer",
  "ui.presentationMode",
  "ui.reducedMotion",
  "ui.graphics",
  "budget.dailyRunLimit",
]);

const VALIDATORS = {
  "observation.enabled": bool,
  "observation.autoCreateWorkspaces": bool,
  "observation.staleAfterMs": intRange(5000, 24 * 60 * 60 * 1000),
  "hooks.claudeCode.installed": bool,
  "hooks.claudeCode.timeoutSeconds": intRange(10, 3600),
  "codex.useAppServer": bool,
  "ui.presentationMode": bool,
  "ui.reducedMotion": bool,
  "ui.graphics": oneOf(["low", "medium", "high"]),
  "budget.dailyRunLimit": nullableIntRange(1, 100000),
};

const SECRET_KEY =
  /token|secret|password|authorization|credential|apikey|api_key/i;

function bool(value, key) {
  if (typeof value !== "boolean")
    throw new InputError(`${key} must be true or false`);
  return value;
}
function intRange(min, max) {
  return (value, key) => {
    if (!Number.isInteger(value) || value < min || value > max)
      throw new InputError(
        `${key} must be an integer between ${min} and ${max}`,
      );
    return value;
  };
}
function nullableIntRange(min, max) {
  const inner = intRange(min, max);
  return (value, key) => (value === null ? null : inner(value, key));
}
function oneOf(options) {
  return (value, key) => {
    if (!options.includes(value))
      throw new InputError(`${key} must be one of ${options.join(", ")}`);
    return value;
  };
}

export class Settings {
  constructor(db, { defaults = SETTING_DEFAULTS, now = Date.now } = {}) {
    this.db = db;
    this.defaults = { ...defaults };
    this.now = now;
  }

  has(key) {
    return !!this.db.prepare("SELECT key FROM settings WHERE key = ?").get(key);
  }

  get(key, fallback) {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key);
    if (!row) return fallback !== undefined ? fallback : this.defaults[key];
    try {
      return JSON.parse(row.value);
    } catch {
      return fallback !== undefined ? fallback : this.defaults[key];
    }
  }

  set(key, value) {
    if (typeof key !== "string" || !key.trim() || key.length > 120)
      throw new InputError("Setting key must be a short string");
    if (SECRET_KEY.test(key))
      throw new InputError("Secrets are not stored in settings", 400);
    if (value === undefined) throw new InputError(`${key} needs a value`);
    const validate = VALIDATORS[key];
    const checked = validate ? validate(value, key) : value;
    const json = JSON.stringify(checked);
    if (json === undefined || json.length > 16384)
      throw new InputError(`${key} value is not storable JSON`);
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, json, this.now());
    return checked;
  }

  /** Applies several keys at once; validates everything before writing. */
  update(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch))
      throw new InputError("Expected an object of settings");
    const entries = Object.entries(patch);
    for (const [key, value] of entries) {
      const validate = VALIDATORS[key];
      if (SECRET_KEY.test(key))
        throw new InputError("Secrets are not stored in settings", 400);
      if (validate) validate(value, key);
    }
    for (const [key, value] of entries) this.set(key, value);
    return this.all();
  }

  delete(key) {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  /** Defaults merged with stored overrides. */
  all() {
    const result = { ...this.defaults };
    for (const row of this.db
      .prepare("SELECT key, value FROM settings")
      .all()) {
      try {
        result[row.key] = JSON.parse(row.value);
      } catch {
        /* skip unreadable value */
      }
    }
    return result;
  }

  /** The subset the browser may see. */
  publicSubset() {
    const all = this.all();
    const out = {};
    for (const key of PUBLIC_SETTING_KEYS) out[key] = all[key];
    return out;
  }
}
