// Zones: where an activity takes place. Layout is computed from the agent
// count (desk grid in front, shared zones along the back wall). Zone
// furniture is rebuilt on theme change; agent figures are not.
import * as THREE from "three";
import { builders, textTexture, swapTexture } from "./scene.js";
import { basename, changedSummary, maskPrivate } from "./data.js";
import { themeMaterials } from "./themes.js";
import { buildDeskField } from "./instancing.js";

/** One honest line about the artifacts on the review table. */
function artifactLine(chips) {
  if (!chips.length) return "no artifacts linked yet";
  if (chips.length === 1) return `1 artifact: ${chips[0].title}`;
  return `${chips.length} artifacts linked`;
}

export const ZONE_IDS = ["research", "qa", "review", "meeting", "breakArea"];

/**
 * What a room is for. A room serves the function it is named after unless the
 * workspace gave it another one (core/visual/OfficeLayout.js); "none" means
 * the office has no room for that work and it happens at the agent's desk.
 */
export const ROOM_FUNCTIONS = [...ZONE_IDS];

/** Activity → room function. Anything not listed keeps the agent at its desk. */
export const ZONE_FOR_ACTIVITY = {
  CODING: "desk",
  COMMANDING: "desk",
  DEBUGGING: "desk",
  RESEARCHING: "research",
  ANALYZING: "research",
  TESTING: "qa",
  REVIEWING: "review",
  DELEGATING: "meeting",
  MESSAGING: "meeting",
  WAITING_APPROVAL: "desk",
  BLOCKED: "desk",
  STALE: "desk",
  ERROR: "desk",
  IDLE: "desk",
};

/**
 * Where an activity takes place: the room serving that function in this
 * layout, or "desk" when the office has no such room. Without a layout each
 * room serves its own function, which is the office's own arrangement.
 */
export function zoneForActivity(activity, layout = null) {
  const wanted = ZONE_FOR_ACTIVITY[activity] ?? "desk";
  if (wanted === "desk") return "desk";
  if (!layout?.functionAt) return wanted;
  return layout.functionAt[wanted] ?? "desk";
}

/** The room serving `fn` in this layout, or null when none does. */
export function roomFor(layout, fn) {
  const id = layout?.functionAt?.[fn] ?? (layout?.zones?.[fn] ? fn : null);
  return id ? (layout.zones[id] ?? null) : null;
}

const DESK_PITCH_X = 2.3;
const DESK_PITCH_Z = 2.5;
const SHARED_ROW = 3.3; // depth reserved for the shared zone row

/**
 * Computes room size, desk positions and shared zone anchors for `count`
 * agents. Coordinates: x across the room, z toward the viewer; the back
 * wall is at -depth/2.
 */
export const LAYOUT_PROFILES = new Set([
  "studio",
  "command",
  "courtyard",
  "spine",
  "stacks",
  "gallery",
]);

const PROFILE_ANCHORS = {
  command: [
    [-0.72, -0.54],
    [-0.38, -0.7],
    [0, -0.78],
    [0.38, -0.7],
    [0.72, -0.54],
  ],
  courtyard: [
    [-0.75, -0.62],
    [-0.75, -0.18],
    [0, -0.72],
    [0.75, -0.18],
    [0.75, -0.62],
  ],
  spine: [
    [-0.72, -0.68],
    [-0.36, -0.68],
    [0, -0.68],
    [0.36, -0.68],
    [0.72, -0.68],
  ],
  stacks: [
    [-0.76, -0.66],
    [-0.4, -0.66],
    [-0.04, -0.66],
    [0.32, -0.66],
    [0.68, -0.66],
  ],
  gallery: [
    [-0.72, -0.7],
    [-0.36, -0.58],
    [0, -0.46],
    [0.36, -0.58],
    [0.72, -0.7],
  ],
};

