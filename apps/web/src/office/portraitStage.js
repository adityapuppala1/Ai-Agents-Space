// The Agents page's 3D portraits. One WebGL renderer draws every card's
// figure and copies the frame into that card's own 2D canvas, so a page of
// forty agents costs one WebGL context, not forty (browsers allow about
// sixteen). Each portrait is the office's own figure (avatars.js), dressed in
// the profile's avatar style, on a small stage: seated at a laptop while it
// has work, standing beside an empty chair while it has none
// (office/portrait.js says which, from recorded state only).
//
// Only cards on screen are drawn, working agents more often than idle ones,
// nothing at all while the tab is hidden, and under reduced motion each
// portrait is drawn once per change.
import * as THREE from "three";
import { Resources, builders } from "./scene.js";
import {
  createFigure,
  applyAgentState,
  animateFigure,
  styleKeyOf,
} from "./avatars.js";
import { portraitScene, portraitFps, SCREEN_TONES } from "./portrait.js";

/** Yaw that turns a figure at (ax, az) to face (bx, bz); yaw 0 faces -z. */
function facingToward(ax, az, bx, bz) {
  return Math.atan2(-(bx - ax), -(bz - az));
}

// Framed so the stage's rim and an indicator over the head both fit.
const CAMERA = new THREE.Vector3(3.4, 3.05, 4.6);
const LOOK = new THREE.Vector3(0, 1.06, 0.05);
/** Seated, the agent turns to its laptop, three-quarters to the viewer. */
const DESK_FACING = facingToward(0, 0, -2.3, 5.0);
/** Standing, it faces the viewer, a little to one side. */
const STAND_FACING = facingToward(0, 0, 1.6, 3.9);

