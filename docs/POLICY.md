# Policy, autonomy, budgets, incidents, and trust

What Agent Space enforces, where it enforces it, and what it deliberately does not. Sources: `core/policy/Policy.js`, `core/contracts.js`, `core/approvals/ApprovalService.js`, `core/hooks/claudeHookBridge.js`, `core/runs/{retry,queue,budget}.js`, `core/ops/{Incident,Retention}.js`, `core/extensions/{manifest,registry}.js`, `core/webhooks/WebhookService.js`, `core/mcp/tools.js`, `core/audit/Audit.js`, `packages/server/src/server.js`.

The binding rule (ARCHITECTURE §0 rule 5): **policies are enforced server-side, not by hiding buttons.** An unsupported or refused action is disabled in the UI _and_ rejected by the API with a message that says why.

## 1. Autonomy presets

Every workspace has one preset (`policy.autonomy`). It decides whether runs may be launched, what they may do, and whether "risky" actions can be routed to a person.

| Preset         | Label              | Launch | Write | Shell | Network | Isolation                  | Approvals | Effect on managed runs                                                                                                                                                                                                                                                      |
| -------------- | ------------------ | ------ | ----- | ----- | ------- | -------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `observe-only` | Observe only       | no     | no    | no    | no      | —                          | none      | Launches refused (403, rule `launch.observe-only`). Hook calls from this workspace get no decision (`passthrough`): Claude Code keeps its own permission prompts                                                                                                            |
| `propose`      | Propose            | yes    | no    | no    | no      | none                       | none      | Read-only runs: Claude Code `--permission-mode plan --allowedTools Read Glob Grep` (plus WebFetch/WebSearch only with `allowedNetwork`), Codex `-s read-only`, Copilot `--allow-tool view/grep/glob`, Gemini `--approval-mode plan`. Hook: writes, shell and network denied |
| `sandbox`      | Execute in sandbox | yes    | yes   | yes   | no      | `worktree` (forced)        | risky     | Every run is forced into a Git worktree whatever the request or task asks (audited `run.isolation.forced`). Shell allowed inside it; risky commands ask; network denied unless `allowedNetwork`. Gemini `--approval-mode yolo`                                              |
| `scoped`       | Scoped execution   | yes    | yes   | yes   | yes     | `none` (worktree optional) | risky     | **Default.** Writes to the project folder; the denied list wins, then risky commands and pushes ask for a decision. Gemini `--approval-mode auto_edit`                                                                                                                      |

`GET /api/policy/presets` returns them; Workspace settings → Execution policy edits them.

## 2. Policy fields

Stored per workspace as JSON (`workspaces.policy`), merged over `DEFAULT_POLICY` on every read.

