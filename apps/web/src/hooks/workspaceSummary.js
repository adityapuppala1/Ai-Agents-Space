import { providerLabel } from "./useApi.js";

/** Connections that may be used by a workspace, per `allowedWorkspaces`. */
export function runtimesForWorkspace(connections = [], workspaceId) {
  return connections.filter((connection) => {
    if (connection.enabled === false) return false;
    const allowed = connection.allowedWorkspaces;
    if (!Array.isArray(allowed) || allowed.length === 0) return true;
    return allowed.includes(workspaceId);
  });
}

/**
 * The runtime line for one workspace in the switcher, or null when it would
 * say nothing new. Detection status is global (the top bar shows it), so it
 * is not repeated per workspace; the line appears only when some connection
 * is limited to certain workspaces, and then names what this one may launch.
 */
export function workspaceRuntimeNote(connections = [], workspaceId) {
  const installed = connections.filter(
    (connection) => connection.status !== "missing",
  );
  const scoped = installed.some(
    (connection) =>
      Array.isArray(connection.allowedWorkspaces) &&
      connection.allowedWorkspaces.length > 0,
  );
  if (!scoped) return null;
  const names = [
    ...new Set(
      runtimesForWorkspace(installed, workspaceId).map((connection) =>
        providerLabel(connection.provider),
      ),
    ),
  ];
  return names.length
    ? `Can launch: ${names.join(", ")}`
    : "No runtime is allowed here";
}

/**
 * The one thing worth saying about a workspace you are not currently in,
 * or null when there is nothing going on.
 *
 * A switcher row is scanned, not read: four facts per row is a list you have
 * to parse, one is a list you can skim. Attention outranks running because
 * it is the only one that needs you; an idle workspace says nothing at all
 * rather than "0 running", which is noise pretending to be information.
 */
export function workspaceSignal(workspace = {}) {
  const attention = workspace.attention ?? 0;
  if (attention)
    return {
      text: `${attention} attention`,
      tone: "attention",
      label: `${attention} need${attention === 1 ? "s" : ""} attention`,
    };
  const running = workspace.activeRuns ?? 0;
  if (running)
    return {
      text: `${running} running`,
      tone: "running",
      label: `${running} running`,
    };
  return null;
}

/** "3 agents · 2 running · 1 needs attention", zero counts left out. */
export function workspaceStats(workspace = {}) {
  const parts = [];
  const agents = workspace.agents ?? 0;
  const running = workspace.activeRuns ?? 0;
  const attention = workspace.attention ?? 0;
  if (agents) parts.push(`${agents} agent${agents === 1 ? "" : "s"}`);
  if (running) parts.push(`${running} running`);
  if (attention)
    parts.push(`${attention} need${attention === 1 ? "s" : ""} attention`);
  return parts.length ? parts.join(" · ") : "No agents yet";
}
