import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { InputError } from "../TaskStore.js";
import { assertDispatchAllowed } from "../ops/Incident.js";
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
import { repoRoot, currentBranch, removeWorktree } from "./worktree.js";
import {
  captureGitDiff,
  captureTestOutput,
  finalMessage,
  formatTestOutput,
} from "./artifacts.js";
import { RunQueue } from "./queue.js";
import { BudgetTracker } from "./budget.js";
import {
  classifyFailure,
  retryPolicy,
  SIDE_EFFECT_REVIEW_REASON,
} from "./retry.js";
import {
  resolveRunScope,
  releaseRunScope,
  pinRange,
  rangeIsStale,
} from "./outputScope.js";

const ACTIVE_STATUSES = ["running", "waiting_approval", "blocked", "stale"];
const RECONCILE_STATUSES = [...ACTIVE_STATUSES, "queued"];
export const DISCONNECTED_ERROR =
  "server restarted before the run finished; reconcile before retrying";
export const CANCEL_MESSAGE =
  "Run cancelled by user; side effects already made are not undone";
export const SHUTDOWN_ERROR = "server shut down while the run was active";

const TASK_PRIORITY_WEIGHT = { CRITICAL: 3, HIGH: 2, MEDIUM: 1, LOW: 0 };

/** Keys a provider may use to say when a rate limit resets. */
const RESET_KEYS = [
  "resetsAt",
  "resets_at",
  "resetAt",
  "reset_at",
  "retryAfter",
  "retry_after",
  "retryAt",
];

function resetHint(events = [], text = "") {
  for (const event of events) {
    const data = event?.data;
    if (!data || typeof data !== "object") continue;
    for (const key of RESET_KEYS)
      if (data[key] !== undefined && data[key] !== null) return data[key];
    const nested = data.rate_limit ?? data.rateLimit ?? data.error;
    if (nested && typeof nested === "object")
      for (const key of RESET_KEYS)
        if (nested[key] !== undefined && nested[key] !== null)
          return nested[key];
  }
  return text || null;
}

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

/** Document inputs attached to the task target: [{ path, label }]. */
function documentsFor(task) {
  const raw = task?.target?.documents;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((doc) =>
      typeof doc === "string"
        ? { path: doc, label: null }
        : doc && typeof doc === "object" && doc.path
          ? {
              path: String(doc.path),
              label: doc.label ? String(doc.label) : null,
            }
          : null,
    )
    .filter(Boolean)
    .slice(0, 50);
}

