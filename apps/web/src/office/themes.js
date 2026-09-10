// Office themes. A theme owns palette, lighting, room labels and the
// decorative room shell. Zones and avatars are theme-independent so a theme
// switch only rebuilds decoration and never touches agent state.
import * as THREE from "three";
import { builders, textTexture, swapTexture } from "./scene.js";
import { clean } from "./data.js";

export const THEMES = {
  studio: {
    id: "studio",
    label: "Development studio",
    floorLabel: "FLOOR 01",
    rooms: {
      desk: "Workstations",
      research: "Library",
      qa: "QA station",
      review: "Review table",
      meeting: "Meeting area",
      breakArea: "Break area",
    },
    palette: {
      base: "#f5f5ef",
      floor: "#dedfda",
      floorLine: "#cbd0ce",
      wall: "#e2eaf0",
      wood: "#d1ba9c",
      metal: "#727f8b",
      dark: "#303f51",
      accent: "#8aa8bd",
      green: "#6e967a",
      screenBg: "#263748",
      screenFg: "#dbe7f2",
      sign: "#556b82",
      mat: "#c5d1d9",
      minimapFloor: "#eef1f3",
      minimapZone: "#d8e2ea",
      minimapText: "#5a6d80",
    },
    light: {
      sky: "#ffffff",
      ground: "#9aa9b6",
      hemi: 2.7,
      sunColor: "#fff7e6",
      sun: 3.1,
    },
    signLines: ["AGENT SPACE", "Good work happens together."],
  },
  operations: {
    id: "operations",
    label: "Operations center",
    floorLabel: "OPS DECK",
    rooms: {
      desk: "Consoles",
      research: "Intel desk",
      qa: "Pipeline",
      review: "Approvals",
      meeting: "Bridge",
      breakArea: "Standby",
    },
    palette: {
      base: "#2b3340",
      floor: "#232a35",
      floorLine: "#313a48",
      wall: "#1f2632",
      wood: "#3d4756",
      metal: "#8a95a3",
      dark: "#121821",
      accent: "#4f8fd6",
      green: "#4fb286",
      screenBg: "#0d1420",
      screenFg: "#9fd3ff",
      sign: "#9fd3ff",
      mat: "#2f3947",
      minimapFloor: "#1e2530",
      minimapZone: "#2d3846",
      minimapText: "#b7c6d6",
    },
    light: {
      sky: "#cfe3ff",
      ground: "#1c2430",
      hemi: 1.9,
      sunColor: "#dbe9ff",
      sun: 2.4,
    },
    signLines: ["OPERATIONS", "Every action is recorded."],
  },
};

// Palette variants share the proven room layout and event-driven props.
for (const [id, label, palette, light] of [
  ["garden", "Garden atelier", {base:"#e8eddf",floor:"#cad7c4",wall:"#d3e1cf",wood:"#b5a17c",accent:"#548c74",green:"#357455",mat:"#acc6b4",sign:"#366653"}, {sky:"#f3ffe8",sunColor:"#fff0cb"}],
  ["midnight", "Midnight lab", {base:"#25263f",floor:"#24233b",wall:"#2d2c4b",wood:"#51436a",accent:"#a795ed",green:"#729aaf",mat:"#403b60",sign:"#d4c7ff",screenBg:"#17162d",screenFg:"#cbbcff",minimapFloor:"#25233b",minimapZone:"#45405e",minimapText:"#ddd3fa"}, {sky:"#c8c6ff",ground:"#282343",hemi:2.2,sunColor:"#e6d7ff",sun:2.3}],
  ["sandstone", "Desert studio", {base:"#f5e7d8",floor:"#dfcbb6",wall:"#eddbc7",wood:"#bc8b67",accent:"#bb7553",green:"#7c916c",mat:"#d6b89e",sign:"#86583d"}, {sky:"#fff0de",sunColor:"#ffe0b2"}],
]) THEMES[id] = {...THEMES.studio, id, label, floorLabel: label.toUpperCase(), palette:{...THEMES.studio.palette,...palette}, light:{...THEMES.studio.light,...light}, signLines:[label.toUpperCase(), "A shared space for real work."]};

export function getTheme(name) {
  return THEMES[name] ?? THEMES.studio;
}

