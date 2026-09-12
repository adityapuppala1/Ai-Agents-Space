/**
 * Structural edits to a workflow definition's step graph.
 *
 * The graph a workflow editor draws is `definition.steps[]` — the same array
 * that already round-trips through `exportWorkflow`/`importWorkflow`, so
 * editing structure needs no new file shape and `formatVersion` stays 1.
 *
 * Everything here is pure: no database, no services, no clock. Each edit
 * returns a new definition, so a rejected edit leaves the caller's object
 * exactly as it was and an editor can keep an undo stack for free.
 */
import { InputError } from "../TaskStore.js";
import { validateContract } from "./contracts.js";

/** Edit operations `applyEdit` understands. */
export const EDIT_OPS = [
  "add-step",
  "remove-step",
  "update-step",
  "add-edge",
  "remove-edge",
];

/** Step keys are used as ids in URLs, SVG markup and element ids. */
export const STEP_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,60}$/;

/**
 * `validateTemplate` refuses a step contract whose timeout is not an integer
 * of at least 1000 ms, and refuses an empty acceptance list, so a new step
 * carries the same defaults the shipped template packs use rather than a
 * shape the save path would immediately reject.
 */
export const DEFAULT_STEP_TIMEOUT_MS = 900_000;
export const DEFAULT_ACCEPTANCE = Object.freeze(["final-message-non-empty"]);

/** Fields `update-step` merges. Key, dependsOn and role have their own rules. */
export const PATCHABLE_STEP_FIELDS = [
  "title",
  "instructions",
  "deliverable",
  "acceptance",
  "provider",
  "priority",
  "contract",
  "branchCondition",
];

function stepsOf(definition) {
  const steps = definition?.steps;
  if (!Array.isArray(steps))
    throw new InputError("This workflow definition has no steps array to edit");
  return steps;
}

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim())
    throw new InputError(`step ${field} must be a non-empty string`);
  return value;
}

function roleKeys(definition) {
  return (definition?.roles ?? []).map((role) => role.key);
}

function normalizeContract(input) {
  const source = input ?? {};
  return validateContract({
    ...source,
    timeoutMs: source.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
    completionCriteria: (source.completionCriteria ?? []).length
      ? source.completionCriteria
      : [...DEFAULT_ACCEPTANCE],
  });
}

/**
 * Projects a definition's steps onto the node shape `TaskGraph` builds from
 * task rows, so `checkGraph` cannot tell a draft from a stored graph.
 *
 * The step key is the node id: a draft step has no task id yet, and the key is
 * what the definition's own edges already name.
 */
export function stepsToNodes(definition, { inputs = null } = {}) {
  const values = inputs ?? definition?.inputs ?? {};
  return (definition?.steps ?? []).map((step) => ({
    id: step.key,
    title: step.title ?? step.key,
    status: "QUEUE",
    priority: step.priority ?? null,
    provider: step.provider ?? definition?.provider ?? null,
    agentId: null,
    workflowId: null,
    dependsOn: [...(step.dependsOn ?? [])],
    contract: validateContract(step.contract ?? {}),
    branchCondition: step.branchCondition ?? null,
    repairOf: null,
    reviewer: null,
    idempotencyKey: null,
    review: {},
    context: { inputs: values },
    updatedAt: null,
  }));
}

/** Every dependency, flattened. `from` must finish before `to` may start. */
export function definitionEdges(definition) {
  const edges = [];
  for (const step of definition?.steps ?? [])
    for (const dep of step.dependsOn ?? [])
      edges.push({ from: dep, to: step.key });
  return edges;
}

function addStep(next, edit) {
  const steps = stepsOf(next);
  const input = edit.step;
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new InputError("add-step needs a step object");
  const key = String(input.key ?? "").trim();
  if (!STEP_KEY_PATTERN.test(key))
    throw new InputError(
      `Step key "${key}" must be lower-case letters, digits and hyphens, starting with a letter or digit (up to 61 characters)`,
    );
  if (steps.some((step) => step.key === key))
    throw new InputError(`A step with the key "${key}" already exists`);
  const roles = roleKeys(next);
  const role = String(input.role ?? "").trim();
  if (roles.length && !roles.includes(role))
    throw new InputError(
      `Step role "${role}" is unknown. This workflow defines: ${roles.join(", ")}`,
    );
  const dependsOn = [...new Set(input.dependsOn ?? [])].map(String);
  for (const dep of dependsOn) {
    if (dep === key)
      throw new InputError(`Step "${key}" cannot depend on itself`);
    if (!steps.some((step) => step.key === dep))
      throw new InputError(`Step "${key}" depends on unknown step "${dep}"`);
  }
  const acceptance = input.acceptance?.length
    ? [...input.acceptance]
    : [...DEFAULT_ACCEPTANCE];
  steps.push({
    key,
    title: requireText(input.title, "title"),
    role,
    instructions: requireText(input.instructions, "instructions"),
    deliverable: requireText(input.deliverable, "deliverable"),
    acceptance,
    contract: normalizeContract({
      ...(input.contract ?? {}),
      completionCriteria: input.contract?.completionCriteria ?? acceptance,
    }),
    dependsOn,
    branchCondition: input.branchCondition ?? null,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.priority ? { priority: input.priority } : {}),
  });
  return next;
}

