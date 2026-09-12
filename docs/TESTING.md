# Testing

Two suites, no test framework dependency: `node --test` for unit and integration tests, Playwright for the browser.

```bash
npm test                                  # node --test → every tests/*.test.js
node --test tests/templates.test.js       # one file
node --test tests/extensions.test.js tests/workflows.test.js
npm run build && npx playwright test      # e2e (Chrome, server on port 5174)
npx playwright test e2e/execution.spec.js --headed
npx prettier --write <files you changed>
```

## Rules that bind every test

1. **Never touch a real provider home.** `~/.claude`, `~/.codex`, `~/.copilot`, `~/.gemini`, `~/.cursor` are read-only territory belonging to the user's own tools, and `~/.claude/settings.json` is never modified. Point the home environment variables at a fixture or temp folder instead.
2. **Never launch a real provider CLI.** Use the fake CLIs. A test that shells out to `claude`, `codex`, or `copilot` is a broken test.
3. **Use temp or in-memory databases.** `createServices({ demo: false })` opens `:memory:`; a file-backed test writes under the OS temp dir and deletes it.
4. **No network.** Nothing in the suite makes an outbound request.
5. **Assert facts, not vibes.** Assert on recorded events, exit codes, artifacts, and schema validation — the same objective vocabulary the templates use.

## Fixtures

`tests/fixtures/providers/` holds real, sanitized captures from this machine (2026-09-09):

| File                            | What it is                                                 |
| ------------------------------- | ---------------------------------------------------------- |
| `claude-headless-stream.jsonl`  | A verified `claude -p … --output-format stream-json` run   |
| `claude-code-transcript.jsonl`  | A `~/.claude/projects/<slug>/<sessionId>.jsonl` transcript |
| `claude-session-registry.json`  | A `~/.claude/sessions/<pid>.json` live-session record      |
| `codex-rollout.jsonl`           | A `~/.codex/sessions/**/rollout-*.jsonl` session           |
| `codex-exec-stream-error.jsonl` | A `codex exec --json` stream ending in a rate-limit error  |
| `copilot-headless-stream.jsonl` | A verified `copilot -p … --output-format json` run         |

Use them for parser tests: they are the only evidence of a real stream format, so a parser change that breaks a fixture is a regression, not a fixture problem.

## The fake CLI harness

`tests/fixtures/fake-cli/{claude,codex,copilot,gemini}.js` replay those fixtures with the same argument shapes as the real binaries, honouring `--cwd` / `-C` and `--resume`. Select them with the binary override variables (provider id upper-cased, `-` → `_`):

```bash
AGENT_SPACE_BIN_CLAUDE_CODE="node tests/fixtures/fake-cli/claude.js"
AGENT_SPACE_BIN_CODEX="node tests/fixtures/fake-cli/codex.js"
AGENT_SPACE_BIN_COPILOT="node tests/fixtures/fake-cli/copilot.js"
AGENT_SPACE_BIN_GEMINI="node tests/fixtures/fake-cli/gemini.js"
```

In a test, build the value from `process.execPath` and an absolute script path so it does not depend on `node` being on PATH. The full contract each fake must honour is in `tests/fixtures/fake-cli/README.md`.