| Field                    | Default                                                                                                                                        | Validation               | Used by                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `autonomy`               | `scoped`                                                                                                                                       | one of the four presets  | launch verdict, hook/app-server decisions, adapter permission flags                                                      |
| `maxConcurrentRuns`      | 2                                                                                                                                              | integer 1–10             | `RunQueue` per workspace                                                                                                 |
| `allowedFolders`         | `[]`                                                                                                                                           | ≤100 strings ≤500 chars  | file-scope checks, `--add-dir` grant, context manifest scope                                                             |
| `deniedCommands`         | `git push`, `git push --force`, `rm -rf /`, `Remove-Item -Recurse -Force C:`, `npm publish`, `docker push`, `kubectl apply`, `terraform apply` | ≤200 strings             | an exact word-boundary match (quotes stripped) is always `deny`; entries ending in `:` or `\` match as prefixes          |
| `requireApprovalFor`     | `shell.risky`, `network`, `git.push`, `deploy`                                                                                                 | ≤20 strings              | which risky categories become `ask` instead of `allow`                                                                   |
| `budget.maxTokensPerRun` | `null`                                                                                                                                         | null or positive integer | **enforced** — the pre-launch estimate and the post-hoc provider total (see §7)                                          |
| `budget.maxRunsPerDay`   | `null`                                                                                                                                         | null or positive integer | refuses launches once reached (managed runs since local midnight)                                                        |
| `timeoutMs`              | 1 800 000 (30 min)                                                                                                                             | 60 000–7 200 000         | managed run kill timer                                                                                                   |
| `allowedNetwork`         | unset                                                                                                                                          | boolean                  | lets `sandbox`/`propose` runs use network tools; network requests still become `ask` under `requireApprovalFor: network` |
| `autoDispatch`           | unset (true)                                                                                                                                   | boolean                  | `false` stops the task graph launching ready dependents                                                                  |
| `retry`                  | see §6                                                                                                                                         | object                   | `{maxAttempts, retryableClasses, allowFallback, fallbackProviders}`                                                      |
| `isolation`              | preset default                                                                                                                                 | `none` \| `worktree`     | `sandbox` always forces `worktree` regardless                                                                            |

A run-level override (task `executionPolicy`, or the `policy` field of a launch request) can only **tighten** the workspace policy (`Policy.tighten`): a more restrictive preset, fewer concurrent runs, a shorter timeout, `allowedNetwork: false`, extra denied commands and approval categories. It can never widen it.

There is also a global `budget.dailyRunLimit` setting (`PUT /api/settings`) counting managed runs across all workspaces.

## 3. Launch evaluation (`Policy.evaluateLaunch`)

Called by `RunWorker.start` and exposed as `POST /api/workspaces/:id/policy/launch`. Order:

0. `assertDispatchAllowed(services)` — an operator stop (§8) refuses before policy is even consulted.
1. `observe-only` → refused.
2. Workspace `budget.maxRunsPerDay` reached → refused (`launch.budget.workspace`).
3. Global `budget.dailyRunLimit` reached → refused (`launch.budget.global`).
4. Otherwise allowed with an `effective` block: `autonomy`, `isolation`, `allowedTools`, `sandbox`, `network`, `maxConcurrentRuns`, `timeoutMs`.

`RunWorker` then applies the verdict: forced isolation is recorded in `config_snapshot.requestedIsolation` plus a status event; extra directories (a `task.target.folder` outside cwd) must be inside `rootPath` or `allowedFolders` or the launch is refused with 403; a refused launch is audited as `run.refused` with `policyDecision: deny`. The token budget is reserved after this, and a per-run estimate over the ceiling refuses the launch before anything is spawned.

## 4. Tool-call evaluation (`Policy.evaluate`)

Called for every Claude Code `PreToolUse` hook, for Codex app-server approval requests, for connector writes, and by `POST /api/workspaces/:id/policy/preview`. `claudeHookBridge.requestFromTool` maps Bash/PowerShell → `command`, Edit/Write/MultiEdit/NotebookEdit/Read → `file` (with `access` write/read), WebFetch/WebSearch → `network`, everything else → `tool`. When a `runId` is given, the run's `config_snapshot.autonomy` (the preset it launched under) overrides the current workspace preset, so editing the policy mid-run cannot retroactively widen a running run.

Result: `{decision: allow|deny|ask, rule, reason, autonomy, kind, category?, match?, path?, scopes?}`.

| Kind      | Order of checks                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| any       | `observe-only` → `allow` with `passthrough: true` (the hook answers `{}`, leaving the decision to the provider)                                                                                                                                                                                                                                                                                                                                     |
| `command` | 1. matches `deniedCommands` (quotes and backslashes stripped first, so `gi''t push` still matches) → `deny`. 2. preset has no shell → `deny`. 3. risky pattern matched → `ask` when the preset allows approvals and the category (or `shell.risky`) is in `requireApprovalFor`; `deny` when the preset has no approval channel; otherwise `allow`. A command too long to inspect (`MAX_INSPECT_CHARS` 8192) is treated as risky rather than scanned |
| `file`    | 1. no path → allow. 2. path looks like a secret (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `.credentials.json`, `auth.json`, `secrets.*`, `.npmrc`, `.netrc`) → `deny` (`file.secret`). 3. write access under a no-write preset → `deny`. 4. no scope configured at all → `allow` (`file.unscoped`, and the verdict says scope is not enforced). 5. inside workspace root / run cwd / worktree / `allowedFolders` → allow, else deny                    |
| `network` | preset forbids network and `allowedNetwork` is not true → `deny`; `requireApprovalFor` includes `network` and the preset allows approvals → `ask`; else `allow`                                                                                                                                                                                                                                                                                     |
| `tool`    | a write-type tool name (`edit`, `write`, `create`, `apply_patch`, …) under a no-write preset → `deny`; else `allow`                                                                                                                                                                                                                                                                                                                                 |

### Risky command catalogue (`RISKY_COMMAND_PATTERNS`)

| Category      | Pattern ids                                                                                                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell.risky` | `rm-rf`, `rmdir-s`, `del-f`, `remove-item-recurse`, `git-reset-hard`, `git-clean`, `curl-sh`, `wget-sh`, `iex-download`, `sudo`, `chmod-777`, `format`, `mkfs`, `drop-table`, `truncate`, `ssh`, `scp`, `env-dump`, `indirect-exec` |
| `git.push`    | `git-push`, `git-force`                                                                                                                                                                                                             |
| `deploy`      | `npm-publish`, `docker-push`, `kubectl`, `terraform-apply`, `deploy-verb` (vercel/netlify/firebase/gcloud/aws/az/heroku/fly/wrangler/serverless/cdk/pulumi + deploy/publish/release/push/up)                                        |

