import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Minus, Plus, RotateCcw, Maximize2, MousePointer2 } from "lucide-react";

const POSITIONS = [
  [-3.7, -1.7],
  [-0.2, -1.7],
  [3.3, -1.7],
  [-3.7, 1.8],
  [-0.2, 1.8],
  [3.3, 1.8],
];

function makeOffice(scene, agents) {
  const material = (color, extra = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.72, ...extra });
  const palette = {
    white: material("#f5f5ef"),
    floor: material("#dedfda"),
    wood: material("#d1ba9c"),
    metal: material("#727f8b"),
    dark: material("#303f51"),
    wall: material("#e2eaf0"),
    blue: material("#8aa8bd"),
    green: material("#6e967a"),
  };
  function mesh(geometry, mat, x, y, z, parent = scene) {
    const m = new THREE.Mesh(geometry, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }
  const box = (w, h, d, mat, x, y, z, p) =>
    mesh(new THREE.BoxGeometry(w, h, d), mat, x, y, z, p);
  const cylinder = (r, rb, h, mat, x, y, z, p) =>
    mesh(new THREE.CylinderGeometry(r, rb, h, 20), mat, x, y, z, p);
  const sphere = (r, mat, x, y, z, p) =>
    mesh(new THREE.SphereGeometry(r, 16, 12), mat, x, y, z, p);
  function textTexture(lines, bg, fg, w = 512, h = 256) {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const c = canvas.getContext("2d");
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);
    c.fillStyle = fg;
    lines.forEach((line, i) => {
      c.font = i === 0 ? "bold 32px sans-serif" : "24px monospace";
      c.fillText(line, 30, 54 + i * 40);
    });
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }
  function plant(x, z, scale = 1) {
    const g = new THREE.Group();
    g.position.set(x, 0.12, z);
    g.scale.setScalar(scale);
    scene.add(g);
    cylinder(0.28, 0.21, 0.55, palette.white, 0, 0.275, 0, g);
    cylinder(0.04, 0.055, 0.8, palette.wood, 0, 0.8, 0, g);
    for (let i = 0; i < 7; i++) {
      const angle = i * 2.4;
      const leaf = sphere(
        0.24,
        i % 2 ? palette.green : material("#88a888"),
        Math.cos(angle) * 0.22,
        0.9 + i * 0.07,
        Math.sin(angle) * 0.22,
        g,
      );
      leaf.scale.set(0.65, 1.65, 0.6);
      leaf.rotation.z = Math.cos(angle) * 0.7;
    }
  }

  box(14.5, 0.28, 10.7, palette.white, 0, -0.18, 0);
  box(14.15, 0.08, 10.3, palette.floor, 0, 0.005, 0);
  for (let i = 0; i < 23; i++)
    box(0.013, 0.012, 10.2, material("#cbd0ce"), -6.9 + i * 0.62, 0.052, 0);
  box(14.2, 3.1, 0.17, palette.wall, 0, 1.54, -5.12);
  box(0.17, 3.1, 10.3, palette.wall, -7.03, 1.54, 0);
  box(14.2, 0.12, 0.24, palette.white, 0, 3.13, -5.12);
  box(0.24, 0.12, 10.3, palette.white, -7.03, 3.13, 0);
  box(14, 0.11, 0.09, palette.white, 0, 0.1, -4.99);
  box(0.09, 0.11, 10, palette.white, -6.92, 0.1, 0);
  // Window recesses and mullions make the open room feel architectural.
  for (let i = 0; i < 3; i++) {
    const x = -0.1 + i * 2.1;
    box(
      1.94,
      1.8,
      0.07,
      material("#bad4e2", { metalness: 0.12, roughness: 0.25 }),
      x,
      1.95,
      -4.99,
    );
    box(0.055, 1.83, 0.11, palette.white, x, 1.95, -4.92);
    box(1.96, 0.06, 0.11, palette.white, x, 1.94, -4.92);
    box(2.05, 0.09, 0.3, palette.white, x, 1.03, -4.87);
  }
  const sign = new THREE.MeshBasicMaterial({
    map: textTexture(
      ["AGENT SPACE", "Good work happens together."],
      "#e2eaf0",
      "#556b82",
      640,
      150,
    ),
  });
  mesh(new THREE.PlaneGeometry(3.2, 0.75), sign, -4.45, 2.35, -4.99);
  // Whiteboard, pinned notes, and shelving on the left wall.
  box(0.08, 1.18, 2.65, palette.white, -6.91, 1.87, -2.7);
  for (let i = 0; i < 5; i++)
    box(
      0.02,
      0.16,
      0.24,
      material(["#dfbd79", "#94b6cb", "#b7c8a3"][i % 3]),
      -6.85,
      2.12 - (i % 2) * 0.34,
      -3.5 + i * 0.4,
    );
  box(0.63, 1.08, 2.4, palette.wood, -6.6, 0.59, 0.75);
  for (let i = 0; i < 3; i++)
    box(0.68, 0.06, 2.48, palette.white, -6.58, 0.13 + i * 0.48, 0.75);
  for (let i = 0; i < 9; i++)
    box(
      0.37,
      0.29 + (i % 3) * 0.06,
      0.12,
      material(["#849bab", "#d5bca3", "#889c83"][i % 3]),
      -6.43,
      0.78,
      -0.15 + i * 0.2,
    );
  plant(-6.1, -4.1, 1.2);
  plant(6.1, -4.1, 1.15);
  plant(-6.1, 4, 0.95);
  plant(6.2, 3.9, 1.3);
  // Quiet lounge nook, with a floor lamp and a round coffee table.
  box(1.1, 0.5, 2.3, material("#9eaebc"), 5.85, 0.42, -0.9);
  box(0.3, 0.8, 2.4, palette.blue, 6.36, 0.77, -0.9);
  for (const z of [-2.02, 0.22])
    box(1.18, 0.56, 0.18, palette.blue, 5.89, 0.75, z);
  cylinder(0.42, 0.42, 0.08, palette.wood, 5.8, 0.65, 1.1);
  cylinder(0.06, 0.09, 0.58, palette.metal, 5.8, 0.31, 1.1);
  cylinder(0.23, 0.23, 0.05, palette.metal, 6.15, 0.12, -2.8);
  cylinder(0.025, 0.025, 1.8, palette.metal, 6.15, 1, -2.8);
  cylinder(0.22, 0.37, 0.36, palette.white, 6.15, 1.95, -2.8);
  const figures = [];
  agents.forEach((agent, i) => {
    const [x, z] = POSITIONS[i];
    const group = new THREE.Group();
    group.position.set(x, 0.08, z);
    scene.add(group);
    const accent = material(agent.color);
    box(
      2.75,
      0.025,
      2.8,
      material(i < 3 ? "#c2cfd7" : "#c9d3d8"),
      0,
      0.005,
      0.25,
      group,
    );
    box(2.45, 0.13, 1.16, palette.wood, 0, 0.94, -0.2, group);
    for (const dx of [-1.05, 1.05])
      for (const dz of [-0.67, 0.23])
        box(0.065, 0.89, 0.065, palette.white, dx, 0.43, dz, group);
    box(0.8, 0.05, 0.3, palette.metal, -0.17, 1.04, -0.46, group);
    box(0.055, 0.27, 0.055, palette.metal, -0.17, 1.19, -0.49, group);
    box(1.15, 0.69, 0.07, palette.dark, -0.17, 1.54, -0.49, group);
    const screen = new THREE.MeshBasicMaterial({
      map: textTexture(
        [
          i === 3
            ? "✓  TEST SUITE"
            : i === 0
              ? "WORKSPACE / PLAN"
              : "> agent.run()",
          "  task: workspace",
          "  status: active",
          "  ███████░░░",
        ],
        "#263748",
        agent.color,
      ),
    });
    mesh(
      new THREE.PlaneGeometry(1.06, 0.6),
      screen,
      -0.17,
      1.54,
      -0.447,
      group,
    );
    box(0.72, 0.035, 0.27, palette.white, -0.17, 1.027, 0.12, group);
    for (let row = 0; row < 3; row++)
      for (let key = 0; key < 8; key++)
        box(
          0.06,
          0.006,
          0.045,
          palette.metal,
          -0.45 + key * 0.08,
          1.049,
          0.04 + row * 0.065,
          group,
        );
    cylinder(0.085, 0.075, 0.16, accent, 0.85, 1.08, -0.35, group);
    box(0.29, 0.035, 0.36, material("#b4c2cf"), 0.85, 1.029, 0.08, group);
    box(0.67, 0.15, 0.66, accent, 0, 0.59, 0.9, group);
    box(0.72, 0.68, 0.14, accent, 0, 0.94, 1.23, group);
    cylinder(0.06, 0.06, 0.38, palette.metal, 0, 0.33, 0.9, group);
    box(0.7, 0.055, 0.09, palette.metal, 0, 0.15, 0.9, group);
    box(0.09, 0.055, 0.7, palette.metal, 0, 0.15, 0.9, group);
    const person = new THREE.Group();
    group.add(person);
    const skin = material(
      ["#e5bd9f", "#bd8e74", "#e3b995", "#d6a889", "#a87961", "#ecc8a8"][i],
    );
    const hair = material(
      ["#60534b", "#343e50", "#493d38", "#8f704b", "#48413f", "#665645"][i],
    );
    const torso = cylinder(0.23, 0.27, 0.52, accent, 0, 1.02, 0.82, person);
    sphere(0.255, skin, 0, 1.52, 0.79, person);
    const cap = sphere(0.26, hair, 0, 1.62, 0.83, person);
    cap.scale.y = 0.65;
    if (i === 1 || i === 5) box(0.44, 0.34, 0.17, hair, 0, 1.45, 0.99, person);
    for (const dx of [-0.16, 0.16]) {
      box(0.16, 0.36, 0.17, palette.dark, dx, 0.46, 0.6, person);
      box(0.18, 0.1, 0.3, palette.dark, dx, 0.27, 0.53, person);
      const arm = cylinder(
        0.065,
        0.075,
        0.4,
        accent,
        dx * 1.6,
        1.06,
        0.57,
        person,
      );
      arm.rotation.x = -1.15;
      sphere(0.075, skin, dx * 1.6, 0.99, 0.36, person);
    }
    const ring = mesh(
      new THREE.RingGeometry(0.47, 0.5, 48),
      new THREE.MeshBasicMaterial({
        color: agent.color,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.5,
      }),
      0,
      0.025,
      0.9,
      group,
    );
    ring.rotation.x = -Math.PI / 2;
    group.traverse((obj) => {
      if (obj.isMesh) obj.userData.agentId = agent.id;
    });
    figures.push({
      id: agent.id,
      group,
      person,
      torso,
      ring,
      anchor: new THREE.Vector3(x, 2.35, z + 0.65),
    });
  });
  return figures;
}

