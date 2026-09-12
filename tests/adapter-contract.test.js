import test from "node:test";
import assert from "node:assert/strict";
import { defaultAdapters } from "../packages/core/src/adapters/index.js";
import { EVENT_KINDS, PROVIDERS } from "../packages/core/src/contracts.js";
import { InputError } from "../packages/core/src/TaskStore.js";

/**
 * The contract every adapter has to meet, run against every adapter there is.
 *
 * Until this existed each adapter was tested only on its own terms — its own
 * fixtures, its own stream, its own flags — so nothing said what an adapter
 * *is*. A new one could omit a capability key, emit an event kind the rest of
 * the system does not know, or throw on a line it did not recognise, and
 * every existing test would still pass.
 *
 * This is the executable half of "adding a runtime is a document": the shape
 * is stated once, here, and proved for all of them at once. Adding a
 * provider means satisfying this file. It never calls a real provider CLI;
 * everything below is arithmetic on the adapter objects and on text.
 */

const ADAPTERS = Object.entries(defaultAdapters);

/** The capability keys the connections table and the run inspector read. */
const CAPABILITY_KEYS = [
  "launch",
  "stream",
  "interrupt",
  "resume",
  "approve",
  "reportModel",
  "reportUsage",
  "artifacts",
  "attach",
  "fork",
  "delegate",
];

/** The only words a capability may be. Anything else is a claim we cannot read. */
const CAPABILITY_VALUES = new Set([
  "verified",
  "unsupported",
  "unknown",
  "experimental",
]);

/** Lines no provider documents, which an adapter must survive regardless. */
const HOSTILE_LINES = [
  "",
  "   ",
  "not json at all",
  "{",
  "null",
  "[]",
  "[1,2,3]",
  '{"type":"unknown-to-everyone"}',
  '{"type":null,"data":{"deep":{"deeper":[1,2,{"x":"y"}]}}}',
  '"a bare string"',
  "123",
  '{"type":"message","message":{"content":null}}',
];

test("every adapter is registered under the id it calls itself", () => {
  for (const [key, adapter] of ADAPTERS) {
    assert.equal(adapter.id, key, `${key} is registered under another id`);
    assert.ok(adapter.name, `${key} has no human name`);
    assert.ok(
      PROVIDERS[adapter.provider],
      `${key} names provider "${adapter.provider}", which contracts.js does not know`,
    );
  }
});

test("every adapter declares every capability, in words the UI can read", () => {
  for (const [key, adapter] of ADAPTERS) {
    const caps = adapter.capabilities ?? {};
    for (const name of CAPABILITY_KEYS) {
      assert.ok(
        name in caps,
        `${key} does not say whether it supports "${name}"`,
      );
      assert.ok(
        CAPABILITY_VALUES.has(caps[name]),
        `${key}.${name} is "${caps[name]}", which is not a word the UI knows`,
      );
    }
    // Unknown extra keys would be silently ignored by the connections table.
    for (const name of Object.keys(caps))
      assert.ok(
        CAPABILITY_KEYS.includes(name),
        `${key} declares unknown capability "${name}"`,
      );
  }
});

test("supportsResume never contradicts the resume capability", () => {
  for (const [key, adapter] of ADAPTERS) {
    const stated = adapter.capabilities.resume;
    // "experimental" with supportsResume true is legitimate: the mechanism
    // exists but has not been verified here. "unsupported" with true is a
    // contradiction — the interface would offer a reply that cannot work.
    if (stated === "unsupported")
      assert.equal(
        Boolean(adapter.supportsResume),
        false,
        `${key} says resume is unsupported but supportsResume is true`,
      );
    if (stated === "verified")
      assert.equal(
        Boolean(adapter.supportsResume),
        true,
        `${key} says resume is verified but supportsResume is false`,
      );
  }
});

