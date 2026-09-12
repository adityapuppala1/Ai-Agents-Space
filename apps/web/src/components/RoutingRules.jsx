import React, { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Route } from "lucide-react";
import { apiFetch, useApi } from "../hooks/useApi.js";
import {
  candidateLine,
  formToRules,
  moveInOrder,
  ruleSummary,
  rulesToForm,
} from "../hooks/routingLogic.js";

/**
 * Routing and data rules for one workspace (roadmap §8, §11): the default
 * data label, where each label may go, a daily token cap per assistant, the
 * preference order, and how many graded results make a pass rate count.
 * Saved with PUT /api/workspaces/:id/policy; the data rule and the caps are
 * enforced by the server at launch. "Who would take it" ranks the
 * assistants with POST /api/workspaces/:id/route, which starts nothing.
 * @param {{ workspaceId: string, policy: object, onSaved?: (policy: object) => void }} props
 */
export default function RoutingRules({ workspaceId, policy, onSaved }) {
  const vocabulary = useApi("/routing");
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [trialLabel, setTrialLabel] = useState("");
  const [ranking, setRanking] = useState(null);
  const [rankError, setRankError] = useState("");
  const vocab = vocabulary.data;

  useEffect(() => {
    if (policy && vocab) setForm(rulesToForm(policy, vocab));
  }, [policy, vocab]);

  if (vocabulary.error)
    return (
      <section
        className="as-card as-routing"
        aria-label="Routing and data rules"
      >
        <h4>Routing and data rules</h4>
        <p className="as-muted as-small">
          {vocabulary.error.status === 404
            ? "This Agent Space server was started before routing existed. Restart it to set data rules and caps."
            : vocabulary.error.message}
        </p>
      </section>
    );
  if (!form || !vocab) return null;
  const vendorIds = Object.keys(vocab.vendors ?? {});
  const levelName = (level) => vocab.labels?.[level] ?? level;
  const providerName = (id) =>
    vocab.providers?.find((provider) => provider.id === id)?.name ?? id;
  const setRow = (level, next) =>
    setForm({ ...form, rows: { ...form.rows, [level]: next } });

  const save = async () => {
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const result = await apiFetch(
        `/workspaces/${encodeURIComponent(workspaceId)}/policy`,
        { method: "PUT", body: formToRules(form) },
      );
      onSaved?.(result);
      setSaved(
        "Routing saved. The data rules and daily caps are checked by the server on every launch.",
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const rank = async () => {
    setRankError("");
    try {
      setRanking(
        await apiFetch(`/workspaces/${encodeURIComponent(workspaceId)}/route`, {
          method: "POST",
          body: { sensitivity: trialLabel || null },
        }),
      );
    } catch (err) {
      setRanking(null);
      setRankError(err.message);
    }
  };

  return (
    <section className="as-card as-routing" aria-label="Routing and data rules">
      <h4>
        <Route size={14} aria-hidden="true" /> Routing and data rules
      </h4>
      <p className="as-muted as-small">
        Which assistant takes a task, and where each kind of work may go. A
        cloud assistant sends work to its vendor; the rules below are checked by
        the server before every launch, and rechecked before a fallback is
        offered. Nothing here starts a run.
      </p>
      {error ? (
        <div className="form-error" role="alert">
          {error}
        </div>
      ) : null}
      {saved ? (
        <p className="as-feedback" role="status">
          {saved}
        </p>
      ) : null}
      <label className="routing-default">
        Label for this workspace's tasks
        <select
          value={form.dataSensitivity}
          onChange={(e) =>
            setForm({ ...form, dataSensitivity: e.target.value })
          }
        >
          <option value="">None</option>
          {vocab.levels.map((level) => (
            <option key={level} value={level}>
              {levelName(level)}
            </option>
          ))}
        </select>
        <span className="as-muted as-small">
          A task can raise its own label, never lower it below this one.
        </span>
      </label>

      <div className="routing-grid-wrap">
        <table className="routing-grid">
          <caption>Where each label may go</caption>
          <thead>
            <tr>
              <th scope="col">Label</th>
              <th scope="col">Any vendor</th>
              {vendorIds.map((vendor) => (
                <th key={vendor} scope="col">
                  {vocab.vendors[vendor]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {vocab.levels.map((level) => {
              const row = form.rows[level] ?? { any: true, vendors: [] };
              return (
                <tr key={level}>
                  <th scope="row">
                    {levelName(level)}
                    <small>{ruleSummary(row, vocab.vendors)}</small>
                  </th>
                  <td>
                    <input
                      type="checkbox"
                      checked={row.any}
                      aria-label={`${levelName(level)}: any vendor`}
                      onChange={(e) =>
                        setRow(level, { ...row, any: e.target.checked })
                      }
                    />
                  </td>
                  {vendorIds.map((vendor) => (
                    <td key={vendor}>
                      <input
                        type="checkbox"
                        disabled={row.any}
                        checked={!row.any && row.vendors.includes(vendor)}
                        aria-label={`${levelName(level)}: ${vocab.vendors[vendor]}`}
                        onChange={(e) =>
                          setRow(level, {
                            ...row,
                            vendors: e.target.checked
                              ? [...row.vendors, vendor]
                              : row.vendors.filter((v) => v !== vendor),
                          })
                        }
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <fieldset className="as-fieldset routing-caps">
        <legend>Daily token cap per assistant</legend>
        {vocab.providers.map((provider) => (
          <label key={provider.id}>
            {provider.name}
            <input
              type="number"
              min="1"
              value={form.caps[provider.id] ?? ""}
              placeholder="no cap"
              onChange={(e) =>
                setForm({
                  ...form,
                  caps: { ...form.caps, [provider.id]: e.target.value },
                })
              }
            />
          </label>
        ))}
        <p className="as-muted as-small">
          Counted from the tokens each assistant reported today in this
          workspace. Usage arrives after a turn, so a run can pass its cap; the
          next launch is refused.
        </p>
      </fieldset>

      <fieldset className="as-fieldset routing-order">
        <legend>Preferred order</legend>
        <p className="as-muted as-small">
          Among assistants that pass every check, these go first, in this order.
          Unlisted ones follow.
        </p>
        <ol>
          {vocab.providers.map((provider) => {
            const listed = form.preference.includes(provider.id);
            return (
              <li key={provider.id} className={listed ? "is-listed" : ""}>
                <label>
                  <input
                    type="checkbox"
                    checked={listed}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        preference: e.target.checked
                          ? [...form.preference, provider.id]
                          : form.preference.filter((id) => id !== provider.id),
                      })
                    }
                  />
                  {listed
                    ? `${form.preference.indexOf(provider.id) + 1}. ${provider.name}`
                    : provider.name}
                </label>
                {listed ? (
                  <span className="routing-move">
                    <button
                      type="button"
                      aria-label={`Move ${provider.name} up`}
                      onClick={() =>
                        setForm({
                          ...form,
                          preference: moveInOrder(
                            form.preference,
                            provider.id,
                            -1,
                          ),
                        })
                      }
                    >
                      <ArrowUp size={13} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${provider.name} down`}
                      onClick={() =>
                        setForm({
                          ...form,
                          preference: moveInOrder(
                            form.preference,
                            provider.id,
                            1,
                          ),
                        })
                      }
                    >
                      <ArrowDown size={13} aria-hidden="true" />
                    </button>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
      </fieldset>

      <label className="routing-min">
        Graded results needed before pass rates rank assistants
        <input
          type="number"
          min="1"
          max="1000"
          value={form.minEvaluations}
          onChange={(e) => setForm({ ...form, minEvaluations: e.target.value })}
        />
      </label>
      <div className="modal-actions">
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={save}
        >
          Save routing
        </button>
      </div>

      <div className="routing-trial" aria-label="Who would take a task">
        <h5>Who would take it</h5>
        <div className="routing-trial-row">
          <label>
            Work labelled
            <select
              value={trialLabel}
              onChange={(e) => setTrialLabel(e.target.value)}
            >
              <option value="">(this workspace's label)</option>
              {vocab.levels.map((level) => (
                <option key={level} value={level}>
                  {levelName(level)}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="button" onClick={rank}>
            Rank the assistants
          </button>
        </div>
        {rankError ? (
          <div className="form-error" role="alert">
            {rankError}
          </div>
        ) : null}
        {ranking ? (
          <div role="status">
            <p className="as-small">
              {ranking.recommended
                ? `Recommended: ${ranking.why}`
                : "No assistant passes every check for this work."}
            </p>
            <ol className="routing-ranking">
              {ranking.candidates.map((candidate) => (
                <li
                  key={candidate.provider}
                  className={candidate.eligible ? "is-eligible" : "is-excluded"}
                >
                  <strong>
                    <span aria-hidden="true">
                      {candidate.eligible ? "✓" : "✕"}
                    </span>{" "}
                    {providerName(candidate.provider)}
                    <span className="sr-only">
                      {candidate.eligible ? ", qualifies" : ", excluded"}
                    </span>
                  </strong>
                  <span>{candidateLine(candidate)}</span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>
    </section>
  );
}
