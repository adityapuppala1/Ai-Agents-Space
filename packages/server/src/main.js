import { fileURLToPath } from "node:url";
import { createServices } from "../../core/src/services.js";
import {
  status as hookStatus,
  defaultSettingsPath,
  HOOK_EVENTS,
} from "../../core/src/hooks/installer.js";
import { createWorkspaceServer } from "./server.js";

const port = Number(process.env.PORT ?? 5173);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be between 1 and 65535");
const host = process.env.HOST ?? "127.0.0.1";

// AGENT_SPACE_DB: path to the SQLite file, or ":memory:" for a throwaway
// database. Defaults to data/agent-space.sqlite in the project root.
const dbPath =
  process.env.AGENT_SPACE_DB ||
  fileURLToPath(new URL("../../../data/agent-space.sqlite", import.meta.url));
const observe = process.env.AGENT_SPACE_OBSERVE !== "false";

// How often the outbound webhook queue is drained and the health level is
// refreshed. Both timers are unref'd so they never hold the process open.
const WEBHOOK_INTERVAL_MS =
  Number(process.env.AGENT_SPACE_WEBHOOK_INTERVAL) || 30_000;
const HEALTH_INTERVAL_MS =
  Number(process.env.AGENT_SPACE_HEALTH_INTERVAL) || 60_000;

