import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./db.js";
import { WorkspaceHub } from "./WorkspaceHub.js";
import { Settings } from "./settings/Settings.js";
import { Audit } from "./audit/Audit.js";
import { Policy } from "./policy/Policy.js";
import { ConnectionService } from "./connections/ConnectionService.js";
import { RunRecorder } from "./runs/RunRecorder.js";
import { ApprovalService } from "./approvals/ApprovalService.js";
import { createHookBridge } from "./hooks/claudeHookBridge.js";
import {
  ObservationService,
  liveSessionsSummary,
  providerHome,
} from "./observe/ObservationService.js";
import { createObserver as createClaudeObserver } from "./observe/claudeCode.js";
import { createObserver as createCodexObserver } from "./observe/codex.js";
import { createObserver as createCopilotObserver } from "./observe/copilot.js";
import { createObserver as createCursorObserver } from "./observe/cursor.js";
import { createObserver as createGeminiObserver } from "./observe/gemini.js";
import { createRunWorker } from "./runs/RunWorker.js";
import { defaultAdapters } from "./adapters/index.js";
import { TaskGraph } from "./workflows/TaskGraph.js";
import { WorkflowService } from "./workflows/WorkflowService.js";
import { Analytics } from "./analytics/Analytics.js";
import { ContextManifest } from "./context/ContextManifest.js";
import { createCheckpointService } from "./workflows/checkpoints.js";
import { createDryRun } from "./workflows/dryRun.js";
import { createSuggest } from "./workflows/suggest.js";
import { createWebhookService } from "./webhooks/WebhookService.js";
import { createIncidentService } from "./ops/Incident.js";
import { createBackupService } from "./ops/Backup.js";
import { createHealthService } from "./ops/Health.js";
import { createDiagnosticsService } from "./ops/Diagnostics.js";
import { createRetentionService } from "./ops/Retention.js";
import { createSearch } from "./search/Search.js";
import { createConnectorRegistry } from "./connectors/index.js";
import { createMemory } from "./context/memory.js";
import { createRelevance } from "./context/relevance.js";
import { createHandover } from "./collab/Handover.js";
import { createDecisions } from "./collab/Decisions.js";
import { createPricing } from "./analytics/pricing.js";
import { createLineage } from "./analytics/lineage.js";
import { createEvaluation } from "./analytics/evaluation.js";
import { createExtensionRegistry } from "./extensions/registry.js";
import { createMcpServer } from "./mcp/server.js";
import { TOOLS as MCP_TOOLS } from "./mcp/tools.js";
import { classifyFailure, retryPolicy } from "./runs/retry.js";

const OBSERVER_FACTORIES = [
  ["claude-code", createClaudeObserver],
  ["codex", createCodexObserver],
  ["copilot", createCopilotObserver],
  ["cursor", createCursorObserver],
  ["gemini", createGeminiObserver],
];

/** Default location for worktrees, artifacts, and the SQLite file. */
export const DEFAULT_DATA_DIR = fileURLToPath(
  new URL("../../../data/", import.meta.url),
);

/**
 * Builds the five provider observers synchronously. Homes honour the
 * provider env overrides (CLAUDE_CONFIG_DIR, CODEX_HOME, COPILOT_HOME,
 * CURSOR_HOME, GEMINI_HOME). Constructing an observer never touches disk;
 * files are read only when the observation service polls.
 */
export function defaultObservers(
  services,
  { env = process.env, log = console } = {},
) {
  const observers = [];
  for (const [providerId, factory] of OBSERVER_FACTORIES) {
    try {
      const observer = factory({
        home: providerHome(providerId, env),
        env,
        services,
      });
      if (observer && typeof observer.scanSessions === "function") {
        observer.provider ??= providerId;
        observers.push(observer);
      }
    } catch (error) {
      log.debug?.(
        `[services] observer for ${providerId} unavailable: ${error?.message ?? error}`,
      );
    }
  }
  return observers;
}

