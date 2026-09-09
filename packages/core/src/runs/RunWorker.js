import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { InputError } from "../TaskStore.js";
import {
  PROVIDERS,
  DEFAULT_POLICY,
  TERMINAL_RUN_STATUSES,
} from "../contracts.js";
import { RunRecorder } from "./RunRecorder.js";
import { defaultAdapters, adapterFor } from "../adapters/index.js";
import {
  buildPrompt,
  extraDirsFor,
  commandLine,
  clip,
} from "../adapters/base.js";
import { resolveBinary, spawnProvider, killTree, isAlive } from "./process.js";
import { isWithin } from "../policy/Policy.js";
import {
  isGitRepo,
  repoRoot,
  currentBranch,
  createWorktree,
  removeWorktree,
} from "./worktree.js";
import {
  captureGitDiff,
  captureTestOutput,
  finalMessage,
  formatTestOutput,
} from "./artifacts.js";

const ACTIVE_STATUSES = ["running", "waiting_approval", "blocked", "stale"];
const RECONCILE_STATUSES = [...ACTIVE_STATUSES, "queued"];
export const DISCONNECTED_ERROR =
  "server restarted before the run finished; reconcile before retrying";
export const CANCEL_MESSAGE =
  "Run cancelled by user; side effects already made are not undone";
export const SHUTDOWN_ERROR = "server shut down while the run was active";

/** Isolation the policy engine (or the preset, without one) requires. */
function enforcedIsolation(effective, requested) {
  if (effective?.autonomy === "sandbox") return "worktree";
  const fromPolicy = effective?.isolation;
  return ["none", "worktree"].includes(fromPolicy) ? fromPolicy : requested;
}

function json(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function rowToTask(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    description: row.description ?? "",
    priority: row.priority,
    status: row.status,
    progress: row.progress,
    source: row.source,
    assignedAgentId: row.assigned_agent_id ?? null,
    dependsOn: json(row.depends_on, []),
    deliverable: row.deliverable ?? "",
    target: json(row.target, {}),
    provider: row.provider ?? null,
    executionPolicy: json(row.execution_policy, {}),
    templateId: row.template_id ?? null,
    workflowId: row.workflow_id ?? null,
    context: json(row.context, {}),
    review: json(row.review, {}),
  };
}

/**
 * Executes managed runs: validates the launch against workspace policy,
 * queues per-workspace concurrency, spawns the provider CLI through its
 * adapter, feeds the normalized events into RunRecorder, captures artifacts,
 * and keeps cancel/retry/input/reconcile honest about what really happened.
 *
 * new RunWorker(services, {
 *   recorder = services.recorder ?? new RunRecorder(services),
 *   adapters = defaultAdapters,
 *   spawn = spawnProvider,
 *   now = Date.now,
 *   dataDir = process.env.AGENT_SPACE_DATA_DIR ?? "data",
 *   env = process.env,
 *   kill = killTree,
 * })
 */
export class RunWorker {
  constructor(services, options = {}) {
    this.services = services;
    this.db = services.db;
    this.hub = services.hub;
    this.bus = services.bus;
    this.recorder =
      options.recorder ?? services.recorder ?? new RunRecorder(services);
    this.adapters = options.adapters ?? defaultAdapters;
    this.spawn = options.spawn ?? spawnProvider;
    this.now = options.now ?? Date.now;
    this.env = options.env ?? process.env;
    this.kill = options.kill ?? killTree;
    this.dataDir = resolve(
      options.dataDir ?? this.env.AGENT_SPACE_DATA_DIR ?? "data",
    );
    this.children = new Map(); // runId → entry
    this.specs = new Map(); // runId → launch spec (queued or running)
    this.queues = new Map(); // workspaceId → [runId]
    this.waiters = new Map(); // runId → [resolve]
    services.onClose?.(() => this.close());
  }

  // ---------------------------------------------------------------- lookups

  adapterFor(provider) {
    return adapterFor(provider, {
      adapters: this.adapters,
      settings: this.services.settings ?? null,
    });
  }

  taskRecord(workspaceId, taskId) {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE id = ? AND workspace_id = ?")
      .get(taskId, workspaceId);
    if (!row) throw new InputError("Task not found", 404);
    return rowToTask(row);
  }

  policyFor(workspaceId, task = null, override = null) {
    let base = null;
    try {
      base = this.services.policy?.forWorkspace?.(workspaceId) ?? null;
    } catch {
      base = null;
    }
    if (!base) {
      const row = this.db
        .prepare("SELECT policy FROM workspaces WHERE id = ?")
        .get(workspaceId);
      base = { ...DEFAULT_POLICY, ...json(row?.policy, {}) };
    }
    const merged = { ...base, ...(task?.executionPolicy ?? {}) };
    if (override && typeof override === "object")
      Object.assign(merged, override);
    if (!merged.maxConcurrentRuns || merged.maxConcurrentRuns < 1)
      merged.maxConcurrentRuns = DEFAULT_POLICY.maxConcurrentRuns;
    return merged;
  }

