import React from "react";
import { activityLabel, MANUAL_ACTIVITY_NOTE } from "../hooks/useApi.js";

/**
 * Activity label ("Coding", "Needs approval", ...). Inferred activities carry
 * a visible "inferred" suffix and a tooltip so they are never mistaken for
 * provider-reported state; a manual task carries "manual" for the same reason.
 * @param {{ activity?: string|null, inferred?: boolean, status?: string|null }} props
 *   status: optional run status; "stale" | "disconnected" | "failed" override the label.
 */
export default function ActivityBadge({ activity, inferred = false, status }) {
  let key = activity ?? "IDLE";
  if (status === "stale") key = "STALE";
  else if (status === "waiting_approval") key = "WAITING_APPROVAL";
  else if (status === "failed" || status === "disconnected") key = "ERROR";
  else if (status === "blocked") key = "BLOCKED";
  const label = status === "disconnected" ? "Disconnected" : activityLabel(key);
  const manual = key === "MANUAL" && !inferred;
  let title = label;
  if (inferred) title = "Activity derived from tool name (inferred)";
  else if (manual) title = MANUAL_ACTIVITY_NOTE;
  return (
    <span
      className={`status as-activity as-activity-${String(key).toLowerCase()}`}
      title={title}
    >
      <i className="dot" aria-hidden="true" />
      {label}
      {inferred ? <em className="as-inferred">inferred</em> : null}
      {manual ? <em className="as-inferred">manual</em> : null}
    </span>
  );
}
