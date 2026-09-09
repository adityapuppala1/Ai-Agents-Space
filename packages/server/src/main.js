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

const services = createServices({
  dbPath,
  demo: process.env.DEMO !== "false",
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
  // 1. Detect provider CLIs (never blocks startup for more than 10 s).
  const detection = await withTimeout(services.connections.refresh(), 10_000);
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

  // 5. Observation of provider sessions started outside Agent Space.
  if (observe) {
    services.observation.start();
    await services.observation.poll().catch(() => {});
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
    `Startup: providers — ${providers} | live sessions: ${live} | hooks: ${hooksLabel} | observation: ${
      observe ? "on" : "off (AGENT_SPACE_OBSERVE=false)"
    }${disconnected.length ? ` | ${disconnected.length} run(s) marked disconnected` : ""}`,
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
