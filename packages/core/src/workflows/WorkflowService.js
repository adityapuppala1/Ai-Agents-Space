import { randomUUID, createHash } from "node:crypto";
import { InputError } from "../TaskStore.js";
import { PROVIDERS } from "../contracts.js";
import { WORKING_STATES } from "../AgentProfiles.js";
import { transaction } from "../db.js";
import { TaskGraph, validateBranchCondition } from "./TaskGraph.js";
import { validateContract, contractIsEmpty } from "./contracts.js";
import {
  getTemplate,
  listTemplates,
  interpolate,
  templateInputKeys,
  validateTemplate,
} from "./templates/index.js";
import { stepsToNodes, definitionEdges, diffDefinitions } from "./editor.js";

/** The on-disk/Git format version of an exported workflow document. */
export const WORKFLOW_FORMAT_VERSION = 1;

/** Triggers a workflow definition may permit. */
export const TRIGGERS = ["manual", "dependency", "webhook", "schedule"];

/** JSON with object keys in a stable order, so a hash is reproducible. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** Stable sha256 of a workflow definition, for Git review and diffing. */
export function definitionHash(definition) {
  return createHash("sha256")
    .update(canonicalJson(definition ?? {}))
    .digest("hex");
}

/** Validates the quota/trigger block a workflow definition may carry. */
export function validateDefinition(definition) {
  if (
    !definition ||
    typeof definition !== "object" ||
    Array.isArray(definition)
  )
    throw new InputError("definition must be an object");
  const out = { ...definition };
  if (definition.quotas !== undefined && definition.quotas !== null) {
    const quotas = definition.quotas;
    if (typeof quotas !== "object" || Array.isArray(quotas))
      throw new InputError("definition.quotas must be an object");
    const int = (value, field) => {
      if (value === undefined || value === null) return null;
      if (!Number.isInteger(value) || value < 1)
        throw new InputError(
          `definition.quotas.${field} must be an integer >= 1`,
        );
      return value;
    };
    out.quotas = {
      maxRuns: int(quotas.maxRuns, "maxRuns"),
      maxConcurrentRuns: int(quotas.maxConcurrentRuns, "maxConcurrentRuns"),
    };
  }
  if (definition.triggers !== undefined && definition.triggers !== null) {
    if (!Array.isArray(definition.triggers))
      throw new InputError("definition.triggers must be an array");
    const unknown = definition.triggers.filter((t) => !TRIGGERS.includes(t));
    if (unknown.length)
      throw new InputError(
        `Unknown trigger(s) ${unknown.join(", ")}. Supported: ${TRIGGERS.join(", ")}`,
      );
    out.triggers = [...new Set(definition.triggers)];
  }
  return out;
}

const PRIORITY_BY_TEMPLATE = {
  Launch: "high",
  Growth: "medium",
  Explore: "low",
};
const TASK_PRIORITIES = ["critical", "high", "medium", "low"];

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function rowToWorkflow(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    templateId: row.template_id ?? null,
    status: row.status,
    definition: parseJson(row.definition, {}),
    version: row.version ?? 1,
    definitionHash: row.definition_hash ?? null,
    publishedAt: row.published_at ?? null,
    owner: row.owner ?? "agent-space",
    externalId: row.external_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskRow(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    priority: row.priority,
    status: row.status,
    progress: row.progress,
    provider: row.provider ?? null,
    assignedAgentId: row.assigned_agent_id ?? null,
    deliverable: row.deliverable ?? "",
    dependsOn: parseJson(row.depends_on, []),
    templateId: row.template_id ?? null,
    workflowId: row.workflow_id ?? null,
    stepKey: parseJson(row.context, {}).stepKey ?? null,
    review: parseJson(row.review, {}),
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
  };
}

/** Topological order of template steps (dependencies first). */
export function orderSteps(steps) {
  const byKey = new Map(steps.map((step) => [step.key, step]));
  const done = new Set();
  const visiting = new Set();
  const ordered = [];
  const visit = (step) => {
    if (done.has(step.key)) return;
    if (visiting.has(step.key))
      throw new InputError(`Template steps form a cycle at ${step.key}`, 400);
    visiting.add(step.key);
    for (const dep of step.dependsOn ?? []) {
      const target = byKey.get(dep);
      if (!target) throw new InputError(`Unknown step dependency ${dep}`, 400);
      visit(target);
    }
    visiting.delete(step.key);
    done.add(step.key);
    ordered.push(step);
  };
  for (const step of steps) visit(step);
  return ordered;
}

