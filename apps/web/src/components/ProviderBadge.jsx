import React from "react";
import { providerLabel } from "../hooks/useApi.js";

/**
 * Text badge naming the provider. Text, never colour alone (UI vocabulary §6).
 * @param {{ provider?: string|null, mode?: string|null, size?: 'small'|'normal' }} props
 *   provider: "claude-code" | "codex" | "copilot" | "cursor" | "gemini" | "manual" | "simulated"
 *   mode: optional run mode ("observed" | "managed" | "manual" | "simulated") shown as a suffix.
 */
export default function ProviderBadge({ provider, mode, size = "normal" }) {
  const label = providerLabel(provider === "simulated" ? "demo" : provider);
  const id = String(provider ?? "manual").replace(/[^a-z0-9-]/gi, "");
  return (
    <span
      className={`as-provider as-provider-${id} ${size === "small" ? "as-provider-small" : ""}`}
      data-provider={id}
      title={`Provider: ${label}${mode ? ` (${mode})` : ""}`}
    >
      {label}
      {mode && mode !== "manual" ? (
        <span className="as-provider-mode">{mode}</span>
      ) : null}
    </span>
  );
}