  evaluateLaunch({ workspace, provider, isolation, policy }) {
    const policyService = this.services.policy;
    if (policyService?.evaluateLaunch) {
      // The merged run-level policy (task execution_policy + launch request)
      // is passed as an override; the engine only lets it tighten the
      // workspace policy, never widen it.
      const verdict = policyService.evaluateLaunch({
        workspace,
        provider,
        isolation,
        override: policy,
      });
      return {
        allowed: verdict?.allowed !== false,
        reason: verdict?.reason ?? null,
        effective: verdict?.effective ?? policy,
      };
    }
    if (policy.autonomy === "observe-only")
      return {
        allowed: false,
        reason: "Workspace policy is observe-only: launches are disabled",
        effective: policy,
      };
    return { allowed: true, reason: null, effective: policy };
  }

  providerAvailability(provider) {
    const connections = this.services.connections;
    if (!connections?.list) return { ok: true, connectionId: null };
    let rows = [];
    try {
      rows = (connections.list() ?? []).filter((c) => c.provider === provider);
    } catch {
      return { ok: true, connectionId: null };
    }
    if (!rows.length) return { ok: true, connectionId: null };
    const usable = rows.find(
      (c) =>
        (c.enabled === undefined || c.enabled === true || c.enabled === 1) &&
        ["ready", "detected"].includes(c.status),
    );
    if (!usable)
      return {
        ok: false,
        connectionId: null,
        reason: `${PROVIDERS[provider]?.name ?? provider} is not available: ${
          rows[0].error ?? `connection status is ${rows[0].status}`
        }`,
      };
    return { ok: true, connectionId: usable.id ?? null };
  }

  pickAgent(workspace, agentId, provider) {
    if (agentId) return workspace.profiles.get(agentId);
    const snapshot = workspace.snapshot();
    const idle = snapshot.agents.filter((a) => !a.taskId && !a.archivedAt);
    const byProvider = this.db
      .prepare(
        "SELECT id FROM agent_profiles WHERE workspace_id = ? AND provider = ? AND archived_at IS NULL ORDER BY position",
      )
      .all(workspace.id, provider)
      .map((row) => row.id);
    const preferred = idle.find((a) => byProvider.includes(a.id));
    const agent = preferred ?? idle[0];
    if (!agent)
      throw new InputError(
        "No available agent in this workspace; add one or wait for a run to finish",
        409,
      );
    return workspace.profiles.get(agent.id);
  }

  activeCount(workspaceId) {
    return this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM runs WHERE workspace_id = ? AND mode = 'managed' AND status IN (${ACTIVE_STATUSES.map(() => "?").join(",")})`,
      )
      .get(workspaceId, ...ACTIVE_STATUSES).n;
  }

  audit(
    action,
    run,
    details = {},
    policyDecision = null,
    actor = "local-user",
  ) {
    try {
      this.services.audit?.record?.({
        actor,
        action,
        target: run?.id ?? null,
        workspaceId: run?.workspaceId ?? details.workspaceId ?? null,
        runId: run?.id ?? null,
        policyDecision,
        details,
      });
    } catch {
      /* audit is best effort */
    }
  }

  system(runId, summary, data = {}, kind = "system") {
    try {
      this.recorder.applyEvent(runId, {
        kind,
        provenance: "system",
        summary,
        data,
        timestamp: this.now(),
      });
    } catch {
      /* run may be gone */
    }
  }

  // ----------------------------------------------------------------- start

  /**
   * start({ workspaceId, taskId, provider, agentId?, prompt?, policy?, model?,
   *         isolation?, resumeSessionId?, parentRunId?, attempt?, actor? })
   * → run (status "running" or "queued")
   */
  async start(input = {}) {
    const {
      workspaceId,
      taskId,
      agentId = null,
      prompt: promptOverride = null,
      policy: policyOverride = null,
      model: modelOverride = null,
      isolation: isolationOverride = null,
      resumeSessionId = null,
      parentRunId = null,
      attempt = 1,
      actor = "local-user",
    } = input;
    if (!workspaceId || typeof workspaceId !== "string")
      throw new InputError("workspaceId is required");
    if (!taskId || typeof taskId !== "string")
      throw new InputError("taskId is required");
    const workspace = this.hub.get(workspaceId);
    const task = this.taskRecord(workspaceId, taskId);
    const provider = input.provider ?? task.provider;
    if (!provider || !PROVIDERS[provider])
      throw new InputError(
        `Unknown provider "${provider ?? ""}". Choose one of ${Object.keys(PROVIDERS).join(", ")}`,
      );
    if (task.status === "COMPLETED")
      throw new InputError("Completed tasks cannot be run again", 409);
    const adapter = this.adapterFor(provider);
    if (!adapter)
      throw new InputError(`No adapter for provider ${provider}`, 409);
    const availability = this.providerAvailability(provider);
    if (!availability.ok) throw new InputError(availability.reason, 409);

    const policy = this.policyFor(workspaceId, task, policyOverride);
    const requestedIsolation = isolationOverride ?? policy.isolation ?? null;
    if (
      requestedIsolation !== null &&
      !["none", "worktree"].includes(requestedIsolation)
    )
      throw new InputError('isolation must be "none" or "worktree"');
    let isolation =
      requestedIsolation ??
      (policy.autonomy === "sandbox" ? "worktree" : "none");
    const record = workspace.record;
    const verdict = this.evaluateLaunch({
      workspace: record,
      provider,
      isolation,
      policy,
    });
    if (!verdict.allowed) {
      this.audit(
        "run.refused",
        null,
        { workspaceId, taskId, provider, reason: verdict.reason },
        "deny",
        actor,
      );
      throw new InputError(
        verdict.reason ?? "Workspace policy does not allow launching runs",
        403,
      );
    }
    const effective = verdict.effective ?? policy;
    if (effective.autonomy === "observe-only")
      throw new InputError(
        "Workspace policy is observe-only: launches are disabled",
        403,
      );
    // The policy engine's verdict wins over the request: a sandbox
    // workspace always runs in a worktree, whatever the caller asked for.
    const forcedIsolation = enforcedIsolation(effective, isolation);
    const isolationForced = forcedIsolation !== isolation;
    if (isolationForced) {
      this.audit(
        "run.isolation.forced",
        null,
        {
          workspaceId,
          taskId,
          provider,
          requested: isolation,
          effective: forcedIsolation,
          autonomy: effective.autonomy,
        },
        "allow",
        actor,
      );
      isolation = forcedIsolation;
    }

    const cwd = record.rootPath ?? task.target?.folder ?? null;
    if (!cwd)
      throw new InputError(
        "Workspace has no root path; set one before running tasks",
      );
    if (!existsSync(cwd))
      throw new InputError(`Workspace root path does not exist: ${cwd}`);
    // Extra directories handed to the provider (--add-dir) must stay inside
    // what the policy already allows; otherwise the launch would grant
    // writes the hook policy denies.
    const extraDirs = extraDirsFor({ task, cwd });
    const allowedScopes = [
      record.rootPath,
      ...(effective.allowedFolders ?? policy.allowedFolders ?? []),
    ].filter(Boolean);
    const outside = extraDirs.filter(
      (dir) => !allowedScopes.some((scope) => isWithin(dir, scope)),
    );
    if (outside.length)
      throw new InputError(
        `Task target folder ${outside[0]} is outside the workspace root and the policy's allowedFolders; add it to allowedFolders or move the task`,
        403,
      );