export function computeLayout(count, profile = "studio", arranged = null) {
  const n = Math.max(count, 1);
  const cols = Math.min(6, Math.max(3, Math.ceil(Math.sqrt(n))));
  const rows = Math.max(2, Math.ceil(n / cols));
  const width = Math.max(cols * DESK_PITCH_X + 1.6, 14.5);
  const depth = Math.max(SHARED_ROW + rows * DESK_PITCH_Z + 1.4, 10.7);
  const zoneZ = -depth / 2 + 1.7;
  const desks = [];
  const deskAreaW = cols * DESK_PITCH_X;
  for (let i = 0; i < n; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    desks.push({
      x: -deskAreaW / 2 + DESK_PITCH_X / 2 + c * DESK_PITCH_X,
      z: zoneZ + SHARED_ROW - 0.4 + r * DESK_PITCH_Z,
      facing: 0, // yaw 0 = facing -z, i.e. the monitor
    });
  }
  const zones = {};
  ZONE_IDS.forEach((id, i) => {
    // A workspace that arranged its own office (core/visual/OfficeLayout.js)
    // places the room itself; otherwise the theme's layout profile does.
    const placed = arranged?.zones?.[id] ?? null;
    const anchor = PROFILE_ANCHORS[profile]?.[i] ?? null;
    const x = placed
      ? placed.x * (width / 2 - 0.7)
      : anchor
        ? anchor[0] * (width / 2 - 0.7)
        : -width / 2 + (width * (i + 0.5)) / ZONE_IDS.length;
    const centerZ = placed
      ? placed.z * (depth / 2 - 0.6)
      : anchor
        ? anchor[1] * (depth / 2 - 0.6)
        : zoneZ;
    const slots = [];
    for (let s = 0; s < 8; s++) {
      const angle = Math.PI * 0.15 + (Math.PI * 0.7 * s) / 7;
      const sx = x + Math.cos(angle) * 1.15;
      const sz = centerZ + 0.35 + Math.sin(angle) * 0.9;
      // Yaw that points the figure at the zone centre (yaw 0 = facing -z).
      slots.push({
        x: sx,
        z: sz,
        facing: Math.atan2(-(x - sx), -(centerZ - sz)),
      });
    }
    zones[id] = {
      id,
      x,
      z: centerZ,
      w: width / ZONE_IDS.length - 0.3,
      d: SHARED_ROW - 0.6,
      slots,
      // The name this workspace gave the room, if it gave it one, and what
      // it is for: its own function unless the workspace changed it.
      label: placed?.label ?? null,
      placed: Boolean(placed),
      does: placed?.does ?? id,
    };
  });
  // Function → the room serving it. A function no room serves is absent, and
  // the work happens at the agent's desk.
  const functionAt = {};
  for (const id of ZONE_IDS) {
    const does = zones[id].does;
    if (does !== "none" && !functionAt[does]) functionAt[does] = id;
  }
  // Furniture the workspace placed, in world units.
  const props = (arranged?.props ?? []).map((prop, index) => ({
    ...prop,
    index,
    x: prop.x * (width / 2 - 0.6),
    z: prop.z * (depth / 2 - 0.6),
  }));
  return {
    width,
    depth,
    cols,
    rows,
    desks,
    zones,
    functionAt,
    props,
    arranged:
      props.length > 0 ||
      ZONE_IDS.some((id) => zones[id].placed || zones[id].does !== id),
    profile: LAYOUT_PROFILES.has(profile) ? profile : "studio",
    scale: Math.max(width / 14.5, depth / 10.7),
  };
}

/** Room names for a theme, with the names this workspace gave its rooms. */
export function roomNames(theme, layout) {
  const out = { ...(theme?.rooms ?? {}) };
  for (const id of ZONE_IDS) {
    const zone = layout?.zones?.[id] ?? null;
    const does = zone?.does ?? id;
    // A room that took another function is called after that function,
    // unless this workspace gave it a name of its own.
    if (does !== id && does !== "none") out[id] = theme?.rooms?.[does] ?? does;
    if (does === "none") out[id] = "Open space";
    if (zone?.label) out[id] = zone.label;
  }
  return out;
}

/**
 * Builds zone furniture into `group`. Returns handles used to update the
 * monitors and status screens without rebuilding geometry.
 *
 * `options.liveScreens` is the set of agent ids whose desk keeps an individual
 * monitor with its own canvas texture; every other desk shares one instanced
 * dim screen. Omitting it gives every agent a live screen, which is what the
 * scene did before the screen budget existed.
 */
