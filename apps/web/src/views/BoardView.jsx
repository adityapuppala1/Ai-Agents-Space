import React, { useMemo } from "react";
import { ChevronLeft, ChevronRight, GitBranch } from "lucide-react";
import ProviderBadge from "../components/ProviderBadge.jsx";
import { maskText } from "../hooks/useApi.js";
import EmptyState from "../components/EmptyState.jsx";
import VirtualList from "../components/VirtualList.jsx";
import { useSelection, FilterChips } from "../components/SelectionProvider.jsx";

export const BOARD_COLUMNS = [
  { id: "QUEUE", label: "Queued" },
  { id: "IN_PROGRESS", label: "In progress" },
  { id: "BLOCKED", label: "Blocked" },
  { id: "COMPLETED", label: "Completed" },
];

const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

/** Columns longer than this are windowed instead of rendered whole. */
export const VIRTUALIZE_ABOVE = 30;
const CARD_HEIGHT = 118;

/**
 * Kanban board without drag-and-drop for moves: every card has
 * keyboard-accessible move buttons. Moves call `onMove(task, nextStatus)`;
 * the server validates the transition.
 *
 * Selection and filters are shared with the Office, Timeline and Dependency
 * Map through SelectionProvider: selecting a card here selects it everywhere,
 * and clicking a provider badge toggles the shared provider filter so all four
 * views narrow together. Without a provider the component still works, using a
 * local selection.
 *
 * @param {{
 *   tasks: any[],
 *   agents?: any[],
 *   onSelectTask?: (task: any) => void,
 *   onMove?: (task: any, status: string) => void,
 *   selectedId?: string|null,     // overrides the shared selection when given
 *   columns?: Array<{ id: string, label: string }>,
 *   onCreateTask?: () => void,
 *   presentation?: boolean        // presenter mode: hide task text before recording
 * }} props
 */
export default function BoardView({
  tasks = [],
  agents = [],
  onSelectTask,
  onMove,
  selectedId = null,
  columns = BOARD_COLUMNS,
  onCreateTask,
  presentation = false,
}) {
  const selection = useSelection();
  const activeId = selectedId ?? selection.selectedTaskId;
  const agentById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );
  const visible = useMemo(
    () => tasks.filter((task) => selection.matchesTask(task)),
    [tasks, selection],
  );
  const grouped = useMemo(() => {
    const map = Object.fromEntries(columns.map((column) => [column.id, []]));
    for (const task of visible) (map[task.status] ??= []).push(task);
    for (const list of Object.values(map))
      list.sort(
        (a, b) =>
          (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
          (a.createdAt ?? 0) - (b.createdAt ?? 0),
      );
    return map;
  }, [visible, columns]);
  const titleOf = (id) => tasks.find((task) => task.id === id)?.title ?? id;

  const pick = (task) => {
    selection.selectTask?.(task.id, { agentId: task.assignedAgentId ?? null });
    onSelectTask?.(task);
  };

  const renderCard = (task, columnIndex) => {
    const previous = columns[columnIndex - 1];
    const next = columns[columnIndex + 1];
    const agent = task.assignedAgentId
      ? agentById.get(task.assignedAgentId)
      : null;
    const blockedBy = (task.dependsOn ?? []).filter(
      (id) => tasks.find((entry) => entry.id === id)?.status !== "COMPLETED",
    );
    return (
      <div className={`as-task ${activeId === task.id ? "selected" : ""}`}>
        <button
          type="button"
          className="as-task-main"
          onClick={() => pick(task)}
          aria-label={`Open task ${task.title}`}
          aria-pressed={activeId === task.id}
        >
          <span className="as-row as-wrap">
            <span className={`priority priority-${task.priority}`}>
              {task.priority}
            </span>
            {task.review?.status === "pending" ? (
              <span className="status status-in_progress">review</span>
            ) : null}
          </span>
          <strong>{maskText(task.title, presentation)}</strong>
          {task.deliverable ? (
            <span className="as-muted as-small">
              → {maskText(task.deliverable, presentation)}
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
            {typeof task.progress === "number" && task.status === "IN_PROGRESS"
              ? ` · ${task.progress}%`
              : ""}
          </span>
          {blockedBy.length ? (
            <span
              className="as-muted as-small as-row"
              title={blockedBy.map(titleOf).join(", ")}
            >
              <GitBranch size={11} aria-hidden="true" /> waits for{" "}
              {blockedBy.length} task{blockedBy.length > 1 ? "s" : ""}
            </span>
          ) : null}
        </button>
        <div className="as-task-side">
          {task.provider ? (
            <button
              type="button"
              className="as-provider-filter"
              onClick={() =>
                selection.toggleFilter?.("provider", task.provider)
              }
              aria-pressed={selection.filters?.provider === task.provider}
              aria-label={`Filter every view by ${task.provider}`}
              title="Filter all views by this provider"
            >
              <ProviderBadge provider={task.provider} size="small" />
            </button>
          ) : null}
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
                title={previous ? `Move to ${previous.label}` : undefined}
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
        </div>
      </div>
    );
  };

  const filtered = tasks.length !== visible.length;

  return (
    <div className="as-board-wrap">
      <FilterChips label="Filters shared with every view" />
      {filtered ? (
        <p className="as-muted as-small" role="status">
          Showing {visible.length} of {tasks.length} tasks. The same filter
          applies to the Office, Timeline and Dependency Map.
        </p>
      ) : null}
      {tasks.length === 0 ? (
        <EmptyState
          title="No tasks in this workspace"
          description="Create a task to give an agent something to do, or instantiate a workflow template."
          actions={
            onCreateTask
              ? [{ label: "New task", primary: true, onClick: onCreateTask }]
              : []
          }
        />
      ) : null}
      {tasks.length && visible.length === 0 ? (
        <EmptyState
          compact
          title="No task matches the current filters"
          description="Clear a filter chip above to see the rest."
          actions={[
            {
              label: "Clear filters",
              onClick: () => selection.clearFilters?.(),
            },
          ]}
        />
      ) : null}
      {visible.length ? (
        <div className="as-board" role="list" aria-label="Task board">
          {columns.map((column, columnIndex) => {
            const list = grouped[column.id] ?? [];
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
                {list.length === 0 ? (
                  <p className="as-muted as-empty-col">Empty</p>
                ) : list.length > VIRTUALIZE_ABOVE ? (
                  <VirtualList
                    items={list}
                    itemHeight={CARD_HEIGHT}
                    height={CARD_HEIGHT * 6}
                    label={`${column.label} tasks`}
                    className="as-column-list"
                    getKey={(task) => task.id}
                    renderItem={(task) => renderCard(task, columnIndex)}
                  />
                ) : (
                  <ul className="as-column-list">
                    {list.map((task) => (
                      <li key={task.id}>{renderCard(task, columnIndex)}</li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
