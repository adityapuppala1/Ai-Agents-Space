import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  FolderOpen,
  Plus,
  Pencil,
  Archive,
  History,
  Check,
} from "lucide-react";
import { apiFetch, maskPath, providerLabel } from "../hooks/useApi.js";
import { useGlobal } from "../hooks/useGlobal.js";
import { useLocalStorage, pushRecent } from "../hooks/useLocalStorage.js";
import EmptyState from "./EmptyState.jsx";

export const RECENT_WORKSPACES_KEY = "agent-space-recent-workspaces";

/** Theme preview swatches. Colour is a preview, never the only signal: the
 *  theme name is always written next to it. */
const THEME_PREVIEW = {
  studio: {
    label: "Development Studio",
    colors: ["#f4efe6", "#c9b28a", "#5d7f9c"],
  },
  operations: {
    label: "Operations Center",
    colors: ["#1d2733", "#2f4a63", "#6fa8dc"],
  },
};

/** Connections that may be used by a workspace, per `allowedWorkspaces`. */
export function runtimesForWorkspace(connections = [], workspaceId) {
  return connections.filter((connection) => {
    if (connection.enabled === false) return false;
    const allowed = connection.allowedWorkspaces;
    if (!Array.isArray(allowed) || allowed.length === 0) return true;
    return allowed.includes(workspaceId);
  });
}

function StatusDot({ status }) {
  const label =
    status === "ready"
      ? "ready"
      : status === "error"
        ? "error"
        : status === "missing"
          ? "missing"
          : status === "detected"
            ? "detected"
            : "unknown";
  return <span className={`as-conn-dot as-conn-${label}`}>{label}</span>;
}

/**
 * Rich workspace switcher: name, root path, the runtimes connected to it,
 * active runs, an attention count, a theme preview, recent workspaces, and
 * create / rename / archive actions.
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
  const [recent, setRecent] = useLocalStorage(RECENT_WORKSPACES_KEY, []);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);

  const current =
    workspaces.find((workspace) => workspace.id === currentId) ?? null;

  useEffect(() => {
    if (currentId) setRecent((list) => pushRecent(list, currentId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

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

  const recentList = useMemo(() => {
    const known = new Map(workspaces.map((w) => [w.id, w]));
    return (Array.isArray(recent) ? recent : [])
      .filter((id) => id !== currentId && known.has(id))
      .slice(0, 5)
      .map((id) => known.get(id));
  }, [recent, workspaces, currentId]);

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
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        aria-label={`Workspace: ${summary}. Open workspace switcher`}
      >
        <FolderOpen size={14} aria-hidden="true" />
        <span className="as-wsswitch-name">{current?.name ?? "Workspace"}</span>
        {current?.activeRuns ? (
          <span className="as-tag">{current.activeRuns} active</span>
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
          role="menu"
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
          <ul className="as-wsswitch-list" role="none">
            {workspaces.map((workspace) => {
              const runtimes = runtimesForWorkspace(connections, workspace.id);
              const theme = THEME_PREVIEW[workspace.theme] ?? {
                label: workspace.theme ?? "studio",
                colors: ["#ddd", "#bbb", "#999"],
              };
              const selected = workspace.id === currentId;
              return (
                <li key={workspace.id} className="as-wsswitch-row">
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className={`as-wsswitch-item ${selected ? "active" : ""}`}
                    onClick={() => {
                      onSelect(workspace.id);
                      setOpen(false);
                    }}
                  >
                    <span className="as-row as-wrap">
                      {selected ? <Check size={12} aria-hidden="true" /> : null}
                      <strong>{workspace.name}</strong>
                      {workspace.kind === "demo" ? (
                        <span className="as-tag">Demo</span>
                      ) : null}
                      {workspace.autoCreated ? (
                        <span className="as-tag">auto-created</span>
                      ) : null}
                    </span>
                    <span className="as-muted as-small as-mono">
                      {workspace.rootPath
                        ? maskPath(workspace.rootPath, presentation)
                        : "no folder set"}
                    </span>
                    <span className="as-row as-wrap as-wsswitch-meta">
                      <span className="as-tag">
                        {workspace.activeRuns ?? 0} active run
                        {(workspace.activeRuns ?? 0) === 1 ? "" : "s"}
                      </span>
                      <span
                        className={`as-tag ${workspace.attention ? "as-tag-warn" : ""}`}
                      >
                        {workspace.attention ?? 0} need attention
                      </span>
                      <span className="as-tag">
                        {workspace.agents ?? 0} agents
                      </span>
                    </span>
                    <span className="as-row as-wrap as-wsswitch-runtimes">
                      {runtimes.length === 0 ? (
                        <span className="as-muted as-small">
                          no runtime connected
                        </span>
                      ) : (
                        runtimes.map((connection) => (
                          <span
                            key={connection.id}
                            className="as-runtime-chip"
                            title={`${providerLabel(connection.provider)} (${connection.alias ?? "default"}): ${connection.status ?? "unknown"}`}
                          >
                            {providerLabel(connection.provider)}
                            {connection.alias && connection.alias !== "default"
                              ? ` · ${connection.alias}`
                              : ""}
                            <StatusDot status={connection.status} />
                          </span>
                        ))
                      )}
                    </span>
                    <span className="as-row as-wsswitch-theme">
                      <span
                        className="as-theme-swatch"
                        aria-hidden="true"
                        style={{
                          background: `linear-gradient(90deg, ${theme.colors.join(", ")})`,
                        }}
                      />
                      <span className="as-muted as-small">
                        Theme: {theme.label}
                      </span>
                    </span>
                  </button>
                  {allowManage ? (
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
          </ul>

          {recentList.length ? (
            <section
              className="as-wsswitch-recent"
              aria-label="Recent workspaces"
            >
              <h4>
                <History size={12} aria-hidden="true" /> Recent
              </h4>
              <ul role="none">
                {recentList.map((workspace) => (
                  <li key={workspace.id}>
                    <button
                      type="button"
                      role="menuitem"
                      className="text-button"
                      onClick={() => {
                        onSelect(workspace.id);
                        setOpen(false);
                      }}
                    >
                      {workspace.name}
                      <span className="as-muted as-small">
                        {" "}
                        {workspace.rootPath
                          ? maskPath(workspace.rootPath, presentation)
                          : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

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
                <button
                  type="button"
                  className="button"
                  onClick={() => setCreating({ name: "", rootPath: "" })}
                >
                  <Plus size={12} /> New workspace
                </button>
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
