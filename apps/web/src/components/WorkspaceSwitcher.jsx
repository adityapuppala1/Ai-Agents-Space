import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  FolderOpen,
  Plus,
  Pencil,
  Archive,
  Check,
} from "lucide-react";
import { apiFetch, maskPath } from "../hooks/useApi.js";
import { useGlobal } from "../hooks/useGlobal.js";
import { useLocalStorage, pushRecent } from "../hooks/useLocalStorage.js";
import {
  runtimesForWorkspace,
  workspaceRuntimeNote,
  workspaceSignal,
} from "../hooks/workspaceSummary.js";
import { themeLabel } from "../office/themeCatalog.js";
import EmptyState from "./EmptyState.jsx";

export const RECENT_WORKSPACES_KEY = "agent-space-recent-workspaces";
export { runtimesForWorkspace };

/**
 * Rich workspace switcher: name, what is going on there (agents, running,
 * attention), its folder and office theme, the runtimes it may launch when
 * that is restricted, recent workspaces, and create / rename / archive.
 *
 * Data comes from `useGlobal()` (workspaces + connections from the global
 * channel) unless `workspaces`/`connections` are passed in.
 *
 * @param {{
 *   currentId: string,
 *   onSelect: (workspaceId: string) => void,
 *   workspaces?: any[],           // [{ id, name, rootPath, theme, activeRuns, attention, agents, kind, archivedAt }]
 *   connections?: any[],          // [{ id, provider, alias, status, enabled, allowedWorkspaces }]
 *   presentation?: boolean,       // mask private absolute paths
 *   onChanged?: () => void,       // called after create/rename/archive succeeded
 *   allowManage?: boolean         // default true; false hides create/rename/archive
 * }} props
 */
