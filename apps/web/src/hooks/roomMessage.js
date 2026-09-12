// Saying one thing to everybody working on a team.
//
// Each member has its own run, so "message the room" is not one action — it
// is several, and some of them will be refused. Nothing here decides *why* a
// member can or cannot be written to: that rule lives in the server
// (core/runs/conversation.js replyState) and is read back per run from
// GET /api/runs/:id/conversation, so the interface never offers a message
// the server is about to refuse and never invents a second copy of the rule.
//
// What this module does is arithmetic on those answers: who will receive it,
// who will not and why, and what actually happened afterwards.
//
// Pure. No fetch, no DOM.

/**
 * Sorts a room's members into those a message will reach and those it will
 * not. `entries` is `[{ agent, runId, reply }]`, where `reply` is whatever
 * the server said about that run.
 */
export function roomMessagePlan(entries = []) {
  const willReceive = [];
  const cannot = [];
  for (const entry of entries ?? []) {
    if (!entry?.agent) continue;
    const name = entry.agent.name || entry.agent.id;
    if (!entry.runId) {
      cannot.push({ ...entry, name, reason: "has no run to continue." });
      continue;
    }
    if (entry.reply?.can) willReceive.push({ ...entry, name });
    else
      cannot.push({
        ...entry,
        name,
        // The server's own words, so the two never disagree.
        reason: entry.reply?.reason ?? "cannot be replied to.",
      });
  }
  return { willReceive, cannot };
}

/** "3 of 5 will receive this" — the sentence above the confirm button. */
export function describePlan(plan) {
  const total = plan.willReceive.length + plan.cannot.length;
  if (!total) return "Nobody is in this room.";
  if (!plan.willReceive.length)
    return `Nobody here can be messaged: ${total === 1 ? "the one member" : `all ${total} members`} would refuse it.`;
  if (!plan.cannot.length)
    return plan.willReceive.length === 1
      ? "1 member will receive this."
      : `All ${plan.willReceive.length} members will receive this.`;
  return `${plan.willReceive.length} of ${total} will receive this; the rest cannot be messaged.`;
}

/**
 * What happened after sending. `results` is `[{ name, ok, error? }]`.
 *
 * Partial success is reported as partial success: several runs are several
 * actions, and hiding a failure behind "sent" would be a claim we cannot
 * make about the ones that failed.
 */
export function describeOutcome(results = []) {
  const sent = results.filter((result) => result.ok);
  const failed = results.filter((result) => !result.ok);
  if (!results.length) return "Nothing was sent.";
  if (!failed.length)
    return sent.length === 1
      ? "Sent to 1 agent; it starts a new attempt."
      : `Sent to ${sent.length} agents; each starts a new attempt.`;
  if (!sent.length)
    return `Nothing was sent. ${failed.length === 1 ? failed[0].name : `All ${failed.length}`} refused it.`;
  return `Sent to ${sent.length}; ${failed.length} refused: ${failed
    .map((result) => result.name)
    .join(", ")}.`;
}
