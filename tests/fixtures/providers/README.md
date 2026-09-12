# Provider fixtures

These are **genuine recorded sessions** from the vendors' own CLIs, and that is deliberate. A parser tested against invented input is tested against the author's assumptions about a format rather than the format itself, and every provider here has surprised us at least once — a field that is sometimes absent, an event that arrives twice, a path spelled two different ways in the same stream. Those are the things a real recording carries and a hand-written sample does not.

The cost is that a recording carries whatever else was on the machine that made it, and this repository is public.

## The rule

**Sanitise a recording before committing it.** Replace, consistently, everywhere it appears — including inside slugified paths, URL-encoded forms, and any test that asserts against the value:

| What | Replace with |
| --- | --- |
| The account name in a home directory | `dev` |
| An organisation or repository name that is not this project | `example-org`, `ExampleApp` |
| A host that is not this project's or the vendor's | `example.com` |
| Anything shaped like a credential | Remove it. Do not "redact" it in place — delete the value |

Keep everything that carries format information: event ordering, field names, absent fields, timestamps, opaque vendor identifiers. Those are why the fixture exists. Session and request ids are opaque and are left alone; they identify nothing outside the vendor's own systems.

## What enforces it

[`tests/fixture-hygiene.test.js`](../../fixture-hygiene.test.js) scans every file in `tests/fixtures/` on each run. It matches the **shape** of a leak rather than a list of values that leaked once — naming them would put them back into the repository, and would only catch the mistake already made rather than the next one, recorded on a different machine by a different person.

It fails on:

- a home directory whose account name is not a known synthetic one, in Windows, POSIX, macOS or slugified spelling
- a URL with something before the `@` — how an organisation's name reached this repository once, and also the shape a credential in a URL takes
- a host not vouched for in `KNOWN_HOSTS`
- an OpenAI, GitHub, AWS or Slack token, or a private key block

Each rule was verified by making it fail on purpose before its passing was believed. A gate that cannot fail proves nothing.

**If a check fails, sanitise the recording.** Do not widen the allowlist to make the red go away — the allowlist exists so that adding a name is a deliberate act somebody can see in a diff.

## History

The fixtures were sanitised on 12 September 2026. Before that they carried the recording machine's account name, its home paths, and — the part that mattered — the organisation and repository URL of an unrelated private project. No credentials were present; that was checked specifically.

Sanitising these files does not remove the earlier versions from git history, where they remain reachable. Removing them there would require rewriting published history.
