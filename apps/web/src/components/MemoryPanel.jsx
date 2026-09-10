import React, { useMemo, useState } from "react";
import { Brain, Trash2, Plus } from "lucide-react";
import { apiFetch, useApi, formatTime } from "../hooks/useApi.js";
import EmptyState from "./EmptyState.jsx";

/** The three scopes and what each one is allowed to hold. */
export const MEMORY_SCOPES = [
  {
    id: "workspace",
    label: "Workspace knowledge",
    detail:
      "Facts about this workspace: conventions, where things live, decisions already taken. Never shared with another workspace.",
  },
  {
    id: "user",
    label: "Personal preferences",
    detail:
      "How you like to be worked with. Applies to you across workspaces, and is stored locally like everything else.",
  },
  {
    id: "run",
    label: "Run notes",
    detail:
      "Temporary notes attached to one run. They disappear with the run and never leak into another.",
  },
];

function pathFor(scope, { workspaceId, runId }) {
  if (scope === "user") return "/memory/user";
  if (scope === "run")
    return runId ? `/runs/${encodeURIComponent(runId)}/memory` : null;
  return workspaceId
    ? `/workspaces/${encodeURIComponent(workspaceId)}/memory`
    : null;
}

/**
 * Scoped memory: workspace knowledge, personal preferences and run notes.
 * Isolation is the point — nothing here is copied between scopes, and the
 * panel says so where a reader might assume otherwise.
 *
 * Routes: GET|POST|DELETE /api/workspaces/:id/memory, /api/memory/user,
 * /api/runs/:id/memory.
 *
 * @param {{ workspaceId?: string|null, runId?: string|null, defaultScope?: 'workspace'|'user'|'run' }} props
 */
export default function MemoryPanel({
  workspaceId = null,
  runId = null,
  defaultScope = "workspace",
}) {
  const [scope, setScope] = useState(defaultScope);
  const [draft, setDraft] = useState({ key: "", value: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const path = pathFor(scope, { workspaceId, runId });
  const memory = useApi(path);

  const entries = useMemo(() => {
    const data = memory.data;
    if (!data) return [];
    const list = Array.isArray(data) ? data : (data.entries ?? []);
    return [...list].sort((a, b) =>
      String(a.key ?? "").localeCompare(String(b.key ?? "")),
    );
  }, [memory.data]);

  const scopeMeta = MEMORY_SCOPES.find((entry) => entry.id === scope);

  const add = async (event) => {
    event.preventDefault();
    if (!path || !draft.key.trim()) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await apiFetch(path, {
        method: "POST",
        body: {
          key: draft.key.trim(),
          value: draft.value,
          source: "user",
        },
      });
      setDraft({ key: "", value: "" });
      setMessage("Saved. It is attached to this scope only.");
      memory.reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const forget = async (key) => {
    if (!path) return;
    setBusy(true);
    setError("");
    try {
      await apiFetch(`${path}?key=${encodeURIComponent(key)}`, {
        method: "DELETE",
      });
      setMessage(`Forgot "${key}".`);
      memory.reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="as-memory" aria-label="Scoped memory">
      <header className="as-section-head">
        <h3>
          <Brain size={14} aria-hidden="true" /> Memory
        </h3>
        <div
          className="as-row as-filters"
          role="group"
          aria-label="Memory scope"
        >
          {MEMORY_SCOPES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`as-chip ${scope === entry.id ? "active" : ""}`}
              aria-pressed={scope === entry.id}
              disabled={entry.id === "run" && !runId}
              title={
                entry.id === "run" && !runId
                  ? "Open a run to see its notes"
                  : entry.detail
              }
              onClick={() => setScope(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </header>
      <p className="as-muted as-small">{scopeMeta?.detail}</p>

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

      {!path ? (
        <EmptyState
          compact
          title="Nothing selected"
          description={
            scope === "run"
              ? "Open a run to read or write its notes."
              : "Choose a workspace first."
          }
        />
      ) : memory.error ? (
        <EmptyState
          compact
          title="Memory is unavailable"
          error={memory.error}
          missingRoutes={[`GET ${path.replace(/\/[^/]+\//, "/:id/")}`]}
        />
      ) : entries.length === 0 && !memory.loading ? (
        <EmptyState
          compact
          icon={<Brain size={20} />}
          title="Nothing remembered in this scope"
          description="Add a fact an agent should be told every time it works here."
        />
      ) : (
        <ul className="as-memory-list" role="list">
          {entries.map((entry) => (
            <li key={entry.key} className="as-memory-item">
              <div>
                <code className="as-mono">{entry.key}</code>
                <p>{String(entry.value ?? "")}</p>
                <span className="as-muted as-small">
                  {entry.kind ? `${entry.kind} · ` : ""}
                  {entry.source
                    ? `recorded by ${entry.source}`
                    : "source not recorded"}
                  {entry.updatedAt ? ` · ${formatTime(entry.updatedAt)}` : ""}
                  {entry.expiresAt
                    ? ` · expires ${formatTime(entry.expiresAt)}`
                    : ""}
                </span>
              </div>
              <button
                type="button"
                className="icon-button"
                disabled={busy}
                onClick={() => forget(entry.key)}
                aria-label={`Forget ${entry.key}`}
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {path ? (
        <form
          className="as-memory-form"
          onSubmit={add}
          aria-label="Add a memory entry"
        >
          <div className="form-columns">
            <label>
              Key
              <input
                value={draft.key}
                onChange={(event) =>
                  setDraft({ ...draft, key: event.target.value })
                }
                placeholder="test-command"
              />
            </label>
            <label>
              Value
              <input
                value={draft.value}
                onChange={(event) =>
                  setDraft({ ...draft, value: event.target.value })
                }
                placeholder="npm test -- --runInBand"
              />
            </label>
          </div>
          <button
            type="submit"
            className="button"
            disabled={busy || !draft.key.trim()}
          >
            <Plus size={12} /> Remember
          </button>
          <p className="as-muted as-small">
            Never store a credential here. Keys that look like a secret are
            refused by the server.
          </p>
        </form>
      ) : null}
    </section>
  );
}
