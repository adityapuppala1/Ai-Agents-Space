import test from "node:test";
import assert from "node:assert/strict";
import { changedFiles } from "../apps/web/src/office/data.js";

/**
 * What the review table says a review is about.
 *
 * The board has always named the artifacts linked to it — "2 artifacts
 * linked" — which tells you a review exists without telling you what it is
 * about. The changed files are on the diff artifact's own metadata, so the
 * board can name them. The rule that matters: a review with no recorded diff
 * and a review of nothing are different facts and must read differently.
 */

const reviewers = [{ id: "nova", name: "Nova" }];

const withFiles = (files) => ({
  nova: [{ id: "a1", kind: "diff", title: "Diff", metadata: { files } }],
});

test("the board names the files the diff recorded", () => {
  const changed = changedFiles(
    withFiles([
      { path: "src/app.js", status: "M" },
      { path: "src/api/routes.js", status: "M" },
      { path: "README.md", status: "A" },
    ]),
    reviewers,
  );
  assert.equal(changed.count, 3, "the count is every file, not just the named");
  assert.deepEqual(changed.names, ["app.js", "routes.js"]);
});

test("no recorded diff is not the same as nothing changed", () => {
  // An artifact with no file list at all.
  assert.equal(
    changedFiles({ nova: [{ id: "a1", kind: "message", title: "Final" }] }, reviewers),
    null,
  );
  // An artifact whose file list is empty.
  assert.equal(changedFiles(withFiles([]), reviewers), null);
  // Nobody at the table.
  assert.equal(changedFiles(withFiles([{ path: "a.js" }]), []), null);
  // No artifacts at all.
  assert.equal(changedFiles(null, reviewers), null);
});

test("a single file is counted as one, not pluralised by the caller's hope", () => {
  const changed = changedFiles(withFiles([{ path: "only.js", status: "M" }]), reviewers);
  assert.equal(changed.count, 1);
  assert.deepEqual(changed.names, ["only.js"]);
});

test("presentation mode never shows a path on the wall", () => {
  const changed = changedFiles(
    withFiles([{ path: "C:\\Users\\someone\\secret\\app.js", status: "M" }]),
    reviewers,
    { mask: true },
  );
  assert.deepEqual(changed.names, ["app.js"]);
  assert.ok(!changed.names[0].includes("someone"));
});

test("it reads the first reviewer who actually recorded a diff", () => {
  const changed = changedFiles(
    {
      nova: [{ id: "m", kind: "message", title: "Final" }],
      echo: [
        { id: "d", kind: "diff", title: "Diff", metadata: { files: [{ path: "x/y.ts" }] } },
      ],
    },
    [
      { id: "nova", name: "Nova" },
      { id: "echo", name: "Echo" },
    ],
  );
  assert.equal(changed.count, 1);
  assert.deepEqual(changed.names, ["y.ts"]);
});

test("a plain list of paths is read as well as a list of records", () => {
  const changed = changedFiles(withFiles(["src/one.js", "src/two.js"]), reviewers);
  assert.equal(changed.count, 2);
  assert.deepEqual(changed.names, ["one.js", "two.js"]);
});

test("the exact line the board draws is pinned here, since a canvas cannot be read back", async () => {
  const { changedSummary } = await import("../apps/web/src/office/data.js");
  assert.equal(
    changedSummary({ count: 3, names: ["app.js", "routes.js"] }),
    "3 files changed: app.js, routes.js",
  );
  assert.equal(
    changedSummary({ count: 1, names: ["only.js"] }),
    "1 file changed: only.js",
  );
  // A count with no names still reads correctly, singular and plural.
  assert.equal(changedSummary({ count: 1, names: [] }), "1 file changed");
  assert.equal(changedSummary({ count: 7, names: [] }), "7 files changed");
  // The distinction the whole feature turns on.
  assert.equal(changedSummary(null), "no diff recorded");
});
