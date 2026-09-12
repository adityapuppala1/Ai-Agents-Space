import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { HOMES } from "./global-setup.js";

/**
 * The visual workflow editor: add a step through the form, link it with the
 * keyboard on the canvas, validate the draft server-side, and save a new
 * version of the same Git-reviewable document.
 *
 * Nothing here computes a graph problem in the browser: Validate and Save both
 * go to the server, which runs the one copy of the four launch checks.
 */

const stamp = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

async function createWorkspace(request, name) {
  const rootPath = path.join(HOMES.projects, name);
  fs.mkdirSync(rootPath, { recursive: true });
  fs.writeFileSync(path.join(rootPath, "README.md"), `# ${name}\n`);
  const response = await request.post("/api/workspaces", {
    data: { name, rootPath },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return await response.json();
}

async function seedWorkflow(request, workspaceId) {
  const response = await request.post(
    `/api/workspaces/${workspaceId}/workflows`,
    { data: { templateId: "bug-clinic", inputs: { issue: "Leak" } } },
  );
  expect(response.ok(), await response.text()).toBeTruthy();
  return await response.json();
}

/**
 * App.jsx reads the workspace from localStorage "agent-space-workspace" and
 * the setup panel from "agent-space-onboarding", so the spec opens straight
 * into the workspace it seeded instead of driving the switcher: this file is
 * about the editor, not about how a workspace is chosen.
 */
async function openEditor(page, workspaceId) {
  await page.addInitScript((id) => {
    try {
      localStorage.setItem("agent-space-workspace", id);
      localStorage.setItem(
        "agent-space-onboarding",
        JSON.stringify({ step: 0, done: [], dismissed: true }),
      );
    } catch {
      /* private mode */
    }
  }, workspaceId);
  await page.goto("/");
  await expect(
    page.getByText("Live connection", { exact: true }),
  ).toBeVisible();
  // The rail entry and its shortcut are the same view. The shortcut is used to
  // get there because the rail re-renders on every workspace snapshot.
  await expect(
    page.getByRole("button", { name: "Workflow editor", exact: true }).first(),
  ).toBeVisible();
  await page.keyboard.press("g");
  const editor = page.getByRole("region", { name: "Workflow editor" });
  await expect(editor).toBeVisible({ timeout: 20000 });
  return editor;
}

test("a step is added, linked with the keyboard, validated and saved as a new version", async ({
  page,
  request,
}) => {
  const ws = await createWorkspace(request, `wfedit-${stamp()}`);
  await seedWorkflow(request, ws.id);
  const editor = await openEditor(page, ws.id);

  await expect(editor.getByText("Version 1 · published")).toBeVisible();
  await expect(
    editor.getByRole("button", { name: /step reproduce/ }),
  ).toBeVisible();

  // Add a step with the form. Every field is labelled.
  await editor.getByLabel("Step key", { exact: true }).fill("triage");
  await editor
    .getByLabel("Step title", { exact: true })
    .fill("Triage the report");
  await editor.getByLabel("Role", { exact: true }).selectOption("investigator");
  await editor
    .getByLabel("Instructions", { exact: true })
    .fill("Decide whether the report reproduces at all before diagnosing it.");
  await editor
    .getByLabel("Deliverable", { exact: true })
    .fill("A triage note on the issue");
  await editor.getByRole("button", { name: "Add step", exact: true }).click();

  const triage = editor.getByRole("button", { name: /step triage/ });
  await expect(triage).toBeVisible();
  await expect(editor.getByText(/1 unsaved change/)).toBeVisible();

  // Link it from the keyboard: select "triage", then press L on "reproduce"
  // so the selection waits for it.
  await triage.click();
  await editor.getByRole("button", { name: /step reproduce/ }).focus();
  await page.keyboard.press("l");
  await expect(
    editor.getByText('"triage" now waits for "reproduce".', { exact: false }),
  ).toBeVisible();
  await expect(
    editor.getByRole("button", {
      name: "Remove the link from reproduce to triage",
    }),
  ).toBeVisible();

  // The server decides whether the graph is sound.
  await editor.getByRole("button", { name: "Validate", exact: true }).click();
  await expect(editor.getByText("VALID", { exact: true })).toBeVisible();
  await expect(editor.getByText(/5 step\(s\) checked/)).toBeVisible();

  await editor
    .getByRole("button", { name: "Save as a new version", exact: true })
    .click();
  await expect(
    editor.getByText(/Saved as version 2, status draft/),
  ).toBeVisible();
  await expect(editor.getByText("Version 2 · draft")).toBeVisible();

  // The saved document is the file a reviewer reads.
  await editor
    .getByRole("button", { name: "View as file", exact: true })
    .click();
  await expect(editor.getByText(/"formatVersion": 1/)).toBeVisible();
  await expect(editor.getByText(/"definitionHash"/)).toBeVisible();

  // It survives a reload because it was written, not kept in the page.
  const reopened = await openEditor(page, ws.id);
  await expect(reopened.getByText("Version 2 · draft")).toBeVisible();
  await expect(
    reopened.getByRole("button", { name: /step triage/ }),
  ).toBeVisible();
  await expect(
    reopened.getByRole("button", {
      name: "Remove the link from reproduce to triage",
    }),
  ).toBeVisible();
});

test("editing the definition never deletes a task that already exists", async ({
  page,
  request,
}) => {
  const ws = await createWorkspace(request, `wfdrift-${stamp()}`);
  const workflow = await seedWorkflow(request, ws.id);
  const editor = await openEditor(page, ws.id);

  await expect(
    editor.getByText(/Editing the definition does not delete tasks/),
  ).toBeVisible();

  // Unlink "fix" from "diagnose" so "diagnose" can go, then remove it.
  await editor
    .getByRole("button", { name: "Remove the link from diagnose to fix" })
    .click();
  await editor.getByRole("button", { name: /step diagnose/ }).click();
  await editor
    .getByRole("button", { name: "Remove step", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "Save as a new version", exact: true })
    .click();
  await expect(editor.getByText(/Saved as version 2/)).toBeVisible();

  await expect(
    editor.getByText(/this task has no step in the definition any more/),
  ).toBeVisible();
  const tasks = await (
    await request.get(`/api/workspaces/${ws.id}/tasks`)
  ).json();
  expect(
    tasks.some((task) => String(task.title).startsWith("Diagnose")),
    "the already-created task is still there",
  ).toBeTruthy();
  expect(
    (await (await request.get(`/api/workflows/${workflow.id}`)).json()).version,
  ).toBe(2);
});

test("the populated editor has named controls, labelled fields and unique ids", async ({
  page,
  request,
}) => {
  const ws = await createWorkspace(request, `wfa11y-${stamp()}`);
  await seedWorkflow(request, ws.id);
  const editor = await openEditor(page, ws.id);
  await editor.getByRole("button", { name: /step reproduce/ }).click();
  await editor
    .getByRole("button", { name: "View as file", exact: true })
    .click();
  await expect(editor.getByText(/"formatVersion": 1/)).toBeVisible();

  const problems = await page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    };
    const found = [];
    for (const el of document.querySelectorAll(
      "button, a[href], [role=button], [role=tab], [role=menuitem]",
    )) {
      if (!visible(el) || el.closest("[aria-hidden=true]")) continue;
      const name = (
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        el.textContent ||
        ""
      ).trim();
      if (!name) found.push(`unnamed control ${el.tagName.toLowerCase()}`);
    }
    for (const el of document.querySelectorAll(
      "input:not([type=hidden]), select, textarea",
    )) {
      if (!visible(el) || el.closest("[aria-hidden=true]")) continue;
      const forLabel = el.id
        ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
        : null;
      if (
        !el.getAttribute("aria-label") &&
        !el.getAttribute("aria-labelledby") &&
        !el.closest("label") &&
        !forLabel &&
        !el.getAttribute("title")
      )
        found.push(`unlabelled field ${el.id || el.tagName.toLowerCase()}`);
    }
    const seen = new Map();
    for (const el of document.querySelectorAll("[id]"))
      seen.set(el.id, (seen.get(el.id) || 0) + 1);
    for (const [id, count] of seen)
      if (count > 1) found.push(`duplicate id ${id}`);
    for (const img of document.querySelectorAll("img"))
      if (
        !img.hasAttribute("alt") &&
        img.getAttribute("role") !== "presentation"
      )
        found.push(`image without alt ${img.src.slice(-30)}`);
    return found;
  });
  expect(problems, problems.join("\n")).toEqual([]);
});