const services = createServices({
  dbPath,
  // Production starts from recorded provider activity. The showcase is an
  // explicit opt-in (`DEMO=true`) and remains available to tests and demos.
  demo: process.env.DEMO === "true",
  port,
});
let server;
try {
  server = createWorkspaceServer({ services });
} catch (error) {
  console.error(`Unable to start Agent Space: ${error.message}`);
  await services.close();
  process.exit(1);
}
server.on("error", (error) => {
  console.error(`Unable to start Agent Space: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, host, () => {
  console.log(`Agent Space: http://127.0.0.1:${port} (database: ${dbPath})`);
  startup().catch((error) =>
    console.error(`Startup tasks failed: ${error?.stack ?? error}`),
  );
});

/** Resolves with { value } or { timedOut: true } after `ms`; never rejects. */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
    timer.unref?.();
  });
  return Promise.race([
    promise.then(
      (value) => ({ value }),
      (error) => ({ error }),
    ),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

async function startup() {
  // startup() runs detached from the listen callback and can take well over
  // 10 s, so the process may already be shutting down between any two steps.
  // Every await point is followed by this check: without it, reconciliation,
  // settings writes and the observation loop all run against a closed
  // database and fill the shutdown log with failures that are not real.
  const stopped = () => services.closed === true;

  // 1. Detect provider CLIs (never blocks startup for more than 10 s).
  const detection = await withTimeout(services.connections.refresh(), 10_000);
  if (stopped()) return;
  if (detection.timedOut)
    console.warn(
      "Provider detection is still running after 10 s; results will appear on the Connections page when it finishes.",
    );
  else if (detection.error)
    console.error(`Provider detection failed: ${detection.error.message}`);

  // 2. Managed runs that were running when the server last stopped.
  let disconnected = [];
  try {
    disconnected = services.runWorker.reconcile();
  } catch (error) {
    console.error(`Run reconciliation failed: ${error.message}`);
  }

  // 2b. Placeholder runs an earlier version left on provider work: they said
  // a task was running before anything was, and never cleared from a stop.
  let placeholders = [];
  try {
    placeholders = services.hub.closeProviderPlaceholders();
  } catch (error) {
    console.error(`Placeholder cleanup failed: ${error.message}`);
  }

  // 3. Claude Code hook status (reads ~/.claude/settings.json; never writes).
  let hooksLabel = "unknown";
  try {
    const hooks = hookStatus(defaultSettingsPath());
    hooksLabel = hooks.installed
      ? `installed (${hooks.events.length}/${HOOK_EVENTS.length} events)`
      : "not installed";
    if (services.settings.get("hooks.claudeCode.installed") !== hooks.installed)
      services.settings.set("hooks.claudeCode.installed", hooks.installed);
  } catch (error) {
    hooksLabel = `unknown (${error.message})`;
  }

  // 4. Dependency workflows dispatch ready dependents on completion.
  try {
    services.workflows.graph.watch();
  } catch (error) {
    console.error(`Workflow watcher failed to start: ${error.message}`);
  }

  // 4b. Schedules. Opt-in twice: the setting must be on AND each schedule
  // enabled, so an upgrade never starts dispatching work on its own.
  let scheduled = "off";
  try {
    const result = await services.scheduler.start();
    scheduled = result.started
      ? `on (${services.scheduler.status().enabled ?? 0} enabled)`
      : `off (${result.reason})`;
  } catch (error) {
    scheduled = `failed (${error.message})`;
  }

  // 5. Observation of provider sessions started outside Agent Space.
  if (observe) {
    services.observation.start();
    await services.observation.poll().catch(() => {});
    if (stopped()) return;
  }

  // 6. Optional modules that this build may or may not contain.
  const optional = await (services.ready ?? Promise.resolve([]));
  if (stopped()) return;

  // 7. Retention sweeps. The timer starts only when the policy is enabled;
  // a disabled policy keeps everything and says so in the startup line.
  let retentionLabel = "not available";
  try {
    const policy = services.retention?.policy?.();
    services.retention?.start?.();
    retentionLabel = !policy
      ? "not available"
      : policy.enabled
        ? `on (events ${policy.eventsDays ?? "forever"}d, runs ${
            policy.runsDays ?? "forever"
          }d, audit ${policy.auditDays ?? "forever"}d)`
        : "off (nothing is deleted)";
  } catch (error) {
    retentionLabel = `error (${error.message})`;
  }

  // 8. Outbound webhook deliveries. Nothing is sent unless an endpoint exists;
  // deliverDue() drains the retry queue with the service's own backoff.
  if (services.webhooks?.deliverDue) {
    const timer = setInterval(() => {
      services.webhooks
        .deliverDue({})
        .catch((error) =>
          console.error(`Webhook delivery failed: ${error?.message ?? error}`),
        );
    }, WEBHOOK_INTERVAL_MS);
    timer.unref?.();
    services.onClose(() => clearInterval(timer));
  }

  // 9. Scheduled reports (analytics.reports). The cadence timer is unref'd,
  // a disabled report is never due, and a report only ever writes CSV/JSON to
  // a local directory — nothing is transmitted anywhere.
  let reportsLabel = "not available";
  try {
    const reports = services.analytics?.reports;
    if (reports?.start) {
      reports.start();
      const enabled = (reports.list?.() ?? []).filter((r) => r.enabled).length;
      reportsLabel = enabled ? `${enabled} enabled` : "none enabled";
      services.onClose(() => reports.stop?.());
    }
  } catch (error) {
    reportsLabel = `error (${error.message})`;
  }

  // 10. Health. The snapshot is computed on demand; this timer only refreshes
  // the level so the global channel can show a banner without every client
  // polling. A change in level forces one global broadcast.
  let healthLabel = "not available";
  let health = null;
  try {
    health = services.health?.snapshot?.() ?? null;
    if (health) {
      healthLabel = `${health.status}${
        health.alerts?.length ? ` (${health.alerts.length} alert(s))` : ""
      }`;
      let lastStatus = health.status;
      const timer = setInterval(() => {
        try {
          const next = services.health.snapshot();
          if (next.status !== lastStatus) {
            lastStatus = next.status;
            services.bus.emit("global");
          }
        } catch {
          /* health must never crash the server */
        }
      }, HEALTH_INTERVAL_MS);
      timer.unref?.();
      services.onClose(() => clearInterval(timer));
    }
  } catch (error) {
    healthLabel = `error (${error.message})`;
  }

  const connections = services.connections.list();
  const providers = connections.length
    ? connections
        .map((c) =>
          `${c.provider} ${c.version ?? ""} ${c.status}`.replace(/\s+/g, " "),
        )
        .join(", ")
    : "none checked yet";
  const live = observe ? services.observation.liveSessions().length : 0;
  console.log(
    `Startup: providers — ${providers} | live sessions: ${live} | hooks: ${hooksLabel} | schedules: ${scheduled} | observation: ${
      observe ? "on" : "off (AGENT_SPACE_OBSERVE=false)"
    }${disconnected.length ? ` | ${disconnected.length} run(s) marked disconnected` : ""}${
      placeholders.length
        ? ` | ${placeholders.length} placeholder run(s) closed on provider work`
        : ""
    }`,
  );

  // Operational facts an operator needs before touching anything.
  const incident = services.incidents?.status?.() ?? null;
  const breakers = Object.entries(services.runWorker?.providerHealth?.() ?? {})
    .filter(([, state]) => state?.state && state.state !== "closed")
    .map(([provider, state]) => `${provider}:${state.state}`);
  console.log(
    `Operations: dispatch ${
      incident?.dispatchStopped
        ? `STOPPED${incident.reason ? ` — ${incident.reason}` : ""}`
        : "allowed"
    }${
      incident?.unacknowledged?.length
        ? ` | ${incident.unacknowledged.length} stop request(s) not acknowledged by a run`
        : ""
    } | circuit breakers: ${breakers.length ? breakers.join(", ") : "all closed"} | retention: ${retentionLabel} | scheduled reports: ${reportsLabel} | health: ${healthLabel}${
      optional.length ? ` | optional modules: ${optional.join(", ")}` : ""
    }`,
  );
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; stopping runs and closing the database`);
  const force = setTimeout(() => process.exit(1), 8_000);
  force.unref?.();
  try {
    // Kills provider child processes (process trees on win32) and stops timers.
    await services.close();
  } catch (error) {
    console.error(`Shutdown error: ${error.message}`);
  }
  server.close(() => process.exit(0));
  server.closeAllConnections?.();
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => shutdown(signal));
