import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Archive,
  ChevronDown,
  Copy,
  LayoutDashboard,
  Pencil,
  Search,
  Timer,
  Users,
} from "lucide-react";
import AgentPortrait from "./AgentPortrait.jsx";
import ProviderBadge from "./ProviderBadge.jsx";
import EmptyState from "./EmptyState.jsx";
import {
  activityLabel,
  basename,
  formatElapsed,
  MANUAL_ACTIVITY_NOTE,
  maskText,
  providerLabel,
  timeAgo,
} from "../hooks/useApi.js";
import {
  agentDirectory,
  agentSections,
  AGENT_SECTIONS,
} from "../hooks/viewLogic.js";
import { isManualWork } from "../office/presence.js";
import { createPortraitStage } from "../office/portraitStage.js";

const STATE_FILTERS = [
  ["all", "All"],
  ["working", "Working"],
  ["attention", "Needs attention"],
  ["idle", "Idle"],
];

/** What the agent is doing, in words, from recorded state only. */
function NowCell({ agent, state, presentation }) {
  if (state === "idle")
    return (
      <span className="dir-now">
        <span className="dir-state is-idle">Idle</span>
        <span className="dir-sub">No recorded work right now</span>
      </span>
    );
  return (
    <span className="dir-now">
      <span className={`dir-state is-${state}`}>
        {activityLabel(agent.activity)}
        {agent.activityProvenance === "inferred" ? (
          <em className="as-inferred" title="Worked out from tool names">
            inferred
          </em>
        ) : null}
        {isManualWork(agent) ? (
          <em className="as-inferred" title={MANUAL_ACTIVITY_NOTE}>
            manual
          </em>
        ) : null}
      </span>
      {agent.taskTitle ? (
        <span
          className="dir-sub"
          title={presentation ? undefined : agent.taskTitle}
        >
          {maskText(agent.taskTitle, presentation)}
        </span>
      ) : null}
      {agent.currentFile ||
      (agent.activeProviderRun && agent.elapsedMs != null) ? (
        <span className="dir-sub dir-meta">
          {agent.currentFile ? (
            <span className="as-mono">{basename(agent.currentFile)}</span>
          ) : null}
          {agent.activeProviderRun && agent.elapsedMs != null ? (
            <span>
              <Timer size={12} aria-hidden="true" />{" "}
              {formatElapsed(agent.elapsedMs)}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The agent's own office figure, drawn by the page's shared 3D stage
 * (office/portraitStage.js), or its 2D portrait when WebGL is unavailable.
 * Decorative: the card says everything the figure shows.
 */
function AgentFigure({ agent, style, state, index, stage }) {
  const canvas = useRef(null);
  useEffect(() => {
    if (!stage || !canvas.current) return undefined;
    stage.mount(agent.id, canvas.current, { agent, style, state, index });
    return () => stage.unmount(agent.id);
    // Mounted once per agent and stage; changes arrive through update().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, agent.id]);
  useEffect(() => {
    stage?.update(agent.id, { agent, style, state });
  }, [stage, agent, style, state]);
  if (!stage) return <AgentPortrait agent={agent} />;
  return (
    <canvas ref={canvas} className="agent-figure-canvas" aria-hidden="true" />
  );
}

function AgentCard({
  agent,
  state,
  index,
  stage,
  style,
  selected,
  disabled,
  presentation,
  onSelect,
  onEdit,
  onDuplicate,
  onArchive,
  onShowInOffice,
  onOpenRun,
}) {
  const skills = Array.isArray(agent.skills) ? agent.skills : [];
  const detailsId = `agent-details-${agent.id}`;
  const liveRun = agent.activeProviderRun && agent.runId ? agent.runId : null;
  const lastRun = agent.lastRun?.id ? agent.lastRun : null;
  return (
    <li
      className={`agent-card is-${state} ${selected ? "selected" : ""}`}
      style={{ "--agent-color": agent.color }}
    >
      <button
        type="button"
        className="agent-card-main"
        aria-expanded={selected}
        aria-controls={detailsId}
        onClick={() => onSelect?.(selected ? null : agent.id)}
      >
        <span className="agent-stage">
          <AgentFigure
            agent={agent}
            style={style}
            state={state}
            index={index}
            stage={stage}
          />
        </span>
        <span className="agent-card-name">
          <strong>{agent.name}</strong>
          <span>{agent.role}</span>
          {agent.autoCreated ? (
            <span className="auto-tag" title="Created from an observed session">
              from a session
            </span>
          ) : null}
        </span>
        <ChevronDown
          className="agent-card-chevron"
          size={16}
          aria-hidden="true"
        />
      </button>
      <div className="agent-card-body">
        <NowCell agent={agent} state={state} presentation={presentation} />
        <span className="agent-card-runtime">
          {agent.provider ? (
            <ProviderBadge provider={agent.provider} size="small" />
          ) : (
            <button
              type="button"
              className="text-button"
              disabled={disabled}
              onClick={() => onEdit?.(agent)}
            >
              Choose a provider
            </button>
          )}
          <span className="agent-card-done" title="Tasks completed">
            {agent.completed ?? 0} done
          </span>
        </span>
        <span className="dir-skills">
          {skills.slice(0, 3).map((skill) => (
            <span key={skill}>{skill}</span>
          ))}
          {skills.length > 3 ? (
            <span title={skills.slice(3).join(", ")}>
              +{skills.length - 3}
            </span>
          ) : null}
          {skills.length === 0 ? (
            <span className="dir-none">No skills listed</span>
          ) : null}
        </span>
      </div>
      {selected ? (
        <dl id={detailsId} className="agent-card-details">
          {agent.model ? (
            <div>
              <dt>Prefers</dt>
              <dd>{agent.model}</dd>
            </div>
          ) : null}
          {agent.lastRun?.actualModel ? (
            <div>
              <dt>Last reported</dt>
              <dd>{agent.lastRun.actualModel}</dd>
            </div>
          ) : null}
          {agent.runtime ? (
            <div>
              <dt>Runtime</dt>
              <dd>{agent.runtime}</dd>
            </div>
          ) : null}
          {skills.length > 3 ? (
            <div>
              <dt>Skills</dt>
              <dd>{skills.join(", ")}</dd>
            </div>
          ) : null}
          <div>
            <dt>Last run</dt>
            <dd>
              {lastRun
                ? `${lastRun.status ?? "recorded"}${
                    lastRun.endedAt
                      ? `, ended ${timeAgo(lastRun.endedAt)}`
                      : lastRun.startedAt
                        ? `, started ${timeAgo(lastRun.startedAt)}`
                        : ""
                  }`
                : "None recorded"}
            </dd>
          </div>
        </dl>
      ) : null}
      <div className="agent-card-actions">
        {state !== "idle" && onShowInOffice ? (
          <button
            type="button"
            className="button small"
            aria-label={`Show ${agent.name} in the office`}
            title="See this agent at work in the office"
            onClick={() => onShowInOffice(agent.id)}
          >
            <LayoutDashboard size={14} aria-hidden="true" />
            In the office
          </button>
        ) : null}
        {liveRun || (selected && lastRun) ? (
          <button
            type="button"
            className="button small"
            aria-label={`Open ${agent.name}'s ${liveRun ? "run" : "last run"}`}
            onClick={() => onOpenRun?.(liveRun ?? lastRun.id)}
          >
            <Activity size={14} aria-hidden="true" />
            {liveRun ? "Open run" : "Last run"}
          </button>
        ) : null}
        <span className="agent-card-tools">
          <button
            type="button"
            className="icon-button"
            aria-label={`Edit ${agent.name}`}
            title="Edit profile"
            disabled={disabled}
            onClick={() => onEdit?.(agent)}
          >
            <Pencil size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={`Duplicate ${agent.name}`}
            title="Duplicate profile"
            disabled={disabled}
            onClick={() => onDuplicate?.(agent)}
          >
            <Copy size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={`Archive ${agent.name}`}
            title={
              agent.taskId
                ? "Finish or reassign this agent's task before archiving"
                : "Archive profile"
            }
            disabled={disabled || Boolean(agent.taskId)}
            onClick={() => onArchive?.(agent)}
          >
            <Archive size={15} aria-hidden="true" />
          </button>
        </span>
      </div>
    </li>
  );
}

/**
 * The Agents page: the team as people. Each profile is a card with its own
 * office figure in 3D, seated at its laptop while it has recorded work and
 * standing by an empty chair while it has none, in sections: who needs
 * attention, who is working, who is ready for work. A card opens in place
 * for the profile's details; the run itself opens in the run view, and the
 * agent at work in the office, so this page repeats neither. Everything shown
 * comes from the profile or recorded run state.
 */
export default function AgentDirectory({
  agents = [],
  selectedId = null,
  onSelect,
  onEdit,
  onDuplicate,
  onArchive,
  onShowInOffice,
  onOpenRun,
  avatarStyles = null,
  reducedMotion = false,
  dark = false,
  disabled = false,
  presentation = false,
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [provider, setProvider] = useState("");
  // One 3D stage for the whole page (office/portraitStage.js); null without
  // WebGL, and the cards then show 2D portraits.
  const [stage, setStage] = useState(null);
  useEffect(() => {
    const next = createPortraitStage({ reducedMotion, dark });
    setStage(next);
    return () => next?.dispose();
    // Created once; motion and theme changes are passed on below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => stage?.setReducedMotion(reducedMotion), [stage, reducedMotion]);
  useEffect(() => stage?.setDark(dark), [stage, dark]);
  const directory = useMemo(
    () => agentDirectory(agents, { query, status, provider: provider || null }),
    [agents, query, status, provider],
  );
  const sections = useMemo(() => {
    if (status === "all") return agentSections(directory.rows);
    const section = AGENT_SECTIONS.find((item) => item.id === status);
    return directory.rows.length ? [{ ...section, rows: directory.rows }] : [];
  }, [directory.rows, status]);
  const order = useMemo(
    () => new Map(agents.map((agent, index) => [agent.id, index])),
    [agents],
  );
  const filtered = Boolean(query || provider || status !== "all");
  return (
    <section className="panel agent-directory" aria-label="Agent directory">
      <div className="dir-tools">
        <label className="search-box dir-search">
          <Search size={15} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, role, skill or provider"
            aria-label="Search agents"
          />
        </label>
        <div className="segmented" role="group" aria-label="Show agents">
          {STATE_FILTERS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={status === id}
              onClick={() => setStatus(id)}
            >
              {label}
              <b>{directory.counts[id]}</b>
            </button>
          ))}
        </div>
        {directory.providers.length > 0 ? (
          <label className="dir-provider">
            <span>Provider</span>
            <select
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
            >
              <option value="">Any</option>
              {directory.providers.map((id) => (
                <option key={id} value={id}>
                  {providerLabel(id)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {sections.map((section) => (
        <section
          key={section.id}
          className={`agent-section is-${section.id}`}
          aria-labelledby={`agent-section-${section.id}`}
        >
          <header className="agent-section-head">
            <h2 id={`agent-section-${section.id}`}>
              {section.title}
              <span className="agent-section-count">
                {section.rows.length}
              </span>
            </h2>
            <p>{section.hint}</p>
          </header>
          <ul className="agent-grid" aria-label={section.title}>
            {section.rows.map(({ agent, state }) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                state={state}
                index={order.get(agent.id) ?? 0}
                stage={stage}
                style={avatarStyles?.[agent.id] ?? null}
                selected={agent.id === selectedId}
                disabled={disabled}
                presentation={presentation}
                onSelect={onSelect}
                onEdit={onEdit}
                onDuplicate={onDuplicate}
                onArchive={onArchive}
                onShowInOffice={onShowInOffice}
                onOpenRun={onOpenRun}
              />
            ))}
          </ul>
        </section>
      ))}
      {directory.rows.length === 0 ? (
        <EmptyState
          compact
          icon={<Users size={22} />}
          title={filtered ? "No agent matches" : "No agents yet"}
          description={
            filtered
              ? "Change the search or the filters to see the rest of the team."
              : "Add an agent to give this workspace a named profile to assign work to."
          }
          actions={
            filtered
              ? [
                  {
                    label: "Clear filters",
                    onClick: () => {
                      setQuery("");
                      setStatus("all");
                      setProvider("");
                    },
                  },
                ]
              : []
          }
        />
      ) : null}
    </section>
  );
}
