# Domain packs (workflow templates)

Thirteen packs from [PRODUCT_ROADMAP.md](../Idea/PRODUCT_ROADMAP.md) section 14 ship as JSON in `packages/core/src/workflows/templates/`. A pack is a **scoped workflow**: role definitions, ordered steps with dependencies, tool requirements, sample inputs, an output schema, an acceptance rubric, and the concrete required result from the roadmap table. A different avatar is not a specialist agent; the contract is.

## The contract every pack carries

```jsonc
{
  "id": "data-analytics",
  "name": "Data analytics",
  "domain": "Data",
  "priority": "Launch" | "Growth" | "Explore",
  "description": "...",
  "requiredResult": "Query, results, chart, assumptions, reproducible report",
  "roles": [{ "key", "name", "workingState", "provider", "skills": [] }],
  "steps": [
    {
      "key": "analyze",
      "title": "Execute the query and analyze: {{question}}",
      "role": "analyst",
      "instructions": "...",
      "deliverable": "...",
      "acceptance": ["command-exit-zero:analysis/query.sql", "file-edited:analysis/results"],
      "contract": {
        "inputs": [{ "key", "type", "required" }],
        "outputSchema": null,
        "completionCriteria": ["…same as acceptance…"],
        "timeoutMs": 900000,
        "allowedTools": ["file.read", "shell"],
        "budget": { "maxTokens": null, "maxRuns": 2 },
        "reviewer": null
      },
      "dependsOn": ["scope"],
      "branchCondition": null
    }
  ],
  "outputSchema": { "type": "object", "properties": {}, "required": [] },
  "rubric": [{ "criterion", "howMeasured", "failsWhen" }],
  "requiredTools": ["file.read", "shell"],
  "requiredConnectors": ["local-filesystem", "sql-database"],
  "sampleInputs": { "question": "…" },
  "notes": "…"
}
```

`validateTemplate()` in `templates/index.js` enforces all of it: unique step keys, acyclic `dependsOn`, every role used by a step, every `workingState` a real activity, every required tool in the tool vocabulary, every connector in the connector vocabulary, every rubric entry an object with `criterion` / `howMeasured` / `failsWhen`, and **every acceptance criterion objective**. Loading a template that breaks any of this throws at startup, so a broken pack can never reach a task brief.

### Acceptance criteria are objective, or they are refused

A criterion must be a fact Agent Space recorded. The vocabulary is the one `packages/core/src/workflows/contracts.js` can check (`parseCriterion` / `validateResult`):

| Criterion                     | Passes when                                                            |
| ----------------------------- | ---------------------------------------------------------------------- |
| `artifact:<kind>`             | An artifact of that kind exists (`diff`, `test-output`, `message`)     |
| `command-exit-zero:<pattern>` | A recorded command matching the substring or `/regex/` exited 0        |
| `test-passed`                 | A recorded test command exited 0 (or a `test-output` artifact says so) |
| `file-edited[:<substring>]`   | A file edit or write event was recorded (optionally on that path)      |
| `final-message-non-empty`     | The run produced a non-empty final message                             |
| `output-schema`               | The parsed JSON result validates against the step's `outputSchema`     |

"The plan is good", "the code is clean", "the reviewer is satisfied" are **not** criteria; `validateTemplate` throws `… is not objective`. A criterion Agent Space could not evaluate counts as a failure, never as a pass, and a contract failure never silently completes a task: it sets the task review to `pending` with the failures listed.

### Tool vocabulary

`TOOL_VOCABULARY` in `templates/index.js` maps Agent Space tool names to the provider tool names verified in [ARCHITECTURE.md](ARCHITECTURE.md) section 3:

| Tool                                 | Claude Code                                                            | Codex                  | Copilot          |
| ------------------------------------ | ---------------------------------------------------------------------- | ---------------------- | ---------------- |
| `file.read`                          | `Read`                                                                 | `exec_command`         | `view`           |
| `file.edit`                          | `Edit`, `Write`, `MultiEdit`                                           | `apply_patch`          | `edit`, `create` |
| `search`                             | `Glob`, `Grep`                                                         | `exec_command`         | `grep`, `glob`   |
| `shell`, `shell.test`, `shell.build` | `Bash`, `PowerShell`                                                   | `exec_command`, `exec` | `bash`           |
| `git.diff`, `git.log`                | via the shell tool                                                     | via the shell tool     | via the shell    |
| `web.fetch`, `web.search`            | `WebFetch`, `WebSearch`                                                | `web_search`           | `web_fetch`      |
| `sql.read`                           | none — runs through the shell tool                                     | same                   | same             |
| `approval`                           | not a provider tool: the hook bridge or the Codex app-server raises it |                        |                  |
| `delegate`                           | `Task` / `Agent`                                                       | —                      | —                |

A pack may not name a tool outside this table: nothing could then say which provider tool it means.

### Connector vocabulary and honest gaps

`CONNECTOR_VOCABULARY` records what this build can actually reach.

