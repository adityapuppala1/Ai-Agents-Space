import React, { useMemo, useRef, useState } from "react";
import { Plus, RotateCw, Trash2, Undo2 } from "lucide-react";
import Dialog from "./Dialog.jsx";
import {
  ARRANGE_COARSE,
  ARRANGE_STEP,
  ARRANGE_TURN,
  addProp,
  describeSelection,
  draftFromLayout,
  isDraftEmpty,
  layoutFromDraft,
  moveSelection,
  placeSelection,
  removeProp,
  renameSelection,
  setFunction,
  resetDraft,
  selectionOf,
  turnSelection,
} from "../hooks/arrangeLogic.js";
import { OFFICE_PROP_KINDS, MAX_OFFICE_PROPS } from "../office/propKinds.js";

/** The plan is this wide; its height follows the floor's own proportions. */
const PLAN = 200;
/** Margin around the floor, so a tile at the wall is still drawn whole. */
const INSET_X = 22;
const INSET_Y = 10;
const SPAN_X = PLAN - INSET_X * 2;

/** Fraction (-1 .. 1) to plan coordinates, across and down. */
const toPlan = (value) => INSET_X + ((value + 1) / 2) * SPAN_X;
const toPlanZ = (value, height) =>
  INSET_Y + ((value + 1) / 2) * (height - INSET_Y * 2);
/** A share of the drawn box (0 .. 1) back to a fraction of the floor. */
const toFraction = (share, size, inset) =>
  ((share * size - inset) / (size - inset * 2)) * 2 - 1;

/**
 * Arranging the office: a plan view of the floor where the shared rooms and
 * the furniture can be moved, turned, renamed and removed, by pointer or by
 * keyboard. It edits a draft; nothing changes in the office until Save, and
 * the result is the portable layout in the workspace's visual preset.
 *
 * The desks are drawn but never moved: they follow the team, one per agent
 * with recorded work, and the office arranges them itself.
 */
