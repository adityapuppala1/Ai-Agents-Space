import { randomUUID } from "node:crypto";
import { InputError } from "../TaskStore.js";

/**
 * Handover briefs (roadmap §12): an editable summary a new person or a new
 * provider can pick up a task from.
 *
 * Two honesty rules shape this module:
 *   1. `build()` composes the brief from stored records only — the task, its
 *      contract, the runs, decisions, artifacts, key events and open
 *      questions. Nothing is generated, inferred, or embellished; a section
 *      with no records says "none recorded".
 *   2. The generated baseline is stored next to the edited body, and every
 *      save is a new version row carrying `edited_by` and `updated_at`, so a
 *      human edit is always distinguishable from generated text.
 */

const KEY_EVENT_KINDS = new Set([
  "session.start",
  "session.end",
  "prompt",
  "approval.request",
  "approval.decision",
  "delegation",
  "error",
  "complete",
  "task",
]);

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function when(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "unknown";
}

function bullet(lines, fallback = "_none recorded_") {
  return lines.length ? lines.map((line) => `- ${line}`).join("\n") : fallback;
}

function rowToBrief(row) {
  return {
    id: row.thread_id,
    versionId: row.id,
    workspaceId: row.workspace_id,
    taskId: row.task_id ?? null,
    runId: row.run_id ?? null,
    author: row.author,
    generated: row.generated,
    body: row.body,
    editedBy: row.edited_by ?? null,
    edited: row.body !== row.generated,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

export class Handover {
  constructor(services, { now = Date.now } = {}) {
    this.services = services;
    this.db = services.db;
    this.now = now;
  }

  /**
   * build({ workspaceId, taskId, runId }) → { markdown, sections, sources }
   *
   * Composed from records only. Either a taskId or a runId is required; the
   * other is filled in from the run/task when it is known.
   */
  build({ workspaceId = null, taskId = null, runId = null } = {}) {
    if (!taskId && !runId) throw new InputError("taskId or runId is required");
    let run = runId
      ? this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId)
      : null;
    if (runId && !run) throw new InputError("Run not found", 404);
    let task = taskId
      ? this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId)
      : run?.task_id
        ? this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(run.task_id)
        : null;
    if (taskId && !task) throw new InputError("Task not found", 404);
    const wsId = workspaceId ?? task?.workspace_id ?? run?.workspace_id ?? null;
    if (!wsId) throw new InputError("workspaceId could not be determined");
    if (task && task.workspace_id !== wsId)
      throw new InputError("Task not found", 404);
    if (run && run.workspace_id !== wsId)
      throw new InputError("Run not found", 404);
    const workspace = this.db
      .prepare("SELECT * FROM workspaces WHERE id = ?")
      .get(wsId);

    const runs = task
      ? this.db
          .prepare(
            "SELECT * FROM runs WHERE task_id = ? ORDER BY started_at ASC",
          )
          .all(task.id)
      : run
        ? [run]
        : [];
    if (!run && runs.length) run = runs[runs.length - 1];

    const runIds = runs.map((r) => r.id);
    const placeholders = runIds.map(() => "?").join(", ");
    const artifacts = runIds.length
      ? this.db
          .prepare(
            `SELECT id, run_id, kind, title, path, size, created_at FROM artifacts WHERE run_id IN (${placeholders}) ORDER BY created_at ASC`,
          )
          .all(...runIds)
      : [];
    const approvals = runIds.length
      ? this.db
          .prepare(
            `SELECT * FROM approvals WHERE run_id IN (${placeholders}) ORDER BY requested_at ASC`,
          )
          .all(...runIds)
      : [];
    const events = runIds.length
      ? this.db
          .prepare(
            `SELECT * FROM events WHERE run_id IN (${placeholders}) ORDER BY timestamp ASC LIMIT 400`,
          )
          .all(...runIds)
      : [];
    const decisions =
      this.services.decisions?.history?.({
        workspaceId: wsId,
        runId: run?.id ?? null,
      }) ?? [];

    const agent = task?.assigned_agent_id
      ? this.db
          .prepare("SELECT * FROM agent_profiles WHERE id = ?")
          .get(task.assigned_agent_id)
      : null;

    const contract = parseJson(task?.contract, {});
    const review = parseJson(task?.review, {});
    const target = parseJson(task?.target, {});

    const sections = {};
    sections.task = task
      ? [
          `Title: ${task.title}`,
          `Status: ${task.status} (priority ${task.priority})`,
          task.deliverable ? `Deliverable: ${task.deliverable}` : null,
          target.folder ? `Target folder: ${target.folder}` : null,
          (target.files ?? []).length
            ? `Target files: ${target.files.join(", ")}`
            : null,
          agent ? `Assigned to: ${agent.name} (${agent.role})` : null,
          task.description ? `Description: ${task.description}` : null,
        ].filter(Boolean)
      : ["No task record is attached to this brief."];

    sections.contract = Object.keys(contract).length
      ? Object.entries(contract).map(
          ([key, value]) =>
            `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
        )
      : [];

    sections.runs = runs.map(
      (r) =>
        `${r.provider ?? "manual"} ${r.mode} run ${r.id} — ${r.status}${r.actual_model ? `, model ${r.actual_model}` : ", model not reported"}, started ${when(r.started_at)}${r.error ? `, error: ${r.error}` : ""}`,
    );

    sections.decisions = decisions.length
      ? decisions.map(
          (entry) =>
            `${when(entry.at)} — ${entry.actor}: ${entry.decision} (${entry.summary})${entry.note ? ` — note: ${entry.note}` : ""}`,
        )
      : approvals
          .filter((a) => a.decided_at)
          .map(
            (a) =>
              `${when(a.decided_at)} — ${a.decided_by ?? "unknown"}: ${a.decision ?? a.status} (${a.action})`,
          );

    sections.artifacts = artifacts.map(
      (artifact) =>
        `${artifact.kind}: ${artifact.title ?? artifact.path ?? artifact.id}${Number.isFinite(artifact.size) ? ` (${artifact.size} bytes)` : ""}`,
    );

    sections.events = events
      .filter((event) => KEY_EVENT_KINDS.has(event.kind))
      .slice(-15)
      .map((event) =>
        `${when(event.timestamp)} [${event.kind}/${event.provenance}] ${event.message ?? ""}`.trim(),
      );

    const openQuestions = [
      ...approvals
        .filter((a) => a.status === "pending")
        .map(
          (a) =>
            `Waiting for a decision: ${a.action}${a.reason ? ` (${a.reason})` : ""}`,
        ),
      ...approvals.flatMap((a) =>
        (parseJson(a.payload, {})._changeRequests ?? []).map(
          (change) =>
            `Change requested by ${change.actor}: ${change.note ?? "no note"}`,
        ),
      ),
      ...(review.status === "pending"
        ? ["A human review of the delivered work is still pending."]
        : []),
      ...runs
        .filter((r) => ["failed", "disconnected", "stale"].includes(r.status))
        .map(
          (r) =>
            `Run ${r.id} ended ${r.status}${r.error ? `: ${r.error}` : ""}`,
        ),
    ];
    sections.openQuestions = openQuestions;

    const markdown = [
      `# Handover brief — ${task?.title ?? run?.title ?? "untitled work"}`,
      "",
      `Workspace: ${workspace?.name ?? wsId}${workspace?.root_path ? ` (${workspace.root_path})` : ""}`,
      `Generated: ${when(this.now())} from stored records only.`,
      "",
      "## Task",
      bullet(sections.task),
      "",
      "## Contract",
      bullet(sections.contract, "_no task contract recorded_"),
      "",
      "## Runs",
      bullet(sections.runs, "_no runs recorded_"),
      "",
      "## Decisions",
      bullet(sections.decisions, "_no decisions recorded_"),
      "",
      "## Artifacts",
      bullet(sections.artifacts, "_no artifacts recorded_"),
      "",
      "## Key events",
      bullet(sections.events, "_no events recorded_"),
      "",
      "## Open questions",
      bullet(sections.openQuestions, "_none recorded_"),
    ].join("\n");

    return {
      workspaceId: wsId,
      taskId: task?.id ?? null,
      runId: run?.id ?? null,
      markdown,
      sections,
      sources: {
        runs: runs.length,
        approvals: approvals.length,
        artifacts: artifacts.length,
        events: events.length,
        decisions: decisions.length,
      },
      generatedAt: this.now(),
    };
  }

  /** Builds and stores version 1 of a brief. */
  create({
    workspaceId = null,
    taskId = null,
    runId = null,
    author = "system",
  } = {}) {
    const built = this.build({ workspaceId, taskId, runId });
    const threadId = randomUUID();
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO handover_briefs (id, thread_id, workspace_id, task_id, run_id, author, generated, body, edited_by, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1)`,
      )
      .run(
        randomUUID(),
        threadId,
        built.workspaceId,
        built.taskId,
        built.runId,
        String(author).slice(0, 120),
        built.markdown,
        built.markdown,
        at,
        at,
      );
    this.services.audit?.record?.({
      actor: author,
      action: "handover.create",
      target: `handover:${threadId}`,
      workspaceId: built.workspaceId,
      runId: built.runId,
      details: { taskId: built.taskId, sources: built.sources },
    });
    return { ...this.get(threadId), sections: built.sections };
  }

  #head(id) {
    return (
      this.db
        .prepare(
          "SELECT * FROM handover_briefs WHERE thread_id = ? ORDER BY version DESC LIMIT 1",
        )
        .get(id) ??
      (() => {
        const row = this.db
          .prepare("SELECT * FROM handover_briefs WHERE id = ?")
          .get(id);
        return row
          ? this.db
              .prepare(
                "SELECT * FROM handover_briefs WHERE thread_id = ? ORDER BY version DESC LIMIT 1",
              )
              .get(row.thread_id)
          : null;
      })()
    );
  }

  get(id) {
    const row = this.#head(id);
    if (!row) throw new InputError("Handover brief not found", 404);
    return rowToBrief(row);
  }

  /**
   * save({ id, body, editedBy }) writes a NEW version. The generated baseline
   * is copied forward unchanged so the difference between what Agent Space
   * wrote and what a person wrote stays visible and attributable.
   */
  save({ id, body, editedBy = "local-user" } = {}) {
    const current = this.#head(id);
    if (!current) throw new InputError("Handover brief not found", 404);
    const text = String(body ?? "");
    if (!text.trim()) throw new InputError("body is required");
    if (text.length > 200_000)
      throw new InputError("body is too long (200000 characters max)");
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO handover_briefs (id, thread_id, workspace_id, task_id, run_id, author, generated, body, edited_by, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        current.thread_id,
        current.workspace_id,
        current.task_id,
        current.run_id,
        current.author,
        current.generated,
        text,
        String(editedBy).slice(0, 120),
        current.created_at,
        at,
        current.version + 1,
      );
    this.services.audit?.record?.({
      actor: editedBy,
      action: "handover.save",
      target: `handover:${current.thread_id}`,
      workspaceId: current.workspace_id,
      runId: current.run_id,
      details: {
        version: current.version + 1,
        edited: text !== current.generated,
      },
    });
    return this.get(current.thread_id);
  }

  /** Regenerates the baseline from current records as a new version. */
  refresh({ id, author = "system" } = {}) {
    const current = this.#head(id);
    if (!current) throw new InputError("Handover brief not found", 404);
    const built = this.build({
      workspaceId: current.workspace_id,
      taskId: current.task_id,
      runId: current.run_id,
    });
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO handover_briefs (id, thread_id, workspace_id, task_id, run_id, author, generated, body, edited_by, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        current.thread_id,
        current.workspace_id,
        current.task_id,
        current.run_id,
        String(author).slice(0, 120),
        built.markdown,
        built.markdown,
        current.created_at,
        at,
        current.version + 1,
      );
    return this.get(current.thread_id);
  }

  /** Every version of one brief, oldest first, each with its editor. */
  history(id) {
    const head = this.#head(id);
    if (!head) throw new InputError("Handover brief not found", 404);
    return this.db
      .prepare(
        "SELECT * FROM handover_briefs WHERE thread_id = ? ORDER BY version ASC",
      )
      .all(head.thread_id)
      .map(rowToBrief);
  }

  /** Latest version of each brief in one workspace. */
  list({ workspaceId = null, taskId = null, runId = null, limit = 50 } = {}) {
    const clauses = [];
    const params = [];
    if (workspaceId) {
      clauses.push("workspace_id = ?");
      params.push(workspaceId);
    }
    if (taskId) {
      clauses.push("task_id = ?");
      params.push(taskId);
    }
    if (runId) {
      clauses.push("run_id = ?");
      params.push(runId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM handover_briefs ${where} ORDER BY updated_at DESC, version DESC`,
      )
      .all(...params);
    const heads = [];
    const seen = new Set();
    for (const row of rows) {
      if (seen.has(row.thread_id)) continue;
      seen.add(row.thread_id);
      heads.push(rowToBrief(row));
      if (heads.length >= Math.max(1, Math.min(Number(limit) || 50, 200)))
        break;
    }
    return heads;
  }
}

/** services.js optional-module factory. */
export function createHandover(services) {
  services.handover ??= new Handover(services);
  return services.handover;
}

export default Handover;
