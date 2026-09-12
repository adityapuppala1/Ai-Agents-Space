# Operations

Running, backing up, recovering, and verifying an Agent Space install. Windows 11 x64 is the tested host; the commands below are PowerShell-friendly and work unchanged in Git Bash unless noted.

## Running the server

```bash
npm install                       # ws is the only runtime dependency
npm start                         # node packages/server/src/main.js
npm run dev                       # same, with --watch
npm run build && npm start        # build the web app, then serve it
node --env-file=.env packages/server/src/main.js   # load .env (Node does not by itself)
```

Default: `http://127.0.0.1:5173`. On boot `main.js` refreshes connections, reconciles managed runs, starts observation unless `AGENT_SPACE_OBSERVE=false`, and logs a startup summary.

Health, at any time:

```bash
curl http://127.0.0.1:5173/api/ops/health
curl http://127.0.0.1:5173/api/ops/status
node bin/agent-space.js doctor --json
```

## Environment variables

Full reference in [`.env.example`](../.env.example) and [ARCHITECTURE.md](ARCHITECTURE.md) section 7. Every one is optional.

| Variable                                                                        | Effect                                                             |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `PORT`, `HOST`                                                                  | Bind address. Use `HOST=0.0.0.0` **only** with `AGENT_SPACE_TOKEN` |
| `AGENT_SPACE_TOKEN`                                                             | Bearer token for every `/api` request and WebSocket (shared mode)  |
| `AGENT_SPACE_WEBHOOK_ALLOW_PRIVATE`                                             | Allow outbound webhooks to loopback/private addresses. Defaults to yes when bound to loopback, no when bound to the network |
| `AGENT_SPACE_DB`                                                                | SQLite file, or `:memory:`                                         |
| `AGENT_SPACE_DATA_DIR`                                                          | Worktrees and artifacts (default `data/`)                          |
| `DEMO`                                                                          | Load the isolated demo workspace                                   |
| `AGENT_SPACE_OBSERVE`, `AGENT_SPACE_OBSERVE_INTERVAL`                           | Observation of sessions started outside Agent Space                |
| `AGENT_SPACE_URL`                                                               | Server URL for the CLI and the Claude Code hook                    |
| `AGENT_SPACE_BIN_<PROVIDER>`                                                    | Binary override, e.g. `AGENT_SPACE_BIN_CLAUDE_CODE`                |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME`, `CURSOR_HOME`, `GEMINI_HOME` | Provider homes (read-only)                                         |
| `AGENT_SPACE_WEBHOOK_INTERVAL`, `AGENT_SPACE_HEALTH_INTERVAL`                   | Background timers                                                  |

Secrets are never stored in the database, the audit log, or settings: webhook signing secrets are referenced by environment-variable **name** and read at delivery time, and provider credentials stay with each provider CLI.

## Backup and restore drill

Backups never overwrite an existing file, and never write inside a provider home.

```bash
# Back up (writes the database copy plus a manifest with counts and a sha256)
curl -X POST http://127.0.0.1:5173/api/ops/backup \
  -H "content-type: application/json" \
  -d '{"confirm":true,"outPath":"C:/backups/agent-space-2026-09-10.sqlite","label":"nightly"}'

# Drill: back up, restore into a throwaway path, reopen it, compare row counts
curl -X POST http://127.0.0.1:5173/api/ops/restore-drill \
  -H "content-type: application/json" -d '{"confirm":true}'
```

The drill result reports the source and restored table counts. A drill that does not match is a failed drill: fix it before trusting the backup. Restoring into the live instance is a deliberate, offline step — stop the server, replace `AGENT_SPACE_DB`, start it again, and confirm `GET /api/ops/health` and one workspace snapshot before resuming work.

## Incident stop switch

```bash
curl -X POST http://127.0.0.1:5173/api/ops/stop-all \
  -H "content-type: application/json" -d '{"confirm":true,"reason":"suspected credential leak"}'
curl http://127.0.0.1:5173/api/ops/dispatch-allowed        # → { allowed:false, reason }
curl -X POST http://127.0.0.1:5173/api/ops/resume \
  -H "content-type: application/json" -d '{"confirm":true,"reason":"cleared"}'
```

Stop-all is enforced server-side on the dispatch paths, not by hiding buttons. Related switches: `POST /api/ops/connections/:id/revoke` (stop using one connection), `POST /api/ops/quarantine` (`{ host, release? }`), and per-run `POST /api/runs/:id/cancel`.

**Stopping does not undo side effects.** A cancelled run's file writes, commits, and external calls stand; the run's events say so and the UI repeats it. After a stop, review the diffs in the run inspector before deciding what to revert by hand.

## Retention

```bash
curl http://127.0.0.1:5173/api/ops/retention                       # policy + preview of what a sweep would delete
curl -X PUT http://127.0.0.1:5173/api/ops/retention \
  -H "content-type: application/json" \
  -d '{"enabled":true,"eventsDays":90,"runsDays":365,"auditDays":365,"artifactsDays":90}'
