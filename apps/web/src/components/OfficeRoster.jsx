import React, { useMemo, useState } from "react";
import AgentPortrait from "./AgentPortrait.jsx";
import {
  activityLabel,
  formatElapsed,
  MANUAL_ACTIVITY_NOTE,
  providerLabel,
} from "../hooks/useApi.js";
import { agentDirectory } from "../hooks/viewLogic.js";
import { isManualWork } from "../office/presence.js";

const VISIBLE = 8;

/**
 * The compact roster under the office: every agent in the workspace, the ones
 * that need attention first, then working, then idle. It wraps instead of
 * scrolling sideways, and past eight agents the rest wait behind "Show more"
 * (the Agents page is the full directory). Selecting an agent opens it in the
 * inspector. No provider is named for an agent that has none: "Manual" was a
 * placeholder, not a fact about the agent.
 *
 * @param {{
 *   agents: any[],
 *   selectedId?: string | null,
 *   onSelect: (agentId: string) => void,
 *   onOpenDirectory?: () => void,
 * }} props
 */
export default function OfficeRoster({
  agents = [],
  selectedId = null,
  onSelect,
  onOpenDirectory,
}) {
  const [showAll, setShowAll] = useState(false);
  const { rows, counts } = useMemo(() => agentDirectory(agents), [agents]);
  const visible = showAll ? rows : rows.slice(0, VISIBLE);
  const hidden = rows.length - visible.length;
  const summary = [
    counts.attention ? `${counts.attention} need attention` : null,
    counts.working ? `${counts.working} working` : null,
    counts.idle ? `${counts.idle} idle` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className="team-section roster" aria-labelledby="roster-title">
      <div className="roster-head">
        <h2 id="roster-title">
          Agents <span>{counts.all}</span>
        </h2>
        {summary ? <p className="roster-summary">{summary}</p> : null}
        {onOpenDirectory && rows.length ? (
          <button
            type="button"
            className="text-button roster-directory"
            onClick={onOpenDirectory}
          >
            Open the directory
          </button>
        ) : null}
      </div>
      {rows.length ? (
        <ul className="roster-list" role="list">
          {visible.map(({ agent, state }) => {
            const selected = selectedId === agent.id;
            const provider =
              agent.provider && agent.provider !== "manual"
                ? providerLabel(agent.provider)
                : null;
            const activity =
              state === "idle" ? "Idle" : activityLabel(agent.activity);
            const elapsed =
              agent.activeProviderRun && agent.elapsedMs != null
                ? formatElapsed(agent.elapsedMs)
                : null;
            return (
              <li key={agent.id}>
                <button
                  type="button"
                  className={`roster-item is-${state}${selected ? " is-selected" : ""}`}
                  aria-pressed={selected}
                  title={agent.role || undefined}
                  onClick={() => onSelect(agent.id)}
                >
                  <span
                    className="roster-tile"
                    style={{ "--agent-color": agent.color }}
                  >
                    <AgentPortrait agent={agent} size="sm" />
                  </span>
                  <span className="roster-text">
                    <span className="roster-name">
                      {agent.name}
                      {agent.autoCreated ? (
                        <span
                          className="auto-tag"
                          title="Created automatically from a session"
                        >
                          auto
                        </span>
                      ) : null}
                    </span>
                    <span className="roster-state">
                      <i aria-hidden="true" />
                      {activity}
                      {agent.activityProvenance === "inferred" &&
                      state !== "idle" ? (
                        <em className="as-inferred">inferred</em>
                      ) : null}
                      {isManualWork(agent) && state !== "idle" ? (
                        <em
                          className="as-inferred"
                          title={MANUAL_ACTIVITY_NOTE}
                        >
                          manual
                        </em>
                      ) : null}
                      {elapsed ? (
                        <span className="roster-elapsed">· {elapsed}</span>
                      ) : null}
                    </span>
                    <span className="roster-sub">
                      {[agent.role, provider].filter(Boolean).join(" · ") ||
                        "No role set"}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {hidden > 0 || showAll ? (
        <button
          type="button"
          className="text-button roster-more"
          aria-expanded={showAll}
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll ? "Show fewer" : `Show ${hidden} more`}
        </button>
      ) : null}
    </section>
  );
}
