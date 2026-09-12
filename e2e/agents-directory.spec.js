import { test, expect } from "@playwright/test";

/**
 * The Agents page is the team as people: cards in sections (needs attention,
 * working now, ready for work), each with the agent's office figure in 3D,
 * search and state filters, a card that opens in place (no spotlight: the run
 * and the office have their own views), and edit, duplicate, archive and
 * restore from the card. Runs in its own workspace so the demo roster other
 * specs read is untouched.
 */
test("the agent directory filters, selects and manages profiles", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/workspaces", {
    data: { name: "Directory" },
  });
  expect(created.ok()).toBeTruthy();
  const workspaceId = (await created.json()).id;
  // One working agent: give the first profile an assigned task.
  const roster = await (
    await request.get(`/api/workspaces/${workspaceId}/agents`)
  ).json();
  const worker = roster[0];
  const task = await (
    await request.post(`/api/workspaces/${workspaceId}/tasks`, {
      data: { title: "Directory walkthrough", priority: "medium" },
    })
  ).json();
  expect(
    (
      await request.post(
        `/api/workspaces/${workspaceId}/tasks/${task.id}/assign`,
        { data: { agentId: worker.id } },
      )
    ).ok(),
  ).toBeTruthy();

  await page.addInitScript(
    (id) => localStorage.setItem("agent-space-workspace", id),
    workspaceId,
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  const directory = page.getByRole("region", { name: "Agent directory" });
  const rows = directory.locator(".agent-card");
  await expect(rows).toHaveCount(roster.length);
  // Sections: the working agent, then everyone ready for work.
  await expect(directory.locator(".agent-section-head h2")).toHaveText([
    /Working now\s*1/,
    new RegExp(`Ready for work\\s*${roster.length - 1}`),
  ]);
  // Every card carries the agent's figure, drawn by the page's one 3D stage.
  await expect(directory.locator(".agent-figure-canvas")).toHaveCount(
    roster.length,
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const canvas = document.querySelector(".agent-figure-canvas");
        if (!canvas?.width) return 0;
        const data = canvas
          .getContext("2d")
          .getImageData(0, 0, canvas.width, canvas.height).data;
        let painted = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted += 1;
        return painted;
      }),
    )
    .toBeGreaterThan(500);

  // State filters count from recorded state; the working agent leads.
  const filters = directory.getByRole("group", { name: "Show agents" });
  await filters.getByRole("button", { name: /^Working/ }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(worker.name);
  await filters.getByRole("button", { name: /^Idle/ }).click();
  await expect(rows).toHaveCount(roster.length - 1);
  await expect(rows.first()).toContainText("No recorded work right now");
  await filters.getByRole("button", { name: /^All/ }).click();

  // Search reaches the role.
  const target = roster[1];
  await directory
    .getByRole("textbox", { name: "Search agents" })
    .fill(target.role);
  await expect(rows.filter({ hasText: target.name })).toHaveCount(1);
  await directory.getByRole("textbox", { name: "Search agents" }).fill("");

  // Choosing a card opens it in place; no spotlight repeats the run views.
  const card = rows.filter({ hasText: target.name });
  const opener = card.locator(".agent-card-main");
  await opener.click();
  await expect(opener).toHaveAttribute("aria-expanded", "true");
  await expect(card.locator(".agent-card-details")).toContainText("Last run");
  await expect(card).toContainText("Choose a provider");
  await expect(
    page.getByRole("complementary", { name: "Agent spotlight" }),
  ).toHaveCount(0);
  await opener.click();
  await expect(opener).toHaveAttribute("aria-expanded", "false");

  // Edit straight from the row.
  await directory
    .getByRole("button", { name: `Edit ${target.name}`, exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: `Edit ${target.name}` });
  await dialog.locator("[name=provider]").selectOption("codex");
  await dialog.getByRole("button", { name: "Save agent", exact: true }).click();
  await expect(
    rows.filter({ hasText: target.name }).locator(".as-provider-codex"),
  ).toBeVisible();

  // Duplicate, then archive the copy and restore it.
  await directory
    .getByRole("button", { name: `Duplicate ${target.name}`, exact: true })
    .click();
  await expect(rows).toHaveCount(roster.length + 1);
  const copies = await (
    await request.get(`/api/workspaces/${workspaceId}/agents`)
  ).json();
  const copy = copies.find(
    (agent) => agent.id !== target.id && agent.name.startsWith(target.name),
  );
  expect(copy).toBeTruthy();
  await directory
    .getByRole("button", { name: `Archive ${copy.name}`, exact: true })
    .click();
  await expect(rows).toHaveCount(roster.length);
  await page
    .getByRole("button", { name: "Show archived", exact: true })
    .click();
  const archived = page.getByRole("region", { name: "Archived agents" });
  await archived.getByRole("button", { name: "Restore" }).first().click();
  await expect(rows).toHaveCount(roster.length + 1);

  // A working agent cannot be archived until its task is finished.
  await expect(
    directory.getByRole("button", {
      name: `Archive ${worker.name}`,
      exact: true,
    }),
  ).toBeDisabled();
});
