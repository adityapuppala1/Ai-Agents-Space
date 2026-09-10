import { InputError } from "../TaskStore.js";

/**
 * Hand-written five-field cron parser plus a simple interval form, with the
 * next occurrence computed IN an IANA time zone.
 *
 *   minute hour day-of-month month day-of-week
 *
 * Supported per field: `*`, lists (`1,15`), ranges (`1-5`), steps (`* /5`,
 * `1-30/10`), month names (jan..dec) and day names (sun..sat, 0 or 7 = Sunday).
 * Day-of-month and day-of-week follow the classic rule: when both are
 * restricted an occurrence matches if EITHER does; when one is `*` only the
 * other counts.
 *
 * Interval form: `every <n> <minutes|hours|days>` (n >= 1). Its next
 * occurrence is `fromMs + n * unit`, which does not depend on a zone.
 *
 * Time zones: wall-clock parts are read with Intl.DateTimeFormat for every
 * candidate instant, so DST gaps and overlaps are handled by looking at real
 * instants rather than by adding hours to a local Date. A wall time that does
 * not exist (spring-forward gap) is never returned; a wall time that occurs
 * twice (fall-back) is returned once, at its first instant.
 */

const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const FIELDS = [
  { name: "minute", min: 0, max: 59, names: null },
  { name: "hour", min: 0, max: 23, names: null },
  { name: "day-of-month", min: 1, max: 31, names: null },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  { name: "day-of-week", min: 0, max: 7, names: DAY_NAMES, nameBase: 0 },
];

const INTERVAL_UNITS = {
  minute: 60_000,
  minutes: 60_000,
  hour: 3_600_000,
  hours: 3_600_000,
  day: 86_400_000,
  days: 86_400_000,
};

/** Upper bound on the search so a never-matching expression cannot spin. */
const MAX_STEPS = 400_000;
const MINUTE = 60_000;

/** True when `zone` is an IANA zone Intl knows about. */
export function isValidTimeZone(zone) {
  if (typeof zone !== "string" || !zone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function fieldValue(token, field) {
  const text = token.toLowerCase();
  if (field.names) {
    const index = field.names.indexOf(text);
    if (index >= 0) return index + field.nameBase;
  }
  if (!/^\d{1,2}$/.test(text))
    throw new InputError(`Invalid ${field.name} value "${token}"`);
  const value = Number(text);
  if (value < field.min || value > field.max)
    throw new InputError(
      `${field.name} value ${value} is outside ${field.min}-${field.max}`,
    );
  return value;
}

function parseField(spec, field) {
  const values = new Set();
  let star = false;
  for (const part of spec.split(",")) {
    if (!part) throw new InputError(`Empty ${field.name} entry`);
    const [rangeText, stepText, ...rest] = part.split("/");
    if (rest.length) throw new InputError(`Invalid ${field.name} "${part}"`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d{1,2}$/.test(stepText) || Number(stepText) < 1)
        throw new InputError(`Invalid ${field.name} step "${stepText}"`);
      step = Number(stepText);
    }
    let low;
    let high;
    if (rangeText === "*") {
      low = field.min;
      high = field.max;
      if (stepText === undefined) star = true;
    } else if (rangeText.includes("-")) {
      const [a, b, ...more] = rangeText.split("-");
      if (more.length || !a || !b)
        throw new InputError(`Invalid ${field.name} range "${rangeText}"`);
      low = fieldValue(a, field);
      high = fieldValue(b, field);
      if (low > high)
        throw new InputError(`${field.name} range "${rangeText}" is reversed`);
    } else {
      low = fieldValue(rangeText, field);
      high = stepText === undefined ? low : field.max;
    }
    for (let v = low; v <= high; v += step) values.add(v);
  }
  // 7 is an alias for Sunday.
  if (field.name === "day-of-week" && values.has(7)) {
    values.delete(7);
    values.add(0);
  }
  return { values, star };
}

/**
 * parse("*\/5 9-17 * * mon-fri") → { kind: "cron", fields, source }
 * parse("every 15 minutes")      → { kind: "interval", ms, source }
 * Throws InputError for anything else.
 */
export function parse(expression) {
  if (typeof expression !== "string" || !expression.trim())
    throw new InputError("Schedule expression is required");
  const source = expression.trim().replace(/\s+/g, " ");
  const interval = source.match(/^every (\d{1,6}) ([a-z]+)$/i);
  if (interval) {
    const n = Number(interval[1]);
    const unit = INTERVAL_UNITS[interval[2].toLowerCase()];
    if (!unit || n < 1)
      throw new InputError(
        'Interval must be "every <n> <minutes|hours|days>" with n >= 1',
      );
    return { kind: "interval", ms: n * unit, source };
  }
  const tokens = source.split(" ");
  if (tokens.length !== 5)
    throw new InputError(
      "Cron expression needs five fields: minute hour day-of-month month day-of-week",
    );
  const parsed = tokens.map((token, index) => parseField(token, FIELDS[index]));
  return {
    kind: "cron",
    source,
    fields: {
      minute: parsed[0].values,
      hour: parsed[1].values,
      dayOfMonth: parsed[2].values,
      month: parsed[3].values,
      dayOfWeek: parsed[4].values,
      dayOfMonthStar: parsed[2].star,
      dayOfWeekStar: parsed[4].star,
    },
  };
}

const formatters = new Map();
function formatter(zone) {
  let fmt = formatters.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formatters.set(zone, fmt);
  }
  return fmt;
}

