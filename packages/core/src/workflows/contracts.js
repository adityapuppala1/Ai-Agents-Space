/**
 * Task contracts (roadmap §10, "Task contracts: required inputs, expected
 * artifact schema, completion criteria, timeout, allowed tools, budget, and
 * reviewer").
 *
 * A contract is stored as JSON on `tasks.contract` (migration 6):
 *
 *   {
 *     inputs: [{ key, type, required }],
 *     outputSchema: <JSON Schema subset> | null,
 *     completionCriteria: [string],   // OBJECTIVE only, see CRITERIA below
 *     timeoutMs: number | null,
 *     allowedTools: [string],
 *     budget: { maxTokens: number|null, maxRuns: number|null },
 *     reviewer: <agent id> | "human" | null,
 *     compensation: { description, command } | null
 *   }
 *
 * Honesty rules that bind this file:
 *  - Completion criteria are machine-checkable facts about recorded runs.
 *    Anything that would require a judgement ("the code is clean", "the plan
 *    is good") is rejected by validateContract: Agent Space never claims to
 *    have judged quality.
 *  - The JSON Schema validator is a hand-written subset (type, properties,
 *    required, items, enum). It reports what it could not check instead of
 *    passing silently.
 *  - A contract failure never marks a task complete: it sets the task review
 *    to `pending` with the failures listed, and the human (or the reviewer
 *    agent) decides.
 */

import { InputError } from "../TaskStore.js";

/** Value types accepted for a contract input. */
export const INPUT_TYPES = [
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "file",
  "any",
];

/** Reviewer values that are not an agent id. */
export const HUMAN_REVIEWER = "human";

/**
 * Objective completion criteria. Each entry is a literal string stored on the
 * contract; anything not matching one of these patterns is refused.
 *
 *   artifact:<kind>              an artifact of that kind exists for the run
 *   command-exit-zero:<pattern>  a recorded command matching <pattern>
 *                                (case-insensitive substring or /regex/)
 *                                reported exit code 0
 *   test-passed                  a recorded test command reported exit code 0
 *   file-edited[:<substring>]    a file edit/write event was recorded
 *   final-message-non-empty      the run produced a non-empty final message
 *   output-schema                the parsed JSON result matches outputSchema
 */
export const CRITERIA = [
  { type: "artifact", pattern: /^artifact:(.+)$/ },
  { type: "command-exit-zero", pattern: /^command-exit-zero:(.+)$/ },
  { type: "test-passed", pattern: /^test-passed$/ },
  { type: "file-edited", pattern: /^file-edited(?::(.+))?$/ },
  { type: "final-message-non-empty", pattern: /^final-message-non-empty$/ },
  { type: "output-schema", pattern: /^output-schema$/ },
];

export const CRITERIA_HELP = CRITERIA.map((c) => c.type).join(", ");

export const DEFAULT_CONTRACT = Object.freeze({
  inputs: [],
  outputSchema: null,
  completionCriteria: [],
  timeoutMs: null,
  allowedTools: [],
  budget: { maxTokens: null, maxRuns: null },
  reviewer: null,
  compensation: null,
});

const SCHEMA_TYPES = [
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
];

export function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

/** Parses one completion criterion string. Returns null when unrecognised. */
export function parseCriterion(text) {
  const value = String(text ?? "").trim();
  for (const entry of CRITERIA) {
    const match = entry.pattern.exec(value);
    if (match) return { type: entry.type, arg: match[1] ?? null, raw: value };
  }
  return null;
}

function nullableInt(value, field, { min = 1 } = {}) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < min)
    throw new InputError(`${field} must be an integer >= ${min} or null`);
  return value;
}

