import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { InputError } from "../TaskStore.js";

export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "SessionStart",
  "SessionEnd",
  "Notification",
  "PreCompact",
];

export const HOOK_TAG = "agent-space";
export const BACKUP_SUFFIX = ".agent-space.bak";

export function defaultSettingsPath(env = process.env) {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return join(configDir || join(homedir(), ".claude"), "settings.json");
}

export function binPath() {
  return fileURLToPath(
    new URL("../../../../bin/agent-space.js", import.meta.url),
  );
}

/** The command every installed hook must start with. */
export function commandPrefix(bin = binPath()) {
  return `node "${bin}" hook claude-code`;
}

/**
 * Hook command. `timeoutSeconds` is passed as `--timeout` so the CLI waits
 * as long as the server does for an approval instead of giving up first.
 */
export function defaultCommand({
  port,
  url,
  bin = binPath(),
  timeoutSeconds,
} = {}) {
  const resolvedPort = port ?? (Number(process.env.PORT) || 5173);
  const base = url ?? `http://127.0.0.1:${resolvedPort}`;
  const timeout =
    Number.isInteger(timeoutSeconds) && timeoutSeconds > 0
      ? ` --timeout ${timeoutSeconds}`
      : "";
  return `${commandPrefix(bin)} --url ${base}${timeout}`;
}

