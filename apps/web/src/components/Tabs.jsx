import React, { useId, useRef } from "react";

/**
 * Accessible tab strip (role=tablist/tab/tabpanel, arrow-key navigation).
 * @param {{
 *   tabs: Array<{ id: string, label: string, badge?: string|number|null, icon?: React.ReactNode }>,
 *   value: string,
 *   onChange: (id: string) => void,
 *   label: string,
 *   children: React.ReactNode  // content of the active panel
 * }} props
 */
export default function Tabs({ tabs, value, onChange, label, children }) {
  const base = useId();
  const refs = useRef([]);
  const onKeyDown = (event, index) => {
    let next = null;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft")
      next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    onChange(tabs[next].id);
    refs.current[next]?.focus();
  };
  const active = tabs.find((tab) => tab.id === value) ?? tabs[0];
  return (
    <div className="as-tabs">
      <div className="as-tablist" role="tablist" aria-label={label}>
        {tabs.map((tab, index) => {
          const selected = tab.id === active?.id;
          return (
            <button
              key={tab.id}
              ref={(node) => {
                refs.current[index] = node;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${base}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              className={`as-tab ${selected ? "active" : ""}`}
              onClick={() => onChange(tab.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {tab.icon}
              <span>{tab.label}</span>
              {tab.badge !== undefined && tab.badge !== null ? (
                <span className="as-tab-badge">{tab.badge}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`${base}-panel-${active?.id}`}
        aria-labelledby={`${base}-tab-${active?.id}`}
        className="as-tabpanel"
        tabIndex={0}
      >
        {children}
      </div>
    </div>
  );
}
