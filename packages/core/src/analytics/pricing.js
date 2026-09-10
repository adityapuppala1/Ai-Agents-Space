/**
 * Optional, explicitly versioned pricing for token usage.
 *
 * Honesty rules (docs/ARCHITECTURE.md §0):
 *   - Provider-reported cost ALWAYS wins and is marked `reported: true`.
 *   - A cost we compute ourselves is marked `estimated: true`, carries the
 *     pricing version it came from, and lists its assumptions.
 *   - With no pricing configured we return `{ value: null, reason: 'no
 *     pricing configured' }`. We never guess a price, and we never rank
 *     model quality by price, speed, or token usage.
 *
 * The table lives in settings under the key `pricing` and is empty by
 * default:
 *
 *   { "<model>": { inputPer1k, outputPer1k, currency, source, version } }
 *
 * `inputPer1k` / `outputPer1k` are the price of one thousand tokens in
 * `currency`. Legacy per-million keys (`inputUsdPerMillion`,
 * `outputUsdPerMillion`) are accepted so an existing caller-supplied table
 * keeps working.
 */

import { InputError } from "../TaskStore.js";

export const PRICING_SETTING_KEY = "pricing";

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Reads provider-reported token counts from the merged usage object. */
export function readTokens(usage = {}) {
  const u = usage ?? {};
  const nested = u.total_token_usage ?? u.totalTokenUsage ?? {};
  const input =
    num(u.input_tokens) ??
    num(u.inputTokens) ??
    num(nested.input_tokens) ??
    num(u.input) ??
    null;
  const output =
    num(u.output_tokens) ??
    num(u.outputTokens) ??
    num(nested.output_tokens) ??
    num(u.output) ??
    null;
  return { input, output, reported: input !== null || output !== null };
}

/** Reads provider-reported cost; never derives it from tokens here. */
export function readCost(cost = {}, usage = {}) {
  const c = cost ?? {};
  const value =
    num(c.total_usd) ??
    num(c.totalUsd) ??
    num(c.usd) ??
    num(c.value) ??
    num(usage?.total_cost_usd) ??
    num(usage?.totalCostUsd) ??
    null;
  return { value, reported: value !== null };
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Normalizes one table entry. Returns null when the entry carries no usable
 * price at all, so a half-written row never produces a number.
 */
export function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const inputPer1k =
    num(entry.inputPer1k) ??
    (num(entry.inputUsdPerMillion) !== null
      ? entry.inputUsdPerMillion / 1000
      : null);
  const outputPer1k =
    num(entry.outputPer1k) ??
    (num(entry.outputUsdPerMillion) !== null
      ? entry.outputUsdPerMillion / 1000
      : null);
  if (inputPer1k === null && outputPer1k === null) return null;
  return {
    inputPer1k: inputPer1k ?? 0,
    outputPer1k: outputPer1k ?? 0,
    currency: typeof entry.currency === "string" ? entry.currency : "USD",
    source: typeof entry.source === "string" ? entry.source : null,
    version:
      entry.version === undefined || entry.version === null
        ? null
        : String(entry.version),
  };
}

export class Pricing {
  /**
   * @param services core service container (uses `settings` when present)
   * @param options.table explicit table; when given, settings are not read
   */
  constructor(services, { table = null, now = Date.now } = {}) {
    this.services = services;
    this.db = services?.db ?? null;
    this.explicit = table && typeof table === "object" ? table : null;
    this.now = now;
  }

  /** The raw configured table (never throws; an unreadable value is empty). */
  raw() {
    if (this.explicit) return this.explicit;
    const settings = this.services?.settings;
    if (settings?.get) {
      const value = settings.get(PRICING_SETTING_KEY, {});
      return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
    }
    if (!this.db) return {};
    try {
      const row = this.db
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get(PRICING_SETTING_KEY);
      const value = row ? JSON.parse(row.value) : {};
      return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
    } catch {
      return {};
    }
  }

  /** Normalized table plus provenance for the UI. */
  table() {
    const raw = this.raw();
    const models = {};
    for (const [model, entry] of Object.entries(raw)) {
      const normalized = normalizeEntry(entry);
      if (normalized) models[model] = normalized;
    }
    return {
      configured: Object.keys(models).length > 0,
      source: this.explicit ? "caller" : "settings:pricing",
      models,
    };
  }

  entry(model) {
    if (!model) return null;
    return this.table().models[model] ?? null;
  }

  /**
   * Estimates the cost of `usage` for `model`.
   * Accepts either a raw provider usage object or `{ input, output }`.
   */
  estimateCost(usage, model) {
    const entry = this.entry(model);
    if (!entry)
      return {
        value: null,
        currency: null,
        reported: false,
        estimated: false,
        reason: "no pricing configured",
      };
    const tokens =
      usage && (num(usage.input) !== null || num(usage.output) !== null)
        ? {
            input: num(usage.input),
            output: num(usage.output),
            reported: true,
          }
        : readTokens(usage);
    if (!tokens.reported)
      return {
        value: null,
        currency: entry.currency,
        reported: false,
        estimated: false,
        reason: "no reported token usage",
      };
    const value = round6(
      ((tokens.input ?? 0) / 1000) * entry.inputPer1k +
        ((tokens.output ?? 0) / 1000) * entry.outputPer1k,
    );
    const assumptions = [
      `input ${entry.inputPer1k} and output ${entry.outputPer1k} ${entry.currency} per 1k tokens`,
      entry.source
        ? `pricing source: ${entry.source}`
        : "pricing source not recorded",
      "cache reads/writes and provider discounts are not modelled",
    ];
    if (entry.version === null)
      assumptions.push("this pricing entry carries no version");
    return {
      value,
      currency: entry.currency,
      reported: false,
      estimated: true,
      pricingVersion: entry.version,
      assumptions,
    };
  }

  /**
   * The cost to display for a run: provider-reported when there is one,
   * otherwise an estimate, otherwise a stated reason.
   */
  costFor({ usage = {}, cost = {}, model = null } = {}) {
    const reported = readCost(cost, usage);
    if (reported.reported)
      return {
        value: reported.value,
        currency: typeof cost?.currency === "string" ? cost.currency : "USD",
        reported: true,
        estimated: false,
        source: "provider",
      };
    return this.estimateCost(usage, model);
  }

  /** Validates and stores a table. Requires a version per entry. */
  configure(table) {
    if (!table || typeof table !== "object" || Array.isArray(table))
      throw new InputError("Pricing must be an object keyed by model");
    const out = {};
    for (const [model, entry] of Object.entries(table)) {
      if (!model.trim()) throw new InputError("Model name may not be empty");
      const normalized = normalizeEntry(entry);
      if (!normalized)
        throw new InputError(
          `Pricing for ${model} needs inputPer1k or outputPer1k`,
        );
      if (!normalized.version)
        throw new InputError(
          `Pricing for ${model} needs an explicit version, so a stored estimate can say which table produced it`,
        );
      out[model] = normalized;
    }
    if (this.services?.settings?.set)
      this.services.settings.set(PRICING_SETTING_KEY, out);
    else if (this.db)
      this.db
        .prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(PRICING_SETTING_KEY, JSON.stringify(out), this.now());
    this.explicit = null;
    return this.table();
  }
}

export function createPricing(services) {
  return new Pricing(services);
}