/** Only our own CLI may be installed as the hook command. */
export function isTrustedCommand(command, bin = binPath()) {
  if (typeof command !== "string") return false;
  const prefix = commandPrefix(bin);
  return (
    command === prefix ||
    (command.startsWith(prefix) &&
      /^(\s+--(url|timeout|token|json)(=|\s+)[^\s"&|;<>`$]+)*\s*$/.test(
        command.slice(prefix.length),
      ))
  );
}

/**
 * Settings files the API may touch: Claude's own config directory
 * (CLAUDE_CONFIG_DIR or ~/.claude) only, never an arbitrary JSON file.
 */
export function allowedSettingsPath(settingsPath, env = process.env) {
  if (
    settingsPath === undefined ||
    settingsPath === null ||
    settingsPath === ""
  )
    return defaultSettingsPath(env);
  if (typeof settingsPath !== "string")
    throw new InputError("settingsPath must be a string");
  const resolved = resolvePath(settingsPath);
  const dir = dirname(defaultSettingsPath(env));
  const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  const inside =
    norm(resolved) === norm(dir) ||
    norm(resolved).startsWith(
      norm(dir) + (process.platform === "win32" ? "\\" : "/"),
    );
  if (!inside || !/\.json$/i.test(resolved))
    throw new InputError(
      `settingsPath must be a .json file inside ${dir} (set CLAUDE_CONFIG_DIR to use another Claude home)`,
      403,
    );
  return resolved;
}

function isOurs(hook) {
  return typeof hook?.command === "string" && hook.command.includes(HOOK_TAG);
}

function readSettings(settingsPath) {
  if (!existsSync(settingsPath)) return { data: {}, existed: false };
  let text;
  try {
    text = readFileSync(settingsPath, "utf8");
  } catch (error) {
    throw new InputError(`Cannot read ${settingsPath}: ${error.message}`, 500);
  }
  if (!text.trim()) return { data: {}, existed: true };
  let data;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new InputError(
      `${settingsPath} is not valid JSON; fix it by hand before installing hooks`,
      409,
    );
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new InputError(`${settingsPath} must contain a JSON object`, 409);
  return { data, existed: true };
}

function writeAtomic(settingsPath, data) {
  mkdirSync(dirname(settingsPath), { recursive: true });
  const tmp = `${settingsPath}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  try {
    renameSync(tmp, settingsPath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw error;
  }
}

function backupOnce(settingsPath) {
  const backup = settingsPath + BACKUP_SUFFIX;
  if (existsSync(backup) || !existsSync(settingsPath)) return null;
  writeFileSync(backup, readFileSync(settingsPath), { flag: "wx" });
  return backup;
}

/** Reports which events carry an agent-space hook and the command used. */
export function status(settingsPath = defaultSettingsPath()) {
  let data;
  try {
    ({ data } = readSettings(settingsPath));
  } catch (error) {
    return {
      installed: false,
      events: [],
      command: null,
      settingsPath,
      error: error.message,
    };
  }
  const hooks = data.hooks && typeof data.hooks === "object" ? data.hooks : {};
  const events = [];
  let command = null;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const ours = (group?.hooks ?? []).find(isOurs);
      if (ours) {
        events.push(event);
        command ??= ours.command;
        break;
      }
    }
  }
  const missing = HOOK_EVENTS.filter((e) => !events.includes(e));
  return {
    installed: events.length > 0,
    complete: missing.length === 0,
    events,
    missing,
    command,
    settingsPath,
    backupPath: existsSync(settingsPath + BACKUP_SUFFIX)
      ? settingsPath + BACKUP_SUFFIX
      : null,
  };
}

/**
 * Adds one agent-space hook entry (no matcher = every tool) to each hook
 * event, keeping every existing entry (e.g. `rtk hook claude`) untouched.
 * Idempotent: an existing agent-space entry is updated in place.
 */
export function install({
  settingsPath = defaultSettingsPath(),
  command = null,
  timeoutSeconds = 300,
  events = HOOK_EVENTS,
} = {}) {
  const timeout = Number(timeoutSeconds);
  if (!Number.isInteger(timeout) || timeout < 10 || timeout > 3600)
    throw new InputError("timeoutSeconds must be an integer from 10 to 3600");
  command ??= defaultCommand({ timeoutSeconds: timeout });
  if (typeof command !== "string" || !command.includes(HOOK_TAG))
    throw new InputError(`Hook command must reference ${HOOK_TAG}`);
  const path = resolvePath(settingsPath);
  const { data } = readSettings(path);
  const backupPath = backupOnce(path);
  if (
    !data.hooks ||
    typeof data.hooks !== "object" ||
    Array.isArray(data.hooks)
  )
    data.hooks = {};
  const added = [];
  const updated = [];
  for (const event of events) {
    if (!Array.isArray(data.hooks[event])) data.hooks[event] = [];
    let found = false;
    for (const group of data.hooks[event]) {
      if (!group || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (!isOurs(hook)) continue;
        found = true;
        if (hook.command !== command || hook.timeout !== timeout) {
          hook.command = command;
          hook.timeout = timeout;
          updated.push(event);
        }
      }
    }
    if (!found) {
      data.hooks[event].push({
        hooks: [{ type: "command", command, timeout }],
      });
      added.push(event);
    }
  }
  writeAtomic(path, data);
  return { ...status(path), added, updated, backupPath };
}

/** Removes only agent-space entries; prunes empty groups and event arrays. */
export function uninstall(settingsPath = defaultSettingsPath()) {
  const path = resolvePath(settingsPath);
  const { data, existed } = readSettings(path);
  if (!existed) return { ...status(path), removed: [] };
  const removed = [];
  if (data.hooks && typeof data.hooks === "object") {
    for (const [event, groups] of Object.entries(data.hooks)) {
      if (!Array.isArray(groups)) continue;
      const kept = [];
      for (const group of groups) {
        if (!group || !Array.isArray(group.hooks)) {
          kept.push(group);
          continue;
        }
        const before = group.hooks.length;
        group.hooks = group.hooks.filter((hook) => !isOurs(hook));
        if (group.hooks.length !== before) removed.push(event);
        if (group.hooks.length) kept.push(group);
      }
      if (kept.length) data.hooks[event] = kept;
      else delete data.hooks[event];
    }
    if (!Object.keys(data.hooks).length) delete data.hooks;
  }
  if (removed.length) writeAtomic(path, data);
  return { ...status(path), removed: [...new Set(removed)] };
}