/**
 * Service container. Every long-lived component is created here once and
 * shared by the HTTP server, the CLI, and tests.
 *
 * Composition order (each step may use the ones before it):
 *   db, bus, hub → settings → audit (hash chain) → policy → connections →
 *   recorder → approvals → hookBridge → observation →
 *   runWorker (+ adapters, budget, queue, retry) →
 *   workflows (TaskGraph + WorkflowService + checkpoints + dryRun + suggest) →
 *   analytics → context → webhooks → ops (incidents, backup, health,
 *   diagnostics, retention) → search → optional modules (services.ready)
 *
 * Every service is optional to its consumers: modules guard cross-service use
 * with optional chaining, so a container built without one still answers.
 *
 * options:
 *   db | dbPath        existing DatabaseSync or a path (":memory:" default)
 *   demo               load the demo simulation into the demo workspace
 *   port               server port (used for the Claude hook command)
 *   env                environment (defaults to process.env; tests inject one)
 *   observers          observer array to use instead of the defaults
 *   disableObservation build the observation service with no observers
 *   detect             detection function for ConnectionService (tests)
 *   dataDir            worktrees/artifacts directory (AGENT_SPACE_DATA_DIR)
 *   log                logger (console)
 *
 * Nothing is started here: main.js refreshes connections, reconciles runs,
 * starts observation, and watches the task graph after the server listens.
 *
 * `bus` is a process-wide EventEmitter for cross-module notifications:
 *   "global"            → something outside a single workspace changed
 *                          (connections, approvals, live sessions); server
 *                          re-broadcasts the global snapshot.
 *   "workspace" (id)    → force a snapshot broadcast for one workspace.
 */