The catalogue is a **heuristic**: it is applied after whitespace normalization and quote stripping, but a determined agent can still phrase a dangerous command it does not recognise. `deniedCommands` is the hard stop; the presets and worktree isolation are the containment.

`POST …/policy/preview` returns the same verdict plus a plain-language `explanation`. It calls the same evaluator, so it can never grant anything.

## 5. Approval flow (`ApprovalService`)

1. **Request** — the payload is secret-redacted, hashed (`payloadHash`, SHA-256 over a stable JSON form), and stored `pending` with `expires_at` (default 15 minutes). An `approval.request` event (provenance `system`) is recorded and the run moves to `waiting_approval`.
2. **Decide** — `POST /api/approvals/:id/decide {decision, note?, payloadHash?, actor?}` accepts `approve`, `deny` or `request-change`. 409 when already decided; 410 when expired; 409 when a supplied `payloadHash` differs from the stored one (the person decided on stale text). `request-change` records the decision and keeps the run waiting, so it stays in the inbox.
3. **Wait** — `wait(id, timeoutMs)` blocks the requester (hook bridge, Codex app-server adapter) until decided, expired or cancelled. When the caller's timeout passes first, the approval is marked `expired` so the inbox never shows an undecidable item.
4. **Expiry sweep** every 30 s marks overdue rows `expired` (event plus audit `approval.expire`). **Cancel** (`cancelForRun`) marks pending rows `cancelled` when the run ends.
5. **Binding to what was shown** — for Claude Code commands the payload carries the whole command (up to 256 KB) plus `commandPreview`, `commandSha256`, `commandLength` and a `truncated` field list. If the approved payload does not carry the exact command, the hook is denied and `hook.approvalMismatch` is audited.
6. **Urgency** — computed from stored facts only: whether the request blocks a waiting run, how long it has waited (`high` after 10 min, `critical` after 30), the risk level of the rule that raised it, the task priority, and whether it expires in under two minutes. Nothing is predicted and no score is invented for display.

**Inbox** (`GET /api/inbox`): pending approvals, failed/stale/disconnected runs, tasks awaiting review, and provider questions, with `counts` and `urgency`.

**Timeouts that must agree**: Claude Code kills a hook after its configured `timeout` (installed as 300 s), the hook CLI waits `--timeout` − 0.5 s, and the bridge answers `deny` after `timeoutSeconds` × 1000 − 5 s. The installer and the route keep the three in step.

## 6. Retries and failure classification (`runs/retry.js`, `runs/queue.js`)

`classifyFailure()` labels every failure from the run's own recorded evidence — its events, exit code and stderr — not from a guess:

| Class                   | Meaning                                                                     | Retried automatically by default                                           |
| ----------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `transport`             | The provider never really started (spawn error, no events, no session id)   | **yes**                                                                    |
| `rate-limit`            | Provider reported a rate or usage limit                                     | **yes** (parked until the reset)                                           |
| `auth`                  | Not logged in, 401, invalid key                                             | no                                                                         |
| `usage-limit`           | Account quota exhausted                                                     | no                                                                         |
| `provider-error`        | The provider ran and failed                                                 | no                                                                         |
| `user-cancelled`        | A person or an operator stop cancelled it                                   | no                                                                         |
| `side-effects-possible` | The attempt recorded a `file.edit`, `file.write`, `command` or `test` event | **never** — it goes to the decision inbox with `SIDE_EFFECT_REVIEW_REASON` |
| `unknown`               | Nothing conclusive                                                          | no                                                                         |

`retryPolicy({policy})` reads `policy.retry`:

