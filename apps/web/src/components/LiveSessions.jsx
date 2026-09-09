import React, { useEffect, useState } from "react";
import { Radio, ExternalLink, FolderOpen } from "lucide-react";
import { formatElapsed, maskPath, basename } from "../hooks/useApi.js";
import { useGlobal } from "../hooks/useGlobal.js";
import ProviderBadge from "./ProviderBadge.jsx";
import ActivityBadge from "./ActivityBadge.jsx";

/**
 * Live provider sessions observed on this machine (from `global.liveSessions`).
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
  const { global, connected } = useGlobal();
  const list = sessions ?? global.liveSessions ?? [];
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const now = Date.now();
  const workspaceName = (id) =>
    global.workspaces.find((w) => w.id === id)?.name ?? id;
  return (
    <section className="as-live" aria-label="Live sessions">
      <header className="as-section-head">
        <h3>
          <Radio size={14} aria-hidden="true" /> Live sessions
        </h3>
        <span className={`live-pill ${connected ? "" : "offline"}`}>
          {connected ? `${list.length} live` : "reconnecting"}
        </span>
      </header>
      {list.length === 0 ? (
        <div className="empty-state">
          <Radio size={28} aria-hidden="true" />
          <h3>No live sessions detected</h3>
          <p>
            Start Claude Code, Codex or Copilot in a terminal; Agent Space reads
            their own session files (observe must be enabled in Connections).
          </p>
        </div>
      ) : null}
      <ul className="as-live-list">
        {list.map((session) => {
          const started = session.startedAt
            ? new Date(session.startedAt).getTime()
            : null;
          return (
            <li
              key={`${session.provider}:${session.sessionId}`}
              className={`as-card as-live-item ${session.live ? "" : "as-ended"}`}
            >
              <div className="as-row as-wrap">
                <ProviderBadge provider={session.provider} mode="observed" />
                <strong className="as-live-title">
                  {session.title ?? "Untitled session"}
                </strong>
                {session.live ? (
                  <span className="status as-activity-coding">
                    <i className="dot" aria-hidden="true" />
                    live
                  </span>
                ) : (
                  <span className="status status-queue">
                    <i className="dot" aria-hidden="true" />
                    ended
                  </span>
                )}
              </div>
              <dl className="as-passport as-compact">
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
                <dt>Elapsed</dt>
                <dd>
                  {started
                    ? formatElapsed(
                        (session.live
                          ? now
                          : new Date(session.lastEventAt ?? now).getTime()) -
                          started,
                      )
                    : "—"}
                </dd>
                <dt>Workspace</dt>
                <dd>{workspaceName(session.workspaceId)}</dd>
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
                    <ExternalLink size={12} /> Open run
                  </button>
                ) : null}
                {session.workspaceId ? (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => onSwitchWorkspace?.(session.workspaceId)}
                    aria-label={`Open workspace ${workspaceName(session.workspaceId)}`}
                  >
                    <FolderOpen size={12} /> Open workspace
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