export function createServices(options = {}) {
  const env = options.env ?? process.env;
  const log = options.log ?? console;
  const db = options.db ?? openDatabase(options.dbPath ?? ":memory:");
  const bus = new EventEmitter();
  bus.setMaxListeners(200);
  const hub = new WorkspaceHub(db, { demo: options.demo ?? false });
  const services = {
    db,
    bus,
    hub,
    options,
    env,
    log,
    ownsDatabase: !options.db,
    closed: false,
    _closers: [],
    /**
     * Registers a shutdown step. When close() has ALREADY run, the step runs
     * immediately instead of being queued: the closers array was drained with
     * splice(0), so anything pushed afterwards is never called. That happens
     * whenever a slow startup registers a timer after Ctrl+C.
     */
    onClose(fn) {
      if (services.closed) {
        try {
          const result = fn();
          if (result && typeof result.then === "function")
            result.then(undefined, () => {});
        } catch {
          /* best effort */
        }
        return;
      }
      services._closers.push(fn);
    },
    /** Returns cross-workspace state for the global WebSocket channel. */
    globalSnapshot() {
      return globalSnapshot(services);
    },
    /** Stops timers and child processes, then closes the db when owned. */
    async close() {
      if (services.closed) return;
      services.closed = true;
      const steps = [
        () => services.observation?.stop?.(),
        () => services.runWorker?.close?.(),
        () => services.approvals?.stop?.(),
      ];
      for (const step of steps) {
        try {
          await step();
        } catch {
          /* best effort */
        }
      }
      for (const stop of services._closers.splice(0)) {
        try {
          await stop();
        } catch {
          /* best effort */
        }
      }
      try {
        for (const timer of services.recorder?.pending?.values() ?? [])
          clearTimeout(timer);
        services.recorder?.pending?.clear?.();
      } catch {
        /* recorder may be replaced by tests */
      }
      if (services.ownsDatabase) db.close();
    },
  };

  // 1. Settings, audit, policy (policy needs settings for budgets).
  services.settings = new Settings(db);
  services.audit = new Audit(db);
  services.policy = new Policy(services);
  hub.setPolicyService(services.policy);

  // 2. Provider connections (reads hook status from settings when asked).
  services.connections = new ConnectionService(services, {
    env,
    detect: options.detect,
  });

  // 3. Single write path for run activity, then approvals and the hook bridge.
  services.recorder = new RunRecorder(services, {
    broadcastIntervalMs: options.broadcastIntervalMs,
  });
  services.approvals = new ApprovalService(services, {
    sweepMs: options.approvalSweepMs,
  });
  services.hookBridge = createHookBridge(services);

  // 4. Observation of sessions started outside Agent Space (not started here).
  const observers = options.disableObservation
    ? []
    : (options.observers ?? defaultObservers(services, { env, log }));
  services.observation = new ObservationService(services, {
    observers,
    intervalMs: Number(env.AGENT_SPACE_OBSERVE_INTERVAL) || 2000,
    log,
  });

  // 5. Managed runs through the provider adapters.
  createRunWorker(services, {
    recorder: services.recorder,
    adapters: defaultAdapters,
    dataDir: options.dataDir ?? env.AGENT_SPACE_DATA_DIR ?? DEFAULT_DATA_DIR,
    env,
  });

  // 5b. Retry classification is a pure module; it is exposed here so callers
  // that are not the run worker (routes, the inbox) can explain a failure the
  // same way the worker does. services.budget and services.queue are attached
  // by createRunWorker above; the aliases below are only convenience.
  services.retry = { classifyFailure, retryPolicy };
  services.queue = services.runWorker?.queue ?? null;

  // 5c. Decision history is composed before approvals so every approve /
  // deny / request-change decision is recorded in decision_history from the
  // first request onward (ApprovalService reads services.decisions lazily,
  // so a container without it still decides — it just records less).
  createDecisions(services); // → services.decisions

  // 6. Workflows (task graph + templates), analytics, context manifests.
  const graph = new TaskGraph(services);
  services.graph = graph;
  services.workflows = new WorkflowService(services, { graph });
  createCheckpointService(services); // → services.checkpoints
  createDryRun(services); // → services.dryRun
  createSuggest(services); // → services.suggest
  // 6b. Memory and relevance are composed BEFORE the context manifest:
  // ContextManifest.build() attaches scoped memory, named knowledge items and
  // a deterministic relevance ranking through them. Both are read with
  // optional chaining there, so an older container still builds a manifest.
  createMemory(services); // → services.memory
  createRelevance(services); // → services.relevance ({ rank, WEIGHTS })

  services.analytics = new Analytics(services, {
    pricing: options.pricing ?? null,
  });
  // These factories return their instance rather than attaching it, so the
  // container assigns the key (the same pattern as createEvaluation below).
  services.pricing = createPricing(services); // settings-backed price table
  services.lineage = createLineage(services); // input → run → artifact graph
  // createEvaluation/createExtensionRegistry return their instance rather
  // than attaching it, so the container assigns the key here.
  services.evaluation = createEvaluation(services); // five separate dimensions
  services.context = new ContextManifest(services, {
    git: options.git ?? true,
  });
  createHandover(services); // → services.handover (briefs built from records)

  // 7. Outbound/inbound webhooks. Nothing is delivered until main.js (or a
  // test) calls services.webhooks.deliverDue(); creating the service starts
  // no timer, so a container built for a unit test never opens a socket.
  createWebhookService(services); // → services.webhooks

  // 8. Operations: incidents (the dispatch stop flag), backup, health,
  // diagnostics, retention. Retention registers its own onClose; its timer
  // only starts when start() is called and the policy is enabled.
  createIncidentService(services); // → services.incidents
  createBackupService(services); // → services.backup
  createHealthService(services); // → services.health
  createDiagnosticsService(services); // → services.diagnostics
  createRetentionService(services); // → services.retention

  // 8b. Connectors (git / filesystem / GitHub through gh) and the extension
  // registry. Every connector write goes policy → approval → audit inside the
  // registry; nothing here reaches the network on construction.
  createConnectorRegistry(services); // → services.connectorRegistry
  services.extensions = createExtensionRegistry(services);

  // 8c. MCP is exposed as a FACTORY and never started in-process: the bridge
  // (bin/agent-space-mcp.js) runs as its own process and talks to this server
  // over HTTP, so it can never contend for the SQLite write lock. Starting a
  // stdio server here would also write protocol frames onto the server's own
  // stdout.
  services.mcp = {
    started: false,
    toolCount: MCP_TOOLS.length,
    /** Builds a stdio MCP server around an HTTP client for this server. */
    createServer: (options) => createMcpServer(options),
    transport: "stdio (separate process: bin/agent-space-mcp.js)",
  };

  // 9. Search across the records above (never the filesystem).
  createSearch(services); // → services.search

  // 10. Modules that may not be installed in this build. Each is optional and
  // is attached only when its file exists; every consumer must keep using
  // optional chaining. `services.ready` resolves once the scan has finished.
  services.ready =
    options.optional === false
      ? Promise.resolve([])
      : attachOptionalServices(services).catch((error) => {
          log.debug?.(
            `[services] optional module scan failed: ${error?.message ?? error}`,
          );
          return [];
        });

  return services;
}

