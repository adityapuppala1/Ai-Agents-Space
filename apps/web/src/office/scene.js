// Shared Three.js helpers for the living office: resource tracking (so every
// geometry/material/texture can be disposed), procedural mesh builders,
// canvas text textures, renderer creation and graphics presets.
import * as THREE from "three";
import { lightingFor } from "./data.js";

/**
 * Graphics presets. `frameMs` is the minimum time between rendered frames.
 * `screenBudget` caps how many desks keep an individual monitor texture and
 * `crowd` how many figures keep articulated limbs — both scale caps, so a
 * large team costs the same as the preset promises rather than growing with
 * the roster. They come from the ui.graphics setting the workspace already
 * stores; there is no separate setting for them.
 */
export const GRAPHICS = {
  low: {
    shadows: false,
    pixelRatio: 1,
    particles: false,
    frameMs: 33,
    shadowSize: 512,
    avatarDetail: "low",
    labelDensity: "active",
    animationRate: 0.5,
    screenBudget: 6,
    crowd: 12,
  },
  medium: {
    shadows: true,
    pixelRatio: 1.5,
    particles: true,
    frameMs: 16,
    shadowSize: 1024,
    avatarDetail: "medium",
    labelDensity: "all",
    animationRate: 1,
    screenBudget: 16,
    crowd: 24,
  },
  high: {
    shadows: true,
    pixelRatio: 2,
    particles: true,
    frameMs: 0,
    shadowSize: 2048,
    avatarDetail: "high",
    labelDensity: "all",
    animationRate: 1,
    screenBudget: 32,
    crowd: 48,
  },
};

export function graphicsPreset(name) {
  return GRAPHICS[name] ?? GRAPHICS.medium;
}

export function adaptiveGraphics({
  width = 1280,
  devicePixelRatio = 1,
  hardwareConcurrency = 8,
  deviceMemory = 8,
  reducedMotion = false,
} = {}) {
  if (reducedMotion)
    return { preset: "low", reason: "reduced motion preference" };
  if (width < 720) return { preset: "low", reason: "compact viewport" };
  if (deviceMemory <= 4 || hardwareConcurrency <= 4)
    return { preset: "low", reason: "device capability" };
  if (
    width >= 1280 &&
    deviceMemory >= 8 &&
    hardwareConcurrency >= 8 &&
    devicePixelRatio <= 2
  )
    return { preset: "high", reason: "device capability" };
  return { preset: "medium", reason: "balanced for this screen" };
}

export function resolveGraphics(name, environment, runtimeCap = null) {
  if (name !== "auto")
    return { preset: name in GRAPHICS ? name : "medium", reason: "manual" };
  const result = adaptiveGraphics(environment);
  const order = ["low", "medium", "high"];
  if (runtimeCap && order.indexOf(runtimeCap) < order.indexOf(result.preset))
    return { preset: runtimeCap, reason: "adjusted for frame rate" };
  return result;
}

export function lowerGraphics(name) {
  return name === "high" ? "medium" : "low";
}

/**
 * Tracks every GPU resource created through it so a whole scene section can
 * be rebuilt (theme switch) or torn down (unmount) without leaks. Geometries
 * and standard materials are cached by their parameters to batch repeats.
 */
