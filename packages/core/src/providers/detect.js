import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { extname, join, isAbsolute, resolve as resolvePath } from "node:path";
import {
  REGISTRY,
  REGISTRY_IDS,
  binaryOverrideEnvName,
  compareVersions,
} from "./registry.js";
import { providerHome } from "../util/paths.js";

/**
 * Provider detection: finds each provider's CLI on PATH (or through the
 * `AGENT_SPACE_BIN_<PROVIDER>` override), probes `--version` with a hard
 * timeout, and reports home-directory / credential-file existence.
 *
 * Nothing here reads credential contents. Every child process is killed on
 * timeout or abort so a wedged CLI can never hang the server.
 */

export const DETECTION_CACHE_TTL_MS = 60_000;
export const AUTH_HINTS = [
  "logged-in-likely",
  "no-credentials-file",
  "unknown",
];

const cache = new Map();
const MAX_OUTPUT = 64 * 1024;

export function clearDetectionCache() {
  cache.clear();
}

function isWindows(platform) {
  return (platform ?? process.platform) === "win32";
}

function envPath(env) {
  return env.PATH ?? env.Path ?? env.path ?? "";
}

/** Splits a command string honouring double/single quotes. */
export function parseCommandLine(value) {
  const parts = [];
  const text = String(value ?? "").trim();
  let current = "";
  let quote = null;
  let hasToken = false;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
    } else if (/\s/.test(char)) {
      if (hasToken || current) parts.push(current);
      current = "";
      hasToken = false;
    } else {
      current += char;
      hasToken = true;
    }
  }
  if (hasToken || current) parts.push(current);
  return parts;
}

/** First version-looking token in probe output (e.g. "2.1.266", "0.152.1-beta"). */
export function parseVersion(text) {
  const match = String(text ?? "").match(
    /(?<![\w.])v?(\d+\.\d+(?:\.\d+)*(?:[-+][\w.]+)?)(?![\w])/,
  );
  return match ? match[1] : null;
}

function killTree(child, platform) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    if (isWindows(platform)) {
      const root =
        process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
      spawn(
        join(root, "System32", "taskkill.exe"),
        ["/pid", String(child.pid), "/t", "/f"],
        {
          windowsHide: true,
          stdio: "ignore",
        },
      ).on("error", () => {});
    }
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

/**
 * Spawns a command, collects stdout/stderr, and resolves after exit. Never
 * rejects; the result carries `error` / `timedOut` instead. Supports
 * `signal` (AbortSignal) for cancellation.
 */
export function runCommand(
  command,
  args = [],
  {
    timeoutMs = 5000,
    env = process.env,
    cwd,
    shell = false,
    signal,
    platform,
  } = {},
) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;
    const started = Date.now();
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve({
        code: null,
        stdout,
        stderr,
        timedOut: false,
        aborted: false,
        error: null,
        durationMs: Date.now() - started,
        ...result,
      });
    };
    const onAbort = () => {
      killTree(child, platform);
      finish({ aborted: true, error: "cancelled" });
    };
    const timer = setTimeout(() => {
      killTree(child, platform);
      finish({ timedOut: true, error: `timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.("abort", onAbort, { once: true });
    try {
      // With a shell (Windows .cmd shims) pass one pre-quoted command line so
      // Node does not concatenate unescaped args (DEP0190).
      const spawnCommand = shell
        ? [command, ...args.map(quoteIfNeeded)].join(" ")
        : command;
      child = spawn(spawnCommand, shell ? [] : args, {
        cwd,
        env,
        shell,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      return finish({ error: error.message });
    }
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish({ error: error.message }));
    child.on("close", (code) => finish({ code }));
  });
}

function quoteIfNeeded(value) {
  return /[\s"]/.test(value) && !/^".*"$/.test(value)
    ? `"${value.replace(/"/g, '\\"')}"`
    : value;
}

/** True when a resolved binary must run through the shell (Windows shims). */
export function needsShell(binaryPath, platform) {
  return isWindows(platform) && /\.(cmd|bat)$/i.test(String(binaryPath ?? ""));
}

function whereExecutable(env, platform) {
  if (!isWindows(platform)) return "which";
  const root =
    env.SystemRoot ?? env.windir ?? process.env.SystemRoot ?? "C:\\Windows";
  return join(root, "System32", "where.exe");
}

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** Lower-cased executable extensions from PATHEXT (win32 only). */
export function executableExtensions(env = process.env) {
  const raw = env.PATHEXT ?? env.Pathext ?? env.pathext ?? DEFAULT_PATHEXT;
  const list = String(raw)
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith("."));
  return list.length ? list : DEFAULT_PATHEXT.toLowerCase().split(";");
}