| Connector                                                                            | Status          | What it means for a pack                                          |
| ------------------------------------------------------------------------------------ | --------------- | ----------------------------------------------------------------- |
| `local-filesystem`                                                                   | available       | Scoped reads/writes in the workspace root, worktree, allowed dirs |
| `git`                                                                                | available       | Diff, status, log, worktree isolation                             |
| `web`                                                                                | available       | Only through the provider's own web tool, only if policy allows   |
| `sql-database`                                                                       | not-implemented | Queries run through the shell tool against an existing client     |
| `ci-cd`                                                                              | not-implemented | Build/deploy status comes from local commands and exit codes only |
| `issue-tracker`, `object-storage`, `document-store`, `design-files`, `notifications` | not-implemented | Declared as a requirement; the pack says what it does instead     |

A pack that requires a `not-implemented` connector still ships — it declares the dependency honestly and its rubric states the substitute. It never pretends the connector exists.

## The three distinctions the roadmap calls out

**CI/CD — show statuses from the actual build/deployment system.** There is no CI connector. `release-room` therefore requires `command-exit-zero:/build|compile|package/` on its build step and `test-passed` on its test step, and its release-notes schema has `statusSource: ["local-command"]`. Its rubric fails the pack when "a release note quotes a pipeline or deployment status that Agent Space never observed".

**Analytics — a generated SQL query is not an executed and validated result.** `data-analytics` splits the two: the `scope` step may only produce `analysis/query.sql` and `analysis/assumptions.md` (and carries no `command-exit-zero` criterion at all), while the `analyze` step requires **both** `command-exit-zero:analysis/query.sql` **and** `file-edited:analysis/results`. Its output schema requires `executed`, `executionCommand`, `executionExitCode`, `resultFile`. Rubric line one: "A generated query is not a result — analysis/query.sql exists but no recorded command running it reported exit code 0: the pack has failed, whatever the report says." `executed: false` is a valid honest outcome; it is never a pass.

**Research — retrieved sources are not verified claims.** `research-desk` writes `research/sources.json` where every source carries two separate required flags: `retrieval` (`retrieved` | `not-retrieved`, about the fetch) and `verification` (`unverified` | `verified-primary` | `verified-second-source` | `contradicted`, about the claim), plus `verifiedBy`. Claims in `research/evidence.json` carry `status` (`verified` | `retrieved-only` | `unverified` | `contradicted`) and may never exceed the verification of their sources. Rubric: "A claim is marked verified while every supporting source is unverified — the pack has failed."

## The packs

Each row lists the roadmap's required result, the steps in dependency order, and the tools and connectors the pack needs. Roles are listed in the JSON with a `workingState`: the profile's working style. It animates demo tasks only. A manual task (no provider run) shows "In progress (manual)", because nothing reports what the agent is doing, and a provider run shows the activity recorded from its events.

### 1. Feature delivery — Launch

Required result: **reviewed patch, test results, implementation notes.**
Steps: `plan` → (`frontend`, `backend`) → `qa` → `review` (fan-out, fan-in at QA).
Key acceptance: plan writes a file under `plans/`; each code step produces a diff artifact; QA needs `test-passed` + `artifact:test-output`; review emits JSON with `decision`, `changedFiles`, `testCommand`, `testExitCode` and is reviewed by a human.
Tools: `file.read`, `file.edit`, `search`, `shell.build`, `shell.test`, `git.diff`. Connectors: local filesystem, git.

### 2. Bug clinic — Launch

Required result: **reproduction evidence and verified fix.**
Steps: `reproduce` → `diagnose` → `fix` → `regression`.
Key acceptance: a file under `repro/` before any fix; the fix is a diff artifact; the regression step needs `test-passed`, a `test-output` artifact, and JSON with the command and exit code. A non-zero exit code on the reproduce step is the expected evidence and is never rewritten.
Tools: `file.read`, `file.edit`, `search`, `shell`, `shell.test`, `git.diff`, `git.log`.

### 3. Repository onboarding — Launch

Required result: **source-linked onboarding document.**
Steps: `explore` → (`map`, `setup`) → `guide`.
Key acceptance: setup requires `command-exit-zero:/install|setup|build|ci/`; the guide's JSON requires `setupCommands` (command + exit code per entry) and `sourceReferences`. Rubric fails a guide that documents a command nobody ran.

### 4. Release room — Growth

Required result: **versioned release artifacts and approval trail.**
Steps: `collect` → `build` → `test` → `notes` → `approve` (human reviewer, `requiresApproval`).
Key acceptance: `command-exit-zero:git log`, `command-exit-zero:/build|compile|package/`, `test-passed`, a notes JSON pinned to `statusSource: local-command`, and a recorded decision artifact. Connector `ci-cd` is declared and not implemented.

### 5. DevOps incident room — Growth

Required result: **incident timeline, approved change, verification.**
Steps: `evidence` → `mitigation` → `approve` → `apply` → `verify`.
Key acceptance: evidence needs a read-only status/log command that exited 0 and a timeline file; `apply` depends on `approve` and carries `branchCondition {when: previous.review, equals: accepted}`; `verify` needs `command-exit-zero:/health|verify|smoke|status/` and JSON with `notUndone` — the effects a rollback cannot reverse. The alert is a typed input: there is no alert connector.

