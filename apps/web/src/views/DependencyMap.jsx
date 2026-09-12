import React, { useEffect, useMemo, useState } from "react";
import {
  GitBranch,
  Link2,
  Unlink,
  ArrowUp,
  ArrowDown,
  ShieldCheck,
  Save,
} from "lucide-react";
import {
  apiFetch,
  useApi,
  layerGraph,
  providerLabel,
} from "../hooks/useApi.js";
import { moveInList } from "../hooks/viewLogic.js";
import EmptyState from "../components/EmptyState.jsx";
import { useSelection, FilterChips } from "../components/SelectionProvider.jsx";

const NODE_W = 170;
const NODE_H = 46;
const GAP_X = 70;
const GAP_Y = 18;
const STATUS_TEXT = {
  QUEUE: "Queued",
  IN_PROGRESS: "In progress",
  BLOCKED: "Blocked",
  COMPLETED: "Completed",
};

const PROBLEM_TEXT = {
  cycle: "Dependency cycle",
  unreachable: "Unreachable step",
  "missing-input": "Missing input",
  "permission-conflict": "Permission conflict",
};

/* `moveInList` is in ../hooks/viewLogic.js (covered by node:test). */
export { moveInList };

/**
 * SVG dependency DAG from GET /api/workspaces/:id/graph ({ nodes, edges }),
 * plus an editor for what the selected task waits for. (The Workflow editor
 * route edits a workflow's step definition; this edits task dependencies.)
 *
 * The editor adds, removes and reorders the dependencies of the selected task
 * with the pointer or the keyboard and saves with
 * `PATCH /api/workspaces/:id/tasks/:taskId/dependencies`. Validate checks
 * what is on screen: with unsaved changes it sends the draft to
 * `POST /api/workspaces/:id/validate` (nothing is written); with none it
 * checks the saved graph. The verdict names which one it checked and is
 * cleared the moment the draft changes, so "valid" never describes a graph
 * other than the one shown. Order is
 * recorded because it is the order a reader sees; the scheduler still requires
 * every dependency, whatever the order.
 *
 * Selection and filters are shared through SelectionProvider.
 *
 * @param {{
 *   workspaceId: string,
 *   onSelectTask?: (taskId: string) => void,
 *   graph?: { nodes: any[], edges: any[] },
 *   selectedId?: string|null,
 *   editable?: boolean
 * }} props
 */
