/**
 * Sandbox dry runs (roadmap §10, "Sandbox dry runs explain planned work or
 * use recorded tool outputs").
 *
 * Two honest modes, neither of which executes anything:
 *
 *  plan()   — asks each provider adapter to BUILD the command line it would
 *             use and returns it verbatim, with the provider, tools, cwd and
 *             the number of runs it would take. Nothing is spawned.
 *  replay() — re-emits the events a COMPLETED run already recorded, clearly
 *             marked as a replay. It is a picture of what happened once, not
 *             a prediction: a new run may differ, and this module never
 *             claims otherwise.
 */

import { InputError } from "../TaskStore.js";
import { DEFAULT_POLICY, PROVIDERS } from "../contracts.js";
import { adapterFor, defaultAdapters } from "../adapters/index.js";
import { buildPrompt, extraDirsFor, commandLine } from "../adapters/base.js";
import { resolveBinary as defaultResolveBinary } from "../runs/process.js";
import { parseJson } from "./contracts.js";

export const PLAN_ASSUMPTIONS = Object.freeze([
  "one run per step",
  "no retries counted",
  "nothing is spawned: the command line comes from the adapter's build() only",
  "the provider decides what its tools actually do; this plan cannot promise it",
]);

function taskRows(db, { workspaceId, workflowId, taskIds }) {
  if (Array.isArray(taskIds) && taskIds.length) {
    const placeholders = taskIds.map(() => "?").join(", ");
    return db
      .prepare(
        `SELECT * FROM tasks WHERE workspace_id = ? AND id IN (${placeholders})`,
      )
      .all(workspaceId, ...taskIds);
  }
  if (workflowId)
    return db
      .prepare(
        "SELECT * FROM tasks WHERE workspace_id = ? AND workflow_id = ? ORDER BY created_at, rowid",
      )
      .all(workspaceId, workflowId);
  return db
    .prepare(
      "SELECT * FROM tasks WHERE workspace_id = ? AND status != 'COMPLETED' ORDER BY created_at, rowid",
    )
    .all(workspaceId);
}

/** Dependencies first; ties keep creation order. */
function orderTasks(rows) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const done = new Set();
  const visiting = new Set();
  const out = [];
  const visit = (row) => {
    if (done.has(row.id) || visiting.has(row.id)) return;
    visiting.add(row.id);
    for (const dep of parseJson(row.depends_on, [])) {
      const target = byId.get(dep);
      if (target) visit(target);
    }
    visiting.delete(row.id);
    done.add(row.id);
    out.push(row);
  };
  for (const row of rows) visit(row);
  return out;
}

/**
 * plan({ workspaceId, workflowId?, taskIds? })
 *
 * → {
 *     workspaceId, workflowId, steps: [{ taskId, title, stepKey, provider,
 *       adapter, tools, estimatedRuns, commandLine, args, cwd, notes }],
 *     estimatedRuns, spawned: false, assumptions
 *   }
 */
