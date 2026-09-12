import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { HOMES } from "./global-setup.js";

/**
 * Schedules from the UI: a schedule is created disabled with its next runs
 * previewed, says it waits for scheduling while scheduling is off, runs once
 * by hand, records that in its history, and scheduling itself turns on and
 * off without a restart.
 */
test("a schedule is set up, run by hand and switched from the Schedules page", async ({
  page,
  request,
}) => {
  const name = `sched-${Date.now().toString(36)}`;
  const rootPath = path.join(HOMES.projects, name);
  fs.mkdirSync(rootPath, { recursive: true });
  fs.writeFileSync(path.join(rootPath, "README.md"), `# ${name}\n`);
  const created = await request.post("/api/workspaces", {
    data: { name, rootPath },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const ws = await created.json();
  await page.addInitScript(
    (id) => localStorage.setItem("agent-space-workspace", id),
    ws.id,
  );

  await page.goto("/");
  await page
    .locator("aside")
    .getByRole("button", { name: "Schedules", exact: true })
    .click();
  const region = page.getByRole("region", { name: "Schedules" });
  await expect(region).toContainText("Scheduling is off");
  await expect(region).toContainText("No schedules yet");

  // Create: the server previews the next runs before anything is saved.
  await region.getByRole("button", { name: "New schedule" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New schedule" });
  await dialog.getByLabel("Name").fill("Nightly README check");
  await dialog.getByLabel("Task title").fill("WRITE_FILE check the README");
  await dialog.getByLabel("Assistant").selectOption("claude-code");
  await dialog.getByLabel("Timing").selectOption("custom");
  await dialog.getByLabel("Cron expression").fill("not a timing");
  await expect(dialog.locator(".sched-preview")).toContainText(
    /expression|field|cron/i,
  );
  await dialog.getByLabel("Cron expression").fill("0 2 * * *");
  await dialog.getByLabel("Time zone").fill("Asia/Kolkata");
  await expect(dialog.locator(".sched-preview")).toContainText("Next runs:");
  await expect(dialog.locator(".sched-preview")).toContainText("02:00");
  await dialog.getByRole("button", { name: "Save (disabled)" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(region).toContainText("is saved and disabled");

  const row = region.locator(".sched-row").filter({
    hasText: "Nightly README check",
  });
  await expect(row.locator(".sched-state")).toHaveText("Disabled");
  await expect(row).toContainText("0 2 * * *");
  await expect(row).toContainText("Asia/Kolkata");
  await expect(row).toContainText("Has not run yet");

  // Enabled while scheduling is off: it says it is waiting.
  await row.getByRole("button", { name: "Enable" }).click();
  await expect(row.locator(".sched-state")).toHaveText(
    "Enabled · scheduling is off",
  );
  await expect(row).toContainText("Next:");

  // Run now: one run, by hand, recorded in the history with its run.
  await row.getByRole("button", { name: /Run now/ }).click();
  await expect(region).toContainText("started now", { timeout: 20000 });
  await expect(row).toContainText("Last: Started by hand");
  await row.getByRole("button", { name: "History" }).click();
  const history = row.getByRole("list", {
    name: "History of Nightly README check",
  });
  await expect(history).toContainText("Started by hand");
  await expect(history.getByRole("button", { name: "Open run" })).toBeVisible();

  // Scheduling on (after a confirmation that says what it will do), then off.
  await region.getByRole("button", { name: "Turn scheduling on" }).click();
  const confirm = page.getByRole("dialog", { name: "Turn scheduling on?" });
  await expect(confirm).toContainText("enabled schedule");
  await confirm.getByRole("button", { name: "Turn scheduling on" }).click();
  await expect(region.locator(".sched-switch")).toContainText(
    "Scheduling is on",
  );
  await expect(row.locator(".sched-state")).toHaveText("Enabled");
  const status = await (await request.get("/api/scheduler/status")).json();
  expect(status.enabled).toBe(true);
  expect(status.running).toBe(true);
  await region.getByRole("button", { name: "Turn scheduling off" }).click();
  await expect(region.locator(".sched-switch")).toContainText(
    "Scheduling is off",
  );
  expect(
    (await (await request.get("/api/scheduler/status")).json()).running,
  ).toBe(false);

  // Cancel (confirmed): it moves to its own section, history kept.
  await row.getByRole("button", { name: "Cancel schedule" }).click();
  await page
    .getByRole("dialog", { name: "Cancel “Nightly README check”?" })
    .getByRole("button", { name: "Cancel schedule" })
    .click();
  await expect(region).toContainText("is cancelled");
  await region.getByRole("button", { name: "Cancelled schedules (1)" }).click();
  await expect(row.locator(".sched-state")).toHaveText("Cancelled");
  await expect(row.getByRole("button", { name: "Enable" })).toHaveCount(0);

  // Delete (confirmed): the schedule and its history go.
  await row.getByRole("button", { name: "Delete with its history" }).click();
  await page
    .getByRole("dialog", { name: "Delete “Nightly README check”?" })
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(row).toHaveCount(0);
  await expect(region).toContainText("No schedules yet");
});