Provider homes are redirected the same way: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME`, `CURSOR_HOME`, `GEMINI_HOME`.

## Browser tests

`playwright.config.js` starts `node packages/server/src/main.js` on port 5174 with an in-memory database, and `e2e/global-setup.js` redirects every provider home to a throwaway folder under `test-results/homes` (plus `AGENT_SPACE_DATA_DIR` under `test-results/data`). Delete `test-results/` at any time.

- `e2e/workspace.spec.js` — workspace isolation, agent edits persisting across reloads, two tabs, mobile layout, WebGL loss and the accessible 2D fallback, the minimap.
- `e2e/execution.spec.js` — launching a managed run with a fake CLI, the run inspector tabs, a Claude Code hook approval flowing through the inbox, inferred-activity labelling.
- `e2e/office-arrange.spec.js` — arranging the office: moving and renaming a room by keyboard, placing furniture, saving, the office drawing it, a reload keeping it, and Reset giving the environment's layout back.
- `e2e/accessibility.spec.js` — accessible names, labelled fields, unique ids, alt text, focus visibility, reduced motion, contrast arithmetic on the tokens and on rendered text in both themes, and text scaling to 150%.
- `e2e/screen-reader.spec.js` — the path an assistive technology takes: landmarks, one page heading, an ordered outline with nothing skipped (in a workspace with records and in an empty one), named regions, a live region per view, the office's text equivalent and its spoken changes, focus never hidden behind the fixed bars, and a task created, assigned and completed with the keyboard alone.

Selectors the specs depend on (`.scene-fallback`, `Inspect <name>` buttons, `.office-canvas canvas`, `.as-inferred`) are load-bearing: changing them breaks e2e.

Conventions the specs rely on (11 September 2026):

- **Choose the workspace explicitly.** A fresh browser opens the first real workspace once another spec has created one, so a spec that reads the demo team sets `agent-space-workspace` to `demo` in an init script (`useDemo()` in `e2e/workspace.spec.js`). A spec that writes tasks should use its own workspace: tasks cannot be deleted, and other specs count the demo's.
- **Only agents with recorded work stand on the floor.** Scale and performance scenarios call `putTeamToWork()` from `e2e/helpers.js` so every agent has an assigned task; an idle roster draws no figures, and the specs assert that too. Idle agents are chosen from the roster (`.team-section .roster-item`), not the scene. `.agent-card` is the Agents page's card, a different thing.
- **Navigation.** Board is the column layout of the Task board (`Task layout` group → `Board`). On a phone, secondary destinations are in the **More destinations** dialog. Office filters and environments are popovers inside the `Office controls` region; open `Filters` or `Environment` first. Settings opens on its Workspace tab; environment controls are on the Environment tab.
- **Never depend on the demo simulation's clock.** The demo runs on its own timeline: its relay hands over, agents pick tasks up and finish them, and a room opens and closes as that happens. Specs that named one demo agent as "free", or waited for the demo to announce something, passed or failed by where in the cycle they ran. Create a workspace and drive the state the test needs.
- **Helpers never live in a `.spec.js` file.** Importing a spec would register its tests twice; shared helpers go in `e2e/helpers.js`.

### Known intermittent: `team-relay.spec.js` "plays the handoff"

On 12 September 2026 this spec failed once in a full-suite run and then passed in isolation and in a second full-suite run. The cause is **unconfirmed** — Playwright clears `test-results/` on each run, so the failure context from the failing run was gone before it could be read. It is recorded here rather than dismissed as flake so the next person to see it knows it has happened before and does not start from zero.

If it recurs, capture the evidence before re-running: copy `test-results/` aside, or run that spec alone with `--repeat-each` under load. The likely suspect is the rule above — the spec deploys a team and waits for the office to play a handoff, which is timing the test does not fully own.

## Writing a test for a template or an extension

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  getTemplate,
  validateTemplate,
} from "../packages/core/src/workflows/templates/index.js";
import {
  validateContract,
  validateResult,
} from "../packages/core/src/workflows/contracts.js";

test("a pack fails when the evidence is missing", () => {
  const pack = getTemplate("data-analytics");
  assert.ok(validateTemplate(pack));
  const contract = validateContract(
    pack.steps.find((s) => s.key === "analyze").contract,
  );
  const result = validateResult(contract, {
    artifacts: [],
    events: [{ kind: "file.edit", file: "analysis/query.sql" }],
  });
  assert.equal(result.ok, false); // a generated query is not an executed result
});
```

`tests/templates.test.js` and `tests/extensions.test.js` are the worked examples: template shape and objective criteria, tool and connector vocabularies, the analytics and research distinctions, manifest validation, semver ranges, permission diffs, refused installs and removals, checksum verification, and secret-free template export. The extension route test drives `routes/extensions.js` directly with a fake `ctx`, which is the cheapest way to test a route module.

## Adding a provider

The work is spread over five owned modules; do them in this order and stop at the first one you cannot verify honestly.

1. **Registry** — add an entry to `packages/core/src/providers/registry.js`: id, display name, vendor, binaries, home env var and default, docs URL, `minVersion` / `verifiedVersions`, and a capability matrix. Every capability starts `unknown`; it becomes `verified` only when you have run it on this machine, `experimental` when the command shape is documented but unproven, `unsupported` when the vendor has no such feature.
2. **Detection** — `providers/detect.js` resolves the binary (`where` on win32, filtered by PATHEXT), reads `--version` with a timeout ≤ 5 s, and reports the auth hint from **file existence only** — never by reading a credential.
3. **Observer** — `packages/core/src/observe/<provider>.js` exporting `createObserver({ home, env })` → `scanSessions()`, `readEvents(session, offset)`, `isLive(session)`. Read only files the vendor documents. Capture a real (sanitized) sample into `tests/fixtures/providers/` and parse _that_ in the test. Return `[]` when the storage is absent rather than guessing.
4. **Adapter** — `packages/core/src/adapters/<provider>.js` with `build()`, `parse(line, state)`, `finalize(state, exitCode)`, `interrupt(child)` per `adapters/base.js`. Normalize through `makeEvent()` so provenance, tool, file, usage, and model are set consistently. Add a fake CLI in `tests/fixtures/fake-cli/` that replays the captured stream, and register it in that README's table.
5. **Tests** — extend `tests/providers.test.js` (registry and detection), add `tests/observe-*.test.js` coverage, and add an adapter case to `tests/adapters.test.js` including a malformed line, a duplicate event id, and a missing-usage case.

Then update [CONNECTIONS.md](CONNECTIONS.md) and `docs/ROADMAP_STATUS.md` with what was actually verified, and on which version and OS.

**Worked example of honesty:** Gemini CLI 0.59.0 is installed on this machine and its flags are verified from its own `--help` (`-p`, `-o text|json|stream-json`, `--approval-mode`, `-m`, `-r`, `--session-id`, `--include-directories`). It is not authenticated: every run exits 41 with an auth error on stderr, and `~/.gemini/settings.json` does not exist until an auth method is chosen. So the launch **flags** are verified while a completed **run** is not, and the capability matrix must say exactly that — `experimental` for launch, `unknown` for anything that depends on a finished run. `cursor-agent` is genuinely not installed (only the Cursor IDE launcher), so Cursor stays detect-only and experimental.
