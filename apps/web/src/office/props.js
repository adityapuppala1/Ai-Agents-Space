// Furniture a workspace placed in its office (core/visual/OfficeLayout.js).
// Each piece is built from the theme's own materials, so an arranged office
// still looks like the environment it was arranged in. Geometry only: a piece
// carries no data, and nothing here reads an agent, a task or a run.
import * as THREE from "three";
import { builders } from "./scene.js";
import { themeMaterials } from "./themes.js";

/** Builds one piece at the origin; the caller places and turns it. */
const BUILDERS = {
  plant(group, { cylinder, sphere }, mat, res) {
    cylinder(0.17, 0.13, 0.28, mat.pot, 0, 0.14, 0, group, 12);
    for (let i = 0; i < 4; i += 1)
      sphere(
        0.16,
        mat.green,
        Math.cos(i * 1.6) * 0.08,
        0.4 + (i % 2) * 0.1,
        Math.sin(i * 1.6) * 0.08,
        group,
      );
  },
  tree(group, { cylinder, sphere }, mat) {
    cylinder(0.22, 0.26, 0.34, mat.pot, 0, 0.17, 0, group, 14);
    cylinder(0.05, 0.06, 0.9, mat.wood, 0, 0.75, 0, group, 8);
    for (const [dx, dy, dz, r] of [
      [0, 1.35, 0, 0.42],
      [0.24, 1.15, 0.1, 0.3],
      [-0.2, 1.2, -0.12, 0.28],
    ])
      sphere(r, mat.green, dx, dy, dz, group);
  },
  sofa(group, { box }, mat) {
    box(1.7, 0.34, 0.78, mat.soft, 0, 0.3, 0, group);
    box(1.7, 0.5, 0.18, mat.soft, 0, 0.6, -0.3, group);
    for (const dx of [-0.85, 0.85]) box(0.18, 0.44, 0.78, mat.soft, dx, 0.5, 0, group);
    for (const [dx, dz] of [
      [-0.72, 0.3],
      [0.72, 0.3],
      [-0.72, -0.28],
      [0.72, -0.28],
    ])
      box(0.09, 0.14, 0.09, mat.metal, dx, 0.07, dz, group);
  },
  armchair(group, { box }, mat) {
    box(0.72, 0.3, 0.7, mat.soft, 0, 0.32, 0, group);
    box(0.72, 0.46, 0.16, mat.soft, 0, 0.6, -0.27, group);
    for (const dx of [-0.36, 0.36]) box(0.14, 0.4, 0.7, mat.soft, dx, 0.5, 0, group);
    box(0.5, 0.14, 0.5, mat.metal, 0, 0.1, 0, group);
  },
  table(group, { box, cylinder }, mat) {
    cylinder(0.52, 0.52, 0.07, mat.wood, 0, 0.42, 0, group, 28);
    cylinder(0.09, 0.12, 0.4, mat.metal, 0, 0.2, 0, group, 12);
    cylinder(0.34, 0.36, 0.04, mat.metal, 0, 0.02, 0, group, 20);
    box(0.22, 0.02, 0.16, mat.base, 0.1, 0.47, 0.06, group);
  },
  shelf(group, { box }, mat) {
    box(1.3, 0.06, 0.38, mat.wood, 0, 0.05, 0, group);
    for (const y of [0.5, 0.95, 1.4]) box(1.3, 0.05, 0.38, mat.wood, 0, y, 0, group);
    for (const dx of [-0.63, 0.63]) box(0.06, 1.45, 0.38, mat.wood, dx, 0.72, 0, group);
    // Books: three blocks of colour on the two lower shelves.
    for (const [dx, y, w, material] of [
      [-0.35, 0.66, 0.4, mat.accent],
      [0.15, 0.66, 0.3, mat.dark],
      [-0.2, 1.11, 0.5, mat.dark],
    ])
      box(w, 0.26, 0.26, material, dx, y, 0, group);
  },
  whiteboard(group, { box, plane }, mat, res) {
    box(1.5, 1.0, 0.06, mat.base, 0, 1.15, 0, group);
    plane(1.4, 0.9, res.material("#f7fafc"), 0, 1.15, 0.035, group);
    box(1.56, 0.06, 0.1, mat.metal, 0, 0.63, 0.02, group);
    for (const dx of [-0.6, 0.6]) box(0.07, 0.62, 0.07, mat.metal, dx, 0.31, 0, group);
  },
  screen(group, { box, plane }, mat) {
    box(1.7, 0.98, 0.09, mat.dark, 0, 1.35, 0, group);
    plane(1.58, 0.86, mat.screen, 0, 1.35, 0.05, group);
    box(0.5, 0.06, 0.3, mat.metal, 0, 0.83, 0, group);
    box(0.14, 0.8, 0.14, mat.metal, 0, 0.42, 0, group);
  },
  rug(group, { cylinder }, mat) {
    cylinder(1.05, 1.05, 0.02, mat.soft, 0, 0.011, 0, group, 40);
    cylinder(0.72, 0.72, 0.006, mat.accent, 0, 0.024, 0, group, 36);
  },
  lamp(group, { box, cylinder, sphere }, mat) {
    cylinder(0.22, 0.24, 0.04, mat.metal, 0, 0.02, 0, group, 16);
    cylinder(0.03, 0.03, 1.5, mat.metal, 0, 0.77, 0, group, 8);
    cylinder(0.26, 0.16, 0.26, mat.lampShade, 0, 1.6, 0, group, 18);
    sphere(0.1, mat.lampGlow, 0, 1.52, 0, group);
  },
  cabinet(group, { box }, mat) {
    box(1.0, 0.9, 0.45, mat.wood, 0, 0.45, 0, group);
    box(1.04, 0.05, 0.49, mat.base, 0, 0.92, 0, group);
    for (const y of [0.28, 0.66]) box(0.9, 0.04, 0.02, mat.metal, 0, y, 0.24, group);
  },
  water(group, { box, cylinder }, mat, res) {
    box(0.34, 0.9, 0.34, mat.base, 0, 0.45, 0, group);
    cylinder(0.16, 0.13, 0.42, res.material("#bfe4f2"), 0, 1.1, 0, group, 16);
    box(0.1, 0.06, 0.1, mat.metal, 0, 0.62, 0.19, group);
  },
};

