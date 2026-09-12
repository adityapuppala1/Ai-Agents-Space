import test from "node:test";
import assert from "node:assert/strict";
import {
  listTemplates,
  getTemplate,
  validateTemplate,
  interpolate,
  TEMPLATE_ORDER,
  TOOL_VOCABULARY,
  TOOL_NAMES,
  CONNECTOR_VOCABULARY,
  RECOMMENDED_ENVIRONMENTS,
} from "../packages/core/src/workflows/templates/index.js";
import {
  validateContract,
  validateResult,
  parseCriterion,
} from "../packages/core/src/workflows/contracts.js";
import { ACTIVITIES } from "../packages/core/src/contracts.js";

/** A valid minimal template, used as the base for the negative cases. */
function baseTemplate(overrides = {}) {
  const template = {
    id: "sample-pack",
    name: "Sample pack",
    domain: "Testing",
    priority: "Growth",
    description: "A minimal but complete pack used by the tests.",
    requiredResult: "A recorded file edit",
    roles: [
      {
        key: "worker",
        name: "Worker",
        workingState: "CODING",
        provider: null,
        skills: ["editing"],
      },
    ],
    steps: [
      {
        key: "one",
        title: "Do the thing",
        role: "worker",
        instructions: "Edit a file.",
        deliverable: "An edited file",
        acceptance: ["file-edited"],
        contract: {
          inputs: [{ key: "thing", type: "string", required: true }],
          outputSchema: null,
          completionCriteria: ["file-edited"],
          timeoutMs: 60000,
          allowedTools: ["file.edit"],
          budget: { maxTokens: null, maxRuns: 1 },
          reviewer: null,
        },
        dependsOn: [],
        branchCondition: null,
      },
    ],
    outputSchema: {
      type: "object",
      properties: { file: { type: "string" } },
      required: ["file"],
    },
    rubric: [
      {
        criterion: "A file changed",
        howMeasured: "A file edit event is recorded",
        failsWhen: "No file edit event exists",
      },
    ],
    requiredTools: ["file.edit"],
    requiredConnectors: ["local-filesystem"],
    sampleInputs: { thing: "a file" },
    notes: "Test fixture.",
  };
  return { ...template, ...overrides };
}

test("all 13 domain packs carry the full section 14 contract", () => {
  const templates = listTemplates();
  assert.equal(templates.length, 13);
  assert.deepEqual(
    templates.map((template) => template.id),
    TEMPLATE_ORDER,
  );
  for (const template of templates) {
    assert.ok(validateTemplate(template), `${template.id} validates`);
    assert.ok(
      template.requiredResult.length > 5,
      `${template.id} names a required result`,
    );
    assert.ok(template.notes.length > 5, `${template.id} has notes`);
    assert.ok(template.requiredConnectors.length >= 1);
    assert.ok(Object.keys(template.sampleInputs).length >= 1);
    assert.ok(template.steps.length >= 3);

    // Roles: every one defined is used, every working state is a real activity.
    const usedRoles = new Set(template.steps.map((step) => step.role));
    for (const role of template.roles) {
      assert.ok(
        ACTIVITIES.includes(role.workingState),
        `${template.id}/${role.key} working state`,
      );
      assert.ok(Array.isArray(role.skills) && role.skills.length > 0);
      assert.ok(
        usedRoles.has(role.key),
        `${template.id}: role ${role.key} is used by a step`,
      );
    }

    // Tools are named in the shared vocabulary and every step subset fits.
    for (const tool of template.requiredTools)
      assert.ok(TOOL_NAMES.includes(tool));
    for (const connector of template.requiredConnectors)
      assert.ok(
        CONNECTOR_VOCABULARY[connector],
        `${template.id}: connector ${connector}`,
      );

    // Every acceptance criterion is objective, and the step contract that the
    // workflow service will store validates against contracts.js.
    for (const step of template.steps) {
      assert.ok(Array.isArray(step.acceptance) && step.acceptance.length > 0);
      for (const criterion of step.acceptance)
        assert.ok(
          parseCriterion(criterion),
          `${template.id}/${step.key}: ${criterion} is objective`,
        );
      const contract = validateContract(step.contract);
      assert.deepEqual(contract.completionCriteria, step.acceptance);
      for (const tool of contract.allowedTools)
        assert.ok(template.requiredTools.includes(tool));
    }
  }
});

test("subjective acceptance criteria are refused", () => {
  assert.throws(
    () =>
      validateTemplate(
        baseTemplate({
          steps: [
            { ...baseTemplate().steps[0], acceptance: ["The code is clean"] },
          ],
        }),
      ),
    /not objective/,
  );
  assert.throws(
    () =>
      validateTemplate(
        baseTemplate({
          steps: [
            {
              ...baseTemplate().steps[0],
              contract: {
                ...baseTemplate().steps[0].contract,
                completionCriteria: ["Reviewer is happy"],
              },
            },
          ],
        }),
      ),
    /not objective/,
  );
  assert.ok(validateTemplate(baseTemplate()));
});

