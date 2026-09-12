import { expect } from "@playwright/test";

/**
 * Gives every agent in a workspace an assigned, in-progress task through the
 * public API. The office draws only agents with recorded work, so scale and
 * load scenarios need a working team, not an idle roster.
 * @returns {Promise<number>} the number of agents in the workspace
 */
export async function putTeamToWork(request, workspaceId) {
  const agents = await (
    await request.get(`/api/workspaces/${workspaceId}/agents`)
  ).json();
  const tasks = await (
    await request.get(`/api/workspaces/${workspaceId}/tasks`)
  ).json();
  const busy = new Set(tasks.map((t) => t.assignedAgentId).filter(Boolean));
  for (const agent of agents) {
    if (busy.has(agent.id)) continue;
    const task = await (
      await request.post(`/api/workspaces/${workspaceId}/tasks`, {
        data: { title: `Scenario work for ${agent.name}`, priority: "medium" },
      })
    ).json();
    const assigned = await request.post(
      `/api/workspaces/${workspaceId}/tasks/${task.id}/assign`,
      { data: { agentId: agent.id } },
    );
    expect(assigned.ok(), `assigning ${agent.name}`).toBeTruthy();
  }
  return agents.length;
}