export class Resources {
  constructor() {
    this.geometries = new Map();
    this.materials = new Map();
    this.loose = new Set();
    this.textures = new Set();
    // Keyed caches for the per-figure resources that used to be created fresh
    // for every agent: loose and textures are Sets with no per-item
    // release, so one entry per figure accumulated for the life of the scene.
    this.shared = new Map();
  }
  /**
   * Cache-by-key for a material or texture whose content depends only on the
   * key. Returned objects are owned by this Resources and disposed with it.
   */
  cached(key, make) {
    let value = this.shared.get(key);
    if (value === undefined) {
      value = make();
      this.shared.set(key, value);
      if (value?.isTexture) this.textures.add(value);
      else if (value) {
        this.loose.add(value);
        if (value.map) this.textures.add(value.map);
      }
    }
    return value;
  }
  geometry(key, make) {
    let g = this.geometries.get(key);
    if (!g) {
      g = make();
      this.geometries.set(key, g);
    }
    return g;
  }
  box(w, h, d) {
    return this.geometry(
      `box:${w}:${h}:${d}`,
      () => new THREE.BoxGeometry(w, h, d),
    );
  }
  cylinder(rt, rb, h, seg = 16) {
    return this.geometry(
      `cyl:${rt}:${rb}:${h}:${seg}`,
      () => new THREE.CylinderGeometry(rt, rb, h, seg),
    );
  }
  sphere(r, ws = 14, hs = 10) {
    return this.geometry(
      `sph:${r}:${ws}:${hs}`,
      () => new THREE.SphereGeometry(r, ws, hs),
    );
  }
  plane(w, h) {
    return this.geometry(`pln:${w}:${h}`, () => new THREE.PlaneGeometry(w, h));
  }
  ring(inner, outer, seg = 40) {
    return this.geometry(
      `ring:${inner}:${outer}:${seg}`,
      () => new THREE.RingGeometry(inner, outer, seg),
    );
  }
  octahedron(r) {
    return this.geometry(`oct:${r}`, () => new THREE.OctahedronGeometry(r));
  }
  cone(r, h) {
    return this.geometry(
      `cone:${r}:${h}`,
      () => new THREE.ConeGeometry(r, h, 12),
    );
  }
  /** Cached MeshStandardMaterial. */
  material(color, extra = {}) {
    const key = `${color}:${JSON.stringify(extra)}`;
    let m = this.materials.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness: 0.72, ...extra });
      this.materials.set(key, m);
    }
    return m;
  }
  /** Uncached material (e.g. one carrying a unique texture). */
  track(material) {
    this.loose.add(material);
    if (material.map) this.textures.add(material.map);
    return material;
  }
  texture(canvas) {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    this.textures.add(t);
    return t;
  }
  release(texture) {
    if (!texture) return;
    this.textures.delete(texture);
    texture.dispose();
  }
  dispose() {
    for (const g of this.geometries.values()) g.dispose();
    for (const m of this.materials.values()) m.dispose();
    for (const m of this.loose) m.dispose();
    for (const t of this.textures) t.dispose();
    this.geometries.clear();
    this.materials.clear();
    this.loose.clear();
    this.textures.clear();
    this.shared.clear();
  }
}

/** Builds a mesh, positions it and attaches it to `parent`. */
export function mesh(geometry, material, x, y, z, parent, shadows = true) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  m.castShadow = shadows;
  m.receiveShadow = shadows;
  parent.add(m);
  return m;
}

/** Convenience builders bound to a Resources instance. */
export function builders(res) {
  return {
    box: (w, h, d, mat, x, y, z, p) => mesh(res.box(w, h, d), mat, x, y, z, p),
    cylinder: (rt, rb, h, mat, x, y, z, p, seg) =>
      mesh(res.cylinder(rt, rb, h, seg), mat, x, y, z, p),
    sphere: (r, mat, x, y, z, p) => mesh(res.sphere(r), mat, x, y, z, p),
    plane: (w, h, mat, x, y, z, p) =>
      mesh(res.plane(w, h), mat, x, y, z, p, false),
  };
}

/**
 * Renders text lines into a canvas texture. Line 0 uses the bold font, the
 * rest the mono font. Returns the texture; caller owns disposal via `res`.
 */
