# Changelog

All notable changes to Agent Space. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project uses [semantic versioning](https://semver.org/) but has not cut a tagged release yet, so entries are grouped by the day the work landed.

Statuses here are deliberately literal. Where something is observed rather than measured, or verified on one provider but not another, this file says so — the same rule the product itself follows.

## Unreleased

### Added

- **Agents walk round the furniture.** `office/obstacles.js` reads a computed layout as the rectangles an agent may not cross, and `office/navmesh.js` finds a way past them with A\* and a string-pull, producing the same multi-leg route `followRoute()` already accepted. The grid is rebuilt with the room, not per frame, and no route is ever fabricated: a path that cannot be found falls back to a straight line rather than stranding anyone.
- **Agents go round each other.** `office/steering.js` steps a walking agent aside for anyone in its way, across its direction of travel so the walk still makes progress. Two agents meeting head-on pass on the right — always the same way, because mirroring is the one case that deadlocks. A nudge is refused if it would put a figure inside the furniture.
- **Agents look at whoever is speaking.** A glance follows a colleague with a recorded message, in the same room, within range, turning at most about 69°. Silence means every head stays forward: there is no idle looking-around, and gaze is never invented.
- **A prioritised plan** for what comes next in [docs/ROADMAP_NEXT.md](docs/ROADMAP_NEXT.md), built from a study of seventeen comparable products.

### Changed

- **Resolving a provider binary no longer holds the server.** The synchronous `where` / `which` fallback was capped at five seconds and re-ran on every launch attempt, so an unresponsive PATH entry froze every page and WebSocket repeatedly. It is now capped at 800 ms and cached for 30 seconds, keyed by binary name and PATH.
- **The workspace menu says less.** Rows carried nine facts each; a row you are scanning past now shows its name and at most one signal (`2 attention`, else `3 running`, else nothing). Only the workspace you are in spells out its folder and environment. "Recent" became an ordering rather than a second list that repeated rows already on screen. Renaming and archiving moved behind a "Manage workspaces" mode, and a filter appears once there are nine workspaces.

### Fixed

- **Agents stood inside their own desks.** A desk agent was sent to the desk anchor, which the desktop covers; it is now sent to the chair, and sits in it. The seated pose that the conference table introduced now applies at desks as well.

### Withdrawn

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
