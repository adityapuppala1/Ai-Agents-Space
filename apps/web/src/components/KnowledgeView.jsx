import React, { useRef } from "react";
import { BookOpen, Brain, NotebookPen } from "lucide-react";
import { useLocalStorage } from "../hooks/useLocalStorage.js";
import KnowledgePanel from "./KnowledgePanel.jsx";
import MemoryPanel from "./MemoryPanel.jsx";
import HandoverBrief from "./HandoverBrief.jsx";

const TABS = [
  {
    id: "collections",
    label: "Collections",
    icon: BookOpen,
    hint: "Documents and notes an agent can be given as context.",
  },
  {
    id: "memory",
    label: "Memory",
    icon: Brain,
    hint: "Short facts kept per workspace, per person or per run.",
  },
  {
    id: "handover",
    label: "Handover briefs",
    icon: NotebookPen,
    hint: "A brief assembled from records, edited before work changes hands.",
  },
];

/**
 * The Knowledge page: three separate stores behind tabs instead of one long
 * stack. Nothing here is scoped by a selection made on another page: Memory
 * chooses its run and Handover chooses its task or run on the page itself.
 * The chosen tab is remembered in this browser.
 *
 * @param {{ workspaceId: string, presentation?: boolean, tasks?: any[], runs?: any[] }} props
 */
export default function KnowledgeView({
  workspaceId,
  presentation = false,
  tasks = [],
  runs = [],
}) {
  const [stored, setTab] = useLocalStorage("agent-space-knowledge-tab", "");
  const tab = TABS.some((entry) => entry.id === stored)
    ? stored
    : "collections";
  const refs = useRef({});
  const current = TABS.find((entry) => entry.id === tab);

  // Arrow keys move between tabs (the ARIA tabs pattern); Home/End jump.
  const onKeyDown = (event) => {
    const index = TABS.findIndex((entry) => entry.id === tab);
    let next = null;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft")
      next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    if (next === null) return;
    event.preventDefault();
    setTab(TABS[next].id);
    refs.current[TABS[next].id]?.focus();
  };

  return (
    <div className="knowledge">
      <div
        className="knowledge-tabs"
        role="tablist"
        aria-label="Knowledge stores"
        onKeyDown={onKeyDown}
      >
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            ref={(node) => {
              refs.current[id] = node;
            }}
            type="button"
            role="tab"
            id={`knowledge-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`knowledge-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
          >
            <Icon size={14} aria-hidden="true" /> {label}
          </button>
        ))}
      </div>
      <p className="as-muted as-small knowledge-hint">{current.hint}</p>
      <div
        role="tabpanel"
        id={`knowledge-panel-${tab}`}
        aria-labelledby={`knowledge-tab-${tab}`}
        className="knowledge-panel"
      >
        {tab === "collections" ? (
          <KnowledgePanel
            workspaceId={workspaceId}
            presentation={presentation}
          />
        ) : null}
        {tab === "memory" ? (
          <MemoryPanel workspaceId={workspaceId} runs={runs} />
        ) : null}
        {tab === "handover" ? (
          <HandoverBrief workspaceId={workspaceId} tasks={tasks} runs={runs} />
        ) : null}
      </div>
    </div>
  );
}
