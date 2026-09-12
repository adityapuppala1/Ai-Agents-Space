// Instanced rendering for the geometry the office repeats once per agent.
// A desk is 13 identical shapes and every agent gets one, so at 100 agents the
// per-agent loop built ~1 700 individual meshes; the same desks here are 13
// instanced parts split into chunks. Imports three only, never the DOM, so the
// batching can be counted by `node --test`.
import * as THREE from "three";

/**
 * Desks per InstancedMesh. One mesh for the whole floor would collapse every
 * desk into a single bounding sphere covering the entire room and destroy the
 * frustum culling the individual meshes had; a chunk keeps culling at block
 * granularity while still collapsing the draw count.
 */
export const INSTANCE_CHUNK = 24;

const tmpMatrix = new THREE.Matrix4();
const tmpPosition = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const tmpEuler = new THREE.Euler();
const tmpQuaternion = new THREE.Quaternion();
const tmpColor = new THREE.Color();
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * A set of instanced parts sharing one item count (one item = one desk, or one
 * crowd figure). Geometry and materials stay owned by the caller's Resources:
 * this only owns the per-instance buffers, which Resources cannot free.
 */
export function createInstancedField(
  group,
  { chunk = INSTANCE_CHUNK, count = 0 } = {},
) {
  const items = Math.max(0, Math.floor(count));
  const chunkSize = Math.max(1, Math.floor(chunk));
  const chunks = Math.ceil(items / chunkSize);
  const parts = new Map();

  const itemsIn = (c) => Math.min(chunkSize, items - c * chunkSize);

  return {
    chunkSize,
    count: items,
    /** Allocates one InstancedMesh per chunk for a repeated shape. */
    part(
      key,
      geometry,
      material,
      { perItem = 1, colored = false, shadows = true, dynamic = false } = {},
    ) {
      const meshes = [];
      for (let c = 0; c < chunks; c += 1) {
        const mesh = new THREE.InstancedMesh(
          geometry,
          material,
          itemsIn(c) * perItem,
        );
        mesh.castShadow = shadows;
        mesh.receiveShadow = shadows;
        if (dynamic) mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        // An instance nobody writes keeps the identity matrix, which parks a
        // full-size copy of the shape at the room origin. Start hidden.
        for (let i = 0; i < mesh.count; i += 1) mesh.setMatrixAt(i, HIDDEN);
        if (colored) {
          tmpColor.set("#ffffff");
          for (let i = 0; i < mesh.count; i += 1) mesh.setColorAt(i, tmpColor);
        }
        group.add(mesh);
        meshes.push(mesh);
      }
      parts.set(key, { perItem, colored, meshes });
      return meshes;
    },
    /** Writes one instance. `index` counts instances, not items (see perItem). */
    set(
      key,
      index,
      {
        x = 0,
        y = 0,
        z = 0,
        rx = 0,
        ry = 0,
        rz = 0,
        s = 1,
        sx = s,
        sy = s,
        sz = s,
        color = null,
      } = {},
    ) {
      const part = parts.get(key);
      if (!part) return false;
      const stride = chunkSize * part.perItem;
      const mesh = part.meshes[Math.floor(index / stride)];
      if (!mesh) return false;
      const local = index % stride;
      if (local >= mesh.count) return false;
      tmpPosition.set(x, y, z);
      tmpEuler.set(rx, ry, rz);
      tmpQuaternion.setFromEuler(tmpEuler);
      tmpScale.set(sx, sy, sz);
      tmpMatrix.compose(tmpPosition, tmpQuaternion, tmpScale);
      mesh.setMatrixAt(local, tmpMatrix);
      if (color && part.colored) mesh.setColorAt(local, tmpColor.set(color));
      return true;
    },
    /** Hides one instance without disturbing the ones after it. */
    clear(key, index) {
      const part = parts.get(key);
      if (!part) return false;
      const stride = chunkSize * part.perItem;
      const mesh = part.meshes[Math.floor(index / stride)];
      if (!mesh) return false;
      const local = index % stride;
      if (local >= mesh.count) return false;
      mesh.setMatrixAt(local, HIDDEN);
      return true;
    },
    /**
     * Records which agent owns each instance of a one-per-item part, so a
     * raycast against a batched mesh still resolves to an agent.
     */
    tag(key, agentIds) {
      const part = parts.get(key);
      if (!part) return;
      part.meshes.forEach((mesh, c) => {
        mesh.userData.instanceAgents = agentIds.slice(
          c * chunkSize,
          c * chunkSize + itemsIn(c),
        );
      });
    },
    commit() {
      for (const part of parts.values())
        for (const mesh of part.meshes) {
          mesh.instanceMatrix.needsUpdate = true;
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
          mesh.computeBoundingSphere();
        }
    },
    meshes() {
      const all = [];
      for (const part of parts.values()) all.push(...part.meshes);
      return all;
    },
    /** Frees the per-instance buffers only; shared geometry/materials survive. */
    dispose() {
      for (const part of parts.values())
        for (const mesh of part.meshes) {
          group.remove(mesh);
          mesh.dispose();
        }
      parts.clear();
    },
  };
}

