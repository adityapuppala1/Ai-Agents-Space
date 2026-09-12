// Isometric orthographic camera with orbit, zoom, reset, keyboard pan and a
// smooth follow mode.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { roomExtents, roomFrustum, validCamera } from "./data.js";

const MIN_ZOOM = 0.65;
const MAX_ZOOM = 2.2;

export function createCamera(renderer, container, { onChange } = {}) {
  const camera = new THREE.OrthographicCamera(-10, 10, 7, -7, 0.1, 400);
  camera.position.set(16, 16, 21);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.3, 0);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minZoom = MIN_ZOOM;
  controls.maxZoom = MAX_ZOOM;
  controls.minPolarAngle = 0.25;
  controls.maxPolarAngle = 1.22;
  controls.update();
  controls.saveState();

  let scale = 1;
  // Projected size of the room from the default view (set by frame()).
  let extents = null;
  // The framing Reset returns to, when frame() left the viewer's own view.
  let home;
  let followPos = null;
  let focusPos = null;
  // True once the viewer moves the camera this session: a new framing (a
  // conference room opening) then waits for Reset instead of taking the
  // view away from what they were looking at.
  let custom = false;
  // A framing change in progress: { start, from, to, extents }.
  let transition = null;
  const delta = new THREE.Vector3();
  const right = new THREE.Vector3();
  const forward = new THREE.Vector3();

  const emit = () => {
    if (!onChange) return;
    onChange({
      position: camera.position.toArray(),
      target: controls.target.toArray(),
      zoom: camera.zoom,
    });
  };
  const start = () => {
    custom = true;
    transition = null;
  };
  controls.addEventListener("start", start);
  controls.addEventListener("end", emit);

  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return false;
    const aspect = w / h;
    // Fit the room's real outline between the overlays; the fixed rule is the
    // fallback before a room has been framed.
    const fitted = roomFrustum(extents, w, h);
    if (fitted) Object.assign(camera, fitted);
    else {
      const vertical = Math.max(7.4, 10.1 / aspect) * scale;
      camera.left = -vertical * aspect;
      camera.right = vertical * aspect;
      camera.top = vertical;
      camera.bottom = -vertical;
    }
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    return true;
  }

  return {
    camera,
    controls,
    resize,
    /**
     * Re-frames for a room whose size is `roomScale` times the base room.
     * `room` ({ width, depth, bounds? }) lets the frustum fit the room's
     * outline; `bounds` adds the conference wing, and the view centres on
     * the whole. `smooth` glides there (a room opening) instead of cutting.
     * A view the viewer chose is left alone: Reset goes to the new framing.
     */
    frame(roomScale, room = null, { smooth = false, reducedMotion = false } = {}) {
      scale = Math.max(1, roomScale);
      const b = room?.bounds;
      const tx = b ? (b.minX + b.maxX) / 2 : 0;
      const tz = b ? (b.minZ + b.maxZ) / 2 : 0;
      const target = new THREE.Vector3(tx, 0.3, tz);
      const position = new THREE.Vector3(
        tx + 16 * scale,
        16 * scale,
        tz + 21 * scale,
      );
      const next =
        room && room.width > 0 && room.depth > 0
          ? roomExtents(room, position.toArray(), target.toArray())
          : null;
      controls.target0.copy(target);
      controls.position0.copy(position);
      home = next;
      // A view left looking at nothing (the room it was on has closed) goes
      // back to the whole scene, zoom and all; any other chosen view stays.
      const area = b ?? {
        minX: -(room?.width ?? 0) / 2,
        maxX: (room?.width ?? 0) / 2,
        minZ: -(room?.depth ?? 0) / 2,
        maxZ: (room?.depth ?? 0) / 2,
      };
      const t = controls.target;
      const lost =
        custom &&
        !followPos &&
        Boolean(room) &&
        (t.x < area.minX - 1 ||
          t.x > area.maxX + 1 ||
          t.z < area.minZ - 1 ||
          t.z > area.maxZ + 1);
      if ((custom || followPos) && !lost) return;
      custom = false;
      focusPos = null;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (smooth && !reducedMotion && w && h) {
        transition = {
          start: performance.now(),
          from: {
            target: controls.target.clone(),
            position: camera.position.clone(),
            left: camera.left,
            right: camera.right,
            top: camera.top,
            bottom: camera.bottom,
            zoom: camera.zoom,
          },
          to: {
            target,
            position,
            frustum: roomFrustum(next, w, h),
            zoom: lost ? 1 : camera.zoom,
          },
          extents: next,
        };
        return;
      }
      transition = null;
      camera.position.copy(position);
      controls.target.copy(target);
      if (lost) camera.zoom = 1;
      extents = next;
      controls.update();
      controls.saveState();
      resize();
    },
    /** Current camera state, for persistence. */
    getState() {
      return {
        position: camera.position.toArray(),
        target: controls.target.toArray(),
        zoom: camera.zoom,
      };
    },
    /** Restores a previously saved state. Invalid input is ignored. */
    setState(state) {
      if (!validCamera(state)) return false;
      followPos = null;
      focusPos = null;
      transition = null;
      camera.position.fromArray(state.position);
      controls.target.fromArray(state.target);
      camera.zoom = THREE.MathUtils.clamp(state.zoom, MIN_ZOOM, MAX_ZOOM);
      camera.updateProjectionMatrix();
      controls.update();
      return true;
    },
    /** Smoothly centres a room (selectable rooms, presentation stops). */
    focus(point, zoom) {
      if (!point) {
        focusPos = null;
        return;
      }
      followPos = null;
      custom = true;
      transition = null;
      focusPos = new THREE.Vector3(point.x, 0.3, point.z);
      if (Number.isFinite(zoom)) {
        camera.zoom = THREE.MathUtils.clamp(zoom, MIN_ZOOM, MAX_ZOOM);
        camera.updateProjectionMatrix();
      }
    },
    zoom(factor) {
      custom = true;
      transition = null;
      camera.zoom = THREE.MathUtils.clamp(
        camera.zoom * factor,
        MIN_ZOOM,
        MAX_ZOOM,
      );
      camera.updateProjectionMatrix();
      emit();
    },
    reset() {
      followPos = null;
      focusPos = null;
      transition = null;
      custom = false;
      controls.reset();
      if (home !== undefined) {
        extents = home;
        home = undefined;
        resize();
      }
      emit();
    },
    /** Pans along the ground plane in screen-relative directions. */
    pan(dx, dz) {
      custom = true;
      transition = null;
      camera.getWorldDirection(forward);
      forward.y = 0;
      forward.normalize();
      right.crossVectors(forward, camera.up).normalize();
      delta
        .set(0, 0, 0)
        .addScaledVector(right, dx)
        .addScaledVector(forward, dz);
      controls.target.add(delta);
      camera.position.add(delta);
      controls.update();
      emit();
    },
    setFollow(position) {
      followPos = position ? position.clone() : null;
    },
    isFollowing() {
      return followPos !== null;
    },
    update(reducedMotion) {
      if (transition) {
        const t = Math.min(1, (performance.now() - transition.start) / 900);
        const k = t * t * (3 - 2 * t);
        const { from, to } = transition;
        controls.target.lerpVectors(from.target, to.target, k);
        camera.position.lerpVectors(from.position, to.position, k);
        if (to.frustum) {
          camera.left = from.left + (to.frustum.left - from.left) * k;
          camera.right = from.right + (to.frustum.right - from.right) * k;
          camera.top = from.top + (to.frustum.top - from.top) * k;
          camera.bottom = from.bottom + (to.frustum.bottom - from.bottom) * k;
        }
        camera.zoom = from.zoom + (to.zoom - from.zoom) * k;
        camera.updateProjectionMatrix();
        if (t >= 1) {
          extents = transition.extents;
          home = undefined;
          transition = null;
          controls.update();
          controls.saveState();
          resize();
        }
      }
      const goal = followPos ?? focusPos;
      if (goal) {
        delta.set(goal.x, 0.3, goal.z).sub(controls.target);
        const k = reducedMotion ? 1 : 0.08;
        if (focusPos && !followPos && delta.lengthSq() < 0.0004) {
          focusPos = null;
          emit();
        }
        delta.multiplyScalar(k);
        controls.target.add(delta);
        camera.position.add(delta);
      }
      controls.update();
    },
    dispose() {
      controls.removeEventListener("start", start);
      controls.removeEventListener("end", emit);
      controls.dispose();
    },
  };
}
