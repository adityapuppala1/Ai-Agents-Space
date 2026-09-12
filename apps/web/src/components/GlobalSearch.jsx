import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Search, FileText, Play, Activity, Package, Radio } from "lucide-react";
import { apiFetch, ApiError, formatTime, maskPath } from "../hooks/useApi.js";
import { useDialogFocus } from "../hooks/useDialogFocus.js";
import EmptyState from "./EmptyState.jsx";
import ProviderBadge from "./ProviderBadge.jsx";

export const SEARCH_ROUTE = "GET /api/search";

const KIND_META = {
  tasks: { label: "Tasks", icon: <FileText size={12} /> },
  runs: { label: "Runs", icon: <Play size={12} /> },
  events: { label: "Events", icon: <Activity size={12} /> },
  artifacts: { label: "Artifacts", icon: <Package size={12} /> },
  sessions: { label: "Sessions", icon: <Radio size={12} /> },
};
const KIND_ORDER = ["tasks", "runs", "events", "artifacts", "sessions"];

/**
 * Global search over the records Agent Space already holds — tasks, runs,
 * events, artifacts and observed sessions — through
 * `GET /api/search?q=&workspace=&kinds=`.
 *
 * It never searches the filesystem, and the footer says so, because the server
 * only matches text it has stored. When the route is missing (404) or the
 * service is not composed (503) the panel says which route the feature needs
 * instead of showing an empty result list.
 *
 * Opens with Ctrl/Cmd+Shift+F when `bindShortcut` is true, and from the
 * command palette by calling `onOpen`.
 *
 * @param {{
 *   open: boolean,
 *   onClose: () => void,
 *   onOpen?: () => void,
 *   workspaceId?: string|null,   // null searches every workspace
 *   scopeToWorkspace?: boolean,
 *   onOpenResult?: (result: { kind:string, id:string, runId?:string, taskId?:string, workspaceId?:string }) => void,
 *   bindShortcut?: boolean,
 *   presentation?: boolean
 * }} props
 */
