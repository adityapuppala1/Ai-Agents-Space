import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  Building2,
  CheckCircle2,
  Clock3,
  Radio,
  Users,
} from "lucide-react";
import EmptyState from "../components/EmptyState.jsx";
import Dialog from "../components/Dialog.jsx";
import { apiFetch, providerLabel, activityLabel } from "../hooks/useApi.js";
import {
  campusBuildings,
  campusTotals,
  campusWorkspaceDetail,
} from "./campusData.js";

const CAMPUS_PALETTES = Object.freeze({
  light: { sky: "#dce8ed", ground: "#aec7c0", hemi: 2.3 },
  dark: { sky: "#1c2632", ground: "#33474b", hemi: 1.8 },
});

export default function CampusView({
  workspaces = [],
  currentWorkspaceId,
  onSelectWorkspace,
  presentation = false,
}) {
  const mountRef = useRef(null);
  const buildings = useMemo(() => campusBuildings(workspaces), [workspaces]);
  const totals = useMemo(() => campusTotals(buildings), [buildings]);
  const [hovered, setHovered] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState("");
  const openBuilding = useCallback((id) => setSelectedId(id), []);

  useEffect(() => {
    if (!selectedId) return undefined;
    let current = true;
    setDetail(null);
    setDetailError("");
    apiFetch(`/workspaces/${encodeURIComponent(selectedId)}/workspace`)
      .then((snapshot) => {
        if (current) setDetail(campusWorkspaceDetail(snapshot));
      })
      .catch((error) => {
        if (current) setDetailError(error.message);
      });
    return () => {
      current = false;
    };
  }, [selectedId]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !buildings.length) return undefined;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(CAMPUS_PALETTES.light.sky);
    scene.fog = new THREE.Fog(CAMPUS_PALETTES.light.sky, 24, 52);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    const rows = Math.max(1, Math.ceil(buildings.length / 4));
    camera.position.set(12, 16 + rows * 1.2, 18 + rows * 2.2);
    camera.lookAt(0, 0, Math.max(0, (rows - 1) * 2));
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const hemi = new THREE.HemisphereLight("#ffffff", "#61747c", 2.3);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight("#fff8e9", 2.7);
    sun.position.set(8, 16, 10);
    scene.add(sun);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(30, Math.max(18, rows * 6 + 7)),
      new THREE.MeshStandardMaterial({ color: "#aec7c0", roughness: 0.95 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.z = Math.max(0, (rows - 1) * 2);
    scene.add(ground);
    // The sky and ground follow the app theme; the buildings keep their
    // workspace colours. It stayed a light scene inside a dark page.
    const applyTheme = () => {
      const palette =
        CAMPUS_PALETTES[
          document.documentElement.dataset.theme === "dark" ? "dark" : "light"
        ];
      scene.background.set(palette.sky);
      scene.fog.color.set(palette.sky);
      ground.material.color.set(palette.ground);
      hemi.intensity = palette.hemi;
    };
    applyTheme();
    const themeWatch = new MutationObserver(applyTheme);
    themeWatch.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    const interactive = [];
    const animated = [];
    for (const building of buildings) {
      const group = new THREE.Group();
      group.position.set(building.x, 0, building.z);
      group.userData.workspaceId = building.id;
      const height = 1.8 + Math.min(building.agents, 8) * 0.18;
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(2.8, height, 2.6),
        new THREE.MeshStandardMaterial({
          color: building.color,
          roughness: 0.7,
          emissive: building.attention ? "#4c1c10" : "#000000",
          emissiveIntensity: building.attention ? 0.2 : 0,
        }),
      );
      body.position.y = height / 2;
      body.userData.workspaceId = building.id;
      group.add(body);
      interactive.push(body);

      const roof = new THREE.Mesh(
        new THREE.BoxGeometry(3.05, 0.18, 2.85),
        new THREE.MeshStandardMaterial({ color: "#edf3f4", roughness: 0.8 }),
      );
      roof.position.y = height + 0.08;
      group.add(roof);
      for (
        let floor = 0;
        floor < Math.max(1, Math.ceil(building.agents / 2));
        floor++
      ) {
        const windowBand = new THREE.Mesh(
          new THREE.BoxGeometry(2.84, 0.18, 1.25),
          new THREE.MeshBasicMaterial({
            color: building.active ? "#c8f4ff" : "#dce4e4",
          }),
        );
        windowBand.position.set(0, 0.55 + floor * 0.42, 0.69);
        group.add(windowBand);
      }
      if (building.active) {
        const beacon = new THREE.Mesh(
          new THREE.SphereGeometry(0.14, 12, 8),
          new THREE.MeshBasicMaterial({ color: "#37d693" }),
        );
        beacon.position.set(0, height + 0.55, 0);
        group.add(beacon);
        animated.push(beacon);
      }
      scene.add(group);
    }

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const hit = (event) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObjects(interactive, false)[0]?.object?.userData
        ?.workspaceId;
    };
    const onMove = (event) => {
      const id = hit(event) ?? null;
      setHovered(id);
      renderer.domElement.style.cursor = id ? "pointer" : "default";
    };
    const onClick = (event) => {
      const id = hit(event);
      if (id) openBuilding(id);
    };
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("click", onClick);

    const resize = () => {
      const width = mount.clientWidth;
      const height = mount.clientHeight;
      renderer.setSize(width, height, false);
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    let frame = 0;
    const render = (time = 0) => {
      for (const beacon of animated)
        beacon.scale.setScalar(reduced ? 1 : 1 + Math.sin(time / 330) * 0.18);
      renderer.render(scene, camera);
      frame = requestAnimationFrame(render);
    };
    render();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      themeWatch.disconnect();
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("click", onClick);
      scene.traverse((object) => {
        object.geometry?.dispose?.();
        if (Array.isArray(object.material))
          object.material.forEach((m) => m.dispose());
        else object.material?.dispose?.();
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [buildings, openBuilding]);

  if (!buildings.length)
    return (
      <EmptyState
        icon={<Building2 size={28} />}
        title="No workspaces on campus"
        description="Create a workspace to add its building to this overview."
      />
    );

  return (
    <section className="campus" aria-label="Workspace campus">
      <div className="campus-summary">
        <span>
          <Building2 size={15} /> <strong>{totals.workspaces}</strong>{" "}
          workspaces
        </span>
        <span>
          <Radio size={15} /> <strong>{totals.active}</strong> active
        </span>
        <span>
          <AlertTriangle size={15} /> <strong>{totals.attention}</strong> need
          attention
        </span>
        <span>
          <Users size={15} /> <strong>{totals.agents}</strong> agents
        </span>
      </div>
      <div className="campus-scene" ref={mountRef} aria-hidden="true">
        <div className="campus-scene-caption">
          {hovered
            ? buildings.find((item) => item.id === hovered)?.name
            : "Select a building to enter its workspace"}
        </div>
      </div>
      <div className="campus-grid" role="list" aria-label="Campus buildings">
        {buildings.map((building) => (
          <div key={building.id} role="listitem">
            <button
              type="button"
              className={building.id === currentWorkspaceId ? "is-current" : ""}
              onClick={() => openBuilding(building.id)}
            >
              <i style={{ background: building.color }} aria-hidden="true" />
              <span>
                <strong>{building.name}</strong>
                <small>
                  {building.theme.replaceAll("-", " ")} · {building.kind}
                </small>
              </span>
              <span className="campus-building-stats">
                <b title="Active runs">
                  <Radio size={11} /> {building.active}
                </b>
                <b title="Agents">
                  <Bot size={11} /> {building.agents}
                </b>
                {building.attention ? (
                  <b className="needs-attention" title="Needs attention">
                    <AlertTriangle size={11} /> {building.attention}
                  </b>
                ) : null}
              </span>
            </button>
          </div>
        ))}
      </div>
      <p className="campus-truth">
        Buildings summarize recorded workspace counts. Entering one changes
        scope before its tasks, agents and runs are loaded
        {presentation ? ". Private paths are masked." : "."}
      </p>
      {selectedId ? (
        <Dialog
          title={
            buildings.find((item) => item.id === selectedId)?.name ??
            "Workspace"
          }
          onClose={() => setSelectedId(null)}
          wide
        >
          <div className="campus-detail-head">
            <div>
              <span className="as-tag">Recorded workspace summary</span>
              <p>
                Rooms group agents by their current recorded activity. Empty
                rooms are omitted.
              </p>
            </div>
            <button
              type="button"
              className="button primary"
              onClick={() => onSelectWorkspace?.(selectedId)}
            >
              Enter workspace <ArrowRight size={14} />
            </button>
          </div>
          {detailError ? (
            <div className="form-error" role="alert">
              {detailError}
            </div>
          ) : null}
          {!detail && !detailError ? (
            <p className="panel-loading" role="status">
              Loading recorded rooms…
            </p>
          ) : null}
          {detail ? (
            <>
              <div
                className="campus-task-strip"
                aria-label="Workspace task counts"
              >
                {Object.entries(detail.taskCounts).map(([status, count]) => (
                  <span key={status}>
                    {status === "completed" ? (
                      <CheckCircle2 size={13} />
                    ) : (
                      <Clock3 size={13} />
                    )}
                    <strong>{count}</strong> {status}
                  </span>
                ))}
              </div>
              <div className="campus-rooms" aria-label="Workspace rooms">
                {detail.rooms.map((room) => (
                  <section key={room.name} className="campus-room">
                    <header>
                      <div>
                        <Building2 size={14} />
                        <strong>{room.name}</strong>
                      </div>
                      <span>
                        {room.agents} agent{room.agents === 1 ? "" : "s"}
                      </span>
                    </header>
                    <div className="campus-room-agents">
                      {room.people.map((person) => (
                        <div key={person.id}>
                          <Bot size={14} />
                          <span>
                            <strong>{person.name}</strong>
                            <small>
                              {person.role || "Agent"}
                              {person.provider
                                ? ` · ${providerLabel(person.provider)}`
                                : ""}
                            </small>
                          </span>
                          <span className="as-tag">
                            {person.activity === "UNKNOWN"
                              ? "Activity not reported"
                              : activityLabel(person.activity)}
                            {person.activity === "MANUAL" ? " (manual)" : ""}
                          </span>
                          {person.taskTitle ? <p>{person.taskTitle}</p> : null}
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
                {!detail.rooms.length ? (
                  <p className="as-muted">
                    No agents are recorded in this workspace.
                  </p>
                ) : null}
              </div>
            </>
          ) : null}
        </Dialog>
      ) : null}
    </section>
  );
}
