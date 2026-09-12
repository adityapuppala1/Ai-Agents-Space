import { useEffect, useRef, useSyncExternalStore } from "react";
import { readToken } from "./useApi.js";

export const EMPTY_GLOBAL = Object.freeze({
  workspaces: [],
  liveSessions: [],
  connections: [],
  inbox: { counts: {} },
  settings: {},
});

function normalize(payload) {
  if (!payload || typeof payload !== "object") return EMPTY_GLOBAL;
  return {
    ...EMPTY_GLOBAL,
    ...payload,
    workspaces: Array.isArray(payload.workspaces) ? payload.workspaces : [],
    liveSessions: Array.isArray(payload.liveSessions)
      ? payload.liveSessions
      : [],
    connections: Array.isArray(payload.connections) ? payload.connections : [],
    inbox: { counts: {}, ...(payload.inbox ?? {}) },
    settings: payload.settings ?? {},
  };
}

/**
 * One global channel per tab, shared by every component that reads it.
 * Before, each caller of useGlobal() opened its own socket (the app shell,
 * the workspace switcher and the open panel: at least three per tab), each
 * parsed every snapshot, and a panel opened later showed empty data until its
 * own socket had caught up.
 */
const INITIAL = Object.freeze({
  global: EMPTY_GLOBAL,
  connected: false,
  revision: 0,
});
const channel = {
  state: INITIAL,
  listeners: new Set(),
  socket: null,
  retry: null,
  closeTimer: null,
  attempts: 0,
};

function publish(patch) {
  channel.state = { ...channel.state, ...patch };
  for (const listener of channel.listeners) listener();
}

function schedule() {
  clearTimeout(channel.retry);
  const delay = Math.min(1000 * 2 ** channel.attempts++, 15000);
  channel.retry = setTimeout(() => {
    channel.retry = null;
    connect();
  }, delay);
}

function connect() {
  if (typeof WebSocket === "undefined" || typeof location === "undefined")
    return;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const token = readToken();
  const query = token ? `&token=${encodeURIComponent(token)}` : "";
  let socket;
  try {
    socket = new WebSocket(
      `${protocol}//${location.host}/ws?channel=global${query}`,
    );
  } catch {
    schedule();
    return;
  }
  channel.socket = socket;
  socket.onopen = () => {
    channel.attempts = 0;
    publish({ connected: true });
  };
  socket.onmessage = ({ data }) => {
    try {
      const message = JSON.parse(data);
      if (message.event === "global:snapshot")
        publish({
          global: normalize(message.payload),
          revision: channel.state.revision + 1,
        });
    } catch {
      /* Ignore malformed frames. */
    }
  };
  socket.onclose = () => {
    if (channel.socket !== socket) return; // replaced or shut down
    channel.socket = null;
    publish({ connected: false });
    if (channel.listeners.size) schedule();
  };
  socket.onerror = () => socket.close();
}

function subscribe(listener) {
  channel.listeners.add(listener);
  clearTimeout(channel.closeTimer);
  if (!channel.socket && !channel.retry) connect();
  return () => {
    channel.listeners.delete(listener);
    if (channel.listeners.size) return;
    // Linger briefly: a route change unmounts one reader just before it
    // mounts the next, and the socket should survive that.
    channel.closeTimer = setTimeout(() => {
      if (channel.listeners.size) return;
      clearTimeout(channel.retry);
      channel.retry = null;
      const socket = channel.socket;
      channel.socket = null;
      socket?.close();
      publish({ connected: false });
    }, 1000);
  };
}

const getSnapshot = () => channel.state;
const getServerSnapshot = () => INITIAL;

/**
 * The latest `global:snapshot` payload from `/ws?channel=global`, with the
 * connection state. Reconnects with exponential backoff. When a bearer token
 * is stored (shared mode) it is sent as `?token=`.
 *
 * @returns {{ global: { workspaces:any[], liveSessions:any[], connections:any[], inbox:{counts:object}, settings:object }, connected:boolean, revision:number }}
 *   `revision` increments on every snapshot (0 until the first arrives), so
 *   consumers can refresh on change and tell "not loaded" from "empty".
 */
export function useGlobal() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Calls `callback` for every global snapshot that arrives after the caller
 * mounted, never on mount itself (the caller's own fetch already ran). With a
 * shared channel the revision is usually above zero when a panel opens, so
 * "skip when revision is 0" would fetch twice.
 */
export function useGlobalChange(callback) {
  const { revision } = useGlobal();
  const seen = useRef(revision);
  const latest = useRef(callback);
  latest.current = callback;
  useEffect(() => {
    if (revision === seen.current) return;
    seen.current = revision;
    latest.current();
  }, [revision]);
}

export default useGlobal;
