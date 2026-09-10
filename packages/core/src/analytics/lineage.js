/**
 * Artifact lineage: which pinned inputs went into which run, which tools it
 * used, which artifacts came out, who reviewed them, and which result was
 * accepted.
 *
 * Honesty rules (docs/ARCHITECTURE.md §0):
 *   - Every node comes from a stored record. Nothing is inferred beyond the
 *     edges between records we actually wrote.
 *   - Input revisions are the ones pinned in the run's context manifest
 *     (`git:<blob>` or `mtime:<ms>`); when a run has no manifest, its inputs
 *     are simply absent rather than guessed.
 *   - The attempt chain (parentRunId) is followed in both directions so a
 *     retried run's lineage stays connected to the inputs of attempt 1.
 *
 * Graph shape:
 *   nodes: [{ id, type: 'input'|'run'|'tool'|'artifact'|'review'|'result',
 *             label, revision, timestamp, ...detail }]
 *   edges: [{ from, to, relation }]
 */

import { createHash } from "node:crypto";
import { InputError } from "../TaskStore.js";

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

const TOOL_KINDS = new Set([
  "tool.start",
  "command",
  "test",
  "file.edit",
  "file.write",
]);

function shortHash(text) {
  return createHash("sha256").update(String(text)).digest("hex").slice(0, 16);
}

class Graph {
  constructor() {
    this.nodes = new Map();
    this.edges = new Map();
  }

  node(node) {
    if (!this.nodes.has(node.id)) this.nodes.set(node.id, node);
    return node.id;
  }

  edge(from, to, relation) {
    if (!from || !to || from === to) return;
    const key = `${from}→${to}:${relation}`;
    if (!this.edges.has(key)) this.edges.set(key, { from, to, relation });
  }

  result() {
    return { nodes: [...this.nodes.values()], edges: [...this.edges.values()] };
  }
}

/** Breadth-first path between two node ids, or null. Edges are directed. */
export function pathBetween(graph, fromId, toId) {
  if (fromId === toId) return [fromId];
  const out = new Map();
  for (const edge of graph.edges) {
    if (!out.has(edge.from)) out.set(edge.from, []);
    out.get(edge.from).push(edge.to);
  }
  const seen = new Set([fromId]);
  const queue = [[fromId]];
  while (queue.length) {
    const path = queue.shift();
    for (const next of out.get(path[path.length - 1]) ?? []) {
      if (seen.has(next)) continue;
      const extended = [...path, next];
      if (next === toId) return extended;
      seen.add(next);
      queue.push(extended);
    }
  }
  return null;
}

export class Lineage {
  constructor(services, { now = Date.now } = {}) {
    this.services = services;
    this.db = services.db;
    this.now = now;
  }

