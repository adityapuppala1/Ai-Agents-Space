#!/usr/bin/env node
// One command to run Agent Space: `npx agentspace`.
//
// This is the launcher, not the server. Everything it does is the work of
// turning "a package someone just downloaded" into "a running office", and
// each step exists because the plain server entry point assumes it is being
// run from a git clone:
//
//   - the database defaults to `data/` *inside the package*, which under npx
//     is a folder in the npm cache that the next run replaces. A user's work
//     belongs in the user's own data directory.
//   - the port is fixed, so a second copy — or anything else on 5173 — fails
//     with EADDRINUSE instead of simply moving over.
//   - nothing opens a browser, which is the whole point of one command.
//
// It adds no dependency: everything here is a Node built-in.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const has = (...names) => names.some((name) => args.includes(name));

if (has("--help", "-h")) {
  console.log(`Agent Space — a local-first command centre for AI coding agents.

  npx agentspace                 start it and open the browser
  npx agentspace --no-open       start it without opening a browser
  npx agentspace --port 6100     use a particular port
  npx agentspace --demo          load the simulated showcase workspace
  npx agentspace --data <dir>    keep the database somewhere else

Everything stays on this machine. Nothing is uploaded, and no account is
needed. Agent Space reads the session files your coding assistants already
write; it never writes to them.`);
  process.exit(0);
}

// `node:sqlite` is what lets this ship without a compiler or node-gyp, and it
// is the one thing that genuinely requires a recent Node. Say so plainly
// rather than letting an import fail with a stack trace.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(
    `Agent Space needs Node 22.13 or newer (this is ${process.versions.node}).\n` +
      `It uses node:sqlite, which is how it installs with no compiler and no native modules.\n` +
      `Install a current Node from https://nodejs.org and run this again.`,
  );
  process.exit(1);
}

/**
 * Where this machine keeps a user's application data. The database and the
 * run artifacts go here rather than inside the package, so they survive npx
 * replacing the package on the next run.
 */
function userDataDir() {
  const home = homedir();
  if (platform() === "win32")
    return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "agentspace");
  if (platform() === "darwin")
    return join(home, "Library", "Application Support", "agentspace");
  return join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "agentspace");
}

const flagValue = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : null;
};

const dataDir = flagValue("--data") ?? process.env.AGENT_SPACE_DATA_DIR ?? userDataDir();
mkdirSync(dataDir, { recursive: true });

/** True when something is already listening there. */
function inUse(port, host) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", (error) => resolve(error.code === "EADDRINUSE"));
    probe.once("listening", () => probe.close(() => resolve(false)));
    probe.listen(port, host);
  });
}

/**
 * The first free port at or after `from`. A second copy of Agent Space
 * should open beside the first, not refuse to start.
 */
async function freePort(from, host) {
  for (let port = from; port < from + 40; port += 1)
    if (!(await inUse(port, host))) return port;
  throw new Error(
    `No free port between ${from} and ${from + 39}. Pass --port to choose one.`,
  );
}

/** Opens the default browser. Never fatal: the URL is printed regardless. */
function openBrowser(url) {
  try {
    const [command, commandArgs] =
      platform() === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : platform() === "darwin"
          ? ["open", [url]]
          : ["xdg-open", [url]];
    const child = spawn(command, commandArgs, {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // A machine with no browser, or none registered, is not a failure.
  }
}

const host = process.env.HOST ?? "127.0.0.1";
const asked = Number(flagValue("--port") ?? process.env.PORT ?? 5173);
if (!Number.isInteger(asked) || asked < 1 || asked > 65535) {
  console.error(`--port must be a number between 1 and 65535 (got ${asked}).`);
  process.exit(1);
}
const port = await freePort(asked, host);
if (port !== asked)
  console.log(`Port ${asked} is busy; using ${port} instead.`);

// The server reads all of this from the environment, so the launcher's whole
// job is to decide it and then hand over.
process.env.PORT = String(port);
process.env.HOST = host;
process.env.AGENT_SPACE_DATA_DIR = dataDir;
process.env.AGENT_SPACE_DB ??= join(dataDir, "agent-space.sqlite");
if (has("--demo")) process.env.DEMO = "true";

const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
console.log(`Agent Space is starting on ${url}`);
console.log(`Your data stays in ${dataDir}`);

if (!has("--no-open")) {
  // After the server is listening, not before, so the first request lands on
  // something that can answer it.
  const ready = setTimeout(() => openBrowser(url), 1200);
  ready.unref?.();
}

// Imported as a file:// URL, not a path. On Windows `import("C:\\...")` is
// rejected outright — ESM only accepts file, data and node schemes — so
// converting the URL to a path here would break every Windows user.
await import(new URL("../packages/server/src/main.js", import.meta.url).href);
