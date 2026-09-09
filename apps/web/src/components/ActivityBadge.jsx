import React from "react";
import { activityLabel } from "../hooks/useApi.js";

/**
 * Activity label ("Coding", "Needs approval", ...). Inferred activities carry
 * a visible "inferred" suffix and a tooltip so they are never mistaken for
 * provider-reported state.
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
  return (
    <span
      className={`status as-activity as-activity-${String(key).toLowerCase()}`}
      title={inferred ? "Activity derived from tool name (inferred)" : label}
    >
      <i className="dot" aria-hidden="true" />
      {label}
      {inferred ? <em className="as-inferred">inferred</em> : null}
    </span>
  );
}
