import { InputError } from "../../../core/src/TaskStore.js";
import {
  install,
  uninstall,
  status,
  defaultCommand,
  defaultSettingsPath,
  isTrustedCommand,
  allowedSettingsPath,
} from "../../../core/src/hooks/installer.js";

const HOOK_BODY_LIMIT = 262144;

/**
 * Claude Code hook routes. Register BEFORE routes/workspaces.js.
 *   POST /api/hooks/claude-code               (hook stdin JSON → decision JSON)
 *   GET  /api/hooks/claude-code/status        (always Claude's own settings.json)
 *   POST /api/hooks/claude-code/install       { settingsPath?, timeoutSeconds?, command? }
 *   POST /api/hooks/claude-code/uninstall     { settingsPath? }
 * `settingsPath` must live inside CLAUDE_CONFIG_DIR / ~/.claude and
 * `command` must be this project's own CLI; anything else is refused so the
 * API cannot be used to plant an arbitrary command in Claude's settings.
 */
export default async function hookRoutes(ctx) {
  const { method, path, send, body, services, actor } = ctx;
  if (!path.startsWith("/api/hooks/claude-code")) return false;

  if (method === "POST" && path === "/api/hooks/claude-code") {
    const bridge = services.hookBridge;
    if (!bridge) {
      send(200, {});
      return true;
    }
    let payload;
    try {
      payload = await body(HOOK_BODY_LIMIT);
    } catch (error) {
      // Never block Claude Code: an unreadable payload yields an empty decision.
      services.audit?.record({
        actor: "hook:claude-code",
        action: "hook.badRequest",
        details: { error: error.message },
      });
      send(200, {});
      return true;
    }
    const result = await bridge.handleHook(payload);
    send(result?.status ?? 200, result?.body ?? {});
    return true;
  }

  const port = services.options?.port ?? (Number(process.env.PORT) || 5173);
  const settingTimeout = () => {
    const value = services.settings?.get("hooks.claudeCode.timeoutSeconds");
    return Number.isInteger(value) && value > 0 ? value : 300;
  };
  if (method === "GET" && path === "/api/hooks/claude-code/status") {
    // Only Claude's own settings file is inspected (no path from the query).
    const settingsPath = defaultSettingsPath();
    const result = status(settingsPath);
    if (
      services.settings &&
      services.settings.get("hooks.claudeCode.installed") !== result.installed
    )
      services.settings.set("hooks.claudeCode.installed", result.installed);
    const timeoutSeconds = settingTimeout();
    send(200, {
      ...result,
      suggestedCommand: defaultCommand({ port, timeoutSeconds }),
      timeoutSeconds,
      bridgeAttached: !!services.hookBridge,
    });
    return true;
  }
  if (method === "POST" && path === "/api/hooks/claude-code/install") {
    const input = (await body()) ?? {};
    const timeoutSeconds = input.timeoutSeconds ?? settingTimeout();
    if (input.command !== undefined && typeof input.command !== "string")
      throw new InputError("command must be a string");
    if (input.command !== undefined && !isTrustedCommand(input.command))
      throw new InputError(
        'command must be this server\'s own hook command (node "<bin>/agent-space.js" hook claude-code …)',
        403,
      );
    const result = install({
      settingsPath: allowedSettingsPath(input.settingsPath),
      command:
        input.command ??
        defaultCommand({
          port,
          timeoutSeconds: Number.isInteger(timeoutSeconds)
            ? timeoutSeconds
            : undefined,
        }),
      timeoutSeconds,
    });
    services.settings?.set("hooks.claudeCode.installed", true);
    if (Number.isInteger(timeoutSeconds))
      services.settings?.set("hooks.claudeCode.timeoutSeconds", timeoutSeconds);
    services.audit?.record({
      actor,
      action: "hooks.install",
      target: result.settingsPath,
      details: {
        added: result.added,
        updated: result.updated,
        command: result.command,
        backupPath: result.backupPath,
      },
    });
    services.bus?.emit("global");
    send(200, result);
    return true;
  }
  if (method === "POST" && path === "/api/hooks/claude-code/uninstall") {
    const input = (await body()) ?? {};
    const result = uninstall(allowedSettingsPath(input.settingsPath));
    services.settings?.set("hooks.claudeCode.installed", false);
    services.audit?.record({
      actor,
      action: "hooks.uninstall",
      target: result.settingsPath,
      details: { removed: result.removed },
    });
    services.bus?.emit("global");
    send(200, result);
    return true;
  }
  return false;
}