test("the dependency editor checks the unsaved draft, not the saved graph", async ({
  page,
  request,
}) => {
  const ws = await createWorkspace(request, `deps-${stamp()}`);
  const make = async (title) => {
    const response = await request.post(`/api/workspaces/${ws.id}/tasks`, {
      data: { title },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return await response.json();
  };
  const first = await make("Write the schema");
  const second = await make("Build the importer");
  const link = await request.patch(
    `/api/workspaces/${ws.id}/tasks/${second.id}/dependencies`,
    { data: { dependsOn: [first.id] } },
  );
  expect(link.ok(), await link.text()).toBeTruthy();

  await page.addInitScript((id) => {
    localStorage.setItem("agent-space-workspace", id);
    localStorage.setItem(
      "agent-space-onboarding",
      JSON.stringify({ step: 0, done: [], dismissed: true }),
    );
  }, ws.id);
  await page.goto("/");
  await page.getByRole("button", { name: "Dependencies", exact: true }).click();
  const map = page.getByRole("region", { name: "Dependency map" });
  await map.getByRole("button", { name: /^Write the schema,/ }).click();

  // The editor inside Dependencies is not a second "Workflow editor".
  await expect(map.getByText("What this task waits for")).toBeVisible();
  await map
    .getByLabel("Add a dependency", { exact: true })
    .selectOption({ label: "Build the importer" });

  // Observed before: "Validate" checked the saved graph and said VALID while
  // this draft would close a cycle.
  await map.getByRole("button", { name: "Check these changes" }).click();
  await expect(map.getByText("PROBLEMS FOUND", { exact: true })).toBeVisible();
  await expect(map).toContainText("Your unsaved changes");
  await expect(map).toContainText("Dependency cycle");

  // Checking wrote nothing.
  const graph = await (
    await request.get(`/api/workspaces/${ws.id}/graph`)
  ).json();
  expect(graph.nodes.find((node) => node.id === first.id).dependsOn).toEqual(
    [],
  );

  // Changing the draft clears the verdict: it described another graph.
  await map.getByRole("button", { name: "Discard changes" }).click();
  await expect(map.getByText("PROBLEMS FOUND", { exact: true })).toHaveCount(0);
});
