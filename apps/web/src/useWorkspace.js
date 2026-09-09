import { useEffect, useState } from "react";

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

export function useWorkspace() {
  const [workspace, setWorkspace] = useState(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let stopped = false,
      socket,
      retry,
      attempts = 0;
    const connect = () => {
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
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
  }, []);
  return { workspace, connected };
}
