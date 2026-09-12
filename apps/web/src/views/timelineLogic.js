/**
 * Pure layout for the run timeline: which runs fall in the chosen window,
 * where each bar starts and ends as a percentage of the window, and axis
 * ticks that say the day as well as the time once the window crosses
 * midnight. Kept free of React so the rules are unit-tested.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const TIMELINE_WINDOWS = [
  { id: "1h", label: "1 hour", ms: HOUR },
  { id: "6h", label: "6 hours", ms: 6 * HOUR },
  { id: "24h", label: "24 hours", ms: DAY },
  { id: "7d", label: "7 days", ms: 7 * DAY },
  { id: "all", label: "All", ms: null },
];

/** More rows than this stop being readable; the page says when it cuts. */
export const TIMELINE_ROW_LIMIT = 60;

const toMs = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const ms = typeof value === "number" ? value : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

/**
 * A run on the clock. An open run ends now. A stale run's activity is known
 * only up to its last recorded event, so `solidEnd` stops there and the rest
 * of the bar is drawn as a gap in the record, not as work.
 */
export function runSpan(run, now) {
  const start = toMs(run.startedAt);
  const end = Math.max(start ?? now, toMs(run.endedAt) ?? now);
  const last = toMs(run.lastEventAt);
  const solidEnd =
    run.status === "stale" && last !== null
      ? Math.min(Math.max(last, start), end)
      : end;
  return { start, end, solidEnd };
}

/** The window's start and end. "All" starts just before the oldest run. */
export function timelineRange(runs, windowId, now) {
  const choice =
    TIMELINE_WINDOWS.find((entry) => entry.id === windowId) ??
    TIMELINE_WINDOWS[2];
  if (choice.ms) return { start: now - choice.ms, end: now };
  const starts = runs
    .map((run) => toMs(run.startedAt))
    .filter((t) => t !== null);
  const oldest = starts.length ? Math.min(...starts) : now - HOUR;
  const span = Math.max(now - oldest, MINUTE);
  return { start: oldest - span * 0.02, end: now };
}

/**
 * Rows for the runs that overlap the window, oldest first. When more than
 * `limit` overlap, the most recent `limit` are kept and `hidden` says how
 * many were left out, so the cut is never silent.
 */
export function placeRuns(
  runs,
  { start, end, now, limit = TIMELINE_ROW_LIMIT },
) {
  const span = Math.max(end - start, 1);
  const pct = (t) => ((Math.min(Math.max(t, start), end) - start) / span) * 100;
  const overlapping = runs
    .filter((run) => toMs(run.startedAt) !== null)
    .map((run) => ({ run, ...runSpan(run, now) }))
    .filter((row) => row.end >= start && row.start <= end)
    .sort((a, b) => a.start - b.start);
  const shown = overlapping.slice(-limit);
  return {
    total: overlapping.length,
    hidden: overlapping.length - shown.length,
    rows: shown.map((row) => {
      const left = pct(row.start);
      const width = Math.max(0, pct(row.end) - left);
      const solid = Math.max(0, pct(row.solidEnd) - left);
      return {
        run: row.run,
        durationMs: Math.max(0, row.end - row.start),
        left,
        width,
        // Share of the bar that is recorded activity (1 unless stale).
        solidShare: width > 0 ? Math.min(1, solid / width) : 1,
        beganEarlier: row.start < start,
      };
    }),
  };
}

const STEPS = [
  MINUTE,
  2 * MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
];

const defaultFormat = {
  time: (t) =>
    new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  day: (t) =>
    new Date(t).toLocaleDateString([], { weekday: "short", day: "numeric" }),
};

/**
 * Axis ticks on round local times (every 15 minutes, every 3 hours, each
 * midnight…), at most `maxTicks`. When the window spans more than one
 * calendar day, the first tick of each day carries the day as well, so a
 * 14:00 tick is never ambiguous; day-sized steps show the day only.
 */
export function timeTicks(start, end, { maxTicks = 7, format } = {}) {
  const fmt = { ...defaultFormat, ...format };
  const span = Math.max(end - start, 1);
  const step = STEPS.find((size) => span / size <= maxTicks) ?? STEPS.at(-1);
  const times = [];
  let t;
  if (step < DAY) {
    // Round in local time: local = UTC - offset (getTimezoneOffset is
    // UTC minus local, in minutes), so a 3-hour step lands on 09:00, 12:00…
    const offset = new Date(start).getTimezoneOffset() * MINUTE;
    t = Math.ceil((start - offset) / step) * step + offset;
  } else {
    const midnight = new Date(start);
    midnight.setHours(0, 0, 0, 0);
    if (midnight.getTime() < start) midnight.setDate(midnight.getDate() + 1);
    t = midnight.getTime();
  }
  while (t <= end && times.length < 50) {
    times.push(t);
    if (step < DAY) t += step;
    else {
      const next = new Date(t);
      next.setDate(next.getDate() + step / DAY);
      t = next.getTime();
    }
  }
  const multiDay =
    new Date(start).toDateString() !== new Date(end).toDateString();
  let lastDay = null;
  return times.map((time) => {
    const day = new Date(time).toDateString();
    const newDay = day !== lastDay;
    lastDay = day;
    return {
      t: time,
      pct: ((time - start) / span) * 100,
      time: step >= DAY ? null : fmt.time(time),
      day: step >= DAY || (multiDay && newDay) ? fmt.day(time) : null,
    };
  });
}
