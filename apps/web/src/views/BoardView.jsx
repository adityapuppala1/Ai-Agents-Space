import React, { useMemo } from "react";
import { ChevronLeft, ChevronRight, GitBranch } from "lucide-react";
import ProviderBadge from "../components/ProviderBadge.jsx";

export const BOARD_COLUMNS = [
  { id: "QUEUE", label: "Queued" },
  { id: "IN_PROGRESS", label: "In progress" },
  { id: "BLOCKED", label: "Blocked" },
  { id: "COMPLETED", label: "Completed" },
];

const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Kanban board without drag-and-drop: every card has keyboard-accessible
 * move buttons. Moves call `onMove(task, nextStatus)`; the server validates
 * the transition.
 * @param {{
 *   tasks: any[],
 *   agents?: any[],
 *   onSelectTask?: (task: any) => void,
 *   onMove?: (task: any, status: string) => void,
 *   selectedId?: string|null,
 *   columns?: Array<{ id: string, label: string }>
 * }} props
 */
export default function BoardView({
  tasks = [],
  agents = [],
  onSelectTask,
  onMove,
  selectedId = null,
  columns = BOARD_COLUMNS,
}) {
  const agentById = useMemo(
    () => new Map(agents.map((a) => [a.id, a])),
    [agents],
  );
  const grouped = useMemo(() => {
    const map = Object.fromEntries(columns.map((c) => [c.id, []]));
    for (const task of tasks) (map[task.status] ??= []).push(task);
    for (const list of Object.values(map))
      list.sort(
        (a, b) =>
          (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
          (a.createdAt ?? 0) - (b.createdAt ?? 0),
      );
    return map;
  }, [tasks, columns]);
  const titleOf = (id) => tasks.find((t) => t.id === id)?.title ?? id;
  return (
    <div className="as-board" role="list" aria-label="Task board">
      {columns.map((column, columnIndex) => {
        const list = grouped[column.id] ?? [];
        const previous = columns[columnIndex - 1];
        const next = columns[columnIndex + 1];
        return (
          <section
            key={column.id}
            className={`as-column as-column-${column.id.toLowerCase()}`}
            role="listitem"
            aria-label={`${column.label}, ${list.length} tasks`}
          >
            <header className="as-column-head">
              <h3>{column.label}</h3>
              <span className="as-count">{list.length}</span>
            </header>
            <ul className="as-column-list">
              {list.length === 0 ? (
                <li className="as-muted as-empty-col">Empty</li>
              ) : null}
              {list.map((task) => {
                const agent = task.assignedAgentId
                  ? agentById.get(task.assignedAgentId)
                  : null;
                const blockedBy = (task.dependsOn ?? []).filter(
                  (id) =>
                    tasks.find((t) => t.id === id)?.status !== "COMPLETED",
                );
                return (
                  <li
                    key={task.id}
                    className={`as-task ${selectedId === task.id ? "selected" : ""}`}
                  >
                    <button
                      type="button"
                      className="as-task-main"
                      onClick={() => onSelectTask?.(task)}
                      aria-label={`Open task ${task.title}`}
                    >
                      <span className="as-row as-wrap">
                        <span className={`priority priority-${task.priority}`}>
                          {task.priority}
                        </span>
                        {task.provider ? (
                          <ProviderBadge
                            provider={task.provider}
                            size="small"
                          />
                        ) : null}
                        {task.review?.status === "pending" ? (
                          <span className="status status-in_progress">
                            review
                          </span>
                        ) : null}
                      </span>
                      <strong>{task.title}</strong>
                      {task.deliverable ? (
                        <span className="as-muted as-small">
                          → {task.deliverable}
                        </span>
                      ) : null}
                      <span className="as-muted as-small">
                        {agent ? (
                          <>
                            <span
                              className="avatar small"
                              style={{ "--agent-color": agent.color }}
                            >
                              {agent.initials}
                            </span>{" "}
                            {agent.name}
                          </>
                        ) : (
                          "Unassigned"
                        )}
                        {typeof task.progress === "number" &&
                        task.status === "IN_PROGRESS"
                          ? ` · ${task.progress}%`
                          : ""}
                      </span>
                      {blockedBy.length ? (
                        <span
                          className="as-muted as-small as-row"
                          title={blockedBy.map(titleOf).join(", ")}
                        >
                          <GitBranch size={11} aria-hidden="true" /> waits for{" "}
                          {blockedBy.length} task
                          {blockedBy.length > 1 ? "s" : ""}
                        </span>
                      ) : null}
                    </button>
                    {onMove ? (
                      <div
                        className="as-task-moves"
                        role="group"
                        aria-label={`Move ${task.title}`}
                      >
                        <button
                          type="button"
                          className="icon-button"
                          disabled={!previous || task.status === "COMPLETED"}
                          aria-label={
                            previous
                              ? `Move ${task.title} to ${previous.label}`
                              : "No earlier column"
                          }
                          title={
                            previous ? `Move to ${previous.label}` : undefined
                          }
                          onClick={() => onMove(task, previous.id)}
                        >
                          <ChevronLeft size={14} />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          disabled={!next || task.status === "COMPLETED"}
                          aria-label={
                            next
                              ? `Move ${task.title} to ${next.label}`
                              : "No later column"
                          }
                          title={next ? `Move to ${next.label}` : undefined}
                          onClick={() => onMove(task, next.id)}
                        >
                          <ChevronRight size={14} />
                        </button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