test("every adapter can be looked for on PATH", () => {
  for (const [key, adapter] of ADAPTERS) {
    // `launchBinaries` is an override; without one the provider table's own
    // names are used. One of the two has to name something.
    const names =
      adapter.launchBinaries ?? PROVIDERS[adapter.provider]?.binaries ?? [];
    assert.ok(
      Array.isArray(names) && names.length,
      `${key} names no binary, so nothing can look for it on PATH`,
    );
    for (const binary of names)
      assert.equal(typeof binary, "string", `${key} has a non-string binary`);
  }
});

test("an adapter that cannot launch refuses, and says how to fix it", () => {
  for (const [key, adapter] of ADAPTERS) {
    if (adapter.capabilities.launch !== "unsupported") continue;
    // A refusal is the honest answer; a command line that would run the wrong
    // thing is not. It must also be actionable.
    assert.throws(
      () =>
        adapter.build({
          prompt: "x",
          binary: { command: "x", args: [] },
          cwd: "C:/tmp",
          policy: {},
        }),
      (error) => {
        assert.ok(
          error instanceof InputError,
          `${key} refused with ${error?.constructor?.name}, not InputError`,
        );
        assert.ok(error.fix, `${key} refuses without saying how to fix it`);
        return true;
      },
      `${key} declares launch unsupported but built a command anyway`,
    );
  }
});

test("an adapter that can launch builds a runnable command", () => {
  for (const [key, adapter] of ADAPTERS) {
    if (adapter.capabilities.launch === "unsupported") continue;
    // The app-server transport speaks JSON-RPC rather than building a
    // headless command line, and says so in `transport`.
    if (adapter.transport !== "stream") continue;
    const built = adapter.build({
      prompt: "Do the thing",
      binary: { command: "the-binary", args: [] },
      cwd: "C:/tmp/work",
      policy: {},
    });
    assert.ok(built?.command, `${key} built no command`);
    assert.ok(Array.isArray(built.args), `${key} built no argument list`);
    assert.equal(built.cwd, "C:/tmp/work", `${key} lost the working folder`);
    // The prompt has to reach the provider somehow: an argument or stdin.
    assert.ok(
      built.args.some((arg) => String(arg).includes("Do the thing")) ||
        built.stdin === "pipe",
      `${key} builds a command that never passes the prompt`,
    );
  }
});

test("parsing survives anything, and never invents an event kind", () => {
  for (const [key, adapter] of ADAPTERS) {
    if (typeof adapter.parse !== "function") continue;
    const state = {};
    for (const line of HOSTILE_LINES) {
      let events;
      assert.doesNotThrow(() => {
        events = adapter.parse(line, state);
      }, `${key} threw on: ${line}`);
      assert.ok(
        Array.isArray(events),
        `${key} returned ${typeof events} rather than a list for: ${line}`,
      );
      for (const event of events) {
        assert.ok(
          EVENT_KINDS.includes(event.kind),
          `${key} emitted kind "${event.kind}", which contracts.js does not know`,
        );
        assert.equal(
          event.provider,
          adapter.provider,
          `${key} emitted an event attributed to "${event.provider}"`,
        );
      }
    }
  }
});

test("finalizing an empty run answers rather than throws", () => {
  for (const [key, adapter] of ADAPTERS) {
    if (typeof adapter.finalize !== "function") continue;
    let final;
    assert.doesNotThrow(() => {
      final = adapter.finalize({}, 0);
    }, `${key} threw finalizing a run that recorded nothing`);
    assert.ok(final && typeof final === "object", `${key} finalized to nothing`);
  }
});

test("no adapter claims a capability the provider table contradicts", () => {
  // A provider marked as having no headless mode must not claim to launch.
  for (const [key, adapter] of ADAPTERS) {
    const provider = PROVIDERS[adapter.provider];
    if (provider?.headless === false)
      assert.notEqual(
        adapter.capabilities.launch,
        "verified",
        `${key} claims a verified launch for a provider with no headless mode`,
      );
  }
});