/**
 * Picks the binary to spawn from the candidates `where`/`which` printed.
 * On win32 `where` lists every match on PATH, including extension-less POSIX
 * shims (npm writes `copilot` next to `copilot.cmd`) that `spawn` cannot run
 * (ENOENT), so the first candidate with a PATHEXT extension wins.
 */
export function pickExecutable(
  candidates,
  { env = process.env, platform } = {},
) {
  const existing = candidates.filter((line) => line && existsSync(line));
  if (!existing.length) return null;
  if (!isWindows(platform)) return existing[0];
  const extensions = executableExtensions(env);
  return (
    existing.find((line) => extensions.includes(extname(line).toLowerCase())) ??
    existing[0]
  );
}

/**
 * Resolves a bare command name to an executable path using `where` (win32)
 * or `which`. Returns null when not found. Respects `env.PATH`.
 */
export async function defaultWhich(
  name,
  { env = process.env, timeoutMs = 5000, signal, platform } = {},
) {
  const result = await runCommand(whereExecutable(env, platform), [name], {
    env,
    timeoutMs,
    signal,
    platform,
  });
  if (result.error && !result.stdout) throw new Error(result.error);
  if (result.code !== 0) return null;
  return pickExecutable(
    result.stdout.split(/\r?\n/).map((line) => line.trim()),
    { env, platform },
  );
}

