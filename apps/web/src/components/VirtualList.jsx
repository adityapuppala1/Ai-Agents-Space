import React, { useCallback, useEffect, useRef, useState } from "react";
import { windowRange } from "../hooks/viewLogic.js";

/**
 * Windowing helper with no dependencies. Renders only the rows that fall in
 * the scroll viewport plus an overscan margin, so a run with 20 000 events or
 * a workspace with 5 000 tasks stays responsive.
 *
 * Accessibility: the scroll container keeps the list semantics (role="list"
 * by default) and every rendered row carries `aria-setsize`/`aria-posinset`
 * so a screen reader still reports "item 412 of 20 000". The container is
 * focusable and Home/End/PageUp/PageDown scroll it.
 *
 * Rows must all be `itemHeight` tall — that is the price of not adding a
 * measuring library. Give variable-height content its own inner scroll or a
 * clamped height.
 */

/* `windowRange` is in ../hooks/viewLogic.js so node:test can cover it. */
export { windowRange };

/**
 * @param {{
 *   items: any[],
 *   itemHeight: number,
 *   height?: number,                       // viewport height in px (default 320)
 *   overscan?: number,
 *   renderItem: (item:any, index:number) => React.ReactNode,
 *   getKey?: (item:any, index:number) => string|number,
 *   label: string,                         // aria-label for the list
 *   role?: 'list'|'listbox'|'presentation',
 *   itemRole?: 'listitem'|'option',
 *   className?: string,
 *   empty?: React.ReactNode,               // rendered instead of the window when items is empty
 *   stickToBottom?: boolean                // follow new rows (live activity feeds)
 * }} props
 */
export default function VirtualList({
  items = [],
  itemHeight = 32,
  height = 320,
  overscan = 4,
  renderItem,
  getKey,
  label,
  role = "list",
  itemRole = "listitem",
  className = "",
  empty = null,
  stickToBottom = false,
}) {
  const ref = useRef(null);
  const pinned = useRef(true);
  const [scrollTop, setScrollTop] = useState(0);

  const onScroll = useCallback(
    (event) => {
      const node = event.currentTarget;
      setScrollTop(node.scrollTop);
      if (stickToBottom)
        pinned.current =
          node.scrollHeight - node.scrollTop - node.clientHeight < itemHeight;
    },
    [stickToBottom, itemHeight],
  );

  useEffect(() => {
    if (!stickToBottom || !pinned.current) return;
    const node = ref.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [items.length, stickToBottom]);

  const onKeyDown = (event) => {
    const node = ref.current;
    if (!node) return;
    const page = Math.max(itemHeight, height - itemHeight);
    if (event.key === "Home") node.scrollTop = 0;
    else if (event.key === "End") node.scrollTop = node.scrollHeight;
    else if (event.key === "PageDown") node.scrollTop += page;
    else if (event.key === "PageUp") node.scrollTop -= page;
    else return;
    event.preventDefault();
    setScrollTop(node.scrollTop);
  };

  if (items.length === 0 && empty) return <>{empty}</>;

  const { start, end, offsetY, totalHeight } = windowRange({
    count: items.length,
    itemHeight,
    height,
    scrollTop,
    overscan,
  });
  const slice = items.slice(start, end);

  return (
    <div
      ref={ref}
      className={`as-virtual ${className}`}
      style={{ height: `${height}px` }}
      onScroll={onScroll}
      onKeyDown={onKeyDown}
      tabIndex={0}
      role={role}
      aria-label={`${label} (${items.length} items, scrollable)`}
    >
      <div className="as-virtual-spacer" style={{ height: `${totalHeight}px` }}>
        <div
          className="as-virtual-window"
          style={{ transform: `translateY(${offsetY}px)` }}
        >
          {slice.map((item, offset) => {
            const index = start + offset;
            return (
              <div
                key={getKey ? getKey(item, index) : (item?.id ?? index)}
                className="as-virtual-row"
                style={{ height: `${itemHeight}px` }}
                role={itemRole}
                aria-setsize={items.length}
                aria-posinset={index + 1}
              >
                {renderItem(item, index)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
