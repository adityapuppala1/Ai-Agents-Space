// Who stands on the office floor. Kept apart from the rest of office/* so the
// application shell can count the same agents the scene draws without pulling
// the office vocabulary into the main bundle. No imports, no DOM, no three.

/** Activity ids from docs/ARCHITECTURE.md §6 (labels live in data.js). */
export const ACTIVITY_IDS = Object.freeze([
  "IDLE",
  "ANALYZING",
  "CODING",
  "RESEARCHING",
  "TESTING",
  "DEBUGGING",
  "REVIEWING",
  "COMMANDING",
  "MESSAGING",
  "DELEGATING",
  "WAITING_APPROVAL",
  "BLOCKED",
  "ERROR",
  "STALE",
]);
/**
 * Presentation-only activity for a manual task. Nothing watches manual work,
 * so the one recorded fact is that the task is in progress. The state the
 * server sends for it is the working style set on the agent's profile, which
 * must never read as something the agent was seen doing.
 */
export const MANUAL_ACTIVITY = "MANUAL";
const KNOWN_ACTIVITIES = new Set([...ACTIVITY_IDS, MANUAL_ACTIVITY]);
const RECORDED_RUN_MODES = new Set(["observed", "managed", "simulated"]);

/**
 * True when an agent has a task in progress that no provider run reports on.
 * Accepts the enriched agent (`manualWork`), the server's "profile"
 * provenance, and the "user" provenance servers sent for the same case before
 * "profile" existed (a blocked task is also "user", and is a recorded fact).
 */
export function isManualWork(agent) {
  if (!agent) return false;
  if (typeof agent.manualWork === "boolean") return agent.manualWork;
  if (agent.activity === MANUAL_ACTIVITY) return true;
  if (!agent.taskId || agent.activity) return false;
  if (agent.activityProvenance === "profile") return true;
  return (
    agent.activityProvenance === "user" &&
    agent.state !== "BLOCKED" &&
    !RECORDED_RUN_MODES.has(agent.runMode)
  );
}

/** Activity with fallback to the legacy `state` field. */
export function activityOf(agent) {
  if (!agent) return "IDLE";
  if (agent.activity && KNOWN_ACTIVITIES.has(agent.activity))
    return agent.activity;
  if (isManualWork(agent)) return MANUAL_ACTIVITY;
  if (agent.state && KNOWN_ACTIVITIES.has(agent.state)) return agent.state;
  return "IDLE";
}

/**
 * An agent is on the floor while it has an active provider run or any
 * recorded activity other than resting or stale, or while it holds a later
 * step of a team relay someone is working on right now (`agent.relay`, see
 * office/relay.js relayPresence): the task is assigned to it and waiting,
 * which is a recorded fact. Idle profiles stay in the roster and never
 * create a figure.
 */
export function isOnFloor(agent) {
  const activity = activityOf(agent);
  return Boolean(
    agent?.activeProviderRun ||
    !["IDLE", "STALE"].includes(activity) ||
    (agent?.relay && activity === "IDLE"),
  );
}

/**
 * Provider beacons are drawn only for assistants with live work right now: a
 * live observed session, or an active run by an agent on the floor. Being
 * installed is not activity — the top bar and Connections already say what is
 * installed — so detection alone draws nothing. One beacon per provider.
 */
export function liveBeaconSurfaces(surfaces = [], agents = []) {
  const running = new Set(
    (agents ?? [])
      .filter((agent) => agent.activeProviderRun && agent.provider)
      .map((agent) => agent.provider),
  );
  const byProvider = new Map();
  for (const surface of surfaces ?? []) {
    if (!surface?.detected || byProvider.has(surface.provider)) continue;
    if ((surface.liveSessions ?? 0) > 0 || running.has(surface.provider))
      byProvider.set(surface.provider, surface);
  }
  for (const provider of running)
    if (!byProvider.has(provider))
      byProvider.set(provider, {
        id: provider,
        provider,
        detected: true,
        liveSessions: 0,
      });
  return [...byProvider.values()];
}

/**
 * The detected surfaces with each live-session count narrowed to one
 * workspace. Observation reports machine-wide counts, so without this a
 * session belonging to one workspace drew a "1 live session" beacon on the
 * floor of every other workspace — including one where nothing was running.
 * Without a workspace the surfaces pass through unchanged. Never mutates.
 */
export function surfacesForWorkspace(
  surfaces = [],
  sessions = [],
  workspaceId = null,
) {
  if (!workspaceId) return surfaces;
  const counts = new Map();
  for (const session of sessions ?? []) {
    if (session?.workspaceId !== workspaceId) continue;
    const provider = session.provider ?? session.providerId;
    if (!provider) continue;
    counts.set(provider, (counts.get(provider) ?? 0) + 1);
  }
  return (surfaces ?? []).map((surface) => ({
    ...surface,
    liveSessions: counts.get(surface.provider) ?? 0,
  }));
}
