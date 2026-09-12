// A small 3D preview of an office being arranged.
//
// The plan view is the editing surface: it is keyboard-operable, announces
// every change, and works without WebGL. This stands beside it and answers
// the question a plan cannot — what will the room actually look like.
//
// It deliberately draws less than the office does. Rooms are slabs with
// their names on, desks are blocks, and only the furniture is built with the
// real catalogue (buildOfficeProps, the same call the office makes), because
// furniture is the thing being placed. Monitors, agents and screens are the
// office's job, not a preview's.
//
// One renderer, created when the arranger opens and disposed when it closes.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Resources, createLights, textTexture } from "./scene.js";
import { buildOfficeProps } from "./props.js";
import { propClashes } from "./obstacles.js";

/** Warning tint for a piece standing in something else. */
const CLASH = 0xb3403f;
/** Highlight for whatever is selected in the plan. */
const PICKED = 0x5b3fc4;

export function createArrangeStage(container, options = {}) {
  const theme = options.theme;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    // No WebGL: the caller keeps the plan view, which is the real editor.
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = false;
  container.appendChild(renderer.domElement);
  renderer.domElement.setAttribute("aria-hidden", "true");

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-10, 10, 7, -7, 0.1, 400);
  camera.position.set(14, 15, 18);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.3, 0);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minPolarAngle = 0.3;
  controls.maxPolarAngle = 1.2;
  controls.update();

  const lights = createLights(scene, theme, 1, "day");
  const group = new THREE.Group();
  scene.add(group);
  let res = new Resources();
  let raf = 0;
  let disposed = false;

  // Half the floor's mean span, set by update(). The preview box is wide and
  // short, so a fixed frustum left the floor filling about half its height.
  let span = 12.6;

  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    const aspect = w / h;
    // Seen from this angle a floor of `span` projects to roughly a third of
    // it vertically and just under half horizontally; fit whichever binds.
    const vertical = Math.max(span * 0.38, (span * 0.52) / aspect, 2);
    camera.left = -vertical * aspect;
    camera.right = vertical * aspect;
    camera.top = vertical;
    camera.bottom = -vertical;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }

  function label(text, width, color) {
    const texture = textTexture(res, {
      lines: [text],
      bg: "#ffffff",
      fg: color,
      w: 256,
      h: 64,
    });
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
    });
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(width, width / 4),
      material,
    );
    plane.rotation.x = -Math.PI / 2;
    return plane;
  }

  /**
   * Rebuilds the preview for `layout` (what computeLayout returned for the
   * draft). `selection` is the plan's own selection string, so the same
   * thing is highlighted in both views.
   */
  function update(layout, { selection = null, roomNames = {} } = {}) {
    if (disposed || !layout) return;
    span = (layout.width + layout.depth) / 2;
    group.clear();
    res.dispose();
    res = new Resources();
    const palette = theme?.palette ?? {};

    // Floor.
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(layout.width, 0.2, layout.depth),
      new THREE.MeshLambertMaterial({ color: palette.floor ?? 0xf1f1ee }),
    );
    floor.position.y = -0.1;
    group.add(floor);

    // Desks, as guides: they follow the team and cannot be arranged.
    const deskMaterial = new THREE.MeshLambertMaterial({
      color: palette.deskTop ?? 0xd9c7a8,
      transparent: true,
      opacity: 0.55,
    });
    for (const desk of layout.desks ?? []) {
      const block = new THREE.Mesh(
        new THREE.BoxGeometry(1.9, 0.5, 0.95),
        deskMaterial,
      );
      block.position.set(desk.x, 0.25, desk.z - 0.35);
      group.add(block);
    }

    // Rooms, as named slabs. A room serving nothing is not drawn, exactly as
    // the office does not build it.
    for (const zone of Object.values(layout.zones ?? {})) {
      if (zone.does === "none") continue;
      const picked = selection === `zone:${zone.id}`;
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(zone.w, 0.12, zone.d),
        new THREE.MeshLambertMaterial({
          color: picked ? PICKED : (palette.accent ?? 0x8aa8bd),
          transparent: true,
          opacity: picked ? 0.85 : 0.5,
        }),
      );
      slab.position.set(zone.x, 0.06, zone.z);
      group.add(slab);
      const name = roomNames[zone.id] ?? zone.id;
      const plate = label(String(name), Math.min(zone.w, 3), "#2b3a4a");
      plate.position.set(zone.x, 0.14, zone.z);
      group.add(plate);
    }

    // Furniture, built with the office's own catalogue. It owns the group it
    // is handed — buildOfficeProps clears it — so it gets one of its own
    // rather than the group holding the floor and the rooms.
    const propGroup = new THREE.Group();
    group.add(propGroup);
    buildOfficeProps(propGroup, layout.props ?? [], theme, res);

    // Anything standing in something else, marked where it stands.
    const clashing = propClashes(layout);
    for (const prop of layout.props ?? []) {
      const chosen = selection === `prop:${prop.index}`;
      const clash = clashing.has(prop.index);
      if (!chosen && !clash) continue;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.42, 0.6, 24),
        new THREE.MeshBasicMaterial({
          color: clash ? CLASH : PICKED,
          transparent: true,
          opacity: 0.9,
          side: THREE.DoubleSide,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(prop.x, 0.16, prop.z);
      group.add(ring);
    }
    resize();
  }

  function frame() {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    controls.update();
    renderer.render(scene, camera);
  }
  resize();
  frame();

  return {
    update,
    resize,
    /** Prop indices standing in something else, for the panel to name. */
    clashes: (layout) => (layout ? propClashes(layout) : new Set()),
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      controls.dispose();
      group.clear();
      res.dispose();
      scene.remove(lights.hemi, lights.sun);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
