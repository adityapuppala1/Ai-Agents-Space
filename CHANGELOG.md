# Changelog

All notable changes to Agent Space. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project uses [semantic versioning](https://semver.org/) but has not cut a tagged release yet, so entries are grouped by the day the work landed.

Statuses here are deliberately literal. Where something is observed rather than measured, or verified on one provider but not another, this file says so — the same rule the product itself follows.

## Unreleased

### Added

- **One command to run it: `npx @adhirocks2/agentspace`.** Published as [`@adhirocks2/agentspace`](https://www.npmjs.com/package/@adhirocks2/agentspace) 0.1.0 on 12 September 2026. A launcher (`bin/agentspace.js`) finds a free port, keeps the database in the operating system's own per-user data directory rather than inside the downloaded package, opens the browser, and hands over to the server. Provider detection and session observation already run on startup, so it shows the assistants on the machine without being configured.

  Verified after publishing, by installing from the registry into an empty directory and running it: one dependency (`ws`), `LICENSE`, `NOTICE` and `THIRD-PARTY-NOTICES.md` all present, every provider on the machine detected, and the office drew a real live Claude Code session with no console errors.

  The name is scoped because npm refused the bare `agentspace` as too similar to the unrelated `agent-space` — its check ignores punctuation. Availability and publishability turned out to be different questions.
- **Licensed under Apache-2.0.** `LICENSE` carries the canonical text and `NOTICE` the copyright line, both packed into the published tarball. The interface bundles React, react-dom, three and lucide-react, and minification strips their licence comments — so `THIRD-PARTY-NOTICES.md` reproduces each MIT/ISC licence in full and ships with every copy, which is what those licences require of a distribution.
- **A committed route audit.** `npm run test:routes` walks every route at eight viewports in both themes — 256 renders — checking for sideways scrolling, page errors, unnamed controls and text below the 12px floor. It writes a screenshot only where something failed. The product passes it clean.
- **Every provider adapter is held to one contract.** `tests/adapter-contract.test.js` runs against every registered adapter — capability vocabulary, a findable binary, refusal-with-a-fix where launch is unsupported, a runnable command where it is not, and a `parse()` that survives hostile input without throwing or inventing an event kind. Registering an adapter is the only step needed to be held to it.
- **You can say one thing to a whole team.** "Message the team" on the relay strip. Every member continues its own session, so this starts a new attempt for each — the dialog says so, names everyone who cannot be reached and why (the server's own words, read per run), and reports a partial success as a partial success.
- **The office replays a recorded minute.** Scrub back and the floor shows that moment — agents in the rooms their activity put them in, desk screens showing the file that was open. Activity is read from the event kind the recorder assigned, nothing is interpolated between events, and a replayed agent never claims a live run. The floor says which minute it is showing for as long as it shows it.
- **The top bar says when another workspace needs you.** A workspace could sit blocked and say nothing until the switcher was opened; the bar now reads "Payments needs you" or "2 workspaces need you", and clicking it goes there. Silent when nothing is waiting.
- **Arranging the office shows a live 3D preview.** It stands above the plan, is built from the same layout computation the office runs, highlights whatever the plan has selected, and rings any furniture standing in something else. Without WebGL it does not appear — the plan is the editor and always was. Dragging in 3D is not built.
- **Parallel workflow steps are drawn as parallel.** The relay strip put an arrow between every consecutive step, so two steps that depend on none of each other and run at the same time looked like a queue. Steps are now grouped into the stages they form: arrows only between stages, steps within a stage braced together, and "one of 2 running at the same time" for a screen reader.
- **Every agent says which branch it is on.** The snapshot's agents now carry `branch` and `isolated`; the run passport names the branch and says whether it is an isolated worktree or your own working tree, and an agent's tooltip in the office says the same. A run that recorded no branch says so rather than being shown as `main`.
- **The review table says what changed.** Its board read "2 artifacts linked"; it now reads "3 files changed: app.js, routes.js", from the diff artifact's own record of the files it touched. When no diff was recorded it says so, rather than showing "0 files changed" — those are different facts.
- **Watch over an agent's shoulder.** Select an agent and press the eye in the camera toolbar: the view drops in behind it and looks at what it faces, riding along as it walks and turns. Dragging, resetting or turning on follow all give the camera back, and leaving restores the view you had.
- **You can read the exchange with an agent, and reply to it.** A **Conversation** tab on the run inspector shows the prompt and every message the provider reported, as turns. Continuing a session with a headless provider creates a new run linked to the last, so `RunRecorder.chain()` walks that chain and `core/runs/conversation.js` reads it back as one exchange; each turn says which attempt it belongs to. Replying states plainly that it starts a new attempt. New route: `GET /api/runs/:id/conversation`. Selecting an agent whose run has finished offers **Read and reply** at its desk, which opens that same view directly on the conversation.
- **Agents walk round the furniture.** `office/obstacles.js` reads a computed layout as the rectangles an agent may not cross, and `office/navmesh.js` finds a way past them with A\* and a string-pull, producing the same multi-leg route `followRoute()` already accepted. The grid is rebuilt with the room, not per frame, and no route is ever fabricated: a path that cannot be found falls back to a straight line rather than stranding anyone.
- **Agents go round each other.** `office/steering.js` steps a walking agent aside for anyone in its way, across its direction of travel so the walk still makes progress. Two agents meeting head-on pass on the right — always the same way, because mirroring is the one case that deadlocks. A nudge is refused if it would put a figure inside the furniture.
- **Agents look at whoever is speaking.** A glance follows a colleague with a recorded message, in the same room, within range, turning at most about 69°. Silence means every head stays forward: there is no idle looking-around, and gaze is never invented.
- **A prioritised plan** for what comes next in [docs/ROADMAP_NEXT.md](docs/ROADMAP_NEXT.md), built from a study of seventeen comparable products.

### Security

- **An outbound webhook can no longer be pointed at the machine's own network.** Creating an endpoint is the one place where a caller names an address and the *server* connects to it, and the only check was that the URL began with `http`. On a server bound to the network — the shared mode, where a token is the only thing between the API and everyone else — that made it a way to reach whatever the server can reach and the caller cannot: the host's loopback interface, the LAN, and the cloud metadata service on `169.254.169.254` that hands out credentials to anything that asks. Found by review, not by a scanner (CWE-918).

  Link-local addresses are now refused always, whatever the server is bound to, because nothing legitimate delivers a webhook there. Loopback and private addresses are still allowed on a loopback-bound server, which is the ordinary local install where posting to `http://localhost:3000/hook` is the point; a remote-bound server refuses them unless `AGENT_SPACE_WEBHOOK_ALLOW_PRIVATE=true` says otherwise. A URL carrying a username or password is refused outright — it would be sent to the target and recorded on the way.

  The check is made twice, because one place is not enough: on the address written into the form, and again on whatever a *hostname* resolves to, through a `lookup` passed to the request. The second is what stops `evil.example` with an A record of `169.254.169.254`, and because the socket connects to exactly the address that lookup returned, there is no gap for a second DNS answer to be used instead. The same rule is applied again at delivery, so an endpoint stored while bound to loopback does not keep firing once the server is restarted with `HOST` set. Node's client does not follow redirects, so a 302 is not a way round it either.

  `packages/core/src/webhooks/target.js` holds the rule; `tests/webhook-target.test.js` proves it against a real socket — a refused delivery reaches the listener zero times, a permitted local one arrives — and covers the spellings that usually get past this kind of check: `::ffff:169.254.169.254`, `::ffff:a9fe:a9fe`, and `http://2130706433/`.
- **The provider fixtures no longer carry somebody's machine.** They are genuine recorded sessions, which is the point — a parser tested against invented input is tested against the author's assumptions rather than the vendor's actual format. The cost is that a recording carries whatever else was on the machine that made it, and this repository is public. They held an account name and its home paths, and, more to the point, the organisation and repository URL of an unrelated private project on Azure DevOps. No credentials, which was checked specifically.

  303 replacements across 11 files, made in lockstep so that every test asserting against a fixture still asserts something true, and every JSON document was re-parsed afterwards — a replacement that broke the syntax would turn a real parser test into a test of the parser's error path, which passes while proving nothing. Format information is untouched: event ordering, field names, absent fields, and opaque vendor identifiers all stay, because they are why the fixtures exist.

  The durable half is [tests/fixture-hygiene.test.js](tests/fixture-hygiene.test.js), which fails the build on a home directory whose account name is not a known synthetic one (Windows, POSIX, macOS and slugified spellings), a URL with something before the `@` — how the organisation name travelled, and the shape a credential in a URL takes — an unvouched host, or an OpenAI, GitHub, AWS or Slack token. It matches the *shape* of a leak rather than the values that leaked: naming them would put them back in the repository, and would only catch the mistake already made rather than the next one, recorded on a different machine by a different person. Each rule was made to fail on purpose before its passing was believed.

  **This does not reach git history.** Commits before today still contain the original values and are still reachable, in this repository and in any clone or fork taken earlier. Removing them would mean rewriting published history, which has not been done. [SECURITY.md](SECURITY.md) says so plainly rather than implying the problem is closed.
- **The Content-Security-Policy no longer allows inline anything.** `style-src` carried `'unsafe-inline'`; it now reads `style-src 'self'`, so no directive in the policy permits inline content. It was never a live vulnerability — inline styles are an exfiltration channel only once an attacker can already inject markup, and there is no sink: no `dangerouslySetInnerHTML`, no `innerHTML =`, no `eval`, no `new Function` anywhere in the interface. It was a protection that had been weakened for no reason anybody could name.

  Removing it was safe because React applies a `style` prop through CSSOM, which CSP does not govern, and nothing in the app calls `setAttribute("style")`, assigns `cssText`, or injects a `<style>` element — the built `index.html` contains neither a `<style>` tag nor a style attribute.

  Verified by the route audit across all 256 renders, twice, with no findings, and the live header checked on a running server rather than read from source. The green result was then checked for meaning: a deliberate `setAttribute("style", …)` and an injected `<style>` element were both confirmed blocked and both raise a console error the audit reports as a finding, while a CSSOM write passes silently. A gate that cannot fail proves nothing, so it was made to fail on purpose first.

  What that does **not** cover: the audit walks the 16 rail routes in their default state. An inline style reachable only inside a rarely-opened dialog would not have been exercised.
- **A published security policy.** [SECURITY.md](SECURITY.md) states the threat model rather than leaving it to be inferred: the two modes the product runs in (loopback by default, where no token is required because the only caller is the person at the keyboard; and shared mode, where the process refuses to start without one), what is guaranteed in both, how to report a vulnerability privately through a GitHub advisory rather than a public issue, and — the section most projects leave out — the risks that are known and accepted, with the reason each is tolerable. It ships inside the published package, and the README carries a Security section pointing at it.

  Listed there as accepted rather than quietly left: the provider fixtures under `tests/fixtures/providers/` are genuine recorded sessions and still carry the local paths and session identifiers of the machine that recorded them. They contain no credentials, but they are not sanitised, and this repository is public.
- **The security probe is part of the repository.** `npm run test:security` starts an isolated server on its own port with an in-memory database and fake provider homes, then makes 48 requests an attacker would make: authentication, nine path-traversal encodings, `Origin`/`Host`/CORS, the security headers, SQL injection into search, body limits, content-type smuggling, prototype pollution, confirmation on the destructive routes, secret leakage, the SSRF targets above, and error handling. It exits non-zero on a finding.

  Two of its checks use a raw socket rather than `fetch()`, because `fetch()` cannot make them honestly: it silently drops a `Host` override and reports a refused request as status 0. Both produced a false finding the first time this was run, and re-testing them on the wire showed the server had answered `403` and `415` all along. The raw path is in the committed script so that result cannot be mistaken twice.

### Changed

- **Resolving a provider binary no longer holds the server.** The synchronous `where` / `which` fallback was capped at five seconds and re-ran on every launch attempt, so an unresponsive PATH entry froze every page and WebSocket repeatedly. It is now capped at 800 ms and cached for 30 seconds, keyed by binary name and PATH.
- **The workspace menu says less.** Rows carried nine facts each; a row you are scanning past now shows its name and at most one signal (`2 attention`, else `3 running`, else nothing). Only the workspace you are in spells out its folder and environment. "Recent" became an ordering rather than a second list that repeated rows already on screen. Renaming and archiving moved behind a "Manage workspaces" mode, and a filter appears once there are nine workspaces.

### Fixed

- **Work a provider runs no longer looks busy before anything runs.** Assigning an agent opened a "manual" run marked `running` — the placeholder that lets manual work show as in progress — even on a task bound to Claude Code or another provider, where a managed run owns the lifecycle. Found on 2026-09-15 by running three real Claude Code agents: every card read "In progress · 0%", the workspace switcher said "3 running" while one run executed, agents stood on the floor "coding", and stop-all listed the placeholders as runs it could never cancel.

  - A task that names a provider opens no placeholder, and the activity log says its agent *was assigned*, not that it started.
  - A managed run starting on a task closes any placeholder it replaces, so none can resurface once the real run has ended.
  - Startup closes placeholders earlier versions left on provider work, once, each with a system event saying why, and the `Startup:` line reports how many.
  - An agent on provider work with nothing executing shows as idle, never as the profile's working style.
  - The switcher's "running" counts provider work only while a run is live. It had been counting in-progress *tasks*, not runs at all.
  - A provider task no run has started reads "Not launched" instead of a percentage nobody set — on the task list and the task details as well as the board, which each kept their own copy of that logic. Those two views also picked "the live run, else any run", so a placeholder left open by an older server hid a finished run and a rejected task still read "In progress · 0%". All three now share one rule: a provider run wins over a placeholder.
  - A task typed in by hand but run by a provider is labelled "Provider task", not "Manual task".

  Genuine manual work is unchanged and still opens its placeholder. "Provider work" means a task that names a provider, or one a managed or observed run has executed — a task can be launched with a provider it does not store. Covered by `tests/placeholder-runs.test.js`, `tests/task-labels.test.js` and `tests/run-launch-slots.test.js`.
- **A failing test run's output is no longer dropped from its artifact.** Claude Code reports a command's result as a separate event — `tool.end`, or `error` when the command exits non-zero — carrying the same tool-use id. The capture read output only from the command event, so the "Test output" artifact of a failing suite held the command line and nothing else while the output sat in the event stream. Results are now paired to their command by tool-use id, and an exit code is taken from Claude Code's own `Exit code N` line and never invented for a success. `tests/test-output-capture.test.js`.
- **A beacon no longer counts another workspace's sessions, or covers an agent's name.** Live-session counts come from observation machine-wide, so a Claude Code session in one workspace drew "Claude Code · 1 live session" on every other floor, including one where nothing was running. Counts are now narrowed to the workspace on screen (`surfacesForWorkspace` in `office/presence.js`). Separately, the beacon's label had never been part of the de-collision pass that spreads agent names, room chips and team captions, so it was drawn straight over an agent's name; it now goes through the same pass. `tests/office-beacon-scope.test.js`.
- **Two runs launched together now run together.** Under a limit of two, a run launched alongside another was queued — "workspace already runs 2 managed runs" — while only one existed, and it then waited until the first one *ended*. Seen on 2026-09-15: a test-writing agent and a docs agent meant to work side by side ran one after the other, the second queued for 53 s behind a slot that was free. A launch is recorded as running before it finishes starting, and was counted a second time as a launch still in flight. Slots are now counted as a set of run ids, so a run on both lists is one run. The queue message also states how many runs are active; it had always printed the limit instead.

  The reproduction gives each run its own agent, as in the run that showed it. With one shared agent the second launch failed for an unrelated reason — an agent cannot hold two runs — and a test failing that way proves nothing about slots. `tests/run-launch-slots.test.js`.
- **How the fixes above were checked.** Each was first reproduced as a failing test, and each failure was read to confirm it failed for the reason claimed. The concurrency test failed first because its two launches shared one agent — which says nothing about slots — and was rewritten before it counted. Then: `npm test` 765 of 765; the full browser suite 57 of 57 on the fixed build, with Playwright's own exit code recorded rather than a pipe's; the 256-render route audit with no findings; and the server-side changes run against a copy of a real database, where startup closed the one placeholder left on provider work, the workspace's "running" count fell from 1 to 0, its agent left the floor, and the stop list shed the entry it could never clear.

  Two browser specs are timing-sensitive on a loaded machine and failed in two of three full runs. `team-relay.spec.js` fails the same way on the code before these fixes. `office-arrange.spec.js` failed while its save completed just outside a 5-second window; both pass when run alone.
- **Agents stood inside their own desks.** A desk agent was sent to the desk anchor, which the desktop covers; it is now sent to the chair, and sits in it. The seated pose that the conference table introduced now applies at desks as well.

- **The agent spotlight contradicted its own run passport.** An agent whose run had finished showed "No provider chosen" directly above a passport reading "Claude Code managed". The provider fallback stopped at the active run and never consulted the last one — which is what the passport renders. The empty case now reads "No preferred assistant", which is what the profile field means.

### Fixed (tests)

- **`npm test` ran tests written by the agents it manages.** Bare `node --test` searches the whole repository, and the isolated worktrees of managed runs live under `data/worktrees/`. After a real agent wrote a test suite in its worktree on 2026-09-15, `npm test` picked those files up and failed on the agent's own wrong assertion: Agent Space's suite was green and the report said otherwise. `npm test` now runs `tests/**/*.test.js` only, so nothing an agent writes can pass or fail the product's own suite.
- **`team-relay.spec.js` raced the handoff animation.** An office moment lasts 6 500 ms, and the spec asserted against it three separate times; under a loaded suite the element could disappear between the first assertion and the last. It now reads the moment once and asserts on what it read.

### Withdrawn

- **Giving an agent an instruction mid-run** was planned on the belief that `POST /api/runs/:id/input` feeds a running session. It does not — it refuses while a run executes and resumes the session as a new run. A headless provider CLI is one shot and has no stdin to steer, so the interface now says that instead of pretending otherwise.
- **Moving the run worker into its own OS process**, planned as a robustness fix, was withdrawn: the premise that a wedged provider CLI could take the interface down did not survive measurement. A CLI is a separate process with piped stdio and cannot block the event loop. See [docs/ROADMAP_NEXT.md](docs/ROADMAP_NEXT.md) §1.2 for what was measured and what was actually wrong.

## 2026-09-12 — The office becomes a place

The office stopped being a diagram of who is busy and became somewhere work visibly happens.

### Added

- **Conference wing.** When several agents share recorded work, a round-table room opens: they walk to it, through the door rather than the glass, take a seat and keep working individually at the table. Rooms occupy fixed slots so one opening does not shuffle the others, and a closing room stays until the last agent has actually left. Seats, door routes and room geometry are in `apps/web/src/office/conference.js`; the built scene, laptops and wall boards in `office/conferenceScene.js`.
- **Room functions.** Every shared room has a function — research, QA, review, meetings, the break area — and a workspace can give a room a different one, or none at all. The furniture, signs, screens and the agents all follow the function, so a QA station moved to the front of the floor is still where testing happens. Choosing a function takes it from the room that had it, so one kind of work always has exactly one place. A room that serves nothing is not built, and that work happens at the agents' desks.
- **Arranging the office.** A plan view for moving and renaming rooms and placing up to 24 pieces of furniture, by pointer or by keyboard, with a live region announcing each change (`components/OfficeArranger.jsx`, `hooks/arrangeLogic.js`). The result is stored as a portable document in fractions of the floor (`packages/core/src/visual/OfficeLayout.js`) and travels inside the visual preset.
- **Agents directory.** The agents page is now a team view: sections, per-agent 3D portraits, and details that expand in place. All portraits share a single WebGL context (`office/portraitStage.js`) and are drawn into each card's own 2D canvas.
- **Visual presets version 2**, which now carry the office layout alongside the theme and settings. Version 1 documents still import.
- **Screen-reader coverage** as an automated suite (`e2e/screen-reader.spec.js`): landmark and heading outline, polite live regions, and WCAG 2.2 §2.4.11 focus-not-obscured.

### Changed

- **The agent spotlight is gone from the agents page.** It duplicated the workspace and the run inspector; the run is now reachable from the card instead.
- **Type scale moved to `rem`** so the interface honours the browser's text-size setting. The root stays at `100%` and the base size is set on `body`.
- **Heading levels corrected** across ten components so every page has a single, ordered outline.
- **The camera respects a view you chose.** Framing a new room no longer overrides a viewer's own zoom, pan or focus.

### Fixed

- Wall boards in conference rooms rendered blank — the board plane sat behind its frame.
- A relay room could close at the exact moment of a handoff, so work appeared to vanish. Rooms now hold briefly while a handoff is in flight.
- Labels for large seated groups stacked into an unreadable wall; rooms of five or more now use quiet labels that stay keyboard-reachable.
- Conference room name chips ran off-canvas at narrow viewports and were replaced with door signs that expand on hover or focus.

## 2026-09-10 — Verification, scheduling, and a faster first paint

### Added

- Schedules, feature flags, saved views, and scanning of untrusted content.
- The two verification gates that were missing from the acceptance set, and an honest recount of the roadmap against them.
- Scene filters, an activity ribbon, an agent identity editor, and five office environments.

### Changed

- The web app is split by route, so each panel loads on first visit instead of shipping in one bundle.
- Navigation reorganised; colliding labels fixed; a test run is only called a test run when it is one.
- Every page carries its own content rather than repeating a shared overview strip.

### Fixed

- `wait()` could resolve before a cancelled run had finished its bookkeeping.

## 2026-09-09 — Execution, providers and governance

### Added

- **Persistent identity (R1):** workspaces, agent profiles, and runs that snapshot the profile, command, policy and isolation used, so editing a profile later never rewrites history.
- **Provider integrations (R2–R6):** detection, observation of sessions started outside Agent Space, managed runs, approvals, workspace policy, workflows and analytics.
- **Reliability:** bounded retries, failure classification, circuit breakers, rate-limit parking and token budgets. A run that may already have edited files is never retried automatically.
- **Operations, search and collaboration** surfaces; an event-driven office.
- **MCP server, connectors, scoped memory, lineage and evaluation.**
- Execution scaffolding: schema v2, contracts, a services container, route modules and the run recorder.

### Notes on what is actually verified

Managed runs are verified end to end with Claude Code and Copilot. Codex's stream format is verified but its end-to-end run hit an account usage limit. `cursor-agent` is not installed here, so the Cursor adapter refuses to launch rather than emitting a command that would open the IDE. The Gemini command line is verified from its own `--help`, but the CLI is unauthenticated here, so no Gemini session has ever been observed and everything its observer parses is marked `unverified`.

## 2026-09-09 — Initial

- Agent Space local workspace visualizer, and the repository scaffold.