function fileExists(path) {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function directoryExists(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function authHintFor(definition, homePath, homeExists, env = process.env) {
  // Some providers accept an environment credential instead of a file
  // (Gemini: GEMINI_API_KEY / GOOGLE_GENAI_USE_VERTEXAI / GOOGLE_GENAI_USE_GCA).
  // Only the presence of the variable is checked; the value is never read.
  const fromEnv = (definition.authEnv ?? []).some(
    (name) => typeof env?.[name] === "string" && env[name].trim() !== "",
  );
  if (fromEnv) return "logged-in-likely";
  if (!definition.authFiles?.length) return "unknown";
  if (!homeExists) return "no-credentials-file";
  return definition.authFiles.some((name) => fileExists(join(homePath, name)))
    ? "logged-in-likely"
    : "no-credentials-file";
}

/**
 * Honest error categories for a connection's health. Every value has a
 * plain-language remediation (see `remediationFor`). `null` means healthy.
 */
export const ERROR_CATEGORIES = [
  "not-installed",
  "not-logged-in",
  "version-unsupported",
  "permission-denied",
  "binary-unrunnable",
  "timeout",
  "rate-limited",
  "unknown",
];

/**
 * The Gemini CLI prints this exact instruction (exit code 41) when no auth
 * method is configured. Reused verbatim so the remediation is the provider's
 * own wording, not ours.
 */
export const GEMINI_AUTH_FIX =
  "Please set an Auth method in your ~/.gemini/settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA";

/** Plain-language fix for one error category, tailored per provider. */
export function remediationFor(category, providerId = null) {
  const definition = providerId ? REGISTRY[providerId] : null;
  const name = definition?.name ?? "The provider CLI";
  const binary = definition?.binaries?.[0] ?? "the CLI";
  switch (category) {
    case "not-installed":
      return (
        definition?.installHint ??
        `Install ${name} and make sure ${binary} is on PATH.`
      );
    case "not-logged-in":
      if (providerId === "gemini") return GEMINI_AUTH_FIX;
      return `Run \`${binary}\` once in a terminal and complete the sign-in. Agent Space never collects or stores credentials; it only checks that the provider's own credential file exists.`;
    case "version-unsupported":
      return `Update ${binary} to ${definition?.minVersion ?? "a newer version"} or newer: the launch and stream formats were verified on ${definition?.verifiedVersions?.join(", ") || "a later version"}.`;
    case "permission-denied":
      return `Windows or your security software refused to run ${binary}. Check the file permissions and any antivirus or AppLocker rule, then probe the connection again.`;
    case "binary-unrunnable":
      return `${binary} was found but could not be run. Try \`${binary} --version\` in a terminal and fix what it reports (a broken npm shim usually needs a reinstall).`;
    case "timeout":
      return `${binary} did not answer \`--version\` in time. Run it once in a terminal (a first run may download or update itself), then probe again.`;
    case "rate-limited":
      return `${name} reported a rate or usage limit. Wait for the limit to reset or use a different account, then probe again.`;
    default:
      return `Run \`${binary} --version\` in a terminal and fix what it reports.`;
  }
}

/**
 * Derives an honest error category from a detection entry. Nothing is
 * invented: the category comes from what the probe actually reported, the
 * provider's own credential file, and the registry's minimum version.
 *
 * @returns {{category: string|null, detail: string|null, remediation: string|null}}
 */
export function categorizeDetection(entry, { env = process.env } = {}) {
  const definition = REGISTRY[entry?.provider] ?? null;
  const done = (category, detail) => ({
    category,
    detail: detail ? String(detail).slice(0, 500) : null,
    remediation: category ? remediationFor(category, entry?.provider) : null,
  });
  if (!entry) return done("unknown", "No detection result");
  if (!entry.found)
    return done(
      "not-installed",
      entry.error ??
        `No ${definition?.binaries?.join(" / ") ?? "CLI"} was found on PATH.`,
    );
  const error = String(entry.error ?? "");
  if (error) {
    if (/timed out/i.test(error)) return done("timeout", error);
    if (/rate.?limit|usage limit|429|quota/i.test(error))
      return done("rate-limited", error);
    if (/eacces|eperm|permission denied|access is denied/i.test(error))
      return done("permission-denied", error);
    return done("binary-unrunnable", error);
  }
  // Sign-in comes before the version check: it is the first thing the user
  // has to fix, and the doctor reports an old version separately anyway.
  const hint =
    entry.authHint ??
    authHintFor(
      definition ?? {},
      entry.homePath ?? "",
      Boolean(entry.homeExists),
      env,
    );
  if (hint === "no-credentials-file")
    return done(
      "not-logged-in",
      entry.provider === "gemini"
        ? "No ~/.gemini/settings.json and no GEMINI_API_KEY / GOOGLE_GENAI_USE_VERTEXAI / GOOGLE_GENAI_USE_GCA in the environment."
        : `No credential file was found under ${entry.homePath ?? "the provider home"} (existence only; contents are never read).`,
    );
  if (
    definition?.minVersion &&
    entry.version &&
    compareVersions(entry.version, definition.minVersion) < 0
  )
    return done(
      "version-unsupported",
      `${entry.version} is older than ${definition.minVersion}`,
    );
  return done(null, null);
}

/**
 * Auth expiry, honestly: none of the five providers writes an expiry we are
 * allowed to read (Agent Space checks file existence only and never opens a
 * credential file), so this is always null. It exists so the column has a
 * single documented source instead of an invented value.
 */
export function authExpiryFor() {
  return null;
}

/**
 * Detects one provider. Options mirror `detectProviders`.
 */
export async function detectProvider(
  providerId,
  {
    env = process.env,
    which = defaultWhich,
    timeoutMs = 5000,
    versionTimeoutMs = 8000,
    cwd = process.cwd(),
    signal,
    platform,
    now = Date.now,
  } = {},
) {
  const definition = REGISTRY[providerId];
  if (!definition) throw new Error(`Unknown provider: ${providerId}`);
  const entry = {
    provider: providerId,
    found: false,
    binaryPath: null,
    binaryName: null,
    version: null,
    versionOutput: null,
    homePath: null,
    homeExists: false,
    authHint: "unknown",
    override: false,
    error: null,
    probedAt: now(),
  };
  try {
    entry.homePath = providerHome(providerId, env, { platform });
    entry.homeExists = directoryExists(entry.homePath);
    entry.authHint = authHintFor(
      definition,
      entry.homePath,
      entry.homeExists,
      env,
    );
  } catch (error) {
    entry.error = `home: ${error.message}`;
  }

  let command = null;
  let args = [];
  let shell = false;
  const override = env[binaryOverrideEnvName(providerId)];
  if (typeof override === "string" && override.trim()) {
    const parts = parseCommandLine(override);
    if (parts.length) {
      entry.override = true;
      entry.found = true;
      entry.binaryPath = override.trim();
      entry.binaryName = parts[0];
      command = parts[0];
      args = parts.slice(1);
      if (!isAbsolute(command) && /[\\/]/.test(command))
        command = resolvePath(cwd, command);
      if (needsShell(command, platform)) {
        shell = true;
        command = quoteIfNeeded(command);
      }
    }
  } else {
    for (const name of definition.binaries) {
      if (signal?.aborted) break;
      let resolved = null;
      try {
        resolved = await which(name, { env, timeoutMs, signal, platform });
      } catch (error) {
        entry.error = `lookup ${name}: ${error.message}`;
        continue;
      }
      if (resolved) {
        entry.found = true;
        entry.binaryPath = resolved;
        entry.binaryName = name;
        command = resolved;
        if (needsShell(resolved, platform)) {
          shell = true;
          command = quoteIfNeeded(resolved);
        }
        entry.error = null;
        break;
      }
    }
  }

  if (entry.found && command) {
    const result = await runCommand(
      command,
      [...args, ...(definition.versionArgs ?? ["--version"])],
      { env, cwd, timeoutMs: versionTimeoutMs, shell, signal, platform },
    );
    const output = `${result.stdout}\n${result.stderr}`.trim();
    entry.versionOutput = output.slice(0, 400) || null;
    // A version printed on stderr only counts when the probe succeeded;
    // otherwise a crashing wrapper (e.g. a missing script run through node)
    // would be reported with the wrapper runtime's own version.
    entry.version =
      parseVersion(result.stdout) ??
      (result.code === 0 ? parseVersion(result.stderr) : null);
    if (result.error) entry.error = `version probe: ${result.error}`;
    else if (result.code !== 0 && !entry.version)
      entry.error = `version probe exited with code ${result.code}`;
  }
  return entry;
}

function cacheKey(env, providerIds) {
  const parts = [envPath(env), providerIds.join(",")];
  for (const id of providerIds) {
    const definition = REGISTRY[id];
    parts.push(env[binaryOverrideEnvName(id)] ?? "");
    parts.push(env[definition.homeEnv] ?? "");
  }
  parts.push(env.HOME ?? "", env.USERPROFILE ?? "");
  return parts.join("\u0000");
}

/**
 * Detects every registered provider (or `providers`). Results are cached for
 * `DETECTION_CACHE_TTL_MS` per environment; pass `force: true` to bypass.
 * Never rejects for a single provider failure; each entry carries `error`.
 *
 * Returns `[{ provider, found, binaryPath, version, homePath, homeExists,
 * authHint, error, probedAt, override }]`.
 */
export async function detectProviders({
  env = process.env,
  which = defaultWhich,
  timeoutMs = 5000,
  versionTimeoutMs = 8000,
  cwd = process.cwd(),
  signal,
  platform,
  now = Date.now,
  force = false,
  providers = REGISTRY_IDS,
  ttlMs = DETECTION_CACHE_TTL_MS,
} = {}) {
  const key = cacheKey(env, providers);
  const cached = cache.get(key);
  if (!force && cached && now() - cached.at < ttlMs) return cached.entries;
  const entries = await Promise.all(
    providers.map((id) =>
      detectProvider(id, {
        env,
        which,
        timeoutMs,
        versionTimeoutMs,
        cwd,
        signal,
        platform,
        now,
      }).catch((error) => ({
        provider: id,
        found: false,
        binaryPath: null,
        version: null,
        homePath: null,
        homeExists: false,
        authHint: "unknown",
        override: false,
        error: error.message,
        probedAt: now(),
      })),
    ),
  );
  if (!signal?.aborted) cache.set(key, { at: now(), entries });
  return entries;
}
