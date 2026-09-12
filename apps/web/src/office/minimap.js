// Small 2D overview of the office: zones, conference rooms and agent dots.
// Click selects the nearest agent (or focuses a room), hover reports it.
const PAD = 6;

export function createMinimap(
  canvas,
  { onSelect, onHover, onSelectRoom, onSelectConference },
) {
  let layout = null;
  // The conference wing (office/conference.js) and the area the map shows:
  // the floor alone, or the floor and the wing beside it.
  let rooms = [];
  let bounds = null;
  let dots = [];
  let hovered = null;
  const ctx = canvas.getContext("2d");

  function toMap(x, z) {
    const w = canvas.width - PAD * 2;
    const h = canvas.height - PAD * 2;
    const b = bounds ?? {
      minX: -layout.width / 2,
      maxX: layout.width / 2,
      minZ: -layout.depth / 2,
      maxZ: layout.depth / 2,
    };
    return [
      PAD + ((x - b.minX) / (b.maxX - b.minX || 1)) * w,
      PAD + ((z - b.minZ) / (b.maxZ - b.minZ || 1)) * h,
    ];
  }

  /** Conference room under the pointer. */
  function conferenceAt(sx, sy) {
    for (const room of rooms) {
      const [x, y] = toMap(room.bounds.minX, room.bounds.minZ);
      const [x2, y2] = toMap(room.bounds.maxX, room.bounds.maxZ);
      if (sx >= x && sx <= x2 && sy >= y && sy <= y2) return room.key;
    }
    return null;
  }

  function nearest(event) {
    const r = canvas.getBoundingClientRect();
    const sx = ((event.clientX - r.left) / r.width) * canvas.width;
    const sy = ((event.clientY - r.top) / r.height) * canvas.height;
    let best = null;
    let bestD = 100;
    for (const d of dots) {
      const dist = (d.x - sx) ** 2 + (d.y - sy) ** 2;
      if (dist < bestD) {
        bestD = dist;
        best = d.id;
      }
    }
    return best;
  }

  /** Zone under the pointer, for selectable rooms. */
  function zoneAt(event) {
    if (!layout) return null;
    const r = canvas.getBoundingClientRect();
    const sx = ((event.clientX - r.left) / r.width) * canvas.width;
    const sy = ((event.clientY - r.top) / r.height) * canvas.height;
    const conference = conferenceAt(sx, sy);
    if (conference) return { conference };
    for (const zone of Object.values(layout.zones)) {
      const [x, y] = toMap(zone.x - zone.w / 2, zone.z - zone.d / 2);
      const [x2, y2] = toMap(zone.x + zone.w / 2, zone.z + zone.d / 2);
      if (sx >= x && sx <= x2 && sy >= y && sy <= y2) return zone.id;
    }
    return null;
  }

  const click = (event) => {
    const id = nearest(event);
    if (id != null) {
      onSelect?.(id);
      return;
    }
    const zone = zoneAt(event);
    if (zone?.conference) onSelectConference?.(zone.conference);
    else if (zone) onSelectRoom?.(zone);
  };
  const move = (event) => {
    const id = nearest(event);
    if (id !== hovered) {
      hovered = id;
      onHover?.(id);
    }
    canvas.style.cursor = id != null ? "pointer" : "default";
  };
  const leave = () => {
    if (hovered !== null) {
      hovered = null;
      onHover?.(null);
    }
  };
  canvas.addEventListener("click", click);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerleave", leave);

  return {
    setLayout(next, wing = null) {
      layout = next;
      rooms = wing?.rooms ?? [];
      bounds = rooms.length ? (wing?.bounds ?? null) : null;
    },
    draw({ figures, selected, theme, selectedRoom }) {
      if (!ctx || !layout) return;
      const p = theme.palette;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const [fx, fy] = toMap(-layout.width / 2, -layout.depth / 2);
      const [fx2, fy2] = toMap(layout.width / 2, layout.depth / 2);
      ctx.fillStyle = p.minimapFloor;
      ctx.fillRect(fx, fy, fx2 - fx, fy2 - fy);
      ctx.strokeStyle = p.minimapZone;
      ctx.lineWidth = 1;
      ctx.strokeRect(fx + 0.5, fy + 0.5, fx2 - fx - 1, fy2 - fy - 1);
      // Each conference room: its floor, edged in the team's colour.
      for (const room of rooms) {
        const [x, y] = toMap(room.bounds.minX, room.bounds.minZ);
        const [x2, y2] = toMap(room.bounds.maxX, room.bounds.maxZ);
        ctx.fillStyle = p.minimapFloor;
        ctx.fillRect(x, y, x2 - x, y2 - y);
        ctx.strokeStyle = room.color ?? p.minimapText;
        ctx.lineWidth = 1.4;
        ctx.strokeRect(x + 0.5, y + 0.5, x2 - x - 1, y2 - y - 1);
        const [cx, cy] = toMap(room.x, room.z);
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(2, ((x2 - x) * room.tableRadius) / room.side), 0, Math.PI * 2);
        ctx.fillStyle = p.minimapZone;
        ctx.fill();
      }
      ctx.lineWidth = 1;
      ctx.font = "7px sans-serif";
      ctx.textBaseline = "top";
      for (const zone of Object.values(layout.zones)) {
        const [x, y] = toMap(zone.x - zone.w / 2, zone.z - zone.d / 2);
        const [x2, y2] = toMap(zone.x + zone.w / 2, zone.z + zone.d / 2);
        ctx.fillStyle = p.minimapZone;
        ctx.fillRect(x, y, x2 - x, y2 - y);
        if (selectedRoom && zone.id === selectedRoom) {
          ctx.strokeStyle = p.minimapText;
          ctx.lineWidth = 1.4;
          ctx.strokeRect(x + 0.5, y + 0.5, x2 - x - 1, y2 - y - 1);
        }
        ctx.fillStyle = p.minimapText;
        ctx.fillText(
          String(theme.rooms[zone.id] ?? zone.id).slice(0, 10),
          x + 2,
          y + 2,
        );
      }
      dots = [];
      for (const f of figures) {
        const [x, y] = toMap(f.pos.x, f.pos.z);
        dots.push({ id: f.id, x, y });
        ctx.beginPath();
        ctx.arc(x, y, f.id === selected ? 4 : 3, 0, Math.PI * 2);
        ctx.fillStyle = f.color;
        ctx.fill();
        if (f.id === selected || f.id === hovered) {
          ctx.strokeStyle = p.minimapText;
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
      }
    },
    dispose() {
      canvas.removeEventListener("click", click);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerleave", leave);
    },
  };
}
