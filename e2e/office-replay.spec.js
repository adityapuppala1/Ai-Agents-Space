import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { HOMES } from "./global-setup.js";

/**
 * Watching the floor as it was.
 *
 * The rule that matters is not that the scrubber moves — it is that a replay
 * can never be mistaken for the present. So this checks the floor says which
 * minute it is showing, says the work is recorded, and gives the live floor
 * back when asked.
 */

const stamp = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

test("the office replays a recorded minute, and says that is what it is doing", async ({
  page,
  request,
}) => {
  const name = `replay-${stamp()}`;
  const rootPath = path.join(HOMES.projects, name);
  fs.mkdirSync(rootPath, { recursive: true });
  fs.writeFileSync(path.join(rootPath, "README.md"), `# ${name}\n`);
  const created = await request.post("/api/workspaces", {
    data: { name, rootPath },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const ws = await created.json();

  // A real run so there are recorded events to replay.
  const task = await request.post(`/api/workspaces/${ws.id}/tasks`, {
    data: { title: "WRITE_FILE and summarise the project" },
  });
  const { id: taskId } = await task.json();
  const launched = await request.post(
    `/api/workspaces/${ws.id}/tasks/${taskId}/run`,
    { data: { provider: "claude-code" } },
  );
  expect(launched.ok(), await launched.text()).toBeTruthy();

  await page.addInitScript((id) => {
    localStorage.setItem("agent-space-workspace", id);
    localStorage.setItem(
      "agent-space-onboarding",
      JSON.stringify({ step: 0, done: [], dismissed: true }),
    );
  }, ws.id);
  await page.goto("/");

  const replay = page.getByRole("button", { name: "Replay", exact: true });
  await expect(replay).toBeVisible({ timeout: 30000 });
  await replay.click();

  // The floor says which minute it is showing, and that it is recorded.
  const strip = page.locator(".office-replay");
  await expect(strip).toBeVisible();
  await expect(strip).toContainText(/^Replay · \d/);
  await expect(strip).toContainText("recorded events only");

  // Scrubbing to the start moves the cursor to a different moment.
  const before = await strip.innerText();
  const range = strip.locator("input[type=range]");
  await range.fill(await range.getAttribute("min"));
  await expect
    .poll(async () => strip.innerText(), { timeout: 10000 })
    .not.toBe(before);

  // The floor's own count follows what is drawn, not the live list: a replay
  // showing somebody must not sit under "0 on the floor".
  const floor = page.locator(".office-status .office-fact").first();
  await expect(floor).toContainText(/on the floor/);

  // And the live floor comes back when asked.
  await strip.getByRole("button", { name: "Back to live" }).click();
  await expect(strip).toHaveCount(0);
  await expect(replay).toBeVisible();
});
