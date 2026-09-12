/**
 * Pure rules behind the Schedules page (apps/web/src/views/SchedulesView.jsx).
 * The server owns every decision (packages/core/src/workflows/Scheduler.js);
 * this module only words what it recorded and shapes what the form sends.
 */

/** Common timings, each a cron expression the server parses. */
export const SCHEDULE_PRESETS = Object.freeze([
  { id: "hourly", label: "Every hour, on the hour", expression: "0 * * * *" },
  { id: "every-30", label: "Every 30 minutes", expression: "every 30 minutes" },
  { id: "daily-9", label: "Every day at 09:00", expression: "0 9 * * *" },
  { id: "weekdays-9", label: "Weekdays at 09:00", expression: "0 9 * * 1-5" },
  { id: "nightly-2", label: "Every night at 02:00", expression: "0 2 * * *" },
  { id: "monday-9", label: "Mondays at 09:00", expression: "0 9 * * 1" },
]);

/** The preset an expression matches, or "custom". */
export function presetFor(expression) {
  const text = String(expression ?? "").trim();
  return SCHEDULE_PRESETS.find((p) => p.expression === text)?.id ?? "custom";
}

export const OVERLAP_CHOICES = Object.freeze([
  {
    id: "skip",
    label: "Skip this time",
    detail: "If the previous run is still going, this occurrence is skipped.",
  },
  {
    id: "queue",
    label: "Wait, then start",
    detail:
      "If the previous run is still going, this one waits and starts when a slot frees.",
  },
  {
    id: "allow",
    label: "Start alongside",
    detail: "Runs may overlap, up to the number allowed at once.",
  },
]);

export const MISSED_CHOICES = Object.freeze([
  {
    id: "skip",
    label: "Skip what was missed",
    detail:
      "Times that passed while scheduling was off are recorded as missed.",
  },
  {
    id: "run-once",
    label: "Run once",
    detail: "One run for everything missed, then back on the timer.",
  },
  {
    id: "catch-up",
    label: "Catch up",
    detail: "One run per missed time, up to the limit.",
  },
]);

/**
 * What a recorded occurrence decision means, in words. Takes a history row
 * (detail nested under `detail`) or a schedule's `lastResult` (the same
 * fields spread at the top level).
 */
export function scheduleOutcome(run) {
  const detail = run?.detail ?? run ?? {};
  switch (run?.outcome) {
    case "started":
      return {
        label: detail.manual ? "Started by hand" : "Started",
        tone: "ok",
        detail: null,
      };
    case "queued":
      return {
        label: "Waiting for a free slot",
        tone: "warn",
        detail:
          "The previous run is still going; this one starts when it ends.",
      };
    case "skipped-overlap":
      return {
        label: "Skipped: previous run still going",
        tone: "muted",
        detail: null,
      };
    case "skipped-quiet":
      return {
        label: detail.deferredTo
          ? "Moved past quiet hours"
          : "Skipped: quiet hours",
        tone: "muted",
        detail: detail.deferredTo
          ? { kind: "deferred", at: detail.deferredTo }
          : null,
      };
    case "skipped-missed":
      return {
        label: "Missed while scheduling was off",
        tone: "muted",
        detail: null,
      };
    case "skipped-flag":
      return {
        label: "Skipped: turned off by a feature flag",
        tone: "muted",
        detail: null,
      };
    case "failed":
      return {
        label: "Could not start",
        tone: "bad",
        detail: detail.error ? { kind: "error", text: detail.error } : null,
      };
    default:
      return {
        label: String(run?.outcome ?? "Unknown"),
        tone: "muted",
        detail: null,
      };
  }
}

/**
 * Where a schedule stands. "Enabled" alone would be misleading while
 * scheduling as a whole is off: nothing starts until both are on.
 */