curl -X POST http://127.0.0.1:5173/api/ops/retention/sweep \
  -H "content-type: application/json" -d '{"confirm":true,"dryRun":true}'   # then dryRun:false
```

Always run the dry run first and read the counts. Deletion is permanent; take a backup before the first real sweep.

## Diagnostics and support bundle

```bash
curl "http://127.0.0.1:5173/api/ops/diagnostics?outPath=C:/temp/agent-space-diagnostics"
curl "http://127.0.0.1:5173/api/ops/diagnostics?events=0"     # smaller bundle, no event bodies
node bin/agent-space.js doctor            # plain-language provider problems and fixes
curl http://127.0.0.1:5173/api/connections/doctor
```

The bundle reports its own redaction. Read it before sending it anywhere: it is your machine's data.

## Audit

```bash
curl "http://127.0.0.1:5173/api/audit?limit=200"
curl http://127.0.0.1:5173/api/audit/verify                 # hash-chain check
curl "http://127.0.0.1:5173/api/audit/export?format=csv" > audit.csv
```

`verify` reports the first sequence number that does not match, and counts pre-v5 rows separately as `unchained` rather than claiming them verified.

## Upgrade and rollback

1. Back up first (`/api/ops/backup`) and keep the manifest next to the file.
2. Stop the server.
3. Update the source, run `npm install`, run `npm test`.
4. Start the server. Migrations in `packages/core/src/db.js` are applied in order on `openDatabase()`; they only ever add.
5. Verify: `GET /api/ops/health`, one workspace snapshot, `GET /api/audit/verify`.

Rollback: stop the server, restore the previous source, and restore the backup taken in step 1 to `AGENT_SPACE_DB`. A database written by a newer build may contain columns an older build does not read; roll back the database with the code, never only one of them.

---

# Acceptance gates as executable checklists

Roadmap sections 6 (phases) and 18 (releases R1–R6). Each item is a command plus the observation that decides pass or fail. Run them from the repository root. Everything below uses temp databases, fixture provider homes, and the fake CLIs — no real provider CLI is launched, and no real provider home is touched.

Baseline for every gate:

```bash
npm test                      # node --test over tests/*.test.js
npm run build                 # vite build of apps/web
npx playwright test           # e2e/*.spec.js (Chrome)
```

## R1 — Persistent workspace (phase 1)

Scope: saved profiles, workspaces, runs, demo isolation, migrations.

- [ ] `node --test tests/persistence.test.js` — passes (restart retains data, profile snapshots survive edits).
- [ ] `node --test tests/workspace.test.js tests/realtime.test.js` — passes (isolation, reconnect snapshot).
- [ ] `npx playwright test e2e/workspace.spec.js` — passes (workspaces isolated, agent edits persist across reloads).
- [ ] Restart drill: `AGENT_SPACE_DB=data/gate-r1.sqlite npm start`, create a workspace and an agent, stop, start again, `curl http://127.0.0.1:5173/api/workspaces` — the workspace and agent are still there.
- [ ] Demo isolation: with `DEMO=true`, `curl http://127.0.0.1:5173/api/workspaces` — simulated runs appear only in the demo workspace.

## R2 — Real local work (phase 2)

Scope: one provider, scoped worker, decisions, provenance, artifacts.

- [ ] `node --test tests/run-worker.test.js tests/adapters.test.js` — passes (launch, cancel, retry, input, worktree isolation, unauthorized targets refused).
- [ ] `node --test tests/hooks.test.js tests/approvals.test.js tests/policy.test.js` — passes (deny path, payload-bound decisions, expiry, secret paths always denied).
- [ ] `node --test tests/run-recorder.test.js` — passes (duplicate `provider_event_id` recorded once).
- [ ] `npx playwright test e2e/execution.spec.js` — passes (Run now launches a managed run; a hook approval flows through the inbox).
- [ ] Restart drill: start a run with a fake CLI, kill the server, restart — the run is `disconnected`, and `POST /api/runs/:id/retry` refuses without `{"force":true}`.
- [ ] Real repo drill (manual, deliberate): in a disposable git repo, create a task, run it with a connected provider, inspect the diff and test artifacts in the inspector, then accept or reject the review.

## R3 — Public developer beta (phases 3–4)

Scope: two tested providers, office, two themes, 2D workflow, onboarding.

