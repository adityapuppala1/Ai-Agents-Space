import { InputError } from "../../../core/src/TaskStore.js";
import {
  diffVisualPreset,
  makeVisualPreset,
  normalizeVisualPreset,
} from "../../../core/src/visual/VisualPreset.js";

function visualState(record) {
  return {
    theme: record.theme,
    settings: record.settings?.visual ?? {},
  };
}

/** Data-only office presentation import/export. No tasks or execution fields. */
export default async function visualPresetRoutes(ctx) {
  const { method, path, send, body, services, actor } = ctx;
  const match = path.match(/^\/api\/workspaces\/([^/]+)\/visual-preset(?:\/(preview|apply))?$/);
  if (!match) return false;
  const [, workspaceId, action] = match;
  const workspace = services.hub.get(workspaceId);
  if (method === "GET" && !action) {
    const current = visualState(workspace.record);
    send(200, makeVisualPreset({
      name: `${workspace.record.name} visual preset`,
      theme: current.theme,
      settings: current.settings,
    }));
    return true;
  }
  if (method !== "POST" || !action)
    throw new InputError("Use GET to export or POST to preview/apply a visual preset", 405);
  const input = (await body(64 * 1024)) ?? {};
  const preset = normalizeVisualPreset(input.preset);
  const changes = diffVisualPreset(visualState(workspace.record), preset);
  if (action === "preview") {
    send(200, { preset, changes });
    return true;
  }
  if (action !== "apply") return false;
  // Validation is complete before either write. These are the only fields a
  // visual preset can modify; task, policy, connection and path state stays put.
  const record = services.hub.applyVisualPreset(workspaceId, {
    theme: preset.theme,
    visual: preset.settings,
  });
  services.audit?.record?.({
    actor,
    action: "visualPreset.apply",
    target: workspaceId,
    workspaceId,
    details: { name: preset.name, theme: preset.theme, keys: Object.keys(preset.settings) },
  });
  services.bus?.emit("workspace", workspaceId);
  send(200, { preset, changes, workspace: record });
  return true;
}
