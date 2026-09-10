import React, { useEffect, useState } from "react";
import { NotebookPen, RefreshCw, History, Save } from "lucide-react";
import { apiFetch, useApi, formatTime } from "../hooks/useApi.js";
import EmptyState from "./EmptyState.jsx";

/**
 * Editable handover brief for a workspace, task or run.
 *
 * The generated baseline is assembled from records — the task contract, the
 * runs, the recorded decisions, the artifacts and the open questions. Human
 * edits are saved as a NEW version carrying who edited it, so the generated
 * text and the human text are never confused with one another and the history
 * stays attributable.
 *
 * Routes: GET|POST /api/workspaces/:id/handover,
 * POST /api/workspaces/:id/handover/preview, GET|PUT /api/handover/:id,
 * POST /api/handover/:id/refresh, GET /api/handover/:id/history.
 *
 * @param {{ workspaceId: string, taskId?: string|null, runId?: string|null, editedBy?: string }} props
 */
export default function HandoverBrief({
  workspaceId,
  taskId = null,
  runId = null,
  editedBy = "local-user",
}) {
  const params = new URLSearchParams();
  if (taskId) params.set("taskId", taskId);
  if (runId) params.set("runId", runId);
  const listPath = workspaceId
    ? `/workspaces/${encodeURIComponent(workspaceId)}/handover${params.toString() ? `?${params}` : ""}`
    : null;
  const briefs = useApi(listPath);
  const [selectedId, setSelectedId] = useState(null);
  const [brief, setBrief] = useState(null);
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const list = Array.isArray(briefs.data)
    ? briefs.data
    : (briefs.data?.briefs ?? []);

  useEffect(() => {
    if (!selectedId && list.length) setSelectedId(list[0].id);
  }, [list, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setBrief(null);
      setDraft("");
      return undefined;
    }
    let stopped = false;
    apiFetch(`/handover/${encodeURIComponent(selectedId)}`)
      .then((data) => {
        if (stopped) return;
        setBrief(data);
        setDraft(data?.body ?? "");
      })
      .catch((err) => !stopped && setError(err.message));
    return () => {
      stopped = true;
    };
  }, [selectedId]);

  const guard = async (fn) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    guard(async () => {
      const created = await apiFetch(
        `/workspaces/${encodeURIComponent(workspaceId)}/handover`,
        { method: "POST", body: { taskId, runId, author: editedBy } },
      );
      briefs.reload();
      setSelectedId(created.id);
      setMessage(
        "Baseline assembled from the recorded task, runs, decisions and artifacts. Edit it and save to add your own version.",
      );
    });

  if (!workspaceId)
    return (
      <EmptyState
        compact
        title="Choose a workspace"
        description="A handover brief belongs to one workspace."
      />
    );
  if (briefs.error)
    return (
      <EmptyState
        title="Handover briefs are unavailable"
        error={briefs.error}
        missingRoutes={[
          "GET /api/workspaces/:id/handover",
          "GET /api/handover/:id",
        ]}
      />
    );

  return (
    <section className="as-handover" aria-label="Handover brief">
      <header className="as-section-head">
        <h3>
          <NotebookPen size={14} aria-hidden="true" /> Handover brief
        </h3>
        <button
          type="button"
          className="button"
          onClick={create}
          disabled={busy}
        >
          New brief from records
        </button>
      </header>
      <p className="as-muted as-small">
        The baseline is assembled from stored records only. Your edits are saved
        as a new version attributed to you; the generated text is kept beside
        them so the two are never mixed up.
      </p>

      {message ? (
        <p className="as-feedback" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <div className="form-error" role="alert">
          {error}
        </div>
      ) : null}

      {list.length === 0 && !briefs.loading ? (
        <EmptyState
          compact
          icon={<NotebookPen size={20} />}
          title="No handover brief yet"
          description="Assemble one from what has already been recorded, then edit it before handing the work over."
          actions={[
            { label: "New brief from records", primary: true, onClick: create },
          ]}
        />
      ) : null}

      {list.length ? (
        <label className="as-inline-label">
          Brief
          <select
            value={selectedId ?? ""}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {list.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.taskId ? `Task ${entry.taskId.slice(0, 8)}` : ""}
                {entry.runId ? ` Run ${entry.runId.slice(0, 8)}` : ""}
                {!entry.taskId && !entry.runId ? "Workspace" : ""} · v
                {entry.version} · {formatTime(entry.updatedAt)}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {brief ? (
        <>
          <p className="as-row as-wrap as-small as-muted">
            <span className="as-tag">version {brief.version}</span>
            <span>
              {brief.editedBy
                ? `last edited by ${brief.editedBy}`
                : "generated by Agent Space, not yet edited"}
            </span>
            <span>{formatTime(brief.updatedAt)}</span>
          </p>
          <label className="as-handover-editor">
            Brief (Markdown)
            <textarea
              rows={16}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              aria-label="Handover brief body"
            />
          </label>
          <div className="as-row as-wrap">
            <button
              type="button"
              className="button primary"
              disabled={busy || draft === brief.body}
              onClick={() =>
                guard(async () => {
                  const saved = await apiFetch(
                    `/handover/${encodeURIComponent(brief.id)}`,
                    { method: "PUT", body: { body: draft, editedBy } },
                  );
                  setBrief(saved);
                  setMessage(
                    `Saved as version ${saved.version}, attributed to ${saved.editedBy ?? editedBy}.`,
                  );
                  briefs.reload();
                })
              }
            >
              <Save size={12} /> Save as a new version
            </button>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() =>
                guard(async () => {
                  const refreshed = await apiFetch(
                    `/handover/${encodeURIComponent(brief.id)}/refresh`,
                    { method: "POST" },
                  );
                  setBrief(refreshed);
                  setDraft(refreshed?.body ?? "");
                  setMessage(
                    `Regenerated the baseline as version ${refreshed.version}. Your earlier versions are still in the history.`,
                  );
                })
              }
            >
              <RefreshCw size={12} /> Regenerate the baseline
            </button>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() =>
                guard(async () => {
                  setHistory(
                    await apiFetch(
                      `/handover/${encodeURIComponent(brief.id)}/history`,
                    ),
                  );
                })
              }
            >
              <History size={12} /> Show history
            </button>
          </div>

          {history ? (
            <ol className="as-handover-history" aria-label="Brief versions">
              {(Array.isArray(history)
                ? history
                : (history.versions ?? [])
              ).map((version) => (
                <li key={version.versionId ?? version.version}>
                  <span className="as-tag">v{version.version}</span>
                  <span>
                    {version.editedBy
                      ? `edited by ${version.editedBy}`
                      : "generated baseline"}
                  </span>
                  <time
                    dateTime={new Date(version.updatedAt).toISOString?.() ?? ""}
                  >
                    {formatTime(version.updatedAt)}
                  </time>
                </li>
              ))}
            </ol>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
