# Changelog

All notable changes to Agent Space. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project uses [semantic versioning](https://semver.org/) but has not cut a tagged release yet, so entries are grouped by the day the work landed.

Statuses here are deliberately literal. Where something is observed rather than measured, or verified on one provider but not another, this file says so — the same rule the product itself follows.

## Unreleased

Nothing pending. The entries below are all on `main`.

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
