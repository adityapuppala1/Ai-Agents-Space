import { randomUUID } from "node:crypto";
import { InputError } from "../TaskStore.js";
import { transaction } from "../db.js";
import { TaskGraph } from "./TaskGraph.js";
import { getTemplate, listTemplates, interpolate } from "./templates/index.js";

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
      actor = "local-user",
    } = {},
  ) {
    const workspace = this.hub.get(workspaceId);
    const template = getTemplate(templateId);
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs))
      throw new InputError("inputs must be an object");
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
        const stepProvider = step.provider ?? provider ?? null;
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
}
