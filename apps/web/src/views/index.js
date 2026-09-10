/**
 * Full-page views. Styles come from components/index.js (styles/components.css).
 *
 * All four views read the same records and share selection and filters through
 * `SelectionProvider` (apps/web/src/components/SelectionProvider.jsx). Wrap
 * them in one provider so a task selected on the Board is the task selected in
 * the Office, on the Timeline, and on the Dependency Map.
 */
import "../styles/components.css";

export { default as BoardView, BOARD_COLUMNS } from "./BoardView.jsx";
export { VIRTUALIZE_ABOVE } from "./BoardView.jsx";
export { default as TimelineView } from "./TimelineView.jsx";
export { default as DependencyMap, moveInList } from "./DependencyMap.jsx";
export {
  default as AnalyticsView,
  normalizeHeatmap,
} from "./AnalyticsView.jsx";
