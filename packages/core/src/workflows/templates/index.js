import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { InputError } from "../../TaskStore.js";
import { ACTIVITIES, PROVIDERS } from "../../contracts.js";
import { parseCriterion, CRITERIA_HELP } from "../contracts.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Order matches PRODUCT_ROADMAP.md section 14. */
export const TEMPLATE_ORDER = [
  "feature-delivery",
  "bug-clinic",
  "repository-onboarding",
  "release-room",
  "devops-incident-room",
  "data-engineering",
  "data-analytics",
  "research-desk",
  "documentation-studio",
  "design-review",
  "security-review",
  "agency-delivery",
  "marketing-operations",
];

/**
 * The tool vocabulary a template may require. These are Agent Space names for
 * capabilities, mapped to the tool names the providers actually report (see
 * docs/ARCHITECTURE.md section 3, captured from the vendors' own streams).
 * A template that names a tool outside this list fails validation, because
 * nothing in the product could then say which provider tool it means.
 *
 * `viaShell: true` marks a capability no provider exposes as its own tool: it
 * is performed through the shell tool, so the workspace policy governs it as
 * a command, not as a dedicated integration.
 */
export const TOOL_VOCABULARY = Object.freeze({
  "file.read": {
    description: "Read a file in scope",
    providerTools: {
      "claude-code": ["Read"],
      codex: ["exec_command"],
      copilot: ["view"],
    },
  },
  "file.edit": {
    description: "Create or edit a file in scope",
    providerTools: {
      "claude-code": ["Edit", "Write", "MultiEdit", "NotebookEdit"],
      codex: ["apply_patch"],
      copilot: ["edit", "create"],
    },
  },
  search: {
    description: "Search files by name or content",
    providerTools: {
      "claude-code": ["Glob", "Grep"],
      codex: ["exec_command"],
      copilot: ["grep", "glob"],
    },
  },
  shell: {
    description: "Run a command; every command is policy-checked",
    providerTools: {
      "claude-code": ["Bash", "PowerShell"],
      codex: ["exec_command", "exec"],
      copilot: ["bash", "powershell"],
    },
  },
  "shell.test": {
    description: "Run the project test command (classified as TESTING)",
    providerTools: {
      "claude-code": ["Bash"],
      codex: ["exec_command"],
      copilot: ["bash"],
    },
    viaShell: true,
  },
  "shell.build": {
    description: "Run the project build or lint command",
    providerTools: {
      "claude-code": ["Bash"],
      codex: ["exec_command"],
      copilot: ["bash"],
    },
    viaShell: true,
  },
  "git.diff": {
    description: "Read the working-tree diff (also captured as a run artifact)",
    providerTools: {
      "claude-code": ["Bash"],
      codex: ["exec_command"],
      copilot: ["bash"],
    },
    viaShell: true,
  },
  "git.log": {
    description: "Read commit history",
    providerTools: {
      "claude-code": ["Bash"],
      codex: ["exec_command"],
      copilot: ["bash"],
    },
    viaShell: true,
  },
  "web.fetch": {
    description: "Fetch a URL",
    providerTools: {
      "claude-code": ["WebFetch"],
      codex: ["web_search"],
      copilot: ["web_fetch"],
    },
  },
  "web.search": {
    description: "Search the web",
    providerTools: {
      "claude-code": ["WebSearch"],
      codex: ["web_search"],
      copilot: ["web_fetch"],
    },
  },
  "sql.read": {
    description:
      "Run a read-only query. No provider exposes a SQL tool and Agent Space has no SQL connector: this runs through the shell tool against a client the repository already has.",
    providerTools: {},
    viaShell: true,
  },
  approval: {
    description:
      "Ask a human for a decision. Not a provider tool: Agent Space raises the approval (Claude Code hook bridge or Codex app-server request) and records the answer.",
    providerTools: {},
  },
  delegate: {
    description: "Start a subagent; recorded as a delegation event",
    providerTools: { "claude-code": ["Task", "Agent"] },
  },
});

export const TOOL_NAMES = Object.freeze(Object.keys(TOOL_VOCABULARY));

/**
 * Connectors a template may declare as required. `status` is the honest state
 * in THIS build: `available` means the code exists and is exercised by tests;
 * `not-implemented` means the pack declares a dependency that Agent Space
 * cannot satisfy yet, and the pack's rubric must say what it does instead.
 */
