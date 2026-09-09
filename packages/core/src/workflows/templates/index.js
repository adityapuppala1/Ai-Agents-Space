import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { InputError } from "../../TaskStore.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Order matches PRODUCT_ROADMAP.md section 14. */
export const TEMPLATE_ORDER = [
  "feature-delivery",
  "bug-clinic",
  "repository-onboarding",
  "release-room",
  "devops-incident-room",
  "data-engineering",
  "data-analytics",
  "research-desk",
  "documentation-studio",
  "design-review",
  "security-review",
  "agency-delivery",
  "marketing-operations",
];

let cache = null;

function load() {
  if (cache) return cache;
  const templates = new Map();
  for (const file of readdirSync(here)) {
    if (!file.endsWith(".json")) continue;
    const template = JSON.parse(readFileSync(join(here, file), "utf8"));
    validateTemplate(template);
    templates.set(template.id, template);
  }
  cache = templates;
  return templates;
}

/** Throws when a template is structurally unusable (bad step keys or deps). */
export function validateTemplate(template) {
  if (!template?.id || !Array.isArray(template.steps))
    throw new Error(`Template ${template?.id ?? "?"} is missing id or steps`);
  const roles = new Set((template.roles ?? []).map((role) => role.key));
  const keys = new Set();
  for (const step of template.steps) {
    if (!step.key || keys.has(step.key))
      throw new Error(
        `Template ${template.id}: duplicate step key ${step.key}`,
      );
    keys.add(step.key);
    if (step.role && !roles.has(step.role))
      throw new Error(
        `Template ${template.id}: step ${step.key} uses unknown role ${step.role}`,
      );
  }
  for (const step of template.steps)
    for (const dep of step.dependsOn ?? [])
      if (!keys.has(dep))
        throw new Error(
          `Template ${template.id}: step ${step.key} depends on unknown ${dep}`,
        );
  return true;
}

export function listTemplates() {
  const templates = load();
  const ordered = TEMPLATE_ORDER.filter((id) => templates.has(id)).map((id) =>
    templates.get(id),
  );
  for (const [id, template] of templates)
    if (!TEMPLATE_ORDER.includes(id)) ordered.push(template);
  return ordered.map((template) => structuredClone(template));
}

export function getTemplate(id) {
  const template = load().get(String(id));
  if (!template) throw new InputError(`Template ${id} not found`, 404);
  return structuredClone(template);
}

/** Replaces {{key}} placeholders with input values; unknown keys stay as-is. */
export function interpolate(text, inputs = {}) {
  return String(text ?? "").replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key) =>
    inputs[key] === undefined || inputs[key] === null
      ? match
      : String(inputs[key]),
  );
}
