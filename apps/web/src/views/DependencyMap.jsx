import React, { useMemo } from "react";
import { GitBranch } from "lucide-react";
import { useApi, layerGraph } from "../hooks/useApi.js";

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

/**
 * SVG dependency DAG from GET /api/workspaces/:id/graph ({ nodes, edges }).
 * Layered left-to-right; each node shows its status as text, never colour alone.
 * @param {{ workspaceId: string, onSelectTask?: (taskId: string) => void, graph?: { nodes: any[], edges: any[] }, selectedId?: string|null }} props
 */
export default function DependencyMap({
  workspaceId,
  onSelectTask,
  graph: givenGraph,
  selectedId = null,
}) {
  const fetched = useApi(
    givenGraph ? null : `/workspaces/${encodeURIComponent(workspaceId)}/graph`,
    { interval: 5000 },
  );
  const graph = givenGraph ?? fetched.data ?? null;
  const layout = useMemo(() => {
    if (!graph) return null;
    const nodes = graph.nodes ?? [];
    const edges = (graph.edges ?? []).map((e) => ({
      from: e.from ?? e.source,
      to: e.to ?? e.target,
    }));
    const { layers, position } = layerGraph(nodes, edges);
    const tallest = Math.max(1, ...layers.map((l) => l.length));
    const width = Math.max(1, layers.length) * (NODE_W + GAP_X) + 20;
    const height = tallest * (NODE_H + GAP_Y) + 20;
    const place = (id) => {
      const p = position.get(id);
      const layerHeight = layers[p.layer].length * (NODE_H + GAP_Y);
      return {
        x: 10 + p.layer * (NODE_W + GAP_X),
        y: 10 + (height - 20 - layerHeight) / 2 + p.index * (NODE_H + GAP_Y),
      };
    };
    return {
      nodes,
      edges: edges.filter((e) => position.has(e.from) && position.has(e.to)),
      place,
      width,
      height,
    };
  }, [graph]);

  if (fetched.error)
    return (
      <div className="form-error" role="alert">
        {fetched.error.message}
      </div>
    );
  if (!layout) return <p className="as-muted">Loading dependency graph…</p>;
  if (layout.nodes.length === 0)
    return (
      <div className="empty-state">
        <GitBranch size={28} aria-hidden="true" />
        <h3>No tasks yet</h3>
        <p>Add tasks with dependencies to see the graph.</p>
      </div>
    );
  return (
    <section className="as-depmap" aria-label="Dependency map">
      <header className="as-section-head">
        <h3>
          <GitBranch size={14} aria-hidden="true" /> Dependencies
        </h3>
        <span className="as-muted">
          {layout.nodes.length} tasks · {layout.edges.length} links · arrows
          point to the task that waits
        </span>
      </header>
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
          {layout.edges.map((edge, i) => {
            const a = layout.place(edge.from);
            const b = layout.place(edge.to);
            const x1 = a.x + NODE_W,
              y1 = a.y + NODE_H / 2,
              x2 = b.x,
              y2 = b.y + NODE_H / 2;
            const mx = (x1 + x2) / 2;
            return (
              <path
                key={i}
                d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                className="as-dep-edge"
                markerEnd="url(#as-arrow)"
              />
            );
          })}
          {layout.nodes.map((node) => {
            const p = layout.place(node.id);
            const status = node.status ?? "QUEUE";
            return (
              <g
                key={node.id}
                transform={`translate(${p.x},${p.y})`}
                className={`as-dep-node as-dep-${String(status).toLowerCase()} ${selectedId === node.id ? "selected" : ""}`}
                tabIndex={0}
                role="button"
                aria-label={`${node.title ?? node.id}, ${STATUS_TEXT[status] ?? status}`}
                onClick={() => onSelectTask?.(node.id)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    onSelectTask?.(node.id);
                  }
                }}
              >
                <rect width={NODE_W} height={NODE_H} rx={8} />
                <text x={10} y={18} className="as-dep-title">
                  {String(node.title ?? node.id).slice(0, 24)}
                </text>
                <text x={10} y={35} className="as-dep-status">
                  {STATUS_TEXT[status] ?? status}
                  {node.provider ? ` · ${node.provider}` : ""}
                  {node.ready ? " · ready" : ""}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}
