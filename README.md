# Agent Space

A local-first command center for AI agents. It shows what your coding assistants are doing right now in a procedural 3D office and a task board, launches bounded runs through the provider CLIs you already have installed, routes their permission requests into a decision inbox, and keeps every run's events, artifacts, and approvals in a local SQLite database. The product strategy lives in [Idea/PRODUCT_ROADMAP.md](Idea/PRODUCT_ROADMAP.md); what has actually shipped is tracked line by line in [docs/ROADMAP_STATUS.md](docs/ROADMAP_STATUS.md).

![Desktop workspace](artifacts/workspace-desktop.png)

## Status

| Area                                                                                                                | State                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| React dashboard, task board, Board/Timeline/Dependency/Analytics views, shared selection and filters                | Working                                                                                                                                                                                                                                                               |
| Three.js office: eight environments, activity zones, minimap, follow camera, reduced motion, graphics presets, 2D fallback | Working, event-driven, all assets generated locally                                                                                                                                                                                                            |
| Conference wing: agents walk through the door, take a seat at a round table and work individually while the room lasts | Working; a room opens only for recorded shared work, keeps its slot, and stays until the last agent leaves                                                                                                                                                     |
| Arranging the office: move and rename rooms, choose what each room is for, place furniture, export as a portable preset | Working ([docs/API.md](docs/API.md) "Office appearance"); the server refuses two rooms serving one function                                                                                                                                                    |
| Agents directory with 3D portraits, and keyboard/screen-reader paths through the 3D views                            | Working; portraits share a single WebGL context, and the office has a 2D fallback                                                                                                                                                                                     |
| Global search, command palette, drag-to-assign, pinned runs, day in review, presentation and focus modes            | Working                                                                                                                                                                                                                                                               |
| Manual task lifecycle, assignment, progress, demo mode                                                              | Working, confined to the demo workspace                                                                                                                                                                                                                               |
| WebSocket snapshots (per workspace and global channel), reconnect                                                   | Working                                                                                                                                                                                                                                                               |
| Persistent workspaces, agent profiles, runs, migrations                                                             | Working, SQLite via `node:sqlite` (schema v9), no native dependencies                                                                                                                                                                                                 |
| Provider detection, connection doctor, aliases, kinds, error categories, migration assistant                        | Working for Claude Code, Codex, Copilot, Cursor, Gemini CLI (see [docs/CONNECTIONS.md](docs/CONNECTIONS.md))                                                                                                                                                          |
| Observation of sessions started outside Agent Space                                                                 | Working for Claude Code, Codex, Copilot (their own session files); Cursor summaries only (experimental); Gemini layout read defensively and labelled unverified                                                                                                       |
| Managed runs (launch, stream, cancel, retry, input, worktree or scoped output folder, artifacts, review)            | Verified with Claude Code and Copilot here; Codex stream format verified but the end-to-end run hit the account usage limit; `cursor-agent` not installed so Cursor refuses to launch; Gemini command line verified from `--help` but the CLI is unauthenticated here |
| Reliability: bounded retries, failure classification, circuit breakers, rate-limit parking, token budgets           | Working ([docs/POLICY.md](docs/POLICY.md) §6–7)                                                                                                                                                                                                                       |
| Workspace policy, approvals, decision inbox, tamper-evident audit log                                               | Working; Claude Code approvals via the hook bridge, Codex via the opt-in app server; Copilot, Cursor and Gemini have no approval channel                                                                                                                              |
| Workflows: dependencies, 13 domain packs, contracts, branches, repair loops, checkpoints, dry run, replay, versions | Working ([docs/TEMPLATES.md](docs/TEMPLATES.md))                                                                                                                                                                                                                      |
| Operations: health, stop-all, quarantine, backup and restore drill, redacted diagnostics, retention                 | Working ([docs/OPERATIONS.md](docs/OPERATIONS.md)); retention is off by default and nothing is deleted until you turn it on                                                                                                                                           |
| Analytics: funnel, time breakdown, availability, saturation, heatmaps, forecasts, lineage, OTLP-shaped export       | Working; every figure is labelled counted, reported, measured or estimated                                                                                                                                                                                            |
| Evaluation: five dimensions, benchmarks with frozen inputs, variant comparison, shadow experiments                  | Working; `correctness` and `security` are never asserted by Agent Space                                                                                                                                                                                               |
| Context: manifests with pinned revisions, scoped memory, knowledge collections, relevance ranking, transfer records | Working                                                                                                                                                                                                                                                               |
| Collaboration: handover briefs, decision history, request-change                                                    | Working; no comments, mentions or notifications                                                                                                                                                                                                                       |
| Connectors: filesystem, Git, GitHub (through `gh`)                                                                  | Reads working and scoped; the one write (draft PR) needs both policy and an approved approval                                                                                                                                                                         |
| Extensions and template sharing                                                                                     | Registry working; **no extension is ever loaded or executed** ([docs/EXTENSIONS.md](docs/EXTENSIONS.md))                                                                                                                                                              |
| Webhooks (signed, both directions) and MCP server                                                                   | Working; MCP runs as a separate process over HTTP, and `decide_approval` is gated                                                                                                                                                                                     |
| CLI (`bin/agent-space.js`)                                                                                          | Working, no dependencies                                                                                                                                                                                                                                              |
| Shared mode (bearer token), remote workers, roles                                                                   | Token auth working; remote workers, roles and tenant isolation are not built                                                                                                                                                                                          |
| Unit, integration, and Chrome browser tests                                                                         | Working: `node --test` 716 tests, Playwright 57 tests in 22 files, and a 256-render route audit ([docs/TESTING.md](docs/TESTING.md))                                                                                                                                  |

