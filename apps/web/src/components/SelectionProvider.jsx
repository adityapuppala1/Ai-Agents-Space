import {
  DEFAULT_FILTERS,
  EMPTY_SELECTION,
  describeFilters,
  filtersAreEmpty,
  normalizeFilters,
  taskMatchesFilters,
  runMatchesFilters,
  agentMatchesFilters,
} from "../hooks/viewLogic.js";
import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

/**
 * Shared selection and filter state for the Office, Board, Timeline and
 * Dependency Map. All four are alternative views of the same records, so
 * selecting a task in one must select it in the others and a filter set in one
 * must narrow the others.
 *
 * Nothing here talks to the server: it only holds ids the caller already has.
 */

/*
 * The filter shape, the matcher predicates and the chip labels live in
 * ../hooks/viewLogic.js so `node --test` can import them without a JSX build.
 * They are re-exported here so callers can keep importing this module.
 */
export {
  DEFAULT_FILTERS,
  EMPTY_SELECTION,
  describeFilters,
  filtersAreEmpty,
  taskMatchesFilters,
  runMatchesFilters,
  agentMatchesFilters,
};

const SelectionContext = createContext(null);

/**
 * Provider. Uncontrolled by default; pass `value` + `onChange` to drive it
 * from the host application (App.jsx) instead.
 *
 * @param {{
 *   children: React.ReactNode,
 *   initial?: Partial<typeof EMPTY_SELECTION>,
 *   value?: typeof EMPTY_SELECTION|null,
 *   onChange?: (next: typeof EMPTY_SELECTION) => void
 * }} props
 */
export function SelectionProvider({
  children,
  initial,
  value = null,
  onChange,
}) {
  const [internal, setInternal] = useState(() => ({
    ...EMPTY_SELECTION,
    ...(initial ?? {}),
    filters: normalizeFilters(initial?.filters),
  }));
  const state = value
    ? { ...EMPTY_SELECTION, ...value, filters: normalizeFilters(value.filters) }
    : internal;

  const apply = useCallback(
    (patch) => {
      const next = {
        ...state,
        ...patch,
        filters: normalizeFilters(patch.filters ?? state.filters),
      };
      if (!value) setInternal(next);
      onChange?.(next);
    },
    [state, value, onChange],
  );

  const api = useMemo(
    () => ({
      ...state,
      /** Selecting a task clears a run selection that belonged to another task. */
      selectTask: (taskId, { runId = null, agentId } = {}) =>
        apply({
          selectedTaskId: taskId ?? null,
          selectedRunId: runId,
          selectedAgentId:
            agentId === undefined ? state.selectedAgentId : (agentId ?? null),
        }),
      selectRun: (runId, { taskId, agentId } = {}) =>
        apply({
          selectedRunId: runId ?? null,
          selectedTaskId:
            taskId === undefined ? state.selectedTaskId : (taskId ?? null),
          selectedAgentId:
            agentId === undefined ? state.selectedAgentId : (agentId ?? null),
        }),
      selectAgent: (agentId, { taskId, runId } = {}) =>
        apply({
          selectedAgentId: agentId ?? null,
          selectedTaskId:
            taskId === undefined ? state.selectedTaskId : (taskId ?? null),
          selectedRunId:
            runId === undefined ? state.selectedRunId : (runId ?? null),
        }),
      clearSelection: () =>
        apply({
          selectedTaskId: null,
          selectedRunId: null,
          selectedAgentId: null,
        }),
      setFilters: (filters) => apply({ filters: normalizeFilters(filters) }),
      setFilter: (key, filterValue) =>
        apply({ filters: { ...state.filters, [key]: filterValue ?? null } }),
      toggleFilter: (key, filterValue) =>
        apply({
          filters: {
            ...state.filters,
            [key]: state.filters[key] === filterValue ? null : filterValue,
          },
        }),
      clearFilters: () => apply({ filters: DEFAULT_FILTERS }),
      matchesTask: (task) => taskMatchesFilters(task, state.filters),
      matchesRun: (run) => runMatchesFilters(run, state.filters),
      matchesAgent: (agent) => agentMatchesFilters(agent, state.filters),
    }),
    [state, apply],
  );

  return (
    <SelectionContext.Provider value={api}>
      {children}
    </SelectionContext.Provider>
  );
}

/**
 * Reads the shared selection. Safe outside a provider: it then falls back to
 * a local, component-scoped selection so a view can be rendered standalone
 * (and in tests) without crashing.
 */
export function useSelection() {
  const shared = useContext(SelectionContext);
  const [fallback, setFallback] = useState(EMPTY_SELECTION);
  const local = useMemo(
    () => ({
      ...fallback,
      selectTask: (taskId) =>
        setFallback((s) => ({ ...s, selectedTaskId: taskId ?? null })),
      selectRun: (runId) =>
        setFallback((s) => ({ ...s, selectedRunId: runId ?? null })),
      selectAgent: (agentId) =>
        setFallback((s) => ({ ...s, selectedAgentId: agentId ?? null })),
      clearSelection: () =>
        setFallback((s) => ({
          ...s,
          selectedTaskId: null,
          selectedRunId: null,
          selectedAgentId: null,
        })),
      setFilters: (filters) =>
        setFallback((s) => ({ ...s, filters: normalizeFilters(filters) })),
      setFilter: (key, filterValue) =>
        setFallback((s) => ({
          ...s,
          filters: { ...s.filters, [key]: filterValue ?? null },
        })),
      toggleFilter: (key, filterValue) =>
        setFallback((s) => ({
          ...s,
          filters: {
            ...s.filters,
            [key]: s.filters[key] === filterValue ? null : filterValue,
          },
        })),
      clearFilters: () =>
        setFallback((s) => ({ ...s, filters: DEFAULT_FILTERS })),
      matchesTask: (task) => taskMatchesFilters(task, fallback.filters),
      matchesRun: (run) => runMatchesFilters(run, fallback.filters),
      matchesAgent: (agent) => agentMatchesFilters(agent, fallback.filters),
    }),
    [fallback],
  );
  return shared ?? local;
}

/**
 * Filter chips bar. Shows every active filter with a keyboard-reachable
 * remove button and a "Clear all" action.
 * @param {{ label?: string }} props
 */
export function FilterChips({ label = "Active filters" }) {
  const selection = useSelection();
  const chips = describeFilters(selection.filters);
  if (chips.length === 0) return null;
  return (
    <div
      className="as-row as-wrap as-filter-chips"
      role="group"
      aria-label={label}
    >
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          className="as-chip active"
          onClick={() => selection.setFilter(chip.key, null)}
          aria-label={`Remove filter ${chip.label}`}
        >
          {chip.label} <span aria-hidden="true">×</span>
        </button>
      ))}
      <button
        type="button"
        className="text-button"
        onClick={() => selection.clearFilters()}
      >
        Clear all
      </button>
    </div>
  );
}

export default SelectionProvider;
