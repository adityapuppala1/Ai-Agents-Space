/**
 * Living office (Three.js). Renders every agent as a figure that moves to the
 * zone matching its recorded activity. Walking is a visual transition only.
 *
 * Props
 * - agents: [{ id, name, color, initials, state, activity, currentFile,
 *     currentAction, provider, runStatus, runMode, taskTitle, role?,
 *     completed?, activityProvenance? }]. When `activity` is missing the legacy
 *     `state` is used (CODING/ANALYZING/TESTING/DEBUGGING/RESEARCHING/BLOCKED/IDLE).
 * - selected: agent id highlighted in the scene.
 * - onSelect(agentId): called from figure clicks, label buttons, minimap and the fallback list.
 * - running: boolean; false freezes ambient motion (demo paused).
 * - theme: "studio" | "operations" (default "studio"). Switching rebuilds decoration only.
 * - graphics: "low" | "medium" | "high" (default "medium"): shadows, pixel ratio, particles, frame cap.
 * - followAgentId: agent id the camera should track smoothly (null = free camera).
 * - reducedMotion: boolean; disables walking tweens, bobbing, particles.
 * - onZoneHover?(agentId|null): hover over a figure (3D canvas or minimap).
 *
 * Keyboard (focus the canvas area): arrows pan, + / - zoom, F toggles follow of
 * the selected agent. Controls: Zoom in, Zoom out, Reset camera, Fullscreen.
 * Accessibility: every agent has an "Inspect <name>" button; when WebGL is
 * unavailable a `.scene-fallback` list replaces the canvas.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import {
  Minus,
  Plus,
  RotateCcw,
  Maximize2,
  MousePointer2,
  Crosshair,
} from "lucide-react";
import {
  Resources,
  createRenderer,
  createLights,
  applyGraphics,
} from "./office/scene.js";
import { getTheme, buildRoom } from "./office/themes.js";
import { computeLayout, buildZones, zoneForActivity } from "./office/zones.js";
import {
  createFigure,
  applyAgentState,
  animateFigure,
  createCelebration,
  activityOf,
  activityLabel,
  providerLabel,
  statusTone,
} from "./office/avatars.js";
import { createCamera } from "./office/camera.js";
import { createMinimap } from "./office/minimap.js";
import "./styles/office.css";

const IDLE_CLUSTER_THRESHOLD = 12;
const TYPING = new Set(["CODING", "COMMANDING", "DEBUGGING"]);
const SLOT_COUNT = 8;

export default function Office({
  agents = [],
  selected,
  onSelect,
  running = true,
  theme = "studio",
  graphics = "medium",
  followAgentId = null,
  reducedMotion = false,
  onZoneHover,
}) {
  const host = useRef(null);
  const minimapRef = useRef(null);
  const clusterRef = useRef(null);
  const labels = useRef({});
  const api = useRef(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // undefined = defer to the followAgentId prop; null = user turned follow off; id = user follow.
  const [localFollow, setLocalFollow] = useState(undefined);
  const followId = localFollow === undefined ? followAgentId : localFollow;
  const toggleFollow = () =>
    setLocalFollow(followId != null ? null : (selected ?? null));
  const themeDef = getTheme(theme);
  const state = useRef({});
  state.current = {
    agents,
    selected,
    running,
    onSelect,
    theme,
    graphics,
    followId,
    reducedMotion,
    onZoneHover,
    expanded,
  };
  const agentKey = useMemo(() => agents.map((a) => a.id).join("|"), [agents]);
  const idleCount = agents.filter((a) => activityOf(a) === "IDLE").length;
  const clustering = idleCount > IDLE_CLUSTER_THRESHOLD && !expanded;

  useEffect(() => {
    setLocalFollow(undefined);
  }, [followAgentId]);

  useEffect(() => {
    const container = host.current;
    const renderer = createRenderer(container);
    if (!renderer) {
      setFailed(true);
      return undefined;
    }
    const scene = new THREE.Scene();
    const cam = createCamera(renderer, container);
    const roomGroup = new THREE.Group();
    const zoneGroup = new THREE.Group();
    const figureGroup = new THREE.Group();
    scene.add(roomGroup, zoneGroup, figureGroup);
    const figureRes = new Resources();
    let roomRes = new Resources();
    let lights = createLights(scene, getTheme(state.current.theme), 1);
    let preset = applyGraphics(
      renderer,
      scene,
      lights.sun,
      state.current.graphics,
    );
    let layout = computeLayout(state.current.agents.length);
    let zones = null;
    let figures = new Map();
    let particles = [];
    let visible = true;
    let cameraScale = 0;
    let caretOn = true;
    const minimap = minimapRef.current
      ? createMinimap(minimapRef.current, {
          onSelect: (id) => state.current.onSelect?.(id),
          onHover: (id) => state.current.onZoneHover?.(id),
        })
      : null;

    function rebuild() {
      const themeDef = getTheme(state.current.theme);
      roomGroup.clear();
      zoneGroup.clear();
      roomRes.dispose();
      roomRes = new Resources();
      layout = computeLayout(state.current.agents.length);
      buildRoom(roomGroup, themeDef, layout, roomRes);
      zones = buildZones(
        zoneGroup,
        themeDef,
        layout,
        state.current.agents,
        roomRes,
      );
      scene.remove(lights.hemi, lights.sun);
      lights.sun.shadow.map?.dispose();
      lights.sun.dispose();
      lights.hemi.dispose();
      lights = createLights(scene, themeDef, layout.scale);
      preset = applyGraphics(
        renderer,
        scene,
        lights.sun,
        state.current.graphics,
      );
      minimap?.setLayout(layout);
      if (layout.scale !== cameraScale) {
        cameraScale = layout.scale;
        cam.frame(layout.scale);
      }
      // Force monitors to redraw with current content.
      sync(true);
    }

    function sync(force = false) {
      const { agents, reducedMotion, expanded } = state.current;
      const now = performance.now();
      const ids = new Set(agents.map((a) => a.id));
      for (const [id, fig] of figures) {
        if (!ids.has(id)) {
          figureGroup.remove(fig.group);
          figures.delete(id);
        }
      }
      const idle = agents.filter((a) => activityOf(a) === "IDLE");
      const cluster = idle.length > IDLE_CLUSTER_THRESHOLD && !expanded;
      const slots = {};
      const testing = [];
      const reviewing = [];
      let clustered = 0;
      agents.forEach((agent, i) => {
        let fig = figures.get(agent.id);
        if (!fig) {
          fig = createFigure(agent, i, figureRes);
          fig.color = agent.color;
          figures.set(agent.id, fig);
          figureGroup.add(fig.group);
        }
        const activity = activityOf(agent);
        const zoneId = zoneForActivity(activity);
        let target;
        let isClustered = false;
        if (cluster && activity === "IDLE") {
          const slot = layout.zones.breakArea.slots[clustered % SLOT_COUNT];
          target = { ...slot, zone: "breakArea" };
          isClustered = true;
          clustered++;
        } else if (zoneId === "desk") {
          target = {
            ...(layout.desks[i] ?? layout.desks[layout.desks.length - 1]),
            zone: "desk",
          };
        } else {
          slots[zoneId] = (slots[zoneId] ?? 0) + 1;
          const slot =
            layout.zones[zoneId].slots[(slots[zoneId] - 1) % SLOT_COUNT];
          target = { ...slot, zone: zoneId };
        }
        fig.clustered = isClustered;
        fig.group.visible = !isClustered;
        const completed = applyAgentState(fig, agent, target, {
          now,
          reducedMotion,
        });
        if (completed && preset.particles && !reducedMotion) {
          fig.celebrateUntil = now + 900;
          const burst = createCelebration(fig.pos, agent.color, now);
          scene.add(burst.points);
          particles.push(burst);
        }
        if (activity === "TESTING") testing.push(agent.name);
        if (activity === "REVIEWING") reviewing.push(agent.name);
        if (force) {
          const m = zones?.monitors.get(agent.id);
          if (m) m.key = "";
        }
        zones?.updateMonitor(agent.id, agent, {
          typing: TYPING.has(activity),
          caret: caretOn,
          activityLabel: activityLabel(agent),
        });
      });
      zones?.updateQa(testing);
      zones?.updateReview(reviewing);
      zones?.updateCluster(clustered);
    }

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    function pick(event) {
      const r = renderer.domElement.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      mouse.set(
        ((event.clientX - r.left) / r.width) * 2 - 1,
        -((event.clientY - r.top) / r.height) * 2 + 1,
      );
      raycaster.setFromCamera(mouse, cam.camera);
      const hit = raycaster.intersectObjects(figureGroup.children, true)[0];
      return hit?.object.userData.agentId ?? null;
    }
    let down = null;
    let hovered = null;
    let lastMove = 0;
    const pointerdown = (e) => {
      down = [e.clientX, e.clientY];
    };
    const pointerup = (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5)
        return;
      const id = pick(e);
      if (id != null) state.current.onSelect?.(id);
    };
    const pointermove = (e) => {
      if (!state.current.onZoneHover || e.timeStamp - lastMove < 80) return;
      lastMove = e.timeStamp;
      const id = pick(e);
      if (id !== hovered) {
        hovered = id;
        state.current.onZoneHover(id);
      }
      renderer.domElement.style.cursor = id != null ? "pointer" : "";
    };
    const lost = (event) => {
      event.preventDefault();
      setFailed(true);
    };
    renderer.domElement.addEventListener("pointerdown", pointerdown);
    renderer.domElement.addEventListener("pointerup", pointerup);
    renderer.domElement.addEventListener("pointermove", pointermove);
    renderer.domElement.addEventListener("webglcontextlost", lost);

    const resizeObserver = new ResizeObserver(() => cam.resize());
    resizeObserver.observe(container);
    const intersection =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver((entries) => {
            visible = entries.some((e) => e.isIntersecting);
          })
        : null;
    intersection?.observe(container);

    const anchor = new THREE.Vector3();
    let frame = 0;
    let last = 0;
    let caretAt = 0;
    function place(el, x, y, z) {
      anchor.set(x, y, z).project(cam.camera);
      el.style.left = `${(anchor.x * 0.5 + 0.5) * container.clientWidth}px`;
      el.style.top = `${(-anchor.y * 0.5 + 0.5) * container.clientHeight}px`;
      el.style.visibility = anchor.z > 1 ? "hidden" : "visible";
    }
    function loop(time) {
      frame = requestAnimationFrame(loop);
      if (document.hidden) return;
      // Off-screen: no GPU work, but keep labels placed at a slow tick so the
      // accessible buttons stay positioned when the canvas scrolls back in.
      if (time - last < (visible ? preset.frameMs : 500)) return;
      const dt = Math.min(0.1, (time - last) / 1000 || 0.016);
      last = time;
      const { selected, running, reducedMotion, followId, agents } =
        state.current;
      if (time - caretAt > 500) {
        caretAt = time;
        caretOn = !caretOn;
        for (const agent of agents) {
          if (TYPING.has(activityOf(agent)))
            zones?.updateMonitor(agent.id, agent, {
              typing: true,
              caret: caretOn && !reducedMotion,
              activityLabel: activityLabel(agent),
            });
        }
      }
      const followed = followId != null ? figures.get(followId) : null;
      cam.setFollow(followed && !followed.clustered ? followed.pos : null);
      cam.update(reducedMotion);
      for (const fig of figures.values()) {
        if (fig.clustered) continue;
        animateFigure(fig, time, {
          reducedMotion,
          running,
          selected: selected === fig.id,
        });
        const label = labels.current[fig.id];
        if (label) place(label, fig.pos.x, 2.4, fig.pos.z);
      }
      for (const [id, label] of Object.entries(labels.current)) {
        if (label && figures.get(id)?.clustered)
          label.style.visibility = "hidden";
      }
      if (clusterRef.current) {
        const z = layout.zones.breakArea;
        place(clusterRef.current, z.x, 2.5, z.z + 0.3);
      }
      particles = particles.filter((p) => {
        const alive = p.update(time, dt);
        if (!alive) p.dispose();
        return alive;
      });
      minimap?.draw({
        figures: figures.values(),
        selected,
        theme: getTheme(state.current.theme),
        clusterCount: [...figures.values()].filter((f) => f.clustered).length,
        clusterZone: layout.zones.breakArea,
      });
      if (visible) renderer.render(scene, cam.camera);
    }
    rebuild();
    frame = requestAnimationFrame(loop);

    api.current = {
      rebuild,
      sync,
      zoom: (f) => cam.zoom(f),
      reset: () => cam.reset(),
      pan: (dx, dz) => cam.pan(dx * layout.scale, dz * layout.scale),
      setGraphics: () => {
        preset = applyGraphics(
          renderer,
          scene,
          lights.sun,
          state.current.graphics,
        );
        if (!preset.particles) {
          particles.forEach((p) => p.dispose());
          particles = [];
        }
      },
    };
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      intersection?.disconnect();
      renderer.domElement.removeEventListener("pointerdown", pointerdown);
      renderer.domElement.removeEventListener("pointerup", pointerup);
      renderer.domElement.removeEventListener("pointermove", pointermove);
      renderer.domElement.removeEventListener("webglcontextlost", lost);
      minimap?.dispose();
      cam.dispose();
      particles.forEach((p) => p.dispose());
      roomRes.dispose();
      figureRes.dispose();
      lights.sun.shadow.map?.dispose();
      lights.sun.dispose();
      lights.hemi.dispose();
      scene.clear();
      renderer.dispose();
      renderer.domElement.remove();
      api.current = null;
    };
  }, []);

  useEffect(() => {
    api.current?.rebuild();
  }, [theme, agentKey]);

  useEffect(() => {
    api.current?.sync();
  }, [agents, expanded, reducedMotion]);

  useEffect(() => {
    api.current?.setGraphics();
  }, [graphics]);

  const keydown = (e) => {
    const a = api.current;
    if (!a) return;
    const step = 0.6;
    switch (e.key) {
      case "ArrowLeft":
        a.pan(-step, 0);
        break;
      case "ArrowRight":
        a.pan(step, 0);
        break;
      case "ArrowUp":
        a.pan(0, step);
        break;
      case "ArrowDown":
        a.pan(0, -step);
        break;
      case "+":
      case "=":
        a.zoom(1.1);
        break;
      case "-":
      case "_":
        a.zoom(0.9);
        break;
      case "f":
      case "F":
        toggleFollow();
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const followedAgent = agents.find((a) => a.id === followId);
  const clusteredCount = clustering ? idleCount : 0;

  return (
    <div className={`office-wrap office-theme-${themeDef.id}`}>
      <div className="office-meta">
        <span>
          <i className="dot blue" /> {themeDef.label}
          {followedAgent && (
            <em className="office-follow">Following {followedAgent.name}</em>
          )}
        </span>
        <span>{themeDef.floorLabel}</span>
      </div>
      <div
        className="office-canvas"
        ref={host}
        role="application"
        tabIndex={failed ? -1 : 0}
        onKeyDown={keydown}
        aria-label="Office scene. Arrow keys pan, plus and minus zoom, F follows the selected agent."
      >
        {!failed &&
          agents.map((agent) => {
            const tone = statusTone(agent);
            const inferred = agent.activityProvenance === "inferred";
            return (
              <button
                key={agent.id}
                ref={(el) => {
                  labels.current[agent.id] = el;
                }}
                className={`scene-label tone-${tone} ${selected === agent.id ? "selected" : ""}`}
                onClick={() => onSelect?.(agent.id)}
                onMouseEnter={() => onZoneHover?.(agent.id)}
                onMouseLeave={() => onZoneHover?.(null)}
                aria-label={`Inspect ${agent.name}`}
                title={
                  agent.taskTitle
                    ? `${activityLabel(agent)} · ${agent.taskTitle}`
                    : activityLabel(agent)
                }
                style={{ "--agent-color": agent.color }}
              >
                <i className={`dot ${tone}`} />
                {agent.name}
                <span className="scene-provider">{providerLabel(agent)}</span>
                <span className="scene-activity">
                  {activityLabel(agent)}
                  {inferred ? " (inferred)" : ""}
                </span>
              </button>
            );
          })}
        {!failed && clusteredCount > 0 && (
          <button
            ref={clusterRef}
            className="scene-cluster"
            onClick={() => setExpanded(true)}
            aria-label={`Show ${clusteredCount} available agents`}
          >
            {themeDef.rooms.breakArea} · {clusteredCount} available
          </button>
        )}
        {!failed && expanded && idleCount > IDLE_CLUSTER_THRESHOLD && (
          <button
            className="scene-cluster scene-cluster-collapse"
            onClick={() => setExpanded(false)}
            aria-label="Collapse available agents"
          >
            Collapse {idleCount} available
          </button>
        )}
        {!failed && (
          <canvas
            ref={minimapRef}
            className="office-minimap"
            width={150}
            height={110}
            aria-label="Office minimap. Click an agent dot to select it."
          />
        )}
        {failed && (
          <div className="scene-fallback">
            <h3>The team is still here.</h3>
            <p>
              3D rendering is unavailable in this browser. Select any agent
              below to manage their work.
            </p>
            {agents.map((a) => (
              <button key={a.id} onClick={() => onSelect?.(a.id)}>
                {a.name} · {a.role ?? providerLabel(a)} · {activityLabel(a)}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="office-bottom">
        <span>
          <MousePointer2 size={13} /> Drag to orbit · Scroll to zoom · Arrows
          pan · F follows
        </span>
        <div className="camera-tools">
          <button
            title="Zoom out"
            aria-label="Zoom out"
            onClick={() => api.current?.zoom(0.9)}
          >
            <Minus size={16} />
          </button>
          <button
            title="Zoom in"
            aria-label="Zoom in"
            onClick={() => api.current?.zoom(1.1)}
          >
            <Plus size={16} />
          </button>
          <span />
          <button
            title="Follow selected agent"
            aria-label="Follow selected agent"
            aria-pressed={followId != null}
            onClick={toggleFollow}
          >
            <Crosshair size={15} />
          </button>
          <button
            title="Reset camera"
            aria-label="Reset camera"
            onClick={() => {
              setLocalFollow(null);
              api.current?.reset();
            }}
          >
            <RotateCcw size={15} />
          </button>
          <button
            title="Fullscreen"
            aria-label="Fullscreen"
            onClick={() => {
              const el = host.current?.parentElement;
              if (document.fullscreenElement) document.exitFullscreen?.();
              else el?.requestFullscreen?.().catch(() => {});
            }}
          >
            <Maximize2 size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
