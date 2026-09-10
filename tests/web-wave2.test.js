import test from "node:test";
import assert from "node:assert/strict";

/**
 * Wave-2 web surfaces: the pure helpers behind the new components and views.
 *
 * These are node:test units, so they import only modules that do not touch the
 * DOM at import time. React components themselves are exercised by the
 * Playwright suite, not here.
 */
import {
  maskText,
  maskAccount,
  maskArtifact,
  maskPath,
} from "../apps/web/src/hooks/useApi.js";
import { pushRecent, toggleIn } from "../apps/web/src/hooks/useLocalStorage.js";
import {
  DEFAULT_FILTERS,
  describeFilters,
  filtersAreEmpty,
  taskMatchesFilters,
  runMatchesFilters,
  agentMatchesFilters,
  windowRange,
  assignmentCompatibility,
  buildChapter,
  orderByUrgency,
  urgencyRank,
  moveInList,
  normalizeHeatmap,
  SAMPLE_SCOPE,
  ONBOARDING_STEP_IDS,
} from "../apps/web/src/hooks/viewLogic.js";

/* ------------------------------------------------------------------ */
/* Shared selection and filters                                        */
/* ------------------------------------------------------------------ */

test("shared filters narrow tasks, runs and agents by the same criteria", () => {
  assert.ok(filtersAreEmpty(DEFAULT_FILTERS));
  assert.ok(filtersAreEmpty({}));

  const filters = { ...DEFAULT_FILTERS, provider: "codex" };
  assert.equal(filtersAreEmpty(filters), false);
  assert.ok(taskMatchesFilters({ provider: "codex" }, filters));
  assert.equal(taskMatchesFilters({ provider: "claude-code" }, filters), false);
  assert.ok(runMatchesFilters({ provider: "codex" }, filters));
  assert.ok(agentMatchesFilters({ provider: "codex" }, filters));

  const text = { ...DEFAULT_FILTERS, query: "invoice" };
  assert.ok(taskMatchesFilters({ title: "Fix Invoice totals" }, text));
  assert.equal(taskMatchesFilters({ title: "Fix login" }, text), false);

  const chips = describeFilters({ provider: "codex", query: "invoice" });
  assert.deepEqual(
    chips.map((chip) => chip.key),
    ["provider", "query"],
  );
});

test("a null task or run never matches a filter set", () => {
  assert.equal(taskMatchesFilters(null, DEFAULT_FILTERS), false);
  assert.equal(runMatchesFilters(undefined, DEFAULT_FILTERS), false);
  assert.equal(agentMatchesFilters(null, DEFAULT_FILTERS), false);
});

/* ------------------------------------------------------------------ */
/* Virtualization                                                      */
/* ------------------------------------------------------------------ */

test("windowRange renders only the visible slice plus the overscan", () => {
  const window = windowRange({
    count: 10000,
    itemHeight: 20,
    height: 200,
    scrollTop: 4000,
    overscan: 2,
  });
  assert.equal(window.totalHeight, 200000);
  assert.equal(window.start, 198);
  assert.equal(window.offsetY, 3960);
  assert.ok(window.end - window.start < 20, "window stays small");
  assert.ok(window.end <= 10000);
});

test("windowRange is safe for an empty list and for a short one", () => {
  const empty = windowRange({
    count: 0,
    itemHeight: 20,
    height: 200,
    scrollTop: 0,
  });
  assert.deepEqual(empty, { start: 0, end: 0, offsetY: 0, totalHeight: 0 });
  const short = windowRange({
    count: 3,
    itemHeight: 20,
    height: 200,
    scrollTop: 0,
  });
  assert.equal(short.start, 0);
  assert.equal(short.end, 3);
});

/* ------------------------------------------------------------------ */
/* Drag-to-assign compatibility                                        */
/* ------------------------------------------------------------------ */

test("assignment compatibility refuses a provider mismatch and flags a busy agent", () => {
  const task = { id: "t1", provider: "codex" };
  const wrong = assignmentCompatibility(task, {
    id: "a1",
    provider: "claude-code",
  });
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, /Codex/);

  const busy = assignmentCompatibility(task, {
    id: "a2",
    provider: "codex",
    taskId: "other",
  });
  assert.equal(busy.ok, true);
  assert.equal(busy.level, "warn");

  const archived = assignmentCompatibility(task, {
    id: "a3",
    provider: "codex",
    archivedAt: 1,
  });
  assert.equal(archived.ok, false);

  const fine = assignmentCompatibility(task, { id: "a4", provider: "codex" });
  assert.equal(fine.ok, true);
  assert.equal(fine.level, "ok");
});

