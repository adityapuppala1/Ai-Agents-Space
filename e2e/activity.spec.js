import { test, expect } from "@playwright/test";

/**
 * The Activity page reads past the live snapshot's latest 60 events, a page
 * at a time, and says how many of the recorded total it is showing.
 */
test("activity reads older events a page at a time and says how many are showing", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/workspaces", {
    data: { name: `Activity history ${Date.now().toString(36)}` },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const workspaceId = (await created.json()).id;
  // Each task records an event: 175 plus whatever the workspace recorded
  // when it was created, so two pages are needed past the live 60.
  for (let i = 0; i < 175; i++) {
    const task = await request.post(`/api/workspaces/${workspaceId}/tasks`, {
      data: { title: `History task ${i}`, priority: "low" },
    });
    expect(task.ok()).toBeTruthy();
  }
  const { total } = await (
    await request.get(`/api/workspaces/${workspaceId}/events?limit=1`)
  ).json();
  expect(total).toBeGreaterThanOrEqual(175);

  await page.addInitScript(
    (id) => localStorage.setItem("agent-space-workspace", id),
    workspaceId,
  );
  await page.goto("/");
  await page
    .locator("aside")
    .getByRole("button", { name: "Activity", exact: true })
    .click();
  const region = page.getByRole("region", { name: "Workspace activity" });
  const rows = region.locator(".feed-row");
  await expect(region).toContainText(
    `Showing 60 of ${total.toLocaleString("en-US")} recorded events`,
  );
  await expect(rows).toHaveCount(60);

  await region.getByRole("button", { name: /^Show 100 older events$/ }).click();
  await expect(rows).toHaveCount(160);
  await expect(region).toContainText(`Showing 160 of`);

  const rest = total - 160;
  await region
    .getByRole("button", { name: `Show ${rest} older events` })
    .click();
  await expect(rows).toHaveCount(total);
  await expect(region).toContainText(
    "That is every event recorded in this workspace.",
  );
  await expect(
    region.getByRole("button", { name: /older events/ }),
  ).toHaveCount(0);
  // The oldest row is the workspace's first task, and none is repeated.
  const texts = await rows.locator(".feed-message").allTextContents();
  expect(new Set(texts).size).toBe(texts.length);
  expect(texts.at(-1)).not.toContain("History task 174");
});