Activity shown for provider sessions is derived from tool names and is always labelled "inferred". Models and costs are shown only when the provider reports them ("model not reported" otherwise). Progress percentages exist only for manual and demo tasks; provider runs show elapsed time and recorded events.

### Roadmap phase 1 (R1): persistent identity

- **Workspaces.** Create, rename, archive, and restore project workspaces from the switcher in the top bar. Each keeps its own agents, tasks, runs, activity, policy, and theme. The demo workspace always exists and is the only place the simulation runs.
- **Agent profiles.** Rename, edit role, color, working style, specialty, instructions, and provider. Duplicate, archive, and restore profiles. An agent with active work cannot be archived.
- **Runs.** Assigning a task starts a run that stores a snapshot of the agent profile; managed runs also snapshot the exact command, policy, and isolation. Editing the profile later never rewrites that run.
- **Storage.** Everything is written to `data/agent-space.sqlite` with versioned migrations (schema v9; there is no v7 — the number was skipped). Set `AGENT_SPACE_DB` to another path, or to `:memory:` for a throwaway database.

## Live sessions and real integrations

**What auto-detects.** On start the server looks for `claude`, `codex`, `copilot`, `cursor-agent`, and `gemini` on `PATH`, runs `--version` on each (8 s cap), and checks whether the provider's documented credential file exists — existence only, nothing is read. The startup lines summarise it, for example:

```
Startup: providers — claude-code 2.1.258 ready, codex 0.152.1 ready, copilot 1.0.80 detected,
  cursor 3.14.27 detected, gemini 0.59.0 detected | live sessions: 1 | hooks: not installed | observation: on
Operations: dispatch allowed | circuit breakers: all closed | retention: off (nothing is deleted) |
  scheduled reports: none enabled | health: ok | optional modules: connectors
```

Read the statuses literally: `ready` means the binary answered **and** a credential file exists; `detected` means only the binary was found. The Connections view shows the same table with a doctor that explains what is missing, plus each connection's error category, remediation and probe history.