/** Standard material set for a theme, cached through `res`. */
export function themeMaterials(theme, res) {
  const p = theme.palette;
  return {
    base: res.material(p.base),
    floor: res.material(p.floor),
    line: res.material(p.floorLine),
    wall: res.material(p.wall),
    wood: res.material(p.wood),
    metal: res.material(p.metal),
    dark: res.material(p.dark),
    accent: res.material(p.accent),
    green: res.material(p.green),
    mat: res.material(p.mat),
  };
}

/**
 * Builds the room shell (floor, walls, windows or pipeline wall, plants or
 * server racks) into `group`. Everything created is tracked by `res`.
 */
export function buildRoom(group, theme, layout, res, options = {}) {
  const p = theme.palette;
  const { box, plane } = builders(res);
  const W = layout.width;
  const D = layout.depth;
  const mat = themeMaterials(theme, res);
  let handles = {};

  box(W + 0.5, 0.28, D + 0.5, mat.base, 0, -0.18, 0, group);
  box(W + 0.15, 0.08, D + 0.1, mat.floor, 0, 0.005, 0, group);
  const lines = Math.floor(W / 0.62);
  for (let i = 0; i < lines; i++)
    box(0.013, 0.012, D, mat.line, -W / 2 + 0.3 + i * 0.62, 0.052, 0, group);
  // Back and left walls with cornices and skirting.
  box(W + 0.2, 3.1, 0.17, mat.wall, 0, 1.54, -D / 2 - 0.1, group);
  box(0.17, 3.1, D + 0.2, mat.wall, -W / 2 - 0.1, 1.54, 0, group);
  box(W + 0.2, 0.12, 0.24, mat.base, 0, 3.13, -D / 2 - 0.1, group);
  box(0.24, 0.12, D + 0.2, mat.base, -W / 2 - 0.1, 3.13, 0, group);
  box(W, 0.11, 0.09, mat.base, 0, 0.1, -D / 2 + 0.03, group);
  box(0.09, 0.11, D, mat.base, -W / 2 + 0.03, 0.1, 0, group);

  if (theme.id === "operations")
    handles = buildOperationsShell(group, theme, layout, res, mat, options);
  else buildStudioShell(group, theme, layout, res, mat);

  // Decorative accents live along the walls, outside the navigation lanes.
  // They never represent telemetry or fabricated pipeline activity.
  if (theme.id === "garden") {
    const { cylinder, sphere } = builders(res);
    for (let i=0; i<4; i++) {
      const z=-D/2+1.4+i*1.05;
      cylinder(.23,.18,.26,mat.wood,-W/2+.3,2.25,z,group);
      box(.025,.65,.025,mat.metal,-W/2+.3,2.68,z,group);
      for(let j=0;j<3;j++) sphere(.2,mat.green,-W/2+.27+j*.07,2.44-j*.14,z+(j-1)*.16,group);
    }
  }
  if (theme.id === "midnight") {
    const glow=res.material("#b29aff", {emissive:"#8055e0",emissiveIntensity:.7});
    box(W,.045,.04,glow,0,2.98,-D/2+.01,group);
    box(.04,.045,D,glow,-W/2+.01,2.98,0,group);
  }
  if (theme.id === "sandstone") {
    for(let i=0;i<12;i++) box(.07,.95,.10,mat.wood,-W/2+.12,1.7,-D/2+.8+i*.25,group);
  }

  // Room name sign on the back wall (top-left).
  const signTexture = textTexture(res, {
    lines: theme.signLines,
    bg: p.wall,
    fg: p.sign,
    w: 640,
    h: 150,
    bold: "bold 40px sans-serif",
    mono: "24px sans-serif",
  });
  if (signTexture) {
    const signMaterial = res.track(
      new THREE.MeshBasicMaterial({ map: signTexture }),
    );
    plane(3.2, 0.75, signMaterial, -W / 2 + 2.3, 2.45, -D / 2 - 0.01, group);
  }
  return handles;
}