function removeStep(next, edit) {
  const steps = stepsOf(next);
  const key = String(edit.key ?? "");
  const index = steps.findIndex((step) => step.key === key);
  if (index < 0)
    throw new InputError(`Step "${key}" is not in this workflow`, 404);
  const dependents = steps
    .filter((step) => (step.dependsOn ?? []).includes(key))
    .map((step) => step.key);
  if (dependents.length && edit.cascade !== true)
    throw new InputError(
      `"${key}" cannot be removed while ${dependents.join(", ")} depend${dependents.length === 1 ? "s" : ""} on it. Remove those links first, or confirm the cascade to drop them.`,
    );
  steps.splice(index, 1);
  for (const step of steps)
    if ((step.dependsOn ?? []).includes(key))
      step.dependsOn = step.dependsOn.filter((dep) => dep !== key);
  return next;
}

function updateStep(next, edit) {
  const steps = stepsOf(next);
  const key = String(edit.key ?? "");
  const step = steps.find((entry) => entry.key === key);
  if (!step) throw new InputError(`Step "${key}" is not in this workflow`, 404);
  const patch = edit.patch;
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    throw new InputError("update-step needs a patch object");
  if (patch.role !== undefined) {
    const roles = roleKeys(next);
    if (roles.length && !roles.includes(patch.role))
      throw new InputError(
        `Step role "${patch.role}" is unknown. This workflow defines: ${roles.join(", ")}`,
      );
    step.role = patch.role;
  }
  for (const field of PATCHABLE_STEP_FIELDS) {
    if (patch[field] === undefined) continue;
    if (["title", "instructions", "deliverable"].includes(field))
      step[field] = requireText(patch[field], field);
    else if (field === "contract")
      step.contract = normalizeContract(patch.contract);
    else step[field] = patch[field];
  }
  return next;
}

function edgeEnds(next, edit) {
  const steps = stepsOf(next);
  const from = String(edit.from ?? "");
  const to = String(edit.to ?? "");
  if (from === to)
    throw new InputError(`Step "${from}" cannot depend on itself`);
  for (const key of [from, to])
    if (!steps.some((step) => step.key === key))
      throw new InputError(`Step "${key}" is not in this workflow`, 404);
  return { steps, from, to, target: steps.find((step) => step.key === to) };
}

function addEdge(next, edit) {
  const { from, target } = edgeEnds(next, edit);
  target.dependsOn = [...(target.dependsOn ?? [])];
  if (target.dependsOn.includes(from))
    throw new InputError(`"${target.key}" already waits for "${from}"`);
  target.dependsOn.push(from);
  return next;
}

function removeEdge(next, edit) {
  const { from, target } = edgeEnds(next, edit);
  const dependsOn = [...(target.dependsOn ?? [])];
  if (!dependsOn.includes(from))
    throw new InputError(`"${target.key}" does not wait for "${from}"`, 404);
  target.dependsOn = dependsOn.filter((dep) => dep !== from);
  return next;
}

const HANDLERS = {
  "add-step": addStep,
  "remove-step": removeStep,
  "update-step": updateStep,
  "add-edge": addEdge,
  "remove-edge": removeEdge,
};

/**
 * Applies one structural edit and returns a new definition.
 *
 * Structural legality only: a cycle, an unreachable step or a permission
 * conflict is reported by `checkGraph`, which judges a draft and a live graph
 * with the same code. This function never decides whether a graph is sound,
 * only whether the edit itself is expressible.
 */
export function applyEdit(definition, edit) {
  if (!edit || typeof edit !== "object" || Array.isArray(edit))
    throw new InputError("An edit must be an object");
  const handler = HANDLERS[edit.op];
  if (!handler)
    throw new InputError(
      `Unknown edit "${edit.op}". Supported: ${EDIT_OPS.join(", ")}`,
    );
  return handler(structuredClone(definition), edit);
}

/** Applies edits in order. The first refusal throws and nothing is kept. */
export function applyEdits(definition, edits = []) {
  if (!Array.isArray(edits)) throw new InputError("edits must be an array");
  return edits.reduce(
    (next, edit) => applyEdit(next, edit),
    structuredClone(definition),
  );
}

/**
 * What a reviewer would see in the diff between two definitions.
 * → { addedSteps, removedSteps, changedSteps, addedEdges, removedEdges }
 */
export function diffDefinitions(before, after) {
  const beforeSteps = new Map(
    (before?.steps ?? []).map((step) => [step.key, step]),
  );
  const afterSteps = new Map(
    (after?.steps ?? []).map((step) => [step.key, step]),
  );
  const edgeId = (edge) => `${edge.from}->${edge.to}`;
  const beforeEdges = new Map(
    definitionEdges(before).map((edge) => [edgeId(edge), edge]),
  );
  const afterEdges = new Map(
    definitionEdges(after).map((edge) => [edgeId(edge), edge]),
  );
  // Dependencies are reported as edges, so a changed link is not also counted
  // as a changed step: a reviewer would see the same change twice.
  const withoutDeps = (step) => {
    const rest = { ...step };
    delete rest.dependsOn;
    return rest;
  };
  const changedSteps = [];
  for (const [key, step] of afterSteps) {
    const previous = beforeSteps.get(key);
    if (!previous) continue;
    if (
      JSON.stringify(withoutDeps(previous)) !==
      JSON.stringify(withoutDeps(step))
    )
      changedSteps.push(key);
  }
  return {
    addedSteps: [...afterSteps.keys()].filter((key) => !beforeSteps.has(key)),
    removedSteps: [...beforeSteps.keys()].filter((key) => !afterSteps.has(key)),
    changedSteps,
    addedEdges: [...afterEdges.values()].filter(
      (edge) => !beforeEdges.has(edgeId(edge)),
    ),
    removedEdges: [...beforeEdges.values()].filter(
      (edge) => !afterEdges.has(edgeId(edge)),
    ),
  };
}