/**
 * Modules that this build may or may not contain. Each
 * entry is { key, path, factory }: when the file exists it is imported and
 * `factory(services)` is called, which is expected to attach `services[key]`.
 *
 * This list is the ONLY place a new optional module has to be named. Nothing
 * here is required: an absent module leaves `services[key]` undefined and every
 * caller already guards with optional chaining, so the container degrades
 * instead of failing.
 *
 * Everything else that the wave-2 plan listed here now ships in this build and
 * is composed statically above in dependency order (decisions, memory,
 * relevance, handover, pricing, lineage, evaluation, connectorRegistry,
 * extensions, mcp), so the container no longer has to guess at a filename.
 * `services.connectors` remains optional: it is the provider-availability
 * probe registry, which is a different thing from `services.connectorRegistry`
 * (git / filesystem / GitHub reads and gated writes).
 */
export const OPTIONAL_MODULES = Object.freeze([
  {
    key: "connectors",
    path: "./connectors/Connectors.js",
    factory: "createConnectors",
  },
]);

/**
 * Attaches every optional module whose file is present. Returns the list of
 * keys that were attached, so main.js can log exactly what this build has.
 * A module that throws while loading is logged and skipped: one broken
 * optional module never stops the container.
 */
export async function attachOptionalServices(
  services,
  { modules = OPTIONAL_MODULES } = {},
) {
  const attached = [];
  const here = new URL("./", import.meta.url);
  for (const entry of modules) {
    const file = new URL(entry.path, here);
    if (!existsSync(fileURLToPath(file))) continue;
    try {
      const module = await import(file.href);
      const factory = module[entry.factory] ?? module.default;
      if (typeof factory !== "function") continue;
      const value = await factory(services);
      services[entry.key] ??= value;
      if (services[entry.key]) attached.push(entry.key);
    } catch (error) {
      services.log?.error?.(
        `[services] optional module ${entry.key} failed to load: ${error?.message ?? error}`,
      );
    }
  }
  return attached;
}

/** How long a health snapshot is reused for the global channel payload. */
export const HEALTH_CACHE_MS = 5_000;

const emptyUrgency = Object.freeze({
  overdueApprovals: 0,
  oldestApprovalAgeMs: null,
  failedRuns: 0,
  pendingReviews: 0,
  questions: 0,
});

/** Approvals older than this are counted as overdue in the inbox urgency. */
export const OVERDUE_APPROVAL_MS = 30 * 60 * 1000;

/**
 * Urgency counts for the inbox badge. Everything here is derived from stored
 * timestamps; nothing is predicted or scored. `oldestApprovalAgeMs` is null
 * when no approval is pending rather than 0, so the UI cannot mistake "none
 * waiting" for "just arrived".
 */
export function inboxUrgency(inbox, now = Date.now()) {
  const pending = inbox?.approvals ?? [];
  const ages = pending
    .map((approval) => approval.requestedAt)
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.max(0, now - value));
  return {
    overdueApprovals: ages.filter((age) => age > OVERDUE_APPROVAL_MS).length,
    oldestApprovalAgeMs: ages.length ? Math.max(...ages) : null,
    failedRuns: (inbox?.runs ?? []).filter((run) =>
      ["failed", "disconnected", "stale"].includes(run.status),
    ).length,
    pendingReviews: inbox?.reviews?.length ?? 0,
    questions: inbox?.questions?.length ?? 0,
  };
}

/** Health level + top alerts, recomputed at most every HEALTH_CACHE_MS. */
function cachedHealth(services) {
  const now = Date.now();
  const cache = services._healthCache;
  if (cache && now - cache.at < HEALTH_CACHE_MS) return cache.value;
  const snapshot = services.health?.snapshot?.();
  const value = snapshot
    ? {
        status: snapshot.status,
        checkedAt: snapshot.checkedAt ?? now,
        alertCount: snapshot.alerts?.length ?? 0,
        alerts: (snapshot.alerts ?? [])
          .slice(0, 5)
          .map(({ level, code, title }) => ({ level, code, title })),
      }
    : { status: "unknown", alerts: [], alertCount: 0, checkedAt: null };
  services._healthCache = { at: now, value };
  return value;
}