### 6. Data engineering — Growth

Required result: **dataset version, lineage, validation report.**
Steps: `ingest` → `transform` → `validate` → `publish`.
Key acceptance: each stage needs a recorded command that exited 0; validation reports per check `passed` / `failed` / **`not-run`**; publish writes `data/lineage/<dataset>.json` pairing every output with the command that produced it and a version string.

### 7. Data analytics — Growth

Required result: **query, results, chart, assumptions, reproducible report.** See the analytics distinction above.
Steps: `scope` → `analyze` → `chart` → `review`.

### 8. Research desk — Growth

Required result: **citations, uncertainties, and inspectable source set.** See the research distinction above.
Steps: `sources` → `compare` → `brief`.

### 9. Documentation studio — Growth

Required result: **versioned document with source references.**
Steps: `draft` → `check` → `review`.
Key acceptance: the fact check writes one entry per statement with `verified` / `unverified` / `wrong`; the review needs a diff artifact and records a version. An unverified statement stays visible as unverified — it is never published as fact nor deleted silently.

### 10. Design review — Growth

Required result: **annotated findings and reviewable changes.**
Steps: (`accessibility`, `layout`) → `edits`.
Key acceptance: findings JSON requires `file`, `check`, `severity` per finding; the edits step needs a diff artifact and JSON mapping `addressed` / `deferred` back to finding ids. Connector `design-files` is declared and not implemented: review reads source files, nothing renders a screen.

### 11. Security review — Growth

Required result: **findings with evidence and explicit scope.**
Steps: `scan` → `triage` → `remediate` → `retest`.
Key acceptance: the scan runs an audit/lint command that exited 0 and states scope and exclusions; every finding needs `evidence` and a status of `confirmed` / `suspected` / `false-positive`; closure requires a rerun (`test-passed`, `rescanExitCode`).

### 12. Agency delivery — Growth

Required result: **approved deliverables without other-client context.**
Steps: `brief` → `execute` → `qa` → `client-review` (human, `requiresApproval`).
Key acceptance: the brief lists `scopeFolders` and checkable acceptance criteria; the diff must stay inside them; QA needs `test-passed`; the client decision is recorded with `criteriaMet` / `criteriaOpen`. Isolation is by workspace — give each client its own workspace with its own `rootPath` and `allowedFolders`.

### 13. Marketing operations — Explore

Required result: **approved campaign artifacts; no automatic unsolicited outreach.**
Steps: `research` → `draft` → `review` → `approve` (human, `requiresApproval`).
Key acceptance: claims carry `verified` / `unverified` with a named source; the review marks each statement `supported` / `unsupported` / `off-brand`; the approval records the decision and the artifact list. **Agent Space sends nothing and publishes nothing** — there is no send, post, or contact capability in this build.

## Running a pack

CLI:

```bash
node bin/agent-space.js templates                       # list packs
node bin/agent-space.js workflow start <workspace> data-analytics \
  --input question="Which providers have the highest retry rate?" --json
node bin/agent-space.js graph <workspace>               # dependency state
node bin/agent-space.js runs <workspace>
```

HTTP:

```bash
curl http://127.0.0.1:5173/api/templates
curl http://127.0.0.1:5173/api/templates/data-analytics
curl -X POST http://127.0.0.1:5173/api/workspaces/<id>/workflows \
  -H "content-type: application/json" \
  -d '{"templateId":"data-analytics","inputs":{"question":"…"},"provider":"claude-code"}'
```

UI: **Templates** in the rail → pick a pack → the gallery shows the steps, roles, and providers before anything is created → fill the inputs (pre-filled from `sampleInputs`) → create.

Instantiating creates one task per step with `depends_on` wired from `dependsOn`, the step contract stored on `tasks.contract`, `branch_condition`, and `reviewer`. Steps with no ready dependency start immediately when the workspace policy allows auto-dispatch; everything else waits. Nothing runs until a provider is connected and the workspace policy permits the launch.

## Sharing a pack

```bash
curl http://127.0.0.1:5173/api/templates/bug-clinic/export > bug-clinic.json
curl -X POST http://127.0.0.1:5173/api/templates/import-preview \
  -H "content-type: application/json" -d @bug-clinic.json
```

Export strips secrets, private absolute paths, raw logs, and client data, and lists everything it removed. Import is **preview first**: the response shows the steps, roles, required tools, which connectors are unavailable, a permission summary, and validation errors. Nothing is written. See [EXTENSIONS.md](EXTENSIONS.md).

## Adding a pack

1. Add `packages/core/src/workflows/templates/<id>.json` in the shape above.
2. Add the id to `TEMPLATE_ORDER` in `templates/index.js` (order follows roadmap section 14).
3. Every acceptance criterion must parse with `parseCriterion`; every tool must be in `TOOL_VOCABULARY`; every connector in `CONNECTOR_VOCABULARY`.
4. `node --test tests/templates.test.js` — the suite validates every pack, rejects subjective criteria, and asserts the analytics and research distinctions.
