import test from "node:test";
import assert from "node:assert/strict";
import { claudeCodeAdapter } from "../packages/core/src/adapters/claudeCode.js";
import {
  captureTestOutput,
  formatTestOutput,
} from "../packages/core/src/runs/artifacts.js";

/**
 * Claude Code reports a command and its result as two separate events: the
 * tool call (classified `test` when it runs a suite) and, later, the tool
 * result — `tool.end`, or `error` when the command exits non-zero — carrying
 * the same toolUseId and the output.
 *
 * The test-output artifact read output only from the first of those, so a
 * failing suite produced an artifact holding the command line and nothing
 * else: the one time the output was the whole point. Seen on a real Claude
 * Code run on 2026-09-15, where the output was sitting in the event stream.
 */

function parse(records) {
  const state = {};
  const events = [];
  for (const record of records)
    events.push(...claudeCodeAdapter.parse(JSON.stringify(record), state));
  // RunRecorder stores an event's summary as its message.
  return events.map((event) => ({ ...event, message: event.summary }));
}

const call = (id, command) => ({
  type: "assistant",
  session_id: "session-1",
  message: {
    id: `msg_${id}`,
    content: [{ type: "tool_use", id, name: "Bash", input: { command } }],
  },
});

const result = (id, content, isError) => ({
  type: "user",
  session_id: "session-1",
  message: {
    content: [
      { type: "tool_result", tool_use_id: id, is_error: isError, content },
    ],
  },
});

test("a failing test run keeps its output and its exit code", () => {
  const tests = captureTestOutput(
    parse([
      call("toolu_fail", "node --test"),
      result(
        "toolu_fail",
        "Exit code 1\n✔ lowercasing (5ms)\n✖ maxLength with no trailing separator\n  expected: 'hello-world'",
        true,
      ),
    ]),
  );
  assert.equal(tests.length, 1);
  assert.equal(tests[0].command, "node --test");
  assert.match(tests[0].output ?? "", /✖ maxLength with no trailing separator/);
  assert.equal(tests[0].exitCode, 1);
  assert.match(
    formatTestOutput(tests),
    /^\$ node --test \(exit 1\)\n.*✔ lowercasing/s,
  );
});

test("a passing test run keeps its output, and no exit code is invented", () => {
  const [run] = captureTestOutput(
    parse([
      call("toolu_pass", "npm test"),
      result("toolu_pass", "✔ all 8 tests passed", false),
    ]),
  );
  assert.match(run.output ?? "", /all 8 tests passed/);
  // Claude Code states no exit code for a command that succeeded, and a zero
  // written here would be a guess presented as a report.
  assert.equal(run.exitCode, null);
});

test("each command gets its own result, never its neighbour's", () => {
  const tests = captureTestOutput(
    parse([
      call("toolu_a", "node --test"),
      call("toolu_b", "npm test"),
      result("toolu_b", "B passed", false),
      result("toolu_a", "Exit code 2\nA failed", true),
    ]),
  );
  assert.deepEqual(
    tests.map((t) => [t.command, t.output, t.exitCode]),
    [
      ["node --test", "Exit code 2\nA failed", 2],
      ["npm test", "B passed", null],
    ],
  );
});

test("a command that never reported back is captured without output", () => {
  const [run] = captureTestOutput(parse([call("toolu_open", "node --test")]));
  assert.equal(run.command, "node --test");
  assert.equal(run.output, null);
  assert.equal(run.exitCode, null);
});
