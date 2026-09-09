// Small 2D overview of the office: zones and agent dots. Click selects the
// nearest agent, hover reports it.
const PAD = 6;

export function createMinimap(canvas, { onSelect, onHover }) {
  let layout = null;
  let dots = [];
  let hovered = null;
  const ctx = canvas.getContext("2d");

  function toMap(x, z) {
    const w = canvas.width - PAD * 2;
    const h = canvas.height - PAD * 2;
    return [
      PAD + ((x + layout.width / 2) / layout.width) * w,
      PAD + ((z + layout.depth / 2) / layout.depth) * h,
    ];
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

  const click = (event) => {
    const id = nearest(event);
    if (id != null) onSelect?.(id);
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
    setLayout(next) {
      layout = next;
    },
    draw({ figures, selected, theme, clusterCount, clusterZone }) {
      if (!ctx || !layout) return;
      const p = theme.palette;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = p.minimapFloor;
      ctx.fillRect(PAD, PAD, canvas.width - PAD * 2, canvas.height - PAD * 2);
      ctx.strokeStyle = p.minimapZone;
      ctx.strokeRect(
        PAD + 0.5,
        PAD + 0.5,
        canvas.width - PAD * 2 - 1,
        canvas.height - PAD * 2 - 1,
      );
      ctx.font = "7px sans-serif";
      ctx.textBaseline = "top";
      for (const zone of Object.values(layout.zones)) {
        const [x, y] = toMap(zone.x - zone.w / 2, zone.z - zone.d / 2);
        const [x2, y2] = toMap(zone.x + zone.w / 2, zone.z + zone.d / 2);
        ctx.fillStyle = p.minimapZone;
        ctx.fillRect(x, y, x2 - x, y2 - y);
        ctx.fillStyle = p.minimapText;
        ctx.fillText(
          String(theme.rooms[zone.id] ?? zone.id).slice(0, 10),
          x + 2,
          y + 2,
        );
      }
      dots = [];
      for (const f of figures) {
        if (f.clustered) continue;
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
      if (clusterCount > 0 && clusterZone) {
        const [x, y] = toMap(clusterZone.x, clusterZone.z + 0.3);
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fillStyle = p.minimapText;
        ctx.fill();
        ctx.fillStyle = p.minimapFloor;
        ctx.font = "bold 7px sans-serif";
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";
        ctx.fillText(String(clusterCount), x, y);
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
      }
    },
    dispose() {
      canvas.removeEventListener("click", click);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerleave", leave);
    },
  };
}
