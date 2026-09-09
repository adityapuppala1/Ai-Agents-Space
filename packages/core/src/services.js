import { EventEmitter } from "node:events";
import { openDatabase } from "./db.js";
import { WorkspaceHub } from "./WorkspaceHub.js";

/**
 * Service container. Every long-lived component is created here once and
 * shared by the HTTP server, the CLI, and tests.
 *
 * Fields that other modules may add (see docs/ARCHITECTURE.md):
 *   settings, audit, policy, connections, observation, runWorker, approvals,
 *   analytics, workflows, context, hookBridge.
 *
 * `bus` is a process-wide EventEmitter for cross-module notifications:
 *   "global"            → something outside a single workspace changed
 *                          (connections, approvals, live sessions); server
 *                          re-broadcasts the global snapshot.
 *   "workspace:<id>"    → force a snapshot broadcast for one workspace.
 */
export function createServices(options = {}) {
  const db = options.db ?? openDatabase(options.dbPath ?? ":memory:");
  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  const hub = new WorkspaceHub(db, { demo: options.demo ?? false });
  const services = {
    db,
    bus,
    hub,
    options,
    ownsDatabase: !options.db,
    /** Returns cross-workspace state for the global WebSocket channel. */
    globalSnapshot() {
      return { workspaces: hub.list() };
    },
    /** Called on server close: stop timers, kill child processes, close db. */
    async close() {
      for (const stop of services._closers) {
        try {
          await stop();
        } catch {
          /* best effort */
        }
      }
      if (services.ownsDatabase) db.close();
    },
    _closers: [],
    onClose(fn) {
      services._closers.push(fn);
    },
  };
  return services;
}