/** Validates a JSON Schema subset. Throws InputError on unsupported keywords. */
export function validateSchemaDocument(schema, path = "outputSchema") {
  if (schema === null || schema === undefined) return null;
  if (typeof schema !== "object" || Array.isArray(schema))
    throw new InputError(`${path} must be a JSON Schema object`);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "type") {
      const types = Array.isArray(value) ? value : [value];
      for (const type of types)
        if (!SCHEMA_TYPES.includes(type))
          throw new InputError(
            `${path}.type must be one of ${SCHEMA_TYPES.join(", ")}`,
          );
      out.type = value;
    } else if (key === "properties") {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new InputError(`${path}.properties must be an object`);
      out.properties = {};
      for (const [name, child] of Object.entries(value))
        out.properties[name] = validateSchemaDocument(
          child,
          `${path}.properties.${name}`,
        );
    } else if (key === "required") {
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
        throw new InputError(`${path}.required must be an array of strings`);
      out.required = [...value];
    } else if (key === "items") {
      out.items = validateSchemaDocument(value, `${path}.items`);
    } else if (key === "enum") {
      if (!Array.isArray(value) || value.length === 0)
        throw new InputError(`${path}.enum must be a non-empty array`);
      out.enum = [...value];
    } else if (key === "description" || key === "title") {
      out[key] = String(value).slice(0, 300);
    } else {
      throw new InputError(
        `${path}: unsupported JSON Schema keyword "${key}". Supported: type, properties, required, items, enum, title, description`,
      );
    }
  }
  return out;
}

function typeMatches(type, value) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return (
        value !== null && typeof value === "object" && !Array.isArray(value)
      );
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      return false;
  }
}

/**
 * Hand-written validator for the schema subset. Returns a list of plain
 * strings describing every mismatch (empty list = valid).
 */
export function checkSchema(schema, value, path = "$") {
  if (!schema) return [];
  const failures = [];
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(type, value)))
      failures.push(`${path} should be ${types.join(" or ")}`);
  }
  if (schema.enum !== undefined) {
    const ok = schema.enum.some(
      (option) => JSON.stringify(option) === JSON.stringify(value),
    );
    if (!ok)
      failures.push(`${path} should be one of ${JSON.stringify(schema.enum)}`);
  }
  if (
    schema.properties &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    for (const [name, child] of Object.entries(schema.properties))
      if (value[name] !== undefined)
        failures.push(...checkSchema(child, value[name], `${path}.${name}`));
  }
  if (Array.isArray(schema.required)) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      failures.push(`${path} should be an object with required properties`);
    else
      for (const name of schema.required)
        if (value[name] === undefined)
          failures.push(`${path}.${name} is required and missing`);
  }
  if (schema.items && Array.isArray(value))
    value.forEach((entry, index) =>
      failures.push(...checkSchema(schema.items, entry, `${path}[${index}]`)),
    );
  return failures;
}

/** Validates and normalizes a contract. Throws InputError with a plain reason. */
export function validateContract(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new InputError("contract must be an object");
  const contract = {
    ...DEFAULT_CONTRACT,
    budget: { ...DEFAULT_CONTRACT.budget },
  };

  if (input.inputs !== undefined) {
    if (!Array.isArray(input.inputs))
      throw new InputError("contract.inputs must be an array");
    contract.inputs = input.inputs.map((entry, index) => {
      if (!entry || typeof entry !== "object")
        throw new InputError(`contract.inputs[${index}] must be an object`);
      const key = String(entry.key ?? "").trim();
      if (!key || key.length > 80)
        throw new InputError(
          `contract.inputs[${index}].key must be 1–80 characters`,
        );
      const type = entry.type ?? "any";
      if (!INPUT_TYPES.includes(type))
        throw new InputError(
          `contract.inputs[${index}].type must be one of ${INPUT_TYPES.join(", ")}`,
        );
      return { key, type, required: entry.required !== false };
    });
  }

  contract.outputSchema = validateSchemaDocument(input.outputSchema ?? null);

  if (input.completionCriteria !== undefined) {
    if (!Array.isArray(input.completionCriteria))
      throw new InputError("contract.completionCriteria must be an array");
    contract.completionCriteria = input.completionCriteria.map((entry) => {
      const parsed = parseCriterion(entry);
      if (!parsed)
        throw new InputError(
          `Completion criterion "${entry}" is not objective. Agent Space only checks facts it recorded. Use one of: ${CRITERIA_HELP}`,
        );
      return parsed.raw;
    });
  }

  contract.timeoutMs = nullableInt(input.timeoutMs, "contract.timeoutMs", {
    min: 1000,
  });

  if (input.allowedTools !== undefined) {
    if (
      !Array.isArray(input.allowedTools) ||
      input.allowedTools.some((tool) => typeof tool !== "string")
    )
      throw new InputError("contract.allowedTools must be an array of strings");
    contract.allowedTools = [
      ...new Set(input.allowedTools.map((t) => t.trim())),
    ]
      .filter(Boolean)
      .slice(0, 64);
  }

  if (input.budget !== undefined && input.budget !== null) {
    if (typeof input.budget !== "object" || Array.isArray(input.budget))
      throw new InputError("contract.budget must be an object");
    contract.budget = {
      maxTokens: nullableInt(
        input.budget.maxTokens,
        "contract.budget.maxTokens",
      ),
      maxRuns: nullableInt(input.budget.maxRuns, "contract.budget.maxRuns"),
    };
  }

  if (input.reviewer !== undefined && input.reviewer !== null) {
    if (typeof input.reviewer !== "string" || !input.reviewer.trim())
      throw new InputError(
        `contract.reviewer must be an agent id or "${HUMAN_REVIEWER}"`,
      );
    contract.reviewer = input.reviewer.trim();
  }

  if (input.compensation !== undefined && input.compensation !== null) {
    const comp = input.compensation;
    if (typeof comp !== "object" || Array.isArray(comp))
      throw new InputError("contract.compensation must be an object");
    const description = String(comp.description ?? "").trim();
    if (!description)
      throw new InputError("contract.compensation.description is required");
    contract.compensation = {
      description: description.slice(0, 500),
      // Stored for a human to approve. Agent Space never runs it itself.
      command: comp.command ? String(comp.command).slice(0, 500) : null,
      automatic: false,
    };
  }

  return contract;
}

