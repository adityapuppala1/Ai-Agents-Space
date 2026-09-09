import { useEffect, useRef, useState } from "react";
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
 * Subscribes to the global channel (`/ws?channel=global`) and returns the
 * latest `global:snapshot` payload. Reconnects with exponential backoff.
 * When a bearer token is stored (shared mode) it is sent as `?token=`.
 *
 * @returns {{ global: { workspaces:any[], liveSessions:any[], connections:any[], inbox:{counts:object}, settings:object }, connected:boolean, revision:number }}
 *   `revision` increments on every snapshot so consumers can refresh on change.
 */
export function useGlobal() {
  const [global, setGlobal] = useState(EMPTY_GLOBAL);
  const [connected, setConnected] = useState(false);
  const [revision, setRevision] = useState(0);
  const attempts = useRef(0);
  useEffect(() => {
    if (typeof WebSocket === "undefined") return undefined;
    let stopped = false;
    let socket = null;
    let retry = null;
    const connect = () => {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const token = readToken();
      const query = token ? `&token=${encodeURIComponent(token)}` : "";
      try {
        socket = new WebSocket(
          `${protocol}//${location.host}/ws?channel=global${query}`,
        );
      } catch {
        schedule();
        return;
      }
      socket.onopen = () => {
        attempts.current = 0;
        if (!stopped) setConnected(true);
      };
      socket.onmessage = ({ data }) => {
        try {
          const message = JSON.parse(data);
          if (!stopped && message.event === "global:snapshot") {
            setGlobal(normalize(message.payload));
            setRevision((value) => value + 1);
          }
        } catch {
          /* Ignore malformed frames. */
        }
      };
      socket.onclose = () => {
        if (stopped) return;
        setConnected(false);
        schedule();
      };
      socket.onerror = () => socket?.close();
    };
    const schedule = () => {
      retry = setTimeout(
        connect,
        Math.min(1000 * 2 ** attempts.current++, 15000),
      );
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, []);
  return { global, connected, revision };
}

export default useGlobal;