/** The materials a piece can use, from the theme. */
function propMaterials(theme, res) {
  const mat = themeMaterials(theme, res);
  const p = theme.palette;
  return {
    ...mat,
    pot: res.material("#c7b299", { roughness: 0.8 }),
    soft: res.material(p.soft ?? p.mat, { roughness: 0.9 }),
    accent: res.material(p.accent, { roughness: 0.75 }),
    screen: res.material(p.screenBg, {
      emissive: p.screenBg,
      emissiveIntensity: 0.35,
    }),
    lampShade: res.material("#2f3b48", { metalness: 0.4, roughness: 0.5 }),
    lampGlow: res.material("#fff1d6", {
      emissive: "#ffe6b5",
      emissiveIntensity: 0.9,
    }),
  };
}

/**
 * Builds every placed piece into `group` (cleared first). `props` are
 * layout.props from computeLayout: world coordinates and a rotation.
 */
export function buildOfficeProps(group, props = [], theme, res) {
  group.clear();
  if (!props.length) return;
  const build = builders(res);
  const mat = propMaterials(theme, res);
  for (const prop of props) {
    const make = BUILDERS[prop.kind];
    if (!make) continue;
    const piece = new THREE.Group();
    make(piece, build, mat, res);
    piece.position.set(prop.x, 0, prop.z);
    piece.rotation.y = prop.rotation ?? 0;
    piece.traverse((object) => {
      if (object.isMesh) object.userData.propIndex = prop.index;
    });
    group.add(piece);
  }
}

/** Kinds this build can draw, for the editor's palette. */
export const DRAWN_PROP_KINDS = Object.freeze(Object.keys(BUILDERS));
