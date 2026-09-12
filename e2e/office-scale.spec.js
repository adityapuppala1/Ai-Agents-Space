import { test, expect } from "@playwright/test";
import { putTeamToWork } from "./helpers.js";

/**
 * Office scale: desk batching and keyboard reach with a large working team.
 *
 * What this proves is a counted reduction in draw objects and that every agent
 * on the floor stays an ordinary, named, focusable control. It is NOT a
 * frame-rate or capacity claim: the browser here renders through SwiftShader,
 * and e2e/performance.spec.js owns the timings. Nothing below asserts a
 * supported agent count.
 *
 * Only agents with recorded work stand on the floor, so each agent is given an
 * assigned task first. Idle profiles stay in the roster and never create a
 * figure, which this spec also checks.
 */

const AGENTS = 40;

async function scaleCounts(page) {
  return page.evaluate(() => window.__officeScale ?? null);
}

test("a large working team batches its desks and stays reachable by keyboard", async ({
  page,
  request,
}) => {
  test.setTimeout(150000);

  // A dedicated workspace: 40 agents must not leak into the demo workspace
  // every other spec reads.
  const created = await request.post("/api/workspaces", {
    data: { name: "Office scale" },
  });
  expect(created.ok()).toBeTruthy();
  const workspace = await created.json();
  const workspaceId = workspace.id ?? workspace.workspaceId;

  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByText("Live connection", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Switch workspace", { exact: true })
    .selectOption(workspaceId);
  // An idle team stands nowhere: nobody has recorded work yet.
  await expect(page.locator(".scene-label")).toHaveCount(0);

  const existing = await (
    await request.get(`/api/workspaces/${workspaceId}/agents`)
  ).json();
  for (let i = existing.length; i < AGENTS; i += 1) {
    const response = await request.post(
      `/api/workspaces/${workspaceId}/agents`,
      {
        data: {
          name: `Scale ${String(i + 1).padStart(3, "0")}`,
          role: "Scale scenario",
          color: "#4a7dd0",
        },
      },
    );
    expect(response.ok(), `creating agent ${i + 1}`).toBeTruthy();
  }
  expect(await putTeamToWork(request, workspaceId)).toBe(AGENTS);
  await page.reload();
  await expect(
    page.getByText("Live connection", { exact: true }),
  ).toBeVisible();

  // The contract every other office spec depends on: one control per agent.
  await expect(page.locator(".scene-label")).toHaveCount(AGENTS, {
    timeout: 30000,
  });
  await expect(page.locator(".scene-fallback")).toHaveCount(0);

  await expect
    .poll(async () => (await scaleCounts(page))?.agents ?? 0, {
      timeout: 15000,
    })
    .toBe(AGENTS);
  const counts = await scaleCounts(page);

  // Batching: the desks are instanced parts in chunks, not 16 meshes per agent.
  expect(
    counts.deskMeshes,
    `desk meshes ${counts.deskMeshes} for ${AGENTS} agents`,
  ).toBeLessThan(AGENTS * 2);
  expect(counts.deskMeshes).toBeGreaterThan(0);
  // Live monitor textures are capped by the graphics preset, not by roster size.
  expect(counts.liveScreens).toBeLessThan(AGENTS);

  // Every figure's label is an ordinary, named, focusable button.
  const labels = page.locator(".scene-label");
  const names = await labels.evaluateAll((els) =>
    els.map((el) => ({
      tag: el.tagName,
      name: el.getAttribute("aria-label") ?? "",
      tabbable: el.tabIndex >= 0,
    })),
  );
  expect(names).toHaveLength(AGENTS);
  for (const label of names) {
    expect(label.tag).toBe("BUTTON");
    expect(label.name).toMatch(/^Inspect /);
    expect(label.tabbable).toBe(true);
  }
  // A crowded floor sends the large team to a conference room: sixteen walk
  // in through the door and sit round the table, the rest keep their desks.
  // Nobody is grouped or hidden: every figure is drawn, every button stays.
  // The workspace's default agents each form a team of one and stay put.
  const team = AGENTS - existing.length;
  const room = page.locator(".scene-room");
  await expect(room).toHaveCount(1);
  // The sign over the door: the team and how many sit at the table.
  await expect(room.locator(".scene-room-look")).toHaveText(
    /Scale scenario\s*16/,
  );
  const look = room.getByRole("button", {
    name: /Scale scenario: 16 at the table/,
  });
  await expect(look).toHaveAccessibleName(
    new RegExp(`${team - 16} more at their desks`),
  );
  await expect.poll(async () => (await scaleCounts(page)).roomed).toBe(16);
  const meeting = await scaleCounts(page);
  expect(meeting.rooms).toBe(1);
  expect(meeting.clustered).toBe(0);
  expect(meeting.visibleFigures).toBe(AGENTS);
  // They get there on foot and then sit down (the walk takes a few seconds).
  await expect
    .poll(async () => (await scaleCounts(page)).seated ?? 0, {
      timeout: 20000,
    })
    .toBe(16);

  const last = labels.last();
  await last.focus();
  await expect(last).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(last).toHaveClass(/selected/);

  // Back to desks: the sign opens on keyboard focus; everyone gets up and
  // walks out; the room closes.
  await look.focus();
  await expect(room).toContainText(`${team - 16} more at their desks`);
  await room
    .getByRole("button", { name: "Scale scenario: back to desks" })
    .click();
  await expect(page.locator(".scene-room")).toHaveCount(0);
  await expect.poll(async () => (await scaleCounts(page)).roomed).toBe(0);
  await expect
    .poll(async () => (await scaleCounts(page)).seated ?? -1)
    .toBe(0);
  // And the team can go back in.
  await page.getByRole("button", { name: "Use conference rooms" }).click();
  await expect(page.locator(".scene-room")).toHaveCount(1);
  await expect.poll(async () => (await scaleCounts(page)).roomed).toBe(16);

  expect(errors, errors.join("\n")).toEqual([]);
});
