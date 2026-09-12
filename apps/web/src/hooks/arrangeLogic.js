// Arranging the office: the rules behind the plan view. Everything here is
// arithmetic on the layout document (core/visual/OfficeLayout.js), in
// fractions of the floor (-1 .. 1), so node:test covers it without a browser
// or a scene. Nothing here reads an agent, a task or a run.

/** How far one arrow key moves a room or a piece, and how far with Shift. */
export const ARRANGE_STEP = 0.02;
export const ARRANGE_COARSE = 0.08;
/** How far one turn key turns a piece. */
export const ARRANGE_TURN = Math.PI / 8;

const clamp = (value) => Math.max(-1, Math.min(1, Math.round(value * 1000) / 1000));

/**
 * The draft an editor works on: every room (whether the workspace has moved
 * it or not) and every piece. `defaults` is where the theme puts each room,
 * in fractions, so a room nobody moved starts where it stands today.
 */
export function draftFromLayout(layout = null, defaults = {}) {
  const zones = {};
  for (const [id, spot] of Object.entries(defaults)) {
    const placed = layout?.zones?.[id] ?? null;
    zones[id] = {
      x: clamp(placed?.x ?? spot.x ?? 0),
      z: clamp(placed?.z ?? spot.z ?? 0),
      label: placed?.label ?? "",
      // What happens in this room: its own function unless it was changed.
      does: placed?.does ?? id,
      moved: Boolean(placed),
    };
  }
  const props = (layout?.props ?? []).map((prop) => ({
    kind: prop.kind,
    x: clamp(prop.x),
    z: clamp(prop.z),
    rotation: Number(prop.rotation) || 0,
  }));
  return { zones, props };
}

/** The layout document for a draft: only what differs from the theme. */
export function layoutFromDraft(draft, defaults = {}) {
  const zones = {};
  for (const [id, zone] of Object.entries(draft.zones ?? {})) {
    const spot = defaults[id] ?? { x: 0, z: 0 };
    const moved =
      Math.abs(zone.x - (spot.x ?? 0)) > 0.0005 ||
      Math.abs(zone.z - (spot.z ?? 0)) > 0.0005;
    const label = (zone.label ?? "").trim();
    const does = zone.does ?? id;
    if (!moved && !label && does === id) continue;
    zones[id] = { x: clamp(zone.x), z: clamp(zone.z) };
    if (label) zones[id].label = label;
    if (does !== id) zones[id].does = does;
  }
  return {
    zones,
    props: (draft.props ?? []).map((prop) => ({
      kind: prop.kind,
      x: clamp(prop.x),
      z: clamp(prop.z),
      rotation: Math.round((Number(prop.rotation) || 0) * 1000) / 1000,
    })),
  };
}

/** A selection is a room ("zone:qa") or a piece ("prop:3"), or null. */
export function selectionOf(kind, id) {
  return `${kind}:${id}`;
}

function withZone(draft, id, change) {
  const zone = draft.zones[id];
  if (!zone) return draft;
  return {
    ...draft,
    zones: { ...draft.zones, [id]: { ...zone, ...change } },
  };
}

function withProp(draft, index, change) {
  const prop = draft.props[index];
  if (!prop) return draft;
  const props = [...draft.props];
  props[index] = { ...prop, ...change };
  return { ...draft, props };
}

/** Moves what is selected by (dx, dz), inside the floor. */
export function moveSelection(draft, selection, dx, dz) {
  if (!selection) return draft;
  const [kind, key] = selection.split(":");
  if (kind === "zone") {
    const zone = draft.zones[key];
    if (!zone) return draft;
    return withZone(draft, key, {
      x: clamp(zone.x + dx),
      z: clamp(zone.z + dz),
      moved: true,
    });
  }
  const index = Number(key);
  const prop = draft.props[index];
  if (!prop) return draft;
  return withProp(draft, index, {
    x: clamp(prop.x + dx),
    z: clamp(prop.z + dz),
  });
}

/** Puts what is selected at (x, z) — a drag, in fractions. */
export function placeSelection(draft, selection, x, z) {
  if (!selection) return draft;
  const [kind, key] = selection.split(":");
  if (kind === "zone")
    return withZone(draft, key, { x: clamp(x), z: clamp(z), moved: true });
  return withProp(draft, Number(key), { x: clamp(x), z: clamp(z) });
}

