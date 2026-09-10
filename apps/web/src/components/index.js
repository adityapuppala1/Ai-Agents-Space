/**
 * Self-contained web components for Agent Space. Importing this module also
 * loads the shared component stylesheet (class prefix `as-`).
 *
 * Every component documents its props in its own file. Nothing here reads or
 * writes App.jsx state directly: data arrives as props, from the REST routes
 * under /api, or from the global channel through `useGlobal()`.
 */
import "../styles/components.css";

/* Wave 1 */
export { default as RunInspector } from "./RunInspector.jsx";
export { default as DecisionInbox } from "./DecisionInbox.jsx";
export { orderByUrgency, urgencyRank } from "./DecisionInbox.jsx";
export { default as ConnectionsPanel } from "./ConnectionsPanel.jsx";
export { default as LiveSessions } from "./LiveSessions.jsx";
export { default as CommandPalette } from "./CommandPalette.jsx";
export { buildStandardCommands } from "./CommandPalette.jsx";
export { default as TaskLauncher } from "./TaskLauncher.jsx";
export { default as TemplateGallery } from "./TemplateGallery.jsx";
export { default as PolicyEditor } from "./PolicyEditor.jsx";
export { default as ContextManifestView } from "./ContextManifestView.jsx";
export { default as ProviderBadge } from "./ProviderBadge.jsx";
export { default as Provenance } from "./Provenance.jsx";
export { default as ActivityBadge } from "./ActivityBadge.jsx";
export { default as Dialog } from "./Dialog.jsx";
export { default as Tabs } from "./Tabs.jsx";

/* Wave 2: shared selection, navigation and primitives */
export {
  default as SelectionProvider,
  SelectionProvider as Selection,
  FilterChips,
  useSelection,
  DEFAULT_FILTERS,
  EMPTY_SELECTION,
  describeFilters,
  filtersAreEmpty,
  taskMatchesFilters,
  runMatchesFilters,
  agentMatchesFilters,
} from "./SelectionProvider.jsx";
export { default as EmptyState } from "./EmptyState.jsx";
export { default as VirtualList, windowRange } from "./VirtualList.jsx";
export { default as EventLink } from "./EventLink.jsx";
export { default as WorkspaceSwitcher } from "./WorkspaceSwitcher.jsx";
export {
  RECENT_WORKSPACES_KEY,
  runtimesForWorkspace,
} from "./WorkspaceSwitcher.jsx";
export { default as GlobalSearch, SEARCH_ROUTE } from "./GlobalSearch.jsx";
export {
  default as DragAssign,
  DRAG_TYPE,
  assignmentCompatibility,
} from "./DragAssign.jsx";
export {
  default as PinnedRuns,
  PinToggle,
  usePinnedRuns,
  readPinnedRuns,
  togglePinnedRun,
  PINNED_RUNS_KEY,
} from "./PinnedRuns.jsx";
export { default as DayInReview, buildChapter } from "./DayInReview.jsx";
export {
  default as Onboarding,
  SetupEntry,
  ONBOARDING_KEY,
  ONBOARDING_STEPS,
  SAMPLE_SCOPE,
} from "./Onboarding.jsx";

/* Wave 2: operations and collaboration */
export { default as OpsPanel } from "./OpsPanel.jsx";
export { default as MemoryPanel, MEMORY_SCOPES } from "./MemoryPanel.jsx";
export { default as KnowledgePanel } from "./KnowledgePanel.jsx";
export { default as HandoverBrief } from "./HandoverBrief.jsx";
export { default as RunLineage } from "./RunLineage.jsx";

/* Hooks */
export { useGlobal } from "../hooks/useGlobal.js";
export {
  useApi,
  apiFetch,
  ApiError,
  maskPath,
  maskText,
  maskAccount,
  maskArtifact,
} from "../hooks/useApi.js";
export {
  useLocalStorage,
  readLocal,
  writeLocal,
  pushRecent,
  toggleIn,
} from "../hooks/useLocalStorage.js";