    const agent = this.pickAgent(workspace, agentId, provider);
    const model = modelOverride ?? agent.model ?? null;
    const binary = resolveBinary(provider, this.env, {
      names: adapter.launchBinaries ?? null,
    });
    if (!binary.resolved)
      throw new InputError(
        `${PROVIDERS[provider].name} binary not found${
          adapter.missingBinaryHint ? `: ${adapter.missingBinaryHint}` : ""
        }. Set AGENT_SPACE_BIN_${provider.toUpperCase().replace(/-/g, "_")} or install the CLI.`,
        409,
      );
    if (resumeSessionId && !adapter.supportsResume)
      throw new InputError(
        `${adapter.name} does not support resuming a session`,
        409,
      );

    const prompt =
      typeof promptOverride === "string" && promptOverride.trim()
        ? promptOverride
        : buildPrompt({
            task,
            workspace: record,
            agent,
            context: task.context,
          });
    const context = {
      ...(task.context ?? {}),
      target: task.target ?? {},
      files: task.target?.files ?? [],
      folder: task.target?.folder ?? null,
      promptSource: promptOverride ? "user" : "task",
    };
    const queued = this.activeCount(workspaceId) >= effective.maxConcurrentRuns;
    const run = this.recorder.ensureRun({
      workspaceId,
      agentId: agent.id,
      mode: "managed",
      provider,
      taskId,
      cwd,
      host: "local",
      prompt,
      requestedModel: model,
      connectionId: availability.connectionId,
      context,
      configSnapshot: {
        provider,
        adapter: adapter.id,
        binary: binary.command,
        model,
        isolation,
        requestedIsolation: isolationForced ? requestedIsolation : undefined,
        extraDirs,
        policy: {
          autonomy: effective.autonomy,
          maxConcurrentRuns: effective.maxConcurrentRuns,
          timeoutMs: effective.timeoutMs ?? null,
        },
        resumeSessionId,
        queued,
      },
      status: queued ? "queued" : "running",
      startedAt: this.now(),
      parentRunId,
      attempt,
    });
    if (task.status === "BLOCKED") {
      try {
        workspace.store.update(task.id, { status: "IN_PROGRESS" });
      } catch {
        /* keep going; the run itself is valid */
      }
    }
    if (isolationForced)
      this.system(
        run.id,
        `Isolation forced to a Git worktree by the “${effective.autonomy}” preset (requested: ${requestedIsolation ?? "default"})`,
        { requested: requestedIsolation, effective: isolation },
        "status",
      );
    this.specs.set(run.id, {
      runId: run.id,
      workspaceId,
      taskId,
      provider,
      adapter,
      binary,
      policy: effective,
      isolation,
      extraDirs,
      cwd,
      prompt,
      model,
      resumeSessionId,
      task,
      agent,
      workspace: record,
      actor,
    });
    if (queued) {
      const queue = this.queues.get(workspaceId) ?? [];
      queue.push(run.id);
      this.queues.set(workspaceId, queue);
      this.system(
        run.id,
        `Queued: workspace already runs ${effective.maxConcurrentRuns} managed run${
          effective.maxConcurrentRuns === 1 ? "" : "s"
        }; will start when a slot frees`,
        { maxConcurrentRuns: effective.maxConcurrentRuns },
        "status",
      );
      this.audit("run.queue", run, { provider, taskId }, "allow", actor);
      return this.recorder.get(run.id);
    }
    await this.launch(run.id);
    return this.recorder.get(run.id);
  }

  async launch(runId) {
    const spec = this.specs.get(runId);
    if (!spec) throw new InputError("Launch spec missing for run", 500);
    const { adapter, policy } = spec;
    const recorder = this.recorder;
    let cwd = spec.cwd;
    let worktree = null;
    let branch = null;
    try {
      const gitRepo = await isGitRepo(cwd);
      if (gitRepo) branch = await currentBranch(cwd);
      if (spec.isolation === "worktree") {
        if (gitRepo) {
          const root = await repoRoot(cwd);
          const created = await createWorktree(root, runId, this.dataDir);
          cwd = created.path;
          worktree = created.path;
          branch = created.branch;
          recorder.update(runId, {
            context: { ...recorder.get(runId).context, repoRoot: root },
          });
          this.system(
            runId,
            `Created isolated worktree on branch ${created.branch}`,
            { worktree: created.path, branch: created.branch, repoRoot: root },
          );
        } else {
          this.system(
            runId,
            "Worktree isolation requested but the folder is not a Git repository; running in place",
            { cwd },
            "status",
          );
        }
      }
      const extraDirs = spec.extraDirs ?? [];
      let hooksInstalled = false;
      try {
        hooksInstalled =
          this.services.settings?.get?.("hooks.claudeCode.installed", false) ===
          true;
      } catch {
        hooksInstalled = false;
      }
      const launch = adapter.build({
        run: recorder.get(runId),
        task: spec.task,
        agent: spec.agent,
        workspace: spec.workspace,
        policy,
        prompt: spec.prompt,
        binary: spec.binary,
        cwd,
        extraDirs,
        model: spec.model,
        resumeSessionId: spec.resumeSessionId,
        hooksInstalled,
        settings: this.services.settings ?? null,
      });
      const command = commandLine(launch.command, launch.args ?? []);
      const current = recorder.get(runId);
      recorder.update(runId, {
        status: "running",
        cwd,
        worktree,
        branch,
        configSnapshot: {
          ...current.configSnapshot,
          command,
          args: launch.args ?? [],
          cwd,
          worktree,
          branch,
          extraDirs,
          queued: false,
          transport: adapter.transport,
        },
      });
      const state = { sessionId: spec.resumeSessionId ?? null, model: null };
      const entry = {
        runId,
        workspaceId: spec.workspaceId,
        adapter,
        state,
        spec,
        child: null,
        exiting: false,
        cancelled: false,
        timedOut: false,
        finalized: false,
        sessionRecorded: false,
        stderr: [],
        startedAt: this.now(),
      };
      const env = { ...this.env, ...(launch.env ?? {}) };
      const child = this.spawn({
        command: launch.command,
        args: launch.args ?? [],
        cwd: launch.cwd ?? cwd,
        env,
        stdin: launch.stdin ?? "ignore",
        onLine: (line) => this.handleLine(entry, line),
        onStderr: (line) => this.handleStderr(entry, line),
        onExit: (code, signal, error) =>
          this.handleExit(entry, code, signal, error),
      });
      entry.child = child;
      this.children.set(runId, entry);
      recorder.update(runId, { pid: child?.pid ?? null });
      this.system(runId, `Launched ${adapter.name}: ${clip(command, 160)}`, {
        command,
        // What was actually executed (an npm .cmd shim resolves to node + script).
        spawnfile: child?.spawnfile ?? null,
        pid: child?.pid ?? null,
        cwd,
      });
      this.audit(
        "run.start",
        recorder.get(runId),
        { provider: spec.provider, command, cwd, isolation: spec.isolation },
        "allow",
        spec.actor,
      );
      if (spec.resumeSessionId) this.recordSession(entry);
      if (typeof adapter.attach === "function")
        adapter.attach(child, state, {
          run: recorder.get(runId),
          services: this.services,
          launch,
          emit: (event) => this.applyEvent(entry, event),
          fail: (message) => this.failLaunch(entry, message),
          approvalTimeoutMs: policy.approvalTimeoutMs ?? null,
        });
      const timeoutMs = Number(policy.timeoutMs);
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        entry.timer = setTimeout(() => this.timeout(entry), timeoutMs);
        entry.timer.unref?.();
      }
    } catch (error) {
      this.specs.delete(runId);
      recorder.setStatus(runId, "failed", {
        error: `Could not start ${spec.provider}: ${error.message}`.slice(
          0,
          500,
        ),
      });
      this.audit(
        "run.failed",
        recorder.get(runId),
        { error: error.message },
        null,
        spec.actor,
      );
      this.settle(runId);
      this.drain(spec.workspaceId);
    }
  }

  // --------------------------------------------------------------- streams

  handleLine(entry, line) {
    if (entry.finalized) return;
    let events = [];
    try {
      events = entry.adapter.parse(line, entry.state) ?? [];
    } catch (error) {
      events = [
        {
          kind: "status",
          provenance: "system",
          summary: `Could not parse provider output: ${clip(error.message, 100)}`,
          data: { line: line.slice(0, 500) },
        },
      ];
    }
    for (const event of events) this.applyEvent(entry, event);
    if (entry.state.sessionId && !entry.sessionRecorded)
      this.recordSession(entry);
    if (entry.state.finished && !entry.exiting) this.terminate(entry);
  }

  handleStderr(entry, line) {
    entry.stderr.push(line);
    if (entry.stderr.length > 50) entry.stderr.shift();
  }

  applyEvent(entry, event) {
    if (!event) return;
    try {
      this.recorder.applyEvent(entry.runId, {
        timestamp: this.now(),
        ...event,
      });
    } catch {
      /* run removed or event invalid */
    }
    if (
      event.kind === "session.start" &&
      entry.state.sessionId &&
      !entry.sessionRecorded
    )
      this.recordSession(entry);
  }

  recordSession(entry) {
    const sessionId = entry.state.sessionId;
    if (!sessionId) return;
    entry.sessionRecorded = true;
    const provider = entry.adapter.provider;
    const existing = this.recorder.find({
      provider,
      providerSessionId: sessionId,
    });
    const run = this.recorder.get(entry.runId);
    if (!existing) {
      this.recorder.update(entry.runId, { providerSessionId: sessionId });
    } else if (existing.id !== entry.runId) {
      this.recorder.update(entry.runId, {
        configSnapshot: {
          ...run.configSnapshot,
          providerSessionId: sessionId,
          resumedFromRun: existing.id,
        },
      });
    }
  }

  /** JSON-RPC transports never exit by themselves; close stdin then kill. */
  terminate(entry) {
    entry.exiting = true;
    try {
      entry.child?.stdin?.end?.();
    } catch {
      /* ignore */
    }
    const timer = setTimeout(() => {
      if (!entry.finalized) this.kill(entry.child?.pid);
    }, 750);
    timer.unref?.();
  }

  failLaunch(entry, message) {
    if (entry.finalized || entry.exiting) return;
    entry.state.error = entry.state.error ?? message;
    this.system(
      entry.runId,
      `Provider handshake failed: ${clip(message, 200)}`,
      {},
      "error",
    );
    this.terminate(entry);
  }

  timeout(entry) {
    if (entry.finalized || entry.exiting) return;
    entry.timedOut = true;
    entry.exiting = true;
    this.system(
      entry.runId,
      `Run exceeded the policy timeout of ${Math.round((entry.spec.policy.timeoutMs ?? 0) / 1000)} s; stopping it. Side effects already made are not undone`,
      {},
      "error",
    );
    this.kill(entry.child?.pid);
  }

  async handleExit(entry, code, signal, spawnError) {
    if (entry.finalized) return;
    entry.finalized = true;
    if (entry.timer) clearTimeout(entry.timer);
    this.children.delete(entry.runId);
    this.specs.delete(entry.runId);
    try {
      await this.finishRun(entry, code, signal, spawnError);
    } catch (error) {
      // The database may already be closed (shutdown) or the run removed;
      // never let a provider exit become an unhandled rejection.
      this.services.log?.warn?.(
        `[runs] could not finalize run ${entry.runId}: ${error?.message ?? error}`,
      );
    } finally {
      this.settle(entry.runId);
      try {
        this.drain(entry.workspaceId);
      } catch {
        /* database closed */
      }
    }
  }

  async finishRun(entry, code, signal, spawnError) {
    const recorder = this.recorder;
    const run = recorder.get(entry.runId);
    let final = null;
    try {
      final = entry.adapter.finalize(entry.state, code) ?? {};
    } catch (error) {
      final = { status: "failed", error: `finalize failed: ${error.message}` };
    }
    const updates = {};
    if (final.usage && typeof final.usage === "object")
      updates.usage = {
        ...final.usage,
        reportedBy: final.usage.reportedBy ?? "provider",
      };
    if (final.cost && typeof final.cost === "object") updates.cost = final.cost;
    if (final.model && !run.actualModel) updates.actualModel = final.model;
    if (Object.keys(updates).length) recorder.update(entry.runId, updates);
    if (final.sessionId && !entry.sessionRecorded) {
      entry.state.sessionId = final.sessionId;
      this.recordSession(entry);
    }
    await this.captureArtifacts(entry, final);
    if (entry.cancelled) {
      // Status was set when the cancellation was requested.
      this.system(
        entry.runId,
        `Provider process ended after cancellation (exit ${code ?? signal ?? "unknown"})`,
        { exitCode: code, signal },
        "status",
      );
      recorder.update(entry.runId, { exitCode: code ?? null });
    } else if (entry.timedOut) {
      recorder.setStatus(entry.runId, "failed", {
        error: "timed out",
        exitCode: code ?? null,
      });
      this.audit(
        "run.timeout",
        run,
        { exitCode: code },
        null,
        entry.spec.actor,
      );
    } else if (spawnError) {
      recorder.setStatus(entry.runId, "failed", {
        error:
          `Could not start ${entry.adapter.name}: ${spawnError.message}`.slice(
            0,
            500,
          ),
        exitCode: code ?? null,
      });
      this.audit(
        "run.failed",
        run,
        { error: spawnError.message },
        null,
        entry.spec.actor,
      );
    } else {
      let status = final.status ?? (code === 0 ? "completed" : "failed");
      if (!["completed", "failed", "cancelled"].includes(status))
        status = "failed";
      let error = final.error ?? null;
      if (status === "failed" && !error)
        error = `${entry.adapter.name} exited with code ${code ?? signal ?? "unknown"}`;
      if (
        status === "failed" &&
        entry.stderr.length &&
        error &&
        error.length < 200
      ) {
        const tail = entry.stderr.slice(-3).join(" | ");
        if (tail.trim()) error = `${error} — ${clip(tail, 250)}`;
      }
      recorder.setStatus(entry.runId, status, {
        error: status === "failed" ? error : null,
        exitCode: code ?? null,
        summary:
          status === "completed"
            ? `Run completed for “${run.title ?? "task"}”; review the changes`
            : null,
      });
      this.audit(
        status === "completed" ? "run.complete" : "run.failed",
        run,
        { exitCode: code, error },
        null,
        entry.spec.actor,
      );
      if (status === "completed") {
        try {
          await this.services.workflows?.onTaskCompleted?.(run.taskId);
        } catch (error) {
          this.system(
            entry.runId,
            `Workflow follow-up failed: ${clip(error.message, 150)}`,
            {},
            "status",
          );
        }
      }
    }
  }

  async captureArtifacts(entry, final = {}) {
    const recorder = this.recorder;
    const run = recorder.get(entry.runId);
    const cwd = run.worktree ?? run.cwd;
    try {
      const diff = await captureGitDiff(cwd);
      if (diff.isRepo && (diff.diff.trim() || diff.status.trim())) {
        recorder.addArtifact(entry.runId, {
          kind: "diff",
          path: cwd,
          title: "Changes (git diff)",
          content: diff.diff,
          metadata: {
            status: diff.status,
            files: diff.files,
            truncated: diff.truncated,
            skippedSecretPaths: diff.skipped ?? [],
            worktree: run.worktree,
            branch: run.branch,
            capturedAt: this.now(),
          },
        });
      } else if (diff.isRepo) {
        this.system(
          entry.runId,
          "No file changes detected by git",
          {},
          "status",
        );
      }
    } catch (error) {
      this.system(
        entry.runId,
        `Could not capture git diff: ${clip(error.message, 150)}`,
        {},
        "status",
      );
    }
    const events = recorder.events(entry.runId, { limit: 5000 });
    const tests = captureTestOutput(events);
    if (tests.length)
      recorder.addArtifact(entry.runId, {
        kind: "test-output",
        title: `Test output (${tests.length} run${tests.length === 1 ? "" : "s"})`,
        content: formatTestOutput(tests),
        metadata: {
          count: tests.length,
          commands: tests.map((t) => t.command),
        },
      });
    const message = finalMessage(events) ?? final.finalText ?? null;
    if (message)
      recorder.addArtifact(entry.runId, {
        kind: "message",
        title: "Final message",
        content: String(message),
        metadata: { provenance: "provider" },
      });
  }

  // -------------------------------------------------------------- controls

  async cancel(runId, { actor = "local-user" } = {}) {
    const run = this.recorder.get(runId);
    if (run.mode !== "managed")
      throw new InputError("Only managed runs can be cancelled here", 409);
    if (
      TERMINAL_RUN_STATUSES.includes(run.status) ||
      run.status === "disconnected"
    )
      throw new InputError(`Run already ${run.status}`, 409);
    if (run.status === "queued") {
      const queue = this.queues.get(run.workspaceId) ?? [];
      this.queues.set(
        run.workspaceId,
        queue.filter((id) => id !== runId),
      );
      this.specs.delete(runId);
      this.recorder.setStatus(runId, "cancelled", { summary: CANCEL_MESSAGE });
      this.audit("run.cancel", run, { queued: true }, null, actor);
      this.settle(runId);
      return this.recorder.get(runId);
    }
    const entry = this.children.get(runId);
    if (!entry)
      throw new InputError(
        "Run is not attached to this server; reconcile before retrying",
        409,
      );
    entry.cancelled = true;
    entry.exiting = true;
    if (entry.timer) clearTimeout(entry.timer);
    this.recorder.setStatus(runId, "cancelled", { summary: CANCEL_MESSAGE });
    this.audit(
      "run.cancel",
      run,
      { pid: entry.child?.pid ?? null },
      null,
      actor,
    );
    let interrupted = false;
    try {
      interrupted =
        entry.adapter.interrupt?.(entry.child, entry.state) === true;
    } catch {
      interrupted = false;
    }
    const pid = entry.child?.pid;
    if (interrupted) {
      const timer = setTimeout(() => {
        if (!entry.finalized) this.kill(pid);
      }, 1000);
      timer.unref?.();
    } else await this.kill(pid);
    return this.recorder.get(runId);
  }

  async retry(
    runId,
    { actor = "local-user", prompt = null, force = false } = {},
  ) {
    const run = this.recorder.get(runId);
    if (run.mode !== "managed")
      throw new InputError("Only managed runs can be retried", 409);
    if (
      !TERMINAL_RUN_STATUSES.includes(run.status) &&
      run.status !== "disconnected"
    )
      throw new InputError(`Run is still ${run.status}; cancel it first`, 409);
    if (run.status === "disconnected") {
      if (run.pid && !this.children.has(runId) && isAlive(run.pid) && !force)
        throw new InputError(
          `Provider process ${run.pid} from the disconnected run may still be running; stop it first (or retry with force: true) to avoid duplicate execution`,
          409,
        );
      this.system(
        runId,
        "Retrying a disconnected run: check the provider's own session for work already done before trusting the new attempt",
        {},
        "status",
      );
    }
    const next = await this.start({
      workspaceId: run.workspaceId,
      taskId: run.taskId,
      agentId: run.agentId,
      provider: run.provider,
      prompt: prompt ?? run.prompt,
      model: run.requestedModel,
      isolation: run.configSnapshot?.isolation ?? null,
      parentRunId: run.id,
      attempt: (run.attempt ?? 1) + 1,
      actor,
    });
    this.audit("run.retry", next, { parentRunId: run.id }, null, actor);
    return next;
  }

  async input(runId, text, { actor = "local-user" } = {}) {
    if (typeof text !== "string" || !text.trim())
      throw new InputError("text is required");
    const run = this.recorder.get(runId);
    if (run.mode !== "managed")
      throw new InputError("Only managed runs accept input", 409);
    const adapter = this.adapterFor(run.provider);
    if (!adapter?.supportsResume)
      throw new InputError(
        `${PROVIDERS[run.provider]?.name ?? run.provider} does not support resuming a session (capability: ${
          adapter?.capabilities?.resume ?? "unknown"
        })`,
        409,
      );
    if (this.children.has(runId))
      throw new InputError(
        "Run is still executing; headless providers accept input only between attempts. Cancel it or wait for it to finish",
        409,
      );
    const sessionId =
      run.providerSessionId ?? run.configSnapshot?.providerSessionId ?? null;
    if (!sessionId)
      throw new InputError(
        "No provider session id was recorded for this run, so it cannot be resumed",
        409,
      );
    const next = await this.start({
      workspaceId: run.workspaceId,
      taskId: run.taskId,
      agentId: run.agentId,
      provider: run.provider,
      prompt: text,
      model: run.requestedModel,
      isolation: run.configSnapshot?.isolation ?? null,
      resumeSessionId: sessionId,
      parentRunId: run.id,
      attempt: (run.attempt ?? 1) + 1,
      actor,
    });
    this.system(
      next.id,
      `Resumed provider session ${sessionId} with new input`,
      {
        resumeSessionId: sessionId,
        parentRunId: run.id,
      },
    );
    this.audit(
      "run.input",
      next,
      { parentRunId: run.id, sessionId },
      null,
      actor,
    );
    return next;
  }

  /** Marks managed runs left active by a previous server process as disconnected. */
  reconcile() {
    const affected = [];
    for (const run of this.recorder.active()) {
      if (run.mode !== "managed") continue;
      if (!RECONCILE_STATUSES.includes(run.status)) continue;
      if (this.children.has(run.id) || this.specs.has(run.id)) continue;
      // The provider process may have outlived the previous server; say so
      // rather than silently allowing a duplicate attempt.
      const pidAlive = !!run.pid && isAlive(run.pid);
      this.recorder.setStatus(run.id, "disconnected", {
        error: pidAlive
          ? `${DISCONNECTED_ERROR}; provider process ${run.pid} may still be running`
          : DISCONNECTED_ERROR,
      });
      if (pidAlive) {
        this.recorder.update(run.id, {
          context: { ...run.context, pidAliveAtReconcile: run.pid },
        });
        this.system(
          run.id,
          `Provider process ${run.pid} may still be running unmanaged; stop it before retrying to avoid duplicate execution`,
          { pid: run.pid },
          "status",
        );
      }
      this.audit(
        "run.disconnected",
        run,
        { previousStatus: run.status, pid: run.pid ?? null, pidAlive },
        null,
        "system",
      );
      affected.push(this.recorder.get(run.id));
    }
    return affected;
  }

  async removeWorktree(runId, { actor = "local-user" } = {}) {
    const run = this.recorder.get(runId);
    if (!run.worktree) throw new InputError("Run has no worktree", 409);
    if (this.children.has(runId))
      throw new InputError("Run is still executing; cancel it first", 409);
    const root = run.context?.repoRoot ?? run.cwd;
    let rootPath = root;
    try {
      rootPath = await repoRoot(root);
    } catch {
      rootPath = root;
    }
    try {
      await removeWorktree(rootPath, run.worktree);
    } catch (error) {
      this.system(
        runId,
        `Could not remove worktree: ${clip(error.message, 200)}`,
        { worktree: run.worktree },
        "status",
      );
      throw new InputError(
        `Could not remove worktree: ${clip(error.message, 300)}`,
        409,
      );
    }
    this.recorder.update(runId, {
      context: {
        ...run.context,
        worktreeRemoved: true,
        worktreePath: run.worktree,
      },
      worktree: null,
    });
    this.system(runId, `Removed worktree ${run.worktree}`, {
      worktree: run.worktree,
    });
    this.audit(
      "run.worktree.remove",
      run,
      { worktree: run.worktree },
      null,
      actor,
    );
    return this.recorder.get(runId);
  }

  // -------------------------------------------------------------- queries

  get(runId) {
    const run = this.recorder.get(runId);
    return { ...run, attached: this.children.has(runId) };
  }

  describe(runId) {
    const run = this.get(runId);
    let approvals = [];
    try {
      approvals = this.services.approvals?.listForRun?.(runId) ?? [];
    } catch {
      approvals = [];
    }
    return {
      run,
      events: this.recorder.events(runId, { limit: 1000 }),
      artifacts: this.recorder.artifacts(runId),
      approvals,
      context: run.context ?? {},
      capabilities: this.adapterFor(run.provider)?.capabilities ?? {},
    };
  }

  list(workspaceId, options = {}) {
    return this.recorder
      .list(workspaceId, { mode: "managed", ...options })
      .map((run) => ({ ...run, attached: this.children.has(run.id) }));
  }

  /** Resolves when the run leaves the worker (finished, cancelled, or failed to launch). */
  wait(runId, timeoutMs = 60000) {
    const run = this.recorder.get(runId);
    if (
      !this.children.has(runId) &&
      !this.specs.has(runId) &&
      (TERMINAL_RUN_STATUSES.includes(run.status) ||
        run.status === "disconnected")
    )
      return Promise.resolve(run);
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(`Run ${runId} did not finish within ${timeoutMs} ms`),
          ),
        timeoutMs,
      );
      timer.unref?.();
      const waiters = this.waiters.get(runId) ?? [];
      waiters.push(() => {
        clearTimeout(timer);
        resolvePromise(this.recorder.get(runId));
      });
      this.waiters.set(runId, waiters);
    });
  }

  settle(runId) {
    const waiters = this.waiters.get(runId) ?? [];
    this.waiters.delete(runId);
    for (const fn of waiters) fn();
  }

  drain(workspaceId) {
    const queue = this.queues.get(workspaceId);
    if (!queue?.length) return;
    while (queue.length) {
      const nextId = queue[0];
      const spec = this.specs.get(nextId);
      if (!spec) {
        queue.shift();
        continue;
      }
      if (this.activeCount(workspaceId) >= spec.policy.maxConcurrentRuns) break;
      queue.shift();
      this.system(
        nextId,
        "A slot freed up; starting the queued run",
        {},
        "status",
      );
      this.launch(nextId).catch(() => {});
    }
  }

  /**
   * Stops every attached run for shutdown. Runs are marked `disconnected`
   * before the kill so their exit (which may land after the database is
   * closed) has nothing left to record.
   */
  async close() {
    const entries = [...this.children.values()];
    this.children.clear();
    for (const entry of entries) {
      entry.exiting = true;
      entry.finalized = true;
      if (entry.timer) clearTimeout(entry.timer);
      this.specs.delete(entry.runId);
      try {
        this.recorder.setStatus(entry.runId, "disconnected", {
          error: SHUTDOWN_ERROR,
          summary: `Run disconnected: ${SHUTDOWN_ERROR}; side effects already made are not undone`,
        });
      } catch {
        /* database already closed */
      }
      try {
        await this.kill(entry.child?.pid);
      } catch {
        /* ignore */
      }
      this.settle(entry.runId);
    }
  }
}

/** Factory for the integration layer: attaches worker + adapters on services. */
export function createRunWorker(services, options = {}) {
  const worker = new RunWorker(services, options);
  services.runWorker = worker;
  services.adapters = worker.adapters;
  if (!services.recorder) services.recorder = worker.recorder;
  return worker;
}

export { rowToTask as taskFromRow };
