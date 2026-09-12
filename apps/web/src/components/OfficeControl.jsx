import React, { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  LayoutGrid,
  Pause,
  Play,
  PlugZap,
  SlidersHorizontal,
  Palette,
  Users,
} from "lucide-react";
import { providerLabel } from "../hooks/useApi.js";
import { isOnFloor } from "../office/presence.js";
import { OFFICE_THEMES } from "../office/themeCatalog.js";

export { OFFICE_THEMES };

/**
 * A disclosure that behaves like a popover: it closes on Escape (returning
 * focus to its summary) and on a click outside, so two never stay open. When
 * it opens it measures the room on either side of its toggle and opens toward
 * the side with space, so the panel never runs off the page.
 */
function Popover({ label, icon: Icon, hint, children, className = "" }) {
  const ref = useRef(null);
  const [align, setAlign] = useState("start");
  useEffect(() => {
    const onPointer = (event) => {
      const details = ref.current;
      if (details?.open && !details.contains(event.target))
        details.open = false;
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, []);
  const place = () => {
    const details = ref.current;
    if (!details?.open) return;
    const toggle = details.querySelector("summary").getBoundingClientRect();
    const panel = details.querySelector(".office-popover-panel");
    const width = panel?.offsetWidth ?? 440;
    const room = document.documentElement.clientWidth;
    setAlign(toggle.left + width <= room - 12 ? "start" : "end");
  };
  return (
    <details
      ref={ref}
      className={`office-popover ${className}`}
      data-align={align}
      onToggle={place}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !ref.current?.open) return;
        event.preventDefault();
        event.stopPropagation();
        ref.current.open = false;
        ref.current.querySelector("summary")?.focus();
      }}
    >
      <summary>
        <Icon size={15} aria-hidden="true" />
        <span>{label}</span>
        {hint ? <small>{hint}</small> : null}
        <ChevronDown size={14} aria-hidden="true" className="chevron" />
      </summary>
      <div className="office-popover-panel">{children}</div>
    </details>
  );
}

