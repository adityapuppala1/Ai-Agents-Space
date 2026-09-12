import React, { useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Pencil,
  Play,
  Plus,
  Power,
} from "lucide-react";
import Dialog from "../components/Dialog.jsx";
import EmptyState from "../components/EmptyState.jsx";
import { apiFetch, providerLabel, timeAgo, useApi } from "../hooks/useApi.js";
import { useGlobalChange } from "../hooks/useGlobal.js";
import {
  MISSED_CHOICES,
  OVERLAP_CHOICES,
  SCHEDULE_PRESETS,
  draftProblems,
  formatInZone,
  presetFor,
  scheduleBody,
  scheduleDraft,
  scheduleOutcome,
  scheduleState,
} from "../hooks/scheduleLogic.js";

const PROVIDERS = ["claude-code", "codex", "copilot", "gemini", "cursor"];

/**
 * Schedules: tasks and workflows that start on a timer (roadmap §10). The
 * server decides everything (Scheduler.js); this page says what it decided
 * and lets a person set it up. Nothing starts on a timer unless scheduling is
 * on AND the schedule is enabled, and the page says which of the two is
 * missing. New schedules are created disabled.
 *
 * @param {{
 *   workspaceId: string,
 *   onOpenRun?: (runId: string) => void,
 * }} props
 */
