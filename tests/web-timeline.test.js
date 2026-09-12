import test from "node:test";
import assert from "node:assert/strict";
import {
  placeRuns,
  runSpan,
  timeTicks,
  timelineRange,
  TIMELINE_ROW_LIMIT,
} from "../apps/web/src/views/timelineLogic.js";

const HOUR = 3_600_000;
const now = new Date(2026, 8, 11, 14, 30).getTime(); // local 11 Sep 14:30

test("a run in the window is placed as a share of it; an open run ends now", () => {
  const { start, end } = timelineRange([], "6h", now);
  assert.equal(end - start, 6 * HOUR);
  const { rows, total, hidden } = placeRuns(
    [
      {
        id: "a",
        status: "completed",
        startedAt: now - 3 * HOUR,
        endedAt: now - 2 * HOUR,
      },
      { id: "b", status: "running", startedAt: now - HOUR },
    ],
    { start, end, now },
  );
  assert.equal(total, 2);
  assert.equal(hidden, 0);
  assert.equal(Math.round(rows[0].left), 50);
  assert.equal(Math.round(rows[0].width), 17);
  // Running: from an hour ago to the right edge (now).
  assert.equal(Math.round(rows[1].left + rows[1].width), 100);
  assert.equal(rows[1].durationMs, HOUR);
});

test("a run that began before the window is clipped and says so", () => {
  // Observed on this machine: a session open for 1d 18h stretched the whole
  // axis, so every recent run became a sliver.
  const { start, end } = timelineRange([], "24h", now);
  const long = {
    id: "old",
    status: "running",
    startedAt: now - 42 * HOUR,
  };
  const [row] = placeRuns([long], { start, end, now }).rows;
  assert.equal(row.left, 0);
  assert.equal(row.beganEarlier, true);
  // The duration is still the run's own, not the window's.
  assert.equal(row.durationMs, 42 * HOUR);
});

test("a stale run shows recorded activity only up to its last event", () => {
  const stale = {
    status: "stale",
    startedAt: now - 4 * HOUR,
    lastEventAt: now - 3 * HOUR,
  };
  const span = runSpan(stale, now);
  assert.equal(span.solidEnd, now - 3 * HOUR);
  assert.equal(span.end, now);
  const { start, end } = timelineRange([], "6h", now);
  const [row] = placeRuns([stale], { start, end, now }).rows;
  assert.equal(Math.round(row.solidShare * 100), 25);
});

test("runs outside the window are left out and a cut is counted, not silent", () => {
  const { start, end } = timelineRange([], "1h", now);
  const runs = Array.from({ length: TIMELINE_ROW_LIMIT + 5 }, (_, i) => ({
    id: `r${i}`,
    status: "completed",
    startedAt: now - 50 * 60_000 + i * 1000,
    endedAt: now - 40 * 60_000 + i * 1000,
  }));
  runs.push({
    id: "yesterday",
    status: "completed",
    startedAt: now - 30 * HOUR,
    endedAt: now - 29 * HOUR,
  });
  const placed = placeRuns(runs, { start, end, now });
  assert.equal(placed.total, TIMELINE_ROW_LIMIT + 5);
  assert.equal(placed.hidden, 5);
  assert.equal(placed.rows.length, TIMELINE_ROW_LIMIT);
  // The most recent are kept.
  assert.equal(placed.rows.at(-1).run.id, `r${TIMELINE_ROW_LIMIT + 4}`);
  assert.equal(
    placed.rows.some((row) => row.run.id === "yesterday"),
    false,
  );
});

test("'All' starts just before the oldest run", () => {
  const runs = [{ startedAt: now - 10 * HOUR }, { startedAt: now - HOUR }];
  const { start, end } = timelineRange(runs, "all", now);
  assert.ok(start < now - 10 * HOUR);
  assert.ok(start > now - 11 * HOUR);
  assert.equal(end, now);
});

test("ticks land on round local times and name the day once it changes", () => {
  const format = {
    time: (t) => {
      const d = new Date(t);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    },
    day: (t) => `day${new Date(t).getDate()}`,
  };
  // Six hours inside one day: hourly ticks, no day labels.
  const sameDay = timeTicks(now - 6 * HOUR, now, { format });
  assert.ok(sameDay.length >= 3 && sameDay.length <= 7);
  for (const tick of sameDay) {
    assert.match(tick.time, /^\d\d:00$/);
    assert.equal(tick.day, null);
  }
  assert.ok(sameDay.every((tick, i, all) => i === 0 || tick.t > all[i - 1].t));

  // 42 hours back (from 9 Sep 20:30) crosses midnight twice. Six-hour ticks
  // start at 10 Sep 00:00; the first tick, and the first of each new day,
  // names the day.
  const multi = timeTicks(now - 42 * HOUR, now, { format });
  const days = multi.filter((tick) => tick.day).map((tick) => tick.day);
  assert.deepEqual(days, ["day10", "day11"]);
  assert.ok(multi[0].day);
  assert.ok(multi.every((tick) => tick.time));
  assert.ok(multi.every((tick) => tick.pct >= 0 && tick.pct <= 100));

  // Seven days: one tick per midnight, day only.
  const week = timeTicks(now - 7 * 24 * HOUR, now, { format });
  assert.ok(week.every((tick) => tick.time === null && tick.day));
  assert.ok(week.every((tick) => new Date(tick.t).getHours() === 0));
});
