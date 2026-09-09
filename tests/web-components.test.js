import test from "node:test";
import assert from "node:assert/strict";
import {
  formatElapsed,
  fuzzyScore,
  fuzzyFilter,
  groupToolEvents,
  layerGraph,
  parseDiff,
  attemptChain,
  maskPath,
  basename,
  expiresIn,
  toCsv,
  providerLabel,
  activityLabel,
  isActiveRun,
} from "../apps/web/src/hooks/useApi.js";

test("formatElapsed renders seconds, minutes and hours", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(-5), "0s");
  assert.equal(formatElapsed(59_000), "59s");
  assert.equal(formatElapsed(61_000), "1m 01s");
  assert.equal(formatElapsed(3_723_000), "1h 02m 03s");
});

test("fuzzy filter matches subsequences and ranks word starts higher", () => {
  assert.equal(fuzzyScore("", "anything"), 0);
  assert.equal(fuzzyScore("xyz", "open board"), -1);
  assert.ok(fuzzyScore("ob", "Open Board") > fuzzyScore("ob", "robot"));
  const commands = [
    { id: "a", label: "Switch workspace" },
    { id: "b", label: "New task" },
    { id: "c", label: "Open inbox" },
  ];
  assert.deepEqual(
    fuzzyFilter("nt", commands).map((c) => c.id),
    ["b"],
  );
  assert.equal(fuzzyFilter("   ", commands).length, 3);
});

test("groupToolEvents counts starts, ends and files per tool", () => {
  const events = [
    { kind: "tool.start", tool: "Edit", file: "a.js", timestamp: 1 },
    { kind: "tool.end", tool: "Edit", file: "a.js", timestamp: 2 },
    { kind: "tool.start", tool: "Edit", file: "b.js", timestamp: 3 },
    { kind: "tool.start", tool: "Bash", timestamp: 4, data: { isError: true } },
    { kind: "message", timestamp: 5 },
  ];
  const groups = groupToolEvents(events);
  assert.deepEqual(
    groups.map((g) => g.tool),
    ["Edit", "Bash"],
  );
  assert.equal(groups[0].starts, 2);
  assert.equal(groups[0].ends, 1);
  assert.deepEqual(groups[0].files, ["a.js", "b.js"]);
  assert.equal(groups[0].last, 3);
  assert.equal(groups[1].errors, 1);
});

test("layerGraph assigns longest-path layers and tolerates cycles", () => {
  const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const edges = [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "a", to: "c" },
  ];
  const { layers, position } = layerGraph(nodes, edges);
  assert.deepEqual(layers, [["a", "d"], ["b"], ["c"]]);
  assert.equal(position.get("c").layer, 2);
  const cyclic = layerGraph(nodes.slice(0, 2), [
    { from: "a", to: "b" },
    { from: "b", to: "a" },
  ]);
  assert.equal(cyclic.layers.flat().length, 2);
  // Edges to unknown nodes are ignored instead of throwing.
  const partial = layerGraph([{ id: "x" }], [{ from: "x", to: "missing" }]);
  assert.deepEqual(partial.layers, [["x"]]);
});

test("parseDiff classifies unified diff lines and handles CRLF", () => {
  const diff =
    "diff --git a/x b/x\r\n--- a/x\r\n+++ b/x\r\n@@ -1 +1 @@\r\n-old\r\n+new\r\n same";
  const types = parseDiff(diff).map((l) => l.type);
  assert.deepEqual(types, [
    "meta",
    "meta",
    "meta",
    "hunk",
    "del",
    "add",
    "context",
  ]);
});

test("attemptChain walks parentRunId links in both directions", () => {
  const runs = [
    { id: "r1", attempt: 1, parentRunId: null },
    { id: "r2", attempt: 2, parentRunId: "r1" },
    { id: "r3", attempt: 3, parentRunId: "r2" },
    { id: "other", attempt: 1, parentRunId: null },
  ];
  assert.deepEqual(
    attemptChain(runs[1], runs).map((r) => r.id),
    ["r1", "r2", "r3"],
  );
  assert.deepEqual(attemptChain(null, runs), []);
});

test("path helpers mask private paths and handle backslashes", () => {
  assert.equal(
    maskPath("C:\\Users\\me\\projects\\app", true),
    "…/projects/app",
  );
  assert.equal(
    maskPath("C:\\Users\\me\\projects\\app", false),
    "C:\\Users\\me\\projects\\app",
  );
  assert.equal(maskPath("/srv/app", true), "srv/app");
  assert.equal(basename("C:\\x\\y\\file.js"), "file.js");
  assert.equal(basename("/a/b/c.txt"), "c.txt");
  assert.equal(basename(null), "");
});

test("expiresIn reports remaining time or expiry", () => {
  const now = 1_000_000;
  assert.equal(expiresIn(null, now), "no expiry");
  assert.equal(expiresIn(now - 1, now), "expired");
  assert.equal(expiresIn(now + 90_000, now), "expires in 1m 30s");
});

test("toCsv escapes quotes, commas and newlines", () => {
  const csv = toCsv([{ a: 'say "hi"', b: "x,y", c: 3 }], ["a", "b", "c"]);
  assert.equal(csv, 'a,b,c\r\n"say ""hi""","x,y",3');
});

test("labels follow the UI vocabulary and never invent providers", () => {
  assert.equal(providerLabel("claude-code"), "Claude Code");
  assert.equal(providerLabel("simulated"), "Demo");
  assert.equal(providerLabel(undefined), "Manual");
  assert.equal(providerLabel("mystery"), "mystery");
  assert.equal(activityLabel("WAITING_APPROVAL"), "Needs approval");
  assert.equal(activityLabel(null), "Available");
  assert.equal(isActiveRun({ status: "waiting_approval" }), true);
  assert.equal(isActiveRun({ status: "completed" }), false);
  assert.equal(isActiveRun(null), false);
});
