import { basename } from "node:path";
import { InputError } from "../TaskStore.js";
import { transaction } from "../db.js";
import { DEFAULT_POLICY } from "../contracts.js";

const TASK_PRIORITIES = ["critical", "high", "medium", "low"];

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

/** Removes absolute private paths from the policy before export. */
function portablePolicy(policy) {
  const copy = { ...DEFAULT_POLICY, ...policy };
  copy.allowedFolders = (copy.allowedFolders ?? []).map((folder) =>
    /^([a-z]:[\\/]|[\\/]|~)/i.test(String(folder))
      ? basename(String(folder))
      : folder,
  );
  return copy;
}

/**
 * Portable workspace manifest: no ids, no credentials, no absolute private
 * paths. rootPath is replaced by its basename with a note.
 */
export function exportWorkspace(services, workspaceId) {
  const runtime = services.hub.get(workspaceId);
  const workspace = services.db
    .prepare("SELECT * FROM workspaces WHERE id = ?")
    .get(workspaceId);
  const agents = runtime.profiles.list().map((agent) => ({
    name: agent.name,
    role: agent.role,
    color: agent.color,
    specialty: agent.specialty,
    instructions: agent.instructions,
    workingState: agent.workingState,
    runtime: agent.runtime ?? null,
    model: agent.model ?? null,
    provider:
      services.db
        .prepare("SELECT provider FROM agent_profiles WHERE id = ?")
        .get(agent.id)?.provider ?? null,
  }));
  const agentIndex = new Map(runtime.profiles.list().map((a, i) => [a.id, i]));
  const rows = services.db
    .prepare(
      "SELECT * FROM tasks WHERE workspace_id = ? ORDER BY created_at, rowid",
    )
    .all(workspaceId);
  const index = new Map(rows.map((row, i) => [row.id, i]));
  const tasks = rows.map((row) => ({
    title: row.title,
    description: row.description,
    priority: row.priority,
    status: row.status,
    deliverable: row.deliverable ?? "",
    provider: row.provider ?? null,
    templateId: row.template_id ?? null,
    workflowRef: row.workflow_id ? `workflow-${index.get(row.id)}` : null,
    dependsOn: parseJson(row.depends_on, [])
      .map((id) => index.get(id))
      .filter((i) => i !== undefined),
    assignedAgent: row.assigned_agent_id
      ? (agentIndex.get(row.assigned_agent_id) ?? null)
      : null,
  }));
  const templatesUsed = [
    ...new Set(rows.map((row) => row.template_id).filter(Boolean)),
  ];
  return {
    version: 1,
    exportedAt: Date.now(),
    workspace: {
      name: workspace.name,
      theme: workspace.theme ?? "studio",
      policy: portablePolicy(parseJson(workspace.policy, {})),
      rootPathName: workspace.root_path ? basename(workspace.root_path) : null,
      rootPathNote: workspace.root_path
        ? "Absolute root path removed; set rootPath after import."
        : null,
    },
    agents,
    templatesUsed,
    tasks,
    excluded: [
      "credentials",
      "absolute private paths",
      "runs and events",
      "artifacts",
      "approvals",
    ],
  };
}

/** Creates a workspace, agents, and tasks from a manifest; rewires deps by index. */
export function importWorkspace(
  services,
  manifest,
  { name, rootPath = null } = {},
) {
  if (!manifest || typeof manifest !== "object" || manifest.version !== 1)
    throw new InputError("Unsupported manifest (expected version 1)");
  const workspaceName = String(name ?? manifest.workspace?.name ?? "").trim();
  if (!workspaceName) throw new InputError("Workspace name is required");
  const agentsIn = Array.isArray(manifest.agents) ? manifest.agents : [];
  const tasksIn = Array.isArray(manifest.tasks) ? manifest.tasks : [];
  return transaction(services.db, () => {
    const created = services.hub.create({ name: workspaceName, rootPath });
    const runtime = services.hub.get(created.id);
    const policy = portablePolicy(manifest.workspace?.policy ?? {});
    services.db
      .prepare("UPDATE workspaces SET policy = ?, theme = ? WHERE id = ?")
      .run(
        JSON.stringify(policy),
        ["studio", "operations"].includes(manifest.workspace?.theme)
          ? manifest.workspace.theme
          : "studio",
        created.id,
      );
    // Imported agents replace the seeded defaults so the roster matches.
    if (agentsIn.length) {
      services.db
        .prepare(
          "DELETE FROM agent_profiles WHERE workspace_id = ? AND id NOT IN (SELECT assigned_agent_id FROM tasks WHERE assigned_agent_id IS NOT NULL)",
        )
        .run(created.id);
    }
    const agentIds = agentsIn.map((agent) => {
      const profile = runtime.profiles.create({
        name: String(agent.name ?? "Agent").slice(0, 60),
        role: String(agent.role ?? "Agent").slice(0, 60),
        color: /^#[0-9a-f]{6}$/i.test(agent.color ?? "")
          ? agent.color
          : undefined,
        specialty: agent.specialty ?? "",
        instructions: agent.instructions ?? "",
        workingState: agent.workingState,
        runtime: agent.runtime ?? undefined,
        model: agent.model ?? undefined,
      });
      if (agent.provider)
        services.db
          .prepare("UPDATE agent_profiles SET provider = ? WHERE id = ?")
          .run(String(agent.provider), profile.id);
      return profile.id;
    });
    const taskIds = tasksIn.map((task) => {
      const row = runtime.store.create(
        {
          title: String(task.title ?? "Untitled").slice(0, 200),
          description: String(task.description ?? "").slice(0, 2000),
          priority: TASK_PRIORITIES.includes(task.priority)
            ? task.priority
            : "medium",
        },
        "import",
      );
      return row.id;
    });
    tasksIn.forEach((task, i) => {
      const dependsOn = (task.dependsOn ?? [])
        .filter(
          (j) => Number.isInteger(j) && j >= 0 && j < taskIds.length && j !== i,
        )
        .map((j) => taskIds[j]);
      const agentId =
        Number.isInteger(task.assignedAgent) && agentIds[task.assignedAgent]
          ? agentIds[task.assignedAgent]
          : null;
      services.db
        .prepare(
          "UPDATE tasks SET depends_on = ?, deliverable = ?, provider = ?, template_id = ?, assigned_agent_id = ?, updated_at = ? WHERE id = ?",
        )
        .run(
          JSON.stringify(dependsOn),
          String(task.deliverable ?? "").slice(0, 500),
          task.provider ? String(task.provider) : null,
          task.templateId ? String(task.templateId) : null,
          agentId,
          Date.now(),
          taskIds[i],
        );
    });
    runtime.changed(
      `Imported ${taskIds.length} tasks and ${agentIds.length} agents from a manifest`,
      "system",
    );
    services.hub.emit("workspaces");
    return {
      workspace: runtime.record,
      agents: agentIds.length,
      tasks: taskIds.length,
      taskIds,
      agentIds,
    };
  });
}