export const CONNECTOR_VOCABULARY = Object.freeze({
  "local-filesystem": {
    status: "available",
    detail:
      "Scoped reads and writes inside the workspace root, worktree, and allowed folders",
  },
  git: {
    status: "available",
    detail:
      "Diff, status, log, and worktree isolation (core/runs/artifacts.js, worktree.js)",
  },
  web: {
    status: "available",
    detail:
      "Only through the provider's own web tool, and only when the policy allows network",
  },
  "sql-database": {
    status: "not-implemented",
    detail: "No SQL connector; queries run through the shell tool",
  },
  "ci-cd": {
    status: "not-implemented",
    detail:
      "No build or deployment system is read; statuses come from local commands",
  },
  "issue-tracker": {
    status: "not-implemented",
    detail: "No GitHub/GitLab/issue connector",
  },
  "object-storage": {
    status: "not-implemented",
    detail: "No object storage connector",
  },
  "document-store": {
    status: "not-implemented",
    detail: "No document store connector",
  },
  "design-files": {
    status: "not-implemented",
    detail: "No design tool connector; reviews read source files",
  },
  notifications: {
    status: "not-implemented",
    detail: "Agent Space sends nothing",
  },
});

export const CONNECTOR_NAMES = Object.freeze(Object.keys(CONNECTOR_VOCABULARY));

/** Priorities from the roadmap section 14 table. */
export const PRIORITIES = Object.freeze(["Launch", "Growth", "Explore"]);

/** Visual environments a workflow pack may recommend to the client. */
export const RECOMMENDED_ENVIRONMENTS = Object.freeze([
  "studio",
  "operations",
  "garden",
  "midnight",
  "sandstone",
  "data-lab",
  "research-library",
  "creative-studio",
]);

/** Branch conditions a template step may carry (mirrors TaskGraph.BRANCH_WHEN). */
const BRANCH_WHEN = [
  "previous.status",
  "previous.review",
  "artifact.exists",
  "contract.failed",
];

let cache = null;

function load() {
  if (cache) return cache;
  const templates = new Map();
  for (const file of readdirSync(here)) {
    if (!file.endsWith(".json")) continue;
    const template = JSON.parse(readFileSync(join(here, file), "utf8"));
    validateTemplate(template);
    templates.set(template.id, template);
  }
  cache = templates;
  return templates;
}

function fail(id, message) {
  throw new Error(`Template ${id}: ${message}`);
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requireStringArray(id, value, field) {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || !entry.trim())
  )
    fail(id, `${field} must be an array of non-empty strings`);
}

/**
 * Every acceptance criterion must be a fact Agent Space recorded: an artifact
 * exists, a command exited 0, a file changed, a schema validates. Subjective
 * text ("the plan is good") is refused here, not softened. The vocabulary is
 * the one `workflows/contracts.js` can actually check.
 */
function assertObjective(id, where, list) {
  if (!Array.isArray(list) || list.length === 0)
    fail(
      id,
      `${where} must be a non-empty array of objective criteria (${CRITERIA_HELP})`,
    );
  for (const entry of list) {
    if (typeof entry !== "string" || !parseCriterion(entry))
      fail(
        id,
        `${where} criterion ${JSON.stringify(entry)} is not objective. Agent Space only checks facts it recorded. Use one of: ${CRITERIA_HELP}`,
      );
  }
}

function assertAcyclic(id, steps) {
  const byKey = new Map(steps.map((step) => [step.key, step]));
  const state = new Map();
  const visit = (step, trail) => {
    const seen = state.get(step.key);
    if (seen === "done") return;
    if (seen === "visiting")
      fail(id, `steps form a cycle: ${[...trail, step.key].join(" -> ")}`);
    state.set(step.key, "visiting");
    for (const dep of step.dependsOn ?? [])
      visit(byKey.get(dep), [...trail, step.key]);
    state.set(step.key, "done");
  };
  for (const step of steps) visit(step, []);
}

