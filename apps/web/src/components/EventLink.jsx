import React from "react";
import { Link2 } from "lucide-react";
import Provenance from "./Provenance.jsx";
import { formatTime } from "../hooks/useApi.js";

/**
 * Turns a visual action into a link to the event that caused it.
 *
 * Every visible state in Agent Space comes from a stored event. This control
 * carries the event's id and provenance and hands both to the host so it can
 * open the run inspector on the Live activity tab, scrolled to that event.
 * When the state has no recorded event (nothing happened yet, or the event was
 * pruned by retention) the control renders as plain, disabled text saying so —
 * it never invents a citation.
 *
 * @param {{
 *   event?: { id?: string, runId?: string, timestamp?: number, kind?: string, summary?: string, message?: string, provenance?: string }|null,
 *   runId?: string|null,
 *   eventId?: string|null,
 *   label?: React.ReactNode,          // defaults to the event summary
 *   onOpenEvent?: (ref: { runId: string|null, eventId: string|null, event: any }) => void,
 *   showProvenance?: boolean,
 *   showTime?: boolean,               // false when the label already is the time
 *   describe?: string,                // what the event is, for the spoken name
 *   size?: 'small'|'normal',
 *   missingText?: string
 * }} props
 */
export default function EventLink({
  event = null,
  runId = null,
  eventId = null,
  label,
  onOpenEvent,
  showProvenance = true,
  showTime = true,
  describe,
  size = "normal",
  missingText = "no recorded event",
}) {
  const id = eventId ?? event?.id ?? null;
  const run = runId ?? event?.runId ?? null;
  const text =
    label ?? event?.summary ?? event?.message ?? event?.kind ?? "event";
  const canOpen = Boolean(onOpenEvent && (id || run));

  if (!canOpen)
    return (
      <span
        className={`as-eventlink as-eventlink-missing ${size === "small" ? "as-eventlink-small" : ""}`}
        title={
          id || run
            ? "No handler is wired to open the inspector here."
            : "This state has no stored event to link to."
        }
      >
        {text} <span className="as-muted as-small">({missingText})</span>
      </span>
    );

  const when = event?.timestamp ? formatTime(event.timestamp) : null;
  return (
    <button
      type="button"
      className={`as-eventlink ${size === "small" ? "as-eventlink-small" : ""}`}
      onClick={() => onOpenEvent({ runId: run, eventId: id, event })}
      aria-label={`Open the event behind: ${
        describe ?? (typeof text === "string" ? text : "this action")
      }${when ? ` at ${when}` : ""}`}
      title="Open the recorded event behind this"
    >
      <Link2 size={11} aria-hidden="true" />
      <span className="as-eventlink-text">{text}</span>
      {when && showTime ? (
        <span className="as-muted as-small">{when}</span>
      ) : null}
      {showProvenance && event?.provenance ? (
        <Provenance value={event.provenance} />
      ) : null}
    </button>
  );
}
