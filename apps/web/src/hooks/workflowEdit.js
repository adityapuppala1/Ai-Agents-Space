/**
 * Draft edits to a workflow definition, in the browser.
 *
 * These are local array edits for instant feedback while someone drags a
 * graph around. They deliberately do NOT judge the result: cycles,
 * unreachable steps, missing inputs and permission conflicts are decided by
 * the server (`POST /api/workflows/:id/validate-draft`, and again on save), so
 * there is exactly one copy of those four checks in the product.
 *
 * Every function returns a new definition and never mutates its input, so a
 * view can keep the loaded definition as the baseline for "unsaved changes".
 * DOM-free on purpose so `node --test` can cover them.
 */

/** The one acceptance criterion that needs no arguments; see contracts.js. */
export const BLANK_ACCEPTANCE = "final-message-non-empty";

/** Matches the shipped template packs, which the save path validates against. */
export const DEFAULT_TIMEOUT_MS = 900000;

function clone(definition) {
  return structuredClone(definition ?? {});
}

function stepsOf(definition) {
  return Array.isArray(definition?.steps) ? definition.steps : [];
}

/** Every dependency as an edge. `from` must finish before `to` may start. */
export function draftEdges(definition) {
  const edges = [];
  for (const step of stepsOf(definition))
    for (const dep of step.dependsOn ?? [])
      edges.push({ from: dep, to: step.key });
  return edges;
}

/** True when `to` already waits for `from`. */
export function hasEdge(definition, from, to) {
  const step = stepsOf(definition).find((entry) => entry.key === to);
  return Boolean(step && (step.dependsOn ?? []).includes(from));
}

/** A step skeleton the save path accepts once the text fields are filled in. */
export function blankStep(roles = []) {
  return {
    key: "",
    title: "",
    role: roles[0]?.key ?? "",
    instructions: "",
    deliverable: "",
    acceptance: [BLANK_ACCEPTANCE],
    dependsOn: [],
    branchCondition: null,
    contract: {
      inputs: [],
      outputSchema: null,
      completionCriteria: [BLANK_ACCEPTANCE],
      timeoutMs: DEFAULT_TIMEOUT_MS,
      allowedTools: [],
      budget: { maxTokens: null, maxRuns: null },
      reviewer: null,
    },
  };
}

/** Appends a step. A duplicate or empty key is left to the server to refuse. */
export function addStepDraft(definition, step) {
  const next = clone(definition);
  next.steps = [...stepsOf(next), structuredClone(step)];
  return next;
}

/**
 * Removes a step. Without `cascade` a step other steps depend on is left
 * alone, so the caller can ask before dropping those links.
 */
export function removeStepDraft(definition, key, { cascade = false } = {}) {
  const dependents = stepsOf(definition)
    .filter((step) => (step.dependsOn ?? []).includes(key))
    .map((step) => step.key);
  if (dependents.length && !cascade) return clone(definition);
  const next = clone(definition);
  next.steps = stepsOf(next)
    .filter((step) => step.key !== key)
    .map((step) => ({
      ...step,
      dependsOn: (step.dependsOn ?? []).filter((dep) => dep !== key),
    }));
  return next;
}

/** Merges fields into one step. */
export function updateStepDraft(definition, key, patch = {}) {
  const next = clone(definition);
  next.steps = stepsOf(next).map((step) =>
    step.key === key ? { ...step, ...patch } : step,
  );
  return next;
}

/** Makes `to` wait for `from`. A self edge or a duplicate changes nothing. */
export function addEdgeDraft(definition, from, to) {
  const next = clone(definition);
  if (!from || !to || from === to) return next;
  next.steps = stepsOf(next).map((step) =>
    step.key === to && !(step.dependsOn ?? []).includes(from)
      ? { ...step, dependsOn: [...(step.dependsOn ?? []), from] }
      : step,
  );
  return next;
}

/** Drops the dependency of `to` on `from`. */
export function removeEdgeDraft(definition, from, to) {
  const next = clone(definition);
  next.steps = stepsOf(next).map((step) =>
    step.key === to
      ? { ...step, dependsOn: (step.dependsOn ?? []).filter((d) => d !== from) }
      : step,
  );
  return next;
}

/**
 * What a reviewer would see in the diff, for the "N unsaved changes" chip.
 * → { added, removed, changed, edgesAdded, edgesRemoved, changes }
 */
export function summarizeDraft(before, after) {
  const beforeKeys = stepsOf(before).map((step) => step.key);
  const afterKeys = stepsOf(after).map((step) => step.key);
  const edgeId = (edge) => `${edge.from}->${edge.to}`;
  const beforeEdges = new Set(draftEdges(before).map(edgeId));
  const afterEdges = new Set(draftEdges(after).map(edgeId));
  const beforeByKey = new Map(stepsOf(before).map((step) => [step.key, step]));
  // Links are counted as edges, so a step whose only change is a link is not
  // counted twice.
  const withoutDeps = (step) => {
    const rest = { ...step };
    delete rest.dependsOn;
    return JSON.stringify(rest);
  };
  const changed = stepsOf(after)
    .filter((step) => beforeByKey.has(step.key))
    .filter(
      (step) => withoutDeps(beforeByKey.get(step.key)) !== withoutDeps(step),
    )
    .map((step) => step.key);
  const added = afterKeys.filter((key) => !beforeKeys.includes(key));
  const removed = beforeKeys.filter((key) => !afterKeys.includes(key));
  const edgesAdded = [...afterEdges].filter((id) => !beforeEdges.has(id));
  const edgesRemoved = [...beforeEdges].filter((id) => !afterEdges.has(id));
  return {
    added,
    removed,
    changed,
    edgesAdded: edgesAdded.length,
    edgesRemoved: edgesRemoved.length,
    changes:
      added.length +
      removed.length +
      changed.length +
      edgesAdded.length +
      edgesRemoved.length,
  };
}