/** Wall-clock parts of the instant `ms` in `zone`. */
export function wallClock(ms, zone) {
  const out = {};
  for (const part of formatter(zone).formatToParts(new Date(ms))) {
    if (part.type === "weekday")
      out.weekday = DAY_NAMES.indexOf(part.value.toLowerCase().slice(0, 3));
    else if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  // Intl may report hour 24 for midnight in some engines even with h23.
  if (out.hour === 24) out.hour = 0;
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour,
    minute: out.minute,
    weekday: out.weekday,
  };
}

/** Zone offset (ms) at the instant, derived from the wall clock. */
function offsetAt(ms, zone) {
  const p = wallClock(ms, zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - ms;
}

/**
 * Instant for a wall-clock time in `zone`. Calendar overflow is allowed
 * (day 32 rolls into the next month). For a time inside a DST gap the result
 * is the instant with the offset in force just before the gap; callers that
 * need an exact wall time verify with wallClock().
 */
export function wallToUtc({ year, month, day, hour = 0, minute = 0 }, zone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = offsetAt(guess, zone);
  let candidate = guess - first;
  const second = offsetAt(candidate, zone);
  if (second !== first) candidate = guess - second;
  return candidate;
}

function matchesDay(fields, p) {
  const dom = fields.dayOfMonth.has(p.day);
  const dow = fields.dayOfWeek.has(p.weekday);
  if (fields.dayOfMonthStar && fields.dayOfWeekStar) return true;
  if (fields.dayOfMonthStar) return dow;
  if (fields.dayOfWeekStar) return dom;
  return dom || dow;
}

/**
 * Next occurrence strictly after `fromMs`, as an epoch ms, computed in
 * `timeZone`. Returns null when nothing matches within the search bound.
 * Throws InputError for an invalid expression or an unknown zone.
 */
export function next(expression, fromMs = Date.now(), timeZone = "UTC") {
  const spec = typeof expression === "string" ? parse(expression) : expression;
  if (!Number.isFinite(fromMs)) throw new InputError("fromMs must be a number");
  if (spec.kind === "interval") return fromMs + spec.ms;
  if (!isValidTimeZone(timeZone))
    throw new InputError(`Unknown time zone "${timeZone}"`);
  const { fields } = spec;
  let t = Math.floor(fromMs / MINUTE) * MINUTE + MINUTE;
  for (let steps = 0; steps < MAX_STEPS; steps++) {
    const p = wallClock(t, timeZone);
    let jump = null;
    if (!fields.month.has(p.month)) {
      jump = wallToUtc(
        p.month === 12
          ? { year: p.year + 1, month: 1, day: 1 }
          : { year: p.year, month: p.month + 1, day: 1 },
        timeZone,
      );
    } else if (!matchesDay(fields, p)) {
      jump = wallToUtc(
        { year: p.year, month: p.month, day: p.day + 1 },
        timeZone,
      );
    } else if (!fields.hour.has(p.hour)) {
      jump = wallToUtc(
        { year: p.year, month: p.month, day: p.day, hour: p.hour + 1 },
        timeZone,
      );
    } else if (!fields.minute.has(p.minute)) {
      jump = t + MINUTE;
    } else {
      return t;
    }
    // A DST transition can make a wall-clock jump land at or before `t`;
    // always move forward by at least one minute so the search terminates.
    t = jump > t ? jump : t + MINUTE;
  }
  return null;
}

/** "HH:MM" → minutes since midnight, or throws. */
export function parseClock(text, label = "time") {
  const m = typeof text === "string" && text.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new InputError(`${label} must be HH:MM`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59)
    throw new InputError(`${label} must be a valid HH:MM`);
  return hour * 60 + minute;
}

/**
 * Quiet-hours check in a zone. `window` is { start: "22:00", end: "07:00" };
 * a window that crosses midnight is supported. Returns
 * { inside: boolean, endsAt: ms | null } where endsAt is the first instant
 * at or after `ms` whose wall clock is the window's end.
 */
export function quietHoursAt(ms, window, zone) {
  if (!window) return { inside: false, endsAt: null };
  const start = parseClock(window.start, "quietHours.start");
  const end = parseClock(window.end, "quietHours.end");
  if (start === end) return { inside: false, endsAt: null };
  const p = wallClock(ms, zone);
  const now = p.hour * 60 + p.minute;
  const inside = start < end ? now >= start && now < end : now >= start || now < end;
  if (!inside) return { inside: false, endsAt: null };
  const endHour = Math.floor(end / 60);
  const endMinute = end % 60;
  const sameDay = now < end;
  const endsAt = wallToUtc(
    {
      year: p.year,
      month: p.month,
      day: sameDay ? p.day : p.day + 1,
      hour: endHour,
      minute: endMinute,
    },
    zone,
  );
  return { inside: true, endsAt: endsAt > ms ? endsAt : ms + MINUTE };
}