**What to expect when Claude Code, Codex, or Copilot run on this machine.** Every two seconds Agent Space reads the vendors' own session files (`~/.claude/sessions/*.json` and `~/.claude/projects/**/*.jsonl`, `~/.codex/sessions/**/rollout-*.jsonl`, `~/.copilot/session-state/*/events.jsonl`). A session whose working directory matches a workspace root appears there; otherwise a workspace named after the folder is created automatically (`autoCreated: true`). The session becomes an observed run on an auto-created agent, the agent walks to the zone matching its last tool call, the card shows the current file and elapsed time, and the Live sessions view lists it with its model when reported. A session with no new events for three minutes is marked stale. Claude Code sessions end when their process exits, Copilot sessions when the CLI writes its `result`, Codex sessions after 30 minutes of inactivity — and that last one is labelled "inferred", because it is. Nothing is ever written to the providers' folders.

**Cursor and Gemini, honestly.** `cursor-agent` is not installed here — only the Cursor IDE launcher — so the Cursor adapter **refuses to launch** with an install link rather than emitting a command that would open the IDE; its observer reads conversation summaries read-only and labels them experimental. The `gemini` binary is present and its launch flags are verified from its own `--help`, but the CLI is unauthenticated here (every invocation exits 41 with a JSON error envelope), so no Gemini run or session has ever been observed: its stream format, model reporting and usage stay `unknown`, and everything the observer parses carries `unverified: true`.

**Managed runs.** Create a task, choose a connected provider, and press "Run now" (or `node bin/agent-space.js run <workspace> <taskId> --provider claude-code`). The exact command is built per provider and policy (see [docs/CONNECTIONS.md](docs/CONNECTIONS.md)): for example `claude -p "<prompt>" --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools Read Edit Write MultiEdit Glob Grep Bash`. A `sandbox` workspace runs in a Git worktree under `data/worktrees/<runId>`; a non-Git document folder gets a scoped output folder under `data/outputs/<runId>` instead, and the run says out loud that nothing is copied in or back. A pinned code range is resolved to a revision at launch, so a stale line reference is caught before you apply the result. When the run finishes, the diff, test output and final message are captured as artifacts and the task waits in the inbox for you to accept or reject.

**When something goes wrong.** Failures are classified from the run's own evidence (`transport`, `rate-limit`, `auth`, `usage-limit`, `provider-error`, `user-cancelled`, `side-effects-possible`). Only transport and rate-limit failures retry automatically, with bounded jittered backoff; a run that may already have edited files is **never** retried automatically and lands in the inbox instead. Repeated provider failures open a circuit breaker, and a rate limit parks that provider until the reset time the provider reported — or, when it gave none, for a cooldown we describe as ours.

**Approvals.** Install the Claude Code hooks once to route permission prompts through the inbox (existing hooks such as `rtk` are kept; a backup of `settings.json` is written):

```sh
node bin/agent-space.js hook install --url http://127.0.0.1:5173
```

Equivalent: the Install button on the Connections page or `POST /api/hooks/claude-code/install`. Under the default `scoped` policy a plain `git push` is denied by the denied list; risky commands (`rm -rf`, `git reset --hard`, deploy verbs, …) create an approval the hook waits on until you approve, deny or request a change in the inbox. The approval is bound to the exact command by hash, so an edited command needs a fresh decision. Codex approvals work only with the app-server transport (`PUT /api/settings {"codex.useAppServer": true}`, experimental). Copilot's non-interactive mode pre-approves tools, so no per-call approval is possible; Cursor and Gemini have no approval channel at all.