/** Turns a selected piece; rooms do not turn. */
export function turnSelection(draft, selection, delta = ARRANGE_TURN) {
  if (!selection?.startsWith("prop:")) return draft;
  const index = Number(selection.split(":")[1]);
  const prop = draft.props[index];
  if (!prop) return draft;
  const turn = Math.PI * 2;
  const next = ((((prop.rotation ?? 0) + delta) % turn) + turn) % turn;
  return withProp(draft, index, { rotation: Math.round(next * 1000) / 1000 });
}

/**
 * Gives a selected room another function. One function belongs to one room,
 * so the room that had it takes this room's function in exchange.
 */
export function setFunction(draft, selection, does) {
  if (!selection?.startsWith("zone:")) return draft;
  const id = selection.split(":")[1];
  const zone = draft.zones[id];
  if (!zone) return draft;
  const previous = zone.does ?? id;
  if (previous === does) return draft;
  const zones = { ...draft.zones };
  if (does !== "none")
    for (const [other, room] of Object.entries(zones)) {
      if (other === id) continue;
      if ((room.does ?? other) === does)
        zones[other] = { ...room, does: previous };
    }
  zones[id] = { ...zone, does };
  return { ...draft, zones };
}

/** Renames a selected room. An empty name gives it the theme's name back. */
export function renameSelection(draft, selection, label) {
  if (!selection?.startsWith("zone:")) return draft;
  return withZone(draft, selection.split(":")[1], { label });
}

/**
 * Adds a piece near the middle of the free floor, offset so a second piece
 * of the same kind does not land on the first. Returns the draft and what
 * is now selected.
 */
export function addProp(draft, kind, { max = 24 } = {}) {
  const props = draft.props ?? [];
  if (props.length >= max) return { draft, selection: null, full: true };
  const step = props.length;
  const next = {
    kind,
    x: clamp(-0.3 + (step % 5) * 0.15),
    z: clamp(0.55 + Math.floor(step / 5) * 0.12),
    rotation: 0,
  };
  return {
    draft: { ...draft, props: [...props, next] },
    selection: selectionOf("prop", props.length),
    full: false,
  };
}

/** Removes a selected piece; the selection moves to the one before it. */
export function removeProp(draft, selection) {
  if (!selection?.startsWith("prop:")) return { draft, selection };
  const index = Number(selection.split(":")[1]);
  if (!draft.props[index]) return { draft, selection };
  const props = draft.props.filter((_, i) => i !== index);
  const next = props.length
    ? selectionOf("prop", Math.max(0, index - 1))
    : null;
  return { draft: { ...draft, props }, selection: next };
}

/** Puts every room back where the theme has it, and clears the furniture. */
export function resetDraft(defaults = {}) {
  return draftFromLayout(null, defaults);
}

/** True when a draft says nothing the theme does not already say. */
export function isDraftEmpty(draft, defaults = {}) {
  const layout = layoutFromDraft(draft, defaults);
  return Object.keys(layout.zones).length === 0 && layout.props.length === 0;
}

/** What the editor says out loud after a change. */
export function describeSelection(draft, selection, names = {}) {
  if (!selection) return "Nothing selected";
  const [kind, key] = selection.split(":");
  if (kind === "zone") {
    const zone = draft.zones[key];
    if (!zone) return "Nothing selected";
    const does = zone.does ?? key;
    const name =
      (zone.label ?? "").trim() ||
      (does === "none" ? "Open space" : (names[does] ?? does));
    const serves = does === "none" ? "nothing in particular" : (names[does] ?? does);
    return `${name} at ${zone.x.toFixed(2)}, ${zone.z.toFixed(2)}, for ${serves}`;
  }
  const prop = draft.props[Number(key)];
  if (!prop) return "Nothing selected";
  const turn = Math.round(((prop.rotation ?? 0) * 180) / Math.PI);
  return `${prop.kind} at ${prop.x.toFixed(2)}, ${prop.z.toFixed(2)}, turned ${turn} degrees`;
}
