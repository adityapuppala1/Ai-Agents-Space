/**
 * Living office (Three.js). Renders every agent as a figure that moves to the
 * zone matching its recorded activity. Walking is a visual transition only.
 * Nothing in this scene is invented: every screen, chip and card is filled
 * from data the caller passes in, and says so plainly when there is none.
 *
 * Props
 * - agents: [{ id, name, color, initials, state, activity, currentFile,
 *     currentAction, provider, runId, runStatus, runMode, taskTitle, role?,
 *     host?, elapsedMs?, completed?, activityProvenance? }]. When `activity` is
 *     missing the legacy `state` is used.
 * - selected: agent id highlighted in the scene.
 * - onSelect(agentId): figure clicks, label buttons, minimap and fallback list.
 * - running: boolean; false freezes ambient motion (demo paused).
 * - theme: "studio" | "operations" (default "studio").
 * - graphics: "low" | "medium" | "high": shadows, pixel ratio, particles,
 *     frame cap, and the defaults for avatar detail and label density.
 * - followAgentId: agent id the camera should track smoothly (null = free).
 * - reducedMotion: boolean; disables walking tweens, bobbing, particles, sound.
 * - onZoneHover?(agentId|null): hover over a figure (3D canvas or minimap).
 *
 * Optional props (all default to today's behaviour)
 * - testResults: { [runId]: { passed, failed, total, updatedAt } } — the QA
 *     screen shows these real counts and attributes them to the run.
 * - buildEvents: [{ id, kind, status, label, timestamp }] — the operations
 *     CI/CD wall.
 * - artifactsByAgent: { [agentId]: [{ id, title, kind, preview? }] } — review
 *     table chips and the sanitized monitor preview.
 * - handoffs: [{ id?, fromAgentId, toAgentId, taskTitle, timestamp }].
 * - messages: { [agentId]: { summary, timestamp, attribution, eventId? } }.
 * - teams: { [agentId]: teamName } — clusters desks and floats a team label.
 * - rooms / selectedRoom / onSelectRoom(roomId) — selectable rooms.
 * - onOpenArtifact(artifactId), onOpenEvent(eventId), onOpenMonitor(agentId).
 * - cameraState / onCameraChange(state) — persisted camera.
 * - presentation: { enabled, largeLabels, cameraPath, step, onStep(next) }.
 * - avatarStyles: { [agentId]: { outfit, accessory, hairColor, pronouns } }.
 * - labelDensity: "all" | "active" | "none"; avatarDetail: "low"|"medium"|"high".
 * - ambientSound: boolean (default false); lighting: "day"|"evening"|"focus".
 *
 * Keyboard (focus the canvas area): arrows pan, + / - zoom, F toggles follow of
 * the selected agent. Controls: Zoom in, Zoom out, Reset camera, Fullscreen.
 * Accessibility: every agent has an "Inspect <name>" button; when WebGL is
 * unavailable a `.scene-fallback` list replaces the canvas.
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import {
  Minus,
  Plus,
  RotateCcw,
  Maximize2,
  MousePointer2,
  Crosshair,
  Pause,
  Play,
  SkipForward,
} from "lucide-react";
import {
  Resources,
  createRenderer,
  createLights,
  applyGraphics,
  graphicsPreset,
} from "./office/scene.js";
import { getTheme, buildRoom } from "./office/themes.js";
import {
  computeLayout,
  buildZones,
  zoneForActivity,
  ZONE_IDS,
} from "./office/zones.js";
import {
  createFigure,
  applyAgentState,
  animateFigure,
  createCelebration,
  activityOf,
  activityLabel,
  providerLabel,
  statusTone,
  styleKeyOf,
} from "./office/avatars.js";
import { createCamera } from "./office/camera.js";
import { createMinimap } from "./office/minimap.js";
import { createAmbientSound } from "./office/sound.js";
import {
  qaScreen,
  pipelinePanels,
  serviceMap,
  reviewChips,
  handoffCard,
  messageFor,
  hostChip,
  pronouns as pronounsOf,
  showLabel,
  orderByTeam,
  teamGroups,
  avoidCollisions,
  previewLines,
  hoverPreview,
  presentationStop,
  defaultCameraPath,
  sameCamera,
  validCamera,
  clean,
} from "./office/data.js";
import "./styles/office.css";

const IDLE_CLUSTER_THRESHOLD = 12;
const TYPING = new Set(["CODING", "COMMANDING", "DEBUGGING"]);
const SLOT_COUNT = 8;
const PRESENTATION_STEP_MS = 6000;
const CAMERA_EMIT_MS = 500;

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
  testResults = null,
  buildEvents = null,
  artifactsByAgent = null,
  handoffs = null,
  messages = null,
  teams = null,
  rooms = null,
  selectedRoom = null,
  onSelectRoom,
  onOpenArtifact,
  onOpenEvent,
  onOpenMonitor,
  cameraState = null,
  onCameraChange,
  presentation = null,
  avatarStyles = null,
  labelDensity = null,
  avatarDetail = null,
  ambientSound = false,
  lighting = "day",
}) {
  const host = useRef(null);
  const minimapRef = useRef(null);
  const clusterRef = useRef(null);
  const previewRef = useRef(null);
  const teamRefs = useRef({});
  const labels = useRef({});
  const api = useRef(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(null);
  const [localRoom, setLocalRoom] = useState(null);
  const [paused, setPaused] = useState(false);
  const [localStep, setLocalStep] = useState(0);
  // undefined = defer to the followAgentId prop; null = user turned follow off; id = user follow.
  const [localFollow, setLocalFollow] = useState(undefined);
  const followId = localFollow === undefined ? followAgentId : localFollow;
  const toggleFollow = () =>
    setLocalFollow(followId != null ? null : (selected ?? null));
  const themeDef = getTheme(theme);
  const preset = graphicsPreset(graphics);
  const density = labelDensity ?? preset.labelDensity ?? "all";
  const detail = avatarDetail ?? preset.avatarDetail ?? "medium";
  const presentationOn = !!presentation?.enabled;
  const mask = presentationOn;
  const room = selectedRoom ?? localRoom;
  const step = presentation?.step ?? localStep;

  // Ordered so team mates take adjacent desks; the desk grid follows the array.
  const ordered = useMemo(() => orderByTeam(agents, teams), [agents, teams]);
  const groups = useMemo(() => teamGroups(ordered, teams), [ordered, teams]);
  const roomList = useMemo(() => {
    if (Array.isArray(rooms) && rooms.length) return rooms;
    return ZONE_IDS.map((id) => ({ id, label: themeDef.rooms[id] ?? id }));
  }, [rooms, themeDef]);

  const state = useRef({});
  state.current = {
    agents: ordered,
    selected,
    running,
    onSelect,
    onZoneHover,
    onOpenArtifact,
    onOpenEvent,
    onOpenMonitor,
    onCameraChange,
    onSelectRoom,
    theme,
    graphics,
    followId,
    reducedMotion,
    expanded,
    testResults,
    buildEvents,
    artifactsByAgent,
    handoffs,
    messages,
    teams,
    avatarStyles,
    density,
    detail,
    mask,
    lighting,
    room,
    presentationOn,
    hovered,
  };
  const agentKey = useMemo(
    () =>
      ordered
        .map(
          (a) =>
            `${a.id}:${styleKeyOf(avatarStyles?.[a.id] ?? null, a)}:${teams?.[a.id] ?? ""}`,
        )
        .join("|"),
    [ordered, avatarStyles, teams],
  );
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
    let lastEmitted = null;
    let emitAt = 0;
    const cam = createCamera(renderer, container, {
      onChange: (next) => {
        const now = performance.now();
        if (sameCamera(next, lastEmitted) || now - emitAt < CAMERA_EMIT_MS)
          return;
        emitAt = now;
        lastEmitted = next;
        state.current.onCameraChange?.(next);
      },
    });
    const roomGroup = new THREE.Group();
    const zoneGroup = new THREE.Group();
    const figureGroup = new THREE.Group();
    scene.add(roomGroup, zoneGroup, figureGroup);
    const figureRes = new Resources();
    let roomRes = new Resources();
    let lights = createLights(
      scene,
      getTheme(state.current.theme),
      1,
      state.current.lighting,
    );
    let gfx = applyGraphics(
      renderer,
      scene,
      lights.sun,
      state.current.graphics,
    );
    let layout = computeLayout(state.current.agents.length);
    let zones = null;
    let shell = {};
    let figures = new Map();
    let particles = [];
    let visible = true;
    let cameraScale = 0;
    let caretOn = true;
    let cameraRestored = false;
    const minimap = minimapRef.current
      ? createMinimap(minimapRef.current, {
          onSelect: (id) => state.current.onSelect?.(id),
          onHover: (id) => hoverAgent(id),
          onSelectRoom: (id) => state.current.onSelectRoom?.(id),
        })
      : null;

    function hoverAgent(id) {
      state.current.onZoneHover?.(id);
      setHovered(id ?? null);
    }

    function rebuild() {
      const themeDef = getTheme(state.current.theme);
      roomGroup.clear();
      zoneGroup.clear();
      roomRes.dispose();
      roomRes = new Resources();
      layout = computeLayout(state.current.agents.length);
      shell =
        buildRoom(roomGroup, themeDef, layout, roomRes, {
          pipeline: pipelinePanels(state.current.buildEvents ?? [], 4, {
            mask: state.current.mask,
          }),
          serviceMap: serviceMap(state.current.agents),
        }) ?? {};
      zones = buildZones(
        zoneGroup,
        themeDef,
        layout,
        state.current.agents,
        roomRes,
      );
      relight();
      minimap?.setLayout(layout);
      if (layout.scale !== cameraScale) {
        cameraScale = layout.scale;
        cam.frame(layout.scale);
      }
      if (!cameraRestored && validCamera(cameraState)) {
        cameraRestored = cam.setState(cameraState);
      }
      // Force screens to redraw with current content.
      sync(true);
    }

    function relight() {
      scene.remove(lights.hemi, lights.sun);
      lights.sun.shadow.map?.dispose();
      lights.sun.dispose();
      lights.hemi.dispose();
      lights = createLights(
        scene,
        getTheme(state.current.theme),
        layout.scale,
        state.current.lighting,
      );
      gfx = applyGraphics(renderer, scene, lights.sun, state.current.graphics);
    }

    function sync(force = false) {
      const {
        agents,
        reducedMotion,
        expanded,
        avatarStyles,
        detail,
        mask,
        testResults,
        artifactsByAgent,
        handoffs,
        messages,
        buildEvents,
      } = state.current;
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
      const testers = [];
      const reviewers = [];
      const occupied = [];
      let clustered = 0;
      agents.forEach((agent, i) => {
        let fig = figures.get(agent.id);
        const style = avatarStyles?.[agent.id] ?? null;
        const wantedKey = styleKeyOf(style, agent);
        if (fig && (fig.styleKey !== wantedKey || fig.detail !== detail)) {
          figureGroup.remove(fig.group);
          figures.delete(agent.id);
          fig = null;
        }
        if (!fig) {
          fig = createFigure(agent, i, figureRes, { style, detail });
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
          // Simple collision avoidance: steer around slots already taken.
          target = { ...avoidCollisions(slot, occupied), zone: zoneId };
        }
        if (!isClustered) occupied.push({ x: target.x, z: target.z });
        fig.clustered = isClustered;
        fig.group.visible = !isClustered;
        const message = messageFor(messages, agent.id, { mask });
        const completed = applyAgentState(fig, agent, target, {
          now,
          reducedMotion,
          talking: !!message,
        });
        if (completed && gfx.particles && !reducedMotion) {
          fig.celebrateUntil = now + 900;
          const burst = createCelebration(fig.pos, agent.color, now);
          scene.add(burst.points);
          particles.push(burst);
        }
        if (activity === "TESTING")
          testers.push({ id: agent.id, name: agent.name, runId: agent.runId });
        if (activity === "REVIEWING") reviewers.push(agent);
        if (force) {
          const m = zones?.monitors.get(agent.id);
          if (m) m.key = "";
        }
        const first = artifactsByAgent?.[agent.id]?.[0];
        zones?.updateMonitor(agent.id, agent, {
          typing: TYPING.has(activity),
          caret: caretOn,
          activityLabel: activityLabel(agent),
          mask,
          preview: first?.preview
            ? previewLines(first.preview, { mask, lines: 3 })
            : null,
        });
      });
      zones?.updateQa(
        qaScreen({
          testers,
          testResults,
          qaLabel: getTheme(state.current.theme).rooms.qa,
          mask,
        }),
      );
      zones?.updateReview(
        reviewers.map((a) => clean(a.name, 20)),
        reviewChips(reviewers, artifactsByAgent, 3),
      );
      zones?.updateHandoff(handoffCard(handoffs, agents, { mask }));
      zones?.updateCluster(clustered);
      shell.updatePipeline?.(pipelinePanels(buildEvents ?? [], 4, { mask }));
      shell.updateServiceMap?.(serviceMap(agents));
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
      const hits = raycaster.intersectObjects(
        [figureGroup, zoneGroup, roomGroup],
        true,
      );
      for (const hit of hits) {
        const data = hit.object.userData ?? {};
        if (data.agentId != null) return { kind: "agent", id: data.agentId };
        if (data.artifactId != null)
          return { kind: "artifact", id: data.artifactId };
        if (data.buildEventId != null)
          return { kind: "event", id: data.buildEventId };
        if (data.monitorAgentId != null)
          return { kind: "monitor", id: data.monitorAgentId };
      }
      return null;
    }
    let down = null;
    let hoveredId = null;
    let lastMove = 0;
    const pointerdown = (e) => {
      down = [e.clientX, e.clientY];
    };
    const pointerup = (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5)
        return;
      const hit = pick(e);
      if (!hit) return;
      if (hit.kind === "agent") state.current.onSelect?.(hit.id);
      else if (hit.kind === "artifact") state.current.onOpenArtifact?.(hit.id);
      else if (hit.kind === "event") state.current.onOpenEvent?.(hit.id);
      else if (hit.kind === "monitor") {
        if (state.current.onOpenMonitor) state.current.onOpenMonitor(hit.id);
        else state.current.onSelect?.(hit.id);
      }
    };
    const pointermove = (e) => {
      if (e.timeStamp - lastMove < 80) return;
      lastMove = e.timeStamp;
      const hit = pick(e);
      const id = hit?.kind === "agent" ? hit.id : null;
      if (id !== hoveredId) {
        hoveredId = id;
        hoverAgent(id);
      }
      renderer.domElement.style.cursor = hit ? "pointer" : "";
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
      const budget = visible ? gfx.frameMs : 500;
      if (time - last < budget) return;
      const dtMs = Math.min(200, time - last || 16);
      const dt = dtMs / 1000;
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
              mask: state.current.mask,
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
          dtMs,
          rate: gfx.animationRate ?? 1,
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
      const hoveredFig = state.current.hovered
        ? figures.get(state.current.hovered)
        : null;
      if (previewRef.current && hoveredFig)
        place(previewRef.current, hoveredFig.pos.x, 3.1, hoveredFig.pos.z);
      for (const [team, el] of Object.entries(teamRefs.current)) {
        if (!el) continue;
        const members = [...figures.values()].filter(
          (f) => state.current.teams?.[f.id] === team && !f.clustered,
        );
        if (!members.length) {
          el.style.visibility = "hidden";
          continue;
        }
        const x = members.reduce((sum, f) => sum + f.pos.x, 0) / members.length;
        const z = members.reduce((sum, f) => sum + f.pos.z, 0) / members.length;
        place(el, x, 3.2, z);
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
        selectedRoom: state.current.room,
      });
      if (visible) renderer.render(scene, cam.camera);
    }
    rebuild();
    frame = requestAnimationFrame(loop);

    api.current = {
      rebuild,
      sync,
      relight,
      zoom: (f) => cam.zoom(f),
      reset: () => cam.reset(),
      pan: (dx, dz) => cam.pan(dx * layout.scale, dz * layout.scale),
      focusRoom: (id) => {
        const zone = id === "desk" ? { x: 0, z: 1.5 } : layout.zones[id];
        if (zone) cam.focus({ x: zone.x, z: zone.z }, 1.35);
      },
      focusPoint: (point, zoom) => cam.focus(point, zoom),
      layout: () => layout,
      restoreCamera: (next) => cam.setState(next),
      setGraphics: () => {
        gfx = applyGraphics(
          renderer,
          scene,
          lights.sun,
          state.current.graphics,
        );
        if (!gfx.particles) {
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
  }, [
    agents,
    expanded,
    reducedMotion,
    testResults,
    buildEvents,
    artifactsByAgent,
    handoffs,
    messages,
    mask,
    detail,
  ]);

  useEffect(() => {
    api.current?.setGraphics();
  }, [graphics]);

  useEffect(() => {
    api.current?.relight();
  }, [lighting]);

  // Selectable rooms focus the camera.
  useEffect(() => {
    if (room) api.current?.focusRoom(room);
  }, [room]);

  // Persisted camera: restore a state supplied later (e.g. after settings load).
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !validCamera(cameraState)) return;
    if (api.current?.restoreCamera(cameraState)) restored.current = true;
  }, [cameraState]);

  // Ambient sound: off by default, never under reduced motion, stops on unmount.
  const sound = useRef(null);
  useEffect(() => {
    sound.current = createAmbientSound({ reducedMotion });
    return () => {
      sound.current?.dispose();
      sound.current = null;
    };
  }, []);
  useEffect(() => {
    sound.current?.setReducedMotion(reducedMotion);
    sound.current?.setEnabled(ambientSound && !reducedMotion && !failed);
  }, [ambientSound, reducedMotion, failed]);

  // Presentation mode: a fixed camera path with pause and step controls.
  const stepTo = useCallback(
    (next) => {
      if (presentation?.onStep) presentation.onStep(next);
      else setLocalStep(next);
    },
    [presentation],
  );
  useEffect(() => {
    if (!presentationOn) return undefined;
    const path = presentation?.cameraPath?.length
      ? presentation.cameraPath
      : defaultCameraPath(api.current?.layout());
    const stop = presentationStop(path, step);
    if (stop) api.current?.focusPoint({ x: stop.x, z: stop.z }, stop.zoom);
    if (paused || reducedMotion) return undefined;
    const timer = setTimeout(() => stepTo(step + 1), PRESENTATION_STEP_MS);
    return () => clearTimeout(timer);
  }, [presentationOn, presentation, step, paused, reducedMotion, stepTo]);

  const keydown = (e) => {
    const a = api.current;
    if (!a) return;
    const stepSize = 0.6;
    switch (e.key) {
      case "ArrowLeft":
        a.pan(-stepSize, 0);
        break;
      case "ArrowRight":
        a.pan(stepSize, 0);
        break;
      case "ArrowUp":
        a.pan(0, stepSize);
        break;
      case "ArrowDown":
        a.pan(0, -stepSize);
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
  const hoveredAgent = agents.find((a) => a.id === hovered) ?? null;
  const preview = hoverPreview(hoveredAgent, { mask });
  const reviewers = ordered.filter((a) => activityOf(a) === "REVIEWING");
  const chips = reviewChips(reviewers, artifactsByAgent, 3);
  const buildStrip = Array.isArray(buildEvents)
    ? pipelinePanels(buildEvents, 4, { mask }).filter((p) => p.id != null)
    : [];
  const handoff = handoffCard(handoffs, ordered, { mask });
  const selectRoom = (id) => {
    if (onSelectRoom) onSelectRoom(id === room ? null : id);
    else setLocalRoom(id === room ? null : id);
  };

  return (
    <div
      className={[
        "office-wrap",
        `office-theme-${themeDef.id}`,
        `office-light-${lighting}`,
        presentationOn ? "office-presentation" : "",
        presentationOn && presentation?.largeLabels !== false
          ? "office-large-labels"
          : "",
        `office-labels-${density}`,
      ]
        .filter(Boolean)
        .join(" ")}
    >
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
        {!failed && (
          <div className="office-rooms" aria-label="Rooms">
            {roomList.map((r) => (
              <button
                key={r.id}
                className={`room-chip ${room === r.id ? "selected" : ""}`}
                aria-pressed={room === r.id}
                onClick={() => selectRoom(r.id)}
                title={`Focus ${r.label}`}
              >
                {r.label}
              </button>
            ))}
          </div>
        )}
        {!failed &&
          agents.map((agent) => {
            const tone = statusTone(agent);
            const inferred = agent.activityProvenance === "inferred";
            const chip = hostChip(agent);
            const style = avatarStyles?.[agent.id] ?? null;
            const pron = pronounsOf(style);
            const shown = showLabel(agent, density, selected);
            const message = messageFor(messages, agent.id, { mask });
            return (
              <button
                key={agent.id}
                ref={(el) => {
                  labels.current[agent.id] = el;
                }}
                className={[
                  "scene-label",
                  `tone-${tone}`,
                  selected === agent.id ? "selected" : "",
                  shown ? "" : "scene-label-dim",
                  message ? "scene-label-talking" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => onSelect?.(agent.id)}
                onMouseEnter={() => {
                  setHovered(agent.id);
                  onZoneHover?.(agent.id);
                }}
                onMouseLeave={() => {
                  setHovered(null);
                  onZoneHover?.(null);
                }}
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
                {pron && <span className="scene-pronouns">{pron}</span>}
                <span className="scene-provider">{providerLabel(agent)}</span>
                {chip && <span className="scene-host">Host: {chip}</span>}
                <span className="scene-activity">
                  {activityLabel(agent)}
                  {inferred ? " (inferred)" : ""}
                </span>
                {message && (
                  <span className="scene-message">
                    “{message.summary}” · {message.attribution}
                  </span>
                )}
              </button>
            );
          })}
        {!failed &&
          groups.map((group) => (
            <span
              key={group.team}
              ref={(el) => {
                teamRefs.current[group.team] = el;
              }}
              className="scene-team"
              style={{ visibility: "hidden" }}
            >
              {group.team} · {group.agentIds.length}
            </span>
          ))}
        {!failed && preview && (
          <div
            ref={previewRef}
            className="scene-preview"
            role="status"
            style={{ visibility: "hidden" }}
          >
            <strong>{preview.name}</strong>
            <em>
              {preview.activity}
              {preview.inferred ? " (inferred)" : ""}
            </em>
            {preview.task && <span>{preview.task}</span>}
            <span>{preview.file ? preview.file : "no file reported"}</span>
            <span>
              {preview.provider}
              {preview.host ? ` · ${preview.host}` : ""}
              {preview.elapsed ? ` · ${preview.elapsed}` : ""}
            </span>
          </div>
        )}
        {!failed && chips.length > 0 && (
          <div className="scene-artifacts" aria-label="Artifacts under review">
            {chips.map((chip) => (
              <button
                key={chip.id}
                className="scene-artifact-chip"
                onClick={() => onOpenArtifact?.(chip.id)}
                title={`Open ${chip.title}`}
              >
                {chip.title}
                <span>{chip.kind}</span>
              </button>
            ))}
          </div>
        )}
        {!failed && handoff && (
          <div className="scene-handoff">
            <strong>Handoff</strong>
            <span>
              {handoff.from} → {handoff.to}
            </span>
            <span>{handoff.title || "task title not recorded"}</span>
            {handoff.id != null && onOpenEvent && (
              <button onClick={() => onOpenEvent(handoff.id)}>
                Open handoff event
              </button>
            )}
          </div>
        )}
        {!failed && buildStrip.length > 0 && (
          <div className="scene-builds" aria-label="Recorded build events">
            {buildStrip.map((event) => (
              <button
                key={event.id}
                className="scene-build"
                onClick={() => onOpenEvent?.(event.id)}
                title={`${event.title} · ${event.status}`}
              >
                {event.title}
                <span>{event.status}</span>
              </button>
            ))}
          </div>
        )}
        {!failed && presentationOn && (
          <div className="office-presentation-bar">
            <button
              onClick={() => setPaused((p) => !p)}
              aria-label={paused ? "Resume presentation" : "Pause presentation"}
              title={paused ? "Resume presentation" : "Pause presentation"}
            >
              {paused ? <Play size={14} /> : <Pause size={14} />}
            </button>
            <button
              onClick={() => stepTo(step + 1)}
              aria-label="Next presentation stop"
              title="Next stop"
            >
              <SkipForward size={14} />
            </button>
            <span>Presentation · private paths masked</span>
          </div>
        )}
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
            aria-label="Office minimap. Click an agent dot to select it, or a room to focus it."
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
              if (onSelectRoom) onSelectRoom(null);
              else setLocalRoom(null);
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