/** Adds the document inputs to the prompt as an explicit, ordered list. */
function withDocuments(prompt, documents) {
  if (!documents.length) return prompt;
  const list = documents
    .map((doc) => `- ${doc.path}${doc.label ? ` (${doc.label})` : ""}`)
    .join("\n");
  return `${prompt}\n\nInput documents (read these; they are the inputs for this task):\n${list}`;
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
    this.waiters = new Map(); // runId → [resolve]
    this.starting = new Map(); // runId → workspaceId (launch in flight)
    this.retryTimers = new Map(); // runId → automatic-retry timer
    this.wakeTimer = null;
    this.closing = false;
    /** Fair, rate-limit aware queue with per-provider circuit breakers. */
    this.queue =
      options.queue ??
      new RunQueue({
        maxConcurrentPerWorkspace: DEFAULT_POLICY.maxConcurrentRuns,
        fairness: "round-robin",
        now: this.now,
        ...(options.queueOptions ?? {}),
      });
    /** Token budgets: reservations up front, honest post-hoc enforcement. */
    this.budget =
      options.budget ??
      services.budget ??
      new BudgetTracker(services, { now: this.now });
    // Injected so tests can assert an exact retry backoff.
    this.random = options.random ?? Math.random;
    services.onClose?.(() => this.close());
  }

  // ------------------------------------------------------- queue + health

  /** Provider circuit-breaker state for the connections panel. */
  providerHealth() {
    return this.queue.providerHealth();
  }

  /** Current provider outages for the UI banner. */
  outage() {
    return this.queue.outage();
  }

  retryPolicyFor(policy) {
    return retryPolicy({ policy, random: this.random });
  }

  /** Runs occupying a slot: recorded as active plus launches in flight. */
  activeSlots(workspaceId) {
    let inFlight = 0;
    for (const id of this.starting.values())
      if (id === workspaceId) inFlight += 1;
    return this.activeCount(workspaceId) + inFlight;
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

  evaluateLaunch({
    workspace,
    provider,
    isolation,
    policy,
    model = null,
    connection = null,
  }) {
    const policyService = this.services.policy;
    if (policyService?.evaluateLaunch) {
      // The merged run-level policy (task execution_policy + launch request)
      // is passed as an override; the engine only lets it tighten the
      // workspace policy, never widen it. The requested model and the chosen
      // connection are handed over for the provider-access checks
      // (allowedProviders, allowedModels, connection.allowedWorkspaces).
      const verdict = policyService.evaluateLaunch({
        workspace,
        provider,
        isolation,
        override: policy,
        model,
        connection,
      });
      return {
        allowed: verdict?.allowed !== false,
        reason: verdict?.reason ?? null,
        rule: verdict?.rule ?? null,
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
        connection: null,
        reason: `${PROVIDERS[provider]?.name ?? provider} is not available: ${
          rows[0].error ?? `connection status is ${rows[0].status}`
        }`,
      };
    return { ok: true, connectionId: usable.id ?? null, connection: usable };
  }

  /**
   * Distinct label for a second (third, …) concurrent run of the same
   * profile: '<agent name> #<n>'. The first run keeps label null; observed
   * runs are never relabelled here.
   */
  labelFor(agent) {
    if (!agent?.id) return null;
    const statuses = [...ACTIVE_STATUSES, "queued"];
    const active = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM runs WHERE agent_id = ? AND mode = 'managed' AND status IN (${statuses.map(() => "?").join(",")})`,
      )
      .get(agent.id, ...statuses).n;
    if (!active) return null;
    return `${agent.name ?? "Agent"} #${active + 1}`;
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
    // An operator stop-all halts every new dispatch, however it is requested
    // (API, workflow auto-dispatch, retry). No-op when ops is not composed.
    assertDispatchAllowed(this.services);
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
    // The agent is chosen before the policy verdict so the model it prefers
    // can be checked against allowedModels (an explicit override wins).
    const agent = this.pickAgent(workspace, agentId, provider);
    const model = modelOverride ?? agent.model ?? null;
    const verdict = this.evaluateLaunch({
      workspace: record,
      provider,
      isolation,
      policy,
      model,
      connection: availability.connection ?? null,
    });
    if (!verdict.allowed) {
      this.audit(
        "run.refused",
        null,
        {
          workspaceId,
          taskId,
          provider,
          model,
          connectionId: availability.connectionId ?? null,
          rule: verdict.rule ?? null,
          reason: verdict.reason,
        },
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

    // Pin the code range to the exact bytes it was chosen against and write
    // the pinned target back to the task, so every later attempt (and the
    // review) refers to the same revision.
    const pin = await this.pinTaskRange(task, cwd);
    const documents = documentsFor(task);
    const basePrompt =
      typeof promptOverride === "string" && promptOverride.trim()
        ? promptOverride
        : buildPrompt({
            task,
            workspace: record,
            agent,
            context: task.context,
          });
    const prompt = withDocuments(basePrompt, documents);
    let manifest = null;
    if (documents.length || task.target?.files?.length) {
      try {
        manifest = this.services.context?.build?.({
          workspaceId,
          taskId,
          agentId: agent.id,
          documents: documents.map((doc) => ({
            title: doc.label ?? doc.path,
            ref: doc.path,
          })),
        });
      } catch {
        manifest = null;
      }
    }
    const context = {
      ...(task.context ?? {}),
      target: task.target ?? {},
      files: task.target?.files ?? [],
      folder: task.target?.folder ?? null,
      documents,
      range: task.target?.range ?? null,
      rangePinnedNow: pin?.pinnedNow ?? false,
      manifest: manifest
        ? {
            hash: manifest.hash,
            files: manifest.files?.length ?? 0,
            documents: manifest.documents?.length ?? 0,
            estimatedTokens: manifest.estimatedTokens ?? null,
            estimateLabel: manifest.estimateLabel ?? "estimate",
          }
        : null,
      promptSource: promptOverride ? "user" : "task",
    };

    // Budget: book estimated headroom before anything is spawned. The
    // estimate is labelled an estimate; real totals arrive afterwards.
    const estimateTokens =
      manifest?.estimatedTokens ?? Math.ceil(prompt.length / 4);
    const preflight = this.budget.reserve({
      workspaceId,
      runId: null,
      estimateTokens,
    });
    if (!preflight.ok) {
      this.audit(
        "run.refused",
        null,
        { workspaceId, taskId, provider, reason: preflight.reason },
        "deny",
        actor,
      );
      throw new InputError(preflight.reason, 429);
    }

    const providerState = this.queue.available(provider);
    const atLimit =
      this.activeSlots(workspaceId) >= effective.maxConcurrentRuns;
    const queued = atLimit || !providerState.ok;
    const label = this.labelFor(agent);
    const run = this.recorder.ensureRun({
      workspaceId,
      agentId: agent.id,
      mode: "managed",
      provider,
      taskId,
      cwd,
      host: "local",
      label,
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
    const reservation = this.budget.reserve({
      workspaceId,
      runId: run.id,
      estimateTokens,
    });
    if (reservation.limit !== null)
      this.system(
        run.id,
        `Reserved ${reservation.estimateTokens} estimated tokens; ${reservation.remaining} of the ${reservation.limit} daily token budget remain (estimate: token totals are only known after the run).`,
        {
          estimateTokens: reservation.estimateTokens,
          limit: reservation.limit,
          remaining: reservation.remaining,
          basis: "estimate",
        },
        "status",
      );
    if (pin?.pinnedNow)
      this.system(
        run.id,
        `Pinned ${pin.file} lines ${pin.start}-${pin.end} to revision ${pin.revision}`,
        { range: pin, basis: pin.revisionBasis ?? null },
        "status",
      );
    else if (pin?.stale)
      this.system(
        run.id,
        `The pinned range in ${pin.file} no longer matches revision ${pin.revision}: the file changed since the range was chosen. The run uses the current contents.`,
        { range: pin },
        "status",
      );
    if (documents.length)
      this.system(
        run.id,
        `${documents.length} document input${documents.length === 1 ? "" : "s"} listed in the prompt: ${documents
          .map((doc) => doc.label ?? doc.path)
          .join(", ")
          .slice(0, 200)}`,
        { documents },
        "status",
      );
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
      this.queue.enqueue({
        workspaceId,
        runId: run.id,
        provider,
        priority: TASK_PRIORITY_WEIGHT[task.priority] ?? 0,
      });
      if (atLimit)
        this.system(
          run.id,
          `Queued: workspace already runs ${effective.maxConcurrentRuns} managed run${
            effective.maxConcurrentRuns === 1 ? "" : "s"
          }; will start when a slot frees`,
          { maxConcurrentRuns: effective.maxConcurrentRuns },
          "status",
        );
      else
        this.system(
          run.id,
          `Queued: ${PROVIDERS[provider].name} is unavailable (${providerState.reason ?? providerState.state}); the run starts when the provider is usable again${
            providerState.until
              ? ` (not before ${new Date(providerState.until).toISOString()})`
              : ""
          }`,
          {
            provider,
            breaker: providerState.state,
            until: providerState.until ?? null,
            reason: providerState.reason ?? null,
          },
          "status",
        );
      this.audit(
        "run.queue",
        run,
        {
          provider,
          taskId,
          reason: atLimit ? "concurrency" : `provider-${providerState.state}`,
        },
        "allow",
        actor,
      );
      this.scheduleWake();
      return this.recorder.get(run.id);
    }
    this.starting.set(run.id, workspaceId);
    await this.launch(run.id);
    return this.recorder.get(run.id);
  }

  /**
   * Pins `task.target.range` to the file revision it was chosen against and
   * writes the pinned target back to the task. An existing pin is checked for
   * staleness instead of being overwritten.
   */
  async pinTaskRange(task, cwd) {
    const range = task?.target?.range;
    if (!range?.file) return null;
    if (range.revision) {
      let stale = false;
      try {
        stale = await rangeIsStale({ ...range, cwd }, { cwd });
      } catch {
        stale = false;
      }
      return { ...range, pinnedNow: false, stale };
    }
    let pinned = null;
    try {
      pinned = await pinRange({
        cwd,
        file: range.file,
        start: range.start ?? null,
        end: range.end ?? null,
      });
    } catch {
      pinned = null;
    }
    if (!pinned?.revision) return { ...range, pinnedNow: false, stale: false };
    const target = {
      ...(task.target ?? {}),
      range: {
        ...range,
        revision: pinned.revision,
        pinnedAt: pinned.pinnedAt,
      },
    };
    task.target = target;
    try {
      this.db
        .prepare("UPDATE tasks SET target = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(target), this.now(), task.id);
    } catch {
      /* the task row may have been removed; the run still uses the pin */
    }
    this.audit(
      "task.range.pinned",
      null,
      {
        workspaceId: task.workspaceId,
        taskId: task.id,
        range: target.range,
        basis: pinned.revisionBasis ?? null,
      },
      null,
      "system",
    );
    return { ...target.range, pinnedNow: true, stale: false };
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
      const scope = await resolveRunScope({
        cwd,
        isolation: spec.isolation,
        dataDir: this.dataDir,
        runId,
      });
      if (scope.isRepo) branch = await currentBranch(cwd);
      if (scope.mode === "worktree") {
        cwd = scope.cwd;
        worktree = scope.worktree;
        branch = scope.branch;
        recorder.update(runId, {
          context: { ...recorder.get(runId).context, repoRoot: scope.repoRoot },
        });
        this.system(runId, `Created isolated worktree on branch ${branch}`, {
          worktree,
          branch,
          repoRoot: scope.repoRoot,
        });
      } else if (scope.mode === "output-folder") {
        spec.outputDir = scope.outputDir;
        recorder.update(runId, {
          context: {
            ...recorder.get(runId).context,
            outputDir: scope.outputDir,
          },
        });
        this.system(
          runId,
          `Not a Git repository, so writes are scoped to an output folder instead of a worktree. ${scope.note}`,
          { outputDir: scope.outputDir, cwd },
          "status",
        );
      }
      const extraDirs = [
        ...new Set([...(spec.extraDirs ?? []), ...(scope.extraDirs ?? [])]),
      ];
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
          outputDir: spec.outputDir ?? null,
        },
      });
      this.starting.delete(runId);
      this.queue.beginAttempt(spec.provider);
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
      this.starting.delete(runId);
      this.budget.release(runId);
      recorder.setStatus(runId, "failed", {
        error: `Could not start ${spec.provider}: ${error.message}`.slice(
          0,
          500,
        ),
      });
      // A launch that never produced a process is a transport failure by
      // definition: nothing ran, so an automatic retry cannot duplicate work.
      const classification = classifyFailure({
        exitCode: null,
        error,
        events: [],
        adapter: spec.adapter,
      });
      this.queue.recordFailure(spec.provider, classification, {
        error: error.message,
      });
      this.considerAutoRetry(
        { runId, spec, workspaceId: spec.workspaceId },
        classification,
      );
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
    // Provider-reported usage is the only honest trigger for budget
    // enforcement, and it always arrives after the tokens were spent.
    if (event.usage && typeof event.usage === "object")
      Promise.resolve(this.budget.enforce(entry.runId)).catch(() => {});
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
    await this.afterFinish(entry, { exitCode: code, spawnError, final });
  }

  /**
   * Everything that happens once a run's status is final: release the scoped
   * output folder, settle the token budget, update the provider's circuit
   * breaker, and decide about a bounded automatic retry.
   */
  async afterFinish(entry, { exitCode = null, spawnError = null } = {}) {
    const recorder = this.recorder;
    let run = null;
    try {
      run = recorder.get(entry.runId);
    } catch {
      return;
    }
    const provider = entry.spec?.provider ?? run.provider;

    if (entry.spec?.outputDir) {
      const release = releaseRunScope({ outputDir: entry.spec.outputDir });
      this.system(
        entry.runId,
        release.removed
          ? `Scoped output folder ${entry.spec.outputDir} was empty and has been removed`
          : `Scoped output folder ${entry.spec.outputDir} kept: ${release.reason}. Copy what you want back into the source folder after review.`,
        { outputDir: entry.spec.outputDir, ...release },
        "status",
      );
    }

    try {
      await this.budget.consume(entry.runId, run.usage ?? null);
    } catch {
      /* budget accounting is best effort; never fail a finished run */
    }

    const status = (() => {
      try {
        return recorder.get(entry.runId).status;
      } catch {
        return run.status;
      }
    })();
    this.notifyOrchestration(entry, run, status);
    if (status === "completed") {
      this.queue.recordSuccess(provider);
      return;
    }
    if (status === "cancelled" || entry.cancelled) {
      this.queue.recordFailure(provider, "user-cancelled");
      return;
    }
    let events = [];
    try {
      events = recorder.events(entry.runId, { limit: 2000 });
    } catch {
      events = [];
    }
    const classification = classifyFailure({
      exitCode,
      error: run.error,
      events,
      adapter: entry.adapter ?? entry.spec?.adapter ?? null,
      sessionId: run.providerSessionId ?? entry.state?.sessionId ?? null,
      spawnError,
      stderr: entry.stderr ?? [],
      timedOut: entry.timedOut === true,
      retryableClasses: this.retryPolicyFor(
        entry.spec?.policy ?? this.policyFor(run.workspaceId),
      ).retryableClasses,
    });
    this.system(
      entry.runId,
      `Failure classified as “${classification.class}”: ${classification.reason} Side effects: ${
        classification.sideEffects === "none"
          ? "none recorded before the failure"
          : `${classification.sideEffects} — files or commands were recorded before it failed`
      }.`,
      {
        class: classification.class,
        retryable: classification.retryable,
        sideEffects: classification.sideEffects,
        exitCode,
      },
      "status",
    );
    this.queue.recordFailure(provider, classification, {
      error: run.error,
      resetAt: resetHint(events, run.error ?? ""),
    });
    if (classification.class === "rate-limit") {
      const parked = this.queue.available(provider);
      if (!parked.ok)
        this.system(
          entry.runId,
          `${PROVIDERS[provider]?.name ?? provider} is parked until ${
            parked.until
              ? new Date(parked.until).toISOString()
              : "the cooldown ends"
          }; queued runs for it wait rather than hammering the limit.`,
          { provider, until: parked.until ?? null },
          "status",
        );
    }
    this.considerAutoRetry(entry, classification);
    this.scheduleWake();
  }

  /**
   * Tells the orchestration modules that a run ended. Both calls are optional
   * and fully guarded: a container without a task graph or without webhooks
   * behaves exactly as before.
   *
   *  - services.graph.recordResult() checks the task contract against what was
   *    actually recorded (artifacts, events, final message) and opens a review
   *    task when the contract is not met. It is called only for a completed
   *    run: a failed run has no result to check.
   *  - services.webhooks.emit() queues an outbound notification. The payload is
   *    sanitized inside emit() to ids, statuses, and titles; nothing is
   *    delivered until deliverDue() runs.
   */
  notifyOrchestration(entry, run, status) {
    const runId = entry.runId;
    if (status === "completed" && run.taskId) {
      try {
        const events = this.recorder.events(runId, { limit: 2000 });
        this.services.graph?.recordResult?.(run.taskId, {
          runId,
          artifacts: this.recorder.artifacts?.(runId) ?? [],
          events,
          finalMessage: run.summary ?? null,
          actor: "run-worker",
        });
      } catch (error) {
        this.system(
          runId,
          `Contract check could not run: ${clip(error.message, 150)}`,
          {},
          "status",
        );
      }
    }
    try {
      this.services.webhooks?.emit?.(
        status === "completed" ? "run.completed" : "run.failed",
        {
          workspaceId: run.workspaceId,
          taskId: run.taskId ?? null,
          runId,
          provider: run.provider,
          status,
          title: run.title ?? null,
          attempt: run.attempt ?? 1,
        },
      );
    } catch {
      /* a webhook queue problem must never change a run's outcome */
    }
  }

  /**
   * Bounded automatic retry. A run whose side effects are anything but "none"
   * is never retried automatically: it stays failed and therefore appears in
   * the decision inbox with the reason spelled out.
   */
  considerAutoRetry(entry, classification) {
    const runId = entry.runId;
    let run = null;
    try {
      run = this.recorder.get(runId);
    } catch {
      return null;
    }
    const spec = entry.spec ?? this.specs.get(runId) ?? null;
    const policy = spec?.policy ?? this.policyFor(run.workspaceId);
    const rules = this.retryPolicyFor(policy);
    const attempt = run.attempt ?? 1;
    const decision = rules.shouldRetry({ classification, attempt });
    if (!decision.retry) {
      const fallback = rules.fallbackProvider(run.provider);
      const extra =
        classification.sideEffects !== "none"
          ? ` Sent to the decision inbox instead: ${SIDE_EFFECT_REVIEW_REASON}.`
          : fallback
            ? ` The workspace policy permits falling back to ${PROVIDERS[fallback]?.name ?? fallback}; start that attempt yourself.`
            : "";
      this.system(
        runId,
        `No automatic retry: ${decision.reason}.${extra}`,
        {
          class: classification.class,
          sideEffects: classification.sideEffects,
          maxAttempts: rules.maxAttempts,
          attempt,
          fallbackAllowed: !!fallback,
        },
        "status",
      );
      this.audit(
        "run.retry.refused",
        run,
        {
          class: classification.class,
          sideEffects: classification.sideEffects,
          reason: decision.reason,
        },
        null,
        "system",
      );
      return null;
    }
    this.system(
      runId,
      `Automatic retry ${attempt + 1} of ${rules.maxAttempts} in ${
        Math.round(decision.delayMs / 100) / 10
      } s: ${classification.reason} No file change or command was recorded before the failure, so re-running cannot duplicate side effects.`,
      {
        class: classification.class,
        attempt,
        maxAttempts: rules.maxAttempts,
        delayMs: decision.delayMs,
      },
      "status",
    );
    this.audit(
      "run.retry.scheduled",
      run,
      {
        class: classification.class,
        delayMs: decision.delayMs,
        attempt,
        maxAttempts: rules.maxAttempts,
      },
      null,
      "system",
    );
    const timer = setTimeout(() => {
      this.retryTimers.delete(runId);
      this.runAutoRetry(runId, classification);
    }, decision.delayMs);
    timer.unref?.();
    this.retryTimers.set(runId, timer);
    return decision;
  }

  async runAutoRetry(runId, classification) {
    if (this.closing || this.services.closed) return null;
    try {
      const next = await this.retry(runId, { actor: "system", auto: true });
      this.system(
        next.id,
        `Automatic retry of run ${runId} (previous failure: ${classification.class})`,
        { parentRunId: runId, class: classification.class },
        "status",
      );
      return next;
    } catch (error) {
      this.system(
        runId,
        `Automatic retry could not start: ${clip(error.message, 200)}`,
        {},
        "status",
      );
      return null;
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
      this.queue.remove(runId);
      this.specs.delete(runId);
      this.starting.delete(runId);
      this.budget.release(runId);
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
    { actor = "local-user", prompt = null, force = false, auto = false } = {},
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
    this.audit(
      "run.retry",
      next,
      { parentRunId: run.id, automatic: auto },
      null,
      actor,
    );
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

  /**
   * Starts whatever the queue says may run now. Round-robin across
   * workspaces, so one busy workspace cannot starve another, and providers
   * whose circuit breaker is open (or that are parked by a rate limit) are
   * skipped until their cooldown passes. The `workspaceId` argument is kept
   * for callers that drain after one workspace finished a run; the queue
   * itself is global.
   */
  drain(_workspaceId = null) {
    if (this.closing) return;
    for (;;) {
      const entry = this.queue.next({
        canStart: (candidate) => {
          const spec = this.specs.get(candidate.runId);
          if (!spec) return true; // cancelled while queued; drop it below
          const limit =
            spec.policy?.maxConcurrentRuns ?? DEFAULT_POLICY.maxConcurrentRuns;
          return this.activeSlots(candidate.workspaceId) < limit;
        },
      });
      if (!entry) break;
      const spec = this.specs.get(entry.runId);
      if (!spec) continue;
      this.starting.set(entry.runId, entry.workspaceId);
      this.system(
        entry.runId,
        "A slot freed up; starting the queued run",
        {},
        "status",
      );
      this.launch(entry.runId).catch(() => {});
    }
    this.scheduleWake();
  }

  /** Re-drains when a parked provider's cooldown expires. */
  scheduleWake() {
    if (this.closing) return;
    const at = this.queue.wakeAt();
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    if (at === null || !this.queue.size()) return;
    const delay = Math.max(50, at - this.now());
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      try {
        this.drain();
      } catch {
        /* database may be closed */
      }
    }, delay);
    this.wakeTimer.unref?.();
  }

  /**
   * Stops every attached run for shutdown. Runs are marked `disconnected`
   * before the kill so their exit (which may land after the database is
   * closed) has nothing left to record.
   */
  async close() {
    this.closing = true;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    this.queue.clear();
    this.starting.clear();
    const entries = [...this.children.values()];
    this.children.clear();
    // Bookkeeping for every run first, then the kills together. On win32 a
    // kill shells out to `taskkill /t /f` with a 10 s timeout, and main.js
    // arms an 8 s force-exit: killing sequentially meant one wedged process
    // tree used the whole budget and runs 2..N never had taskkill issued at
    // all, so their provider trees survived the exit.
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
    }
    await Promise.all(
      entries.map((entry) =>
        Promise.resolve()
          .then(() => this.kill(entry.child?.pid))
          .catch(() => {}),
      ),
    );
    for (const entry of entries) this.settle(entry.runId);
  }
}

/** Factory for the integration layer: attaches worker + adapters on services. */
export function createRunWorker(services, options = {}) {
  const worker = new RunWorker(services, options);
  services.runWorker = worker;
  services.adapters = worker.adapters;
  if (!services.budget) services.budget = worker.budget;
  if (!services.recorder) services.recorder = worker.recorder;
  return worker;
}

export { rowToTask as taskFromRow };
