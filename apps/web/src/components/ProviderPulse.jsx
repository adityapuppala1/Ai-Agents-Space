import React from "react";
import { pulseEntries } from "../hooks/providerStatus.js";

/**
 * Persistent provider presence in the top bar. Every entry carries its state
 * as a word and a shape as well as a colour; the tooltip says what the state
 * is based on. Absent providers are left to the Connections page.
 *
 * A phone has no room for a button per assistant (it used to show three of
 * five and drop the rest without a word), so there one button carries every
 * state as a shape and names them all.
 */
export default function ProviderPulse({
  connections,
  runningProviders,
  onOpen,
}) {
  const entries = pulseEntries(connections, runningProviders);
  if (!entries.length) return null;
  const summary = entries
    .map((entry) => `${entry.name}: ${entry.label}`)
    .join(", ");
  return (
    <div
      className="provider-pulse"
      role="group"
      aria-label="Assistants on this machine"
    >
      {entries.map((entry) => (
        <button
          type="button"
          key={entry.id}
          className={`provider-pulse-item is-${entry.state}`}
          title={`${entry.name}: ${entry.label}. ${entry.detail}`}
          aria-label={`${entry.name}: ${entry.label}. Open connections.`}
          onClick={onOpen}
        >
          <i aria-hidden="true" />
          <span className="provider-pulse-name">{entry.name}</span>
          <span className="provider-pulse-state">{entry.label}</span>
        </button>
      ))}
      <button
        type="button"
        className="provider-pulse-compact"
        title={summary}
        aria-label={`${summary}. Open connections.`}
        onClick={onOpen}
      >
        {entries.map((entry) => (
          <i
            key={entry.id}
            className={`is-${entry.state}`}
            aria-hidden="true"
          />
        ))}
      </button>
    </div>
  );
}
