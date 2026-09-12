import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { HOMES } from "./global-setup.js";

/**
 * A team deployed from a template works as a relay: the first step runs,
 * the office shows the team (the kickoff, the member waiting for it, the
 * relay strip), and when a step is accepted its result is handed to the
 * next agent — recorded, passed into the next prompt, and played as a
 * handoff moment in the office. Fake provider CLIs only.
 */
test("a deployed team works as a relay, and the office plays the handoff", async ({
  page,
  request,
}) => {
  test.setTimeout(120000);
  const name = `team-${Date.now().toString(36)}`;
  const rootPath = path.join(HOMES.projects, name);
  fs.mkdirSync(rootPath, { recursive: true });
  fs.writeFileSync(path.join(rootPath, "README.md"), `# ${name}\n`);
  const created = await request.post("/api/workspaces", {
    data: { name, rootPath },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const ws = await created.json();

  await page.addInitScript((id) => {
    localStorage.setItem("agent-space-workspace", id);
    localStorage.setItem(
      "agent-space-onboarding",
      JSON.stringify({ step: 0, done: [], dismissed: true }),
    );
  }, ws.id);
  await page.goto("/");
  await page
    .locator("aside")
    .getByRole("button", { name: "Task board", exact: true })
    .click();
  await page.getByRole("button", { name: "Use a template" }).click();
  // Roles read as names, not "[object Object]".
  const card = page
    .locator(".as-template")
    .filter({ hasText: "Bug clinic" })
    .first();
  await expect(card).toContainText("Investigator, Developer, QA engineer");
  await card.getByRole("button", { name: /Use template Bug clinic/ }).click();

  const dialog = page.locator("dialog[open]");
  await dialog.getByRole("textbox").first().fill("Login fails after redirect");
  // By the role's own name: agent options elsewhere ("Backend developer")
  // would match a plain text filter.
  const role = (label) =>
    dialog.locator(".team-role").filter({
      has: page.locator(".team-role-name > strong", {
        hasText: new RegExp(`^${label}$`),
      }),
    });
  // New profiles named for each role are proposed by default.
  await expect(role("Investigator").getByLabel("Agent")).toHaveValue("new");
  // Nothing can start until the first step has an assistant.
  const startNow = dialog.getByRole("checkbox", {
    name: /Start the first step now/,
  });
  await expect(startNow).toBeDisabled();
  await role("Investigator")
    .getByLabel("Assistant")
    .selectOption("claude-code");
  await role("Developer").getByLabel("Assistant").selectOption("claude-code");
  await expect(startNow).toBeEnabled();
  await expect(startNow).toBeChecked();
  await expect(dialog.locator(".team-relay-preview")).toContainText(
    "after Diagnose",
  );
  await dialog.getByRole("button", { name: "Deploy team" }).click();

  // The office opens on the team at work. The office chunk and the new
  // workspace snapshot both have to arrive, which under a loaded suite can
  // take longer than the default wait (the other office specs allow 30 s).
  await expect(page.locator(".scene-relay")).toContainText("Bug clinic", {
    timeout: 30000,
  });
  await expect(page.locator(".scene-relay")).toContainText("Reproduce");
  await expect(
    page.locator(".scene-moment.moment-kickoff").first(),
  ).toContainText("Team kickoff");
  await expect(
    page.getByRole("button", { name: "Inspect Investigator", exact: true }),
  ).toBeVisible();
  // Developer's step waits for Investigator's, so Developer stands waiting.
  await expect(
    page.getByRole("button", { name: "Inspect Developer", exact: true }),
  ).toHaveAttribute("title", /Waiting for Investigator/);

  const snapshot = async () =>
    (await request.get(`/api/workspaces/${ws.id}/workspace`)).json();
  const runFor = async (prefix) => {
    const state = await snapshot();
    const task = state.tasks.find((item) => item.title.startsWith(prefix));
    return task
      ? (state.runs.find((run) => run.taskId === task.id) ?? null)
      : null;
  };
  const acceptWhenDone = async (prefix) => {
    let run = null;
    await expect
      .poll(
        async () => {
          run = await runFor(prefix);
          return run?.status ?? null;
        },
        { timeout: 40000 },
      )
      .toBe("completed");
    const review = await request.post(`/api/runs/${run.id}/review`, {
      data: { decision: "accept" },
    });
    expect(review.ok(), await review.text()).toBeTruthy();
    return run;
  };

  // Reproduce and Diagnose are both Investigator's: a handoff to oneself is
  // recorded but plays no moment.
  await acceptWhenDone("Reproduce");
  await acceptWhenDone("Diagnose");

  // Diagnose -> Fix passes from Investigator to Developer.
  //
  // The office plays this as a *moment*, and a moment is a timed episode:
  // EPISODE_MS.handoff is 6 500 ms, after which it leaves the screen. Asking
  // the DOM three separate times — for the title, for "Recorded", and for the
  // receiving agent's label — races that window, and under a loaded suite the
  // gap between the first assertion and the third can outlast what is left of
  // it. So read everything once, while it is on screen, and assert on what
  // was read.
  const seen = { moment: "", developer: "" };
  await expect
    .poll(
      async () => {
        const moment = page.locator(".scene-moment.moment-handoff").first();
        if ((await moment.count()) === 0) return false;
        const developer = page.getByRole("button", {
          name: "Inspect Developer",
          exact: true,
        });
        seen.moment = await moment.innerText().catch(() => "");
        seen.developer = (await developer.count())
          ? await developer.innerText().catch(() => "")
          : "";
        return (
          seen.moment.includes("Handoff · Investigator → Developer") &&
          seen.developer.includes("Receiving from Investigator")
        );
      },
      { timeout: 30000 },
    )
    .toBe(true);
  // Asserted against the captured text, so a failure prints what the office
  // actually said rather than timing out against an element that has gone.
  expect(seen.moment).toContain("Handoff · Investigator → Developer");
  expect(seen.moment).toContain("Recorded");
  expect(seen.developer).toContain("Receiving from Investigator");

  // The handoff is on the record, naming both agents...
  const state = await snapshot();
  const handoff = state.events.find(
    (event) =>
      event.kind === "handoff" && /on to Developer/.test(event.message ?? ""),
  );
  expect(handoff?.handoff?.dispatched).toBe(true);
  expect(handoff?.handoff?.fromAgentId).toBeTruthy();
  expect(handoff?.toAgentId).toBe(handoff?.handoff?.toAgentId);
  // ...and the result reached the next agent's prompt as context.
  const fix = await runFor("Fix");
  const detail = await (await request.get(`/api/runs/${fix.id}`)).json();
  expect(detail.run?.prompt ?? "").toContain("Handoff from Investigator");
});

test("the office offers Deploy a team in a project workspace, never in the demo", async ({
  page,
  request,
  browser,
}) => {
  const name = `office-team-${Date.now().toString(36)}`;
  const rootPath = path.join(HOMES.projects, name);
  fs.mkdirSync(rootPath, { recursive: true });
  const ws = await (
    await request.post("/api/workspaces", { data: { name, rootPath } })
  ).json();
  await page.addInitScript((id) => {
    localStorage.setItem("agent-space-workspace", id);
    localStorage.setItem(
      "agent-space-onboarding",
      JSON.stringify({ step: 0, done: [], dismissed: true }),
    );
  }, ws.id);
  await page.goto("/");
  await page.getByRole("button", { name: "Deploy a team" }).click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toContainText("Choose what the team should do");
  await dialog
    .getByRole("button", { name: "Deploy a team for Bug clinic" })
    .click();
  await expect(dialog.locator(".team-role")).toHaveCount(3);
  await dialog.getByRole("button", { name: "All templates" }).click();
  await expect(
    dialog.getByRole("button", { name: "Deploy a team for Bug clinic" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  // Nothing was created by looking.
  const state = await (
    await request.get(`/api/workspaces/${ws.id}/workspace`)
  ).json();
  expect(state.tasks).toHaveLength(0);

  // The demo is simulated: no real team is deployed into it. A fresh
  // context: the init script above re-selects the project on every load.
  const demo = await browser.newContext();
  await demo.addInitScript(() => {
    localStorage.setItem("agent-space-workspace", "demo");
    localStorage.setItem(
      "agent-space-onboarding",
      JSON.stringify({ step: 0, done: [], dismissed: true }),
    );
  });
  const demoPage = await demo.newPage();
  await demoPage.goto("/");
  // The demo's office bar has loaded: a fresh context fetches the office and
  // the snapshot, which under a loaded suite can take a while, and which
  // agents stand on the floor depends on the simulation's clock.
  const controls = demoPage.getByRole("region", { name: "Office controls" });
  await expect(controls).toContainText("Demo workspace", { timeout: 30000 });
  await expect(
    demoPage.getByRole("button", { name: "Deploy a team" }),
  ).toHaveCount(0);
  await demo.close();
});