/* ------------------------------------------------------------------ */
/* Day in review                                                       */
/* ------------------------------------------------------------------ */

test("a day-in-review chapter keeps only recorded milestone events, in order", () => {
  const run = {
    id: "r1",
    title: "Fix the invoice totals",
    provider: "claude-code",
    mode: "managed",
    status: "completed",
    startedAt: 1000,
    endedAt: 5000,
  };
  const events = [
    {
      id: "e2",
      kind: "file.edit",
      sequence: 2,
      timestamp: 2000,
      summary: "Edited a.js",
      provenance: "provider",
    },
    {
      id: "e1",
      kind: "prompt",
      sequence: 1,
      timestamp: 1000,
      summary: "Prompt",
      provenance: "provider",
    },
    {
      id: "e3",
      kind: "message",
      sequence: 3,
      timestamp: 3000,
      summary: "chatter",
    },
    {
      id: "e4",
      kind: "test",
      sequence: 4,
      timestamp: 4000,
      summary: "npm test",
      provenance: "inferred",
    },
  ];
  const chapter = buildChapter(run, events, [
    { id: "art1", title: "diff", kind: "diff" },
  ]);
  assert.deepEqual(
    chapter.beats.map((beat) => beat.id),
    ["e1", "e2", "e4"],
    "message events are not milestones and the order follows sequence",
  );
  assert.equal(chapter.eventCount, 4);
  assert.equal(chapter.milestoneCount, 3);
  assert.equal(chapter.artifacts[0].id, "art1");
  for (const beat of chapter.beats)
    assert.ok(beat.event, "every beat cites the event it came from");
});

test("a run whose events were pruned yields an empty, honest chapter", () => {
  const chapter = buildChapter({ id: "r2", startedAt: 1 }, [], []);
  assert.equal(chapter.beats.length, 0);
  assert.equal(chapter.eventCount, 0);
});

/* ------------------------------------------------------------------ */
/* Decision inbox urgency ordering                                     */
/* ------------------------------------------------------------------ */

test("the inbox orders by urgency level, then score, then age", () => {
  const rows = [
    { id: "a", urgency: { level: "normal", score: 1 }, requestedAt: 10 },
    { id: "b", urgency: { level: "critical", score: 6 }, requestedAt: 40 },
    { id: "c", urgency: { level: "high", score: 4 }, requestedAt: 30 },
    { id: "d", urgency: { level: "high", score: 4 }, requestedAt: 20 },
    { id: "e", requestedAt: 5 },
  ];
  assert.deepEqual(
    orderByUrgency(rows).map((row) => row.id),
    ["b", "d", "c", "a", "e"],
  );
  assert.equal(urgencyRank({ urgency: { level: "critical" } }), 0);
  assert.equal(urgencyRank({}), 2, "no urgency means normal, never critical");
});

/* ------------------------------------------------------------------ */
/* Dependency editor                                                   */
/* ------------------------------------------------------------------ */

