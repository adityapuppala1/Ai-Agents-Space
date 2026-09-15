import test from "node:test";
import assert from "node:assert/strict";
import {
  rowProgress,
  taskSourceLabel,
} from "../apps/web/src/hooks/viewLogic.js";

/**
 * The task list and the task details kept their own copies of two small
 * labels, and both were wrong for work a provider runs. Seen on 2026-09-15
 * with three Claude Code tasks: every row read "Manual task", and a task whose
 * run had finished and been rejected still read "In progress · 0%" — the
 * percentage nobody ever set, on the view people actually look at.
 */

const now = Date.parse("2026-09-15T05:30:00.000Z");

test("a task typed in by hand but run by a provider is not called manual", () => {
  assert.equal(
    taskSourceLabel({ source: "manual", provider: "claude-code" }),
    "Provider task",
  );
  assert.equal(
    taskSourceLabel({ source: "manual" }, { mode: "managed" }),
    "Provider task",
  );
  assert.equal(
    taskSourceLabel({ source: "manual" }, { mode: "manual" }),
    "Manual task",
  );
  assert.equal(taskSourceLabel({ source: "manual" }), "Manual task");
  // Every other source keeps its own name, whatever runs it.
  assert.equal(
    taskSourceLabel({ source: "demo", provider: "claude-code" }),
    "Demo task",
  );
  assert.equal(taskSourceLabel({ source: "observed" }), "Observed session");
  assert.equal(taskSourceLabel({ source: "workflow" }), "Workflow step");
  assert.equal(taskSourceLabel({ source: "launcher" }), "Launched task");
});

test("a task row never shows a percentage for provider work", () => {
  const bound = { status: "IN_PROGRESS", progress: 0, provider: "claude-code" };
  assert.equal(rowProgress(bound, null, now), "Not launched");
  assert.equal(
    rowProgress(bound, { mode: "manual", status: "running" }, now),
    "Not launched",
  );
  assert.equal(
    rowProgress(
      bound,
      {
        mode: "managed",
        status: "completed",
        startedAt: "2026-09-15T05:28:25.000Z",
        endedAt: "2026-09-15T05:29:13.000Z",
      },
      now,
    ),
    "48s",
  );
  assert.equal(
    rowProgress(
      bound,
      {
        mode: "observed",
        status: "running",
        startedAt: "2026-09-15T05:29:00.000Z",
      },
      now,
    ),
    "1m 00s",
  );
  assert.equal(
    rowProgress(bound, { mode: "managed", status: "queued" }, now),
    "—",
  );
});

test("manual work keeps the percentage a person set", () => {
  assert.equal(
    rowProgress({ status: "IN_PROGRESS", progress: 30 }, null, now),
    "30%",
  );
  assert.equal(
    rowProgress(
      { status: "IN_PROGRESS", progress: 30 },
      { mode: "manual", status: "running" },
      now,
    ),
    "30%",
  );
  // A finished provider task with no run on record is not "Not launched".
  assert.equal(
    rowProgress(
      { status: "COMPLETED", progress: 100, provider: "claude-code" },
      null,
      now,
    ),
    "100%",
  );
});