- [ ] `node --test tests/providers.test.js tests/connections.test.js` — passes (capability matrix is honest per provider; doctor speaks plainly).
- [ ] `curl http://127.0.0.1:5173/api/connections/capabilities` — every capability is `verified`, `experimental`, `unknown`, or `unsupported`, and nothing unverified claims `verified`.
- [ ] Server-side enforcement: call an unsupported control (for example `POST /api/runs/:id/input` on an adapter whose `resume` is not `verified`) — the API rejects with a reason; hiding the button is not the gate.
- [ ] `npx playwright test e2e/workspace.spec.js` — WebGL loss, mobile layout, and the accessible 2D fallback pass.
- [ ] Two providers concurrently (fake CLIs): start one run per provider in two workspaces and confirm each run's events carry its own provider and provenance and write into its own worktree.
- [ ] Publish the tested OS × runtime matrix in [CONNECTIONS.md](CONNECTIONS.md); anything untested stays `experimental`.

## R4 — Workflow product (phase 5)

Scope: task graphs, limits, quality metrics, domain packs.

- [ ] `node --test tests/templates.test.js` — passes (all 13 packs carry the full contract; subjective criteria refused; analytics and research distinctions enforced).
- [ ] `node --test tests/workflows.test.js tests/checkpoints.test.js` — passes (cycles, unreachable steps, auto-dispatch, idempotency, versioned definitions).
- [ ] `node --test tests/analytics.test.js tests/budget.test.js tests/retry.test.js` — passes (funnel, time breakdown, reported-vs-estimated labels, limits, bounded retries).
- [ ] Bounded workflow drill: `node bin/agent-space.js workflow start <ws> feature-delivery --input feature="Gate check" --json`, then `node bin/agent-space.js graph <ws>` — the fan-out steps are ready, QA waits for both, review waits for QA.
- [ ] No duplicate side effects on recovery: kill the server mid-workflow, restart, and confirm no completed step is dispatched twice (`GET /api/runs/:id/orchestration`).
- [ ] Contract failure does not complete a task: a step whose `output-schema` criterion fails leaves the task review `pending` with the failures listed.

## R5 — Team and fleet

Scope: authenticated shared mode, decisions, roles, diagnostics.

- [ ] `node --test tests/server-security.test.js` — passes (token auth, origin/host checks, cross-workspace access).
- [ ] Shared-mode drill: `AGENT_SPACE_TOKEN=<token> HOST=0.0.0.0 npm start`, then `curl -i http://127.0.0.1:5173/api/workspaces` → 401, and with `-H "authorization: Bearer <token>"` → 200.
- [ ] Tenant isolation: with two workspaces, confirm every list endpoint scoped by `?workspace=` returns only that workspace's rows.
- [ ] Revocation drill: `POST /api/ops/connections/:id/revoke` then attempt a launch on that connection — refused server-side.
- [ ] Worker-loss drill: kill a provider child process; the run becomes `disconnected` (never `cancelled`), and `retry` refuses until forced.
- [ ] Cancellation acknowledgement: `POST /api/runs/:id/cancel` writes an event saying side effects are not undone.
- [ ] `node --test tests/ops.test.js` — passes (stop switch, backup, restore drill, retention, diagnostics).
- [ ] Not met in this build: remote workers, device pairing, roles beyond a single token. Record it, do not claim it.

## R6 — Enterprise and ecosystem

Scope: governance, private catalog, deployment options, independent review.

- [ ] Backup/restore reviewed: `POST /api/ops/backup` then `POST /api/ops/restore-drill` — counts match.
- [ ] Audit export reviewed: `GET /api/audit/export?format=csv` opens, and `GET /api/audit/verify` reports an intact chain.
- [ ] Upgrade and rollback rehearsed with the procedure above, on a copy.
- [ ] Extension governance: `node --test tests/extensions.test.js` — passes (workspace opt-in, permission ceiling, staged updates, pinned versions, dependency inventory, revocation, refused removal while in use, checksum verification, secret-free template export).
- [ ] `curl http://127.0.0.1:5173/api/extensions` — `loadingSupported` is `false` and `signatureMeaning` states that a signature is not a safety review.
- [ ] Not met in this build: SSO and provisioning, a private catalog service, a sandbox for executable extensions, and an independent external security review. R6 stays **Deferred** until those exist.

## Other verification from roadmap section 18

- Contract tests per adapter version: `node --test tests/adapters.test.js tests/observe-claude.test.js tests/observe-codex.test.js tests/observe-others.test.js` (malformed lines, duplicates, missing usage, unknown model, truncation, error fixtures). Out-of-order events, authorization failure, and provider-upgrade cases are **not** covered.
- Failure drills covered: process crash and restart (`reconcile`), server shutdown (`close()`), timeouts, partial side effects recorded in events. **Not** covered: network loss, expired credentials, full disk, sleep/wake.
- Security tests: `node --test tests/server-security.test.js tests/policy.test.js tests/approvals.test.js tests/hooks.test.js`.
- Browser/OS tests: `npx playwright test`. **Not** covered: screen reader, upgrade, uninstall.
- Usability sessions require users; nothing in this repository can substitute for them.
