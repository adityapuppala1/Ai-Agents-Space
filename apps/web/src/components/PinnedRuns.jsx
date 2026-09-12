import React, { useCallback, useMemo } from "react";
import { Pin, PinOff, ExternalLink } from "lucide-react";
import {
  useLocalStorage,
  readLocal,
  writeLocal,
  toggleIn,
} from "../hooks/useLocalStorage.js";
import {
  RUN_STATUS_LABELS,
  formatElapsed,
  isActiveRun,
} from "../hooks/useApi.js";
import ProviderBadge from "./ProviderBadge.jsx";
import EmptyState from "./EmptyState.jsx";

export const PINNED_RUNS_KEY = "agent-space-pinned-runs";

/**
 * Pinning is a per-browser view preference, so it lives in localStorage and
 * never touches the database. Pinning a run keeps it visible without forcing
 * every agent to be shown.
 * @returns {{ pinned: string[], isPinned:(id:string)=>boolean, toggle:(id:string)=>void, clear:()=>void }}
 */
export function usePinnedRuns(storageKey = PINNED_RUNS_KEY) {
  const [pinned, setPinned] = useLocalStorage(storageKey, []);
  const list = Array.isArray(pinned) ? pinned : [];
  return {
    pinned: list,
    isPinned: useCallback((id) => list.includes(id), [list]),
    toggle: useCallback(
      (id) => setPinned((current) => toggleIn(current, id)),
      [setPinned],
    ),
    clear: useCallback(() => setPinned([]), [setPinned]),
  };
}

/** Imperative helpers for callers that are not React components. */
export function readPinnedRuns(storageKey = PINNED_RUNS_KEY) {
  const value = readLocal(storageKey, []);
  return Array.isArray(value) ? value : [];
}
export function togglePinnedRun(runId, storageKey = PINNED_RUNS_KEY) {
  const next = toggleIn(readPinnedRuns(storageKey), runId);
  writeLocal(storageKey, next);
  return next;
}

/**
 * A single pin/unpin toggle that can sit on any run card.
 * @param {{ runId: string, title?: string, storageKey?: string }} props
 */
export function PinToggle({ runId, title = "run", storageKey }) {
  const { isPinned, toggle } = usePinnedRuns(storageKey);
  const on = isPinned(runId);
  return (
    <button
      type="button"
      className={`icon-button as-pin ${on ? "active" : ""}`}
      aria-pressed={on}
      onClick={() => toggle(runId)}
      aria-label={on ? `Unpin ${title}` : `Pin ${title}`}
      title={on ? "Unpin this run" : "Pin this run so it stays visible"}
    >
      <Pin size={14} aria-hidden="true" fill={on ? "currentColor" : "none"} />
    </button>
  );
}

/**
 * Compact strip of pinned runs. Pinned ids that no longer resolve to a run in
 * `runs` are listed as "no longer in this workspace" rather than dropped
 * silently, so the user can unpin them deliberately.
 *
 * @param {{
 *   runs?: any[],                                  // candidate runs (workspace or global)
 *   onOpenRun?: (runId: string, workspaceId?: string) => void,
 *   storageKey?: string,
 *   now?: number,
 *   hideWhenEmpty?: boolean                        // render nothing with no pins
 * }} props
 */
export default function PinnedRuns({
  runs = [],
  onOpenRun,
  storageKey = PINNED_RUNS_KEY,
  now = Date.now(),
  hideWhenEmpty = false,
}) {
  const { pinned, toggle, clear } = usePinnedRuns(storageKey);
  const byId = useMemo(() => new Map(runs.map((run) => [run.id, run])), [runs]);
  const resolved = pinned.map((id) => ({ id, run: byId.get(id) ?? null }));

  if (pinned.length === 0 && hideWhenEmpty) return null;
  if (pinned.length === 0)
    return (
      <EmptyState
        compact
        icon={<Pin size={20} />}
        title="No pinned runs"
        description="Pin a run from its card or the inspector to keep it here without showing every agent."
      />
    );

  return (
    <section className="as-pinned" aria-label="Pinned runs">
      <header className="as-section-head">
        <h2>
          <Pin size={14} aria-hidden="true" /> Pinned runs
          <span className="as-count">{pinned.length}</span>
        </h2>
        <button type="button" className="text-button" onClick={clear}>
          Unpin all
        </button>
      </header>
      <ul className="as-pinned-strip" role="list">
        {resolved.map(({ id, run }) => (
          <li key={id} className="as-pinned-item">
            {run ? (
              <>
                <button
                  type="button"
                  className="as-pinned-main"
                  onClick={() => onOpenRun?.(run.id, run.workspaceId)}
                  aria-label={`Open pinned run ${run.title ?? id.slice(0, 8)}`}
                >
                  <span className="as-row as-wrap">
                    <ProviderBadge
                      provider={run.provider}
                      mode={run.mode}
                      size="small"
                    />
                    <span
                      className={`status as-run-status as-run-${run.status}`}
                    >
                      <i className="dot" aria-hidden="true" />
                      {RUN_STATUS_LABELS[run.status] ?? run.status}
                    </span>
                  </span>
                  <strong>{run.title ?? run.label ?? id.slice(0, 8)}</strong>
                  <span className="as-muted as-small">
                    {run.startedAt
                      ? formatElapsed(
                          (run.endedAt
                            ? new Date(run.endedAt).getTime()
                            : now) - new Date(run.startedAt).getTime(),
                        )
                      : "not started"}
                    {isActiveRun(run) ? " · active" : ""}
                  </span>
                </button>
                <ExternalLink size={11} aria-hidden="true" />
              </>
            ) : (
              <span className="as-pinned-main as-muted">
                <strong>{id.slice(0, 8)}</strong>
                <span className="as-small">
                  no longer in the runs shown here
                </span>
              </span>
            )}
            <button
              type="button"
              className="icon-button"
              onClick={() => toggle(id)}
              aria-label={`Unpin run ${run?.title ?? id.slice(0, 8)}`}
            >
              <PinOff size={13} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