export function scheduleState(schedule, status) {
  if (schedule?.cancelledAt)
    return {
      key: "cancelled",
      label: "Cancelled",
      detail: "It will not run again. Its history is kept.",
    };
  if (!schedule?.enabled)
    return {
      key: "disabled",
      label: "Disabled",
      detail: "It starts only when you choose Run now.",
    };
  if (status && status.enabled === false)
    return {
      key: "waiting",
      label: "Enabled · scheduling is off",
      detail: "It starts on its timer once scheduling is turned on.",
    };
  return {
    key: "enabled",
    label: "Enabled",
    detail: "It starts on its timer.",
  };
}

/**
 * A time in a schedule's own zone: "Fri 12 Sep, 09:00 EDT". Falls back to
 * the browser's zone for an unknown zone rather than failing.
 */
export function formatInZone(ms, zone, locale = undefined) {
  if (!Number.isFinite(ms)) return null;
  const options = {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  };
  try {
    return new Intl.DateTimeFormat(locale, {
      ...options,
      timeZone: zone,
    }).format(ms);
  } catch {
    return new Intl.DateTimeFormat(locale, options).format(ms);
  }
}

/** The browser's own zone, for a new schedule's default. */
export function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Form state for a new schedule, or for editing an existing one. */
export function scheduleDraft(schedule = null) {
  const definition = schedule?.definition ?? {};
  return {
    name: schedule?.name ?? "",
    kind: schedule?.kind ?? "task",
    target: schedule?.target ?? "",
    prompt: definition.prompt ?? "",
    provider: definition.provider ?? "",
    inputs: { ...(definition.inputs ?? {}) },
    expression: schedule?.expression ?? "0 9 * * 1-5",
    timeZone: schedule?.timeZone ?? localTimeZone(),
    quiet: Boolean(schedule?.quietHours),
    quietStart: schedule?.quietHours?.start ?? "22:00",
    quietEnd: schedule?.quietHours?.end ?? "07:00",
    overlapPolicy: schedule?.overlapPolicy ?? "skip",
    maxConcurrent: schedule?.maxConcurrent ?? 1,
    missedRunPolicy: schedule?.missedRunPolicy ?? "skip",
    catchUpLimit: schedule?.catchUpLimit ?? 5,
  };
}

/**
 * What is missing before the draft can be sent, as readable problems. The
 * server validates again; this only saves a round trip for the obvious ones.
 */
export function draftProblems(draft, template = null) {
  const problems = [];
  if (!draft.name.trim()) problems.push("Give the schedule a name.");
  if (!draft.expression.trim()) problems.push("Choose when it runs.");
  if (draft.kind === "task" && !draft.target.trim())
    problems.push("Name the task it creates.");
  if (draft.kind === "workflow") {
    if (!draft.target) problems.push("Choose a workflow template.");
    for (const key of template?.inputKeys ?? [])
      if (!String(draft.inputs?.[key] ?? "").trim())
        problems.push(`The workflow needs a value for "${key}".`);
  }
  if (draft.quiet && draft.quietStart === draft.quietEnd)
    problems.push("Quiet hours need different start and end times.");
  return problems;
}

/** The body POST /api/workspaces/:id/schedules and PATCH /api/schedules/:id take. */
export function scheduleBody(draft, template = null) {
  const definition =
    draft.kind === "task"
      ? {
          prompt: draft.prompt.trim() || undefined,
          provider: draft.provider || undefined,
        }
      : {
          inputs: Object.fromEntries(
            (template?.inputKeys ?? Object.keys(draft.inputs ?? {})).map(
              (key) => [key, String(draft.inputs?.[key] ?? "").trim()],
            ),
          ),
        };
  return {
    name: draft.name.trim(),
    kind: draft.kind,
    target: draft.kind === "task" ? draft.target.trim() : draft.target,
    definition: JSON.parse(JSON.stringify(definition)),
    expression: draft.expression.trim(),
    timeZone: draft.timeZone,
    quietHours: draft.quiet
      ? { start: draft.quietStart, end: draft.quietEnd }
      : null,
    overlapPolicy: draft.overlapPolicy,
    maxConcurrent: Math.max(1, Math.min(20, Number(draft.maxConcurrent) || 1)),
    missedRunPolicy: draft.missedRunPolicy,
    catchUpLimit: Math.max(1, Math.min(100, Number(draft.catchUpLimit) || 5)),
  };
}