export default function GlobalSearch({
  open,
  onClose,
  onOpen,
  workspaceId = null,
  scopeToWorkspace: initialScope = false,
  onOpenResult,
  bindShortcut = true,
  presentation = false,
}) {
  const [query, setQuery] = useState("");
  const [kinds, setKinds] = useState(() => new Set(KIND_ORDER));
  const [scoped, setScoped] = useState(initialScope);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [index, setIndex] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const dialogRef = useRef(null);
  // Tab stays inside while open; focus goes back to the invoker on close.
  useDialogFocus(dialogRef, open);
  const id = useId();

  useEffect(() => {
    if (!bindShortcut) return undefined;
    const handler = (event) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        if (open) onClose();
        else onOpen?.();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onOpen, onClose, bindShortcut]);

  useEffect(() => {
    if (!open) return;
    setIndex(0);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const kindParam = useMemo(
    () => KIND_ORDER.filter((kind) => kinds.has(kind)).join(","),
    [kinds],
  );

  useEffect(() => {
    if (!open) return undefined;
    const text = query.trim();
    if (!text) {
      setData(null);
      setError(null);
      setLoading(false);
      return undefined;
    }
    let stopped = false;
    setLoading(true);
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: text });
      if (scoped && workspaceId) params.set("workspace", workspaceId);
      if (kindParam) params.set("kinds", kindParam);
      apiFetch(`/search?${params.toString()}`)
        .then((result) => {
          if (stopped) return;
          setData(result);
          setError(null);
        })
        .catch((err) => {
          if (stopped || err?.name === "AbortError") return;
          setData(null);
          setError(
            err instanceof ApiError ? err : new ApiError(err.message, 0),
          );
        })
        .finally(() => !stopped && setLoading(false));
    }, 180);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [open, query, scoped, workspaceId, kindParam]);

  const results = data?.results ?? [];
  useEffect(() => setIndex(0), [results.length]);
  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [index]);

  if (!open) return null;

  const choose = (result) => {
    if (!result) return;
    onClose();
    onOpenResult?.(result);
  };

  const onKeyDown = (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((value) => Math.min(value + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((value) => Math.max(value - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(results[index]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  const toggleKind = (kind) =>
    setKinds((current) => {
      const next = new Set(current);
      if (next.has(kind) && next.size > 1) next.delete(kind);
      else next.add(kind);
      return next;
    });

  const activeId = results[index] ? `${id}-opt-${index}` : undefined;
  const counts = data?.counts ?? {};

  return (
    <div
      className="as-palette-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className="as-palette as-search panel"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Global search"
        onKeyDown={(event) => {
          // Escape closes from any control inside, not only the text box.
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <div className="as-palette-input">
          <Search size={15} aria-hidden="true" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-label="Search tasks, runs, events, artifacts and sessions"
            placeholder="Search recorded tasks, runs, events, artifacts, sessions…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd>Esc</kbd>
        </div>

        <div
          className="as-row as-wrap as-search-filters"
          role="group"
          aria-label="Result kinds"
        >
          {KIND_ORDER.map((kind) => (
            <button
              key={kind}
              type="button"
              className={`as-chip ${kinds.has(kind) ? "active" : ""}`}
              aria-pressed={kinds.has(kind)}
              onClick={() => toggleKind(kind)}
            >
              {KIND_META[kind].icon} {KIND_META[kind].label}
              {counts[kind] ? (
                <span className="as-count">{counts[kind]}</span>
              ) : null}
            </button>
          ))}
          {workspaceId ? (
            <label className="as-inline-label as-search-scope">
              <input
                type="checkbox"
                checked={scoped}
                onChange={(event) => setScoped(event.target.checked)}
              />
              This workspace only
            </label>
          ) : null}
        </div>

        <div className="as-search-body">
          {error ? (
            <EmptyState
              compact
              title="Search is unavailable"
              error={error}
              missingRoutes={[SEARCH_ROUTE]}
            />
          ) : null}
          {!error && !query.trim() ? (
            <EmptyState
              compact
              icon={<Search size={20} />}
              title="Type to search"
              description="Agent Space searches its own records: task titles, run titles, event summaries, artifact titles and observed session titles."
              hint="It never reads file contents from disk, so a phrase that exists only inside a source file will not match."
            />
          ) : null}
          {!error && query.trim() && !loading && results.length === 0 ? (
            <EmptyState
              compact
              icon={<Search size={20} />}
              title="Nothing recorded matches"
              description={
                data?.note ??
                "No recorded task, run, event, artifact or observed session matches this text."
              }
              hint="Widen the kinds above, or clear the workspace scope."
            />
          ) : null}
          {loading && results.length === 0 ? (
            <p className="as-muted">Searching recorded data…</p>
          ) : null}

          {results.length ? (
            <ul
              className="as-palette-list as-search-list"
              role="listbox"
              id={`${id}-list`}
              ref={listRef}
              aria-label="Search results"
            >
              {results.map((result, i) => (
                <li
                  key={`${result.kind}-${result.id}-${i}`}
                  id={`${id}-opt-${i}`}
                  role="option"
                  aria-selected={i === index}
                  className={`as-palette-item as-search-item ${i === index ? "active" : ""}`}
                  onMouseEnter={() => setIndex(i)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(result)}
                >
                  <span className="as-palette-group">
                    {KIND_META[result.kind]?.label ?? result.kind}
                  </span>
                  <span className="as-palette-label">
                    {presentation && /[\\/]/.test(String(result.title ?? ""))
                      ? maskPath(result.title, true)
                      : (result.title ?? result.id)}
                  </span>
                  {result.snippet ? (
                    <span className="as-muted as-small as-search-snippet">
                      {result.snippet}
                    </span>
                  ) : null}
                  <span className="as-row as-wrap as-small as-muted">
                    {result.provider ? (
                      <ProviderBadge provider={result.provider} size="small" />
                    ) : null}
                    {result.basis ? (
                      <span className="as-tag">matched {result.basis}</span>
                    ) : null}
                    {result.timestamp ? (
                      <span>{formatTime(result.timestamp)}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <footer className="as-search-foot as-muted as-small">
          Enter opens the record · arrows move · results come from the SQLite
          records only, never from the filesystem.
        </footer>
      </div>
    </div>
  );
}