export default function Office({ agents, selected, onSelect, running }) {
  const host = useRef(null),
    sceneApi = useRef(null),
    labels = useRef({}),
    state = useRef({ agents, selected, running, onSelect });
  const [failed, setFailed] = useState(false);
  state.current = { agents, selected, running, onSelect };
  useEffect(() => {
    const container = host.current;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor("#edf2f6", 0);
    container.prepend(renderer.domElement);
    renderer.domElement.setAttribute(
      "aria-label",
      "Interactive 3D office. Use the agent buttons to inspect tasks.",
    );
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-10, 10, 7, -7, 0.1, 100);
    camera.position.set(16, 16, 21);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0.3, 0);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minZoom = 0.65;
    controls.maxZoom = 2;
    controls.minPolarAngle = 0.25;
    controls.maxPolarAngle = 1.22;
    controls.update();
    controls.saveState();
    scene.add(new THREE.HemisphereLight("#ffffff", "#9aa9b6", 2.7));
    const sun = new THREE.DirectionalLight("#fff7e6", 3.1);
    sun.position.set(1, 16, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, {
      left: -12,
      right: 12,
      top: 12,
      bottom: -12,
    });
    sun.shadow.normalBias = 0.04;
    scene.add(sun);
    const figures = makeOffice(scene, state.current.agents);
    const resize = () => {
      const w = container.clientWidth,
        h = container.clientHeight;
      if (!w || !h) return;
      const aspect = w / h;
      const vertical = Math.max(7.4, 10.1 / aspect);
      camera.left = -vertical * aspect;
      camera.right = vertical * aspect;
      camera.top = vertical;
      camera.bottom = -vertical;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    const raycaster = new THREE.Raycaster(),
      mouse = new THREE.Vector2();
    let down;
    const pointerdown = (e) => {
      down = [e.clientX, e.clientY];
    };
    const pointerup = (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5)
        return;
      const r = renderer.domElement.getBoundingClientRect();
      mouse.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      );
      raycaster.setFromCamera(mouse, camera);
      const hit = raycaster.intersectObjects(
        figures.map((f) => f.group),
        true,
      )[0];
      if (hit) state.current.onSelect(hit.object.userData.agentId);
    };
    renderer.domElement.addEventListener("pointerdown", pointerdown);
    renderer.domElement.addEventListener("pointerup", pointerup);
    const lost = (event) => {
      event.preventDefault();
      setFailed(true);
    };
    renderer.domElement.addEventListener("webglcontextlost", lost);
    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
    let frame,
      last = 0;
    function render(time) {
      frame = requestAnimationFrame(render);
      if (document.hidden || time - last < 32) return;
      last = time;
      controls.update();
      figures.forEach((f, i) => {
        const agent = state.current.agents.find((a) => a.id === f.id);
        const active = agent && !["IDLE", "BLOCKED"].includes(agent.state);
        f.person.rotation.x =
          active && state.current.running && !reduceMotion.matches
            ? Math.sin(time * 0.005 + i) * 0.022
            : 0;
        f.ring.material.opacity = state.current.selected === f.id ? 1 : 0.3;
        f.ring.scale.setScalar(state.current.selected === f.id ? 1.3 : 1);
        const point = f.anchor.clone().project(camera);
        const label = labels.current[f.id];
        if (label) {
          label.style.left = `${(point.x * 0.5 + 0.5) * container.clientWidth}px`;
          label.style.top = `${(-point.y * 0.5 + 0.5) * container.clientHeight}px`;
          label.style.visibility = point.z > 1 ? "hidden" : "visible";
        }
      });
      renderer.render(scene, camera);
    }
    frame = requestAnimationFrame(render);
    sceneApi.current = {
      zoom: (factor) => {
        camera.zoom = THREE.MathUtils.clamp(camera.zoom * factor, 0.65, 2);
        camera.updateProjectionMatrix();
      },
      reset: () => controls.reset(),
    };
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener("pointerdown", pointerdown);
      renderer.domElement.removeEventListener("pointerup", pointerup);
      renderer.domElement.removeEventListener("webglcontextlost", lost);
      const geometries = new Set(),
        materials = new Set(),
        textures = new Set();
      scene.traverse((obj) => {
        if (obj.geometry) geometries.add(obj.geometry);
        if (obj.material)
          for (const m of [].concat(obj.material)) {
            materials.add(m);
            if (m.map) textures.add(m.map);
          }
      });
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
      textures.forEach((t) => t.dispose());
      renderer.dispose();
      renderer.domElement.remove();
      sceneApi.current = null;
    };
  }, []);
  return (
    <div className="office-wrap">
      <div className="office-meta">
        <span>
          <i className="dot blue" /> Development studio
        </span>
        <span>FLOOR 01</span>
      </div>
      <div className="office-canvas" ref={host}>
        {!failed &&
          agents.map((agent) => (
            <button
              key={agent.id}
              ref={(el) => {
                labels.current[agent.id] = el;
              }}
              className={`scene-label ${selected === agent.id ? "selected" : ""}`}
              onClick={() => onSelect(agent.id)}
              aria-label={`Inspect ${agent.name}`}
              style={{ "--agent-color": agent.color }}
            >
              <i
                className={`dot ${agent.state === "BLOCKED" ? "amber" : agent.state === "IDLE" ? "gray" : "green"}`}
              />
              {agent.name}
              <span>
                {agent.state === "IDLE"
                  ? "Available"
                  : agent.state.toLowerCase()}
              </span>
            </button>
          ))}
        {failed && (
          <div className="scene-fallback">
            <h3>The team is still here.</h3>
            <p>
              3D rendering is unavailable in this browser. Select any agent
              below to manage their work.
            </p>
            {agents.map((a) => (
              <button key={a.id} onClick={() => onSelect(a.id)}>
                {a.name} · {a.role}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="office-bottom">
        <span>
          <MousePointer2 size={13} /> Drag to orbit · Scroll to zoom
        </span>
        <div className="camera-tools">
          <button
            title="Zoom out"
            aria-label="Zoom out"
            onClick={() => sceneApi.current?.zoom(0.9)}
          >
            <Minus size={16} />
          </button>
          <button
            title="Zoom in"
            aria-label="Zoom in"
            onClick={() => sceneApi.current?.zoom(1.1)}
          >
            <Plus size={16} />
          </button>
          <span />
          <button
            title="Reset camera"
            aria-label="Reset camera"
            onClick={() => sceneApi.current?.reset()}
          >
            <RotateCcw size={15} />
          </button>
          <button
            title="Expand office"
            aria-label="Expand office"
            onClick={() => {
              const el = host.current.parentElement;
              if (document.fullscreenElement) document.exitFullscreen?.();
              else el.requestFullscreen?.().catch(() => {});
            }}
          >
            <Maximize2 size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