export function textTexture(
  res,
  {
    lines,
    bg,
    fg,
    w = 256,
    h = 128,
    bold = "bold 26px sans-serif",
    mono = "18px Consolas, monospace",
    caret = false,
    accent = null,
  },
) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext("2d");
  if (!c) return null;
  c.fillStyle = bg;
  c.fillRect(0, 0, w, h);
  if (accent) {
    c.fillStyle = accent;
    c.fillRect(0, 0, w, 6);
  }
  c.fillStyle = fg;
  const step = Math.max(24, Math.floor((h - 24) / Math.max(lines.length, 1)));
  lines.forEach((line, i) => {
    c.font = i === 0 ? bold : mono;
    let text = String(line ?? "");
    while (text.length > 1 && c.measureText(text).width > w - 28)
      text = text.slice(0, -2);
    c.fillText(text, 14, 34 + i * step);
  });
  if (caret) {
    c.fillStyle = fg;
    c.fillRect(14, Math.min(h - 18, 34 + lines.length * step - 12), 10, 14);
  }
  return res.texture(canvas);
}

/**
 * Replaces the texture on a `{ screen, texture }` handle, disposing the old
 * one. Used by every live screen in the office.
 */
export function swapTexture(res, handle, opts) {
  const next = textTexture(res, opts);
  if (!next) return;
  const material = handle.screen.material;
  res.release(material.map);
  material.map = next;
  material.needsUpdate = true;
  handle.texture = next;
}

/** Basename of a path (both separators, tolerant of null). */
export function basename(file) {
  if (!file) return "";
  const parts = String(file).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/** Creates the WebGL renderer or returns null when WebGL is unavailable. */
export function createRenderer(container) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
  } catch {
    return null;
  }
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Deliberately NO filmic tone mapping: the stylised palette and the light rig
  // were tuned for a linear response, and ACES flattened the floor to white and
  // washed out the wood and grid. Explicit sRGB output only.
  if (THREE.SRGBColorSpace !== undefined)
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor("#000000", 0);
  container.prepend(renderer.domElement);
  // The drawing itself carries no fact of its own: every agent, room and
  // state above it is a named control in the same group, and the roster
  // repeats the floor in text. A labelled canvas node only gave a screen
  // reader something to announce that it could not use.
  renderer.domElement.setAttribute("aria-hidden", "true");
  return renderer;
}

/** Applies a graphics preset to renderer and lights; forces material recompiles. */
export function applyGraphics(renderer, scene, sun, presetName) {
  const preset = graphicsPreset(presetName);
  renderer.setPixelRatio(
    Math.min(window.devicePixelRatio || 1, preset.pixelRatio),
  );
  const changed = renderer.shadowMap.enabled !== preset.shadows;
  renderer.shadowMap.enabled = preset.shadows;
  if (sun) {
    sun.castShadow = preset.shadows;
    if (sun.shadow.mapSize.x !== preset.shadowSize) {
      sun.shadow.mapSize.set(preset.shadowSize, preset.shadowSize);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
  }
  if (changed) {
    scene.traverse((obj) => {
      if (obj.material)
        for (const m of [].concat(obj.material)) m.needsUpdate = true;
    });
  }
  return preset;
}

/**
 * Creates the light rig. `scale` widens the shadow frustum for large rooms;
 * `lighting` is a preset name ("day" | "evening" | "focus").
 */
export function createLights(scene, theme, scale = 1, lighting = "day") {
  const light = lightingFor(theme, lighting);
  const hemi = new THREE.HemisphereLight(light.sky, light.ground, light.hemi);
  const sun = new THREE.DirectionalLight(light.sunColor, light.sun);
  sun.position.set(1 * scale, 16 * scale, 8 * scale);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  const bound = 12 * scale;
  Object.assign(sun.shadow.camera, {
    left: -bound,
    right: bound,
    top: bound,
    bottom: -bound,
    far: 60 * scale,
  });
  sun.shadow.normalBias = 0.04;
  scene.add(hemi, sun);
  return { hemi, sun };
}

/** Removes an object from its parent and detaches children (resources are disposed via Resources). */
export function removeObject(obj) {
  if (!obj) return;
  obj.parent?.remove(obj);
  obj.clear();
}
