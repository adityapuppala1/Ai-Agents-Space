# UI and roadmap review — 10 September 2026

The roadmap is **not fully implemented**. It combines shipped functionality, partially supported integrations, enterprise plans, and marketing/research work. See ROADMAP_STATUS.md for the earlier detailed audit; its provider verification claims are historical, not new checks performed in this UI pass.

## Changes in this pass

- Added Tailwind's Vite integration and utility layer without replacing the existing form styles or resetting the application.
- Added office provider controls with counts and shared filters. Filtering now changes the actual Three.js scene, not just the board and timeline.
- Added a clear demo/live-recorded distinction and a direct route to assistant connections. An installed runtime is not counted as an active run.
- Added a live activity ribbon sourced from current agent/run records. It shows agent, activity, current action or task, provider, and elapsed time; demo work remains explicitly marked as a simulated preview.
- Fixed the scene's animation input: real workspaces no longer depend on the demo-running flag. Existing provider activity mapping, inferred labels, stale states, reduced-motion preferences, and recorded evidence remain authoritative.
- Added agent context actions through right click, Shift+F10, and a visible selected-agent action button. Actions inspect a task, follow an avatar, or open an existing run; they do not fabricate provider commands.
- Expanded office themes from two to five. Garden, midnight, and desert variants add palette, lighting, and decorative wall accents to the existing studio layout; they are not three entirely new floor plans. Theme selection is persisted by the server and does not change execution scope.
- Improved navigation contrast, typography, panels, provider badges, mobile wrapping, and explicit empty-filter feedback.
- Completed the editable agent identity path for skills, preferred provider/runtime/model, outfit, accessory, hair colour, and pronouns. The API validates and persists these fields; duplication preserves them and the Three.js avatar consumes the saved appearance.
- Added role filters to the office and an agent “passport” in the spotlight that keeps preferred model/runtime, last reported model, and skills distinct and scannable.
- Fixed misleading theme-save error text. A failed server save is reported as a failure.

## What still prevents a complete product

| Area                    | Remaining work                                                                                                                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider verification   | Complete authenticated end-to-end tests per provider/version/OS. Earlier audit records Codex usage exhaustion, missing cursor-agent, and unauthenticated Gemini. Fixture tests do not resolve these limitations.                                     |
| Actual model identity   | Preferred provider and requested model can now be edited. Continue keeping execution host and the model actually reported by a run distinct; missing provider fields remain unknown.                                                                 |
| Realistic visualization | More distinct layouts and avatar assets, clearer large-team scene layouts, and richer domain-specific props. Animation represents recorded/inferred activity; it cannot reveal private reasoning or unreported assistant-to-assistant communication. |
| Workflow ergonomics     | Consolidate overlapping task/activity views, progressively reveal advanced controls, and usability-test complete connect → assign → observe → approve → inspect-output journeys.                                                                     |
| Platform maturity       | Native distribution, verified macOS/Linux execution, remote host provisioning, organization identity/SSO, and hosted multi-tenancy are not established by this local Windows test run.                                                               |
| Performance             | The build still reports chunks over 500 kB. Route-level splitting and measured low-end GPU/frame-budget work remain worthwhile.                                                                                                                      |
| Product validation      | Accessibility audit, design-partner feedback, release gates, and marketing deliverables still need separate evidence.                                                                                                                                |

## Validation

- Existing native suite: 401 passed, zero failed. The sandbox run had three process/detection failures; the same suite passed with Windows process access.
- Existing browser suite: 19 passed using isolated databases, provider homes, and fake CLIs.
- Production build passed. No paid provider tasks were launched during this pass.
- New focused browser test: 1 passed, covering scene provider filtering, keyboard agent actions, and saving all five themes. It first caught menu layering and overlapping action-button bugs; both were fixed before the passing run.
- Desktop and mobile screenshots are in `artifacts/astra-desktop.png` and `artifacts/astra-mobile.png`.

Run locally with `npm start` after `npm run build`. The review preview uses an in-memory database with observation disabled so it does not modify existing workspaces or resume their workflows. Restart normally when ready to use saved workspaces and configured observation.

## Later pass, 10 September 2026

- Reorganised navigation: fourteen unlabelled icons became four named groups (Work, Watch, Decide, Set up), collapsing to icons with tooltips below 1180px.
- Scene labels are pushed apart in screen space, so a cluster of desks stays readable instead of stacking into one pile.
- Each page shows its own content; the four-tile overview strip appears only on the three overview pages it describes, instead of on all fourteen.
- Route-level code splitting: the main bundle is 392 kB (was 521 kB) with eleven secondary panels in their own chunks. Barrel imports had to be replaced with direct ones, because a barrel that re-exports every panel pulls the lazily loaded ones straight back into the main graph. three.js remains a 560 kB vendor chunk, loaded only with the office.
- Added an automated accessibility gate (`e2e/accessibility.spec.js`): accessible names, labelled fields, unique ids, alt text, focus visibility, reduced motion, and real contrast arithmetic on the design tokens in both themes. It runs across all fourteen views and fails the build on a regression.

### Defects the gates found

| Defect                                                                                       | Where                                                                        | Status |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------ |
| Light `--muted` was 3.02:1 on the page background, below WCAG AA                             | `styles.css`, `styles/experience.css`                                        | Fixed  |
| Dark theme kept the light `--page` and `--line`, leaving body text at 1.18:1                 | `styles/experience.css` re-declared them at `:root` with no dark counterpart | Fixed  |
| Reading a file named `*.test.js` was reported as "Testing" and appeared on the pipeline wall | shared activity classifier                                                   | Fixed  |
| The operations panel counted ready providers from a field the server does not send           | `OpsPanel.jsx`                                                               | Fixed  |
| A one-member team stacked a redundant caption over that agent's own label                    | `office/data.js`                                                             | Fixed  |
| Analytics used literal NUL bytes as map-key separators, so the source read as binary         | `analytics/Analytics.js`                                                     | Fixed  |

Accessibility remains **Partial**, not conformant: the automated gate cannot replace a manual screen-reader pass or a human review, and none has been done.
