// Isometric orthographic camera with orbit, zoom, reset, keyboard pan and a
// smooth follow mode.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { validCamera } from "./data.js";

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
  let followPos = null;
  let focusPos = null;
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
  controls.addEventListener("end", emit);

  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return false;
    const aspect = w / h;
    const vertical = Math.max(7.4, 10.1 / aspect) * scale;
    camera.left = -vertical * aspect;
    camera.right = vertical * aspect;
    camera.top = vertical;
    camera.bottom = -vertical;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    return true;
  }

  return {
    camera,
    controls,
    resize,
    /** Re-frames for a room whose size is `roomScale` times the base room. */
    frame(roomScale) {
      scale = Math.max(1, roomScale);
      camera.position.set(16 * scale, 16 * scale, 21 * scale);
      controls.target.set(0, 0.3, 0);
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
      focusPos = new THREE.Vector3(point.x, 0.3, point.z);
      if (Number.isFinite(zoom)) {
        camera.zoom = THREE.MathUtils.clamp(zoom, MIN_ZOOM, MAX_ZOOM);
        camera.updateProjectionMatrix();
      }
    },
    zoom(factor) {
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
      controls.reset();
      emit();
    },
    /** Pans along the ground plane in screen-relative directions. */
    pan(dx, dz) {
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
      controls.removeEventListener("end", emit);
      controls.dispose();
    },
  };
}
