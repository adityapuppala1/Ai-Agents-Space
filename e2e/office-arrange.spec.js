import { test, expect } from "@playwright/test";

/**
 * Arranging the office: the shared rooms are moved and renamed and furniture
 * is placed from a plan view, by keyboard as well as by pointer. What it
 * saves is the portable layout in the workspace's visual preset, and the
 * office draws it. Runs in its own workspace: the layout is workspace state.
 */
test("an office is arranged, saved, drawn and carried in the visual preset", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/workspaces", {
    data: { name: "Arrange" },
  });
  expect(created.ok()).toBeTruthy();
  const workspaceId = (await created.json()).id;
  // Someone has to be on the floor for the office to draw anything.
  const roster = await (
    await request.get(`/api/workspaces/${workspaceId}/agents`)
  ).json();
  const task = await (
    await request.post(`/api/workspaces/${workspaceId}/tasks`, {
      data: { title: "Arranging walkthrough" },
    })
  ).json();
  await request.post(`/api/workspaces/${workspaceId}/tasks/${task.id}/assign`, {
    data: { agentId: roster[0].id },
  });
  await page.addInitScript(
    (id) => localStorage.setItem("agent-space-workspace", id),
    workspaceId,
  );
  await page.goto("/");
  await expect(
    page.getByText("Live connection", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".scene-label").first()).toBeAttached({
    timeout: 30000,
  });

  await page
    .getByRole("region", { name: "Office controls" })
    .getByText("Environment", { exact: true })
    .click();
  await page.getByRole("button", { name: "Arrange the office" }).click();
  const dialog = page.getByRole("dialog", { name: "Arrange the office" });
  // The 3D preview stands beside the plan. It is decoration for assistive
  // technology — the plan is the editor — so it is hidden from the tree, and
  // this checks it is actually drawing rather than an empty box.
  const previewCanvas = dialog.locator(".arrange-preview-canvas canvas");
  await expect(previewCanvas).toHaveCount(1);
  await expect(
    dialog.locator(".arrange-preview-canvas"),
  ).toHaveAttribute("class", /arrange-preview-canvas/);
  await expect(previewCanvas).toHaveAttribute("aria-hidden", "true");
  await expect(dialog).toBeVisible();
  // Every shared room is in the plan, and the desks are drawn as a guide.
  await expect(dialog.locator(".arrange-room")).toHaveCount(5);
  await expect(dialog.locator(".arrange-desks")).toHaveCount(1);

  // Everything in the plan and its side panel is a named control.
  const unnamed = await dialog.evaluate((node) => {
    const out = [];
    for (const el of node.querySelectorAll(
      "button, [role=button], select, input",
    )) {
      const name = (
        el.getAttribute("aria-label") ||
        el.textContent ||
        el.labels?.[0]?.textContent ||
        el.getAttribute("title") ||
        ""
      ).trim();
      if (!name) out.push(el.tagName);
    }
    return out;
  });
  expect(unnamed).toEqual([]);

  // Move a room with the keyboard alone, and hear where it went.
  const room = dialog.getByRole("button", { name: /^QA station room/ });
  await room.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(dialog.locator("[role=status]")).toContainText(/QA station at/);
  await dialog.getByLabel("Room name").fill("Test lab");
  await expect(
    dialog.getByRole("button", { name: /^Test lab room/ }),
  ).toBeVisible();

  // Place a piece of furniture.
  await dialog.getByLabel("Furniture").selectOption("sofa");
  await dialog.getByRole("button", { name: "Place" }).click();
  await expect(dialog.locator(".arrange-prop")).toHaveCount(1);
  await expect(dialog).toContainText("1 of 24 pieces placed");

  // What happens where: the meeting room becomes the QA station, and the
  // room that was the QA station takes meetings in exchange.
  await dialog
    .getByRole("button", { name: /^Meeting area room/ })
    .click();
  await dialog.getByLabel("What happens here").selectOption("qa");
  await expect(
    dialog.getByRole("button", { name: /^QA station room, for QA station/ }),
  ).toBeVisible();

  await dialog.getByRole("button", { name: "Save the office" }).click();
  await expect(dialog).toHaveCount(0);

  // The server stored it, in the portable preset.
  const preset = await (
    await request.get(`/api/workspaces/${workspaceId}/visual-preset`)
  ).json();
  expect(preset.version).toBe(2);
  expect(preset.layout.zones.qa.label).toBe("Test lab");
  expect(preset.layout.zones.qa.z).toBeGreaterThan(-1);
  expect(preset.layout.props).toHaveLength(1);
  expect(preset.layout.props[0].kind).toBe("sofa");
  // The two rooms traded functions.
  expect(preset.layout.zones.meeting.does).toBe("qa");
  expect(preset.layout.zones.qa.does).toBe("meeting");

  // The office calls the room by its new name, and still does after a reload.
  await page.getByRole("button", { name: "Show office map" }).click();
  const chips = page.locator(".office-rooms");
  await expect(
    chips.getByRole("button", { name: "Test lab", exact: true }),
  ).toBeVisible();
  // The room that took QA is called the QA station now.
  await expect(
    chips.getByRole("button", { name: "QA station", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Live connection", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show office map" }).click();
  await expect(
    page.locator(".office-rooms").getByRole("button", { name: "Test lab", exact: true }),
  ).toBeVisible();

  // Reset gives the environment's own layout back.
  await page
    .getByRole("region", { name: "Office controls" })
    .getByText("Environment", { exact: true })
    .click();
  await page.getByRole("button", { name: "Arrange the office" }).click();
  const again = page.getByRole("dialog", { name: "Arrange the office" });
  await again.getByRole("button", { name: "Reset" }).click();
  await again.getByRole("button", { name: "Save the office" }).click();
  await expect(again).toHaveCount(0);
  const after = await (
    await request.get(`/api/workspaces/${workspaceId}/visual-preset`)
  ).json();
  expect(after.layout).toEqual({ zones: {}, props: [] });
});