export default function OfficeArranger({
  layout = null,
  defaults = {},
  deskArea = null,
  functionNames = {},
  aspect = 1.35,
  busy = false,
  onSave,
  onClose,
}) {
  const [draft, setDraft] = useState(() => draftFromLayout(layout, defaults));
  const [selection, setSelection] = useState(null);
  const [message, setMessage] = useState("");
  const [kind, setKind] = useState("plant");
  const planHeight = INSET_Y * 2 + SPAN_X / (aspect || 1.35);
  const planRef = useRef(null);
  const dragging = useRef(null);

  const say = (draftNow, next) =>
    setMessage(describeSelection(draftNow, next ?? selection, functionNames));

  const change = (next, selected = selection) => {
    setDraft(next);
    say(next, selected);
  };

  const move = (dx, dz) => {
    if (!selection) return;
    change(moveSelection(draft, selection, dx, dz));
  };

  const keydown = (event) => {
    const step = event.shiftKey ? ARRANGE_COARSE : ARRANGE_STEP;
    const keys = {
      ArrowLeft: () => move(-step, 0),
      ArrowRight: () => move(step, 0),
      ArrowUp: () => move(0, -step),
      ArrowDown: () => move(0, step),
      r: () => change(turnSelection(draft, selection, ARRANGE_TURN)),
      R: () => change(turnSelection(draft, selection, -ARRANGE_TURN)),
      Delete: () => remove(),
      Backspace: () => remove(),
    };
    const act = keys[event.key];
    if (!act) return;
    event.preventDefault();
    act();
  };

  const remove = () => {
    const next = removeProp(draft, selection);
    setDraft(next.draft);
    setSelection(next.selection);
    setMessage("Piece removed");
  };

  const add = () => {
    const next = addProp(draft, kind, { max: MAX_OFFICE_PROPS });
    if (next.full) {
      setMessage(`An office holds ${MAX_OFFICE_PROPS} pieces of furniture`);
      return;
    }
    setDraft(next.draft);
    setSelection(next.selection);
    say(next.draft, next.selection);
  };

  /** Pointer drags move whatever was grabbed. */
  const pointerdown = (event, target) => {
    setSelection(target);
    dragging.current = target;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    say(draft, target);
  };
  const pointermove = (event) => {
    if (!dragging.current || !planRef.current) return;
    const box = planRef.current.getBoundingClientRect();
    const x = toFraction(
      (event.clientX - box.left) / box.width,
      PLAN,
      INSET_X,
    );
    const z = toFraction(
      (event.clientY - box.top) / box.height,
      planHeight,
      INSET_Y,
    );
    setDraft((current) => placeSelection(current, dragging.current, x, z));
  };
  const pointerup = () => {
    if (dragging.current) say(draft, dragging.current);
    dragging.current = null;
  };

  const empty = useMemo(() => isDraftEmpty(draft, defaults), [draft, defaults]);
  const rooms = Object.entries(draft.zones ?? {});
  const selectedRoom = selection?.startsWith("zone:")
    ? draft.zones[selection.split(":")[1]]
    : null;
  const selectedProp = selection?.startsWith("prop:")
    ? draft.props[Number(selection.split(":")[1])]
    : null;

  return (
    <Dialog title="Arrange the office" onClose={() => onClose?.()} wide>
      <p className="as-muted as-small arrange-note">
        Move the shared rooms, say what happens in each, name them, and place
        furniture. Desks follow the team and are drawn here only as a guide.
      </p>
        <div className="arrange-body">
          <div className="arrange-plan-wrap">
            <svg
              ref={planRef}
              className="arrange-plan"
              viewBox={`0 0 ${PLAN} ${planHeight}`}
              style={{ aspectRatio: String(aspect) }}
              role="application"
              aria-label="Office plan. Choose a room or a piece, then move it with the arrow keys."
              onKeyDown={keydown}
              onPointerMove={pointermove}
              onPointerUp={pointerup}
              onPointerLeave={pointerup}
            >
              <rect
                className="arrange-floor"
                x={INSET_X}
                y={INSET_Y}
                width={SPAN_X}
                height={planHeight - INSET_Y * 2}
                rx="4"
              />
              {deskArea ? (
                <g aria-hidden="true">
                  <rect
                    className="arrange-desks"
                    x={toPlan(deskArea.minX)}
                    y={toPlanZ(deskArea.minZ, planHeight)}
                    width={toPlan(deskArea.maxX) - toPlan(deskArea.minX)}
                    height={toPlanZ(deskArea.maxZ, planHeight) - toPlanZ(deskArea.minZ, planHeight)}
                    rx="3"
                  />
                  <text
                    className="arrange-desks-label"
                    x={(toPlan(deskArea.minX) + toPlan(deskArea.maxX)) / 2}
                    y={(toPlanZ(deskArea.minZ, planHeight) + toPlanZ(deskArea.maxZ, planHeight)) / 2}
                  >
                    desks
                  </text>
                </g>
              ) : null}
              {(draft.props ?? []).map((prop, index) => {
                const id = selectionOf("prop", index);
                const piece = OFFICE_PROP_KINDS[prop.kind];
                return (
                  <g
                    key={id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selection === id}
                    aria-label={`${piece?.label ?? prop.kind}, ${prop.x.toFixed(2)} across, ${prop.z.toFixed(2)} down`}
                    className={`arrange-prop ${selection === id ? "is-selected" : ""}`}
                    transform={`translate(${toPlan(prop.x)} ${toPlanZ(prop.z, planHeight)})`}
                    onPointerDown={(event) => pointerdown(event, id)}
                    onFocus={() => setSelection(id)}
                  >
                    <circle r="6" />
                    <line
                      x1="0"
                      y1="0"
                      x2={Math.sin(prop.rotation ?? 0) * 8}
                      y2={-Math.cos(prop.rotation ?? 0) * 8}
                    />
                    <text y="2.6">
                      {(piece?.label ?? prop.kind).slice(0, 1).toUpperCase()}
                    </text>
                  </g>
                );
              })}
              {rooms.map(([id, zone]) => {
                const key = selectionOf("zone", id);
                const does = zone.does ?? id;
                const name =
                  (zone.label ?? "").trim() ||
                  (does === "none"
                    ? "Open space"
                    : (functionNames[does] ?? does));
                return (
                  <g
                    key={key}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selection === key}
                    aria-label={`${name} room, for ${
                      does === "none"
                        ? "nothing in particular"
                        : (functionNames[does] ?? does)
                    }, ${zone.x.toFixed(2)} across, ${zone.z.toFixed(2)} down`}
                    className={`arrange-room ${selection === key ? "is-selected" : ""}`}
                    transform={`translate(${toPlan(zone.x)} ${toPlanZ(zone.z, planHeight)})`}
                    onPointerDown={(event) => pointerdown(event, key)}
                    onFocus={() => setSelection(key)}
                  >
                    <rect x="-18" y="-7" width="36" height="14" rx="3" />
                    <text y="2.2">
                      {name.length > 13 ? `${name.slice(0, 12)}…` : name}
                    </text>
                  </g>
                );
              })}
            </svg>
            <p className="as-muted as-small arrange-hint">
              Arrow keys move · Shift for bigger steps · R turns a piece ·
              Delete removes it
            </p>
          </div>
          <div className="arrange-side">
            <div className="arrange-add">
              <label htmlFor="arrange-kind">Furniture</label>
              <select
                id="arrange-kind"
                value={kind}
                onChange={(event) => setKind(event.target.value)}
              >
                {Object.entries(OFFICE_PROP_KINDS).map(([id, piece]) => (
                  <option key={id} value={id}>
                    {piece.label}
                  </option>
                ))}
              </select>
              <button type="button" className="button" onClick={add}>
                <Plus size={14} aria-hidden="true" />
                Place
              </button>
            </div>
            <p className="as-muted as-small">
              {(draft.props ?? []).length} of {MAX_OFFICE_PROPS} pieces placed
            </p>
            <div className="arrange-selected">
              <h3>Selected</h3>
              {selectedRoom ? (
                <>
                  <label htmlFor="arrange-room-does">What happens here</label>
                  <select
                    id="arrange-room-does"
                    value={selectedRoom.does ?? selection.split(":")[1]}
                    onChange={(event) =>
                      change(setFunction(draft, selection, event.target.value))
                    }
                  >
                    {Object.keys(draft.zones ?? {}).map((id) => (
                      <option key={id} value={id}>
                        {functionNames[id] ?? id}
                      </option>
                    ))}
                    <option value="none">Nothing: work stays at the desks</option>
                  </select>
                  <label htmlFor="arrange-room-name">Room name</label>
                  <input
                    id="arrange-room-name"
                    value={selectedRoom.label ?? ""}
                    maxLength={24}
                    placeholder={
                      functionNames[selectedRoom.does ?? ""] ?? "Room name"
                    }
                    onChange={(event) =>
                      setDraft(
                        renameSelection(draft, selection, event.target.value),
                      )
                    }
                  />
                  <p className="as-muted as-small">
                    Empty gives the room the environment's own name back. One
                    kind of work belongs to one room: choosing it here takes it
                    from the room that had it.
                  </p>
                </>
              ) : null}
              {selectedProp ? (
                <div className="arrange-piece-actions">
                  <span>{OFFICE_PROP_KINDS[selectedProp.kind]?.label}</span>
                  <button
                    type="button"
                    className="button"
                    onClick={() =>
                      change(turnSelection(draft, selection, ARRANGE_TURN))
                    }
                  >
                    <RotateCw size={14} aria-hidden="true" />
                    Turn
                  </button>
                  <button type="button" className="button" onClick={remove}>
                    <Trash2 size={14} aria-hidden="true" />
                    Remove
                  </button>
                </div>
              ) : null}
              {!selectedRoom && !selectedProp ? (
                <p className="as-muted as-small">
                  Choose a room or a piece in the plan.
                </p>
              ) : null}
            </div>
            <div className="arrange-actions">
              <button
                type="button"
                className="button"
                disabled={empty}
                onClick={() => {
                  const next = resetDraft(defaults);
                  setDraft(next);
                  setSelection(null);
                  setMessage("The environment's own layout is back");
                }}
              >
                <Undo2 size={14} aria-hidden="true" />
                Reset
              </button>
              <button type="button" className="button" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="button primary"
                disabled={busy}
                onClick={() => onSave?.(layoutFromDraft(draft, defaults))}
              >
                Save the office
              </button>
            </div>
          </div>
        </div>
      <p className="sr-only" role="status" aria-live="polite">
        {message}
      </p>
    </Dialog>
  );
}
