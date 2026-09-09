import { useEffect, useState } from "react";

export const DEFAULT_WORKSPACE = "demo";
export const TOKEN_KEY = "agent-space-token";

export function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

export function saveToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

export class RequestError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "RequestError";
    this.status = status;
  }
}

/**
 * JSON request helper used by the legacy App forms. Sends the stored bearer
 * token (shared mode) and throws a RequestError carrying the HTTP status so
 * the app can prompt for a token on 401.
 */
export async function api(path, method = "POST", data = {}) {
  const headers = { Accept: "application/json" };
  const token = readToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const hasBody = method !== "GET" && method !== "HEAD";
  if (hasBody) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: hasBody ? JSON.stringify(data ?? {}) : undefined,
    });
  } catch {
    throw new RequestError(
      "Server unreachable. Check that Agent Space is running.",
      0,
    );
  }
  let result = null;
  const text = await response.text();
  if (text) {
    try {
      result = JSON.parse(text);
    } catch {
      result = { raw: text };
    }
  }
  if (!response.ok) {
    if (response.status === 401)
      window.dispatchEvent(new CustomEvent("agent-space:unauthorized"));
    throw new RequestError(
      result?.error ?? "Request failed. Try again.",
      response.status,
    );
  }
  return result;
}

/**
 * Subscribes to one workspace's snapshot stream. Switching the id reconnects
 * to the new workspace and clears the previous snapshot, so views never show
 * another workspace's tasks while the new one loads. `unauthorized` turns on
 * when the server rejects the connection with 401 (AGENT_SPACE_TOKEN mode).
 */
export function useWorkspace(workspaceId = DEFAULT_WORKSPACE) {
  const [workspace, setWorkspace] = useState(null);
  const [connected, setConnected] = useState(false);
  const [missing, setMissing] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);
  useEffect(() => {
    let stopped = false,
      socket,
      retry,
      attempts = 0;
    setWorkspace(null);
    setMissing(false);
    const connect = () => {
      const token = readToken();
      const query = token ? `&token=${encodeURIComponent(token)}` : "";
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws?workspace=${encodeURIComponent(workspaceId)}${query}`,
      );
      socket.onopen = () => {
        attempts = 0;
        if (!stopped) {
          setConnected(true);
          setUnauthorized(false);
        }
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
        // The server refuses the upgrade for unknown workspaces or missing
        // tokens. After a few immediate failures, ask the REST API why so the
        // app can fall back to the demo or prompt for a token.
        if (attempts >= 2) {
          const headers = {};
          const token = readToken();
          if (token) headers.Authorization = `Bearer ${token}`;
          fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
            headers,
          })
            .then((r) => {
              if (stopped) return;
              if (r.status === 404) setMissing(true);
              if (r.status === 401) setUnauthorized(true);
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
  return { workspace, connected, missing, unauthorized };
}