export default function DependencyMap({
  workspaceId,
  onSelectTask,
  graph: givenGraph,
  selectedId = null,
  editable = true,
}) {
  const selection = useSelection();
  const activeId = selectedId ?? selection.selectedTaskId;
  const fetched = useApi(
    givenGraph ? null : `/workspaces/${encodeURIComponent(workspaceId)}/graph`,
    { interval: 5000 },
  );
  const graph = givenGraph ?? fetched.data ?? null;

  // An edit is kept with the task it belongs to; until the first edit the
  // draft simply is the task's saved list. (Copying the saved list in an
  // effect left a moment after selection where the draft was empty and an
  // early edit was silently dropped.)
  const [edit, setEdit] = useState(null); // { taskId, deps: string[] }
  const [validation, setValidation] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [linkFrom, setLinkFrom] = useState(null);

  const nodes = useMemo(() => graph?.nodes ?? [], [graph]);
  const byId = useMemo(
    () => new Map(nodes.map((node) => [node.id, node])),
    [nodes],
  );
  const selectedNode = activeId ? (byId.get(activeId) ?? null) : null;
  const draft = selectedNode
    ? edit?.taskId === selectedNode.id
      ? edit.deps
      : [...(selectedNode.dependsOn ?? [])]
    : null;
  const setDraft = (deps) => {
    if (selectedNode) setEdit({ taskId: selectedNode.id, deps });
  };

  useEffect(() => {
    setValidation(null);
    setMessage("");
    setError("");
  }, [activeId]);

  const visibleNodes = useMemo(
    () => nodes.filter((node) => selection.matchesTask(node)),
    [nodes, selection],
  );

  const layout = useMemo(() => {
    if (!graph) return null;
    const list = visibleNodes;
    const visibleIds = new Set(list.map((node) => node.id));
    const edges = (graph.edges ?? [])
      .map((edge) => ({
        from: edge.from ?? edge.source,
        to: edge.to ?? edge.target,
      }))
      .filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));
    const { layers, position } = layerGraph(list, edges);
    const tallest = Math.max(1, ...layers.map((layer) => layer.length));
    const width = Math.max(1, layers.length) * (NODE_W + GAP_X) + 20;
    const height = tallest * (NODE_H + GAP_Y) + 20;
    const place = (id) => {
      const point = position.get(id);
      const layerHeight = layers[point.layer].length * (NODE_H + GAP_Y);
      return {
        x: 10 + point.layer * (NODE_W + GAP_X),
        y:
          10 + (height - 20 - layerHeight) / 2 + point.index * (NODE_H + GAP_Y),
      };
    };
    return {
      nodes: list,
      edges: edges.filter(
        (edge) => position.has(edge.from) && position.has(edge.to),
      ),
      place,
      width,
      height,
    };
  }, [graph, visibleNodes]);

  const pick = (taskId) => {
    selection.selectTask?.(taskId);
    onSelectTask?.(taskId);
  };

  const dirtyNow = () =>
    Boolean(selectedNode) &&
    Array.isArray(draft) &&
    JSON.stringify(draft) !== JSON.stringify(selectedNode.dependsOn ?? []);

  // A verdict describes one graph; editing the draft makes it stale.
  const draftKey = JSON.stringify(draft ?? null);
  useEffect(() => {
    setValidation((current) =>
      current && current.scope === "draft" && current.draftKey !== draftKey
        ? null
        : current,
    );
  }, [draftKey]);

  const validate = async ({ saved = false } = {}) => {
    setBusy(true);
    setError("");
    const path = `/workspaces/${encodeURIComponent(workspaceId)}/validate`;
    const proposing = !saved && dirtyNow();
    try {
      if (proposing) {
        try {
          const report = await apiFetch(path, {
            method: "POST",
            body: { taskId: selectedNode.id, dependsOn: draft },
          });
          setValidation({ ...report, scope: "draft", draftKey });
          return;
        } catch (err) {
          // A server started before draft checks existed answers 404/405:
          // say so rather than passing the saved graph off as the draft.
          if (err.status !== 404 && err.status !== 405) throw err;
          const report = await apiFetch(path);
          setValidation({ ...report, scope: "saved-only", draftKey });
          return;
        }
      }
      setValidation({ ...(await apiFetch(path)), scope: "saved", draftKey });
    } catch (err) {
      setError(err.message);
      setValidation(null);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!selectedNode || !draft) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await apiFetch(
        `/workspaces/${encodeURIComponent(workspaceId)}/tasks/${encodeURIComponent(selectedNode.id)}/dependencies`,
        { method: "PATCH", body: { dependsOn: draft } },
      );
      setMessage(
        "Dependencies saved. The server refused any cycle or cross-workspace link.",
      );
      setEdit(null);
      fetched.reload?.();
      await validate({ saved: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const addDependency = (fromId) => {
    if (!selectedNode || !draft) return;
    if (fromId === selectedNode.id) {
      setError("A task cannot depend on itself.");
      return;
    }
    if (draft.includes(fromId)) return;
    setDraft([...draft, fromId]);
    setMessage(
      `${byId.get(fromId)?.title ?? fromId} added as a dependency. Nothing is written until you save.`,
    );
  };

  if (fetched.error)
    return (
      <EmptyState
        title="The dependency graph is unavailable"
        error={fetched.error}
        missingRoutes={["GET /api/workspaces/:id/graph"]}
      />
    );
  if (!layout) return <p className="as-muted">Loading dependency graph…</p>;
  if (nodes.length === 0)
    return (
      <EmptyState
        icon={<GitBranch size={28} />}
        title="No tasks to graph"
        description="Add tasks with dependencies, or instantiate a workflow template, to see the order of work."
      />
    );

  const dirty =
    selectedNode &&
    draft &&
    JSON.stringify(draft) !== JSON.stringify(selectedNode.dependsOn ?? []);

  return (
    <section className="as-depmap" aria-label="Dependency map">
      {/* The page header names the view; this line says what is drawn. */}
      <p className="dep-summary">
        <GitBranch size={15} aria-hidden="true" />
        <strong>
          {layout.nodes.length} task{layout.nodes.length === 1 ? "" : "s"} ·{" "}
          {layout.edges.length} link{layout.edges.length === 1 ? "" : "s"}
        </strong>
        <span className="as-muted">Arrows point to the task that waits.</span>
      </p>
      <FilterChips label="Filters shared with every view" />

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

      {visibleNodes.length === 0 ? (
        <EmptyState
          compact
          title="Every task is filtered out"
          description="Clear a filter chip to see the graph again."
          actions={[
            {
              label: "Clear filters",
              onClick: () => selection.clearFilters?.(),
            },
          ]}
        />
      ) : (
        <div className="as-depmap-scroll">
          <svg
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            width={layout.width}
            height={layout.height}
            role="group"
            aria-label="Task dependency graph"
          >
            <defs>
              <marker
                id="as-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="8"
                markerHeight="8"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L10,5 L0,10 z" className="as-dep-arrow" />
              </marker>
            </defs>
            {layout.edges.map((edge, index) => {
              const a = layout.place(edge.from);
              const b = layout.place(edge.to);
              const x1 = a.x + NODE_W;
              const y1 = a.y + NODE_H / 2;
              const x2 = b.x;
              const y2 = b.y + NODE_H / 2;
              const mx = (x1 + x2) / 2;
              return (
                <path
                  key={`${edge.from}-${edge.to}-${index}`}
                  d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                  className="as-dep-edge"
                  markerEnd="url(#as-arrow)"
                />
              );
            })}
            {layout.nodes.map((node) => {
              const point = layout.place(node.id);
              const status = node.status ?? "QUEUE";
              const isLinkSource = linkFrom === node.id;
              return (
                <g
                  key={node.id}
                  transform={`translate(${point.x},${point.y})`}
                  className={`as-dep-node as-dep-${String(status).toLowerCase()} ${activeId === node.id ? "selected" : ""} ${isLinkSource ? "linking" : ""}`}
                  tabIndex={0}
                  role="button"
                  aria-label={`${node.title ?? node.id}, ${STATUS_TEXT[status] ?? status}${
                    linkFrom
                      ? ". Press L to make it a dependency of the selected task"
                      : ""
                  }`}
                  onClick={() => {
                    if (linkFrom && linkFrom !== node.id) {
                      addDependency(node.id);
                      setLinkFrom(null);
                    } else pick(node.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      pick(node.id);
                    } else if (
                      editable &&
                      event.key.toLowerCase() === "l" &&
                      selectedNode &&
                      node.id !== selectedNode.id
                    ) {
                      event.preventDefault();
                      addDependency(node.id);
                    }
                  }}
                >
                  <title>{node.title ?? node.id}</title>
                  <rect width={NODE_W} height={NODE_H} rx={8} />
                  <text x={10} y={18} className="as-dep-title">
                    {String(node.title ?? node.id).length > 24
                      ? `${String(node.title ?? node.id).slice(0, 23)}…`
                      : String(node.title ?? node.id)}
                  </text>
                  <text x={10} y={35} className="as-dep-status">
                    {STATUS_TEXT[status] ?? status}
                    {node.provider ? ` · ${providerLabel(node.provider)}` : ""}
                    {node.ready ? " · can start" : ""}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}

      {editable ? (
        <div className="as-depeditor">
          <h2>
            <Link2 size={13} aria-hidden="true" /> What this task waits for
          </h2>
          {!selectedNode ? (
            <p className="as-muted as-small">
              Select a task in the graph (click it, or Tab to it and press
              Enter) to edit what it waits for.
            </p>
          ) : (
            <>
              <p className="as-muted as-small">
                Editing <strong>{selectedNode.title ?? selectedNode.id}</strong>
                . Add a dependency by pressing <kbd>L</kbd> on another task in
                the graph, or pick one from the list below. Reorder with the
                arrow buttons. Nothing is written until you save, and the server
                refuses a cycle even if the editor missed it.
              </p>
              <ol
                className="as-depeditor-list"
                aria-label="Dependencies, in order"
              >
                {(draft ?? []).length === 0 ? (
                  <li className="as-muted as-small">
                    This task waits for nothing.
                  </li>
                ) : null}
                {(draft ?? []).map((id, index) => (
                  <li key={id}>
                    <span>{byId.get(id)?.title ?? id}</span>
                    <span className="as-tag">
                      {STATUS_TEXT[byId.get(id)?.status] ??
                        byId.get(id)?.status ??
                        "not in this workspace"}
                    </span>
                    <span
                      className="as-row"
                      role="group"
                      aria-label={`Reorder ${byId.get(id)?.title ?? id}`}
                    >
                      <button
                        type="button"
                        className="icon-button"
                        disabled={index === 0}
                        aria-label={`Move ${byId.get(id)?.title ?? id} earlier`}
                        onClick={() => setDraft(moveInList(draft, id, -1))}
                      >
                        <ArrowUp size={12} />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        disabled={index === (draft ?? []).length - 1}
                        aria-label={`Move ${byId.get(id)?.title ?? id} later`}
                        onClick={() => setDraft(moveInList(draft, id, 1))}
                      >
                        <ArrowDown size={12} />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Remove the dependency on ${byId.get(id)?.title ?? id}`}
                        onClick={() =>
                          setDraft(
                            (draft ?? []).filter((entry) => entry !== id),
                          )
                        }
                      >
                        <Unlink size={12} />
                      </button>
                    </span>
                  </li>
                ))}
              </ol>

              <label className="as-inline-label">
                Add a dependency
                <select
                  aria-label="Add a dependency"
                  value=""
                  onChange={(event) => {
                    if (event.target.value) addDependency(event.target.value);
                  }}
                >
                  <option value="">Choose a task…</option>
                  {nodes
                    .filter(
                      (node) =>
                        node.id !== selectedNode.id &&
                        !(draft ?? []).includes(node.id),
                    )
                    .map((node) => (
                      <option key={node.id} value={node.id}>
                        {node.title ?? node.id}
                      </option>
                    ))}
                </select>
              </label>

              <div className="as-row as-wrap">
                <button
                  type="button"
                  className="button"
                  onClick={() =>
                    setLinkFrom((current) => (current ? null : selectedNode.id))
                  }
                  aria-pressed={Boolean(linkFrom)}
                >
                  <Link2 size={12} />{" "}
                  {linkFrom ? "Cancel link mode" : "Link from the graph"}
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => validate()}
                  disabled={busy}
                  title={
                    dirty
                      ? "Checks the graph with your unsaved changes. Nothing is written."
                      : "Checks the saved graph."
                  }
                >
                  <ShieldCheck size={12} aria-hidden="true" />{" "}
                  {dirty ? "Check these changes" : "Validate"}
                </button>
                <button
                  type="button"
                  className="button primary"
                  onClick={save}
                  disabled={busy || !dirty}
                >
                  <Save size={12} /> Save dependencies
                </button>
                {dirty ? (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setEdit(null)}
                  >
                    Discard changes
                  </button>
                ) : null}
              </div>
            </>
          )}

          {validation ? (
            <div
              className={`as-verdict as-verdict-${validation.ok ? "allow" : "deny"}`}
              role="status"
            >
              <strong>{validation.ok ? "VALID" : "PROBLEMS FOUND"}</strong>
              <span>
                {validation.scope === "draft"
                  ? "Your unsaved changes, checked without writing"
                  : "The saved graph"}{" "}
                · {validation.checked} task(s) checked ·{" "}
                {(validation.problems ?? []).length} problem(s)
              </span>
              {validation.scope === "saved-only" ? (
                <span className="as-small">
                  This server can only check the saved graph, so your unsaved
                  changes were not checked. Restart it to check changes before
                  saving; saving still refuses a cycle.
                </span>
              ) : null}
              {(validation.problems ?? []).length ? (
                <ul className="as-validation-list">
                  {validation.problems.map((problem, index) => (
                    <li key={`${problem.code}-${problem.taskId}-${index}`}>
                      <span className="as-tag as-tag-warn">
                        {PROBLEM_TEXT[problem.code] ?? problem.code}
                      </span>
                      <span>
                        {problem.title ?? problem.taskId ?? "workflow"}
                      </span>
                      <span className="as-muted as-small">
                        {problem.detail}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
