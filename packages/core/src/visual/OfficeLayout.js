// The office a workspace has arranged for itself: where each shared room
// sits, what that room is called, and the furniture standing around it.
//
// Data only, and deliberately dimensionless: every coordinate is a fraction
// of the floor (-1 .. 1 from the middle), so a layout a five-agent workspace
// arranged still holds when the floor grows for twenty. It carries no agent,
// no task, no path and no machine detail, which is what makes it portable in
// a visual preset. Pure module: node:test covers every rule.
import { InputError } from "../TaskStore.js";

/** The shared rooms a workspace can move and rename (web/office/zones.js). */
export const OFFICE_ZONE_IDS = Object.freeze([
  "research",
  "qa",
  "review",
  "meeting",
  "breakArea",
]);

/**
 * What a room is for. By default each room serves the function it is named
 * after; a workspace can give a room another function, or none at all, and
 * the office moves the furniture, the screens and the agents with it. Two
 * rooms cannot serve the same function: an agent testing has one place to
 * go, and the test results have one screen to appear on.
 */
export const OFFICE_ROOM_FUNCTIONS = Object.freeze([
  ...OFFICE_ZONE_IDS,
  "none",
]);

/**
 * The furniture catalogue. `radius` is the piece's footprint in world units,
 * used by the editor to keep pieces apart and by the scene to build it.
 */
export const OFFICE_PROP_KINDS = Object.freeze({
  plant: { label: "Plant", radius: 0.45 },
  tree: { label: "Tree", radius: 0.6 },
  sofa: { label: "Sofa", radius: 0.95 },
  armchair: { label: "Armchair", radius: 0.6 },
  table: { label: "Low table", radius: 0.6 },
  shelf: { label: "Shelf", radius: 0.8 },
  whiteboard: { label: "Whiteboard", radius: 0.8 },
  screen: { label: "Wall screen", radius: 0.9 },
  rug: { label: "Rug", radius: 1.1 },
  lamp: { label: "Floor lamp", radius: 0.35 },
  cabinet: { label: "Cabinet", radius: 0.7 },
  water: { label: "Water cooler", radius: 0.4 },
});

/** A floor holds this many pieces; beyond it an office reads as clutter. */
export const MAX_OFFICE_PROPS = 24;

/** A room's name, when a workspace gives it one. */
const MAX_LABEL = 24;

/** Nothing arranged: the theme's own layout, which is the default. */
export const EMPTY_OFFICE_LAYOUT = Object.freeze({
  zones: Object.freeze({}),
  props: Object.freeze([]),
});

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new InputError(`${field} must be an object`);
  return value;
}

/** A coordinate as a fraction of the floor, rounded to the millimetre-ish. */
function fraction(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new InputError(`${field} must be a number`);
  if (value < -1 || value > 1)
    throw new InputError(`${field} must be between -1 and 1`);
  return Math.round(value * 1000) / 1000;
}

function label(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new InputError(`${field} must be text`);
  // Control characters would carry line breaks into a room sign.
  const clean = value.replace(/[\u0000-\u001F\u007F]/g, " ").trim();
  if (!clean) return undefined;
  if (clean.length > MAX_LABEL)
    throw new InputError(`${field} must be under ${MAX_LABEL} characters`);
  return clean;
}

function rotation(value, field) {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new InputError(`${field} must be a number`);
  const turn = Math.PI * 2;
  const wrapped = ((value % turn) + turn) % turn;
  return Math.round(wrapped * 1000) / 1000;
}

function onlyKeys(value, allowed, field) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new InputError(`${field} has unknown key ${key}`);
}

/**
 * Validates an arranged office. Returns `{ zones, props }` with every
 * coordinate rounded and every unknown field refused, or throws InputError.
 * `null`/`undefined` is "nothing arranged".
 */
