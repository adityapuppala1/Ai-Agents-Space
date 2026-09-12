import { spawn, execFileSync, execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { PROVIDERS } from "../contracts.js";
import { InputError } from "../TaskStore.js";
import { pickExecutable } from "../providers/detect.js";

/**
 * Process helpers for managed runs: binary resolution, spawning with a
 * tolerant line splitter, and process-tree kills. Windows first: npm
 * `.cmd` shims are resolved to the Node script they wrap and spawned
 * directly (never through cmd.exe, whose quoting cannot carry a prompt
 * safely); any other `.cmd`/`.bat` is only run through the shell when its
 * arguments contain nothing cmd.exe would interpret.
 */

const cache = new Map();

/** Characters cmd.exe interprets inside a quoted argument (no escape exists). */
const CMD_UNSAFE = /["%!\r\n]/;

/** Splits a command line into arguments, honouring single and double quotes. */
export function splitArgs(text) {
  const args = [];
  let current = "";
  let quote = null;
  let has = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && text[i + 1] === '"') {
        current += '"';
        i++;
      } else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current || has) args.push(current);
      current = "";
      has = false;
      continue;
    }
    current += ch;
  }
  if (current || has) args.push(current);
  return args;
}

export function envKeyFor(providerId) {
  return `AGENT_SPACE_BIN_${String(providerId).toUpperCase().replace(/-/g, "_")}`;
}

function lookup(name, { timeoutMs = 5000, env = process.env } = {}) {
  const tool = process.platform === "win32" ? "where" : "which";
  // Windows `where.exe` can consult the parent PATH despite a scoped child
  // environment. Resolve the supplied PATH directly before falling back.
  const separator = process.platform === "win32" ? ";" : ":";
  const extensions = process.platform === "win32"
    ? String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((value) => value.trim())
    : [""];
  const paths = String(env.PATH ?? env.Path ?? "")
    .split(separator)
    .map((value) => value.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
    .flatMap((folder) => [name, ...extensions.map((extension) => `${name}${extension}`)].map((candidate) => resolvePath(folder, candidate)))
    .filter(existsSync);
  if (paths.length) return pickExecutable(paths, { env }) ?? paths[0];
  try {
    const out = execFileSync(tool, [name], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) return null;
    // `where` also lists extension-less POSIX shims (npm writes `copilot`
    // next to `copilot.cmd`) that spawn() cannot run; pick by PATHEXT.
    return pickExecutable(lines, { env: process.env }) ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolves the executable for a provider.
 *   - `AGENT_SPACE_BIN_<PROVIDER>` wins and may include arguments
 *     (e.g. `node "tests/fixtures/fake-cli/claude.js"`).
 *   - Otherwise `where`/`which` over the provider's known binary names.
 * Returns { command, args, resolved, source } and never throws.
 */
export function resolveBinary(providerId, env = process.env, options = {}) {
  const override = env[envKeyFor(providerId)];
  if (override && override.trim()) {
    const [command, ...args] = splitArgs(override.trim());
    return { command, args, resolved: true, source: "env" };
  }
  const names = options.names ??
    PROVIDERS[providerId]?.binaries ?? [providerId];
  const key = `${providerId}:${names.join("|")}:${env.PATH ?? env.Path ?? ""}`;
  if (!options.noCache && cache.has(key)) return cache.get(key);
  let result = null;
  for (const name of names) {
    const found = (options.which ?? ((binary) => lookup(binary, { env })))(name);
    if (found) {
      result = { command: found, args: [], resolved: true, source: "path" };
      break;
    }
  }
  if (!result)
    result = { command: names[0], args: [], resolved: false, source: "none" };
  cache.set(key, result);
  return result;
}

export function clearBinaryCache() {
  cache.clear();
}

export function needsShell(command) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

/**
 * Resolves an npm `.cmd` shim (cmd-shim format) to the Node script it runs,
 * so the provider can be spawned as `node <script> ...args` without cmd.exe.
 * Returns `{ command, args }` or null when the file is not a recognisable
 * Node shim.
 */
export function resolveCmdShim(command) {
  if (!/\.cmd$/i.test(String(command ?? ""))) return null;
  let text;
  try {
    text = readFileSync(command, "utf8");
  } catch {
    return null;
  }
  if (!/\bnode(\.exe)?\b/i.test(text)) return null;
  const match = /"?%~?dp0%?[\\/]?([^"\r\n]+?\.(?:m?js|cjs))"?\s+%\*/i.exec(
    text,
  );
  if (!match) return null;
  const script = resolvePath(dirname(command), match[1]);
  if (!existsSync(script)) return null;
  return { command: process.execPath, args: [script] };
}

