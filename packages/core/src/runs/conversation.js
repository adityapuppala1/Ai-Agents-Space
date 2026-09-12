// The exchange between a person and an agent.
//
// A headless provider run is one shot: you send a prompt, it works, it
// answers, it exits. Continuing the conversation resumes the provider's
// session as a *new* run, linked to the last one by `parentRunId`. So what a
// person thinks of as "talking to an agent" is recorded as a chain of runs,
// and this module reads that chain back as the exchange it was.
//
// Nothing here invents a turn. A run with no recorded prompt contributes no
// question, and a run the provider never answered contributes no answer —
// the conversation is allowed to be one-sided, because sometimes it was.
//
// Pure: rows in, turns out. No database, no HTTP, no clock.

/** Longest single turn kept in full; the rest is marked as trimmed. */
export const TURN_LIMIT = 4000;

/** Most turns returned for one conversation. */
export const MAX_TURNS = 200;

function trim(text) {
  const value = String(text ?? "").trim();
  if (!value) return null;
  if (value.length <= TURN_LIMIT)
    return { text: value, trimmed: false };
  return {
    text: `${value.slice(0, TURN_LIMIT)}\n\n[trimmed: ${value.length - TURN_LIMIT} more characters]`,
    trimmed: true,
  };
}

/**
 * The turns of one conversation.
 *
 * `runs` is the chain oldest first (see RunRecorder.chain). `eventsFor` is
 * called with a run id and returns that run's recorded events; only
 * `kind === "message"` events with text become answers, which is the same
 * rule the office uses to decide an agent has something to say.
 *
 * Each turn carries the run and attempt it belongs to, so the interface can
 * show that a follow-up started a new attempt rather than pretending one
 * long session took place.
 */
export function buildConversation(runs = [], eventsFor = () => []) {
  const turns = [];
  let trimmedAny = false;
  for (const run of runs) {
    if (!run?.id) continue;
    const asked = trim(run.prompt);
    if (asked) {
      trimmedAny = trimmedAny || asked.trimmed;
      turns.push({
        role: "you",
        text: asked.text,
        at: run.startedAt ?? null,
        runId: run.id,
        attempt: run.attempt ?? 1,
        // A prompt is what the person actually sent; it is never inferred.
        provenance: "recorded",
      });
    }
    const events = eventsFor(run.id) ?? [];
    for (const event of events) {
      if (event?.kind !== "message") continue;
      const said = trim(event.data?.text ?? event.message);
      if (!said) continue;
      trimmedAny = trimmedAny || said.trimmed;
      turns.push({
        role: "agent",
        text: said.text,
        at: event.timestamp ?? null,
        runId: run.id,
        attempt: run.attempt ?? 1,
        sequence: event.sequence ?? null,
        // Whatever the recorder stored; a provider message says "provider".
        provenance: event.provenance ?? "provider",
      });
    }
  }
  const truncated = turns.length > MAX_TURNS;
  return {
    turns: truncated ? turns.slice(-MAX_TURNS) : turns,
    truncated,
    trimmed: trimmedAny,
  };
}

/**
 * Whether this conversation can be continued, and if not, why not — in the
 * words the interface should use.
 *
 * The rules mirror RunWorker.input(), deliberately: the interface must not
 * offer a reply the server is going to refuse, and must not claim a reply is
 * impossible when it is merely not possible *yet*.
 */
export function replyState(run, adapter, { active = false } = {}) {
  if (!run) return { can: false, reason: "There is no run to continue." };
  if (run.mode !== "managed")
    return {
      can: false,
      reason:
        run.mode === "observed"
          ? "This session was started outside Agent Space. Answer it where it runs."
          : "This run is recorded here only, not controlled.",
    };
  if (!adapter?.supportsResume)
    return {
      can: false,
      reason: `${adapter?.name ?? run.provider} cannot resume a session, so it cannot be replied to.`,
    };
  if (active)
    return {
      can: false,
      pending: true,
      reason:
        "This run is still working. A headless provider cannot be interrupted: it can be answered once it finishes, or cancelled now.",
    };
  const sessionId =
    run.providerSessionId ?? run.configSnapshot?.providerSessionId ?? null;
  if (!sessionId)
    return {
      can: false,
      reason:
        "No provider session id was recorded for this run, so it cannot be resumed.",
    };
  return {
    can: true,
    // Said plainly, because it is the part people are surprised by.
    note: "Sending this starts a new attempt that continues the provider's session.",
  };
}