/**
 * Global channel payload. Each section is guarded so one failing module
 * cannot take the whole broadcast down. Connection rows never contain
 * credentials (detection only checks that auth files exist).
 *
 * The payload stays small on purpose: counts, levels, and top-N lists only.
 * The full tables live behind their own routes (/api/ops/health, /api/inbox,
 * /api/connections).
 */
function globalSnapshot(services) {
  const section = (name, fn, fallback) => {
    try {
      return fn();
    } catch (error) {
      services.log?.error?.(
        `[services] globalSnapshot.${name} failed: ${error?.message ?? error}`,
      );
      return fallback;
    }
  };
  const emptyCounts = {
    approvals: 0,
    runs: 0,
    reviews: 0,
    questions: 0,
    total: 0,
  };
  return {
    workspaces: section("workspaces", () => services.hub.list(), []),
    liveSessions: section(
      "liveSessions",
      () => liveSessionsSummary(services),
      [],
    ),
    connections: section(
      "connections",
      () => services.connections?.list?.() ?? [],
      [],
    ),
    inbox: section(
      "inbox",
      () => {
        const inbox = services.approvals?.inbox?.();
        if (!inbox)
          return {
            counts: emptyCounts,
            urgency: emptyUrgency,
            approvals: [],
            runs: [],
            reviews: [],
          };
        return {
          counts: inbox.counts,
          urgency: inboxUrgency(inbox, Date.now()),
          approvals: inbox.approvals.slice(0, 5),
          runs: inbox.runs.slice(0, 5),
          reviews: inbox.reviews.slice(0, 5),
        };
      },
      {
        counts: emptyCounts,
        urgency: emptyUrgency,
        approvals: [],
        runs: [],
        reviews: [],
      },
    ),
    // Provider circuit breakers and rate-limit parking from the run queue.
    // Counts and the parked providers only; the full table is behind
    // GET /api/ops/health.
    providers: section(
      "providers",
      () => {
        const worker = services.runWorker;
        if (!worker?.providerHealth)
          return { health: {}, outages: [], breakersOpen: 0 };
        const health = worker.providerHealth() ?? {};
        const outages = (worker.outage?.() ?? []).slice(0, 5);
        const breakersOpen = Object.values(health).filter(
          (entry) => entry?.state === "open",
        ).length;
        return { health, outages, breakersOpen };
      },
      { health: {}, outages: [], breakersOpen: 0 },
    ),
    // Operator state: is dispatch stopped, and are there stop requests that
    // no run has acknowledged yet (a headless worker that never received the
    // cancel). Counts only, plus the reason so a banner can explain itself.
    operations: section(
      "operations",
      () => {
        const status = services.incidents?.status?.();
        if (!status)
          return {
            dispatchStopped: false,
            unacknowledgedStops: 0,
            quarantinedHosts: 0,
            reason: null,
            stoppedAt: null,
          };
        return {
          dispatchStopped: status.dispatchStopped === true,
          unacknowledgedStops: status.unacknowledged?.length ?? 0,
          quarantinedHosts: status.quarantinedHosts?.length ?? 0,
          revokedConnections: status.revokedConnections?.length ?? 0,
          reason: status.reason ?? null,
          stoppedAt: status.stoppedAt ?? null,
        };
      },
      {
        dispatchStopped: false,
        unacknowledgedStops: 0,
        quarantinedHosts: 0,
        reason: null,
        stoppedAt: null,
      },
    ),
    // Health level plus the top alerts. The snapshot is cached for
    // HEALTH_CACHE_MS because it stats the database file, and the global
    // channel re-broadcasts on every recorded event.
    health: section("health", () => cachedHealth(services), {
      status: "unknown",
      alerts: [],
      alertCount: 0,
      checkedAt: null,
    }),
    settings: section(
      "settings",
      () => services.settings?.publicSubset?.() ?? {},
      {},
    ),
    observation: section(
      "observation",
      () => {
        const observation = services.observation;
        if (!observation)
          return { enabled: false, running: false, lastPollAt: null };
        return {
          enabled: observation.enabled(),
          running: observation.running,
          lastPollAt: observation.lastPollAt ?? null,
          observers: observation.observers.map((o) => o.provider),
        };
      },
      { enabled: false, running: false, lastPollAt: null },
    ),
  };
}
