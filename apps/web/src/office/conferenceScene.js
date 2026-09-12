// The conference wing in three.js: each room's floor, glass walls and door,
// a round table under a pendant lamp, a chair and a laptop at every seat,
// plants, and a wall board that says who is meeting and how their work
// stands. Geometry and seats come from office/conference.js; everything
// written on the board comes from records (see Office.jsx).
import * as THREE from "three";
import { builders, textTexture } from "./scene.js";
import { themeMaterials } from "./themes.js";
import { laptopSpot } from "./conference.js";

/** Lid angles: open leans back a little, closed lies flat over the keys. */
const LID_OPEN = -0.28;
const LID_CLOSED = Math.PI / 2;

/**
 * Builds every room into `group`. `rooms` are conferenceLayout() entries,
 * each with `title` and `color` added. `lids` (Map "key:seat" -> angle, from
 * a previous build's lids()) keeps laptops as they were across a rebuild.
 * Returns handles the scene animates: { rooms: Map key -> { laptops: [..],
 * board, lamp, room }, updateBoard, animate, lids, dispose }.
 */
export function buildConferenceRooms(group, rooms, theme, res, { lids } = {}) {
  const { box, cylinder, sphere, plane } = builders(res);
  const p = theme.palette;
  const mat = themeMaterials(theme, res);
  const glass = res.material("#cfe4ee", {
    transparent: true,
    opacity: 0.26,
    roughness: 0.1,
    metalness: 0.2,
    depthWrite: false,
  });
  const frame = res.material(p.metal, { metalness: 0.5, roughness: 0.4 });
  const carpet = res.material(p.mat, { roughness: 0.95 });
  const tableTop = res.material(p.wood, { roughness: 0.55 });
  const tableEdge = res.material("#8e6f4f", { roughness: 0.6 });
  const chairSeat = res.material(p.dark, { roughness: 0.7 });
  const laptopBody = res.material("#3a4654", {
    metalness: 0.45,
    roughness: 0.35,
  });
  const lampShade = res.material("#2f3b48", { metalness: 0.4, roughness: 0.5 });
  const lampGlow = res.material("#fff1d6", {
    emissive: "#ffe6b5",
    emissiveIntensity: 1.1,
  });
  const lightPool = res.material("#ffe9c2", {
    emissive: "#ffe0a8",
    emissiveIntensity: 0.5,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
  });
  const pot = res.material("#c7b299", { roughness: 0.8 });
  const handles = new Map();

  for (const room of rooms) {
    const roomGroup = new THREE.Group();
    const { minX, maxX, minZ, maxZ } = room.bounds;
    const side = room.side;
    const cx = room.x;
    const cz = room.z;
    // Floor: the same slab as the office, a softer surface, a round rug.
    box(side + 0.3, 0.26, side + 0.3, mat.base, cx, -0.17, cz, roomGroup);
    box(side, 0.08, side, carpet, cx, 0.005, cz, roomGroup);
    const tint = res.material(room.color ?? p.accent, {
      roughness: 0.95,
      emissive: room.color ?? p.accent,
      emissiveIntensity: 0.05,
    });
    cylinder(
      room.chairRadius + 0.45,
      room.chairRadius + 0.45,
      0.012,
      tint,
      cx,
      0.052,
      cz,
      roomGroup,
      48,
    );
    // The back wall carries the team board; the door side is glass with an
    // opening; the two sides the camera looks through are low glass rails.
    box(side + 0.14, 2.7, 0.14, mat.wall, cx, 1.35, minZ - 0.07, roomGroup);
    box(side + 0.2, 0.1, 0.22, mat.base, cx, 2.72, minZ - 0.07, roomGroup);
    const doorHalf = 0.62;
    const panel = (length, z0) => {
      if (length <= 0.05) return;
      plane(
        length,
        2.3,
        glass,
        minX,
        1.17,
        z0 + length / 2,
        roomGroup,
      ).rotation.y = Math.PI / 2;
    };
    panel(cz - doorHalf - minZ, minZ);
    panel(maxZ - (cz + doorHalf), cz + doorHalf);
    for (const z of [minZ, cz - doorHalf, cz + doorHalf, maxZ])
      box(0.07, 2.35, 0.07, frame, minX, 1.17, z, roomGroup);
    // The beam along the top of the glass, over the door.
    box(0.07, 0.08, side, frame, minX, 2.36, cz, roomGroup);
    const rail = (length, x, z, alongX) => {
      const pane = plane(length, 0.86, glass, x, 0.47, z, roomGroup);
      if (!alongX) pane.rotation.y = Math.PI / 2;
      box(
        alongX ? length : 0.06,
        0.05,
        alongX ? 0.06 : length,
        frame,
        x,
        0.92,
        z,
        roomGroup,
      );
    };
    rail(side, cx, maxZ, true);
    rail(side, maxX, cz, false);
    for (const [x, z] of [
      [maxX, minZ],
      [maxX, maxZ],
      [minX, maxZ],
    ])
      box(0.07, 0.95, 0.07, frame, x, 0.47, z, roomGroup);

    // The table: a wooden top with a darker edge on a single pedestal.
    const top = room.tableRadius;
    cylinder(top, top, 0.06, tableTop, cx, 0.76, cz, roomGroup, 56);
    cylinder(
      top + 0.02,
      top + 0.02,
      0.03,
      tableEdge,
      cx,
      0.72,
      cz,
      roomGroup,
      56,
    );
    cylinder(0.14, 0.2, 0.7, frame, cx, 0.37, cz, roomGroup, 16);
    cylinder(0.5, 0.56, 0.05, frame, cx, 0.03, cz, roomGroup, 24);
    // A carafe, two glasses and a small plant in the middle.
    cylinder(0.07, 0.08, 0.2, glass, cx + 0.12, 0.89, cz - 0.08, roomGroup, 12);
    cylinder(
      0.035,
      0.03,
      0.09,
      glass,
      cx - 0.1,
      0.835,
      cz + 0.12,
      roomGroup,
      10,
    );
    cylinder(
      0.035,
      0.03,
      0.09,
      glass,
      cx + 0.2,
      0.835,
      cz + 0.16,
      roomGroup,
      10,
    );
    cylinder(0.08, 0.065, 0.1, pot, cx - 0.12, 0.84, cz - 0.12, roomGroup, 12);
    for (let i = 0; i < 3; i++)
      sphere(
        0.07,
        mat.green,
        cx - 0.12 + (i - 1) * 0.04,
        0.93 + (i % 2) * 0.03,
        cz - 0.12,
        roomGroup,
      );
    // The pendant lamp and the warm pool it throws on the table.
    cylinder(0.008, 0.008, 0.5, frame, cx, 2.55, cz, roomGroup, 6);
    const shade = cylinder(
      0.12,
      0.46,
      0.2,
      lampShade,
      cx,
      2.22,
      cz,
      roomGroup,
      32,
    );
    const bulb = cylinder(
      0.42,
      0.42,
      0.015,
      lampGlow,
      cx,
      2.115,
      cz,
      roomGroup,
      32,
    );
    const pool = cylinder(
      top * 0.9,
      top * 0.9,
      0.004,
      lightPool,
      cx,
      0.795,
      cz,
      roomGroup,
      48,
    );

    // A chair and a laptop at every seat.
    const laptops = [];
    for (const seat of room.seats) {
      const chair = new THREE.Group();
      chair.position.set(seat.x, 0, seat.z);
      chair.rotation.y = seat.facing;
      box(0.46, 0.07, 0.44, chairSeat, 0, 0.44, 0.02, chair);
      box(0.46, 0.5, 0.06, chairSeat, 0, 0.72, 0.24, chair);
      cylinder(0.035, 0.035, 0.36, frame, 0, 0.23, 0.02, chair, 8);
      cylinder(0.24, 0.27, 0.035, frame, 0, 0.04, 0.02, chair, 12);
      roomGroup.add(chair);

      const spot = laptopSpot(room, seat);
      const laptop = new THREE.Group();
      laptop.position.set(spot.x, 0.795, spot.z);
      laptop.rotation.y = spot.facing;
      box(0.36, 0.018, 0.25, laptopBody, 0, 0.009, 0, laptop);
      const hinge = new THREE.Group();
      hinge.position.set(0, 0.018, -0.125);
      laptop.add(hinge);
      box(0.36, 0.24, 0.012, laptopBody, 0, 0.12, 0, hinge);
      const screenMaterial = res.track(
        new THREE.MeshStandardMaterial({
          color: "#1d2733",
          emissive: new THREE.Color("#4f7ed8"),
          emissiveIntensity: 0.1,
          roughness: 0.4,
        }),
      );
      const screen = new THREE.Mesh(res.plane(0.32, 0.2), screenMaterial);
      screen.position.set(0, 0.125, 0.007);
      hinge.add(screen);
      // A lit line that runs down the screen while its owner types.
      const line = new THREE.Mesh(
        res.box(0.2, 0.012, 0.004),
        res.material("#e8f1fb", {
          emissive: "#e8f1fb",
          emissiveIntensity: 0.8,
        }),
      );
      line.position.set(-0.03, 0.18, 0.01);
      line.visible = false;
      hinge.add(line);
      const angle = lids?.get(`${room.key}:${seat.index}`) ?? LID_CLOSED;
      hinge.rotation.x = angle;
      // An empty chair has no laptop in front of it.
      laptop.visible = angle < LID_CLOSED - 0.02;
      roomGroup.add(laptop);
      laptops.push({
        seatIndex: seat.index,
        group: laptop,
        hinge,
        screen: screenMaterial,
        line,
        angle,
      });
    }

    // Two plants in the far corners.
    for (const [x, z] of [
      [maxX - 0.45, minZ + 0.45],
      [maxX - 0.45, maxZ - 0.45],
    ]) {
      cylinder(0.2, 0.16, 0.34, pot, x, 0.17, z, roomGroup, 12);
      for (let i = 0; i < 4; i++)
        sphere(
          0.18,
          mat.green,
          x + Math.cos(i * 1.6) * 0.09,
          0.48 + (i % 2) * 0.12,
          z + Math.sin(i * 1.6) * 0.09,
          roomGroup,
        );
    }

    // The team board on the back wall.
    const boardMaterial = res.track(
      new THREE.MeshBasicMaterial({ color: "#ffffff" }),
    );
    const board = new THREE.Mesh(res.plane(2.1, 1.05), boardMaterial);
    // In front of its frame (which stands proud of the wall by 15 mm).
    board.position.set(cx, 1.72, minZ + 0.03);
    roomGroup.add(board);
    box(2.2, 1.15, 0.04, mat.dark, cx, 1.72, minZ - 0.005, roomGroup);

    roomGroup.traverse((object) => {
      if (object.isMesh) object.userData.roomKey = room.key;
    });
    group.add(roomGroup);
    handles.set(room.key, {
      room,
      group: roomGroup,
      laptops,
      board: { mesh: board, material: boardMaterial, texture: null, key: "" },
      lamp: { shade, bulb, pool },
    });
  }

  return {
    rooms: handles,
    /** Writes a room's board: [title, line, line]. Redraws only on change. */
    updateBoard(key, lines, { bg = "#f7f9fb", fg = "#24374b" } = {}) {
      const handle = handles.get(key);
      if (!handle) return;
      const text = lines.join("|");
      if (text === handle.board.key) return;
      handle.board.key = text;
      const texture = textTexture(res, {
        lines,
        bg,
        fg,
        w: 512,
        h: 256,
        bold: "bold 34px sans-serif",
        mono: "22px sans-serif",
      });
      if (handle.board.texture) res.release(handle.board.texture);
      handle.board.texture = texture;
      handle.board.material.map = texture;
      handle.board.material.needsUpdate = true;
    },
    /**
     * Per frame: lids open for a seated owner and close for an empty seat;
     * the screen glows in the owner's activity colour, and a line runs down
     * it while they type. `occupants` maps "key:seat" -> { seated, color,
     * typing, attention }.
     */
    animate(occupants, time, dt, reducedMotion) {
      for (const [key, handle] of handles) {
        for (const laptop of handle.laptops) {
          const who = occupants.get(`${key}:${laptop.seatIndex}`);
          const target = who?.seated ? LID_OPEN : LID_CLOSED;
          const k = reducedMotion ? 1 : Math.min(1, dt * 4);
          laptop.angle += (target - laptop.angle) * k;
          if (Math.abs(target - laptop.angle) < 0.004) laptop.angle = target;
          laptop.hinge.rotation.x = laptop.angle;
          // Out when its owner sits down, put away once shut behind them.
          laptop.group.visible =
            Boolean(who?.seated) || laptop.angle < LID_CLOSED - 0.02;
          const open = who?.seated && laptop.angle < 0.2;
          if (who?.color) laptop.screen.emissive.set(who.color);
          let glow = 0.06;
          if (open) {
            glow = 0.55;
            if (who.typing && !reducedMotion)
              glow = 0.5 + Math.sin(time * 0.02 + laptop.seatIndex) * 0.08;
            if (who.attention && !reducedMotion)
              glow = 0.45 + Math.max(0, Math.sin(time * 0.006)) * 0.4;
          }
          laptop.screen.emissiveIntensity = glow;
          laptop.line.visible = Boolean(open && who.typing);
          if (laptop.line.visible)
            laptop.line.position.y = reducedMotion
              ? 0.14
              : 0.2 - ((time * 0.00045 + laptop.seatIndex * 0.13) % 1) * 0.15;
        }
      }
    },
    /** Every laptop's lid angle, for the next build to start from. */
    lids() {
      const out = new Map();
      for (const [key, handle] of handles)
        for (const laptop of handle.laptops)
          out.set(`${key}:${laptop.seatIndex}`, laptop.angle);
      return out;
    },
    dispose() {
      for (const handle of handles.values()) {
        if (handle.board.texture) res.release(handle.board.texture);
        group.remove(handle.group);
      }
      handles.clear();
    },
  };
}