export default function WorkspaceSwitcher({
  currentId,
  onSelect,
  workspaces: givenWorkspaces,
  connections: givenConnections,
  presentation = false,
  onChanged,
  allowManage = true,
}) {
  const { global } = useGlobal();
  const workspaces = givenWorkspaces ?? global.workspaces ?? [];
  const connections = givenConnections ?? global.connections ?? [];
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState(null); // { id, name }
  const [creating, setCreating] = useState(null); // { name, rootPath }
  // Managing is a second mode, not a permanent fixture of the list: renaming
  // and archiving are rare, and picking a workspace is what this menu is for.
  const [managing, setManaging] = useState(false);
  const [filter, setFilter] = useState("");
  const [recent, setRecent] = useLocalStorage(RECENT_WORKSPACES_KEY, []);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);

  const current =
    workspaces.find((workspace) => workspace.id === currentId) ?? null;

  useEffect(() => {
    if (currentId) setRecent((list) => pushRecent(list, currentId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  // Closing the menu puts it back to what it is for: picking a workspace.
  useEffect(() => {
    if (open) return;
    setManaging(false);
    setFilter("");
    setRenaming(null);
    setCreating(null);
    setError("");
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDocument = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDocument);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocument);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Recency is an ordering, not a second list. A "Recent" section repeated
  // rows that were already on screen a few lines above.
  const ordered = useMemo(() => {
    const seen = new Map(
      (Array.isArray(recent) ? recent : []).map((id, index) => [id, index]),
    );
    return [...workspaces].sort((a, b) => {
      if (a.id === currentId) return -1;
      if (b.id === currentId) return 1;
      const ra = seen.has(a.id) ? seen.get(a.id) : Infinity;
      const rb = seen.has(b.id) ? seen.get(b.id) : Infinity;
      if (ra !== rb) return ra - rb;
      return (a.name ?? "").localeCompare(b.name ?? "");
    });
  }, [workspaces, recent, currentId]);

  // A search box is itself clutter until there are enough rows to search.
  const searchable = workspaces.length >= 9;
  const needle = filter.trim().toLowerCase();
  const shown =
    searchable && needle
      ? ordered.filter((workspace) =>
          (workspace.name ?? "").toLowerCase().includes(needle),
        )
      : ordered;

  const act = async (fn) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const create = (event) => {
    event.preventDefault();
    const input = creating ?? {};
    if (!input.name?.trim()) return;
    act(async () => {
      const created = await apiFetch("/workspaces", {
        method: "POST",
        body: {
          name: input.name.trim(),
          rootPath: input.rootPath?.trim() || null,
        },
      });
      setCreating(null);
      if (created?.id) {
        onSelect(created.id);
        setOpen(false);
      }
    });
  };

  const rename = (event) => {
    event.preventDefault();
    const input = renaming;
    if (!input?.name?.trim()) return;
    act(async () => {
      await apiFetch(`/workspaces/${encodeURIComponent(input.id)}`, {
        method: "PATCH",
        body: { name: input.name.trim() },
      });
      setRenaming(null);
    });
  };

  const archive = (workspace) =>
    act(async () => {
      await apiFetch(
        `/workspaces/${encodeURIComponent(workspace.id)}/archive`,
        { method: "POST" },
      );
      if (workspace.id === currentId) {
        const next = workspaces.find((w) => w.id !== workspace.id);
        if (next) onSelect(next.id);
      }
    });

  const summary = current
    ? `${current.name}${current.attention ? `, ${current.attention} need attention` : ""}`
    : "No workspace selected";

  return (
    <div className="as-wsswitch" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="as-wsswitch-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        aria-label={`Workspace: ${summary}. Open workspace switcher`}
      >
        <FolderOpen size={14} aria-hidden="true" />
        <span className="as-wsswitch-name">{current?.name ?? "Workspace"}</span>
        {current?.activeRuns ? (
          <span className="as-tag">{current.activeRuns} running</span>
        ) : null}
        {current?.attention ? (
          <span className="as-tag as-tag-warn">
            {current.attention} attention
          </span>
        ) : null}
        <ChevronDown size={13} aria-hidden="true" />
      </button>

      {open ? (
        <div
          className="as-wsswitch-menu panel"
          role="dialog"
          aria-label="Workspaces"
        >
          {error ? (
            <div className="form-error" role="alert">
              {error}
            </div>
          ) : null}
          {workspaces.length === 0 ? (
            <EmptyState
              compact
              title="No workspaces yet"
              description="Create one to point Agent Space at a repository or folder."
            />
          ) : null}
          {searchable ? (
            <div className="as-wsswitch-search">
              <label className="sr-only" htmlFor="ws-filter">
                Filter workspaces
              </label>
              <input
                id="ws-filter"
                type="search"
                value={filter}
                placeholder="Filter workspaces"
                onChange={(event) => setFilter(event.target.value)}
              />
            </div>
          ) : null}

          <ul className="as-wsswitch-list" aria-label="All workspaces">
            {shown.map((workspace) => {
              const selected = workspace.id === currentId;
              const signal = workspaceSignal(workspace);
              // Only the workspace you are in spells out where it lives and
              // what it looks like. On every other row that is a fact you
              // did not ask for while you were trying to pick a name.
              const theme = selected ? themeLabel(workspace.theme) : null;
              const runtimeNote = selected
                ? workspaceRuntimeNote(connections, workspace.id)
                : null;
              const path =
                selected && workspace.rootPath
                  ? maskPath(workspace.rootPath, presentation)
                  : "";
              return (
                <li key={workspace.id} className="as-wsswitch-row">
                  <button
                    type="button"
                    aria-current={selected ? "true" : undefined}
                    className={`as-wsswitch-item ${selected ? "active" : ""}`}
                    onClick={() => {
                      onSelect(workspace.id);
                      setOpen(false);
                    }}
                  >
                    <span className="ws-item-top">
                      <span className="ws-item-check" aria-hidden="true">
                        {selected ? <Check size={13} /> : null}
                      </span>
                      <strong className="ws-item-name">{workspace.name}</strong>
                      {workspace.kind === "demo" ? (
                        <span className="as-tag">Demo</span>
                      ) : null}
                      {signal ? (
                        <span
                          className={`ws-item-signal ${signal.tone}`}
                          aria-label={signal.label}
                        >
                          {signal.text}
                        </span>
                      ) : null}
                    </span>
                    {selected ? (
                      <span className="ws-item-meta">
                        {path ? (
                          <span className="ws-item-path" title={path}>
                            {path}
                          </span>
                        ) : (
                          <span>No folder set</span>
                        )}
                        <span className="ws-item-theme">
                          <i
                            className="ws-item-swatch"
                            aria-hidden="true"
                            style={{ background: theme.color }}
                          />
                          {theme.label}
                        </span>
                      </span>
                    ) : null}
                    {runtimeNote ? (
                      <span className="ws-item-runtimes">{runtimeNote}</span>
                    ) : null}
                  </button>
                  {allowManage && managing ? (
                    <span
                      className="as-wsswitch-actions"
                      role="group"
                      aria-label={`Manage ${workspace.name}`}
                    >
                      <button
                        type="button"
                        className="icon-button"
                        disabled={busy}
                        aria-label={`Rename ${workspace.name}`}
                        onClick={() =>
                          setRenaming({
                            id: workspace.id,
                            name: workspace.name,
                          })
                        }
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        disabled={busy || workspace.kind === "demo"}
                        aria-label={
                          workspace.kind === "demo"
                            ? "The demo workspace cannot be archived"
                            : `Archive ${workspace.name}`
                        }
                        title={
                          workspace.kind === "demo"
                            ? "The demo workspace cannot be archived"
                            : "Archive"
                        }
                        onClick={() => archive(workspace)}
                      >
                        <Archive size={12} />
                      </button>
                    </span>
                  ) : null}
                </li>
              );
            })}
            {shown.length === 0 ? (
              <li className="as-wsswitch-none as-muted as-small">
                No workspace matches “{filter.trim()}”.
              </li>
            ) : null}
          </ul>

          {allowManage ? (
            <div className="as-wsswitch-foot">
              {creating ? (
                <form onSubmit={create} aria-label="Create workspace">
                  <label>
                    Name
                    <input
                      autoFocus
                      value={creating.name ?? ""}
                      onChange={(event) =>
                        setCreating({ ...creating, name: event.target.value })
                      }
                      placeholder="Payments service"
                    />
                  </label>
                  <label>
                    Folder or repository path{" "}
                    <span className="optional">(optional)</span>
                    <input
                      value={creating.rootPath ?? ""}
                      onChange={(event) =>
                        setCreating({
                          ...creating,
                          rootPath: event.target.value,
                        })
                      }
                      placeholder="C:\\src\\payments"
                    />
                  </label>
                  <div className="modal-actions">
                    <button
                      type="button"
                      className="button"
                      onClick={() => setCreating(null)}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="button primary"
                      disabled={busy}
                    >
                      Create
                    </button>
                  </div>
                </form>
              ) : (
                <div className="as-wsswitch-tools">
                  <button
                    type="button"
                    className="button"
                    onClick={() => setCreating({ name: "", rootPath: "" })}
                  >
                    <Plus size={12} /> New workspace
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    aria-pressed={managing}
                    onClick={() => {
                      setManaging((value) => !value);
                      setRenaming(null);
                    }}
                  >
                    {managing ? "Done managing" : "Manage workspaces"}
                  </button>
                </div>
              )}
              {renaming ? (
                <form onSubmit={rename} aria-label="Rename workspace">
                  <label>
                    New name
                    <input
                      autoFocus
                      value={renaming.name}
                      onChange={(event) =>
                        setRenaming({ ...renaming, name: event.target.value })
                      }
                    />
                  </label>
                  <div className="modal-actions">
                    <button
                      type="button"
                      className="button"
                      onClick={() => setRenaming(null)}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="button primary"
                      disabled={busy}
                    >
                      Rename
                    </button>
                  </div>
                </form>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
