# Extensions: manifest, trust model, and SDK plan

Roadmap section 16. This build ships the **bookkeeping half** of the extension model: a versioned manifest, a registry with workspace opt-in, staged updates with a permission diff, pinned versions, a dependency inventory, revocation, safe removal, checksum verification, and secret-free template sharing.

**There is no extension loader.** `install()` never imports, requires, spawns, or evaluates anything. Every record carries `loaded: false` and a `loadRefusedReason`. Executable extension kinds are recorded as declarations only; loading is deferred until isolation and permission enforcement for extension code exist. Do not read anything in this document as a claim that third-party code runs here.

Modules: `packages/core/src/extensions/manifest.js`, `packages/core/src/extensions/registry.js`, `packages/server/src/routes/extensions.js`. Tests: `tests/extensions.test.js`.

## Extension kinds have different trust models

| Kind               | Executable | What it would do                                                        | What a review must cover                           |
| ------------------ | ---------- | ----------------------------------------------------------------------- | -------------------------------------------------- |
| `provider-adapter` | yes        | Launch a provider CLI and parse its stream                              | process spawn, argument building, secrets          |
| `workflow-adapter` | yes        | Import status/artifacts from an external engine (engine stays the boss) | network destinations, credentials, double dispatch |
| `tool-connector`   | yes        | Read or write an external system (issues, storage, CI, database)        | network destinations, write scope, OAuth scopes    |
| `role-pack`        | **no**     | Data only: roles and workflow templates                                 | no secrets, no private paths, objective criteria   |
| `visual-theme`     | **no**     | Data only: colours, geometry presets, scene labels                      | no remote asset URLs                               |

Data kinds (`role-pack`, `visual-theme`) are the only ones this build could ever apply without an isolation story, and even those are recorded rather than merged today. Templates are the working example: see [TEMPLATES.md](TEMPLATES.md).

## The versioned manifest

`manifestVersion: 1`. `validateManifest()` normalizes and refuses anything it cannot state plainly.

```jsonc
{
  "manifestVersion": 1,
  "id": "acme-connector",                  // lower-case letters, digits, dots, hyphens
  "name": "Acme tool connector",
  "kind": "tool-connector",
  "version": "1.2.0",                      // semver, required
  "publisher": { "name": "Acme Ltd", "contact": "dev@acme.example", "url": "https://acme.example" },
  "license": "MIT",
  "compatibility": { "agentSpace": ">=0.2.0 <1.0.0", "os": ["win32", "linux", "darwin"] },
  "capabilities": ["issues.read"],
  "permissions": {
    "filesystem": "none" | "read" | "write",
    "network": ["api.acme.example"],       // hosts, host:port, "*.acme.example", or "*"
    "shell": false,
    "providers": ["codex"]                 // known provider ids only
  },
  "configurationSchema": { "type": "object", "properties": { "baseUrl": { "type": "string" } } },
  "updateChannel": "stable" | "beta",
  "checksum": "sha256:<64 hex>",
  "signature": { "publisher": "Acme Ltd", "algorithm": "ed25519", "keyId": "k1", "value": "…" }
}
```

`configurationSchema` uses the same hand-written JSON Schema subset as task contracts (`type`, `properties`, `required`, `items`, `enum`, `title`, `description`). An unsupported keyword is refused rather than ignored, so nobody believes a constraint is enforced when it is not.

### Compatibility ranges

`satisfiesRange(version, range)` is hand written — no packages. It supports `*`, exact (`1.2.3`, `=1.2.3`), `>=`, `<=`, `>`, `<`, `^1.2.3`, `~1.2.3`, `1.x`, `1.2.x`, space-separated AND, and `||` for OR. Prereleases sort before their release (`1.0.0-beta.1 < 1.0.0`). An unreadable range throws at validation time, not at update time. The build's own version is `AGENT_SPACE_VERSION` in `registry.js`.

## Trust model

**A signature proves the publisher and integrity. It does not prove safety.** That sentence is a constant (`SIGNATURE_MEANING`) returned by `GET /api/extensions`, attached to every inventory row, to every checksum verification result, and to every validated signature record. `verifyChecksum({ bytes, checksum })` recomputes sha256 and reports `{ ok, expected, actual, means }` — matching bytes mean unchanged bytes and nothing more.

What the registry enforces today:

- **Workspace opt-in.** `install()` requires a `workspaceId`. An extension exists for the workspaces that opted in and nowhere else.
- **Permission ceiling.** Every workspace has a ceiling derived from its policy and narrowed by `workspaces.settings.extensions` (`allowFilesystem`, `allowNetwork`, `allowShell`, `allowProviders`). The default ceiling is `filesystem: read`, no network, no shell, no providers. An install that asks for more is refused with a 403 naming each excess permission. An `observe-only` workspace never grants shell.
- **Compatibility and OS.** An install is refused when this build falls outside `compatibility.agentSpace` or when the host platform is not listed.
- **Staged updates.** `update(id, manifest)` never replaces anything: it stores the new manifest as `pending` together with `diffPermissions(old, new)` (`escalates`, `added`, `removed`, plain-language `summary`). `acceptUpdate(id, { acceptedPermissions: true })` applies it, and re-checks the workspace ceiling first; `rejectUpdate(id)` drops it. An extension may not change kind under the same id.
- **Pinned versions.** `pin(id, version)` fixes the version in use and refuses a version that was never recorded.
- **Dependency inventory.** `dependencyInventory()` lists id, kind, pinned version, publisher, license, update channel, checksum, whether it is signed, what the signature means, `loaded: false`, declared dependencies, and the workspaces that opted in. Declared dependencies are recorded with `resolved: false` — nothing is fetched.
- **Revocation.** `revoke(id, { reason })` always succeeds, even mid-run: it stops future use and records why. It does not undo what already happened.
- **Safe removal.** `remove(id)` is refused (409) while a run that recorded a use is still active (`queued`, `running`, `waiting_approval`, `blocked`, `stale`). A finished run never blocks removal. `beginUse(id, runId)` / `endUse(id, runId)` record use; `activeUses(id)` joins them against the `runs` table so a stale record cannot block forever.

