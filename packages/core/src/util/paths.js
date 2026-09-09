import { homedir } from "node:os";
import { PROVIDERS } from "../contracts.js";

/**
 * Shared path helpers. Windows first: every helper accepts backslash or
 * forward-slash input and compares case-insensitively on win32.
 *
 * All helpers are pure; pass `platform` to test non-host behaviour.
 */

const DRIVE = /^[A-Za-z]:(?=\/|$)/;

function isWindows(platform) {
  return (platform ?? process.platform) === "win32";
}

/**
 * Canonical string form of a path: forward slashes, no duplicate separators
 * (a leading `//` UNC prefix is preserved), drive letter lower-cased, no
 * trailing slash (except the root `/` or `c:/`).
 */
export function normalizePath(input, { platform } = {}) {
  if (input === null || input === undefined) return "";
  let path = String(input).trim();
  if (!path) return "";
  path = path.replace(/\\/g, "/");
  const unc = path.startsWith("//");
  path = path.replace(/\/{2,}/g, "/");
  if (unc) path = "/" + path;
  if (DRIVE.test(path) && (isWindows(platform) || /^[A-Z]:/.test(path))) {
    path = path[0].toLowerCase() + path.slice(1);
  }
  // Strip trailing slash unless the path is a bare root.
  if (path.length > 1 && path.endsWith("/") && !/^[a-z]:\/$/i.test(path)) {
    path = path.replace(/\/+$/, "");
  }
  return path;
}

function comparable(path, platform) {
  const normalized = normalizePath(path, { platform });
  return isWindows(platform) ? normalized.toLowerCase() : normalized;
}

/** True when both paths point at the same location (case-insensitive on win32). */
export function samePath(a, b, { platform } = {}) {
  const left = comparable(a, platform);
  const right = comparable(b, platform);
  if (!left || !right) return false;
  return left === right;
}

/** True when `child` equals `parent` or lives underneath it. */
export function isWithin(child, parent, { platform } = {}) {
  const inner = comparable(child, platform);
  const outer = comparable(parent, platform);
  if (!inner || !outer) return false;
  if (inner === outer) return true;
  const prefix = outer.endsWith("/") ? outer : outer + "/";
  return inner.startsWith(prefix);
}

/** Expands a leading `~` (or `~/x`, `~\x`) to the home directory. */
export function expandHome(input, home = homedir()) {
  if (input === null || input === undefined) return "";
  const path = String(input).trim();
  if (path === "~") return String(home);
  if (/^~[\\/]/.test(path)) return `${home}${path.slice(1)}`;
  return path;
}

function homeFromEnv(env) {
  return env.HOME || env.USERPROFILE || homedir();
}

/**
 * Resolves a provider's home directory: the `homeEnv` override when set,
 * otherwise `homeDefault` with `~` expanded. Returns a normalized path.
 */
export function providerHome(providerId, env = process.env, { platform } = {}) {
  const definition = PROVIDERS[providerId];
  if (!definition) throw new Error(`Unknown provider: ${providerId}`);
  const override = env?.[definition.homeEnv];
  const raw =
    typeof override === "string" && override.trim()
      ? override
      : definition.homeDefault;
  return normalizePath(expandHome(raw, homeFromEnv(env ?? {})), { platform });
}

/**
 * Claude Code names its per-project transcript folder after the cwd with every
 * non-alphanumeric character replaced by `-`, e.g.
 * `C:\xampp\htdocs\Ai_Agents_View` → `c--xampp-htdocs-Ai-Agents-View`.
 * The drive letter is lower-cased because that is how Claude reports cwd on
 * Windows; the rest of the path keeps its case.
 */
export function slugForClaudeProject(cwd) {
  let path = String(cwd ?? "").trim();
  if (/^[A-Z]:/.test(path)) path = path[0].toLowerCase() + path.slice(1);
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Last path segment of a file or folder path, or "" for roots. */
export function basenameOf(input, { platform } = {}) {
  const normalized = normalizePath(input, { platform });
  if (!normalized || /^[a-z]:\/?$/i.test(normalized) || normalized === "/")
    return "";
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}
