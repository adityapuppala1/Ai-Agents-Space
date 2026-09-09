import { EventEmitter } from "node:events";
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
 *   db, bus, hub → settings → audit → policy → connections → recorder →
 *   approvals → hookBridge → observation → runWorker (+ adapters) →
 *   workflows (TaskGraph + WorkflowService + templates) → analytics → context
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
    onClose(fn) {
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

  // 6. Workflows (task graph + templates), analytics, context manifests.
  const graph = new TaskGraph(services);
  services.graph = graph;
  services.workflows = new WorkflowService(services, { graph });
  services.analytics = new Analytics(services, {
    pricing: options.pricing ?? null,
  });
  services.context = new ContextManifest(services, {
    git: options.git ?? true,
  });

  return services;
}

/**
 * Global channel payload. Each section is guarded so one failing module
 * cannot take the whole broadcast down. Connection rows never contain
 * credentials (detection only checks that auth files exist).
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
          return { counts: emptyCounts, approvals: [], runs: [], reviews: [] };
        return {
          counts: inbox.counts,
          approvals: inbox.approvals.slice(0, 5),
          runs: inbox.runs.slice(0, 5),
          reviews: inbox.reviews.slice(0, 5),
        };
      },
      { counts: emptyCounts, approvals: [], runs: [], reviews: [] },
    ),
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