function validateContractShape(id, step, template) {
  const contract = step.contract;
  if (!isPlainObject(contract))
    fail(id, `step ${step.key} needs a contract object`);
  for (const field of [
    "inputs",
    "outputSchema",
    "completionCriteria",
    "timeoutMs",
    "allowedTools",
    "budget",
    "reviewer",
  ])
    if (!(field in contract))
      fail(id, `step ${step.key} contract is missing ${field}`);
  if (!Array.isArray(contract.inputs))
    fail(id, `step ${step.key} contract.inputs must be an array`);
  for (const input of contract.inputs) {
    if (
      !isPlainObject(input) ||
      typeof input.key !== "string" ||
      !input.key.trim()
    )
      fail(id, `step ${step.key} contract.inputs entries need a key`);
    if (typeof input.type !== "string")
      fail(id, `step ${step.key} contract input ${input.key} needs a type`);
    if (typeof input.required !== "boolean")
      fail(
        id,
        `step ${step.key} contract input ${input.key} needs required:true|false`,
      );
  }
  assertObjective(
    id,
    `step ${step.key} contract.completionCriteria`,
    contract.completionCriteria,
  );
  if (contract.outputSchema !== null && !isPlainObject(contract.outputSchema))
    fail(
      id,
      `step ${step.key} contract.outputSchema must be an object or null`,
    );
  if (!Number.isInteger(contract.timeoutMs) || contract.timeoutMs < 1000)
    fail(id, `step ${step.key} contract.timeoutMs must be an integer >= 1000`);
  requireStringArray(
    id,
    contract.allowedTools,
    `step ${step.key} contract.allowedTools`,
  );
  for (const tool of contract.allowedTools)
    if (!template.requiredTools.includes(tool))
      fail(
        id,
        `step ${step.key} allows ${tool}, which is not in requiredTools`,
      );
  if (!isPlainObject(contract.budget))
    fail(id, `step ${step.key} contract.budget must be an object`);
  if (contract.reviewer !== null && typeof contract.reviewer !== "string")
    fail(id, `step ${step.key} contract.reviewer must be a string or null`);
}

/**
 * Throws when a template does not meet the domain-pack contract of roadmap
 * section 14: a scoped workflow, role definitions, tool requirements, sample
 * inputs, an output schema, an acceptance rubric, and the required result.
 *
 * Structural checks (ids, step keys, roles, dependencies, cycles) run first so
 * a partially written template still reports the specific structural problem.
 */
