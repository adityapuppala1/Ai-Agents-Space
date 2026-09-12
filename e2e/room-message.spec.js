import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { HOMES } from "./global-setup.js";

/**
 * Saying one thing to a whole team.
 *
 * Every member continues its own session, so this is several actions, not
 * one. The rules that matter: who will and will not receive it is shown
 * before anything is sent, and the refusals are the server's own words.
 */

const stamp = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

test("messaging a team says who will receive it before anything is sent", async ({
  page,
  request,
}) => {
  const name = `room-${stamp()}`;
  const rootPath = path.join(HOMES.projects, name);
  fs.mkdirSync(rootPath, { recursive: true });
  fs.writeFileSync(path.join(rootPath, "README.md"), `# ${name}\n`);
  const created = await request.post("/api/workspaces", {
    data: { name, rootPath },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const ws = await created.json();

  // A relay strip exists only for a *workflow*: tasks sharing a workflowId
  // and linked by dependsOn. Independent tasks put agents on the floor but
  // form no team, so there would be nothing to message.
  const agents = await (
    await request.get(`/api/workspaces/${ws.id}/agents`)
  ).json();
  expect(agents.length, "the workspace has agents to form a team").toBeGreaterThan(1);
  const workflowId = `wf-${stamp()}`;
  const step = async (title, agentId, dependsOn) => {
    const made = await request.post(`/api/workspaces/${ws.id}/tasks`, {
      data: { title, agentId, workflowId, dependsOn },
    });
    expect(made.ok(), await made.text()).toBeTruthy();
    return (await made.json()).id;
  };
  const first = await step("Diagnose the outage", agents[0].id, []);
  await step("Fix what it found", agents[1].id, [first]);

  await page.addInitScript((id) => {
    localStorage.setItem("agent-space-workspace", id);
    localStorage.setItem(
      "agent-space-onboarding",
      JSON.stringify({ step: 0, done: [], dismissed: true }),
    );
  }, ws.id);
  await page.goto("/");

  const message = page.getByRole("button", { name: /^Message everyone in / });
  await expect(message).toBeVisible({ timeout: 30000 });
  await message.click();

  const dialog = page.getByRole("dialog", {
    name: /^Message everyone in /,
  });
  await expect(dialog).toBeVisible();
  // It says plainly that this is several actions, not one conversation.
  await expect(dialog).toContainText("starts a new attempt for every one");
  // And it counts who will actually hear it before offering to send.
  await expect(dialog).toContainText(
    /(will receive this|Nobody here can be messaged|Nobody is in this room)/,
  );

  // These two hold manual tasks, not provider runs, so neither can be
  // messaged — and each is named with the server's own reason rather than
  // being quietly dropped from the list.
  const cannot = dialog.getByRole("list", { name: "Cannot be messaged" });
  await expect(cannot).toBeVisible();
  if (process.env.AGENT_SPACE_CAPTURE)
    await dialog.screenshot({ path: process.env.AGENT_SPACE_CAPTURE });
  await expect(cannot.locator("li")).toHaveCount(2);
  await expect(cannot.locator("li").first()).toContainText(
    /recorded here only|cannot resume|no run to continue|still working/,
  );

  // Nothing can be sent to nobody: the button says so and refuses.
  const send = dialog.getByRole("button", { name: "Send to 0" });
  await expect(send).toBeDisabled();
  // The box itself is closed too, so there is nothing to type into.
  await expect(dialog.getByRole("textbox")).toBeDisabled();
});