function buildStudioShell(group, theme, layout, res, mat) {
  const { box, cylinder, sphere } = builders(res);
  const W = layout.width;
  const D = layout.depth;
  // Windows along the back wall.
  const windows = Math.max(2, Math.floor((W - 6) / 2.4));
  const glass = res.material("#bad4e2", { metalness: 0.12, roughness: 0.25 });
  for (let i = 0; i < windows; i++) {
    const x = -W / 2 + 5.2 + i * 2.4;
    if (x > W / 2 - 1.2) break;
    box(1.94, 1.8, 0.07, glass, x, 1.95, -D / 2 + 0.03, group);
    box(0.055, 1.83, 0.11, mat.base, x, 1.95, -D / 2 + 0.1, group);
    box(1.96, 0.06, 0.11, mat.base, x, 1.94, -D / 2 + 0.1, group);
    box(2.05, 0.09, 0.3, mat.base, x, 1.03, -D / 2 + 0.15, group);
  }
  // Pinned notes on the left wall.
  const noteColors = ["#dfbd79", "#94b6cb", "#b7c8a3"];
  for (let i = 0; i < 5; i++)
    box(
      0.02,
      0.16,
      0.24,
      res.material(noteColors[i % 3]),
      -W / 2 + 0.16,
      2.12 - (i % 2) * 0.34,
      -D / 2 + 2 + i * 0.4,
      group,
    );
  const leafAlt = res.material("#88a888");
  const plant = (x, z, scale = 1) => {
    const g = new THREE.Group();
    g.position.set(x, 0.12, z);
    g.scale.setScalar(scale);
    group.add(g);
    cylinder(0.28, 0.21, 0.55, mat.base, 0, 0.275, 0, g);
    cylinder(0.04, 0.055, 0.8, mat.wood, 0, 0.8, 0, g);
    for (let i = 0; i < 7; i++) {
      const angle = i * 2.4;
      const leaf = sphere(
        0.24,
        i % 2 ? mat.green : leafAlt,
        Math.cos(angle) * 0.22,
        0.9 + i * 0.07,
        Math.sin(angle) * 0.22,
        g,
      );
      leaf.scale.set(0.65, 1.65, 0.6);
      leaf.rotation.z = Math.cos(angle) * 0.7;
    }
  };
  plant(-W / 2 + 0.9, D / 2 - 0.9, 1.1);
  plant(W / 2 - 0.9, D / 2 - 0.9, 1.25);
  plant(W / 2 - 0.9, -D / 2 + 0.9, 1.05);
  // Floor lamp near the right wall.
  cylinder(0.23, 0.23, 0.05, mat.metal, W / 2 - 0.6, 0.12, D / 2 - 2.2, group);
  cylinder(0.025, 0.025, 1.8, mat.metal, W / 2 - 0.6, 1, D / 2 - 2.2, group);
  cylinder(0.22, 0.37, 0.36, mat.base, W / 2 - 0.6, 1.95, D / 2 - 2.2, group);
}