/**
 * Instantiates templates into workflow rows plus dependent tasks.
 *
 * Constructor: `new WorkflowService(services, { graph })` — `graph` is a
 * TaskGraph; one is created when omitted.
 */
export class WorkflowService {
  constructor(services, { graph } = {}) {
    this.services = services;
    this.db = services.db;
    this.hub = services.hub;
    this.graph = graph ?? new TaskGraph(services);
  }

  templates() {
    return listTemplates();
  }

  template(id) {
    return getTemplate(id);
  }

  instantiate(
    workspaceId,
    templateId,
    {
      inputs = {},
      provider = null,
      agentByRole = {},
      providerByRole = {},
      contracts = {},
      actor = "local-user",
    } = {},
  ) {
    const workspace = this.hub.get(workspaceId);
    const template = getTemplate(templateId);
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs))
      throw new InputError("inputs must be an object");
    // A missing input would leave "{{key}}" in task titles and briefs; refuse
    // before anything is written rather than create tasks nobody can read.
    const missing = (template.inputKeys ?? templateInputKeys(template)).filter(
      (key) =>
        inputs[key] === undefined ||
        inputs[key] === null ||
        String(inputs[key]).trim() === "",
    );
    if (missing.length)
      throw new InputError(
        `"${template.name}" needs a value for: ${missing.join(", ")}. Nothing was created.`,
        400,
      );
    if (provider !== null && typeof provider !== "string")
      throw new InputError("provider must be a string");
    const agentIds = new Map();
    for (const [roleKey, agentId] of Object.entries(agentByRole ?? {})) {
      if (!agentId) continue;
      const agent = workspace.profiles.get(agentId, { includeArchived: false });
      agentIds.set(roleKey, agent.id);
    }
    const basePriority = PRIORITY_BY_TEMPLATE[template.priority] ?? "medium";
    const now = Date.now();
    const workflowId = randomUUID();
    const name = interpolate(
      inputs.name ??
        `${template.name}${inputs.feature ? `: ${inputs.feature}` : ""}`,
      inputs,
    ).slice(0, 120);

    return transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO workflows (id, workspace_id, name, template_id, status, definition, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(
          workflowId,
          workspaceId,
          name,
          template.id,
          JSON.stringify({ ...template, inputs, provider, agentByRole }),
          now,
          now,
        );
      const definition = validateDefinition({
        ...template,
        inputs,
        provider,
        agentByRole,
      });
      const hash = definitionHash(definition);
      this.db
        .prepare(
          "UPDATE workflows SET definition = ?, definition_hash = ?, version = 1, published_at = ? WHERE id = ?",
        )
        .run(JSON.stringify(definition), hash, now, workflowId);
      this.db
        .prepare(
          `INSERT INTO workflow_versions (id, workflow_id, version, definition, definition_hash, created_at, created_by, published_at)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          workflowId,
          JSON.stringify(definition),
          hash,
          now,
          actor,
          now,
        );
      const idByKey = new Map();
      const created = [];
      for (const step of orderSteps(template.steps)) {
        const title = interpolate(step.title, inputs).slice(0, 200);
        const description = [
          interpolate(step.instructions, inputs),
          step.deliverable
            ? `Deliverable: ${interpolate(step.deliverable, inputs)}`
            : "",
          step.acceptance
            ? `Acceptance: ${interpolate(step.acceptance, inputs)}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n")
          .slice(0, 2000);
        const priority = TASK_PRIORITIES.includes(step.priority)
          ? step.priority
          : basePriority;
        const task = workspace.store.create(
          { title, description, priority },
          "workflow",
        );
        const dependsOn = (step.dependsOn ?? []).map((key) => idByKey.get(key));
        const stepProvider =
          step.provider ?? providerByRole?.[step.role] ?? provider ?? null;
        const agentId = agentIds.get(step.role) ?? null;
        this.db
          .prepare(
            `UPDATE tasks SET depends_on = ?, deliverable = ?, provider = ?, template_id = ?, workflow_id = ?,
               context = ?, assigned_agent_id = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            JSON.stringify(dependsOn),
            interpolate(step.deliverable ?? "", inputs).slice(0, 500),
            stepProvider,
            template.id,
            workflowId,
            JSON.stringify({
              stepKey: step.key,
              role: step.role,
              requiresApproval: step.requiresApproval === true,
            }),
            agentId,
            now,
            task.id,
          );
        // Per-step task contract, gate, and reviewer (migration 6).
        const contract = validateContract({
          ...(step.contract ?? {}),
          ...(contracts[step.key] ?? {}),
          allowedTools:
            step.contract?.allowedTools ??
            contracts[step.key]?.allowedTools ??
            template.requiredTools ??
            [],
          outputSchema:
            step.contract?.outputSchema ??
            contracts[step.key]?.outputSchema ??
            null,
        });
        const branchCondition = validateBranchCondition(
          step.branchCondition ?? null,
        );
        this.db
          .prepare(
            "UPDATE tasks SET contract = ?, branch_condition = ?, reviewer = ? WHERE id = ?",
          )
          .run(
            contractIsEmpty(contract) ? "{}" : JSON.stringify(contract),
            branchCondition ? JSON.stringify(branchCondition) : null,
            contract.reviewer ?? null,
            task.id,
          );
        idByKey.set(step.key, task.id);
        created.push(task.id);
      }
      this.services.audit?.record?.({
        actor,
        action: "workflow.instantiate",
        target: workflowId,
        workspaceId,
        details: { templateId: template.id, tasks: created.length },
      });
      workspace.changed(
        `Workflow "${name}" created from ${template.name} (${created.length} tasks)`,
        "system",
      );
      return this.get(workflowId);
    });
  }

  /**
   * Deploys a team: staffs every role of a template, creates the workflow,
   * records who is on the team, and (with `start`) starts the steps that
   * wait on nothing. Later steps start as their inputs are handed over
   * (TaskGraph.onTaskCompleted records each handoff).
   *
   *   agentByRole     { roleKey: agentId } existing profiles
   *   providerByRole  { roleKey: provider } the assistant each role runs on
   *   createAgents    true: create a profile for each role left unstaffed;
   *                   a list of role keys: only for those roles (a profile
   *                   with the role's name is reused, never doubled)
   *   start           start the ready first steps now
   *
   * Returns { workflow, team: [{ roleKey, role, agentId, agentName, provider,
   * created }], started: [{ taskId, runId?, error? }] }.
   */
  async deploy(workspaceId, templateId, options = {}) {
    const {
      inputs = {},
      provider = null,
      agentByRole = {},
      providerByRole = {},
      createAgents = false,
      start = false,
      contracts = {},
      actor = "local-user",
    } = options;
    const workspace = this.hub.get(workspaceId);
    const template = getTemplate(templateId);
    const roles = Array.isArray(template.roles) ? template.roles : [];
    for (const [key, value] of Object.entries(providerByRole ?? {}))
      if (value !== null && value !== undefined && !PROVIDERS[value])
        throw new InputError(`Unknown provider "${value}" for role ${key}`);
    const staffed = { ...(agentByRole ?? {}) };
    const team = [];
    const palette = [
      "#7d8cc4",
      "#4f9d8a",
      "#c27c83",
      "#c29552",
      "#6f86b8",
      "#8a9d62",
      "#9b6fb3",
      "#4f9dc7",
    ];
    // Check every staffed profile before anything is written.
    for (const role of roles)
      if (staffed[role.key])
        workspace.profiles.get(staffed[role.key], { includeArchived: false });
    // true staffs every unstaffed role; a list of role keys only those.
    const wantsProfile = (role) =>
      createAgents === true ||
      (Array.isArray(createAgents) && createAgents.includes(role.key));
    roles.forEach((role, index) => {
      const roleProvider = providerByRole?.[role.key] ?? provider ?? null;
      let agentId = staffed[role.key] ?? null;
      let created = false;
      if (!agentId && wantsProfile(role)) {
        const existing = workspace.profiles
          .list()
          .find(
            (profile) =>
              String(profile.name).toLowerCase() ===
              String(role.name).toLowerCase(),
          );
        if (existing) agentId = existing.id;
        else {
          const agent = workspace.createAgent({
            name: String(role.name).slice(0, 40),
            role: String(role.name).slice(0, 60),
            color: palette[index % palette.length],
            workingState: WORKING_STATES.includes(role.workingState)
              ? role.workingState
              : "CODING",
            provider: roleProvider,
            skills: Array.isArray(role.skills) ? role.skills : [],
          });
          agentId = agent.id;
          created = true;
        }
        staffed[role.key] = agentId;
      }
      let agentName = null;
      try {
        agentName = agentId ? workspace.profiles.get(agentId).name : null;
      } catch {
        agentName = null;
      }
      team.push({
        roleKey: role.key,
        role: role.name,
        agentId,
        agentName,
        provider: roleProvider,
        created,
      });
    });
    const workflow = this.instantiate(workspaceId, templateId, {
      inputs,
      provider,
      agentByRole: staffed,
      providerByRole,
      contracts,
      actor,
    });
    const members = team.filter((member) => member.agentId);
    if (members.length)
      workspace.recordEvent({
        kind: "team",
        message: `Team assembled for “${workflow.name}”: ${members
          .map((member) => `${member.agentName} (${member.role})`)
          .join(", ")}`,
        data: {
          workflowId: workflow.id,
          members: members.map((member) => ({
            agentId: member.agentId,
            role: member.role,
          })),
        },
      });
    const started = [];
    if (start) {
      const tasks = this.#tasks(workflow.id);
      for (const task of tasks) {
        if ((task.dependsOn ?? []).length || !task.provider) continue;
        try {
          const run = await this.services.runWorker?.start?.({
            workspaceId,
            taskId: task.id,
            agentId: task.assignedAgentId ?? undefined,
            provider: task.provider,
            actor,
          });
          started.push({ taskId: task.id, runId: run?.id ?? null });
        } catch (error) {
          started.push({ taskId: task.id, error: error.message });
          workspace.changed(
            `Could not start “${task.title}”: ${error.message}`,
            "error",
            task.assignedAgentId ?? undefined,
          );
        }
      }
    }
    this.services.audit?.record?.({
      actor,
      action: "workflow.deploy",
      target: workflow.id,
      workspaceId,
      details: {
        templateId: template.id,
        team: team.map((member) => ({
          role: member.roleKey,
          agentId: member.agentId,
          provider: member.provider,
          created: member.created,
        })),
        started: started.length,
      },
    });
    return { workflow: this.get(workflow.id), team, started };
  }

  #tasks(workflowId) {
    return this.db
      .prepare(
        "SELECT * FROM tasks WHERE workflow_id = ? ORDER BY created_at, rowid",
      )
      .all(workflowId)
      .map(taskRow);
  }

  #progress(tasks) {
    const counts = {
      total: tasks.length,
      queued: 0,
      inProgress: 0,
      blocked: 0,
      completed: 0,
    };
    for (const task of tasks) {
      if (task.status === "QUEUE") counts.queued++;
      else if (task.status === "IN_PROGRESS") counts.inProgress++;
      else if (task.status === "BLOCKED") counts.blocked++;
      else if (task.status === "COMPLETED") counts.completed++;
    }
    counts.percent = counts.total
      ? Math.round((counts.completed / counts.total) * 100)
      : 0;
    return counts;
  }

  /** Recomputes status from task state; archived workflows keep their status. */
  #recompute(workflow, tasks) {
    if (workflow.status === "archived") return workflow.status;
    let status = "active";
    if (tasks.length && tasks.every((task) => task.status === "COMPLETED"))
      status = "completed";
    else if (
      tasks.some(
        (task) =>
          task.status === "BLOCKED" && task.review?.status === "rejected",
      )
    )
      status = "failed";
    if (status !== workflow.status) {
      this.db
        .prepare("UPDATE workflows SET status = ?, updated_at = ? WHERE id = ?")
        .run(status, Date.now(), workflow.id);
    }
    return status;
  }

  get(id) {
    const row = this.db.prepare("SELECT * FROM workflows WHERE id = ?").get(id);
    if (!row) throw new InputError("Workflow not found", 404);
    const workflow = rowToWorkflow(row);
    const tasks = this.#tasks(id);
    workflow.status = this.#recompute(workflow, tasks);
    workflow.tasks = tasks;
    workflow.progress = this.#progress(tasks);
    workflow.ready = this.graph
      .ready(workflow.workspaceId)
      .filter((node) => node.workflowId === id)
      .map((node) => node.id);
    return workflow;
  }

  list(workspaceId) {
    this.hub.get(workspaceId);
    return this.db
      .prepare(
        "SELECT * FROM workflows WHERE workspace_id = ? ORDER BY created_at DESC",
      )
      .all(workspaceId)
      .map((row) => {
        const workflow = rowToWorkflow(row);
        const tasks = this.#tasks(workflow.id);
        workflow.status = this.#recompute(workflow, tasks);
        workflow.progress = this.#progress(tasks);
        delete workflow.definition;
        return workflow;
      });
  }

  archive(id, { actor = "local-user" } = {}) {
    const workflow = this.get(id);
    this.db
      .prepare(
        "UPDATE workflows SET status = 'archived', updated_at = ? WHERE id = ?",
      )
      .run(Date.now(), id);
    this.services.audit?.record?.({
      actor,
      action: "workflow.archive",
      target: id,
      workspaceId: workflow.workspaceId,
    });
    return this.get(id);
  }

  /* ------------------------------------------------------------------ */
  /* Versioned file format for Git review                                */
  /* ------------------------------------------------------------------ */

  #row(id) {
    const row = this.db.prepare("SELECT * FROM workflows WHERE id = ?").get(id);
    if (!row) throw new InputError("Workflow not found", 404);
    return row;
  }

  /**
   * Stores a definition as the next version of an existing workflow and makes
   * it the current draft.
   *
   * The single write path for a new version, so an imported document and a
   * structural edit produce identical rows and differ only in the audit action
   * they record. Publishing stays a separate, deliberate step.
   */
  #storeVersion(
    row,
    definition,
    { actor = "local-user", action, details = {} },
  ) {
    const hash = definitionHash(definition);
    const next = (row.version ?? 1) + 1;
    const now = Date.now();
    return transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO workflow_versions (id, workflow_id, version, definition, definition_hash, created_at, created_by, published_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          randomUUID(),
          row.id,
          next,
          JSON.stringify(definition),
          hash,
          now,
          actor,
        );
      this.db
        .prepare(
          "UPDATE workflows SET version = ?, definition = ?, definition_hash = ?, status = 'draft', published_at = NULL, updated_at = ? WHERE id = ?",
        )
        .run(next, JSON.stringify(definition), hash, now, row.id);
      this.services.audit?.record?.({
        actor,
        action,
        target: row.id,
        workspaceId: row.workspace_id,
        details: {
          version: next,
          definitionHash: hash,
          status: "draft",
          ...details,
        },
      });
      // #recompute() would report the task state; the row this call just wrote
      // is the truth about the version and its draft status.
      return { ...this.get(row.id), version: next, status: "draft" };
    });
  }

  /**
   * exportWorkflow(id) → a deterministic JSON document.
   *
   * The same workflow always produces byte-identical JSON (keys sorted, no
   * timestamps), so a diff in Git is a diff in the workflow. The hash is
   * computed over the definition alone.
   */
  exportWorkflow(id, { version = null } = {}) {
    const row = this.#row(id);
    let definition = parseJson(row.definition, {});
    let versionNumber = row.version ?? 1;
    if (version !== null) {
      const stored = this.version(id, version);
      definition = stored.definition;
      versionNumber = stored.version;
    }
    const document = {
      formatVersion: WORKFLOW_FORMAT_VERSION,
      id: row.id,
      name: row.name,
      templateId: row.template_id ?? null,
      status: row.status,
      owner: row.owner ?? "agent-space",
      externalId: row.external_id ?? null,
      version: versionNumber,
      definition,
    };
    document.definitionHash = definitionHash(definition);
    // Deterministic text: sorted keys, no clock.
    return JSON.parse(canonicalJson(document));
  }

  /**
   * importWorkflow(json, { workspaceId })
   *
   * Validates the document and stores it as version N+1 in DRAFT status.
   * Importing never dispatches anything and never edits existing tasks.
   */
  importWorkflow(json, { workspaceId = null, actor = "local-user" } = {}) {
    if (!json || typeof json !== "object" || Array.isArray(json))
      throw new InputError("Expected a workflow document object");
    if (json.formatVersion !== WORKFLOW_FORMAT_VERSION)
      throw new InputError(
        `Unsupported workflow document: expected formatVersion ${WORKFLOW_FORMAT_VERSION}`,
      );
    const definition = validateDefinition(json.definition ?? {});
    const hash = definitionHash(definition);
    if (json.definitionHash && json.definitionHash !== hash)
      throw new InputError(
        `definitionHash does not match the definition (document says ${json.definitionHash}, computed ${hash}); the file was edited without rehashing`,
      );
    const now = Date.now();
    const existing = json.id
      ? this.db.prepare("SELECT * FROM workflows WHERE id = ?").get(json.id)
      : null;
    if (existing)
      return this.#storeVersion(existing, definition, {
        actor,
        action: "workflow.import",
      });
    const targetWorkspace = workspaceId ?? json.workspaceId;
    if (!targetWorkspace)
      throw new InputError(
        "workspaceId is required to import a workflow that does not exist yet",
      );
    this.hub.get(targetWorkspace);
    const id = json.id ?? randomUUID();
    return transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO workflows (id, workspace_id, name, template_id, status, definition, created_at, updated_at, version, definition_hash, owner)
           VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          targetWorkspace,
          String(json.name ?? "Imported workflow").slice(0, 120),
          json.templateId ?? null,
          JSON.stringify(definition),
          now,
          now,
          hash,
          json.owner ?? "agent-space",
        );
      this.db
        .prepare(
          `INSERT INTO workflow_versions (id, workflow_id, version, definition, definition_hash, created_at, created_by, published_at)
           VALUES (?, ?, 1, ?, ?, ?, ?, NULL)`,
        )
        .run(randomUUID(), id, JSON.stringify(definition), hash, now, actor);
      this.services.audit?.record?.({
        actor,
        action: "workflow.import",
        target: id,
        workspaceId: targetWorkspace,
        details: { version: 1, definitionHash: hash, status: "draft" },
      });
      return this.get(id);
    });
  }

  /** Every stored version of a workflow, newest first. */
  versions(id) {
    this.#row(id);
    return this.db
      .prepare(
        "SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC",
      )
      .all(id)
      .map((row) => ({
        id: row.id,
        workflowId: row.workflow_id,
        version: row.version,
        definitionHash: row.definition_hash,
        createdAt: row.created_at,
        createdBy: row.created_by,
        publishedAt: row.published_at ?? null,
      }));
  }

  version(id, version) {
    const row = this.db
      .prepare(
        "SELECT * FROM workflow_versions WHERE workflow_id = ? AND version = ?",
      )
      .get(id, Number(version));
    if (!row)
      throw new InputError(`Workflow version ${version} not found`, 404);
    return {
      id: row.id,
      workflowId: row.workflow_id,
      version: row.version,
      definition: parseJson(row.definition, {}),
      definitionHash: row.definition_hash,
      createdAt: row.created_at,
      createdBy: row.created_by,
      publishedAt: row.published_at ?? null,
    };
  }

  /** Makes a version the active one. */
  publish(id, version = null, { actor = "local-user" } = {}) {
    const row = this.#row(id);
    const target = this.version(id, version ?? row.version ?? 1);
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE workflows SET status = 'active', version = ?, definition = ?, definition_hash = ?, published_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        target.version,
        JSON.stringify(target.definition),
        target.definitionHash,
        now,
        now,
        id,
      );
    this.db
      .prepare(
        "UPDATE workflow_versions SET published_at = ? WHERE workflow_id = ? AND version = ?",
      )
      .run(now, id, target.version);
    this.services.audit?.record?.({
      actor,
      action: "workflow.publish",
      target: id,
      workspaceId: row.workspace_id,
      details: {
        version: target.version,
        definitionHash: target.definitionHash,
      },
    });
    return this.get(id);
  }

  /**
   * Creates a NEW version from an old one (never rewrites history) and
   * publishes it, so a rollback is itself reviewable in Git.
   */
  rollback(id, version, { actor = "local-user", publish = true } = {}) {
    const row = this.#row(id);
    const source = this.version(id, version);
    const next = (row.version ?? 1) + 1;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO workflow_versions (id, workflow_id, version, definition, definition_hash, created_at, created_by, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        randomUUID(),
        id,
        next,
        JSON.stringify(source.definition),
        source.definitionHash,
        now,
        actor,
      );
    this.db
      .prepare(
        "UPDATE workflows SET version = ?, definition = ?, definition_hash = ?, status = 'draft', published_at = NULL, updated_at = ? WHERE id = ?",
      )
      .run(
        next,
        JSON.stringify(source.definition),
        source.definitionHash,
        now,
        id,
      );
    this.services.audit?.record?.({
      actor,
      action: "workflow.rollback",
      target: id,
      workspaceId: row.workspace_id,
      details: {
        from: row.version ?? 1,
        restored: source.version,
        newVersion: next,
      },
    });
    if (publish) return this.publish(id, next, { actor });
    return this.get(id);
  }

  /* ------------------------------------------------------------------ */
  /* Ownership (mode 3: an external engine stays authoritative)          */
  /* ------------------------------------------------------------------ */

  /**
   * adopt({ workflowId, owner, externalId })
   *
   * Hands the control loop to another engine. Agent Space keeps observing
   * and recording, and refuses to dispatch, retry, or reassign the runs of
   * this workflow while the owner is external. Pass owner "agent-space" to
   * take it back.
   */
  adopt({ workflowId, owner, externalId = null, actor = "local-user" } = {}) {
    if (!workflowId) throw new InputError("workflowId is required");
    if (typeof owner !== "string" || !owner.trim() || owner.length > 80)
      throw new InputError("owner must be 1–80 characters");
    const row = this.#row(workflowId);
    const nextOwner = owner.trim();
    if (externalId !== null && typeof externalId !== "string")
      throw new InputError("externalId must be a string or null");
    this.db
      .prepare(
        "UPDATE workflows SET owner = ?, external_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(nextOwner, externalId, Date.now(), workflowId);
    // Runs already recorded for this workflow's tasks carry the same owner,
    // so the inspector and the UI show who is in charge.
    this.db
      .prepare(
        `UPDATE runs SET orchestration_owner = ?
          WHERE task_id IN (SELECT id FROM tasks WHERE workflow_id = ?)`,
      )
      .run(nextOwner, workflowId);
    this.services.audit?.record?.({
      actor,
      action: "workflow.adopt",
      target: workflowId,
      workspaceId: row.workspace_id,
      details: { owner: nextOwner, externalId },
    });
    try {
      this.hub
        .get(row.workspace_id)
        .changed(
          nextOwner === "agent-space"
            ? `Agent Space took orchestration of "${row.name}" back`
            : `"${row.name}" is now orchestrated by ${nextOwner}${externalId ? ` (external id ${externalId})` : ""}; Agent Space will not dispatch, retry, or reassign its runs`,
          "system",
        );
    } catch {
      /* workspace gone */
    }
    return this.get(workflowId);
  }

  /** Who owns a workflow's control loop. */
  ownership(id) {
    const row = this.#row(id);
    const owner = row.owner ?? "agent-space";
    return {
      workflowId: id,
      owner,
      externalId: row.external_id ?? null,
      local: owner === "agent-space",
    };
  }

  /* ------------------------------------------------------------------ */
  /* Quotas and permitted triggers                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Enforced before dispatching a step of this workflow.
   * → { allowed, reason }
   */
  checkDispatch(id, { trigger = "manual" } = {}) {
    const row = this.#row(id);
    const owner = row.owner ?? "agent-space";
    if (owner !== "agent-space")
      return {
        allowed: false,
        reason: `workflow is owned by "${owner}"${row.external_id ? ` (external id ${row.external_id})` : ""}; Agent Space does not dispatch its runs`,
      };
    if (row.status === "archived")
      return { allowed: false, reason: "workflow is archived" };
    const definition = parseJson(row.definition, {});
    const triggers = definition.triggers ?? null;
    if (triggers && !triggers.includes(trigger))
      return {
        allowed: false,
        reason: `trigger "${trigger}" is not permitted by this workflow (permitted: ${triggers.join(", ")})`,
      };
    const quotas = definition.quotas ?? {};
    if (quotas.maxRuns) {
      const used = this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM runs WHERE task_id IN (SELECT id FROM tasks WHERE workflow_id = ?)",
        )
        .get(id).n;
      if (used >= quotas.maxRuns)
        return {
          allowed: false,
          reason: `workflow run quota reached (${used} of ${quotas.maxRuns})`,
        };
    }
    if (quotas.maxConcurrentRuns) {
      const active = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','running','waiting_approval','stale')
             AND task_id IN (SELECT id FROM tasks WHERE workflow_id = ?)`,
        )
        .get(id).n;
      if (active >= quotas.maxConcurrentRuns)
        return {
          allowed: false,
          reason: `workflow concurrency quota reached (${active} of ${quotas.maxConcurrentRuns})`,
        };
    }
    return { allowed: true, reason: null };
  }

  /** Static validation of the workflow's task graph. */
  validateGraph(id) {
    const row = this.#row(id);
    return this.graph.validateWorkflow(row.workspace_id, { workflowId: id });
  }

  /* ------------------------------------------------------------------ */
  /* Editing the step graph inside the definition                        */
  /* ------------------------------------------------------------------ */

  /**
   * The step graph as an editor needs it: the definition itself plus the
   * nodes and edges already inside it, and the vocabularies an edit must stay
   * within (roles, required tools, inputs).
   */
  definitionGraph(id) {
    const row = this.#row(id);
    const definition = parseJson(row.definition, {});
    const owner = row.owner ?? "agent-space";
    return {
      workflowId: id,
      workspaceId: row.workspace_id,
      name: row.name,
      version: row.version ?? 1,
      status: row.status,
      definitionHash: row.definition_hash ?? null,
      // #recompute() rewrites `status` from the task state, so a version that
      // was never published shows as active there. published_at is the durable
      // answer to "has anyone signed this version off".
      publishedAt: row.published_at ?? null,
      definition,
      steps: definition.steps ?? [],
      edges: definitionEdges(definition),
      roles: definition.roles ?? [],
      requiredTools: definition.requiredTools ?? [],
      inputs: definition.inputs ?? {},
      owner,
      editable: owner === "agent-space",
    };
  }

  /**
   * Runs the four launch checks over a proposed definition that was never
   * stored. Same code, same wording, and nothing is written.
   */
  validateDraft(id, definition) {
    const row = this.#row(id);
    return this.graph.validateDraftNodes(
      row.workspace_id,
      stepsToNodes(definition),
    );
  }

  /**
   * Stores an edited step graph as a new draft version.
   *
   * `expectedHash` is the hash the editor loaded. A mismatch means someone
   * else wrote a version in the meantime, and the edit is refused rather than
   * silently overwriting theirs.
   */
  saveDefinition(
    id,
    definition,
    { expectedHash = null, actor = "local-user" } = {},
  ) {
    const row = this.#row(id);
    const owner = row.owner ?? "agent-space";
    if (owner !== "agent-space")
      throw new InputError(
        `"${row.name}" is orchestrated by "${owner}"; its definition is edited there, not here`,
        409,
      );
    if (expectedHash && expectedHash !== (row.definition_hash ?? null))
      throw new InputError(
        `The workflow changed since you opened it (it is now version ${row.version ?? 1}, hash ${row.definition_hash}). Reload before saving.`,
        409,
      );
    const previous = parseJson(row.definition, {});
    const next = validateDefinition(definition);
    // A definition that carries steps is judged by the same structural rules
    // as a shipped template pack. Imported documents are deliberately not:
    // they already load today, and tightening that is a separate decision.
    if (next.steps) {
      try {
        validateTemplate(next);
      } catch (error) {
        throw new InputError(error.message, 400);
      }
    }
    const report = this.validateDraft(id, next);
    if (!report.ok) {
      const error = new InputError(
        `This graph cannot be launched: ${report.problems
          .map(
            (problem) =>
              `${problem.code} at ${problem.title ?? problem.taskId}`,
          )
          .join("; ")}`,
        400,
      );
      error.problems = report.problems;
      throw error;
    }
    const diff = diffDefinitions(previous, next);
    return this.#storeVersion(row, next, {
      actor,
      action: "workflow.edit",
      details: {
        addedSteps: diff.addedSteps,
        removedSteps: diff.removedSteps,
        changedSteps: diff.changedSteps,
        addedEdges: diff.addedEdges.length,
        removedEdges: diff.removedEdges.length,
      },
    });
  }

  /**
   * Which steps of the definition already exist as tasks, and which tasks no
   * longer match a step.
   *
   * A report, never a write. Editing the definition does not delete a task:
   * a task may already carry runs, artifacts and audit rows, and removing it
   * would destroy that record. Re-materializing an edited workflow is a
   * separate feature that does not exist yet.
   */
  materialization(id) {
    const row = this.#row(id);
    const definition = parseJson(row.definition, {});
    const tasks = this.db
      .prepare(
        "SELECT id, title, status, context FROM tasks WHERE workflow_id = ? ORDER BY created_at, rowid",
      )
      .all(id);
    const runs = (taskId) =>
      this.db
        .prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ?")
        .get(taskId).n;
    const stepKeyOf = (task) => parseJson(task.context, {}).stepKey ?? null;
    const taskByKey = new Map();
    for (const task of tasks) {
      const key = stepKeyOf(task);
      if (key && !taskByKey.has(key)) taskByKey.set(key, task);
    }
    const defined = new Set((definition.steps ?? []).map((step) => step.key));
    return {
      workflowId: id,
      version: row.version ?? 1,
      steps: (definition.steps ?? []).map((step) => {
        const task = taskByKey.get(step.key) ?? null;
        return {
          key: step.key,
          title: step.title ?? step.key,
          taskId: task?.id ?? null,
          status: task?.status ?? null,
          runs: task ? runs(task.id) : 0,
        };
      }),
      orphanTasks: tasks
        .filter((task) => {
          const key = stepKeyOf(task);
          return !key || !defined.has(key);
        })
        .map((task) => ({
          taskId: task.id,
          title: task.title,
          stepKey: stepKeyOf(task),
          status: task.status,
          runs: runs(task.id),
        })),
      note: "Editing the definition does not delete tasks that already exist, and never deletes a task that has runs.",
    };
  }
}