/** True when the contract asks for anything at all. */
export function contractIsEmpty(contract) {
  if (!contract) return true;
  return (
    (contract.inputs ?? []).length === 0 &&
    !contract.outputSchema &&
    (contract.completionCriteria ?? []).length === 0 &&
    !contract.timeoutMs &&
    (contract.allowedTools ?? []).length === 0 &&
    !contract.reviewer &&
    !contract.compensation &&
    !contract.budget?.maxTokens &&
    !contract.budget?.maxRuns
  );
}

/**
 * Checks the required inputs of a task's contract against what is available.
 * `provided` defaults to the task's own `context.inputs`.
 *
 * → { ok, missing: [{ key, type, detail }], provided: [keys] }
 */
export function checkInputs(task, provided = null) {
  const contract = task?.contract ?? DEFAULT_CONTRACT;
  const values =
    provided ??
    (task?.context && typeof task.context === "object"
      ? (task.context.inputs ?? {})
      : {});
  const missing = [];
  for (const input of contract.inputs ?? []) {
    if (!input.required) continue;
    const value = values?.[input.key];
    if (value === undefined || value === null || value === "") {
      missing.push({
        key: input.key,
        type: input.type,
        detail: `required input "${input.key}" was not provided`,
      });
      continue;
    }
    if (
      input.type !== "any" &&
      input.type !== "file" &&
      !typeMatches(input.type, value)
    )
      missing.push({
        key: input.key,
        type: input.type,
        detail: `input "${input.key}" should be ${input.type}`,
      });
  }
  return {
    ok: missing.length === 0,
    missing,
    provided: Object.keys(values ?? {}),
  };
}

const TEST_HINT =
  /\b(test|jest|vitest|pytest|mocha|playwright|npm run test|node --test|go test|cargo test|phpunit)\b/i;

function commandTextOf(event) {
  return String(
    event?.data?.command ?? event?.data?.cmd ?? event?.summary ?? "",
  );
}

function exitCodeOf(event) {
  const value = event?.data?.exitCode ?? event?.data?.exit_code;
  return typeof value === "number" ? value : null;
}

function matchesPattern(text, pattern) {
  const value = String(text ?? "");
  const regex = /^\/(.+)\/([a-z]*)$/.exec(pattern ?? "");
  if (regex) {
    try {
      return new RegExp(regex[1], regex[2]).test(value);
    } catch {
      return false;
    }
  }
  return value.toLowerCase().includes(String(pattern ?? "").toLowerCase());
}

