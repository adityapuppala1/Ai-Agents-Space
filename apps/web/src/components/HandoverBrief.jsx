import React, { useEffect, useMemo, useState } from "react";
import { NotebookPen, RefreshCw, History, Save } from "lucide-react";
import {
  apiFetch,
  useApi,
  formatTime,
  RUN_STATUS_LABELS,
} from "../hooks/useApi.js";
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
 * What a brief is about (the whole workspace, one task or one run) is chosen
 * here, and briefs are named by the task or run they cover, never by an id
 * or by a selection made on another page.
 *
 * @param {{ workspaceId: string, taskId?: string|null, runId?: string|null, tasks?: any[], runs?: any[], editedBy?: string }} props
 */
export default function HandoverBrief({
  workspaceId,
  taskId = null,
  runId = null,
  tasks = [],
  runs = [],
  editedBy = "local-user",
}) {
  const [scopeKey, setScopeKey] = useState(
    taskId ? `task:${taskId}` : runId ? `run:${runId}` : "all",
  );
  const [scopeKind, scopeId] = scopeKey.split(":");
  const scopeTaskId = scopeKind === "task" ? scopeId : null;
  const scopeRunId = scopeKind === "run" ? scopeId : null;
  const taskTitles = useMemo(
    () => new Map(tasks.map((task) => [task.id, task.title])),
    [tasks],
  );
  const runTitles = useMemo(
    () => new Map(runs.map((run) => [run.id, run])),
    [runs],
  );
  const params = new URLSearchParams();
  if (scopeTaskId) params.set("taskId", scopeTaskId);
  if (scopeRunId) params.set("runId", scopeRunId);
  const listPath = workspaceId
    ? `/workspaces/${encodeURIComponent(workspaceId)}/handover${params.toString() ? `?${params}` : ""}`
    : null;
  const briefs = useApi(listPath);
  const describe = (entry) => {
    if (entry.runId) {
      const run = runTitles.get(entry.runId);
      return `Run: ${run?.title ?? `${entry.runId.slice(0, 8)} (not in this list)`}`;
    }
    if (entry.taskId)
      return `Task: ${taskTitles.get(entry.taskId) ?? `${entry.taskId.slice(0, 8)} (not in this list)`}`;
    return "The whole workspace";
  };
  const scopeName =
    scopeKind === "task"
      ? `the task "${taskTitles.get(scopeTaskId) ?? scopeTaskId}"`
      : scopeKind === "run"
        ? `the run "${runTitles.get(scopeRunId)?.title ?? scopeRunId}"`
        : "the whole workspace";
  const [selectedId, setSelectedId] = useState(null);
  const [brief, setBrief] = useState(null);
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const all = Array.isArray(briefs.data)
    ? briefs.data
    : (briefs.data?.briefs ?? []);
  // "The whole workspace" lists workspace-level briefs only; the server's
  // unfiltered list also carries task and run briefs.
  const list =
    scopeKind === "workspace"
      ? all.filter((entry) => !entry.taskId && !entry.runId)
      : all;

  useEffect(() => {
    setSelectedId(null);
  }, [scopeKey]);

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
        {
          method: "POST",
          body: {
            taskId: scopeTaskId,
            runId: scopeRunId,
            author: editedBy,
          },
        },
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
        <h2>
          <NotebookPen size={14} aria-hidden="true" /> Handover brief
        </h2>
        <button
          type="button"
          className="button"
          onClick={create}
          disabled={busy}
          title={`Assembles a brief about ${scopeName} from stored records`}
        >
          New brief from records
        </button>
      </header>
      <label className="as-inline-label handover-scope">
        <span>Brief for</span>
        <select
          aria-label="What the brief is about"
          value={scopeKey}
          onChange={(event) => setScopeKey(event.target.value)}
        >
          <option value="all">Every brief in this workspace</option>
          <option value="workspace">The whole workspace</option>
          {tasks.length ? (
            <optgroup label="A task">
              {tasks.map((task) => (
                <option key={task.id} value={`task:${task.id}`}>
                  {String(task.title ?? task.id).slice(0, 80)}
                </option>
              ))}
            </optgroup>
          ) : null}
          {runs.length ? (
            <optgroup label="A run">
              {runs.map((run) => (
                <option key={run.id} value={`run:${run.id}`}>
                  {String(run.title ?? run.id).slice(0, 70)} ·{" "}
                  {RUN_STATUS_LABELS[run.status] ?? run.status}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </label>
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
          <span>Brief</span>
          <select
            aria-label="Brief to open"
            value={selectedId ?? ""}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {list.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {describe(entry)} · v{entry.version} ·{" "}
                {formatTime(entry.updatedAt)}
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