export function validateTemplate(template) {
  if (!template?.id || !Array.isArray(template.steps))
    throw new Error(`Template ${template?.id ?? "?"} is missing id or steps`);
  const id = template.id;
  const roles = new Set((template.roles ?? []).map((role) => role.key));
  const keys = new Set();
  for (const step of template.steps) {
    if (!step.key || keys.has(step.key))
      fail(id, `duplicate step key ${step.key}`);
    keys.add(step.key);
    if (step.role && !roles.has(step.role))
      fail(id, `step ${step.key} uses unknown role ${step.role}`);
  }
  for (const step of template.steps)
    for (const dep of step.dependsOn ?? [])
      if (!keys.has(dep))
        fail(id, `step ${step.key} depends on unknown ${dep}`);
  assertAcyclic(id, template.steps);

  /* ------------------------------ full shape ----------------------------- */
  for (const field of [
    "name",
    "domain",
    "priority",
    "description",
    "requiredResult",
    "roles",
    "steps",
    "outputSchema",
    "rubric",
    "requiredTools",
    "requiredConnectors",
    "sampleInputs",
    "notes",
  ])
    if (template[field] === undefined) fail(id, `missing ${field}`);
  if (!PRIORITIES.includes(template.priority))
    fail(id, `priority must be one of ${PRIORITIES.join(", ")}`);
  if (
    template.recommendedEnvironment !== undefined &&
    !RECOMMENDED_ENVIRONMENTS.includes(template.recommendedEnvironment)
  )
    fail(
      id,
      `recommendedEnvironment must be one of ${RECOMMENDED_ENVIRONMENTS.join(", ")}`,
    );
  if (
    typeof template.requiredResult !== "string" ||
    !template.requiredResult.trim()
  )
    fail(
      id,
      "requiredResult must name the concrete result from the roadmap table",
    );
  if (!isPlainObject(template.outputSchema))
    fail(id, "outputSchema must be an object");
  if (!isPlainObject(template.sampleInputs))
    fail(id, "sampleInputs must be an object");

  requireStringArray(id, template.requiredTools, "requiredTools");
  for (const tool of template.requiredTools)
    if (!TOOL_NAMES.includes(tool))
      fail(
        id,
        `requiredTools names ${tool}, which is not in the tool vocabulary (${TOOL_NAMES.join(", ")})`,
      );
  requireStringArray(id, template.requiredConnectors, "requiredConnectors");
  for (const connector of template.requiredConnectors)
    if (!CONNECTOR_NAMES.includes(connector))
      fail(
        id,
        `requiredConnectors names ${connector}, which is not in the connector vocabulary`,
      );

  if (!Array.isArray(template.roles) || template.roles.length === 0)
    fail(id, "roles must be a non-empty array");
  for (const role of template.roles) {
    if (!isPlainObject(role) || !role.key) fail(id, "every role needs a key");
    if (typeof role.name !== "string" || !role.name.trim())
      fail(id, `role ${role.key} needs a name`);
    if (!ACTIVITIES.includes(role.workingState))
      fail(
        id,
        `role ${role.key} workingState must be one of ${ACTIVITIES.join(", ")}`,
      );
    if (role.provider !== null && !PROVIDERS[role.provider])
      fail(
        id,
        `role ${role.key} provider must be null (any ready connection) or a known provider id`,
      );
    requireStringArray(id, role.skills, `role ${role.key} skills`);
  }

  if (!Array.isArray(template.rubric) || template.rubric.length === 0)
    fail(id, "rubric must be a non-empty array");
  for (const entry of template.rubric) {
    if (!isPlainObject(entry)) fail(id, "rubric entries must be objects");
    for (const field of ["criterion", "howMeasured", "failsWhen"])
      if (typeof entry[field] !== "string" || !entry[field].trim())
        fail(id, `rubric entry needs ${field}`);
  }

  const usedRoles = new Set();
  for (const step of template.steps) {
    for (const field of ["title", "role", "instructions", "deliverable"])
      if (typeof step[field] !== "string" || !step[field].trim())
        fail(id, `step ${step.key} needs ${field}`);
    usedRoles.add(step.role);
    if (!Array.isArray(step.dependsOn))
      fail(id, `step ${step.key} needs a dependsOn array`);
    assertObjective(id, `step ${step.key} acceptance`, step.acceptance);
    validateContractShape(id, step, template);
    if (step.branchCondition !== null && step.branchCondition !== undefined) {
      const branch = step.branchCondition;
      if (!isPlainObject(branch) || !BRANCH_WHEN.includes(branch.when))
        fail(
          id,
          `step ${step.key} branchCondition.when must be one of ${BRANCH_WHEN.join(", ")}`,
        );
      if (branch.equals === undefined)
        fail(id, `step ${step.key} branchCondition needs equals`);
      if (!["run", "skip"].includes(branch.then ?? "run"))
        fail(id, `step ${step.key} branchCondition.then must be run or skip`);
    }
  }
  for (const role of roles)
    if (!usedRoles.has(role))
      fail(id, `role ${role} is defined but no step uses it`);

  return true;
}

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

/**
 * The input keys a template's steps use (`{{client}}` → "client"), sorted.
 * A template instantiated without one of them would create tasks whose
 * titles and briefs still read "{{client}}".
 */
export function templateInputKeys(template) {
  const keys = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object")
      Object.values(value).forEach(visit);
    else if (typeof value === "string")
      for (const match of value.matchAll(PLACEHOLDER)) keys.add(match[1]);
  };
  visit(template?.steps ?? []);
  return [...keys].sort();
}

const withInputKeys = (template) => ({
  ...structuredClone(template),
  inputKeys: templateInputKeys(template),
});

export function listTemplates() {
  const templates = load();
  const ordered = TEMPLATE_ORDER.filter((id) => templates.has(id)).map((id) =>
    templates.get(id),
  );
  for (const [id, template] of templates)
    if (!TEMPLATE_ORDER.includes(id)) ordered.push(template);
  return ordered.map(withInputKeys);
}

export function getTemplate(id) {
  const template = load().get(String(id));
  if (!template) throw new InputError(`Template ${id} not found`, 404);
  return withInputKeys(template);
}

/**
 * Replaces {{key}} placeholders with input values; unknown keys stay as-is.
 * An array (an acceptance list) is rendered as one line per entry so a task
 * brief reads as a checklist rather than a joined string.
 */
export function interpolate(text, inputs = {}) {
  if (Array.isArray(text))
    return text.map((entry) => interpolate(entry, inputs)).join("\n- ");
  return String(text ?? "").replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key) =>
    inputs[key] === undefined || inputs[key] === null
      ? match
      : String(inputs[key]),
  );
}