- `maxAttempts` — default **2**; `0` disables automatic retries entirely.
- `retryableClasses` — default `["transport", "rate-limit"]`.
- `backoffMs(attempt)` — `min(30 s, 1 s × 2^attempt)` with ±20 % jitter so parallel runs do not retry in lockstep. The random source is injectable, so the tests assert an exact backoff.
- `allowFallback` / `fallbackProviders` — a permitted fallback is **named in the event** and the operator starts that attempt themselves. Fallback is never automatic.

Every automatic retry and every refusal is written as a `status` event, so the timeline shows who decided what and why.

**Circuit breakers and rate-limit parking** (`RunQueue`): a breaker opens after **3** consecutive `transport`/`provider-error` failures inside a **5-minute** window, stays open for a **60-second** cooldown, then half-opens and closes on the next success. Auth failures and user cancellations never open it, because they are not outages. A rate limit parks the provider until the reset time the provider reported (`parseResetTime` understands epoch seconds/ms, ISO stamps, Codex's "try again at 11:33 PM", and "in 5 minutes"); with no reported reset it uses a **15-minute** cooldown and says the cooldown is ours, not the provider's promise. Queueing is round-robin across workspaces, so one busy workspace cannot starve another.

**Reconciliation.** `RunWorker.reconcile()` runs at startup: a managed run left `running` by a previous process is marked `disconnected` (never `cancelled`), and if its provider pid is still alive that is flagged and `retry` is refused with 409 until forced.

## 7. Budgets and capacity (`runs/budget.js`)

Token totals arrive from providers **after** the work is done, so enforcement is post-hoc by construction and every enforcement event says so.

| Control                                 | When it is checked                                                                     | Behaviour                                                                                                                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `budget.maxTokensPerRun`                | Before launch (against the reserved **estimate**) and again after the provider reports | Over the ceiling before launch → refused, nothing is spawned, with the message "split the task or raise budget.maxTokensPerRun". Over the ceiling after the fact → the run is cancelled with an honest post-hoc event |
| `budget.maxRunsPerDay`                  | `evaluateLaunch`                                                                       | Counts managed runs started since local midnight in this workspace                                                                                                                                                    |
| `budget.dailyRunLimit` (global setting) | `evaluateLaunch`                                                                       | Counts managed runs across all workspaces                                                                                                                                                                             |
| `policy.maxConcurrentRuns`              | `RunQueue`                                                                             | Extra runs are `queued`, not refused; cancelling one frees the slot                                                                                                                                                   |
| `policy.timeoutMs`                      | `RunWorker` timer                                                                      | Kills the process tree; the run fails with "timed out"                                                                                                                                                                |

Reservations live in `budget_reservations` (migration 3) and are **estimates**, labelled as such. `release()` frees one when the run ends; the daily rollup is a query over that table plus `runs.usage`, never a second copy of the numbers. `headroom()` returns `reported: false` when no run in the window reported usage, so a zero is never mistaken for "nothing spent". With no limit configured, the tracker reports `limit: null` rather than inventing one.

Cost is separate from tokens: `core/analytics/pricing.js` marks a provider-reported cost `reported: true`, marks a computed cost `estimated: true` with its pricing version and assumptions, and returns `{value: null, reason: "no pricing configured"}` when there is no table. Model quality is never ranked by price, speed or token usage.

## 8. Incident controls (`ops/Incident.js`)

The stop flag lives in the `settings` table (`ops.dispatchStopped`), so it survives a restart and any component can read it without holding a reference to the service. `assertDispatchAllowed(services)` is the guard every dispatch path calls — `RunWorker.start`, the run routes, and the task graph's auto-dispatch.

| Action              | Route                                                              | Effect                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stop all dispatch   | `POST /api/ops/stop-all {confirm:true, reason?}`                   | New dispatch is refused everywhere, and cancellation is **requested** for every live run                                                                        |
| Resume              | `POST /api/ops/resume {confirm:true, reason?}`                     | Clears the flag                                                                                                                                                 |
| Revoke a connection | `POST /api/ops/connections/:id/revoke {confirm:true, reason?}`     | Disables the connection (no launch, no observation) and cancels its runs. Agent Space holds no credential, so this is the only "revoke" it can honestly perform |
| Quarantine a runner | `POST /api/ops/quarantine {confirm:true, host, reason?, release?}` | Marks a host unavailable for scheduling, or releases it                                                                                                         |

**Cancellation is requested, never assumed.** A headless or offline worker may not receive it, so every stopped run is listed as _unacknowledged_ until its status becomes terminal (`completed`, `failed`, `cancelled` or `disconnected`). The count is on the global WebSocket channel and in `GET /api/ops/status`, and the Operations panel shows it as a banner. Stopping interrupts work; it never undoes side effects, and every message says so.

Every `POST` under `/api/ops` requires an explicit `{"confirm": true}` and is audited with the request's actor. No route under `/api/ops` dispatches work.

## 9. Retention and data governance (`ops/Retention.js`)

**Nothing is deleted until an operator turns retention on.** `DEFAULT_RETENTION` is `{enabled: false, eventsDays: 90, runsDays: 365, auditDays: 730, artifactsDays: 180}`, and a manual sweep with retention disabled deletes nothing and says so.

- `GET /api/ops/retention` reads the policy; `PUT` validates it (each day field is `null` for "keep forever" or an integer 1–3650) and `POST /api/ops/retention/sweep {confirm:true, dryRun?}` runs it. `dryRun` counts what would go without touching a row.
- **Protected rows are never swept**: a run that is still live, or attached to a task that is not `COMPLETED`, and any task that is not `COMPLETED`.
- Pruning the oldest audit rows keeps the hash chain verifiable — `Audit.verify()` starts from the oldest surviving row and reports the rest honestly.
- The sweep timer starts only when the policy is enabled, and the startup line says which: `retention: off (nothing is deleted)` or `retention: on (events 90d, runs 365d, audit 730d)`.
- Export and delete are separate paths: `GET /api/workspaces/:id/export` produces a portable manifest with no credentials, and knowledge items support a soft delete plus a `?purge=1` hard delete. Forgetting a memory scope is a hard `DELETE`, not a flag.
- Not implemented, and not claimed: storage destinations, permitted provider regions, and classification-aware routing. Everything is on this disk.

## 10. Extension permissions (`extensions/manifest.js`, `extensions/registry.js`)

**There is no extension loader in this build.** `install()` never imports, requires, spawns or evaluates anything. An entry whose kind is executable (`provider-adapter`, `workflow-adapter`, `tool-connector`) is recorded with `loaded: false` and stays inert until isolation and permission enforcement for extension code exist. `role-pack` and `visual-theme` are declaration-only by nature.

A manifest declares `permissions: {filesystem: "none"|"read"|"write", network: [destinations], shell: boolean, providers: [ids]}`. Every install is checked against the **workspace ceiling**, which is deliberately tight:

| Ceiling field | Default                                                     | Widened by                                                         |
| ------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `filesystem`  | `read`                                                      | `workspaces.settings.extensions.allowFilesystem`                   |
| `network`     | `[]` (none)                                                 | `…allowNetwork` (exact hosts, or a `*.example.com` suffix, or `*`) |
| `shell`       | `false` — and always `false` in an `observe-only` workspace | `…allowShell`                                                      |
| `providers`   | `[]`                                                        | `…allowProviders`                                                  |

`permissionsExceeding()` returns one entry per excess with the requested value, the allowed value and a plain-language detail. An install asking for more is refused; an install cannot widen the permissions of a workspace that already opted in.

- **Updates are staged**, not applied: `PATCH /api/extensions/:id {manifest}` records the new version with a permission diff that a person must accept (`{accept:true}`) or reject. `{pin:"<version>"}` freezes a version.
- **Removal is refused** (409) while a run is using the extension (`beginUse`/`endUse`/`activeUses`); **revocation always works**.
- `verifyChecksum({bytes, checksum})` proves integrity. `SIGNATURE_MEANING` is said out loud in the API, the UI and the docs: _"A signature and checksum establish the publisher and that the bytes did not change. They are not a safety review, and this build never executes extension code."_
- Template sharing is a separate, safe path: `stripTemplate()` removes secrets, absolute or user paths, raw logs and client data, and `POST /api/templates/import-preview` shows the permission summary and writes nothing.
- Records live in the `settings` table under `extensions.item.<id>` — which is why `Settings.publicSubset()` is prefix-allow-listed and never serves `all()`.

## 11. Webhook trust (`webhooks/WebhookService.js`)

Signed in both directions, with the same construction: HMAC-SHA256 over `` `${timestamp}.${rawBody}` ``, compared with `timingSafeEqual`.

**Inbound** (`POST /api/webhooks/:endpointId`) is accepted only when all four hold:

1. the signature verifies against the endpoint's secret,
2. the timestamp is inside the **5-minute** freshness window (in either direction),
3. the signature and payload hash have not been seen before,
4. the external event id is new.

Everything received is recorded in `webhook_inbox` with the verdict, so a rejection is visible rather than silent. The receiver reads the **raw** request body itself, because `ctx.body()` would parse and discard the exact bytes the signature covers.

**Outbound** delivers only five events — `run.completed`, `run.failed`, `approval.requested`, `task.review.pending`, `workflow.completed` — with at most **5 attempts** and exponential backoff from a 30-second base. Every attempt is written to `webhook_deliveries`. Payloads carry ids, statuses, titles and timestamps **only**: prompts, file contents, tokens and credentials are never sent, and an unsigned send is refused.

**Secrets.** `secret_ref` names the **environment variable** the shared secret lives in. It deliberately does not fall back to the settings table, because settings are reachable over HTTP and through the MCP bridge (ARCHITECTURE §0 rule 4). The secret is never stored by this module, never returned by any route, never logged, and never included in an event. An endpoint exposes `secretRef` and `hasSecret`, nothing more.

## 12. MCP gating (`mcp/tools.js`, `mcp/server.js`, `bin/agent-space-mcp.js`)

The MCP bridge is a **separate process** that talks to a running Agent Space over HTTP. It never opens the SQLite file, so it cannot contend for the write lock and cannot see or change anything the HTTP API would not allow: server-side policy, approvals and audit apply unchanged.

- Nine of the eleven tools are read-only and are annotated `readOnlyHint: true`.
- `create_task` changes state and goes through the same route as the UI, so the same workspace policy applies to anything the task later launches.
- **`decide_approval` is gated.** It refuses unless the server setting `mcp.allowDecisions` is `true`, with the message: _"Approving an agent's action is a human decision; turn the setting on in Settings if you want MCP clients to decide."_ When it is allowed, it declares `mcp` as the actor, so the approval row and the audit entry both say where the decision came from. `routes/approvals.js` enforces the same rule server-side for any declared non-human actor — the gate is not in the bridge alone.
- Resources are two fixed documents (`docs/ARCHITECTURE.md`, `docs/ROADMAP_STATUS.md`) plus live records read back through the API. There is no path parameter, so a resource read cannot be steered at another file.
- A failing tool answers with `isError: true` and the server's real message; failures are never reported as empty results.
- stdout carries JSON-RPC frames and nothing else; every diagnostic goes to stderr.

## 13. Audit log (`audit/Audit.js`)

Append-only `audit_log` rows: `{id, timestamp, actor, action, target, workspaceId, runId, policyDecision, details, sequence, prevHash, hash}`. `details` is secret-redacted (recursively, by key name) and capped at 16 KB.

**Tamper-evident (schema v5, chain version 2).** Each row's hash is `sha256(canonicalJson({version, sequence, timestamp, actor, action, target, workspaceId, runId, policyDecision, details, prevHash}))`. Two properties matter:

- `workspaceId` and `runId` are **covered**, so a row cannot be re-attributed to another workspace or run without breaking the chain.
- Fields are hashed as canonical JSON rather than joined with newlines, so caller text containing a line break cannot make two different rows hash the same.

`GET /api/audit/verify` walks the chain and returns `{ok, brokenAt, brokenReason, count, unchained, legacy, chainVersion}`. Rows written before migration 5 have no hash and are counted as **`unchained`** — never claimed as verified. Rows written under chain version 1 are recomputed with `legacyAuditHash()` and counted as **`legacy`**, so an existing install still verifies `ok: true` and is told plainly that `workspace_id`/`run_id` are unverifiable on those rows. A row removed from the middle of the chain is detected.

`GET /api/audit/export?format=csv|json` downloads the log; the JSON form carries the verification result alongside the entries, and the CSV form quotes commas, quotes and newlines.

Actions recorded today:

| Area              | Actions                                                                                                                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Policy            | `policy.update`                                                                                                                                                                                                                           |
| Runs              | `run.refused`, `run.isolation.forced`, `run.queue`, `run.start`, `run.complete`, `run.failed`, `run.timeout`, `run.cancel`, `run.retry`, `run.input`, `run.disconnected`, `run.worktree.remove`, `run.review.accept`, `run.review.reject` |
| Approvals         | `approval.request`, `approval.decide`, `approval.expire`, `approval.cancel`                                                                                                                                                               |
| Hooks             | `hook.deny`, `hook.approvalMismatch`, `hook.policyError`, `hook.invalid`, `hook.error`, `hook.badRequest`, `hooks.install`, `hooks.uninstall`, `workspace.autoCreate`                                                                     |
| Workflows         | `task.dependencies.set`, `workflow.instantiate`, `workflow.archive`, `workflow.auto-dispatch`, `workflow.auto-dispatch.failed`, workflow publish/rollback/adopt                                                                           |
| Operations        | dispatch stop/resume, connection revoke, quarantine, backup, restore drill, diagnostics, retention change and sweep                                                                                                                       |
| Connections       | connection create/update/delete, probe, migration apply                                                                                                                                                                                   |
| Connectors        | every connector write, with the approval it was bound to                                                                                                                                                                                  |
| Extensions        | install, update staged/accepted/rejected, pin, revoke, remove                                                                                                                                                                             |
| Settings / Export | `settings.update`, `workspace.export`, `workspace.import`                                                                                                                                                                                 |

Actors: `local-user`, `token` (shared mode), `hook:claude-code`, `mcp`, `system`.

## 14. Shared mode and token auth (`server.js`)

- Default: bind `127.0.0.1`, no token, `Host` must be loopback, `Origin` (when present) must match the host. This is the local single-user mode.
- `AGENT_SPACE_TOKEN` turns on shared mode: every `/api` request and every WebSocket upgrade must carry `Authorization: Bearer <token>` or `?token=<token>`, compared in constant time. The web app prompts on 401 and stores the token in the browser; the CLI takes `--token` or the environment variable.
- A non-loopback `HOST` is refused at startup unless a token is set. With both set, non-loopback `Host` headers are accepted.
- **One exception**: `POST /api/hooks/claude-code` from a loopback TCP peer with a loopback `Host` is accepted without the token, so the local Claude Code hook keeps working. That route can only record events and ask for approvals, never launch runs. The hook CLI fails closed (denies the tool call) on 401/403 for any other reason.
- Everything else about tenancy is single-user: one token grants full access to every workspace, artifact, setting and hook installation. TLS is not built in; put a reverse proxy in front for remote use.

## 15. What is enforced, and where

| Control                                                                         | Enforced by                                                                                           | Notes                                                                                                                                      |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Operator dispatch stop                                                          | `assertDispatchAllowed()` on `RunWorker.start`, the run routes and the graph auto-dispatch            | Survives restart (settings-backed)                                                                                                         |
| Launch allowed / refused                                                        | `RunWorker.start` → `Policy.evaluateLaunch`                                                           | API 403 with the reason; the TaskLauncher only reflects it                                                                                 |
| Sandbox isolation                                                               | `RunWorker.start` (`enforcedIsolation`)                                                               | Worktree forced for `sandbox` regardless of request or task; retry and input go through `start` again                                      |
| Read-only runs under `propose`                                                  | Adapter command lines (`permissionsFor`)                                                              | Claude plan mode + read-only tools, Codex `-s read-only`, Copilot read-only allow list, Gemini `--approval-mode plan`                      |
| Extra folders (`--add-dir`)                                                     | `RunWorker.start`                                                                                     | Must be inside `rootPath` or `allowedFolders`; recorded in `config_snapshot.extraDirs` and counted as scope by the hook policy             |
| Write scope for non-Git document work                                           | `runs/outputScope.js`                                                                                 | A scoped `outputs/<runId>/` folder, with an event saying nothing is copied in or back                                                      |
| Concurrency, daily run budgets, per-run token ceiling                           | `RunQueue`, `Policy.evaluateLaunch`, `BudgetTracker`                                                  | The token ceiling refuses pre-launch on the estimate and cancels post-hoc on the reported total                                            |
| Run timeout                                                                     | `RunWorker.launch` timer                                                                              | Process tree killed; run `failed` ("timed out")                                                                                            |
| Bounded retries                                                                 | `runs/retry.js` + `RunWorker.considerAutoRetry`                                                       | A run that may have written is never retried automatically                                                                                 |
| Provider circuit breakers and rate-limit parking                                | `RunQueue`                                                                                            | Opens only on evidence; a parked provider says whose reset time it is                                                                      |
| Denied commands, risky commands, file scope, secret files, network, write tools | `Policy.evaluate` via the Claude Code hook bridge, the Codex app-server adapter, and connector writes | Only for those three channels — see §16                                                                                                    |
| Connector writes                                                                | `core/connectors/index.js`                                                                            | Needs the connector to declare the op, the policy to allow the equivalent command, **and** an approved approval bound to the exact request |
| Approval binding and expiry                                                     | `ApprovalService.decide/wait/expireSweep`, the hook bridge command check                              | `payloadHash` mismatch → 409                                                                                                               |
| Non-human approval decisions                                                    | `routes/approvals.js` + `mcp/tools.js`                                                                | Both check `mcp.allowDecisions`                                                                                                            |
| Extension permissions                                                           | `extensions/registry.js` workspace ceiling                                                            | Refuses install, refuses widening, stages updates                                                                                          |
| Webhook authenticity                                                            | `WebhookService.receive()`                                                                            | Signature, freshness, dedup, external-id novelty                                                                                           |
| Retention deletion                                                              | `RetentionService.sweep()`                                                                            | Disabled by default; never removes a live run or an unfinished task                                                                        |
| Connection enabled                                                              | `RunWorker.providerAvailability`, `ObservationService.observeAllowed`                                 | A disabled connection neither launches nor observes                                                                                        |
| Audit integrity                                                                 | `Audit.record()` hash chain, `GET /api/audit/verify`                                                  |                                                                                                                                            |
| Host / origin / token                                                           | `server.js`                                                                                           |                                                                                                                                            |
| Untrusted hook install commands and paths                                       | `routes/hooks.js` (`isTrustedCommand`, `allowedSettingsPath`)                                         | The API cannot be used to plant an arbitrary command in Claude's settings                                                                  |
| Shell-metacharacter safety                                                      | `runs/process.js` `assertShellSafe`, `connectors/git.js` `safeArgument`                               | An argument `cmd.exe` could reinterpret is refused rather than escaped                                                                     |

## 16. What is not enforced

- **Copilot managed runs** run with `--allow-all-tools` (except under `propose`); Copilot's non-interactive mode has no per-call approval channel, so the denied list and risky heuristics do not apply to what Copilot executes.
- **Codex `exec` runs** (the default transport) have no approval channel either; containment is the `-s` sandbox flag and worktree isolation. The denied and risky rules reach Codex only through the opt-in app server (`codex.useAppServer`).
- **Gemini and Cursor** have no approval channel at all. Gemini's containment is `--approval-mode`; Cursor cannot be launched here.
- **Observed sessions** of every provider are watched, never gated: Agent Space reads their files after the fact.
- **Claude Code without hooks** is observed only; with hooks, calls from an `observe-only` workspace are left to Claude's own prompts by design.
- **File scope is not enforced when nothing defines a scope** (no `rootPath`, no run cwd, no `allowedFolders`); the verdict says so (`file.unscoped`).
- **Network policy is allow/ask/deny as a whole** — there is no per-destination allow list for a run. (Extensions _do_ declare network destinations, but nothing executes them.)
- **`connections.allowedWorkspaces`** is stored and editable but is not checked at launch or observation time.
- **Dual approval does not exist**: one decision resolves an approval. Escalation is a ranking in the inbox, not a notification to a second person — there is no notification channel at all.
- **Risky-command detection is heuristic**: obfuscation beyond quoting (encoded payloads, a script written to disk then executed by an allowed command) is not recognised. Use `deniedCommands`, `propose` or `sandbox` when that matters.
- **Retrieved content is not filtered**: instructions inside files, tool results or web pages reach the provider through its own loop. Agent Space records what was attached and where it went (`context_transfers`), but it cannot inspect what the provider read.
- **Side effects are never undone**: cancel, timeout, shutdown, reconciliation, checkpoint restore and compensation steps all stop or mark work; every such message says side effects already made are not undone. Compensation commands are stored for a human to approve and run — Agent Space never executes one.
- **No roles or per-user permissions**: in shared mode one token is full access, and the audit log records `token` as the actor, not a person.
- **No credential store**: Agent Space stores no secret anywhere, but it also does not integrate with DPAPI, Keychain or libsecret. Rotation and revocation are the provider's own (`claude /login`, `gh auth`).