function FilterGroup({ label, caption, all, allCount, items, value, onPick }) {
  return (
    <div className="office-filter-group" role="group" aria-label={label}>
      <span className="control-caption">{caption}</span>
      <div className="office-filter-options">
        <button aria-pressed={!value} onClick={() => onPick(null)}>
          {all} <b>{allCount}</b>
        </button>
        {items.map(([id, text, count]) => (
          <button
            key={id}
            aria-pressed={value === id}
            onClick={() => onPick(value === id ? null : id)}
          >
            {text} <b>{count}</b>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The office toolbar. Counts are live facts with a place to act on them:
 * decisions open the inbox, live sessions open the session list. Filters and
 * the environment are one click away without covering the floor.
 */
export default function OfficeControl({
  agents,
  visibleCount,
  filters,
  onFilters,
  theme,
  onTheme,
  isDemo,
  demoRunning,
  demoDisabled,
  onToggleDemo,
  decisions = 0,
  liveSessions = 0,
  onOpenInbox,
  onOpenSessions,
  onConnections,
  onDeployTeam,
  onArrange,
  // { from, to, at, onChange, onExit } — present only when the workspace has
  // recorded events to replay. `at` null means the floor is live.
  replay = null,
  // The agents the office is drawing. Defaults to `agents`; they differ
  // during a replay, and the "on the floor" count follows what is drawn.
  floorAgents = null,
}) {
  const providers = [...new Set(agents.map((a) => a.provider).filter(Boolean))];
  const roles = [...new Set(agents.map((a) => a.role).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b),
  );
  // Counted from what the office is actually drawing, not from the live
  // list: while a replay is on those differ, and "0 on the floor" above a
  // floor with somebody on it is the office contradicting itself.
  const onFloor = (floorAgents ?? agents).filter(isOnFloor).length;
  const filtered = Boolean(filters?.provider || filters?.role);
  const themeLabel = OFFICE_THEMES.find(([id]) => id === theme)?.[1] ?? theme;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  return (
    <section className="office-control" aria-label="Office controls">
      {/* Replaying a past minute. The floor must never look live while this
          is on, so the strip says the time it is showing and stays until it
          is left. */}
      {replay?.at ? (
        <div className="office-replay" role="status">
          <strong>
            Replay · {new Date(replay.at).toLocaleTimeString()}
          </strong>
          <span className="as-tag">recorded events only</span>
          <label className="as-scrubber">
            <span className="sr-only">Replay position</span>
            <input
              type="range"
              min={replay.from}
              max={replay.to}
              step={1000}
              value={replay.at}
              aria-valuetext={new Date(replay.at).toLocaleTimeString()}
              onChange={(event) => replay.onChange(Number(event.target.value))}
            />
          </label>
          <button type="button" className="button" onClick={replay.onExit}>
            Back to live
          </button>
        </div>
      ) : null}
      <div className="office-status">
        <span
          className={`office-kind ${isDemo ? "is-demo" : ""}`}
          title={
            isDemo
              ? "Simulated agents. Real workspaces never mix with the demo."
              : "Work recorded in this workspace."
          }
        >
          <i aria-hidden="true" />
          {isDemo ? "Demo workspace" : "Project workspace"}
        </span>
        {isDemo ? <span className="office-fact">Simulated preview</span> : null}
        <span className="office-fact">
          <strong>{onFloor}</strong> on the floor
        </span>
        {replay && !replay.at ? (
          <button
            type="button"
            className="office-fact is-link"
            title="Scrub back through what was recorded and watch the floor as it was"
            onClick={replay.onStart}
          >
            Replay
          </button>
        ) : null}
        <button
          type="button"
          className={`office-fact is-link ${decisions ? "is-attention" : ""}`}
          onClick={onOpenInbox}
        >
          <strong>{decisions}</strong>{" "}
          {decisions === 1 ? "decision waiting" : "decisions waiting"}
        </button>
        <button
          type="button"
          className="office-fact is-link"
          onClick={onOpenSessions}
        >
          {plural(liveSessions, "live session", "live sessions")}
        </button>
      </div>
      <div className="office-actions">
        {isDemo ? (
          <button
            type="button"
            className="button office-demo"
            aria-label={demoRunning ? "Pause demo" : "Resume demo"}
            title={demoRunning ? "Pause demo" : "Resume demo"}
            disabled={demoDisabled}
            onClick={onToggleDemo}
          >
            {demoRunning ? (
              <Pause size={14} aria-hidden="true" />
            ) : (
              <Play size={14} aria-hidden="true" />
            )}
            <span>{demoRunning ? "Pause demo" : "Resume demo"}</span>
          </button>
        ) : null}
        <Popover
          label="Filters"
          icon={SlidersHorizontal}
          hint={filtered ? `${visibleCount} shown` : null}
          className={filtered ? "is-filtered" : ""}
        >
          <FilterGroup
            label="Filter office by provider"
            caption="Provider"
            all="All assistants"
            allCount={agents.length}
            value={filters?.provider ?? null}
            onPick={(provider) => onFilters({ ...filters, provider })}
            items={providers.map((provider) => [
              provider,
              providerLabel(provider),
              agents.filter((a) => a.provider === provider).length,
            ])}
          />
          {roles.length > 1 ? (
            <FilterGroup
              label="Filter office by role"
              caption="Role"
              all="All roles"
              allCount={roles.length}
              value={filters?.role ?? null}
              onPick={(role) => onFilters({ ...filters, role })}
              items={roles.map((role) => [
                role,
                role,
                agents.filter((a) => a.role === role).length,
              ])}
            />
          ) : null}
          {filtered && visibleCount === 0 ? (
            <p className="office-empty" role="status">
              No agents match these filters.
            </p>
          ) : null}
        </Popover>
        <Popover label="Environment" icon={Palette} hint={themeLabel}>
          <div
            className="office-environments"
            role="group"
            aria-label="Office environments"
          >
            {OFFICE_THEMES.map(([id, label, color]) => (
              <button
                key={id}
                aria-pressed={theme === id}
                onClick={() => onTheme(id)}
              >
                <i style={{ background: color }} aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
          {onArrange ? (
            <button
              type="button"
              className="button office-arrange"
              onClick={onArrange}
            >
              <LayoutGrid size={14} aria-hidden="true" />
              Arrange the office
            </button>
          ) : null}
          <p className="office-popover-note">
            Changes the room only. Tasks, runs and providers stay as they are.
          </p>
        </Popover>
        {onDeployTeam ? (
          <button
            type="button"
            className="button office-team"
            aria-label="Deploy a team"
            title="Put a team of agents on a job, step by step"
            onClick={onDeployTeam}
          >
            <Users size={14} aria-hidden="true" />
            <span>Deploy a team</span>
          </button>
        ) : null}
        <button
          type="button"
          className="button office-connect"
          aria-label="Connect assistants"
          title="Connect assistants"
          onClick={onConnections}
        >
          <PlugZap size={14} aria-hidden="true" />
          <span>Connect assistants</span>
        </button>
      </div>
    </section>
  );
}