export function plan(
  services,
  {
    workspaceId,
    workflowId = null,
    taskIds = null,
    adapters = defaultAdapters,
    resolveBinary = defaultResolveBinary,
    env = null,
  } = {},
) {
  if (!workspaceId) throw new InputError("workspaceId is required");
  const workspace = services.hub.get(workspaceId);
  const record = workspace.record;
  const rows = orderTasks(
    taskRows(services.db, { workspaceId, workflowId, taskIds }),
  );
  const policy = services.policy?.forWorkspace?.(workspaceId) ?? {
    ...DEFAULT_POLICY,
    ...parseJson(record.policy, {}),
  };
  const agents = workspace.snapshot().agents ?? [];
  const environment = env ?? services.env ?? process.env;

  const steps = [];
  for (const row of rows) {
    const notes = [];
    const provider = row.provider ?? null;
    const context = parseJson(row.context, {});
    const contract = parseJson(row.contract, {});
    const step = {
      taskId: row.id,
      title: row.title,
      stepKey: context.stepKey ?? null,
      provider,
      providerName: provider ? (PROVIDERS[provider]?.name ?? provider) : null,
      adapter: null,
      tools: contract.allowedTools ?? [],
      estimatedRuns: 1,
      commandLine: null,
      args: [],
      cwd: record.rootPath ?? parseJson(row.target, {}).folder ?? null,
      dependsOn: parseJson(row.depends_on, []),
      notes,
      wouldSpawn: false,
    };
    if (!provider) {
      step.estimatedRuns = 0;
      notes.push("no provider on this task; it would not be dispatched");
      steps.push(step);
      continue;
    }
    const adapter = adapterFor(provider, {
      adapters,
      settings: services.settings ?? null,
    });
    if (!adapter) {
      step.estimatedRuns = 0;
      notes.push(`no adapter for provider ${provider}`);
      steps.push(step);
      continue;
    }
    step.adapter = adapter.id;
    const agent =
      agents.find((a) => a.id === row.assigned_agent_id) ??
      agents.find((a) => a.provider === provider) ??
      agents[0] ??
      null;
    const cwd = record.rootPath ?? parseJson(row.target, {}).folder ?? null;
    step.cwd = cwd;
    if (!cwd)
      notes.push("workspace has no root path; the real launch would refuse");
    let binary = { command: provider, args: [], resolved: false };
    try {
      binary = resolveBinary(provider, environment, {
        names: adapter.launchBinaries ?? null,
      });
    } catch (error) {
      notes.push(`binary lookup failed: ${error.message}`);
    }
    if (!binary.resolved)
      notes.push(
        `${PROVIDERS[provider]?.name ?? provider} binary was not found; the command below shows the shape only`,
      );
    const task = {
      id: row.id,
      title: row.title,
      description: row.description,
      deliverable: row.deliverable ?? "",
      target: parseJson(row.target, {}),
      context,
      priority: row.priority,
    };
    const prompt = buildPrompt({
      task,
      workspace: record,
      agent: agent ?? { name: "unassigned", role: "", instructions: "" },
      context: task.context,
    });
    try {
      const launch = adapter.build({
        // A dry run has no run row: the adapters only read ids from it.
        run: { id: "dry-run", attempt: 1 },
        task,
        agent: agent ?? {},
        workspace: record,
        policy,
        prompt,
        binary,
        cwd,
        extraDirs: extraDirsFor({ task, cwd }),
        model: agent?.model ?? null,
        resumeSessionId: null,
        hooksInstalled: false,
        settings: services.settings ?? null,
        dry: true,
      });
      step.args = launch.args ?? [];
      step.commandLine = commandLine(launch.command, launch.args ?? []);
      step.cwd = launch.cwd ?? cwd;
    } catch (error) {
      notes.push(`the adapter could not build a command: ${error.message}`);
      step.estimatedRuns = 0;
    }
    steps.push(step);
  }

  return {
    workspaceId,
    workflowId,
    steps,
    estimatedRuns: steps.reduce((sum, step) => sum + step.estimatedRuns, 0),
    spawned: false,
    assumptions: [...PLAN_ASSUMPTIONS],
  };
}

/**
 * replay({ runId })
 *
 * Re-emits the recorded events of a finished run as a preview timeline.
 * Everything is labelled: these are recorded events, not a simulation, and a
 * new run may take a different path.
 */
export function replay(services, { runId, limit = 500 } = {}) {
  if (!runId) throw new InputError("runId is required");
  const run = services.db
    .prepare(
      "SELECT id, workspace_id, task_id, provider, status, started_at, ended_at, summary, actual_model FROM runs WHERE id = ?",
    )
    .get(runId);
  if (!run) throw new InputError("Run not found", 404);
  const rows = services.db
    .prepare(
      "SELECT id, sequence, kind, message, timestamp, provenance, tool, file, data FROM events WHERE run_id = ? ORDER BY sequence ASC LIMIT ?",
    )
    .all(runId, Math.min(Number(limit) || 500, 5000));
  const events = rows.map((row) => ({
    id: row.id,
    sequence: row.sequence,
    kind: row.kind,
    message: row.message,
    timestamp: row.timestamp,
    provenance: row.provenance,
    tool: row.tool ?? null,
    file: row.file ?? null,
    data: parseJson(row.data, {}),
    replayed: true,
  }));
  return {
    runId,
    workspaceId: run.workspace_id,
    taskId: run.task_id,
    provider: run.provider,
    status: run.status,
    model: run.actual_model ?? null,
    startedAt: run.started_at,
    endedAt: run.ended_at ?? null,
    replay: true,
    recorded: true,
    executed: false,
    events,
    note: "This is a replay of events this run already recorded. Nothing was executed, and a new run may take a different path.",
  };
}

export function createDryRun(services, options = {}) {
  const api = {
    plan: (input) => plan(services, { ...options, ...input }),
    replay: (input) => replay(services, { ...options, ...input }),
  };
  services.dryRun = api;
  return api;
}
