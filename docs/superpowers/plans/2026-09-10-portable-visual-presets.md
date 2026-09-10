# Portable Visual Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build safe export, preview, and apply flows for a workspace’s visual office presentation.

**Architecture:** A pure core module owns strict versioned document validation, export, and change calculation. A dedicated route translates that module to HTTP and atomically writes only a workspace theme and its `settings.visual` UI vocabulary. The React settings panel fetches, previews, and applies the document; Three.js reacts through the existing workspace snapshot and settings props.

**Tech Stack:** Node.js 24, node:sqlite, React 19, Vite, Three.js, native Node test runner, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-10-portable-visual-presets-design.md`

## Global Constraints

- Node.js built-ins only on the server; no new runtime dependencies.
- Maintain theme identifiers `studio`, `operations`, `garden`, `midnight`, `sandstone`.
- Presets may contain no remote URLs, executable code, credentials, paths, agents, tasks, runs, or policy.
- Preserve existing reduced-motion, graphics, and presentation behaviour.

---

### Task 1: Pure visual preset contract

**Files:**
- Create: `packages/core/src/visual/VisualPreset.js`
- Test: `tests/visual-preset.test.js`

**Interfaces:**
- Produces `normalizeVisualPreset(input)`, `makeVisualPreset({name, theme, settings})`, and `diffVisualPreset(current, preset)`.
- Consumed by `packages/server/src/routes/visualPresets.js`.

- [x] **Step 1: Write failing tests for valid normalization, unknown keys, and diff output.**

```js
assert.deepEqual(normalizeVisualPreset({kind:"agent-space-visual-preset",version:1,name:"Ops",theme:"operations",settings:{lighting:"focused"}}).theme, "operations");
assert.throws(() => normalizeVisualPreset({kind:"agent-space-visual-preset",version:1,name:"x",theme:"neon"}), /theme/);
```

- [x] **Step 2: Run the test and confirm the missing module failure.**

Run: `node --test tests/visual-preset.test.js`

- [x] **Step 3: Implement strict allow-listed normalization and diffing.**

```js
export const VISUAL_SETTING_KEYS = Object.freeze(["ui.graphics", "ui.office.labelDensity", "ui.office.avatarDetail", "ui.office.lighting", "ui.office.ambientSound"]);
export function normalizeVisualPreset(input) { /* reject unknown keys and validate values */ }
```

- [x] **Step 4: Run the unit test and confirm it passes.**

Run: `node --test tests/visual-preset.test.js`

### Task 2: Visual preset HTTP routes

**Files:**
- Create: `packages/server/src/routes/visualPresets.js`
- Modify: `packages/server/src/routes/index.js`
- Modify: `packages/core/src/WorkspaceHub.js`
- Test: `tests/integration.test.js`

**Interfaces:**
- Consumes `normalizeVisualPreset`, `makeVisualPreset`, `diffVisualPreset`.
- Produces `GET /api/workspaces/:id/visual-preset`, `POST /api/workspaces/:id/visual-preset/preview`, and `POST /api/workspaces/:id/visual-preset/apply`.

- [x] **Step 1: Write integration assertions that preview has no writes and apply changes only theme and visual settings.**

```js
const before = await api("GET", `/api/workspaces/${id}`);
const preview = await api("POST", `/api/workspaces/${id}/visual-preset/preview`, {preset});
assert.equal((await api("GET", `/api/workspaces/${id}`)).data.theme, before.data.theme);
assert.equal((await api("POST", `/api/workspaces/${id}/visual-preset/apply`, {preset})).status, 200);
```

- [x] **Step 2: Run only the integration test and confirm route assertions fail.**

Run: `node --test tests/integration.test.js`

- [x] **Step 3: Add route handling before the generic workspace route, apply validated settings, record a safe audit event, and emit workspace/global refresh events.**

```js
services.hub.applyVisualPreset(id, {theme: preset.theme, visual: preset.settings});
services.audit?.record({actor, action:"visualPreset.apply", workspaceId:id, details:{theme:preset.theme, keys:Object.keys(preset.settings)}});
```

- [x] **Step 4: Run integration coverage and confirm it passes.**

Run: `node --test tests/integration.test.js`

### Task 3: Settings preview and apply UI

**Files:**
- Modify: `apps/web/src/App.jsx`
- Modify: `apps/web/src/styles/experience.css`
- Modify: `e2e/office-controls.spec.js`

**Interfaces:**
- Consumes the three visual preset routes.
- Produces export/download, local JSON file preview, explicit apply, and an error message when input is invalid.

- [x] **Step 1: Write a browser test that uploads a fixture preset, sees the preview, applies it, and observes the selected theme.**

```js
await page.setInputFiles('input[type=file]', {name:'preset.json', mimeType:'application/json', buffer:Buffer.from(JSON.stringify(preset))});
await expect(page.getByText('Midnight lab')).toBeVisible();
await page.getByRole('button', {name:'Apply preset'}).click();
await expect(page.locator('.office-theme-midnight')).toBeVisible();
```

- [x] **Step 2: Run the focused browser test and confirm it fails before UI implementation.**

Run: `npx playwright test e2e/office-controls.spec.js`

- [x] **Step 3: Add a visual preset settings row with export, file read, preview, and explicit apply controls.**

```jsx
<input type="file" accept="application/json" onChange={readPreset} />
<button disabled={!presetPreview} onClick={applyPreset}>Apply preset</button>
```

- [x] **Step 4: Run production build and focused browser test.**

Run: `npm run build && npx playwright test e2e/office-controls.spec.js`

## Plan self-review

- Spec coverage: Tasks 1–3 cover document validation, safe API writes, UI preview/apply, and all stated tests.
- Placeholder scan: no unresolved requirements or deferred implementation language appears in the tasks.
- Type consistency: all route and UI work uses `normalizeVisualPreset`, `makeVisualPreset`, and `diffVisualPreset`; settings keys are defined once in Task 1.