export function buildZones(group, theme, layout, agents, res, options = {}) {
  // Each room is called after the function it serves, under the name this
  // workspace gave it (roomNames); the sign over it says so.
  const names = roomNames(theme, layout);
  const p = theme.palette;
  const mat = themeMaterials(theme, res);
  const { box, cylinder, sphere, plane } = builders(res);
  const screenMaterial = (texture) =>
    res.track(new THREE.MeshBasicMaterial({ map: texture }));

  // Personal desks: 13 repeated shapes per agent, drawn as instanced parts so
  // the draw-object count grows by chunk rather than by agent.
  const desks = buildDeskField(group, {
    layout,
    agents,
    res,
    mat,
    palette: p,
    liveScreens: options.liveScreens ?? null,
    screenMaterial: (agent) => {
      const texture = textTexture(res, {
        lines: [agent.name ?? "", "no file"],
        bg: p.screenBg,
        fg: p.screenFg,
        accent: agent.color,
      });
      return { material: screenMaterial(texture), texture };
    },
  });
  const monitors = desks.monitors;

  // Each function is built in the room that serves it; a function no room
  // serves is not built at all, and its work happens at the desks.
  const z = {};
  for (const fn of ROOM_FUNCTIONS) {
    const id = layout.functionAt?.[fn] ?? (layout.zones[fn] ? fn : null);
    z[fn] = id ? layout.zones[id] : null;
  }
  const label = (zone, text) => {
    const t = textTexture(res, {
      lines: [text],
      bg: p.wall,
      fg: p.sign,
      w: 384,
      h: 96,
      bold: "bold 34px sans-serif",
    });
    if (t)
      plane(
        1.6,
        0.4,
        screenMaterial(t),
        zone.x,
        2.75,
        -layout.depth / 2 - 0.01,
        group,
      );
  };

  // Research desk / library shelf.
  if (z.research) {
    const zone = z.research;
    label(zone, names.research);
    box(2.2, 0.12, 0.9, mat.wood, zone.x, 0.9, zone.z - 0.6, group);
    for (const dx of [-1, 1])
      box(0.06, 0.85, 0.06, mat.base, zone.x + dx, 0.45, zone.z - 0.6, group);
    box(2.4, 1.5, 0.35, mat.wood, zone.x, 0.75, -layout.depth / 2 + 0.3, group);
    const bookColors = ["#849bab", "#d5bca3", "#889c83", "#c88f7a"];
    for (let s = 0; s < 3; s++) {
      box(
        2.45,
        0.05,
        0.4,
        mat.base,
        zone.x,
        0.2 + s * 0.48,
        -layout.depth / 2 + 0.3,
        group,
      );
      for (let b = 0; b < 8; b++)
        box(
          0.18,
          0.3 + (b % 3) * 0.05,
          0.28,
          res.material(bookColors[(b + s) % 4]),
          zone.x - 1.05 + b * 0.3,
          0.4 + s * 0.48,
          -layout.depth / 2 + 0.32,
          group,
        );
    }
    for (let i = 0; i < 3; i++)
      box(
        0.3,
        0.04,
        0.22,
        res.material(bookColors[i]),
        zone.x - 0.5 + i * 0.5,
        0.99,
        zone.z - 0.6,
        group,
      );
  }

  // QA station with status screen.
  const qa = (() => {
    const zone = z.qa;
    if (!zone) return null;
    label(zone, names.qa);
    box(2.0, 0.12, 0.8, mat.metal, zone.x, 0.9, zone.z - 0.6, group);
    for (const dx of [-0.9, 0.9])
      box(0.06, 0.85, 0.06, mat.base, zone.x + dx, 0.45, zone.z - 0.6, group);
    box(
      1.9,
      1.1,
      0.08,
      mat.dark,
      zone.x,
      1.85,
      -layout.depth / 2 + 0.12,
      group,
    );
    const texture = textTexture(res, {
      lines: [names.qa, "idle"],
      bg: p.screenBg,
      fg: p.screenFg,
      w: 384,
      h: 192,
    });
    const screen = plane(
      1.8,
      1.0,
      screenMaterial(texture),
      zone.x,
      1.85,
      -layout.depth / 2 + 0.17,
      group,
    );
    for (let i = 0; i < 3; i++)
      cylinder(
        0.06,
        0.06,
        0.08,
        i === 1 ? mat.green : mat.metal,
        zone.x - 0.5 + i * 0.5,
        1.0,
        zone.z - 0.5,
        group,
      );
    return { screen, texture, key: "" };
  })();

  // Review table with whiteboard.
  const review = (() => {
    const zone = z.review;
    if (!zone) return null;
    label(zone, names.review);
    cylinder(0.9, 0.9, 0.08, mat.wood, zone.x, 0.9, zone.z - 0.2, group, 24);
    cylinder(0.08, 0.14, 0.86, mat.metal, zone.x, 0.45, zone.z - 0.2, group);
    box(2.4, 1.2, 0.08, mat.base, zone.x, 1.9, -layout.depth / 2 + 0.12, group);
    const texture = textTexture(res, {
      lines: [names.review, "nothing under review"],
      bg: "#f7f7f2",
      fg: "#41556a",
      w: 384,
      h: 192,
    });
    const screen = plane(
      2.3,
      1.1,
      screenMaterial(texture),
      zone.x,
      1.9,
      -layout.depth / 2 + 0.17,
      group,
    );
    // Up to three artifact chips lying on the table. Each is a click target
    // that opens the real artifact; they stay hidden when none was recorded.
    const chips = [0, 1, 2].map((i) => {
      const chipTexture = textTexture(res, {
        lines: ["artifact"],
        bg: "#eef2f6",
        fg: "#41556a",
        w: 256,
        h: 96,
        bold: "bold 26px sans-serif",
      });
      const mesh = plane(
        0.66,
        0.26,
        screenMaterial(chipTexture),
        zone.x - 0.66 + i * 0.66,
        0.945,
        zone.z - 0.2,
        group,
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      return { screen: mesh, texture: chipTexture, key: "", artifactId: null };
    });
    return { screen, texture, key: "", chips };
  })();

  // Meeting area: round table, chairs and the task handoff card.
  const handoff = (() => {
    const zone = z.meeting;
    if (!zone) return null;
    label(zone, names.meeting);
    cylinder(1.0, 1.0, 0.08, mat.wood, zone.x, 0.82, zone.z - 0.1, group, 28);
    cylinder(0.1, 0.18, 0.78, mat.metal, zone.x, 0.41, zone.z - 0.1, group);
    for (let i = 0; i < 5; i++) {
      const a = Math.PI * 0.1 + (Math.PI * 0.8 * i) / 4;
      box(
        0.45,
        0.08,
        0.45,
        mat.accent,
        zone.x + Math.cos(a) * 1.35,
        0.5,
        zone.z - 0.1 + Math.sin(a) * 1.35,
        group,
      );
    }
    sphere(0.08, mat.green, zone.x, 0.95, zone.z - 0.1, group);
    const texture = textTexture(res, {
      lines: ["Handoff", "no handoff recorded"],
      bg: "#fdf6e6",
      fg: "#6c5a33",
      w: 384,
      h: 160,
      bold: "bold 30px sans-serif",
      mono: "18px sans-serif",
    });
    const card = plane(
      1.4,
      0.58,
      screenMaterial(texture),
      zone.x,
      1.72,
      zone.z - 0.1,
      group,
    );
    card.visible = false;
    return { screen: card, texture, key: "" };
  })();

  // Break area: sofa, coffee table and the cluster marker.
  const cluster = (() => {
    const zone = z.breakArea;
    if (!zone) return null;
    label(zone, names.breakArea);
    box(
      1.9,
      0.5,
      0.8,
      res.material("#9eaebc"),
      zone.x,
      0.42,
      zone.z - 0.7,
      group,
    );
    box(1.95, 0.75, 0.25, mat.accent, zone.x, 0.78, zone.z - 1.05, group);
    cylinder(0.42, 0.42, 0.08, mat.wood, zone.x, 0.62, zone.z + 0.3, group, 20);
    cylinder(0.06, 0.09, 0.55, mat.metal, zone.x, 0.3, zone.z + 0.3, group);
    const texture = textTexture(res, {
      lines: ["0 available"],
      bg: p.wall,
      fg: p.sign,
      w: 256,
      h: 96,
      bold: "bold 34px sans-serif",
    });
    const marker = plane(
      1.2,
      0.45,
      screenMaterial(texture),
      zone.x,
      2.1,
      zone.z + 0.3,
      group,
    );
    marker.visible = false;
    return { screen: marker, texture, key: "" };
  })();

  return {
    monitors,
    deskField: desks.field,
    qa,
    review,
    handoff,
    cluster,
    theme,
    /** Frees the instance buffers; Resources still owns geometry and materials. */
    dispose() {
      desks.dispose();
    },
    /**
     * Redraws a monitor when its content key changed. `preview` holds already
     * sanitized artifact lines (masked by the caller under presentation mode).
     */
    updateMonitor(
      agentId,
      agent,
      {
        typing = false,
        caret = false,
        activityLabel = "",
        preview = null,
        mask = false,
      } = {},
    ) {
      const m = monitors.get(agentId);
      if (!m) return;
      const rawFile = basename(agent.currentFile);
      const file = mask ? maskPrivate(rawFile) : rawFile;
      const rawAction = agent.currentAction
        ? String(agent.currentAction).slice(0, 40)
        : "";
      const action = mask ? maskPrivate(rawAction) : rawAction;
      const previewLines = Array.isArray(preview) ? preview.slice(0, 3) : [];
      const key = [
        file,
        activityLabel,
        action,
        previewLines.join("/"),
        typing ? (caret ? "c1" : "c0") : "s",
      ].join("|");
      if (key === m.key) return;
      m.key = key;
      const lines = previewLines.length
        ? [file || agent.name || "", ...previewLines]
        : [file || agent.name || "", activityLabel, action];
      swapTexture(res, m, {
        lines,
        bg: p.screenBg,
        fg: p.screenFg,
        accent: agent.color,
        caret: typing && caret && !previewLines.length,
      });
    },
    /**
     * QA screen: the real pass/fail counts from the run's test output, or an
     * explicit "no test output yet" when nothing was recorded.
     */
    updateQa(screen) {
      if (!qa) return;
      const lines = screen?.lines?.length
        ? screen.lines
        : [names.qa, "no test output yet"];
      const key = `${screen?.tone ?? "none"}|${lines.join(",")}`;
      if (key === qa.key) return;
      qa.key = key;
      const tone = screen?.tone ?? "none";
      let fg = p.screenFg;
      if (tone === "pass") fg = "#9be7b5";
      else if (tone === "fail") fg = "#f2a3a0";
      swapTexture(res, qa, { lines, bg: p.screenBg, fg, w: 384, h: 192 });
    },
    /** Whiteboard names plus up to three clickable artifact chips. */
    updateReview(names, chips = [], changed = null) {
      if (!review) return;
      const list = Array.isArray(chips) ? chips.slice(0, 3) : [];
      const key = `${names.join(",")}|${list.map((c) => c.id).join(",")}|${
        changed ? `${changed.count}:${changed.names.join("/")}` : "-"
      }`;
      if (key !== review.key) {
        review.key = key;
        let lines;
        if (names.length)
          // Two names rather than three, to make room for the one line that
          // says what the review is actually about.
          lines = [
            "reviewing",
            ...names.slice(0, 2),
            changedSummary(changed),
            artifactLine(list),
          ];
        else if (list.length)
          lines = [names.review, changedSummary(changed), artifactLine(list)];
        else lines = [names.review, "nothing under review"];
        swapTexture(res, review, {
          lines,
          bg: "#f7f7f2",
          fg: "#41556a",
          w: 384,
          h: 192,
        });
      }
      review.chips.forEach((chip, i) => {
        const data = list[i];
        chip.screen.visible = !!data;
        chip.artifactId = data?.id ?? null;
        chip.screen.userData.artifactId = data?.id ?? null;
        const chipKey = data ? `${data.id}|${data.title}` : "";
        if (chipKey === chip.key) return;
        chip.key = chipKey;
        if (!data) return;
        swapTexture(res, chip, {
          lines: [data.title || data.kind || "artifact"],
          bg: "#eef2f6",
          fg: "#41556a",
          w: 256,
          h: 96,
          bold: "bold 24px sans-serif",
        });
      });
    },
    /** Task handoff card above the meeting table; hidden when none recorded. */
    updateHandoff(card) {
      if (!handoff) return;
      handoff.screen.visible = !!card;
      const key = card ? card.lines.join("|") : "";
      if (key === handoff.key) return;
      handoff.key = key;
      if (!card) return;
      swapTexture(res, handoff, {
        lines: card.lines,
        bg: "#fdf6e6",
        fg: "#6c5a33",
        w: 384,
        h: 160,
        bold: "bold 30px sans-serif",
        mono: "18px sans-serif",
      });
    },
    updateCluster(count) {
      if (!cluster) return;
      cluster.screen.visible = count > 0;
      const key = String(count);
      if (key === cluster.key) return;
      cluster.key = key;
      swapTexture(res, cluster, {
        lines: [`${count} available`],
        bg: p.wall,
        fg: p.sign,
        w: 256,
        h: 96,
        bold: "bold 34px sans-serif",
      });
    },
  };
}
