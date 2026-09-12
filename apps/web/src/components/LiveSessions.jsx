import React from "react";
import { Radio, ExternalLink, FolderOpen } from "lucide-react";
import {
  formatElapsed,
  formatTime,
  maskPath,
  basename,
  useTicker,
} from "../hooks/useApi.js";
import { useGlobal } from "../hooks/useGlobal.js";
import ProviderBadge from "./ProviderBadge.jsx";
import ActivityBadge from "./ActivityBadge.jsx";
import { sessionState } from "../hooks/viewLogic.js";

/**
 * Live provider sessions observed on this machine (from `global.liveSessions`).
 *
 * A session is "live" while its provider process runs. That is not the same
 * as working: a session whose run has recorded nothing for a while is shown
 * as Quiet with the time of its last event, never as active. Before the
 * first snapshot arrives the page says it is connecting instead of claiming
 * that nothing is running, and while the channel is down it says the list
 * may be out of date.
 *
 * @param {{
 *   onOpenRun?: (runId: string, workspaceId?: string) => void,
 *   onSwitchWorkspace?: (workspaceId: string) => void,
 *   presentation?: boolean,
 *   sessions?: any[]   // optional override; defaults to the global channel
 * }} props
 */
export default function LiveSessions({
  onOpenRun,
  onSwitchWorkspace,
  presentation = false,
  sessions,
}) {
  const { global, connected, revision } = useGlobal();
  const list = sessions ?? global.liveSessions ?? [];
  useTicker();
  const now = Date.now();
  // The app always passes an array (empty until the first snapshot), so
  // "loaded" follows the shared channel, not the prop.
  const loaded = revision > 0 || list.length > 0;
  const workspaceName = (session) =>
    session.workspaceName ??
    global.workspaces.find((w) => w.id === session.workspaceId)?.name ??
    session.workspaceId;
  const states = list.map((session) => sessionState(session, now));
  const quiet = states.filter((state) => state.key === "quiet").length;
  const active = states.filter((state) => state.key === "active").length;

  let summary;
  if (!loaded) summary = "Connecting to the live channel…";
  else if (!list.length) summary = null;
  else
    summary = [
      `${list.length} live session${list.length === 1 ? "" : "s"}`,
      active && quiet ? `${active} active` : null,
      quiet ? `${quiet} quiet` : null,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <section className="as-live live" aria-label="Live sessions">
      {summary || !connected ? (
        <p className="live-summary">
          <Radio size={15} aria-hidden="true" />
          {summary ? <strong>{summary}</strong> : null}
          {loaded && !connected ? (
            <span className="live-pill offline">
              Reconnecting — this list may be out of date
            </span>
          ) : null}
        </p>
      ) : null}
      {loaded && list.length === 0 ? (
        <div className="empty-state">
          <Radio size={28} aria-hidden="true" />
          <h2>No live sessions detected</h2>
          <p>
            Start Claude Code, Codex or Copilot in a terminal; Agent Space reads
            their own session files (observe must be enabled in Connections).
          </p>
        </div>
      ) : null}
      <ul className="as-live-list">
        {list.map((session, index) => {
          const state = states[index];
          const started = session.startedAt
            ? new Date(session.startedAt).getTime()
            : null;
          const lastEvent = session.lastEventAt
            ? new Date(session.lastEventAt).getTime()
            : null;
          const name = workspaceName(session);
          return (
            <li
              key={`${session.provider}:${session.sessionId}`}
              className={`as-card as-live-item is-${state.key}`}
            >
              <div className="live-item-head">
                <ProviderBadge provider={session.provider} mode="observed" />
                <strong className="as-live-title" title={session.title ?? ""}>
                  {session.title ?? "Untitled session"}
                </strong>
                <span className={`live-state is-${state.key}`}>
                  <i aria-hidden="true" />
                  {state.label}
                </span>
              </div>
              <p className="live-item-note">{state.detail}</p>
              <dl className="as-passport as-compact">
                <dt>Workspace</dt>
                <dd>{name ?? "—"}</dd>
                <dt>Folder</dt>
                <dd
                  className="as-mono"
                  title={presentation ? undefined : session.cwd}
                >
                  {maskPath(session.cwd, presentation) || "—"}
                </dd>
                <dt>Activity</dt>
                <dd>
                  <ActivityBadge
                    activity={session.activity}
                    inferred={Boolean(session.activity)}
                  />
                </dd>
                <dt>Current file</dt>
                <dd className="as-mono">
                  {session.currentFile ? basename(session.currentFile) : "—"}
                </dd>
                <dt>Model</dt>
                <dd>{session.model ?? "model not reported"}</dd>
                <dt>Started</dt>
                <dd>
                  {started
                    ? `${formatTime(started)} · ${formatElapsed(
                        (state.key === "ended" && lastEvent ? lastEvent : now) -
                          started,
                      )}`
                    : "—"}
                </dd>
                <dt>Last event</dt>
                <dd>
                  {lastEvent
                    ? `${formatElapsed(Math.max(0, now - lastEvent))} ago`
                    : "none recorded"}
                </dd>
              </dl>
              <div className="as-row">
                {session.runId ? (
                  <button
                    type="button"
                    className="button"
                    onClick={() =>
                      onOpenRun?.(session.runId, session.workspaceId)
                    }
                    aria-label={`Open run for ${session.title ?? session.sessionId}`}
                  >
                    <ExternalLink size={12} aria-hidden="true" /> Open run
                  </button>
                ) : null}
                {session.workspaceId ? (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => onSwitchWorkspace?.(session.workspaceId)}
                    aria-label={`Open workspace ${name}`}
                  >
                    <FolderOpen size={12} aria-hidden="true" /> Open workspace
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {list.length ? (
        <p className="as-muted as-small">
          Live means the {list.length === 1 ? "provider's" : "providers'"}{" "}
          process is running. Activity is inferred from the latest tool call in
          its session files; a quiet session has recorded nothing recently.
        </p>
      ) : null}
    </section>
  );
}
