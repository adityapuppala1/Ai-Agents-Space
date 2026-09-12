import { InputError } from "../../../core/src/TaskStore.js";
import {
  buildConversation,
  replyState,
} from "../../../core/src/runs/conversation.js";

/**
 * Managed-run routes. Register BEFORE routes/workspaces.js: it owns the
 * generic /api/workspaces/:id prefix and would 404 the task run sub-path.
 *
 *   POST /api/workspaces/:id/tasks/:taskId/run  {provider, agentId?, prompt?, model?, isolation?, policy?}
 *   GET  /api/runs/:id                           run + events + artifacts (no content) + approvals + context
 *   GET  /api/runs/:id/events?after=&limit=
 *   GET  /api/runs/:id/artifacts
 *   GET  /api/runs/:id/artifacts/:artifactId     (with content)
 *   POST /api/runs/:id/cancel
 *   POST /api/runs/:id/retry                     {prompt?}
 *   GET  /api/runs/:id/conversation              the exchange across every
 *                                                attempt in this chain
 *   POST /api/runs/:id/input                     {text}
 *   POST /api/runs/:id/review                    {decision:'accept'|'reject', note?}
 *   POST /api/runs/:id/worktree/apply            {check?} copies the reviewed
 *                                                changes into the working tree
 *                                                (uncommitted); check only tests
 *   POST /api/runs/:id/worktree/remove
 */
export default async function runRoutes(ctx) {
  const { method, path, send, body, services, db, hub, actor } = ctx;
  if (!path.startsWith("/api/")) return false;

  const launch = path.match(
    /^\/api\/workspaces\/([^/]+)\/tasks\/([^/]+)\/run$/,
  );
  if (launch && method === "POST") {
    const worker = requireWorker(services);
    const input = (await body()) ?? {};
    const run = await worker.start({
      workspaceId: decodeURIComponent(launch[1]),
      taskId: decodeURIComponent(launch[2]),
      provider: input.provider,
      agentId: input.agentId ?? null,
      prompt: input.prompt ?? null,
      model: input.model ?? null,
      isolation: input.isolation ?? null,
      policy: input.policy ?? null,
      actor,
    });
    send(201, run);
    return true;
  }

  const scoped = path.match(/^\/api\/runs\/([^/]+)(\/.*)?$/);
  if (!scoped) return false;
  const runId = decodeURIComponent(scoped[1]);
  const rest = scoped[2] ?? "";
  const worker = requireWorker(services);

  if (method === "GET" && rest === "") {
    send(200, worker.describe(runId));
    return true;
  }
  if (method === "GET" && rest === "/events") {
    const after = Number(ctx.query.get("after") ?? 0);
    const limit = Math.min(Number(ctx.query.get("limit") ?? 500), 5000);
    worker.recorder.get(runId);
    send(200, {
      events: worker.recorder.events(runId, {
        after: Number.isFinite(after) ? after : 0,
        limit: Number.isFinite(limit) && limit > 0 ? limit : 500,
      }),
    });
    return true;
  }
  if (method === "GET" && rest === "/conversation") {
    const chain = worker.recorder.chain(runId);
    const built = buildConversation(chain, (id) =>
      worker.recorder.events(id, { limit: 5000 }),
    );
    const latest = chain[chain.length - 1] ?? worker.recorder.get(runId);
    send(200, {
      runId,
      // The attempt a reply would continue from: the newest in the chain.
      latestRunId: latest.id,
      attempts: chain.map((run) => ({
        id: run.id,
        attempt: run.attempt ?? 1,
        status: run.status,
        startedAt: run.startedAt ?? null,
      })),
      ...built,
      reply: replyState(latest, worker.adapterFor(latest.provider), {
        active: worker.children?.has?.(latest.id) ?? false,
      }),
    });
    return true;
  }
  if (method === "GET" && rest === "/artifacts") {
    worker.recorder.get(runId);
    send(200, worker.recorder.artifacts(runId));
    return true;
  }
  const artifact = rest.match(/^\/artifacts\/([^/]+)$/);
  if (method === "GET" && artifact) {
    const item = worker.recorder.artifact(decodeURIComponent(artifact[1]));
    if (item.runId !== runId) throw new InputError("Artifact not found", 404);
    send(200, item);
    return true;
  }
  if (method === "POST" && rest === "/cancel") {
    send(200, await worker.cancel(runId, { actor }));
    return true;
  }
  if (method === "POST" && rest === "/retry") {
    let input = {};
    try {
      input = (await body()) ?? {};
    } catch (error) {
      if (!(error instanceof InputError) || error.status !== 415) throw error;
    }
    send(
      201,
      await worker.retry(runId, {
        actor,
        prompt: input.prompt ?? null,
        force: input.force === true,
      }),
    );
    return true;
  }
  if (method === "POST" && rest === "/input") {
    const input = (await body()) ?? {};
    send(201, await worker.input(runId, input.text, { actor }));
    return true;
  }
  if (method === "POST" && rest === "/review") {
    const input = (await body()) ?? {};
    send(200, reviewRun({ db, hub, worker, runId, input, actor, services }));
    return true;
  }
  if (method === "POST" && rest === "/worktree/apply") {
    const input = (await body()) ?? {};
    send(
      200,
      await worker.applyWorktree(runId, { actor, check: input.check === true }),
    );
    return true;
  }
  if (method === "POST" && rest === "/worktree/remove") {
    send(200, await worker.removeWorktree(runId, { actor }));
    return true;
  }
  return false;
}