/** Agent id behind a raycast hit on a batched mesh, or null. */
export function agentAt(intersection) {
  const list = intersection?.object?.userData?.instanceAgents;
  if (!Array.isArray(list)) return null;
  return list[intersection.instanceId] ?? null;
}

/** Desk geometry, expressed once instead of once per agent. */
const DESK_PARTS = [
  {
    key: "rug",
    shape: ["box", 2.1, 0.025, 2.2],
    mat: "mat",
    at: [[0, 0.005, 0.2]],
  },
  {
    key: "top",
    shape: ["box", 1.9, 0.11, 0.95],
    mat: "wood",
    at: [[0, 0.94, -0.35]],
  },
  {
    key: "leg",
    shape: ["box", 0.06, 0.89, 0.06],
    mat: "base",
    at: [
      [-0.85, 0.43, -0.72],
      [-0.85, 0.43, -0.02],
      [0.85, 0.43, -0.72],
      [0.85, 0.43, -0.02],
    ],
  },
  {
    key: "keyboard",
    shape: ["box", 0.6, 0.04, 0.26],
    mat: "metal",
    at: [[-0.1, 1.02, -0.6]],
  },
  {
    key: "stand",
    shape: ["box", 0.05, 0.25, 0.05],
    mat: "metal",
    at: [[-0.1, 1.16, -0.63]],
  },
  {
    key: "frame",
    shape: ["box", 1.05, 0.64, 0.06],
    mat: "dark",
    at: [[-0.1, 1.5, -0.63]],
  },
  {
    key: "tray",
    shape: ["box", 0.62, 0.03, 0.22],
    mat: "base",
    at: [[-0.1, 1.01, -0.1]],
  },
  {
    key: "mug",
    shape: ["cylinder", 0.075, 0.065, 0.14],
    mat: "agent",
    at: [[0.7, 1.06, -0.45]],
  },
  {
    key: "seat",
    shape: ["box", 0.6, 0.13, 0.58],
    mat: "agent",
    at: [[0, 0.59, 0.75]],
  },
  {
    key: "back",
    shape: ["box", 0.64, 0.6, 0.12],
    mat: "agent",
    at: [[0, 0.93, 1.05]],
  },
  {
    key: "chairPost",
    shape: ["cylinder", 0.05, 0.05, 0.36],
    mat: "metal",
    at: [[0, 0.33, 0.75]],
  },
  {
    key: "chairBarX",
    shape: ["box", 0.62, 0.05, 0.08],
    mat: "metal",
    at: [[0, 0.15, 0.75]],
  },
  {
    key: "chairBarZ",
    shape: ["box", 0.08, 0.05, 0.62],
    mat: "metal",
    at: [[0, 0.15, 0.75]],
  },
];

/** The count the desk field batches away, asserted by tests/office-scale.test.js. */
export const DESK_PART_COUNT = DESK_PARTS.length;
export const DESK_MESHES_PER_AGENT = DESK_PARTS.reduce(
  (sum, part) => sum + part.at.length,
  0,
);

const DESK_BASE_Y = 0.08;

function geometryFor(res, shape) {
  const [kind, ...args] = shape;
  if (kind === "cylinder") return res.cylinder(args[0], args[1], args[2]);
  return res.box(args[0], args[1], args[2]);
}

/**
 * Builds every agent desk as instanced parts. Agents in `liveScreens` keep an
 * individual monitor plane with their own canvas texture (registered in the
 * returned `monitors` map, which is what zones.updateMonitor writes to);
 * everyone else shares one instanced dim screen, so the texture count is
 * capped however large the team gets.
 */
