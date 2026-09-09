import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Search, CornerDownLeft } from "lucide-react";
import { fuzzyFilter } from "../hooks/useApi.js";

/**
 * Ctrl/Cmd+K command palette with fuzzy filtering and keyboard navigation.
 * The caller owns the `open` state; this component only registers the
 * shortcut when `bindShortcut` is true (default) and calls `onOpen`.
 *
 * @param {{
 *   open: boolean,
 *   onClose: () => void,
 *   onOpen?: () => void,
 *   commands: Array<{ id: string, label: string, hint?: string, group?: string, keywords?: string, run: () => void }>,
 *   bindShortcut?: boolean
 * }} props
 */
export default function CommandPalette({
  open,
  onClose,
  onOpen,
  commands = [],
  bindShortcut = true,
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const id = useId();

  useEffect(() => {
    if (!bindShortcut) return undefined;
    const handler = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (open) onClose();
        else onOpen?.();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose, onOpen, bindShortcut]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const results = useMemo(
    () =>
      fuzzyFilter(
        query,
        commands,
        (c) =>
          `${c.group ?? ""} ${c.label} ${c.hint ?? ""} ${c.keywords ?? ""}`,
      ).slice(0, 40),
    [query, commands],
  );
  useEffect(() => setIndex(0), [results.length, query]);
  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [index]);

  if (!open) return null;
  const run = (command) => {
    onClose();
    command?.run?.();
  };
  const onKeyDown = (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (results[index]) run(results[index]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };
  const activeId = results[index]
    ? `${id}-opt-${results[index].id}`
    : undefined;
  return (
    <div
      className="as-palette-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="as-palette panel"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
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
            aria-label="Search commands"
            placeholder="Type a command, view, workspace or task…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd>Esc</kbd>
        </div>
        <ul
          className="as-palette-list"
          role="listbox"
          id={`${id}-list`}
          ref={listRef}
        >
          {results.length === 0 ? (
            <li className="as-muted as-palette-empty">No matching commands.</li>
          ) : null}
          {results.map((command, i) => (
            <li
              key={command.id}
              id={`${id}-opt-${command.id}`}
              role="option"
              aria-selected={i === index}
              className={`as-palette-item ${i === index ? "active" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run(command)}
            >
              {command.group ? (
                <span className="as-palette-group">{command.group}</span>
              ) : null}
              <span className="as-palette-label">{command.label}</span>
              {command.hint ? (
                <span className="as-muted">{command.hint}</span>
              ) : null}
              {i === index ? (
                <CornerDownLeft size={12} aria-hidden="true" />
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