function requireWorker(services) {
  if (!services.runWorker)
    throw new InputError("Managed runs are not enabled on this server", 503);
  return services.runWorker;
}

/**
 * Records the human review on the task. Accept completes the task; reject
 * keeps it where it is with the note attached so the run can be retried.
 */
function reviewRun({ db, hub, worker, runId, input, actor, services }) {
  const decision = input?.decision;
  if (!["accept", "reject"].includes(decision))
    throw new InputError('decision must be "accept" or "reject"');
  const note =
    input.note === undefined || input.note === null ? "" : String(input.note);
  if (note.length > 2000)
    throw new InputError("note must be under 2000 characters");
  const run = worker.recorder.get(runId);
  if (run.mode !== "managed")
    throw new InputError("Only managed runs can be reviewed", 409);
  if (
    !["completed", "failed", "cancelled", "disconnected"].includes(run.status)
  )
    throw new InputError(
      `Run is still ${run.status}; review it once it finishes`,
      409,
    );
  const workspace = hub.get(run.workspaceId);
  const task = workspace.store.get(run.taskId);
  // Roadmap section 12: never accept a result whose pinned inputs changed
  // underneath it. Re-review is forced unless the reviewer acknowledges the
  // drift explicitly, because the patch may reference stale line numbers.
  if (decision === "accept" && input?.acknowledgeStale !== true) {
    const gate = services?.context?.gateApply?.({ runId });
    if (gate && gate.action === "re-review") {
      const paths = gate.stale
        .map((entry) => entry.path)
        .slice(0, 5)
        .join(", ");
      throw new InputError(
        `Inputs changed since this run started (${paths}${gate.stale.length > 5 ? ", …" : ""}). Re-review the result, or accept again with acknowledgeStale to record that you checked.`,
        409,
      );
    }
  }
  const review = {
    runId,
    status: decision === "accept" ? "accepted" : "rejected",
    note,
    decidedBy: actor,
    decidedAt: Date.now(),
  };
  db.prepare("UPDATE tasks SET review = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(review),
    Date.now(),
    task.id,
  );
  let updatedTask = task;
  if (decision === "accept") {
    if (task.status === "BLOCKED")
      updatedTask = workspace.update(task.id, { status: "IN_PROGRESS" });
    if (updatedTask.status !== "COMPLETED")
      updatedTask = workspace.update(task.id, { status: "COMPLETED" });
  }
  worker.recorder.applyEvent(runId, {
    kind: decision === "accept" ? "complete" : "status",
    provenance: "user",
    summary:
      decision === "accept"
        ? `Review accepted${note ? `: ${note.slice(0, 120)}` : ""}`
        : `Review rejected${note ? `: ${note.slice(0, 120)}` : ""}`,
    data: { review },
    timestamp: Date.now(),
  });
  try {
    services.audit?.record?.({
      actor,
      action: `run.review.${decision}`,
      target: runId,
      workspaceId: run.workspaceId,
      runId,
      policyDecision: null,
      details: { note, taskId: task.id },
    });
  } catch {
    /* best effort */
  }
  if (decision === "accept") {
    // Dependents are dispatched best effort; onTaskCompleted is async.
    Promise.resolve()
      .then(() => services.graph?.onTaskCompleted?.(task.id))
      .catch(() => {});
  }
  return { run: worker.get(runId), task: updatedTask, review };
}