  #run(runId) {
    return this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
  }

  /** Every run in the attempt chain that contains `runId`, oldest first. */
  #attemptChain(runId) {
    const seen = new Map();
    const walkUp = (id) => {
      let current = this.#run(id);
      while (current && !seen.has(current.id)) {
        seen.set(current.id, current);
        current = current.parent_run_id
          ? this.#run(current.parent_run_id)
          : null;
      }
    };
    walkUp(runId);
    const queue = [...seen.keys()];
    while (queue.length) {
      const id = queue.shift();
      for (const child of this.db
        .prepare("SELECT * FROM runs WHERE parent_run_id = ?")
        .all(id)) {
        if (seen.has(child.id)) continue;
        seen.set(child.id, child);
        queue.push(child.id);
      }
    }
    return [...seen.values()].sort(
      (a, b) =>
        (a.attempt ?? 1) - (b.attempt ?? 1) || a.started_at - b.started_at,
    );
  }

  /** Adds one run and everything hanging off it to `graph`. */
  #addRun(graph, run, { task = null } = {}) {
    const runNode = graph.node({
      id: `run:${run.id}`,
      type: "run",
      label: `${run.provider} attempt ${run.attempt ?? 1}`,
      revision: run.provider_session_id ?? null,
      timestamp: run.started_at,
      runId: run.id,
      workspaceId: run.workspace_id,
      taskId: run.task_id,
      provider: run.provider,
      mode: run.mode,
      status: run.status,
      model: run.actual_model ?? null,
      attempt: run.attempt ?? 1,
      parentRunId: run.parent_run_id ?? null,
    });

    // Inputs: the run's own context manifest, else the task's manifest.
    const manifest = parseJson(run.context, {});
    const taskManifest = task ? parseJson(task.context, {}) : {};
    const files = manifest.files?.length
      ? manifest.files
      : (taskManifest.files ?? []);
    const documents = manifest.documents?.length
      ? manifest.documents
      : (taskManifest.documents ?? []);
    for (const file of files) {
      if (!file?.path) continue;
      const id = `input:${shortHash(`${file.path}|${file.revision ?? ""}`)}`;
      graph.node({
        id,
        type: "input",
        label: file.path,
        revision: file.revision ?? null,
        timestamp: manifest.createdAt ?? taskManifest.createdAt ?? null,
        bytes: file.bytes ?? null,
        kind: "file",
      });
      graph.edge(id, runNode, "input-of");
    }
    for (const doc of documents) {
      const id = `input:${shortHash(`doc|${doc.ref ?? doc.title}|${doc.revision ?? ""}`)}`;
      graph.node({
        id,
        type: "input",
        label: doc.title ?? String(doc.ref ?? "document"),
        revision: doc.revision ?? null,
        timestamp: manifest.createdAt ?? null,
        kind: "document",
      });
      graph.edge(id, runNode, "input-of");
    }

    // Tools and commands the run actually recorded.
    for (const event of this.db
      .prepare(
        "SELECT id, kind, message, tool, file, timestamp, provenance FROM events WHERE run_id = ? ORDER BY sequence ASC",
      )
      .all(run.id)) {
      if (!TOOL_KINDS.has(event.kind)) continue;
      const id = `tool:${event.id}`;
      graph.node({
        id,
        type: "tool",
        label: event.tool ?? event.kind,
        revision: null,
        timestamp: event.timestamp,
        kind: event.kind,
        file: event.file ?? null,
        provenance: event.provenance,
        runId: run.id,
      });
      graph.edge(runNode, id, "ran");
    }

    // Artifacts (output revisions): size and content hash, never contents.
    const artifacts = this.db
      .prepare(
        "SELECT id, kind, path, title, size, content, created_at FROM artifacts WHERE run_id = ? ORDER BY created_at ASC",
      )
      .all(run.id);
    const artifactIds = [];
    for (const artifact of artifacts) {
      const id = `artifact:${artifact.id}`;
      graph.node({
        id,
        type: "artifact",
        label: artifact.title ?? artifact.kind,
        revision:
          artifact.content !== null && artifact.content !== undefined
            ? `sha256:${shortHash(artifact.content)}`
            : null,
        timestamp: artifact.created_at,
        artifactId: artifact.id,
        kind: artifact.kind,
        path: artifact.path || null,
        size: artifact.size ?? 0,
        runId: run.id,
      });
      graph.edge(runNode, id, "produced");
      artifactIds.push(id);
    }
    return { runNode, artifactIds };
  }

  /** Adds the review decision and the accepted result for one task. */
  #addReview(graph, task, runNodes) {
    if (!task) return;
    const review = parseJson(task.review, {});
    if (!review.status) return;
    const reviewNode = graph.node({
      id: `review:${task.id}`,
      type: "review",
      label: `review ${review.status}`,
      revision: null,
      timestamp: review.decidedAt ?? task.updated_at ?? null,
      taskId: task.id,
      status: review.status,
      note: review.note ?? null,
      runId: review.runId ?? null,
      decidedBy: review.decidedBy ?? null,
    });
    const reviewed = runNodes.get(review.runId);
    if (reviewed) {
      if (reviewed.artifactIds.length)
        for (const artifactId of reviewed.artifactIds)
          graph.edge(artifactId, reviewNode, "reviewed-in");
      else graph.edge(reviewed.runNode, reviewNode, "reviewed-in");
    }
    if (review.status === "accepted") {
      const resultNode = graph.node({
        id: `result:${task.id}`,
        type: "result",
        label: task.title,
        revision: null,
        timestamp:
          task.completed_at ?? review.decidedAt ?? task.updated_at ?? null,
        taskId: task.id,
        runId: review.runId ?? null,
        accepted: true,
      });
      graph.edge(reviewNode, resultNode, "accepted-as");
    }
  }

  /** Lineage for one run, including its whole attempt chain. */
  forRun(runId) {
    const run = this.#run(runId);
    if (!run) throw new InputError("Run not found", 404);
    const chain = this.#attemptChain(runId);
    const graph = new Graph();
    const task = run.task_id
      ? this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(run.task_id)
      : null;
    const runNodes = new Map();
    for (const attempt of chain)
      runNodes.set(attempt.id, this.#addRun(graph, attempt, { task }));
    for (let i = 1; i < chain.length; i++)
      if (chain[i].parent_run_id)
        graph.edge(
          `run:${chain[i].parent_run_id}`,
          `run:${chain[i].id}`,
          "retried-as",
        );
    this.#addReview(graph, task, runNodes);
    const result = graph.result();
    return {
      ...result,
      focus: `run:${run.id}`,
      runIds: chain.map((attempt) => attempt.id),
      taskId: run.task_id ?? null,
      generatedAt: this.now(),
    };
  }

  /** Lineage for a task: every run on it plus the review and result. */
  forTask(taskId) {
    const task = this.db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(taskId);
    if (!task) throw new InputError("Task not found", 404);
    const runs = this.db
      .prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at ASC")
      .all(taskId);
    const graph = new Graph();
    const runNodes = new Map();
    for (const run of runs)
      runNodes.set(run.id, this.#addRun(graph, run, { task }));
    for (const run of runs)
      if (run.parent_run_id && runNodes.has(run.parent_run_id))
        graph.edge(`run:${run.parent_run_id}`, `run:${run.id}`, "retried-as");
    this.#addReview(graph, task, runNodes);
    const result = graph.result();
    return {
      ...result,
      focus: `result:${task.id}`,
      taskId,
      runIds: runs.map((run) => run.id),
      generatedAt: this.now(),
    };
  }

  /** Lineage across a workspace since a timestamp. */
  lineage({ workspaceId = null, since = 0 } = {}) {
    if (workspaceId && !this.services.hub.has(workspaceId))
      throw new InputError("Workspace not found", 404);
    const from = Number(since) || 0;
    const runs = workspaceId
      ? this.db
          .prepare(
            "SELECT * FROM runs WHERE workspace_id = ? AND started_at >= ? ORDER BY started_at ASC",
          )
          .all(workspaceId, from)
      : this.db
          .prepare(
            "SELECT * FROM runs WHERE started_at >= ? ORDER BY started_at ASC",
          )
          .all(from);
    const graph = new Graph();
    const tasks = new Map();
    const byTask = new Map();
    for (const run of runs) {
      let task = tasks.get(run.task_id);
      if (task === undefined) {
        task = run.task_id
          ? (this.db
              .prepare("SELECT * FROM tasks WHERE id = ?")
              .get(run.task_id) ?? null)
          : null;
        tasks.set(run.task_id, task);
      }
      const added = this.#addRun(graph, run, { task });
      if (!byTask.has(run.task_id)) byTask.set(run.task_id, new Map());
      byTask.get(run.task_id).set(run.id, added);
    }
    for (const run of runs)
      if (run.parent_run_id)
        graph.edge(`run:${run.parent_run_id}`, `run:${run.id}`, "retried-as");
    for (const [taskId, runNodes] of byTask)
      this.#addReview(graph, tasks.get(taskId) ?? null, runNodes);
    const result = graph.result();
    return {
      ...result,
      scope: { workspaceId, since: from },
      runIds: runs.map((run) => run.id),
      generatedAt: this.now(),
    };
  }
}

export function createLineage(services) {
  return new Lineage(services);
}
