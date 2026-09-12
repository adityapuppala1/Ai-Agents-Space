import React, { useEffect, useState } from "react";
import { Send, TriangleAlert } from "lucide-react";
import Dialog from "./Dialog.jsx";
import { apiFetch } from "../hooks/useApi.js";
import {
  describeOutcome,
  describePlan,
  roomMessagePlan,
} from "../hooks/roomMessage.js";

/**
 * Says one thing to everybody working on a team.
 *
 * Each member has its own run, so this is several actions rather than one.
 * That shapes the whole dialog: it shows exactly who will receive the message
 * and who will not *before* anything is sent, because a message that starts
 * work on several agents at once is not something to discover afterwards; and
 * it reports partial success as partial success.
 *
 * Whether a run can be written to is the server's rule, read back per run
 * from `GET /api/runs/:id/conversation` rather than decided again here.
 *
 * @param {{
 *   title: string,                     // the team's name
 *   members: Array<{id, name, runId}>,
 *   onClose: () => void,
 *   onSent?: () => void,
 * }} props
 */
export default function RoomMessage({ title, members = [], onClose, onSent }) {
  const [entries, setEntries] = useState(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      const read = await Promise.all(
        members.map(async (agent) => {
          if (!agent.runId) return { agent, runId: null, reply: null };
          try {
            const data = await apiFetch(
              `/runs/${encodeURIComponent(agent.runId)}/conversation`,
            );
            return { agent, runId: agent.runId, reply: data?.reply ?? null };
          } catch (error) {
            return {
              agent,
              runId: agent.runId,
              reply: { can: false, reason: error.message },
            };
          }
        }),
      );
      if (alive) setEntries(read);
    })();
    return () => {
      alive = false;
    };
  }, [members]);

  const plan = roomMessagePlan(entries ?? []);

  const send = async (event) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || busy || !plan.willReceive.length) return;
    setBusy(true);
    const results = [];
    // One at a time, so a refusal part-way through is reported as itself
    // rather than lost in a batch.
    for (const entry of plan.willReceive) {
      try {
        await apiFetch(`/runs/${encodeURIComponent(entry.runId)}/input`, {
          method: "POST",
          body: { text: value },
        });
        results.push({ name: entry.name, ok: true });
      } catch (error) {
        results.push({ name: entry.name, ok: false, error: error.message });
      }
    }
    setOutcome(describeOutcome(results));
    setBusy(false);
    setText("");
    if (results.some((result) => result.ok)) onSent?.();
  };

  return (
    <Dialog title={`Message everyone in ${title}`} onClose={onClose}>
      {entries === null ? (
        <p className="as-muted as-small">Checking who can be messaged…</p>
      ) : (
        <>
          <p className="as-note as-note-info">
            <TriangleAlert size={12} aria-hidden="true" /> Each agent continues
            its own session, so this starts a new attempt for every one of
            them. It is not one conversation.
          </p>

          <p>
            <strong>{describePlan(plan)}</strong>
          </p>

          {plan.willReceive.length ? (
            <ul className="as-room-list" aria-label="Will receive this">
              {plan.willReceive.map((entry) => (
                <li key={entry.agent.id}>
                  <span className="dot green" aria-hidden="true" /> {entry.name}
                </li>
              ))}
            </ul>
          ) : null}

          {plan.cannot.length ? (
            <ul className="as-room-list as-room-cannot" aria-label="Cannot be messaged">
              {plan.cannot.map((entry) => (
                <li key={entry.agent.id}>
                  <span className="dot" aria-hidden="true" />
                  <strong>{entry.name}</strong> {entry.reason}
                </li>
              ))}
            </ul>
          ) : null}

          <form onSubmit={send} aria-label="Message the room">
            <label htmlFor="as-room-text">What should they all be told?</label>
            <textarea
              id="as-room-text"
              rows={3}
              value={text}
              disabled={!plan.willReceive.length}
              onChange={(event) => setText(event.target.value)}
            />
            <div className="modal-actions">
              <button type="button" className="button" onClick={onClose}>
                Close
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={!text.trim() || busy || !plan.willReceive.length}
              >
                <Send size={12} aria-hidden="true" />{" "}
                {busy
                  ? "Sending…"
                  : `Send to ${plan.willReceive.length}`}
              </button>
            </div>
          </form>

          {outcome ? (
            <p className="as-note" role="status">
              {outcome}
            </p>
          ) : null}
        </>
      )}
    </Dialog>
  );
}
