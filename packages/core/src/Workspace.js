import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { InputError, TaskStore } from "./TaskStore.js";

export const AGENTS = [
  {
    id: "atlas",
    name: "Atlas",
    role: "Architect",
    color: "#7d8cc4",
    initials: "AT",
    specialty: "Systems & planning",
    workingState: "ANALYZING",
  },
  {
    id: "nova",
    name: "Nova",
    role: "Frontend developer",
    color: "#527be1",
    initials: "NO",
    specialty: "Interfaces & interaction",
    workingState: "CODING",
  },
  {
    id: "echo",
    name: "Echo",
    role: "Backend developer",
    color: "#4f9c92",
    initials: "EC",
    specialty: "APIs & data",
    workingState: "CODING",
  },
  {
    id: "pixel",
    name: "Pixel",
    role: "QA engineer",
    color: "#c29552",
    initials: "PX",
    specialty: "Testing & validation",
    workingState: "TESTING",
  },
  {
    id: "orbit",
    name: "Orbit",
    role: "DevOps engineer",
    color: "#c27c83",
    initials: "OR",
    specialty: "Builds & infrastructure",
    workingState: "DEBUGGING",
  },
  {
    id: "sage",
    name: "Sage",
    role: "Researcher",
    color: "#8a9d62",
    initials: "SA",
    specialty: "Research & discovery",
    workingState: "RESEARCHING",
  },
];

export class Workspace extends EventEmitter {
  constructor(store = new TaskStore(), { demo = false } = {}) {
    super();
    this.store = store;
    this.events = [];
    this.sequence = 0;
    this.demoRunning = false;
    this.startedAt = Date.now();
    if (demo) this.loadDemo();
  }

  snapshot() {
    const tasks = this.store.list();
    const agents = AGENTS.map((agent) => {
      const task = tasks.find(
        (task) =>
          task.assignedAgentId === agent.id &&
          !["COMPLETED", "QUEUE"].includes(task.status),
      );
      return {
        ...agent,
        state: task
          ? task.status === "BLOCKED"
            ? "BLOCKED"
            : agent.workingState
          : "IDLE",
        taskId: task?.id,
        completed: tasks.filter(
          (t) => t.assignedAgentId === agent.id && t.status === "COMPLETED",
        ).length,
      };
    });
    return {
      agents,
      tasks,
      events: this.events,
      demoRunning: this.demoRunning,
      sequence: this.sequence,
      startedAt: this.startedAt,
    };
  }

  changed(message, kind = "task", agentId) {
    this.events.unshift({
      id: randomUUID(),
      message,
      kind,
      agentId,
      timestamp: Date.now(),
    });
    this.events = this.events.slice(0, 60);
    this.sequence++;
    this.emit("change", this.snapshot());
  }

  availableAgent(agentId) {
    const agent = this.snapshot().agents.find((a) => a.id === agentId);
    if (!agent) throw new InputError("Agent not found", 404);
    if (agent.taskId)
      throw new InputError(
        `${agent.name} is already working. Choose an available agent or add to queue.`,
        409,
      );
    return agent;
  }

  create(input) {
    const agent = input?.agentId ? this.availableAgent(input.agentId) : null;
    let task = this.store.create(input);
    if (agent) task = this.store.assign(task.id, agent.id);
    this.changed(
      agent
        ? `${agent.name} started “${task.title}”`
        : `Added “${task.title}” to the queue`,
      "task",
      agent?.id,
    );
    return task;
  }

  assign(id, agentId) {
    const agent = this.availableAgent(agentId);
    const task = this.store.assign(id, agentId);
    this.changed(`${agent.name} started “${task.title}”`, "task", agent.id);
    return task;
  }

  update(id, input) {
    const task = this.store.update(id, input);
    const action =
      task.status === "COMPLETED"
        ? "Completed"
        : task.status === "BLOCKED"
          ? "Paused"
          : "Updated";
    this.changed(
      `${action} “${task.title}”`,
      task.status === "COMPLETED" ? "complete" : "task",
      task.assignedAgentId,
    );
    return task;
  }

  setDemo(running) {
    if (typeof running !== "boolean")
      throw new InputError("running must be a boolean");
    this.demoRunning = running;
    this.changed(`Demo simulation ${running ? "resumed" : "paused"}`, "system");
  }

  loadDemo() {
    this.store.removeDemoTasks();
    const samples = [
      [
        "Map the workspace architecture",
        "Break the workspace into clear modules and define the event contract.",
        64,
        "high",
      ],
      [
        "Build the agent dashboard",
        "Create responsive agent cards, task details, and the office viewport.",
        42,
        "high",
      ],
      [
        "Connect the live event stream",
        "Keep tasks and agent states synchronized across connected clients.",
        78,
        "high",
      ],
      [
        "Test task assignment flow",
        "Verify assignment, progress updates, and completion from end to end.",
        31,
        "medium",
      ],
      [
        "Review deployment configuration",
        "Waiting for a target environment. Resume this task when the target is ready.",
        23,
        "critical",
      ],
      [
        "Explore animation references",
        "Find clear visual cues for researching, coding, testing, and idle states.",
        100,
        "low",
      ],
    ];
    samples.forEach(([title, description, progress, priority], i) => {
      if (this.snapshot().agents[i].taskId) return;
      const task = this.store.create({ title, description, priority }, "demo");
      this.store.assign(task.id, AGENTS[i].id);
      this.store.update(task.id, {
        progress,
        status: progress === 100 ? "COMPLETED" : "IN_PROGRESS",
      });
      if (i === 4) this.store.update(task.id, { status: "BLOCKED" });
      this.events.unshift({
        id: randomUUID(),
        message: `${AGENTS[i].name} ${progress === 100 ? "completed" : i === 4 ? "paused" : "started"} “${title}”`,
        kind: progress === 100 ? "complete" : "task",
        agentId: AGENTS[i].id,
        timestamp: Date.now(),
      });
    });
    this.store.create(
      {
        title: "Document the integration contract",
        description:
          "Describe how external tools can submit tasks to the local workspace API.",
        priority: "medium",
      },
      "demo",
    );
    this.demoRunning = true;
    this.changed(
      "Demo workspace loaded. All agent activity is simulated.",
      "system",
    );
  }

  tick() {
    if (!this.demoRunning) return;
    const active = this.store
      .list()
      .filter((t) => t.source === "demo" && t.status === "IN_PROGRESS");
    if (!active.length) return;
    for (const task of active) {
      const progress = Math.min(100, task.progress + 1);
      this.store.update(task.id, {
        progress,
        status: progress === 100 ? "COMPLETED" : "IN_PROGRESS",
      });
      if (progress === 100)
        this.changed(
          `Completed “${task.title}”`,
          "complete",
          task.assignedAgentId,
        );
    }
    this.sequence++;
    this.emit("change", this.snapshot());
  }
}