/** Parses the first JSON object/array found in artifacts or the final message. */
export function extractJsonResult({
  artifacts = [],
  finalMessage = null,
} = {}) {
  const candidates = [];
  for (const artifact of artifacts)
    if (typeof artifact?.content === "string")
      candidates.push({
        source: `artifact:${artifact.kind}`,
        text: artifact.content,
      });
  if (typeof finalMessage === "string")
    candidates.push({ source: "final-message", text: finalMessage });
  for (const candidate of candidates) {
    const text = candidate.text.trim();
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
    for (const body of [fenced?.[1], text]) {
      if (!body) continue;
      const trimmed = body.trim();
      if (!/^[[{]/.test(trimmed)) continue;
      try {
        return { value: JSON.parse(trimmed), source: candidate.source };
      } catch {
        /* try the next candidate */
      }
    }
  }
  return { value: undefined, source: null };
}

/**
 * Checks a completed run against the contract.
 *
 * result = { artifacts: [{kind,title,content,metadata}], finalMessage, events }
 * → { ok, failures: [{ criterion, detail }], checked: [criterion], json }
 *
 * Every failure names the criterion it came from. Criteria Agent Space could
 * not evaluate (no recorded evidence) count as failures, never as passes.
 */
export function validateResult(contract, result = {}) {
  const spec = contract ?? DEFAULT_CONTRACT;
  const artifacts = result.artifacts ?? [];
  const events = result.events ?? [];
  const finalMessage = result.finalMessage ?? null;
  const failures = [];
  const checked = [];
  const json = extractJsonResult({ artifacts, finalMessage });

  const criteria = [...(spec.completionCriteria ?? [])];
  if (spec.outputSchema && !criteria.includes("output-schema"))
    criteria.push("output-schema");

  for (const raw of criteria) {
    const parsed = parseCriterion(raw);
    if (!parsed) {
      failures.push({
        criterion: raw,
        detail: "unknown criterion; nothing was checked",
      });
      continue;
    }
    checked.push(parsed.raw);
    switch (parsed.type) {
      case "artifact": {
        if (!artifacts.some((a) => a.kind === parsed.arg))
          failures.push({
            criterion: parsed.raw,
            detail: `no artifact of kind "${parsed.arg}" was recorded for this run`,
          });
        break;
      }
      case "command-exit-zero": {
        const hit = events.some(
          (event) =>
            (event.kind === "command" || event.kind === "test") &&
            matchesPattern(commandTextOf(event), parsed.arg) &&
            exitCodeOf(event) === 0,
        );
        if (!hit)
          failures.push({
            criterion: parsed.raw,
            detail: `no recorded command matching "${parsed.arg}" reported exit code 0`,
          });
        break;
      }
      case "test-passed": {
        const fromEvents = events.some(
          (event) =>
            (event.kind === "test" ||
              (event.kind === "command" &&
                TEST_HINT.test(commandTextOf(event)))) &&
            exitCodeOf(event) === 0,
        );
        const fromArtifacts = artifacts.some(
          (a) => a.kind === "test-output" && a.metadata?.exitCode === 0,
        );
        if (!fromEvents && !fromArtifacts)
          failures.push({
            criterion: parsed.raw,
            detail:
              "no recorded test command reported exit code 0 (a test may have run outside Agent Space; that is not evidence)",
          });
        break;
      }
      case "file-edited": {
        const hit = events.some(
          (event) =>
            ["file.edit", "file.write"].includes(event.kind) &&
            (!parsed.arg ||
              String(event.file ?? "")
                .toLowerCase()
                .includes(parsed.arg.toLowerCase())),
        );
        if (!hit)
          failures.push({
            criterion: parsed.raw,
            detail: parsed.arg
              ? `no recorded file edit touched "${parsed.arg}"`
              : "no file edit or write event was recorded",
          });
        break;
      }
      case "final-message-non-empty": {
        if (typeof finalMessage !== "string" || !finalMessage.trim())
          failures.push({
            criterion: parsed.raw,
            detail: "the run recorded no final message",
          });
        break;
      }
      case "output-schema": {
        if (!spec.outputSchema) {
          failures.push({
            criterion: parsed.raw,
            detail: "the contract has no outputSchema to check against",
          });
          break;
        }
        if (json.value === undefined) {
          failures.push({
            criterion: parsed.raw,
            detail:
              "no JSON artifact or final message could be parsed, so the output schema was not checked",
          });
          break;
        }
        for (const problem of checkSchema(spec.outputSchema, json.value))
          failures.push({ criterion: parsed.raw, detail: problem });
        break;
      }
      default:
        break;
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    checked,
    json: json.source ? { source: json.source } : null,
  };
}

/** Reads and normalizes the contract stored on a task row. */
export function contractFromRow(row) {
  const stored = parseJson(row?.contract, {});
  try {
    return validateContract(stored);
  } catch {
    // A contract written by an older/edited row must never crash a read.
    return { ...DEFAULT_CONTRACT, budget: { ...DEFAULT_CONTRACT.budget } };
  }
}