test("validateTemplate enforces the shape, unique keys, acyclic deps, roles, and the tool vocabulary", () => {
  const base = baseTemplate();
  // Structural checks come first so a half-written template reports the real
  // problem (this exact case is asserted by tests/workflows.test.js too).
  assert.throws(
    () =>
      validateTemplate({
        id: "x",
        roles: [],
        steps: [{ key: "a", dependsOn: ["zzz"] }],
      }),
    /unknown zzz/,
  );
  assert.throws(
    () =>
      validateTemplate(
        baseTemplate({
          steps: [base.steps[0], { ...base.steps[0], title: "Twice" }],
        }),
      ),
    /duplicate step key/,
  );
  assert.throws(
    () =>
      validateTemplate(
        baseTemplate({
          steps: [
            { ...base.steps[0], key: "a", dependsOn: ["b"] },
            { ...base.steps[0], key: "b", dependsOn: ["a"] },
          ],
        }),
      ),
    /cycle/,
  );
  assert.throws(
    () =>
      validateTemplate(
        baseTemplate({ steps: [{ ...base.steps[0], role: "ghost" }] }),
      ),
    /unknown role ghost/,
  );
  assert.throws(
    () =>
      validateTemplate(
        baseTemplate({
          roles: [
            ...base.roles,
            {
              key: "spare",
              name: "Spare",
              workingState: "IDLE",
              provider: null,
              skills: [],
            },
          ],
        }),
      ),
    /no step uses it/,
  );
  assert.throws(
    () => validateTemplate(baseTemplate({ requiredTools: ["telepathy"] })),
    /tool vocabulary/,
  );
  assert.throws(
    () =>
      validateTemplate(baseTemplate({ requiredConnectors: ["quantum-bus"] })),
    /connector vocabulary/,
  );
  assert.throws(
    () => validateTemplate(baseTemplate({ requiredResult: "" })),
    /requiredResult/,
  );
  assert.throws(
    () => validateTemplate(baseTemplate({ priority: "Someday" })),
    /priority/,
  );
  assert.throws(
    () => validateTemplate(baseTemplate({ rubric: ["a plain string"] })),
    /rubric entries must be objects/,
  );
  assert.throws(
    () =>
      validateTemplate(
        baseTemplate({
          roles: [
            {
              key: "worker",
              name: "Worker",
              workingState: "SLEEPING",
              provider: null,
              skills: [],
            },
          ],
        }),
      ),
    /workingState/,
  );
  assert.throws(
    () =>
      validateTemplate(
        baseTemplate({
          steps: [
            {
              ...base.steps[0],
              contract: {
                ...base.steps[0].contract,
                allowedTools: ["web.fetch"],
              },
            },
          ],
        }),
      ),
    /not in requiredTools/,
  );
});

test("every tool in the vocabulary maps to provider tool names or says why it cannot", () => {
  for (const [name, entry] of Object.entries(TOOL_VOCABULARY)) {
    assert.ok(entry.description.length > 10, `${name} is described`);
    const mapped = Object.values(entry.providerTools ?? {}).flat();
    if (!mapped.length)
      assert.match(
        entry.description,
        /No provider exposes|Not a provider tool/,
        `${name} explains why no provider tool backs it`,
      );
  }
  for (const [name, entry] of Object.entries(CONNECTOR_VOCABULARY))
    assert.ok(
      ["available", "not-implemented"].includes(entry.status),
      `${name} has an honest status`,
    );
});

test("the data analytics pack requires both a generated query and an executed result", () => {
  const pack = getTemplate("data-analytics");
  const scope = pack.steps.find((step) => step.key === "scope");
  const analyze = pack.steps.find((step) => step.key === "analyze");

  // The scoping step produces the query artifact and nothing else.
  assert.ok(scope.acceptance.includes("file-edited:analysis/query.sql"));
  assert.ok(
    !scope.acceptance.some((criterion) =>
      criterion.startsWith("command-exit-zero"),
    ),
  );

  // The analysis step needs BOTH a command that ran the query and a result file.
  assert.ok(
    analyze.acceptance.includes("command-exit-zero:analysis/query.sql"),
  );
  assert.ok(analyze.acceptance.includes("file-edited:analysis/results"));

  // The rubric says a generated query without an executed result is a failure.
  const rule = pack.rubric.find((entry) =>
    /generated query/i.test(entry.criterion),
  );
  assert.ok(rule, "the rubric names the generated-vs-executed distinction");
  assert.match(rule.failsWhen, /no recorded command|exit code 0/i);

  // And the contract actually fails when only the query exists.
  const contract = validateContract(analyze.contract);
  const queryOnly = validateResult(contract, {
    artifacts: [],
    finalMessage: "I wrote the query.",
    events: [{ kind: "file.edit", file: "analysis/query.sql" }],
  });
  assert.equal(queryOnly.ok, false);
  assert.ok(
    queryOnly.failures.some(
      (failure) => failure.criterion === "command-exit-zero:analysis/query.sql",
    ),
  );

  const executed = validateResult(contract, {
    artifacts: [],
    finalMessage: "42 rows.",
    events: [
      { kind: "file.edit", file: "analysis/results.csv" },
      {
        kind: "command",
        summary: "sqlite3 app.db < analysis/query.sql",
        data: { command: "sqlite3 app.db < analysis/query.sql", exitCode: 0 },
      },
    ],
  });
  assert.equal(executed.ok, true, JSON.stringify(executed.failures));

  // The output schema keeps the distinction as data too.
  assert.ok(pack.outputSchema.required.includes("executed"));
  assert.ok(pack.outputSchema.required.includes("executionExitCode"));
});