**Environment variables.** `PORT`, `HOST`, `DEMO`, `AGENT_SPACE_DB`, `AGENT_SPACE_TOKEN` (required to bind a non-loopback `HOST`), `AGENT_SPACE_URL` (CLI, hook and MCP bridge), `AGENT_SPACE_OBSERVE=false` (disable observation), `AGENT_SPACE_OBSERVE_INTERVAL` (ms), `AGENT_SPACE_DATA_DIR` (worktrees, output folders, artifacts), `AGENT_SPACE_BIN_<PROVIDER>` (binary override, e.g. `AGENT_SPACE_BIN_CLAUDE_CODE`), and the provider homes `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME`, `CURSOR_HOME`, `GEMINI_HOME`. See `.env.example` and [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Operate

Day-to-day running, and the switches you reach for when something is wrong. Full detail in [docs/OPERATIONS.md](docs/OPERATIONS.md); the rules behind them in [docs/POLICY.md](docs/POLICY.md).

| You want to                              | Do this                                                                                                                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| See how the machine is holding up        | Operations view, or `GET /api/ops/health` — database, queue, provider breakers, observation, approvals, budget, alerts with fixes                                                                                |
| Stop everything now                      | `POST /api/ops/stop-all {"confirm":true,"reason":"…"}`. New dispatch is refused and cancellation is **requested**; each run stays listed as unacknowledged until it actually stops. It never undoes side effects |
| Take a provider out of service           | `POST /api/ops/connections/:id/revoke {"confirm":true}` — disables it and cancels its runs                                                                                                                       |
| Back up, and prove the backup restores   | `POST /api/ops/backup {"confirm":true,"outPath":"…"}`, then `POST /api/ops/restore-drill {"confirm":true}` — restores into a throwaway path and compares row counts and a sha256                                 |
| Send a support bundle                    | `POST /api/ops/diagnostics {"confirm":true}` — home paths masked, secret literals scrubbed, and it lists what it removed                                                                                         |
| Delete old records                       | `GET/PUT /api/ops/retention`, then `POST /api/ops/retention/sweep {"confirm":true,"dryRun":true}` to preview. Retention is **off by default**; a sweep never removes a live run or an unfinished task            |
| Check the audit log has not been altered | `GET /api/audit/verify` — hash chain, with pre-upgrade rows counted honestly as `unchained` or `legacy` rather than claimed as verified                                                                          |

Every `POST` under `/api/ops` needs an explicit `{"confirm": true}` and is audited.

## Extend

| You want to                                       | Start here                                                                                                                                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Run a domain workflow, or write one               | [docs/TEMPLATES.md](docs/TEMPLATES.md) — the 13 packs, the contract each carries, and why subjective acceptance criteria are refused                                                                                           |
| Describe an extension, or share a template safely | [docs/EXTENSIONS.md](docs/EXTENSIONS.md) — the manifest, the trust model, and the workspace permission ceiling. **No extension is ever loaded or executed in this build**; a signature establishes the publisher, never safety |
| Use Agent Space from another agent                | `node bin/agent-space-mcp.js` exposes a running server over MCP on stdio — eleven tools, nine read-only, with `decide_approval` gated behind the `mcp.allowDecisions` setting. See [docs/API.md](docs/API.md)                  |
| Receive or send job events                        | Signed webhooks in both directions ([docs/POLICY.md](docs/POLICY.md) §11). The shared secret is read from an environment variable you name; it is never stored                                                                 |
| Add a provider, or write a test                   | [docs/TESTING.md](docs/TESTING.md) — fixtures, the fake-CLI harness, and the rule that no test ever calls a real provider                                                                                                      |

## Run

### One command

```sh
npx @adhirocks2/agentspace
```

It finds a free port, opens your browser, detects which assistants are installed on this machine, and starts showing the sessions they are already running. Nothing is uploaded and no account is needed.

```sh
npx @adhirocks2/agentspace --no-open        # do not open a browser
npx @adhirocks2/agentspace --port 6100      # choose the port
npx @adhirocks2/agentspace --demo           # load the simulated showcase workspace
npx @adhirocks2/agentspace --data <dir>     # keep the database somewhere else
```

Your database and run artifacts live in the usual place for your operating system — `%LOCALAPPDATA%\agentspace` on Windows, `~/Library/Application Support/agentspace` on macOS, `${XDG_DATA_HOME:-~/.local/share}/agentspace` on Linux — not inside the downloaded package, so they survive the next `npx`.

Works the same on Windows, macOS and Linux: there are no native modules to compile. Storage is `node:sqlite`, which is why Node **22.13+ or 24+** is required, and why installing needs no compiler and no `node-gyp`. A browser with WebGL2 is needed for the 3D view (there is a 2D fallback without it). Git is needed for worktree isolation and diff artifacts.

[![npm](https://img.shields.io/npm/v/@adhirocks2/agentspace)](https://www.npmjs.com/package/@adhirocks2/agentspace)

> The package is scoped because npm refuses unscoped names too close to an existing one, and `agentspace` collides with the unrelated `agent-space`. The scope is what makes it publishable; the product is still Agent Space.

### From a clone

```sh
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:5173**. The server starts with clearly labeled demo tasks in the demo workspace. Set `DEMO=false` to skip loading them, or use the pause button to stop simulated progress. `PORT` changes the port, `HOST` the bind address (loopback by default), and `AGENT_SPACE_DB` the SQLite file.

```powershell
# Windows example
$env:DEMO = 'false'
npm start
```

For development run `npm run dev` (server with restart on change) and `npm run dev:web` (Vite with hot reload on http://127.0.0.1:3000) in two terminals.

## Verify

```sh
npm test           # Node unit and integration tests (716)
npm run build      # Vite production build
npm run test:ui    # Playwright browser suite (57 tests in 22 files)
npm run test:routes # Route audit: 16 routes x 8 viewports x 2 themes (256 renders)
```

The Node suite never calls a real provider: adapters and the run worker use the fake CLIs in `tests/fixtures/fake-cli/`, and observers read fixture homes. The browser suite uses an installed Google Chrome, starts an isolated server on port 5174 with an in-memory database, the fake CLIs, and empty provider homes under `test-results/homes`, and covers desktop and mobile rendering, two-tab synchronization, the manual task lifecycle, a fake managed run through the inspector, a hook approval through the inbox, a live Claude Code session with an auto-created workspace, the command palette, first-run setup, global search, keyboard drag-to-assign, request-change, the operations panel, day in review, pinned runs, the workspace switcher, server-stored office settings, the knowledge/memory/handover panels, the agents directory, arranging the office, conference-room scale, and a screen-reader pass over the landmarks, headings and live regions. See [docs/TESTING.md](docs/TESTING.md). To use another browser, change `channel` in `playwright.config.js`. On Linux CI run `npx playwright install chrome` first. Preview captures are written to `artifacts/`.

## API

All write endpoints require `Content-Type: application/json`. Requests are limited to 16 KB (hook payloads 256 KB). Errors return `{ "error": "description" }` with a 4xx status. The server accepts local hosts and same-origin browser requests only; set `AGENT_SPACE_TOKEN` for shared mode (bearer token on every request and WebSocket).

The complete route list with bodies and responses is in [docs/API.md](docs/API.md). Routes are scoped per workspace under `/api/workspaces/:id/...`; the shorter forms without a workspace prefix target the demo workspace, or the one named by `?workspace=<id>`. The most used ones:

| Endpoint                                                   | Purpose                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                                          | Health, mode, task count, workspace count, schema version                                                                       |
| `GET /api/workspaces`, `POST /api/workspaces`              | List (add `?archived=1`) and create `{ "name", "rootPath", "theme", "policy" }`                                                 |
| `PATCH /api/workspaces/:id`, `/archive`, `/restore`        | Rename, change folder, theme, or policy; archive or restore                                                                     |
| `GET /api/workspaces/:id/workspace`                        | Complete snapshot: workspace, agents (with activity and provenance), tasks, runs, activity, workspaces                          |
| `POST /api/workspaces/:id/tasks`                           | Create `{ "title", "description", "priority", "agentId", "provider", "deliverable", "target", "executionPolicy", "dependsOn" }` |
| `POST /api/workspaces/:id/tasks/:taskId/run`               | Launch a managed run `{ "provider", "prompt", "model", "isolation", "policy" }`                                                 |
| `GET /api/runs/:id`, `/events`, `/artifacts`               | Run passport, events, artifacts; `POST …/cancel`, `/retry`, `/input`, `/review`                                                 |
| `GET /api/connections`, `/doctor`, `/capabilities`         | Detected providers, plain-language diagnostics, capability matrix                                                               |
| `GET /api/sessions?live=1`                                 | Observed provider sessions                                                                                                      |
| `GET /api/inbox`, `POST /api/approvals/:id/decide`         | Decisions needed; approve or deny                                                                                               |
| `GET/PUT /api/workspaces/:id/policy`                       | Workspace policy; `POST …/policy/preview` explains a decision                                                                   |
| `POST /api/hooks/claude-code/install`                      | Install the Claude Code hook bridge (`/status`, `/uninstall`)                                                                   |
| `GET /api/templates`, `POST /api/workspaces/:id/workflows` | Domain templates and workflow instantiation                                                                                     |
| `GET /api/analytics`, `/api/analytics/export`              | Funnel, time breakdown, usage; CSV/JSON export                                                                                  |
| `GET /api/search?q=`                                       | Search Agent Space's own records (tasks, runs, events, artifacts, sessions) — never file contents                               |
| `GET /api/ops/health`, `POST /api/ops/stop-all`            | Service health with fixes; stop all dispatch (needs `{"confirm": true}`)                                                        |
| `GET /api/audit/verify`, `/api/audit/export`               | Hash-chain verification and CSV/JSON export of the audit log                                                                    |
| `GET /api/connectors`, `POST /api/connectors/:id/read`     | Filesystem, Git and GitHub connectors with honest availability; scoped reads                                                    |
| `GET /api/extensions`, `GET /api/templates/:id/export`     | Extension registry and secret-stripped template sharing                                                                         |
| `POST /api/webhooks/:endpointId`                           | Signed inbound receiver (HMAC-SHA256, replay-protected)                                                                         |
| `WS /ws?workspace=<id>`, `WS /ws?channel=global`           | Read-only `workspace:snapshot` and `global:snapshot` events                                                                     |

Demo workspace agent IDs: `atlas`, `nova`, `echo`, `pixel`, `orbit`, `sage`. Project workspaces get their own copies of these profiles with workspace-prefixed IDs. Priorities: `low`, `medium`, `high`, `critical`. Working states: `CODING`, `ANALYZING`, `TESTING`, `DEBUGGING`, `RESEARCHING`.

Task lifecycle: `QUEUE → IN_PROGRESS → COMPLETED`, with `IN_PROGRESS ↔ BLOCKED`. Completion sets progress to 100 and releases the agent. Progress cannot decrease and completed tasks are immutable. Run statuses: `queued`, `running`, `waiting_approval`, `blocked`, `stale`, `completed`, `failed`, `cancelled`, `disconnected`.

```powershell
$task = Invoke-RestMethod http://127.0.0.1:5173/api/tasks -Method Post -ContentType 'application/json' -Body '{"title":"Review project","priority":"high"}'
Invoke-RestMethod "http://127.0.0.1:5173/api/tasks/$($task.id)/assign" -Method Post -ContentType 'application/json' -Body '{"agentId":"sage"}'
Invoke-RestMethod "http://127.0.0.1:5173/api/tasks/$($task.id)" -Method Patch -ContentType 'application/json' -Body '{"status":"COMPLETED"}'
```

## Project layout

```text
apps/web/src/          React interface, WebSocket hooks, Three.js office (office/), views/, components/
packages/core/src/     SQLite schema, tasks, agents, workspaces, providers/, observe/, adapters/, runs/, policy/, approvals/, hooks/, audit/, workflows/, analytics/, context/, collab/, connectors/, connections/, extensions/, mcp/, ops/, search/, webhooks/, export/
packages/server/src/   Local HTTP API (routes/), static frontend, WebSocket broadcast, main.js entrypoint
bin/                   agent-space.js CLI (also the Claude Code hook command), agent-space-mcp.js MCP bridge
docs/                  ARCHITECTURE, ROADMAP_STATUS, API, CONNECTIONS, POLICY, OPERATIONS, TEMPLATES, EXTENSIONS, TESTING
data/                  SQLite database, worktrees, scoped output folders, artifacts (created on first start, ignored by git)
tests/                 Node unit and integration tests, provider fixtures, fake CLIs
e2e/                   Chrome browser acceptance tests
artifacts/             Desktop and mobile captures
```

## Documents

| File                                                                           | Purpose                                                                                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| [CHANGELOG.md](CHANGELOG.md)                                                   | What changed and when, with the same honest statuses used everywhere else                                                       |
| [Idea/PRODUCT_ROADMAP.md](Idea/PRODUCT_ROADMAP.md)                             | Product strategy, release gates R1–R6, and the next step                                                                        |
| [docs/ROADMAP_STATUS.md](docs/ROADMAP_STATUS.md)                               | Done / Partial / Deferred status of every roadmap item with evidence                                                            |
| [docs/ROADMAP_NEXT.md](docs/ROADMAP_NEXT.md)                                   | The prioritised queue of what gets built next, and the market study behind it                                                   |
| [docs/UI_UX_REVIEW.md](docs/UI_UX_REVIEW.md)                                   | Page-by-page UI/UX audit board, design tokens and shell decisions, verification evidence                                        |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                                   | Module contracts, schema v1–v9, verified provider facts                                                                         |
| [docs/CONNECTIONS.md](docs/CONNECTIONS.md)                                     | Per-provider detection, observation, launch commands, approvals, limitations                                                    |
| [docs/API.md](docs/API.md)                                                     | Every HTTP route and WebSocket channel                                                                                          |
| [docs/POLICY.md](docs/POLICY.md)                                               | Autonomy, retries, budgets, incidents, retention, extension permissions, webhook trust, MCP gating, audit, what is not enforced |
| [docs/OPERATIONS.md](docs/OPERATIONS.md)                                       | Running the server, backup and restore drills, incident stop switch, retention, diagnostics, acceptance gates                   |
| [docs/TEMPLATES.md](docs/TEMPLATES.md)                                         | The 13 domain packs and the contract each one carries                                                                           |
| [docs/EXTENSIONS.md](docs/EXTENSIONS.md)                                       | Extension manifest, trust model, and template sharing without secrets                                                           |
| [docs/TESTING.md](docs/TESTING.md)                                             | Fixtures, the fake-CLI harness, browser tests, adding a provider                                                                |
| [Idea/AGENT_WORKSPACE_SYSTEM_PROMPT.md](Idea/AGENT_WORKSPACE_SYSTEM_PROMPT.md) | Original visualizer specification (the idea the product grew from)                                                              |
| [Idea/PROJECT_STRUCTURE.md](Idea/PROJECT_STRUCTURE.md)                         | Proposed monorepo layout                                                                                                        |
| [Idea/IMPLEMENTATION_GUIDE.md](Idea/IMPLEMENTATION_GUIDE.md)                   | Original phased implementation notes                                                                                            |
| [Idea/QUICK_REFERENCE.md](Idea/QUICK_REFERENCE.md)                             | Architecture and UI quick reference                                                                                             |
| [Idea/STARTER_FILES.md](Idea/STARTER_FILES.md)                                 | Starter configuration samples                                                                                                   |

## Licence

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). You may use, modify and redistribute it, including commercially, provided the licence and notices travel with it; the licence also carries an explicit patent grant from every contributor.

The published package bundles React, react-dom, three and lucide-react into the interface and installs `ws` at runtime, each under its own MIT or ISC licence. Minification strips the licence comments that would otherwise sit inside `apps/web/dist`, so those notices are reproduced in full in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), which ships with every copy.

The copyright line in `NOTICE` reads "The Agent Space authors". Replace it with your own name or your company's if you would rather it named you directly.

## Container option

```sh
docker build -t agent-space .
docker run --rm -p 127.0.0.1:5173:5173 -e AGENT_SPACE_TOKEN=change-me agent-space
```

The image binds `0.0.0.0`, so `AGENT_SPACE_TOKEN` is required; `data/` is a volume for the database, worktrees, and artifacts. Provider CLIs are not in the image, so managed runs and observation need the CLIs and their homes mounted or installed separately. The container recipe has not been exercised in this environment. Without a token the server is intended for local single-user use only.
