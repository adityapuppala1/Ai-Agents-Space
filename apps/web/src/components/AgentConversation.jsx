import React, { useState } from "react";
import { MessageSquare, Send, TriangleAlert } from "lucide-react";
import { apiFetch, useApi } from "../hooks/useApi.js";
import EmptyState from "./EmptyState.jsx";

/**
 * What was said to an agent and what it said back, across every attempt in
 * one chain, with a box to reply.
 *
 * There is one of these, used from the run inspector and from the office, so
 * the two can never disagree about what was said. It reads
 * `GET /api/runs/:id/conversation`, which assembles the exchange from
 * recorded prompts and recorded provider messages — nothing is generated
 * here, and a run the provider never answered simply shows no answer.
 *
 * Replying is honest about what it does. A headless provider run cannot be
 * interrupted; sending a reply resumes the provider's session as a **new
 * attempt**, and the form says so rather than letting it look like a chat.
 *
 * @param {{
 *   runId: string,
 *   onReplied?: (run: any) => void,  // the new attempt that was started
 *   interval?: number,               // poll while a run is active
 * }} props
 */
export default function AgentConversation({ runId, onReplied, interval = 0 }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const path = runId
    ? `/runs/${encodeURIComponent(runId)}/conversation`
    : null;
  const { data, loading, reload } = useApi(path, { interval });

  const turns = data?.turns ?? [];
  const reply = data?.reply ?? null;
  const attempts = data?.attempts ?? [];

  const send = async (event) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setError("");
    try {
      // The newest attempt is the one a reply continues from.
      const target = data?.latestRunId ?? runId;
      const started = await apiFetch(
        `/runs/${encodeURIComponent(target)}/input`,
        { method: "POST", body: { text: value } },
      );
      setText("");
      await reload();
      onReplied?.(started);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!runId) return null;

  return (
    <section className="as-conversation" aria-label="Conversation with the agent">
      {loading && !data ? (
        <p className="as-muted as-small">Loading the conversation…</p>
      ) : null}

      {!loading && turns.length === 0 ? (
        <EmptyState
          compact
          title="Nothing was said yet"
          description="The prompt and every message the provider reported will appear here."
        />
      ) : null}

      {turns.length ? (
        <ol className="as-turns">
          {turns.map((turn, index) => (
            <li
              key={`${turn.runId}:${turn.sequence ?? "p"}:${index}`}
              className={`as-turn ${turn.role}`}
            >
              <p className="as-turn-who">
                <span className="as-turn-role">
                  {turn.role === "you" ? "You" : "Agent"}
                </span>
                {attempts.length > 1 ? (
                  <span className="as-turn-attempt">
                    attempt {turn.attempt}
                  </span>
                ) : null}
                {turn.at ? (
                  <time dateTime={turn.at}>
                    {new Date(turn.at).toLocaleTimeString()}
                  </time>
                ) : null}
              </p>
              <p className="as-turn-text">{turn.text}</p>
            </li>
          ))}
        </ol>
      ) : null}

      {data?.truncated ? (
        <p className="as-muted as-small">
          Only the most recent part of a long exchange is shown.
        </p>
      ) : null}

      {reply?.can ? (
        <form className="as-reply" onSubmit={send} aria-label="Reply to the agent">
          <label htmlFor="as-reply-text">
            <MessageSquare size={12} aria-hidden="true" /> Reply
          </label>
          <textarea
            id="as-reply-text"
            rows={3}
            value={text}
            placeholder="Ask for a change, or answer a question it asked."
            onChange={(event) => setText(event.target.value)}
          />
          <div className="as-reply-foot">
            <p className="as-muted as-small">{reply.note}</p>
            <button
              type="submit"
              className="button primary"
              disabled={!text.trim() || busy}
            >
              <Send size={12} aria-hidden="true" />{" "}
              {busy ? "Sending…" : "Send reply"}
            </button>
          </div>
        </form>
      ) : reply ? (
        <p
          className={`as-note${reply.pending ? "" : " as-note-info"}`}
          role={reply.pending ? "status" : undefined}
        >
          <TriangleAlert size={12} aria-hidden="true" /> {reply.reason}
        </p>
      ) : null}

      {error ? (
        <div className="form-error" role="alert">
          {error}
        </div>
      ) : null}
    </section>
  );
}