export function buildDeskField(
  group,
  {
    layout,
    agents,
    res,
    mat,
    palette,
    liveScreens = null,
    chunk = INSTANCE_CHUNK,
    screenMaterial,
  },
) {
  const placed = agents.slice(0, layout.desks.length);
  const field = createInstancedField(group, { chunk, count: placed.length });
  const monitors = new Map();
  const agentMaterial = res.material("#ffffff");
  const materials = { ...mat, agent: agentMaterial };
  for (const part of DESK_PARTS)
    field.part(part.key, geometryFor(res, part.shape), materials[part.mat], {
      perItem: part.at.length,
      colored: part.mat === "agent",
    });

  const dim = placed.filter(
    (agent) => liveScreens && !liveScreens.has(agent.id),
  );
  if (dim.length)
    field.part(
      "dimScreen",
      res.plane(0.96, 0.55),
      res.cached(
        `dim-screen:${palette.screenBg}`,
        () => new THREE.MeshBasicMaterial({ color: palette.screenBg }),
      ),
      { shadows: false },
    );

  placed.forEach((agent, i) => {
    const desk = layout.desks[i];
    const color = agent.color ?? palette.accent;
    for (const part of DESK_PARTS)
      part.at.forEach((offset, j) => {
        field.set(part.key, i * part.at.length + j, {
          x: desk.x + offset[0],
          y: DESK_BASE_Y + offset[1],
          z: desk.z + offset[2],
          color: part.mat === "agent" ? color : null,
        });
      });
    if (!liveScreens || liveScreens.has(agent.id)) return;
    field.set("dimScreen", i, {
      x: desk.x - 0.1,
      y: DESK_BASE_Y + 1.5,
      z: desk.z - 0.595,
    });
  });
  field.tag(
    "frame",
    placed.map((agent) => agent.id),
  );
  field.commit();

  // Live monitors stay individual meshes: each carries a canvas texture that is
  // redrawn as the recorded file and action change, which an instance cannot.
  if (screenMaterial)
    placed.forEach((agent, i) => {
      if (liveScreens && !liveScreens.has(agent.id)) return;
      const desk = layout.desks[i];
      const handle = screenMaterial(agent);
      if (!handle) return;
      const screen = new THREE.Mesh(res.plane(0.96, 0.55), handle.material);
      screen.position.set(desk.x - 0.1, DESK_BASE_Y + 1.5, desk.z - 0.595);
      screen.userData.monitorAgentId = agent.id;
      group.add(screen);
      monitors.set(agent.id, { screen, texture: handle.texture, key: "" });
    });

  return {
    field,
    monitors,
    dispose() {
      field.dispose();
      for (const m of monitors.values()) group.remove(m.screen);
      monitors.clear();
    },
  };
}

const CROWD_PARTS = ["torso", "head", "cap", "ring"];

/**
 * The crowd tier: a resting figure drawn as four instanced shapes instead of
 * ~25 meshes with articulated limbs. It deliberately has no arms, legs or
 * indicators — an agent that needs attention is never in this tier.
 */
export function buildCrowdField(group, res, { chunk = INSTANCE_CHUNK } = {}) {
  let field = null;
  let capacity = 0;
  const skin = res.material("#d6a889");
  const hair = res.material("#4b4640");
  const white = res.material("#ffffff");

  function build(size) {
    field?.dispose();
    capacity = Math.max(chunk, Math.ceil(size / chunk) * chunk);
    field = createInstancedField(group, { chunk, count: capacity });
    field.part("torso", res.cylinder(0.23, 0.27, 0.52), white, {
      colored: true,
      dynamic: true,
    });
    field.part("head", res.sphere(0.255), skin, { dynamic: true });
    field.part("cap", res.sphere(0.26), hair, { dynamic: true });
    field.part(
      "ring",
      res.ring(0.47, 0.5),
      res.cached(
        "crowd-ring",
        () =>
          new THREE.MeshBasicMaterial({
            color: "#ffffff",
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.3,
          }),
      ),
      { colored: true, shadows: false, dynamic: true },
    );
  }

  return {
    get field() {
      return field;
    },
    /** `records` = [{ pos:{x,y,z}, yaw, color }], one per crowd-tier figure. */
    sync(records) {
      if (!records.length) {
        if (!field) return;
        for (let i = 0; i < capacity; i += 1)
          for (const key of CROWD_PARTS) field.clear(key, i);
        field.commit();
        return;
      }
      if (!field || records.length > capacity) build(records.length);
      for (let i = 0; i < capacity; i += 1) {
        const record = records[i];
        if (!record) {
          for (const key of CROWD_PARTS) field.clear(key, i);
          continue;
        }
        const { x, y, z } = record.pos;
        const yaw = record.renderYaw ?? record.yaw ?? 0;
        const color = record.color ?? "#8aa8bd";
        field.set("torso", i, { x, y: y + 1.02, z, ry: yaw, color });
        field.set("head", i, { x, y: y + 1.52, z, ry: yaw });
        field.set("cap", i, { x, y: y + 1.62, z, ry: yaw, sy: 0.65 });
        field.set("ring", i, { x, y: y + 0.025, z, rx: -Math.PI / 2, color });
      }
      field.commit();
    },
    meshes() {
      return field ? field.meshes() : [];
    },
    dispose() {
      field?.dispose();
      field = null;
      capacity = 0;
    },
  };
}