test("moveInList reorders a dependency and refuses to run off either end", () => {
  assert.deepEqual(moveInList(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.deepEqual(moveInList(["a", "b", "c"], "b", 1), ["a", "c", "b"]);
  assert.deepEqual(moveInList(["a", "b", "c"], "a", -1), ["a", "b", "c"]);
  assert.deepEqual(moveInList(["a", "b", "c"], "c", 1), ["a", "b", "c"]);
  assert.deepEqual(moveInList(["a"], "zz", 1), ["a"]);
  assert.deepEqual(moveInList(undefined, "a", 1), []);
});

/* ------------------------------------------------------------------ */
/* Analytics heatmap normalization and drill-down ids                  */
/* ------------------------------------------------------------------ */

test("normalizeHeatmap keeps the run ids behind each cell so it can drill down", () => {
  const blocked = [
    {
      taskId: "t1",
      title: "Task one",
      hour: 9,
      blockedMs: 120000,
      taskIds: ["t1"],
      runIds: ["r1"],
    },
    {
      taskId: "t1",
      title: "Task one",
      hour: 10,
      blockedMs: 60000,
      taskIds: ["t1"],
      runIds: ["r1", "r2"],
    },
    {
      taskId: "t2",
      title: "Task two",
      hour: 9,
      blockedMs: 30000,
      taskIds: ["t2"],
      runIds: [],
    },
  ];
  const heat = normalizeHeatmap(blocked);
  assert.equal(heat.rows.length, 2);
  assert.equal(heat.unit, "ms");
  assert.equal(heat.max, 120000);
  const first = heat.rows.find((row) => row.id === "t1");
  assert.equal(first.hours[9], 120000);
  assert.deepEqual(first.runIds[10], ["r1", "r2"]);
  assert.deepEqual(first.taskIds[9], ["t1"]);
});

test("normalizeHeatmap handles the workload shape and returns null for nothing", () => {
  const workload = normalizeHeatmap([
    { provider: "codex", hour: 3, runs: 2, runIds: ["r9"], taskIds: ["t9"] },
  ]);
  assert.equal(workload.rows[0].id, "codex");
  assert.equal(workload.rows[0].hours[3], 2);
  assert.equal(workload.unit, "count");
  assert.equal(normalizeHeatmap(null), null);
  assert.equal(normalizeHeatmap({ nothing: true }), null);
});

/* ------------------------------------------------------------------ */
/* Presentation (presenter) mode                                       */
/* ------------------------------------------------------------------ */

test("presentation mode hides task text, account labels and artifact titles", () => {
  assert.equal(
    maskText("Rotate the production database password", false),
    "Rotate the production database password",
  );
  const masked = maskText("Rotate the production database password", true);
  assert.match(masked, /^Rotate the …/);
  assert.match(masked, /3 words hidden/);
  assert.ok(!masked.includes("password"));

  assert.equal(maskText("Short title", true), "Short title");
  assert.equal(maskText("", true), "");

  const account = maskAccount("work@example.com", true);
  assert.equal(account.startsWith("w"), true);
  assert.ok(!account.includes("@"));
  assert.equal(maskAccount("work@example.com", false), "work@example.com");

  const artifact = maskArtifact(
    { id: "a", title: "diff for feature/secret-branch", kind: "diff" },
    true,
  );
  assert.ok(!artifact.title.includes("secret-branch"));
  assert.equal(artifact.kind, "diff");
  assert.equal(
    maskArtifact({ id: "a", title: "keep me", kind: "diff" }, false).title,
    "keep me",
  );

  // The existing path masking still applies to private absolute paths.
  assert.equal(
    maskPath("C:\\Users\\someone\\src\\app\\index.js", true),
    "…/app/index.js",
  );
});

/* ------------------------------------------------------------------ */
/* Per-browser preference helpers                                      */
/* ------------------------------------------------------------------ */

test("recent workspaces are newest-first, deduplicated and bounded", () => {
  let list = pushRecent([], "a");
  list = pushRecent(list, "b");
  list = pushRecent(list, "a");
  assert.deepEqual(list, ["a", "b"]);
  const many = Array.from({ length: 20 }, (_, i) => `w${i}`).reduce(
    (acc, id) => pushRecent(acc, id, 5),
    [],
  );
  assert.equal(many.length, 5);
  assert.equal(many[0], "w19");
  assert.deepEqual(pushRecent(["a"], null), ["a"]);
});

test("pinned runs toggle in and out and stay bounded", () => {
  let pinned = toggleIn([], "r1");
  assert.deepEqual(pinned, ["r1"]);
  pinned = toggleIn(pinned, "r2");
  assert.deepEqual(pinned, ["r2", "r1"]);
  pinned = toggleIn(pinned, "r1");
  assert.deepEqual(pinned, ["r2"]);
  const capped = Array.from({ length: 30 }, (_, i) => `r${i}`).reduce(
    (acc, id) => toggleIn(acc, id, 4),
    [],
  );
  assert.equal(capped.length, 4);
  assert.deepEqual(toggleIn(["a"], null), ["a"]);
});

/* ------------------------------------------------------------------ */
/* Onboarding copy                                                     */
/* ------------------------------------------------------------------ */

test("onboarding starts with the credential-free demo and states the resource assumptions", () => {
  assert.equal(ONBOARDING_STEP_IDS[0], "demo");
  assert.equal(ONBOARDING_STEP_IDS[1], "connect");
  assert.equal(
    ONBOARDING_STEP_IDS[ONBOARDING_STEP_IDS.length - 1],
    "billing",
    "the last step explains who bills what",
  );
  assert.ok(SAMPLE_SCOPE.length >= 3);
  assert.ok(
    SAMPLE_SCOPE.some((line) => /provider quota|billed|never buys/i.test(line)),
    "the sample scope states that provider usage is the user's own spend",
  );
  assert.ok(
    SAMPLE_SCOPE.some((line) => /No files are written/i.test(line)),
    "the sample scope states that no repository files are created",
  );
});
