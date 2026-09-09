import { InputError } from "../../../core/src/TaskStore.js";

/**
 * Application settings.
 *   GET /api/settings          → all settings (defaults merged with overrides)
 *   PUT /api/settings          → partial update { "ui.graphics": "high", ... }
 */
export default async function settingsRoutes(ctx) {
  const { method, path, send, body, services, actor } = ctx;
  if (path !== "/api/settings") return false;
  const settings = services.settings;
  if (!settings) throw new InputError("Settings are not enabled", 503);
  if (method === "GET") {
    send(200, settings.all());
    return true;
  }
  if (method === "PUT" || method === "PATCH") {
    const patch = await body();
    const result = settings.update(patch);
    services.audit?.record({
      actor,
      action: "settings.update",
      details: { keys: Object.keys(patch ?? {}) },
    });
    services.bus?.emit("global");
    send(200, result);
    return true;
  }
  return false;
}