test("data workflow packs recommend the Data Lab environment", () => {
  for (const id of ["data-engineering", "data-analytics"]) {
    const pack = getTemplate(id);
    assert.equal(pack.recommendedEnvironment, "data-lab");
    assert.ok(RECOMMENDED_ENVIRONMENTS.includes(pack.recommendedEnvironment));
  }
  assert.equal(
    getTemplate("feature-delivery").recommendedEnvironment,
    undefined,
  );
  assert.throws(
    () =>
      validateTemplate(baseTemplate({ recommendedEnvironment: "unsafe-room" })),
    /recommendedEnvironment must be one of/,
  );
});

test("the research pack flags retrieved versus verified per source", () => {
  const pack = getTemplate("research-desk");
  const sources = pack.steps.find((step) => step.key === "sources");
  const schema = sources.contract.outputSchema;
  const source = schema.properties.sources.items;
  assert.deepEqual(source.properties.retrieval.enum, [
    "retrieved",
    "not-retrieved",
  ]);
  assert.deepEqual(source.properties.verification.enum, [
    "unverified",
    "verified-primary",
    "verified-second-source",
    "contradicted",
  ]);
  assert.ok(source.required.includes("retrieval"));
  assert.ok(source.required.includes("verification"));

  const compare = pack.steps.find((step) => step.key === "compare");
  assert.deepEqual(
    compare.contract.outputSchema.properties.claims.items.properties.status
      .enum,
    ["verified", "retrieved-only", "unverified", "contradicted"],
  );
  assert.ok(compare.contract.outputSchema.required.includes("uncertainties"));

  const rule = pack.rubric.find((entry) =>
    /retrieved is not verified/i.test(entry.criterion),
  );
  assert.ok(rule, "the rubric separates retrieval from verification");
  assert.match(
    rule.failsWhen,
    /verified while every supporting source is unverified/i,
  );

  // A source set missing the verification flag does not satisfy the contract.
  const contract = validateContract(sources.contract);
  const missingFlag = validateResult(contract, {
    artifacts: [
      {
        kind: "message",
        content: JSON.stringify({
          question: "q",
          sources: [{ id: "s1", title: "t", url: "u", retrieval: "retrieved" }],
        }),
      },
    ],
    events: [{ kind: "file.edit", file: "research/sources.json" }],
  });
  assert.equal(missingFlag.ok, false);
  assert.ok(
    missingFlag.failures.some((failure) =>
      /verification is required/.test(failure.detail),
    ),
  );
});

test("CI/CD status in the release pack comes from local commands only", () => {
  const pack = getTemplate("release-room");
  assert.ok(pack.requiredConnectors.includes("ci-cd"));
  assert.equal(CONNECTOR_VOCABULARY["ci-cd"].status, "not-implemented");
  const build = pack.steps.find((step) => step.key === "build");
  assert.ok(
    build.acceptance.some((criterion) =>
      criterion.startsWith("command-exit-zero:"),
    ),
  );
  const notes = pack.steps.find((step) => step.key === "notes");
  assert.deepEqual(notes.contract.outputSchema.properties.statusSource.enum, [
    "local-command",
  ]);
  const rule = pack.rubric.find((entry) =>
    /external CI/i.test(entry.criterion),
  );
  assert.ok(rule);
  assert.match(pack.notes, /NOT implemented/);
});

test("interpolate fills placeholders and renders acceptance lists as a checklist", () => {
  assert.equal(
    interpolate("Plan {{feature}} {{missing}}", { feature: "Search" }),
    "Plan Search {{missing}}",
  );
  assert.equal(
    interpolate(["file-edited:{{dir}}", "test-passed"], { dir: "src" }),
    "file-edited:src\n- test-passed",
  );
  assert.equal(interpolate(null), "");
});
