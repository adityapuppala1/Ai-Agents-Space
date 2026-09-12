import test from "node:test";
import assert from "node:assert/strict";
import {
  candidateLine,
  formToRules,
  moveInOrder,
  routingReason,
  ruleSummary,
  rulesToForm,
} from "../apps/web/src/hooks/routingLogic.js";

/** The routing card: stored policy to form and back, and its words. */

const vocabulary = {
  levels: ["public", "internal", "confidential", "restricted"],
  vendors: { anthropic: "Anthropic", openai: "OpenAI", github: "GitHub" },
  providers: [
    { id: "claude-code", name: "Claude Code" },
    { id: "codex", name: "Codex" },
  ],
};

test("the stored rules round-trip through the form without changing meaning", () => {
  const policy = {
    dataSensitivity: "internal",
    dataRules: { confidential: ["anthropic"], restricted: [] },
    providerDailyTokens: { codex: 5000 },
    routingPreference: ["claude-code"],
    minEvaluations: 3,
  };
  const form = rulesToForm(policy, vocabulary);
  assert.deepEqual(form.rows.public, { any: true, vendors: [] });
  assert.deepEqual(form.rows.confidential, {
    any: false,
    vendors: ["anthropic"],
  });
  assert.deepEqual(form.rows.restricted, { any: false, vendors: [] });
  assert.deepEqual(form.caps, { "claude-code": "", codex: 5000 });
  assert.deepEqual(formToRules(form), {
    dataSensitivity: "internal",
    // "Any vendor" is sent as null: no rule for that label.
    dataRules: {
      public: null,
      internal: null,
      confidential: ["anthropic"],
      restricted: [],
    },
    providerDailyTokens: { "claude-code": null, codex: 5000 },
    routingPreference: ["claude-code"],
    minEvaluations: 3,
  });
  // A blank default label is no label; a nonsense cap is no cap.
  const blank = formToRules({
    ...form,
    dataSensitivity: "",
    caps: { codex: "abc" },
    minEvaluations: "",
  });
  assert.equal(blank.dataSensitivity, null);
  assert.deepEqual(blank.providerDailyTokens, { codex: null });
  assert.equal(blank.minEvaluations, 5);
});

test("each label row says in words where its work may go", () => {
  assert.equal(ruleSummary({ any: true, vendors: [] }), "Any vendor");
  assert.equal(
    ruleSummary({ any: false, vendors: [] }),
    "Nowhere: no assistant may receive it",
  );
  assert.equal(
    ruleSummary(
      { any: false, vendors: ["anthropic", "openai"] },
      vocabulary.vendors,
    ),
    "Only Anthropic, OpenAI",
  );
});

test("the preference order moves one place at a time and never falls off", () => {
  assert.deepEqual(moveInOrder(["a", "b", "c"], "c", -1), ["a", "c", "b"]);
  assert.deepEqual(moveInOrder(["a", "b", "c"], "a", -1), ["a", "b", "c"]);
  assert.deepEqual(moveInOrder(["a", "b", "c"], "c", 1), ["a", "b", "c"]);
  assert.deepEqual(moveInOrder(["a"], "missing", 1), ["a"]);
});

test("a picker shows routing's reason, but not a connection problem it already shows", () => {
  const ranking = {
    recommended: "claude-code",
    candidates: [
      {
        provider: "claude-code",
        eligible: true,
        checks: [
          { check: "connection", ok: true, text: "Connected" },
          { check: "launch", ok: true, text: "Launch verified" },
          {
            check: "evaluation",
            ok: true,
            text: "2 graded results; 5 needed to compare",
          },
        ],
      },
      {
        provider: "codex",
        eligible: false,
        checks: [
          { check: "connection", ok: true, text: "Connected" },
          {
            check: "data",
            ok: false,
            text: "Confidential work may go only to Anthropic",
          },
        ],
      },
      {
        provider: "cursor",
        eligible: false,
        checks: [{ check: "connection", ok: false, text: "Not installed" }],
      },
    ],
  };
  assert.equal(routingReason(ranking, "claude-code"), "");
  assert.equal(
    routingReason(ranking, "codex"),
    "Confidential work may go only to Anthropic",
  );
  assert.equal(routingReason(ranking, "cursor"), "");
  assert.equal(routingReason(null, "codex"), "");
  assert.equal(
    candidateLine(ranking.candidates[0]),
    "Connected · Launch verified · 2 graded results; 5 needed to compare",
  );
  assert.equal(
    candidateLine(ranking.candidates[1]),
    "Confidential work may go only to Anthropic",
  );
});