export default function SchedulesView({ workspaceId, onOpenRun }) {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/schedules`;
  const status = useApi("/scheduler/status");
  // Cancelled schedules are listed too (in their own section), or their
  // history could never be read, nor the schedule deleted, from here.
  const list = useApi(`${base}?includeCancelled=true`, {
    deps: [workspaceId],
  });
  const [showCancelled, setShowCancelled] = useState(false);
  const templates = useApi("/templates");
  const [editing, setEditing] = useState(null); // null | "new" | schedule
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState("");
  const [confirm, setConfirm] = useState(null); // { kind, schedule? }
  useGlobalChange(() => {
    status.reload();
    list.reload();
  });

  const all = Array.isArray(list.data) ? list.data : [];
  const schedules = all.filter((schedule) => !schedule.cancelledAt);
  const cancelled = all.filter((schedule) => schedule.cancelledAt);
  const templateList = Array.isArray(templates.data)
    ? templates.data
    : (templates.data?.templates ?? []);
  const templateName = (id) =>
    templateList.find((template) => template.id === id)?.name ?? id;

  const act = async (key, request, message) => {
    setBusy(key);
    setFeedback("");
    try {
      const result = await request();
      if (message) setFeedback(message(result));
      await Promise.all([list.reload(), status.reload()]);
      return result;
    } catch (error) {
      setFeedback(
        error.status === 404 && key === "scheduler"
          ? "This server cannot switch scheduling from here yet. Restart Agent Space with this version."
          : error.message,
      );
      return null;
    } finally {
      setBusy("");
    }
  };

  const setScheduling = (enabled) =>
    act(
      "scheduler",
      () =>
        apiFetch("/scheduler/enabled", { method: "POST", body: { enabled } }),
      (result) =>
        enabled
          ? `Scheduling is on.${
              result?.missed?.length
                ? ` ${result.missed.length} schedule${result.missed.length === 1 ? "" : "s"} had times that passed while it was off; each followed its missed-run setting.`
                : ""
            }`
          : "Scheduling is off. Runs already started keep going; nothing new starts on a timer.",
    );

  const scheduleAction = (schedule, action, message) =>
    act(
      `${schedule.id}:${action}`,
      () =>
        apiFetch(`/schedules/${encodeURIComponent(schedule.id)}/${action}`, {
          method: "POST",
        }),
      message,
    );

  const renderRow = (schedule) => (
    <li key={schedule.id}>
      <ScheduleRow
        schedule={schedule}
        status={status.data}
        busy={busy}
        templateName={templateName}
        onEdit={() => setEditing(schedule)}
        onToggle={() =>
          scheduleAction(
            schedule,
            schedule.enabled ? "disable" : "enable",
            (result) =>
              result?.enabled
                ? `“${schedule.name}” is enabled. Next: ${formatInZone(result.nextRunAt, result.timeZone) ?? "not computed"}.`
                : `“${schedule.name}” is disabled. It starts only when you choose Run now.`,
          )
        }
        onRunNow={() =>
          scheduleAction(schedule, "run-now", (result) =>
            result?.outcome === "started"
              ? `“${schedule.name}” started now.`
              : `“${schedule.name}”: ${scheduleOutcome(result).label}${result?.error ? ` — ${result.error}` : ""}.`,
          )
        }
        onCancel={() => setConfirm({ kind: "cancel", schedule })}
        onDelete={() => setConfirm({ kind: "delete", schedule })}
        onOpenRun={onOpenRun}
      />
    </li>
  );

  const loading = list.loading && !list.data;
  const unsupported =
    status.error?.status === 404 || list.error?.status === 404;

  return (
    <section className="sched" aria-label="Schedules">
      <SchedulerSwitch
        status={status.data}
        error={status.error}
        busy={busy === "scheduler"}
        onTurnOn={() => setConfirm({ kind: "turn-on" })}
        onTurnOff={() => setScheduling(false)}
      />
      <div className="sched-head">
        <h2>
          Schedules in this workspace{" "}
          {schedules.length ? <span>{schedules.length}</span> : null}
        </h2>
        <button
          type="button"
          className="button primary"
          onClick={() => setEditing("new")}
          disabled={unsupported}
        >
          <Plus size={14} aria-hidden="true" /> New schedule
        </button>
      </div>
      {feedback ? (
        <p className="as-feedback" role="status">
          {feedback}
        </p>
      ) : null}
      {list.error && !unsupported ? (
        <p className="form-error" role="alert">
          {list.error.message}
        </p>
      ) : null}
      {unsupported ? (
        <p className="as-note">
          This server has no scheduler routes. Restart Agent Space with this
          version to use schedules.
        </p>
      ) : null}
      {loading ? (
        <p className="panel-loading" role="status">
          Loading schedules…
        </p>
      ) : null}
      {!loading && !all.length && !list.error ? (
        <EmptyState
          icon={<CalendarClock size={26} />}
          title="No schedules yet"
          description="A schedule starts a task or a workflow at set times: every weekday morning, every night, every hour. It is created disabled, so nothing runs until you enable it."
          actions={[
            { label: "New schedule", onClick: () => setEditing("new") },
          ]}
        />
      ) : null}
      <ul className="sched-list">
        {schedules.map((schedule) => renderRow(schedule))}
      </ul>
      {cancelled.length ? (
        <div className="sched-cancelled">
          <button
            type="button"
            className="text-button"
            aria-expanded={showCancelled}
            onClick={() => setShowCancelled((value) => !value)}
          >
            {showCancelled ? (
              <ChevronDown size={14} aria-hidden="true" />
            ) : (
              <ChevronRight size={14} aria-hidden="true" />
            )}
            Cancelled schedules ({cancelled.length})
          </button>
          {showCancelled ? (
            <ul className="sched-list">
              {cancelled.map((schedule) => renderRow(schedule))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {editing ? (
        <ScheduleEditor
          schedule={editing === "new" ? null : editing}
          templates={templateList}
          onClose={() => setEditing(null)}
          onSave={async (body) => {
            // Returns the server's reason on failure, shown in the form.
            try {
              const result =
                editing === "new"
                  ? await apiFetch(base, { method: "POST", body })
                  : await apiFetch(
                      `/schedules/${encodeURIComponent(editing.id)}`,
                      { method: "PATCH", body },
                    );
              setFeedback(
                editing === "new"
                  ? `“${result.name}” is saved and disabled. Enable it when you are ready for it to run.`
                  : `“${result.name}” is saved.`,
              );
              setEditing(null);
              await Promise.all([list.reload(), status.reload()]);
              return null;
            } catch (error) {
              return error.message;
            }
          }}
        />
      ) : null}

      {confirm ? (
        <ConfirmDialog
          confirm={confirm}
          status={status.data}
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            const { kind, schedule } = confirm;
            setConfirm(null);
            if (kind === "turn-on") return setScheduling(true);
            if (kind === "cancel")
              return scheduleAction(schedule, "cancel", (result) => {
                const runs = result?.cancelledRuns ?? [];
                return `“${schedule.name}” is cancelled.${
                  runs.length
                    ? ` Cancellation was requested for ${runs.length} run${runs.length === 1 ? "" : "s"} it had started; work they already did is not undone.`
                    : ""
                }`;
              });
            if (kind === "delete")
              return act(
                `${schedule.id}:delete`,
                () =>
                  apiFetch(`/schedules/${encodeURIComponent(schedule.id)}`, {
                    method: "DELETE",
                  }),
                () => `“${schedule.name}” and its history are deleted.`,
              );
            return null;
          }}
        />
      ) : null}
    </section>
  );
}

/** The one global switch, and what it means right now. */
function SchedulerSwitch({ status, error, busy, onTurnOn, onTurnOff }) {
  if (error)
    return error.status === 404 ? null : (
      <p className="form-error" role="alert">
        {error.message}
      </p>
    );
  if (!status)
    return (
      <p className="panel-loading" role="status">
        Reading the scheduler…
      </p>
    );
  const on = status.enabled === true;
  const counts = status.schedules ?? {};
  return (
    <div className={`sched-switch ${on ? "is-on" : "is-off"}`}>
      <Power size={18} aria-hidden="true" />
      <div>
        <strong>{on ? "Scheduling is on" : "Scheduling is off"}</strong>
        <p>
          {on
            ? [
                status.running === false
                  ? "The timer is not running; turn scheduling off and on again."
                  : `Checked every ${Math.round((status.tickMs ?? 30000) / 1000)} s${
                      status.lastTickAt
                        ? `, last ${timeAgo(status.lastTickAt) ?? "just now"}`
                        : ""
                    }.`,
                status.nextRunAt
                  ? `Next run across all workspaces: ${formatInZone(status.nextRunAt, undefined)}.`
                  : "No enabled schedule has a next run.",
              ].join(" ")
            : "Nothing starts on a timer, in any workspace. Run now still works for any schedule."}{" "}
          {counts.enabled
            ? `${counts.enabled} enabled schedule${counts.enabled === 1 ? "" : "s"} in all.`
            : ""}
        </p>
      </div>
      <button
        type="button"
        // Emphasised only when it would make something run: an enabled
        // schedule is waiting for it.
        className={`button ${!on && counts.enabled ? "primary" : ""}`}
        disabled={busy}
        onClick={on ? onTurnOff : onTurnOn}
      >
        {busy ? "Saving…" : on ? "Turn scheduling off" : "Turn scheduling on"}
      </button>
    </div>
  );
}

function ScheduleRow({
  schedule,
  status,
  busy,
  templateName,
  onEdit,
  onToggle,
  onRunNow,
  onCancel,
  onDelete,
  onOpenRun,
}) {
  const [open, setOpen] = useState(false);
  const state = scheduleState(schedule, status);
  const last = schedule.lastResult
    ? scheduleOutcome(schedule.lastResult)
    : null;
  const cancelled = state.key === "cancelled";
  const what =
    schedule.kind === "workflow"
      ? `Workflow: ${templateName(schedule.target)}`
      : `Task: ${schedule.target}`;
  const provider = schedule.definition?.provider;
  return (
    <article className={`sched-row is-${state.key}`}>
      <div className="sched-main">
        <h3>{schedule.name}</h3>
        <p className="sched-what">
          {what}
          {provider ? ` · ${providerLabel(provider)}` : ""}
        </p>
        <p className="sched-when">
          <code>{schedule.expression}</code> · {schedule.timeZone}
          {schedule.quietHours
            ? ` · quiet ${schedule.quietHours.start}–${schedule.quietHours.end}`
            : ""}
        </p>
        <p className="sched-next">
          {cancelled || !schedule.enabled
            ? null
            : schedule.nextRunAt
              ? `Next: ${formatInZone(schedule.nextRunAt, schedule.timeZone)}`
              : "Next run not computed"}
          {last ? (
            <span className={`sched-last tone-${last.tone}`}>
              Last: {last.label}
              {schedule.lastResult?.at
                ? ` · ${timeAgo(schedule.lastResult.at)}`
                : ""}
            </span>
          ) : (
            <span className="sched-last tone-muted">Has not run yet</span>
          )}
        </p>
      </div>
      <div className="sched-side">
        <span className={`sched-state state-${state.key}`} title={state.detail}>
          {state.label}
        </span>
        <div className="sched-actions">
          {!cancelled ? (
            <>
              <button
                type="button"
                className="button"
                disabled={
                  busy ===
                  `${schedule.id}:${schedule.enabled ? "disable" : "enable"}`
                }
                onClick={onToggle}
              >
                {schedule.enabled ? "Disable" : "Enable"}
              </button>
              <button
                type="button"
                className="button"
                disabled={busy === `${schedule.id}:run-now`}
                onClick={onRunNow}
                title="Starts it once now, whatever its timer says. Audited as you."
              >
                <Play size={12} aria-hidden="true" /> Run now
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Edit ${schedule.name}`}
                title="Edit"
                onClick={onEdit}
              >
                <Pencil size={14} aria-hidden="true" />
              </button>
              <button type="button" className="text-button" onClick={onCancel}>
                Cancel schedule
              </button>
            </>
          ) : (
            <button type="button" className="text-button" onClick={onDelete}>
              Delete with its history
            </button>
          )}
        </div>
      </div>
      <button
        type="button"
        className="text-button sched-history-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? (
          <ChevronDown size={14} aria-hidden="true" />
        ) : (
          <ChevronRight size={14} aria-hidden="true" />
        )}
        History
      </button>
      {open ? (
        <ScheduleHistory schedule={schedule} onOpenRun={onOpenRun} />
      ) : null}
    </article>
  );
}