export function createPortraitStage({
  reducedMotion = false,
  dark = false,
} = {}) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    return null;
  }
  if (!renderer.getContext()) return null;
  if (THREE.SRGBColorSpace !== undefined)
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor("#000000", 0);
  const res = new Resources();
  const { box, cylinder } = builders(res);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight("#ffffff", "#9fb0c2", 1.35));
  const sun = new THREE.DirectionalLight("#ffffff", 1.7);
  sun.position.set(3, 6, 4);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(27, 4 / 3, 0.1, 40);
  camera.position.copy(CAMERA);
  camera.lookAt(LOOK);

  const slots = new Map();
  let lost = false;
  let frame = 0;
  let last = 0;
  let size = [0, 0];
  const onLost = (event) => {
    event.preventDefault();
    lost = true;
  };
  renderer.domElement.addEventListener("webglcontextlost", onLost);
  const observer =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const slot = entry.target.__portraitSlot;
              if (!slot) continue;
              slot.visible = entry.isIntersecting;
              if (slot.visible) slot.dirty = true;
            }
            wake();
          },
          { rootMargin: "120px" },
        )
      : null;

  const palette = () =>
    dark
      ? { platform: "#2b3a4c", rim: "#3a4c61", table: "#6b5a47" }
      : { platform: "#e4eaf1", rim: "#cfd9e4", table: "#c8a06a" };

  /** The stage under one agent: platform, chair, table and laptop. */
  function buildStage(slot) {
    const group = new THREE.Group();
    const colors = palette();
    const platform = res.material(colors.platform, { roughness: 0.9 });
    const rim = res.material(colors.rim, { roughness: 0.8 });
    cylinder(1.08, 1.12, 0.08, platform, 0, 0.04, 0, group, 48);
    cylinder(1.13, 1.13, 0.02, rim, 0, 0.005, 0, group, 48);
    // The agent's colour, as a ring round the stage.
    const ring = new THREE.Mesh(
      res.ring(1.0, 1.06, 56),
      res.material(slot.agent.color ?? "#7d8cc4", {
        emissive: slot.agent.color ?? "#7d8cc4",
        emissiveIntensity: 0.35,
        side: THREE.DoubleSide,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.085;
    group.add(ring);
    // A soft contact shadow.
    const shadow = new THREE.Mesh(
      res.geometry("portrait-shadow", () => new THREE.CircleGeometry(0.42, 32)),
      res.cached(
        "portrait-shadow",
        () =>
          new THREE.MeshBasicMaterial({
            color: "#000000",
            transparent: true,
            opacity: 0.14,
            depthWrite: false,
          }),
      ),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.083;
    group.add(shadow);

    const seat = res.material(dark ? "#1f2a37" : "#34465a", { roughness: 0.7 });
    const metal = res.material("#8f9aa6", { metalness: 0.5, roughness: 0.4 });
    const chair = new THREE.Group();
    box(0.46, 0.07, 0.44, seat, 0, 0.52, 0.02, chair);
    box(0.46, 0.5, 0.06, seat, 0, 0.8, 0.24, chair);
    cylinder(0.035, 0.035, 0.36, metal, 0, 0.31, 0.02, chair, 8);
    cylinder(0.24, 0.27, 0.035, metal, 0, 0.11, 0.02, chair, 12);
    group.add(chair);

    const desk = new THREE.Group();
    const top = res.material(colors.table, { roughness: 0.55 });
    cylinder(0.36, 0.36, 0.05, top, 0, 0.78, 0, desk, 32);
    cylinder(0.04, 0.05, 0.7, metal, 0, 0.43, 0, desk, 10);
    cylinder(0.2, 0.22, 0.03, metal, 0, 0.1, 0, desk, 16);
    const laptop = new THREE.Group();
    laptop.position.set(0, 0.805, 0);
    const shell = res.material("#3a4654", { metalness: 0.45, roughness: 0.35 });
    box(0.36, 0.018, 0.25, shell, 0, 0.009, 0, laptop);
    const hinge = new THREE.Group();
    hinge.position.set(0, 0.018, -0.125);
    laptop.add(hinge);
    box(0.36, 0.24, 0.012, shell, 0, 0.12, 0, hinge);
    const screen = res.track(
      new THREE.MeshStandardMaterial({
        color: "#1d2733",
        emissive: new THREE.Color(SCREEN_TONES.quiet),
        emissiveIntensity: 0.55,
        roughness: 0.4,
      }),
    );
    const pane = new THREE.Mesh(res.plane(0.32, 0.2), screen);
    pane.position.set(0, 0.125, 0.007);
    hinge.add(pane);
    const line = new THREE.Mesh(
      res.box(0.2, 0.012, 0.004),
      res.material("#e8f1fb", { emissive: "#e8f1fb", emissiveIntensity: 0.8 }),
    );
    line.position.set(-0.03, 0.18, 0.01);
    hinge.add(line);
    hinge.rotation.x = -0.28;
    desk.add(laptop);
    group.add(desk);
    return { group, chair, desk, laptop, screen, line };
  }

  /** The figure for a slot, rebuilt when the avatar style changes. */
  function buildFigure(slot) {
    if (slot.fig?.group) slot.stage.group.remove(slot.fig.group);
    const fig = createFigure(slot.agent, slot.index, res, {
      style: slot.style,
      detail: "high",
    });
    fig.styleKey = styleKeyOf(slot.style, slot.agent);
    fig.pos.set(0, 0.08, 0);
    fig.placed = true;
    // The stage's own ring stands in for the office's selection ring.
    fig.parts.ring.visible = false;
    slot.stage.group.add(fig.group);
    slot.fig = fig;
  }

  /** Poses the slot from the agent's recorded state. */
  function arrange(slot) {
    const view = portraitScene(slot.agent, slot.state);
    slot.view = view;
    const { chair, desk, screen, line } = slot.stage;
    const facing = view.seated ? DESK_FACING : STAND_FACING;
    // Seated: the chair behind the agent, the table in front of it.
    const fx = -Math.sin(facing);
    const fz = -Math.cos(facing);
    chair.rotation.y = facing;
    if (view.seated) {
      chair.position.set(0, 0, 0);
      desk.position.set(fx * 0.56, 0, fz * 0.56);
    } else {
      // Standing beside its empty chair; no laptop out.
      chair.position.set(-0.62, 0, -0.35);
    }
    desk.visible = view.laptop;
    screen.emissive.setHex(SCREEN_TONES[view.tone] ?? SCREEN_TONES.quiet);
    line.visible = view.typing;
    const fig = slot.fig;
    applyAgentState(
      fig,
      slot.agent,
      { x: 0, z: 0, facing, zone: view.seated ? "conference" : "desk" },
      { now: performance.now(), reducedMotion: true },
    );
    fig.yaw = fig.targetYaw = fig.renderYaw = facing;
    fig.group.rotation.y = facing;
    fig.atSeat = view.seated;
    slot.dirty = true;
  }

  function draw(slot, time, dtMs) {
    const canvas = slot.canvas;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(rect.width * ratio);
    const h = Math.round(rect.height * ratio);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    if (size[0] !== w || size[1] !== h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      size = [w, h];
    }
    const fig = slot.fig;
    animateFigure(fig, time, {
      reducedMotion,
      running: true,
      dtMs,
      selected: false,
    });
    // A slow half-turn of the stage, so the figure reads as a body.
    slot.stage.group.rotation.y = reducedMotion
      ? 0
      : Math.sin(time * 0.00045 + slot.index * 1.3) * 0.2;
    const { line } = slot.stage;
    if (line.visible)
      line.position.y = reducedMotion
        ? 0.14
        : 0.2 - ((time * 0.00045 + slot.index * 0.13) % 1) * 0.15;
    scene.add(slot.stage.group);
    renderer.render(scene, camera);
    scene.remove(slot.stage.group);
    slot.ctx.clearRect(0, 0, w, h);
    slot.ctx.drawImage(renderer.domElement, 0, 0, w, h);
    slot.drawnAt = time;
    slot.dirty = false;
  }

  function loop(time) {
    frame = 0;
    if (lost) return;
    const dtMs = Math.min(200, time - (last || time) || 16);
    last = time;
    let animating = false;
    if (!document.hidden)
      for (const slot of slots.values()) {
        if (!slot.visible) continue;
        const fps = portraitFps(slot.view, { reducedMotion });
        if (fps) animating = true;
        const due = fps ? time - slot.drawnAt >= 1000 / fps : false;
        if (slot.dirty || due) draw(slot, time, dtMs);
      }
    if (animating || [...slots.values()].some((s) => s.visible && s.dirty))
      frame = requestAnimationFrame(loop);
  }
  function wake() {
    if (!frame && !lost) frame = requestAnimationFrame(loop);
  }
  const onVisibility = () => {
    if (!document.hidden) wake();
  };
  document.addEventListener("visibilitychange", onVisibility);

  return {
    /** Starts drawing `agent` into `canvas`. */
    mount(id, canvas, { agent, style = null, state = "idle", index = 0 }) {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const slot = {
        id,
        canvas,
        ctx,
        agent,
        style,
        state,
        index,
        visible: !observer,
        dirty: true,
        drawnAt: 0,
      };
      slot.stage = buildStage(slot);
      buildFigure(slot);
      arrange(slot);
      slots.set(id, slot);
      canvas.__portraitSlot = slot;
      observer?.observe(canvas);
      wake();
    },
    /** New recorded state or style for a mounted portrait. */
    update(id, { agent, style = null, state = "idle" }) {
      const slot = slots.get(id);
      if (!slot) return;
      const restyle = styleKeyOf(style, agent) !== slot.fig.styleKey;
      const recolor = (agent.color ?? "") !== (slot.agent.color ?? "");
      slot.agent = agent;
      slot.style = style;
      slot.state = state;
      if (recolor) {
        slot.stage.group.clear();
        slot.stage = buildStage(slot);
        slot.fig = null;
        buildFigure(slot);
      } else if (restyle) buildFigure(slot);
      arrange(slot);
      wake();
    },
    unmount(id) {
      const slot = slots.get(id);
      if (!slot) return;
      observer?.unobserve(slot.canvas);
      delete slot.canvas.__portraitSlot;
      slots.delete(id);
    },
    setReducedMotion(next) {
      reducedMotion = Boolean(next);
      for (const slot of slots.values()) slot.dirty = true;
      wake();
    },
    setDark(next) {
      if (Boolean(next) === dark) return;
      dark = Boolean(next);
      for (const slot of slots.values()) {
        slot.stage.group.clear();
        slot.stage = buildStage(slot);
        slot.fig = null;
        buildFigure(slot);
        arrange(slot);
      }
      wake();
    },
    dispose() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      renderer.domElement.removeEventListener("webglcontextlost", onLost);
      slots.clear();
      res.dispose();
      renderer.dispose();
    },
  };
}