/** Refuses arguments cmd.exe would rewrite or split; there is no escape for them. */
export function assertShellSafe(args) {
  for (const value of args) {
    const text = String(value);
    if (CMD_UNSAFE.test(text))
      throw new InputError(
        'Cannot pass this text through a .cmd/.bat shim: it contains a character cmd.exe interprets (", %, !, or a line break). Point AGENT_SPACE_BIN_<PROVIDER> at the real executable or the Node script instead.',
        409,
      );
  }
}

function quoteForShell(value) {
  const text = String(value);
  if (!/[\s&|<>^()]/.test(text)) return text;
  return `"${text}"`;
}

/** Creates a chunk consumer that emits complete lines and tolerates partial ones. */
export function createLineSplitter(onLine) {
  let buffer = "";
  const push = (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (line.trim()) onLine(line);
    }
    if (buffer.length > 4 * 1024 * 1024) {
      // A pathological line without newline; flush it rather than grow forever.
      const line = buffer;
      buffer = "";
      onLine(line);
    }
  };
  push.flush = () => {
    const line = buffer.replace(/\r$/, "");
    buffer = "";
    if (line.trim()) onLine(line);
  };
  return push;
}

/**
 * Spawns a provider CLI. stdin is closed by default (`ignore`); pass
 * `stdin: "pipe"` for JSON-RPC transports. Returns the child process.
 */
export function spawnProvider({
  command,
  args = [],
  cwd,
  env = process.env,
  onLine = () => {},
  onStderr = () => {},
  onExit = () => {},
  onError = null,
  stdin = "ignore",
}) {
  let launchCommand = command;
  let launchArgs = args;
  const shim = needsShell(command) ? resolveCmdShim(command) : null;
  if (shim) {
    launchCommand = shim.command;
    launchArgs = [...shim.args, ...args];
  }
  const useShell = needsShell(launchCommand);
  if (useShell) assertShellSafe([launchCommand, ...launchArgs]);
  const options = {
    cwd,
    env,
    windowsHide: true,
    stdio: [stdin, "pipe", "pipe"],
    // Own process group on POSIX so killTree can signal every descendant.
    detached: process.platform !== "win32",
  };
  const child = useShell
    ? spawn(
        [quoteForShell(launchCommand), ...launchArgs.map(quoteForShell)].join(
          " ",
        ),
        [],
        { ...options, shell: true },
      )
    : spawn(launchCommand, launchArgs, { ...options, shell: false });
  const out = createLineSplitter(onLine);
  const err = createLineSplitter(onStderr);
  // Decode as a stream so a multibyte character split across chunks survives.
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", out);
  child.stderr?.on("data", err);
  let exited = false;
  child.on("error", (error) => {
    if (onError) onError(error);
    if (!exited) {
      exited = true;
      onExit(null, null, error);
    }
  });
  child.on("close", (code, signal) => {
    out.flush();
    err.flush();
    if (!exited) {
      exited = true;
      onExit(code, signal, null);
    }
  });
  return child;
}

/** Kills a process and its descendants. Resolves when the kill was issued. */
export function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(false);
    if (process.platform === "win32") {
      execFile(
        "taskkill",
        ["/pid", String(pid), "/t", "/f"],
        { windowsHide: true, timeout: 10000 },
        () => resolve(true),
      );
      return;
    }
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        return resolve(false);
      }
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      resolve(true);
    }, 2000);
    timer.unref?.();
  });
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function fileExists(path) {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}
