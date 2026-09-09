import { useEffect, useState } from "react";

export const DEFAULT_WORKSPACE = "demo";

export async function api(path, method = "POST", data = {}) {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error ?? "Request failed. Try again.");
  return result;
}

/**
 * Subscribes to one workspace's snapshot stream. Switching the id reconnects
 * to the new workspace and clears the previous snapshot, so views never show
 * another workspace's tasks while the new one loads.
 */
export function useWorkspace(workspaceId = DEFAULT_WORKSPACE) {
  const [workspace, setWorkspace] = useState(null);
  const [connected, setConnected] = useState(false);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let stopped = false,
      socket,
      retry,
      attempts = 0;
    setWorkspace(null);
    setMissing(false);
    const connect = () => {
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws?workspace=${encodeURIComponent(workspaceId)}`,
      );
      socket.onopen = () => {
        attempts = 0;
        if (!stopped) setConnected(true);
      };
      socket.onmessage = ({ data }) => {
        try {
          const message = JSON.parse(data);
          if (!stopped && message.event === "workspace:snapshot")
            setWorkspace(message.payload);
        } catch {
          /* Ignore malformed events. */
        }
      };
      socket.onclose = () => {
        if (stopped) return;
        setConnected(false);
        // The server refuses the upgrade for unknown workspaces. After a few
        // immediate failures, report it so the app can fall back to the demo.
        if (attempts >= 2) {
          fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}`)
            .then((r) => {
              if (r.status === 404 && !stopped) setMissing(true);
            })
            .catch(() => {});
        }
        retry = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 10000));
      };
      socket.onerror = () => socket.close();
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, [workspaceId]);
  return { workspace, connected, missing };
}
