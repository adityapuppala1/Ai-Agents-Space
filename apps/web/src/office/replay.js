// Watching the floor as it was, rather than as it is.
//
// Everything needed already sits in the workspace's recorded events: who did
// what, with which tool, on which file, and when. This reads that back as
// "the agents, at a moment", so the office can draw a past minute the same
// way it draws this one.
//
// Activity is read from the event *kind* the recorder already assigned, not
// re-derived from raw tool names here. The web never imports from
// packages/core — office/propKinds.js mirrors its catalogue rather than
// importing it — and re-deriving would be a second classifier to keep in
// step with the first. A kind is the server's own conclusion, so reading it
// back cannot disagree with the live floor.
//
// Nothing is interpolated between events: an agent shows the last thing it
// was recorded doing, never a guess about the gap.
//
// Pure: records in, records out. No three.js, no clock, no DOM.

/**
 * Recorded event kind → the activity it is evidence of (contracts.js
 * EVENT_KINDS). Kinds that say nothing about what an agent is *doing* —
 * usage, status, session boundaries — are absent on purpose: they leave the
 * agent showing whatever it was last actually seen doing.
 */
export const ACTIVITY_FOR_KIND = Object.freeze({
  "file.edit": "CODING",
  "file.write": "CODING",
  "file.read": "RESEARCHING",
  search: "RESEARCHING",
  web: "RESEARCHING",
  reasoning: "ANALYZING",
  command: "COMMANDING",
  test: "TESTING",
  message: "MESSAGING",
  prompt: "MESSAGING",
  delegation: "DELEGATING",
  "approval.request": "WAITING_APPROVAL",
  error: "ERROR",
});

/** Timestamps arrive as ISO strings from the API and as epoch ms in snapshots. */
export function timeOf(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The span the recorded events actually cover, or null when there is nothing
 * to replay. A replay never offers a window wider than its own evidence.
 */
export function replayRange(events = []) {
  let from = Infinity;
  let to = -Infinity;
  for (const event of events ?? []) {
    const at = timeOf(event?.timestamp);
    if (at == null) continue;
    if (at < from) from = at;
    if (at > to) to = at;
  }
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return { from, to };
}

/** The activity an event is evidence of, or null when it is evidence of none. */
export function activityOfEvent(event) {
  if (!event) return null;
  // An activity the recorder stated outright beats one read from the kind.
  const stated = event.data?.activity ?? event.activity ?? null;
  if (typeof stated === "string" && stated)
    return { value: stated, inferred: false };
  const fromKind = ACTIVITY_FOR_KIND[event.kind];
  // Read from the kind, which the recorder derived from a tool name: the
  // same chain the live floor labels inferred, so this says so too.
  if (fromKind) return { value: fromKind, inferred: true };
  return null;
}

/**
 * The agents as the record shows them at `at` (epoch ms).
 *
 * Identities come from the live agent list, because who exists is not a
 * question the events answer. Everything that could be *claimed* about right
 * now is cleared: a replayed agent is never shown as having an active run,
 * an elapsed time or a live status, because none of those were reconstructed.
 */
export function agentsAt(agents = [], events = [], at) {
  const moment = timeOf(at);
  // Tracked separately on purpose. Taking simply the latest event would let a
  // usage or status record — bookkeeping, not work — become an agent's most
  // recent evidence and blank it to idle, erasing the command before it.
  const doing = new Map();
  const onFile = new Map();
  const later = (seen, when, sequence) =>
    !seen ||
    when > seen.when ||
    (when === seen.when && sequence >= seen.sequence);

  if (moment != null)
    for (const event of events ?? []) {
      const when = timeOf(event?.timestamp);
      if (when == null || when > moment) continue;
      const id = event.agentId;
      if (!id) continue;
      const sequence = event.sequence ?? 0;
      if (activityOfEvent(event) && later(doing.get(id), when, sequence))
        doing.set(id, { when, sequence, event });
      if (event.file && later(onFile.get(id), when, sequence))
        onFile.set(id, { when, sequence, event });
    }

  return (agents ?? []).map((agent) => {
    const hit = doing.get(agent.id);
    const activity = hit ? activityOfEvent(hit.event) : null;
    return {
      ...agent,
      activity: activity?.value ?? "IDLE",
      activityProvenance: activity?.inferred ? "inferred" : "replay",
      currentFile: onFile.get(agent.id)?.event?.file ?? null,
      currentAction: hit?.event?.message ?? null,
      // Nothing below was reconstructed, so nothing below is claimed.
      activeProviderRun: false,
      elapsedMs: null,
      runStatus: null,
      subagents: [],
      // Marks every figure the office draws from a replay, so the scene can
      // never present a past minute as the present one.
      replay: true,
      replayAt: moment,
    };
  });
}

/**
 * How many of `agents` the record actually says something about at `at`.
 * The office shows this so a replay of a quiet minute reads as a quiet
 * minute rather than as a broken one.
 */
export function recordedAt(agents = [], events = [], at) {
  return agentsAt(agents, events, at).filter(
    (agent) => agent.activityProvenance === "inferred" || agent.currentFile,
  ).length;
}
