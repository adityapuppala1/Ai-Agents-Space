import { claudeCodeAdapter } from "./claudeCode.js";
import { codexAdapter } from "./codex.js";
import { codexAppServerAdapter } from "./codexAppServer.js";
import { copilotAdapter } from "./copilot.js";
import { geminiAdapter } from "./gemini.js";
import { cursorAdapter } from "./cursor.js";

/** Adapters keyed by adapter id. Provider ids map to their default adapter. */
export const defaultAdapters = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  "codex-app-server": codexAppServerAdapter,
  copilot: copilotAdapter,
  gemini: geminiAdapter,
  cursor: cursorAdapter,
};

/**
 * Picks the adapter for a provider. Codex uses the exec transport unless the
 * `codex.useAppServer` setting is true.
 */
export function adapterFor(
  providerId,
  { adapters = defaultAdapters, settings = null } = {},
) {
  if (providerId === "codex") {
    const useAppServer = settings?.get?.("codex.useAppServer", false) ?? false;
    if (useAppServer && adapters["codex-app-server"])
      return adapters["codex-app-server"];
  }
  return adapters[providerId] ?? null;
}

/** Capability table per provider id, for the connections module and the UI. */
export function adapterCapabilities(adapters = defaultAdapters) {
  const out = {};
  for (const adapter of Object.values(adapters)) {
    if (!out[adapter.provider] || adapter.id === adapter.provider)
      out[adapter.provider] = { ...adapter.capabilities };
  }
  return out;
}

export {
  claudeCodeAdapter,
  codexAdapter,
  codexAppServerAdapter,
  copilotAdapter,
  geminiAdapter,
  cursorAdapter,
};
