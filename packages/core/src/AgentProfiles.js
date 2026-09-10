import { randomUUID } from "node:crypto";
import { InputError } from "./TaskStore.js";

export const WORKING_STATES = [
  "CODING",
  "ANALYZING",
  "TESTING",
  "DEBUGGING",
  "RESEARCHING",
];

export const DEFAULT_AGENTS = [
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

function rowToProfile(row) {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    color: row.color,
    initials: row.initials,
    specialty: row.specialty,
    instructions: row.instructions,
    workingState: row.working_state,
    runtime: row.runtime ?? null,
    model: row.model ?? null,
    // Schema v2: provider-backed and auto-created profiles.
    provider: row.provider ?? null,
    autoCreated: row.auto_created === 1,
    connectionId: row.connection_id ?? null,
    skills: parseSkills(row.skills),
    avatar: row.avatar ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? null,
  };
}

function parseSkills(value) {
  try {
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseAvatar(value) {
  try {
    const parsed = value ? JSON.parse(value) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

const PROVIDER_IDS = ["claude-code", "codex", "copilot", "cursor", "gemini"];

function text(value, field, max, { required = false } = {}) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max)
    throw new InputError(`${field} must be a string under ${max} characters`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new InputError(`${field} is required`);
  return trimmed;
}

function initialsFor(name) {
  const parts = name.split(/\s+/).filter(Boolean);
  const letters =
    parts.length > 1
      ? parts[0][0] + parts[1][0]
      : name.replace(/[^a-z0-9]/gi, "").slice(0, 2);
  return (letters || "AG").toUpperCase();
}

function skills(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 24)
    throw new InputError("Skills must be an array with at most 24 entries");
  const clean = value.map((item) => text(item, "Skill", 60, { required: true }));
  return [...new Set(clean)];
}

function avatar(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new InputError("Avatar must be an object");
  const allowed = {
    outfit: ["hoodie", "shirt", "labcoat", "vest", "jacket"],
    accessory: ["hardhat", "glasses", "headset", "clipboard", "none"],
  };
  const result = {};
  for (const key of ["outfit", "accessory"]) {
    if (value[key] === undefined || value[key] === "") continue;
    if (!allowed[key].includes(value[key]))
      throw new InputError(`${key} must be one of ${allowed[key].join(", ")}`);
    if (value[key] !== "none") result[key] = value[key];
  }
  if (value.hairColor !== undefined && value.hairColor !== "") {
    if (!/^#[0-9a-f]{6}$/i.test(value.hairColor))
      throw new InputError("Hair color must be a hex value");
    result.hairColor = value.hairColor.toLowerCase();
  }
  if (value.pronouns !== undefined && value.pronouns !== "")
    result.pronouns = text(value.pronouns, "Pronouns", 30);
  return JSON.stringify(result);
}

/**
 * Editable agent profiles scoped to one workspace. The profile is the stable
 * identity a person edits; runs keep their own snapshot so editing a profile
 * never rewrites history.
 */
export class AgentProfiles {
  constructor(db, workspaceId) {
    this.db = db;
    this.workspaceId = workspaceId;
  }

  seedDefaults() {
    const count = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM agent_profiles WHERE workspace_id = ?",
      )
      .get(this.workspaceId).n;
    if (count) return;
    const now = Date.now();
    const insert = this.db.prepare(
      `INSERT INTO agent_profiles (id, workspace_id, name, role, color, initials, specialty, working_state, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    DEFAULT_AGENTS.forEach((agent, position) => {
      // Profile IDs are stable per workspace; the demo workspace keeps the
      // short ids so scripts and documentation stay valid.
      const id =
        this.workspaceId === "demo" || this.workspaceId === "local"
          ? agent.id
          : `${this.workspaceId}-${agent.id}`;
      insert.run(
        id,
        this.workspaceId,
        agent.name,
        agent.role,
        agent.color,
        agent.initials,
        agent.specialty,
        agent.workingState,
        position,
        now,
        now,
      );
    });
  }

  list({ includeArchived = false } = {}) {
    return this.db
      .prepare(
        `SELECT * FROM agent_profiles WHERE workspace_id = ?
         ${includeArchived ? "" : "AND archived_at IS NULL"}
         ORDER BY position, created_at`,
      )
      .all(this.workspaceId)
      .map(rowToProfile);
  }

  get(id, { includeArchived = true } = {}) {
    const row = this.db
      .prepare("SELECT * FROM agent_profiles WHERE id = ? AND workspace_id = ?")
      .get(id, this.workspaceId);
    if (!row || (!includeArchived && row.archived_at))
      throw new InputError("Agent not found", 404);
    return rowToProfile(row);
  }

  #validate(input, { partial = false } = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new InputError("Expected an object");
    const fields = {
      name: text(input.name, "Name", 60, { required: true }),
      role: text(input.role, "Role", 60, { required: true }),
      specialty: text(input.specialty, "Specialty", 120),
      instructions: text(input.instructions, "Instructions", 4000),
      runtime: text(input.runtime, "Runtime", 60),
      model: text(input.model, "Model", 120),
      skills: skills(input.skills),
      avatar: avatar(input.avatar),
    };
    if (input.color !== undefined) {
      if (
        typeof input.color !== "string" ||
        !/^#[0-9a-f]{6}$/i.test(input.color)
      )
        throw new InputError("Color must be a hex value like #4c78ce");
      fields.color = input.color.toLowerCase();
    }
    if (input.workingState !== undefined) {
      if (!WORKING_STATES.includes(input.workingState))
        throw new InputError(
          `workingState must be one of ${WORKING_STATES.join(", ")}`,
        );
      fields.workingState = input.workingState;
    }
    if (input.provider !== undefined) {
      if (input.provider !== null && !PROVIDER_IDS.includes(input.provider))
        throw new InputError(
          `provider must be null or one of ${PROVIDER_IDS.join(", ")}`,
        );
      fields.provider = input.provider;
    }
    if (!partial) {
      if (fields.name === undefined) throw new InputError("Name is required");
      if (fields.role === undefined) throw new InputError("Role is required");
    }
    return Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    );
  }

  create(input) {
    const fields = this.#validate(input);
    const now = Date.now();
    const position = this.db
      .prepare(
        "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM agent_profiles WHERE workspace_id = ?",
      )
      .get(this.workspaceId).next;
    const id = randomUUID().slice(0, 8);
    this.db
      .prepare(
        `INSERT INTO agent_profiles (id, workspace_id, name, role, color, initials, specialty, instructions, working_state, runtime, model, provider, skills, avatar, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.workspaceId,
        fields.name,
        fields.role,
        fields.color ?? "#4c78ce",
        initialsFor(fields.name),
        fields.specialty ?? "",
        fields.instructions ?? "",
        fields.workingState ?? "CODING",
        fields.runtime ?? null,
        fields.model ?? null,
        fields.provider ?? null,
        JSON.stringify(fields.skills ?? []),
        fields.avatar ?? null,
        position,
        now,
        now,
      );
    return this.get(id);
  }

  update(id, input) {
    const current = this.get(id);
    if (current.archivedAt)
      throw new InputError("Restore the agent before editing it", 409);
    const fields = this.#validate(input, { partial: true });
    if (!Object.keys(fields).length)
      throw new InputError("Provide at least one field to update");
    const next = { ...current, ...fields };
    if (fields.name) next.initials = initialsFor(fields.name);
    this.db
      .prepare(
        `UPDATE agent_profiles SET name = ?, role = ?, color = ?, initials = ?, specialty = ?, instructions = ?, working_state = ?, runtime = ?, model = ?, provider = ?, skills = ?, avatar = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.name,
        next.role,
        next.color,
        next.initials,
        next.specialty,
        next.instructions,
        next.workingState,
        next.runtime,
        next.model,
        next.provider ?? null,
        JSON.stringify(next.skills ?? []),
        next.avatar ?? null,
        Date.now(),
        id,
      );
    return this.get(id);
  }

  duplicate(id) {
    const source = this.get(id);
    return this.create({
      name: `${source.name} copy`.slice(0, 60),
      role: source.role,
      color: source.color,
      specialty: source.specialty,
      instructions: source.instructions,
      workingState: source.workingState,
      runtime: source.runtime ?? undefined,
      model: source.model ?? undefined,
      provider: source.provider ?? undefined,
      skills: source.skills,
      avatar: parseAvatar(source.avatar),
    });
  }

  archive(id) {
    const profile = this.get(id);
    if (profile.archivedAt) return profile;
    const active = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE assigned_agent_id = ? AND status IN ('IN_PROGRESS', 'BLOCKED')",
      )
      .get(id).n;
    if (active)
      throw new InputError(
        `${profile.name} still has active work. Complete or reassign it first.`,
        409,
      );
    this.db
      .prepare(
        "UPDATE agent_profiles SET archived_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(Date.now(), Date.now(), id);
    return this.get(id);
  }

  restore(id) {
    this.get(id);
    this.db
      .prepare(
        "UPDATE agent_profiles SET archived_at = NULL, updated_at = ? WHERE id = ?",
      )
      .run(Date.now(), id);
    return this.get(id);
  }
}
