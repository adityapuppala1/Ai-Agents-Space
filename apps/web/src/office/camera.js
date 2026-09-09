// Isometric orthographic camera with orbit, zoom, reset, keyboard pan and a
// smooth follow mode.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const MIN_ZOOM = 0.65;
const MAX_ZOOM = 2.2;

export function createCamera(renderer, container) {
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
  const delta = new THREE.Vector3();
  const right = new THREE.Vector3();
  const forward = new THREE.Vector3();

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
    zoom(factor) {
      camera.zoom = THREE.MathUtils.clamp(
        camera.zoom * factor,
        MIN_ZOOM,
        MAX_ZOOM,
      );
      camera.updateProjectionMatrix();
    },
    reset() {
      followPos = null;
      controls.reset();
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
    },
    setFollow(position) {
      followPos = position ? position.clone() : null;
    },
    isFollowing() {
      return followPos !== null;
    },
    update(reducedMotion) {
      if (followPos) {
        delta.set(followPos.x, 0.3, followPos.z).sub(controls.target);
        const k = reducedMotion ? 1 : 0.08;
        delta.multiplyScalar(k);
        controls.target.add(delta);
        camera.position.add(delta);
      }
      controls.update();
    },
    dispose() {
      controls.dispose();
    },
  };
}