Storage is one JSON row per extension in the existing `settings` table under `extensions.item.<id>` — no migration, no credentials, no file contents.

Not built, and not claimed: certification badges, a public marketplace, moderation and abuse reporting, private organizational catalogs, and any form of sandboxed execution.

## HTTP API

| Method + path                         | Does                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GET /api/extensions[?workspace=]`    | Inventory, kinds and their trust models, manifest version, `signatureMeaning`, `loadingSupported: false` |
| `POST /api/extensions/import-preview` | `{ manifest, workspaceId? }` → permission summary, problems, compatibility, what would change            |
| `POST /api/extensions`                | `{ manifest, workspaceId, source?, dependencies? }` → install (201)                                      |
| `GET /api/extensions/:id`             | One record                                                                                               |
| `PATCH /api/extensions/:id`           | `{ manifest }` stage · `{ acceptUpdate, acceptedPermissions }` · `{ rejectUpdate }` · `{ pin }`          |
| `POST /api/extensions/:id/revoke`     | `{ reason }`                                                                                             |
| `DELETE /api/extensions/:id`          | Remove; 409 while in use                                                                                 |
| `GET /api/templates/:id/export`       | Secret-stripped shareable template + checksum + `removed` list                                           |
| `POST /api/templates/import-preview`  | `{ template }` → preview only; nothing is written                                                        |

Registration: `packages/server/src/routes/extensions.js` must be listed in `packages/server/src/routes/index.js` **before** `workspaces.js`. It does not collide with `workflows.js`, which claims only `GET /api/templates` and `GET /api/templates/:id`.

## Template sharing without secrets

`exportTemplate(id)` runs `stripTemplate()` over the template and returns `{ format, formatVersion, exportedAt, template, removed, checksum, note }`. It removes, and always reports:

- secret-looking keys and values (`apiToken`, `client_secret`, `password`, `authorization`, `cookie`; a budget field such as `maxTokens` is deliberately **not** treated as a secret),
- absolute and user paths anywhere in a string (`C:\Users\…`, `\\server\share`, `/home/…`) — replaced in place with `<path removed on export>`,
- raw logs (`logs`, `rawLog`) and `clientData`.

`importTemplate(json)` **shows the preview first** and writes nothing: steps, roles, required tools, connectors with their availability, validation errors, a permission summary, and everything that was stripped. Importing a template adds tasks, prompts, and contracts — never executable code — and every tool call is still checked against the workspace policy at run time.

**No lossless import/export across workflow engines is promised.** An imported document is validated against this build's template contract; anything unsupported is reported as a validation problem, and connectors this build does not have are listed as `unavailableConnectors` instead of being silently dropped.

## Development SDK — what exists in this repository

The SDK is the in-repo harness, not a published package. Everything below is real and exercised by tests today:

| SDK piece                 | Where                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Adapter contract          | `packages/core/src/adapters/base.js` (`build` / `parse` / `finalize` / `interrupt`, capability declaration)                                                        |
| Observer contract         | `createObserver({ home, env })` → `scanSessions` / `readEvents` / `isLive` (`packages/core/src/observe/*`)                                                         |
| Event schema              | `packages/core/src/contracts.js` (`makeEvent`, `EVENT_KINDS`, `PROVENANCE`, `classifyTool`)                                                                        |
| Recorded event samples    | `tests/fixtures/providers/*.jsonl` — real, sanitized Claude Code, Codex, and Copilot streams and sessions                                                          |
| Fake CLIs (local harness) | `tests/fixtures/fake-cli/{claude,codex,copilot,gemini}.js`, contract documented in `tests/fixtures/fake-cli/README.md`; selected with `AGENT_SPACE_BIN_<PROVIDER>` |
| Fixture provider homes    | `tests/fixtures/providers/` plus `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `COPILOT_HOME` / `CURSOR_HOME` / `GEMINI_HOME`                                               |
| Contract tests            | `tests/adapters.test.js`, `tests/observe-*.test.js`, `tests/run-recorder.test.js` (dedup, malformed lines, missing usage, unknown model)                           |
| Template contract         | `validateTemplate()` in `packages/core/src/workflows/templates/index.js`, `tests/templates.test.js`                                                                |
| Manifest contract         | `validateManifest()` / `diffPermissions()` / `satisfiesRange()`, `tests/extensions.test.js`                                                                        |

Planned and not built: a published `@agent-space/sdk` package, example third-party adapters outside this repository, a certification pipeline, and a sandbox for executable extensions. See [TESTING.md](TESTING.md) for how to run the harness and how to add a provider.
