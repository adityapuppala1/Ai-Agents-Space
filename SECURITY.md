# Security policy

## Reporting a vulnerability

Please report security issues **privately**, not as a public issue:

1. Go to [the Security tab](https://github.com/adityapuppala1/Ai-Agents-Space/security/advisories/new) and open a private advisory ("Report a vulnerability").
2. Describe what an attacker can do, not only what looks wrong. A request that reproduces it is worth more than a description of the code.
3. Say which configuration you were running — in particular whether the server was bound to loopback or to the network, because that is the boundary most of this product's security rests on.

There is no bounty. Reports are acknowledged and, if valid, credited in [CHANGELOG.md](CHANGELOG.md) unless you ask otherwise.

If you are unsure whether something is a vulnerability, report it privately anyway. It is easier to downgrade a report than to un-publish one.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |
| < 0.1 | No |

The project is pre-1.0 and fixes land on the latest version only.

## The security model

Agent Space is **local-first**. Understanding the two modes it runs in explains nearly every decision below.

### Local mode (the default)

The server binds to loopback, so nothing outside the machine can reach it. The only caller is the person at the keyboard, who already has the privileges the API grants. No token is required, because a token would defend against nobody.

Data stays on the machine: a `node:sqlite` database in the operating system's per-user data directory. Nothing is uploaded, and no account exists.

### Shared mode

Setting `HOST` to something other than loopback makes the API reachable from the network. In that configuration the process **refuses to start without `AGENT_SPACE_TOKEN`**, rather than starting an open server — an unauthenticated listener is not an option the product offers.

Shared mode is the boundary the security controls are written against: a token holder is not necessarily the owner of the host, so the server does not lend out its position inside the network.

## What the product guarantees

- **Secrets never reach the database, the logs, or the interface.** A webhook endpoint stores the *name* of an environment variable, never a value. Resolution deliberately does not fall back to the settings table, because settings are readable over HTTP and through the MCP bridge.
- **A provider's own files are never written.** `~/.claude/settings.json` and every other provider home is read-only to this product. Backups are refused if their destination resolves inside a provider home.
- **Authentication fails closed and compares in constant time**, on both the HTTP API and the WebSocket upgrade.
- **Destructive operations require explicit confirmation** — stopping every run, or sweeping retention, cannot be triggered by a single stray request.
- **A run that may have changed files is never retried automatically** unless idempotency is proven.
- **Outbound connections are constrained.** Webhook delivery is the only place the server connects to an address a caller chose, and [`packages/core/src/webhooks/target.js`](packages/core/src/webhooks/target.js) decides what is reachable. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §0 rule 11.
- **Tests never call a real provider CLI** and never touch a real provider home.

## Checking it yourself

```sh
npm run test:security   # 48 hostile requests against an isolated server
npm audit               # dependency advisories
```

`npm run test:security` starts its own server on its own port with an in-memory database and throwaway provider homes, then attacks it: authentication, path traversal, `Origin`/`Host`/CORS, the security headers, SQL injection, body limits, content-type smuggling, prototype pollution, confirmation on destructive routes, secret leakage, SSRF, and error handling. It exits non-zero on a finding. Nothing in it is destructive, and it never touches the port a person is using.

Two of its checks deliberately use a raw socket instead of `fetch()`. This is not stylistic: `fetch()` silently drops a `Host` override and reports a refused request as status 0, and both behaviours produced a false finding the first time the probe was run. See [docs/TESTING.md](docs/TESTING.md).

## Known accepted risks

- **`style-src` in the Content-Security-Policy.** Tracked in [CHANGELOG.md](CHANGELOG.md); the scripting directives are strict (`script-src 'self'`, no `unsafe-eval`) and the interface has no HTML injection sink — no `dangerouslySetInnerHTML`, no `innerHTML =`, no `eval`.
- **No rate limiting on authentication.** The token comparison is constant-time and a token is long enough that online guessing is impractical, but there is no per-address backoff on repeated failures. This is unreachable in local mode; it is worth closing before shared mode is used widely.
- **Earlier git history contains unsanitised fixtures.** The provider fixtures under `tests/fixtures/providers/` are genuine recorded sessions. They were sanitised on 12 September 2026 — see [tests/fixtures/providers/README.md](tests/fixtures/providers/README.md) — and [`tests/fixture-hygiene.test.js`](tests/fixture-hygiene.test.js) now fails the build on a home directory, a URL with a name before the `@`, an unvouched host, or anything shaped like a credential.

  The current tree is clean. **Commits before that date still contain the original values** and remain reachable through `git log`, forks, and any clone taken earlier. No credentials were ever present; what was there was an account name, local paths, and the organisation and repository URL of an unrelated private project. Removing it from history would require rewriting published history, which has not been done.

## Out of scope

- Anything requiring an attacker to already have a shell on the machine, or to be the local user. Local mode grants the local user the access they already have.
- The provider CLIs themselves (Claude Code, Codex, Copilot, Cursor, Gemini). Report those to their vendors.
- Denial of service against a loopback listener by the person who owns the loopback interface.