/** The recorded decisions for one schedule, newest first. */
function ScheduleHistory({ schedule, onOpenRun }) {
  const runs = useApi(
    `/schedules/${encodeURIComponent(schedule.id)}/runs?limit=20`,
    { deps: [schedule.updatedAt, schedule.lastRunAt] },
  );
  const rows = Array.isArray(runs.data) ? runs.data : [];
  if (runs.loading && !runs.data)
    return (
      <p className="panel-loading" role="status">
        Loading history…
      </p>
    );
  if (runs.error)
    return (
      <p className="form-error" role="alert">
        {runs.error.message}
      </p>
    );
  if (!rows.length)
    return <p className="as-muted as-small">Nothing recorded yet.</p>;
  return (
    <ol className="sched-history" aria-label={`History of ${schedule.name}`}>
      {rows.map((run) => {
        const outcome = scheduleOutcome(run);
        return (
          <li key={run.id}>
            <span className="sched-history-time">
              {formatInZone(run.plannedAt, schedule.timeZone)}
            </span>
            <span className={`tone-${outcome.tone}`}>{outcome.label}</span>
            {outcome.detail?.kind === "deferred" ? (
              <span className="as-muted">
                to {formatInZone(outcome.detail.at, schedule.timeZone)}
              </span>
            ) : null}
            {outcome.detail?.kind === "error" ? (
              <span className="as-muted">{outcome.detail.text}</span>
            ) : null}
            {run.runId && onOpenRun ? (
              <button
                type="button"
                className="text-button"
                onClick={() => onOpenRun(run.runId)}
              >
                Open run
              </button>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/** Create or edit a schedule, with the next run times previewed by the server. */
function ScheduleEditor({ schedule, templates, onClose, onSave }) {
  const [draft, setDraft] = useState(() => scheduleDraft(schedule));
  const [preset, setPreset] = useState(() => presetFor(draft.expression));
  const [preview, setPreview] = useState({ loading: false, error: "", at: [] });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [shown, setShown] = useState(false);
  const set = (key, value) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const template = templates.find((entry) => entry.id === draft.target) ?? null;
  const problems = draftProblems(draft, template);
  const zones = useMemo(() => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return [];
    }
  }, []);

  // Ask the server when the timing would fire; nothing is written.
  useEffect(() => {
    const expression = draft.expression.trim();
    if (!expression) {
      setPreview({ loading: false, error: "", at: [] });
      return undefined;
    }
    let current = true;
    setPreview((state) => ({ ...state, loading: true }));
    const timer = setTimeout(() => {
      apiFetch("/schedules/preview", {
        method: "POST",
        body: { expression, timeZone: draft.timeZone, count: 3 },
      })
        .then((data) => {
          if (current)
            setPreview({
              loading: false,
              error: "",
              at: data?.occurrences ?? [],
            });
        })
        .catch((error) => {
          if (current)
            setPreview({ loading: false, error: error.message, at: [] });
        });
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [draft.expression, draft.timeZone]);

  const submit = async (event) => {
    event.preventDefault();
    setShown(true);
    if (problems.length || preview.error) return;
    setSaving(true);
    setSaveError("");
    const error = await onSave(scheduleBody(draft, template));
    setSaving(false);
    if (error) setSaveError(error);
  };

  return (
    <Dialog
      title={schedule ? `Edit “${schedule.name}”` : "New schedule"}
      onClose={onClose}
      wide
    >
      <form className="sched-form" onSubmit={submit} noValidate>
        <label>
          Name
          <input
            data-autofocus
            value={draft.name}
            maxLength={120}
            onChange={(event) => set("name", event.target.value)}
            placeholder="Nightly dependency check"
          />
        </label>

        <fieldset>
          <legend>What it starts</legend>
          <div className="segmented" role="group" aria-label="What it starts">
            {[
              ["task", "A task"],
              ["workflow", "A workflow"],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={draft.kind === id}
                onClick={() => set("kind", id)}
              >
                {label}
              </button>
            ))}
          </div>
          {draft.kind === "task" ? (
            <>
              <label>
                Task title
                <input
                  value={draft.target}
                  maxLength={200}
                  onChange={(event) => set("target", event.target.value)}
                  placeholder="Check dependencies for updates"
                />
              </label>
              <label>
                Instructions <span className="optional">(optional)</span>
                <textarea
                  rows={3}
                  maxLength={2000}
                  value={draft.prompt}
                  onChange={(event) => set("prompt", event.target.value)}
                  placeholder="What the assistant should do each time"
                />
              </label>
              <label>
                Assistant
                <select
                  value={draft.provider}
                  onChange={(event) => set("provider", event.target.value)}
                >
                  <option value="">The task&apos;s default</option>
                  {PROVIDERS.map((id) => (
                    <option key={id} value={id}>
                      {providerLabel(id)}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <>
              <label>
                Workflow template
                <select
                  value={draft.target}
                  onChange={(event) => set("target", event.target.value)}
                >
                  <option value="">Choose a template</option>
                  {templates.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
              {(template?.inputKeys ?? []).map((key) => (
                <label key={key}>
                  {key}
                  <input
                    value={draft.inputs?.[key] ?? ""}
                    onChange={(event) =>
                      set("inputs", {
                        ...draft.inputs,
                        [key]: event.target.value,
                      })
                    }
                  />
                </label>
              ))}
            </>
          )}
        </fieldset>

        <fieldset>
          <legend>When</legend>
          <label>
            Timing
            <select
              value={preset}
              onChange={(event) => {
                setPreset(event.target.value);
                const chosen = SCHEDULE_PRESETS.find(
                  (entry) => entry.id === event.target.value,
                );
                if (chosen) set("expression", chosen.expression);
              }}
            >
              {SCHEDULE_PRESETS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
              <option value="custom">Custom</option>
            </select>
          </label>
          {preset === "custom" ? (
            <label>
              Cron expression
              <input
                className="as-mono"
                value={draft.expression}
                maxLength={120}
                onChange={(event) => set("expression", event.target.value)}
                placeholder="0 9 * * 1-5"
              />
              <span className="as-muted as-small">
                minute hour day-of-month month day-of-week, or “every 2 hours”
              </span>
            </label>
          ) : null}
          <label>
            Time zone
            <input
              list="sched-zones"
              value={draft.timeZone}
              onChange={(event) => set("timeZone", event.target.value)}
            />
            <datalist id="sched-zones">
              {zones.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          </label>
          <div className="sched-preview" aria-live="polite">
            {preview.error ? (
              <p className="form-error">{preview.error}</p>
            ) : preview.at.length ? (
              <p>
                <strong>Next runs:</strong>{" "}
                {preview.at
                  .map((at) => formatInZone(at, draft.timeZone))
                  .join(" · ")}
              </p>
            ) : preview.loading ? (
              <p className="as-muted">Working out the next runs…</p>
            ) : null}
          </div>
          <label className="as-check">
            <input
              type="checkbox"
              checked={draft.quiet}
              onChange={(event) => set("quiet", event.target.checked)}
            />
            Never start during quiet hours
          </label>
          {draft.quiet ? (
            <div className="sched-quiet">
              <label>
                From
                <input
                  type="time"
                  value={draft.quietStart}
                  onChange={(event) => set("quietStart", event.target.value)}
                />
              </label>
              <label>
                Until
                <input
                  type="time"
                  value={draft.quietEnd}
                  onChange={(event) => set("quietEnd", event.target.value)}
                />
              </label>
              <p className="as-muted as-small">
                In the schedule&apos;s time zone. A time that falls inside moves
                to the end of the window, unless missed times are skipped.
              </p>
            </div>
          ) : null}
        </fieldset>

        <fieldset>
          <legend>If the previous run is still going</legend>
          {OVERLAP_CHOICES.map((choice) => (
            <label key={choice.id} className="sched-choice">
              <input
                type="radio"
                name="overlap"
                checked={draft.overlapPolicy === choice.id}
                onChange={() => set("overlapPolicy", choice.id)}
              />
              <span>
                <strong>{choice.label}</strong>
                <small>{choice.detail}</small>
              </span>
            </label>
          ))}
          {draft.overlapPolicy !== "skip" ? (
            <label>
              Runs allowed at once
              <input
                type="number"
                min={1}
                max={20}
                value={draft.maxConcurrent}
                onChange={(event) =>
                  set("maxConcurrent", Number(event.target.value))
                }
              />
            </label>
          ) : null}
        </fieldset>

        <fieldset>
          <legend>Times missed while scheduling was off</legend>
          {MISSED_CHOICES.map((choice) => (
            <label key={choice.id} className="sched-choice">
              <input
                type="radio"
                name="missed"
                checked={draft.missedRunPolicy === choice.id}
                onChange={() => set("missedRunPolicy", choice.id)}
              />
              <span>
                <strong>{choice.label}</strong>
                <small>{choice.detail}</small>
              </span>
            </label>
          ))}
          {draft.missedRunPolicy === "catch-up" ? (
            <label>
              At most
              <input
                type="number"
                min={1}
                max={100}
                value={draft.catchUpLimit}
                onChange={(event) =>
                  set("catchUpLimit", Number(event.target.value))
                }
              />
            </label>
          ) : null}
        </fieldset>

        {saveError ? (
          <p className="form-error" role="alert">
            Not saved: {saveError}
          </p>
        ) : null}
        {shown && problems.length ? (
          <ul className="form-error" role="alert">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={saving}>
            {saving ? "Saving…" : schedule ? "Save changes" : "Save (disabled)"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Confirmation for the three actions that are hard to take back. */
function ConfirmDialog({ confirm, status, onClose, onConfirm }) {
  const { kind, schedule } = confirm;
  const enabled = status?.schedules?.enabled ?? 0;
  const copy = {
    "turn-on": {
      title: "Turn scheduling on?",
      body: `${enabled} enabled schedule${enabled === 1 ? "" : "s"}, in every workspace, will start on ${enabled === 1 ? "its" : "their"} timers. Times that passed while scheduling was off follow each schedule's missed-run setting, so some may start right away.`,
      action: "Turn scheduling on",
    },
    cancel: {
      title: `Cancel “${schedule?.name}”?`,
      body: "It stops for good and cannot be enabled again. Cancellation is requested for any run it started that is still going; work those runs already did is not undone. Its history is kept.",
      action: "Cancel schedule",
    },
    delete: {
      title: `Delete “${schedule?.name}”?`,
      body: "The schedule and its history of decisions are removed. Runs it started, and their records, are kept.",
      action: "Delete",
    },
  }[kind];
  return (
    <Dialog title={copy.title} onClose={onClose}>
      <p className="modal-intro">{copy.body}</p>
      <div className="modal-actions">
        <button type="button" className="button" onClick={onClose}>
          Keep as is
        </button>
        <button type="button" className="button primary" onClick={onConfirm}>
          {copy.action}
        </button>
      </div>
    </Dialog>
  );
}
