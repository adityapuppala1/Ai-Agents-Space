import test from "node:test";
import assert from "node:assert/strict";
import {
  clearBinaryLookupCache,
  resolveBinary,
} from "../packages/core/src/runs/process.js";

/**
 * Resolving a provider binary happens on the main thread, so whatever it
 * waits for, every open page and WebSocket waits for too. These tests pin the
 * two properties that keep that honest: the wait is bounded, and it is not
 * repeated for every launch attempt.
 */

/** An environment whose PATH contains nothing, so resolution must fall back. */
const emptyPath = () => ({ PATH: "", PATHEXT: ".EXE" });

test("a binary that cannot be found resolves quickly, not eventually", () => {
  clearBinaryLookupCache();
  const started = Date.now();
  const result = resolveBinary("claude-code", emptyPath(), {
    names: ["definitely-not-installed-agent-space-probe"],
  });
  const took = Date.now() - started;
  assert.equal(result.resolved, false, "it reports the miss honestly");
  // The fallback is capped well under a second. Before this cap it could hold
  // the whole server for five.
  assert.ok(took < 3000, `binary lookup held the thread for ${took} ms`);
});

test("a miss is remembered, so a burst of launches pays for it once", () => {
  clearBinaryLookupCache();
  const env = emptyPath();
  const names = ["definitely-not-installed-agent-space-probe"];
  const first = Date.now();
  resolveBinary("claude-code", env, { names });
  const firstTook = Date.now() - first;

  const second = Date.now();
  for (let i = 0; i < 25; i += 1) resolveBinary("claude-code", env, { names });
  const repeatTook = Date.now() - second;

  // Twenty-five more attempts must not cost twenty-five more lookups.
  assert.ok(
    repeatTook <= firstTook + 50,
    `25 cached lookups took ${repeatTook} ms against ${firstTook} ms for one`,
  );
});

test("the cache never answers for a different PATH", () => {
  clearBinaryLookupCache();
  const names = ["definitely-not-installed-agent-space-probe"];
  const miss = resolveBinary("claude-code", emptyPath(), { names });
  assert.equal(miss.resolved, false);
  // A different environment is a different question; an explicit override is
  // the clearest case of one, and must not be shadowed by the cached miss.
  const overridden = resolveBinary(
    "claude-code",
    { ...emptyPath(), AGENT_SPACE_BIN_CLAUDE_CODE: "node --version" },
    { names },
  );
  assert.equal(overridden.resolved, true);
  assert.equal(overridden.command, "node");
  assert.deepEqual(overridden.args, ["--version"]);
});

test("an injected resolver still bypasses the lookup entirely", () => {
  clearBinaryLookupCache();
  const asked = [];
  const result = resolveBinary(
    "claude-code",
    emptyPath(),
    {
      names: ["whatever"],
      which: (binary) => {
        asked.push(binary);
        return "C:\\tools\\whatever.exe";
      },
    },
  );
  assert.deepEqual(asked, ["whatever"]);
  assert.equal(result.resolved, true);
  assert.equal(result.command, "C:\\tools\\whatever.exe");
});