function buildOperationsShell(group, theme, layout, res, mat, options = {}) {
  const p = theme.palette;
  const { box, plane } = builders(res);
  const W = layout.width;
  const D = layout.depth;
  const screenMaterial = (texture) =>
    res.track(new THREE.MeshBasicMaterial({ map: texture }));

  // CI/CD wall: one panel per recorded build/deploy event. The panels are
  // filled from `options.pipeline` (see data.pipelinePanels) and say so
  // honestly when no build event was recorded.
  const PANELS = 4;
  const stripW = Math.min(W - 6, 8);
  const stripX = W / 2 - stripW / 2 - 0.6;
  box(
    stripW,
    1.5,
    0.08,
    res.material("#182130"),
    stripX,
    2.05,
    -D / 2 + 0.02,
    group,
  );
  const panelW = stripW / PANELS;
  const panels = [];
  for (let i = 0; i < PANELS; i++) {
    const x = stripX - stripW / 2 + (i + 0.5) * panelW;
    const texture = textTexture(res, {
      lines: ["Pipeline", "no build events recorded"],
      bg: "#101826",
      fg: p.screenFg,
      w: 256,
      h: 128,
      bold: "bold 28px sans-serif",
      mono: "15px sans-serif",
    });
    const screen = plane(
      panelW - 0.25,
      0.9,
      screenMaterial(texture),
      x,
      2.1,
      -D / 2 + 0.07,
      group,
    );
    screen.visible = i === 0;
    panels.push({ screen, texture, key: "", eventId: null });
    if (i < PANELS - 1)
      box(
        0.22,
        0.04,
        0.05,
        mat.accent,
        x + panelW / 2,
        2.1,
        -D / 2 + 0.08,
        group,
      );
  }

  // Service map: providers and execution hosts as nodes, active runs as edges.
  const mapTexture = textTexture(res, {
    lines: ["Service map", "no connected runtime recorded"],
    bg: "#0d1420",
    fg: p.screenFg,
    w: 384,
    h: 224,
    bold: "bold 28px sans-serif",
    mono: "16px sans-serif",
  });
  const mapScreen = plane(
    2.2,
    1.25,
    screenMaterial(mapTexture),
    stripX - stripW / 2 - 1.35,
    1.95,
    -D / 2 + 0.07,
    group,
  );
  const serviceMapHandle = { screen: mapScreen, texture: mapTexture, key: "" };

  // Server racks along the left wall.
  const rack = res.material("#171d27", { metalness: 0.3, roughness: 0.5 });
  const led = res.material(p.green, {
    emissive: p.green,
    emissiveIntensity: 0.6,
  });
  const ledAlt = res.material(p.accent, {
    emissive: p.accent,
    emissiveIntensity: 0.6,
  });
  const racks = Math.max(2, Math.floor((D - 3) / 1.3));
  for (let i = 0; i < racks; i++) {
    const z = -D / 2 + 1.6 + i * 1.3;
    if (z > D / 2 - 0.9) break;
    box(0.6, 2.1, 1.0, rack, -W / 2 + 0.45, 1.05, z, group);
    for (let u = 0; u < 6; u++) {
      box(
        0.02,
        0.06,
        0.06,
        u % 3 === 1 ? ledAlt : led,
        -W / 2 + 0.76,
        0.35 + u * 0.3,
        z - 0.3,
        group,
      );
      box(0.04, 0.02, 0.7, mat.metal, -W / 2 + 0.76, 0.22 + u * 0.3, z, group);
    }
  }
  // Floor guide line toward the pipeline wall.
  const guide = res.material(p.accent, {
    emissive: p.accent,
    emissiveIntensity: 0.25,
  });
  box(W - 2, 0.012, 0.05, guide, 0, 0.056, -D / 2 + 3.05, group);

  const handles = {
    /** Fills the CI/CD wall from recorded build events. */
    updatePipeline(list = []) {
      const items =
        Array.isArray(list) && list.length ? list.slice(-PANELS) : [];
      panels.forEach((panel, i) => {
        const item = items[i] ?? null;
        panel.screen.visible = i === 0 || !!item;
        panel.eventId = item?.id ?? null;
        panel.screen.userData.buildEventId = item?.id ?? null;
        const key = item ? `${item.title}|${item.status}` : "empty";
        if (key === panel.key) return;
        panel.key = key;
        swapTexture(res, panel, {
          lines: item
            ? [item.title || item.kind || "build", item.detail]
            : ["Pipeline", "no build events recorded"],
          bg: "#101826",
          fg: statusColor(item?.status, p.screenFg),
          w: 256,
          h: 128,
          bold: "bold 28px sans-serif",
          mono: "15px sans-serif",
        });
      });
    },
    /** Draws the service map from providers, runners and active runs. */
    updateServiceMap(map) {
      const nodes = map?.nodes ?? [];
      const edges = map?.edges ?? [];
      const key = `${nodes.map((n) => n.id).join(",")}|${edges
        .map((e) => `${e.id}:${e.runs}`)
        .join(",")}`;
      if (key === serviceMapHandle.key) return;
      serviceMapHandle.key = key;
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const lines = ["Service map"];
      if (!nodes.length) lines.push("no connected runtime recorded");
      else if (!edges.length) {
        lines.push(...nodes.slice(0, 3).map((n) => `${n.label} (${n.kind})`));
        lines.push("no active run recorded");
      } else {
        for (const edge of edges.slice(0, 3)) {
          const from = byId.get(edge.from)?.label ?? "runtime";
          const to = byId.get(edge.to)?.label ?? "host";
          lines.push(
            `${clean(from, 14)} -> ${clean(to, 12)} (${edge.runs} run${edge.runs === 1 ? "" : "s"})`,
          );
        }
      }
      swapTexture(res, serviceMapHandle, {
        lines,
        bg: "#0d1420",
        fg: p.screenFg,
        w: 384,
        h: 224,
        bold: "bold 28px sans-serif",
        mono: "16px sans-serif",
      });
    },
  };
  handles.updatePipeline(options.pipeline ?? []);
  handles.updateServiceMap(options.serviceMap ?? null);
  return handles;
}

/** Colour for a recorded build status; unknown statuses keep the theme text. */
function statusColor(status, fallback) {
  const value = String(status ?? "").toLowerCase();
  if (!value) return fallback;
  if (value.includes("fail") || value.includes("error")) return "#f2a3a0";
  if (value.includes("pass") || value.includes("success")) return "#9be7b5";
  if (value.includes("run") || value.includes("progress")) return "#ffd79a";
  return fallback;
}