export function normalizeOfficeLayout(input) {
  if (input === null || input === undefined)
    return { zones: {}, props: [] };
  const source = object(input, "layout");
  onlyKeys(source, ["zones", "props"], "layout");
  const zones = {};
  if (source.zones !== undefined) {
    const from = object(source.zones, "layout.zones");
    for (const [id, value] of Object.entries(from)) {
      if (!OFFICE_ZONE_IDS.includes(id))
        throw new InputError(`layout.zones.${id} is not a room`);
      const zone = object(value, `layout.zones.${id}`);
      onlyKeys(zone, ["x", "z", "label", "does"], `layout.zones.${id}`);
      const placed = {
        x: fraction(zone.x, `layout.zones.${id}.x`),
        z: fraction(zone.z, `layout.zones.${id}.z`),
      };
      const name = label(zone.label, `layout.zones.${id}.label`);
      if (name) placed.label = name;
      if (zone.does !== undefined && zone.does !== null) {
        if (!OFFICE_ROOM_FUNCTIONS.includes(zone.does))
          throw new InputError(`layout.zones.${id}.does is not a room function`);
        // Its own function is the default and says nothing.
        if (zone.does !== id) placed.does = zone.does;
      }
      zones[id] = placed;
    }
  }
  // One function to one room: the office has one place for each kind of work.
  const taken = new Map();
  for (const [id, zone] of Object.entries(zones)) {
    const does = zone.does ?? id;
    if (does === "none") continue;
    if (taken.has(does))
      throw new InputError(
        `layout.zones.${id}.does is already the function of ${taken.get(does)}`,
      );
    taken.set(does, id);
  }
  // A room that kept its own function cannot keep it if another room took it.
  for (const id of OFFICE_ZONE_IDS) {
    if (zones[id]?.does) continue;
    const holder = taken.get(id);
    if (holder && holder !== id)
      throw new InputError(
        `layout.zones.${id} must give up ${id}: ${holder} serves it`,
      );
  }
  const props = [];
  if (source.props !== undefined) {
    if (!Array.isArray(source.props))
      throw new InputError("layout.props must be a list");
    if (source.props.length > MAX_OFFICE_PROPS)
      throw new InputError(`layout.props holds at most ${MAX_OFFICE_PROPS} pieces`);
    source.props.forEach((value, index) => {
      const prop = object(value, `layout.props[${index}]`);
      onlyKeys(prop, ["kind", "x", "z", "rotation"], `layout.props[${index}]`);
      if (typeof prop.kind !== "string" || !OFFICE_PROP_KINDS[prop.kind])
        throw new InputError(`layout.props[${index}].kind is not furniture`);
      props.push({
        kind: prop.kind,
        x: fraction(prop.x, `layout.props[${index}].x`),
        z: fraction(prop.z, `layout.props[${index}].z`),
        rotation: rotation(prop.rotation, `layout.props[${index}].rotation`),
      });
    });
  }
  return { zones, props };
}

/** True when a layout says nothing: the theme's own arrangement stands. */
export function isEmptyOfficeLayout(layout) {
  const normalized = normalizeOfficeLayout(layout);
  return (
    Object.keys(normalized.zones).length === 0 && normalized.props.length === 0
  );
}

/**
 * What changes when `next` is applied over `current`, for the preset preview:
 * [{ key, from, to }], counting rooms moved or renamed and furniture placed.
 */
export function officeLayoutChanges(current, next) {
  const before = normalizeOfficeLayout(current);
  const after = normalizeOfficeLayout(next);
  const changes = [];
  const refunctioned = OFFICE_ZONE_IDS.filter(
    (id) => (before.zones[id]?.does ?? id) !== (after.zones[id]?.does ?? id),
  );
  const moved = OFFICE_ZONE_IDS.filter((id) => {
    const a = before.zones[id];
    const b = after.zones[id];
    if (!a && !b) return false;
    return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
  });
  if (moved.length)
    changes.push({
      key: "layout.rooms",
      from: `${Object.keys(before.zones).length} arranged`,
      to: `${Object.keys(after.zones).length} arranged (${moved.join(", ")})`,
    });
  if (refunctioned.length)
    changes.push({
      key: "layout.functions",
      from: refunctioned
        .map((id) => `${id}: ${before.zones[id]?.does ?? id}`)
        .join(", "),
      to: refunctioned
        .map((id) => `${id}: ${after.zones[id]?.does ?? id}`)
        .join(", "),
    });
  if (JSON.stringify(before.props) !== JSON.stringify(after.props))
    changes.push({
      key: "layout.furniture",
      from: `${before.props.length} pieces`,
      to: `${after.props.length} pieces`,
    });
  return changes;
}
