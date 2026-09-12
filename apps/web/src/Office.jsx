import { createPortal } from "react-dom";
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
 * - providerSurfaces: detected assistant surfaces. Only a provider with live
 *   work (a live session or an active run on the floor) gets a labelled
 *   beacon; installed-only products draw nothing and never become agents.
 *
 * Keyboard (focus the canvas area): arrows pan, + / - zoom, F toggles follow of
 * the selected agent. Controls: Zoom in, Zoom out, Reset camera, Fullscreen.
 * Accessibility: every agent has an "Inspect <name>" button; when WebGL is
 * unavailable a `.scene-fallback` list replaces the canvas.
 *
 * Scale (office/scale.js, caps from the graphics preset — there is no separate
 * prop or setting for them):
 * - Live presence. The floor contains agents with recorded active work or an
 *   active provider run. Saved idle agents remain in the roster outside the
 *   scene. New arrivals walk in from the entrance; completed/deactivated agents
 *   walk out. The scene never clusters idle agents into a fictional crowd.
 * - Screen budget. Only `preset.screenBudget` desks keep an individual monitor
 *   with its own canvas texture (working agents and the selection first); the
 *   rest share one instanced dim screen.
 * - Crowd tier. Above `preset.crowd` visible figures, resting agents nobody is
 *   watching are drawn by the instanced crowd field instead of an articulated
 *   figure. They promote back the moment they do anything.
 * - Conference rooms (office/conference.js, roomPlan in office/scale.js). A
 *   live team relay, and each large team on a crowded floor, walks through a
 *   door into a glass room beside the floor and sits round one table, each
 *   agent at its own laptop, still doing its own recorded work. Nobody is
 *   hidden or shrunk. Talking and passing work across the table play only
 *   for recorded messages and handoffs.
 * `window.__officeScale` reports the resulting counts (agents, rooms, agents
 * seated in rooms, visible figures, crowd figures, live screens, desk meshes)
 * for tests and diagnostics. Counts only: it carries no agent data and no
 * paths.
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
  Minimize2,
  MousePointer2,
  Crosshair,
  Pause,
  Play,
  SkipForward,
  Video,
  Map as MapIcon,
  MoreHorizontal,
} from "lucide-react";
import {
  Resources,
  createRenderer,
  createLights,
  applyGraphics,
  graphicsPreset,
  resolveGraphics,
  lowerGraphics,
} from "./office/scene.js";
import { getTheme, buildRoom } from "./office/themes.js";
import {
  computeLayout,
  buildZones,
  roomFor,
  roomNames,
  zoneForActivity,
  ZONE_IDS,
} from "./office/zones.js";
import { buildOfficeProps } from "./office/props.js";
import { deskSeat, officeObstacles } from "./office/obstacles.js";
import { buildNavGrid, findPath } from "./office/navmesh.js";
import OfficeArranger from "./components/OfficeArranger.jsx";
import {
  createFigure,
  createCrowdFigure,
  createHelperFigure,
  createDocumentToken,
  followRoute,
  applyAgentState,
  animateFigure,
  createCelebration,
  ACTIVITY_LABELS,
  activityOf,
  activityLabel,
  providerLabel,
  statusTone,
  styleKeyOf,
} from "./office/avatars.js";
import {
  CLUSTER_SLOTS,
  MAX_ROOMS,
  screenPlan,
  figureTier,
  stableDeskOrder,
  roomPlan,
  activitySummary,
} from "./office/scale.js";
import {
  MAX_SLOTS,
  assignSeats,
  conferenceLayout,
  inRoom,
  laptopSpot,
  routeBetween,
  sceneBounds,
  seatCount,
  spreadSeats,
} from "./office/conference.js";
import { buildConferenceRooms } from "./office/conferenceScene.js";
import { agentAt, buildCrowdField } from "./office/instancing.js";
import { createCamera } from "./office/camera.js";
import { createMinimap } from "./office/minimap.js";
import { createAmbientSound } from "./office/sound.js";
import {
  buildChoreography,
  isOnFloor,
  liveLinkSummaries,
} from "./office/choreography.js";
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
  spreadLabels,
  avoidCollisions,
  previewLines,
  hoverPreview,
  presentationStop,
  defaultCameraPath,
  sameCamera,
  validCamera,
  clean,
  maskPrivate,
  PROVIDER_LABELS,
} from "./office/data.js";
import { liveBeaconSurfaces, MANUAL_ACTIVITY } from "./office/presence.js";
import {
  planEpisodes,
  planKickoffs,
  episodePhase,
  episodeAgents,
  meetingSpot,
  helperSpot,
  huddleSpots,
  facingToward,
  EPISODE_FRESH_MS,
  FIRST_LOOK_MS,
} from "./office/episodes.js";
import { waitingLinks, relayName } from "./office/relay.js";
import "./styles/office.css";

const TYPING = new Set(["CODING", "COMMANDING", "DEBUGGING"]);
const SLOT_COUNT = CLUSTER_SLOTS;

const PRESENTATION_STEP_MS = 6000;
const CAMERA_EMIT_MS = 500;
/** A subagent helper steps out of its parent, or walks back to it, in this long. */
const HELPER_WALK_MS = 750;
const HELPER_RETURN_MS = 1100;
/** Colour of each activity effect (rings, props, and laptop screens). */
const EFFECT_COLORS = {
  focus: 0x4f7ed8,
  keystrokes: 0x28a17d,
  scan: 0x5b8be0,
  sequence: 0xd09b3f,
  inspect: 0xc47a43,
  compare: 0x8b6bd7,
  terminal: 0x42a68f,
  speech: 0x7a75dc,
  transfer: 0xa26bd4,
  attention: 0xd39d3e,
  warning: 0xcf7d34,
  alarm: 0xc84f4f,
  stale: 0x8492a2,
  quiet: 0x6f86b8,
};

/** A team relay's room is in the handoff colour; a role team's in its members'. */
const WORKFLOW_ROOM_COLOR = "#8868d8";

/** From this many at one table, seated agents' labels wait for a hover. */
const QUIET_ROOM_SIZE = 5;

/**
 * A closed room stays up while its members walk out: at least this long,
 * and never longer than the second figure (a figure that never leaves).
 */
const ROOM_LINGER_MIN_MS = 1200;
const ROOM_LINGER_MAX_MS = 15_000;
/** A room out of the plan for less than this has not closed (see settleRooms). */
const ROOM_GRACE_MS = 350;

/**
 * What a conference room's wall board says, from records only: the team,
 * how many sit at the table and what they are doing, and the relay's step
 * count (or who is left at their desks when the room is full).
 */
function boardLines(room, plan, relay) {
  const title = clean(room.title ?? "Team", 28);
  if (room.closing || !plan) return [title, "Leaving the room", ""];
  const seated = plan.memberIds.length;
  const doing = activitySummary(plan, ACTIVITY_LABELS);
  const line = `${seated} at the table${doing ? ` · ${doing}` : ""}`;
  let last = "";
  if (relay)
    last = `${relay.done} of ${relay.total} steps done${
      relay.steps.some((step) => step.simulated) ? " · demo" : ""
    }`;
  else if (plan.overflow) last = `${plan.overflow} more at their desks`;
  return [title, clean(line, 44), last];
}

/** Share of a moment spent walking there and back (office/episodes.js). */
const WALK_SHARE = 0.24;

/** Caption text for a playing moment. Names come from the roster. */
function momentText(episode, nameOf, mask) {
  const tidy = (text, max) => clean(mask ? maskPrivate(text) : text, max);
  if (episode.kind === "kickoff")
    return {
      title: "Team kickoff",
      line: tidy(episode.members.map(nameOf).join(", "), 60),
      detail: null,
    };
  const from = nameOf(episode.fromAgentId);
  const to = nameOf(episode.toAgentId);
  if (episode.kind === "handoff")
    return {
      title: `Handoff · ${from} → ${to}`,
      line: tidy(episode.artifact ?? episode.label ?? "", 48),
      detail: episode.detail ? tidy(episode.detail, 48) : null,
    };
  return {
    title: `Message · ${from} → ${to}`,
    line: tidy(episode.label ?? "", 48),
    detail: null,
  };
}

/** Whether an object and every group above it is drawn. */
function shownInScene(object) {
  for (let node = object; node; node = node.parent)
    if (node.visible === false) return false;
  return true;
}

/** What an agent is doing in a moment, for its label; null when in none. */
function momentRole(episode, agentId, nameOf) {
  if (!episode) return null;
  if (episode.kind === "kickoff") return "Team kickoff";
  const giving = episode.fromAgentId === agentId;
  const other = nameOf(giving ? episode.toAgentId : episode.fromAgentId);
  if (episode.kind === "handoff")
    return giving ? `Handing over to ${other}` : `Receiving from ${other}`;
  return giving ? `Talking to ${other}` : `Listening to ${other}`;
}

/** Where a moment comes from, said on the caption itself. */
function momentSource(episode) {
  if (episode.replay) return "Replay of a recorded event";
  if (episode.simulated) return "Simulated (demo)";
  return "Recorded";
}

const STEP_MARKS = {
  done: "✓",
  active: "●",
  blocked: "!",
  ready: "▸",
  waiting: "○",
};
const STEP_STATES = {
  done: "done",
  active: "in progress",
  blocked: "blocked",
  ready: "ready to start",
  waiting: "waiting",
};

/**
 * The relay of a live team workflow: its steps in order, who holds each, and
 * where the baton is. Built from the tasks alone (office/relay.js). Choosing
 * a step selects the agent holding it.
 */
function RelayStrip({ relays, current, onPick, onSelect, mask }) {
  const index = Math.max(
    0,
    relays.findIndex((item) => item.workflowId === current),
  );
  const relay = relays[index];
  const name = relayName(relay);
  const step = (by) =>
    onPick?.(relays[(index + by + relays.length) % relays.length].workflowId);
  return (
    <nav
      className="scene-relay"
      aria-label={`${name}: ${relay.done} of ${relay.total} steps done`}
    >
      <strong>
        {name}
        <span>
          {relay.done}/{relay.total} done
        </span>
        {relays.length > 1 ? (
          <span className="relay-switch">
            <button
              type="button"
              onClick={() => step(-1)}
              aria-label="Previous team"
              title="Previous team"
            >
              ‹
            </button>
            <span aria-live="polite">
              Team {index + 1} of {relays.length}
            </span>
            <button
              type="button"
              onClick={() => step(1)}
              aria-label="Next team"
              title="Next team"
            >
              ›
            </button>
          </span>
        ) : null}
      </strong>
      <ol>
        {relay.steps.map((step) => {
          const title = mask ? maskPrivate(step.title) : step.title;
          return (
            <li key={step.taskId} className={`relay-step is-${step.state}`}>
              <button
                type="button"
                disabled={!step.agentId}
                onClick={() => step.agentId && onSelect?.(step.agentId)}
                title={`${title} · ${STEP_STATES[step.state]}${
                  step.agentName ? ` · ${step.agentName}` : " · unassigned"
                }`}
              >
                <i aria-hidden="true">{STEP_MARKS[step.state]}</i>
                <span>{clean(title, 26)}</span>
                <small>
                  {step.agentName ?? "Unassigned"}
                  <span className="sr-only">, {STEP_STATES[step.state]}</span>
                </small>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export default function Office({
  agents = [],
  providerSurfaces = [],
  onOpenProviders,
  selected,
  onSelect,
  running = true,
  theme = "studio",
  graphics = "auto",
  followAgentId = null,
  reducedMotion = false,
  onZoneHover,
  testResults = null,
  buildEvents = null,
  artifactsByAgent = null,
  handoffs = null,
  kickoffs = null,
  relays = null,
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
  officeLayout = null,
  arranging = false,
  onArrangeSave,
  onArrangeClose,
}) {
  const host = useRef(null);
  const minimapRef = useRef(null);
  const previewRef = useRef(null);
  const teamRefs = useRef({});
  const labels = useRef({});
  const beaconLabels = useRef({});
  // Captions over a playing moment, and chips over subagent helpers, placed
  // by the scene every frame like the agent labels.
  const momentRefs = useRef({});
  const helperRefs = useRef({});
  const roomRefs = useRef({});
  const api = useRef(null);
  const [failed, setFailed] = useState(false);
  const [sceneVersion, setSceneVersion] = useState(0);
  const [hovered, setHovered] = useState(null);
  const [context, setContext] = useState(null);
  const contextRef = useRef(null);
  const contextOrigin = useRef(null);
  const openContext = (event, id) => {
    event.preventDefault();
    contextOrigin.current = document.activeElement;
    const rect = event.currentTarget?.getBoundingClientRect?.();
    setContext({
      id,
      x: Math.max(
        8,
        Math.min(event.clientX || rect?.left || 40, window.innerWidth - 246),
      ),
      y: Math.max(
        8,
        Math.min(
          event.clientY || rect?.bottom || 100,
          window.innerHeight - 240,
        ),
      ),
    });
  };
  const closeContext = () => {
    setContext(null);
    contextOrigin.current?.focus?.();
  };
  useEffect(() => {
    if (context) contextRef.current?.querySelector("button")?.focus();
  }, [context]);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () =>
      setFullscreen(document.fullscreenElement === host.current?.parentElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const [localRoom, setLocalRoom] = useState(null);
  const [paused, setPaused] = useState(false);
  const [localStep, setLocalStep] = useState(0);
  const [director, setDirector] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [autoCap, setAutoCap] = useState(null);
  // undefined = defer to the followAgentId prop; null = user turned follow off; id = user follow.
  const [localFollow, setLocalFollow] = useState(undefined);
  const followId = localFollow === undefined ? followAgentId : localFollow;
  const toggleFollow = () => {
    setDirector(false);
    setLocalFollow(followId != null ? null : (selected ?? null));
  };
  // The office this workspace arranged for itself: where its rooms stand,
  // what they are called and the furniture it placed. Null = the theme's own
  // layout (core/visual/OfficeLayout.js).
  const arranged = officeLayout ?? null;
  const themeDef = useMemo(
    () => ({ ...getTheme(theme), rooms: roomNames(getTheme(theme), arranged) }),
    [theme, arranged],
  );
  // The scene is rebuilt when the arrangement changes, not on every render.
  const layoutKey = useMemo(() => JSON.stringify(arranged ?? {}), [arranged]);
  // The plan the arranger draws: this environment's own room spots and the
  // desk block, as fractions of the floor, so the editor and the scene agree.
  const arrangePlan = useMemo(() => {
    if (!arranging) return null;
    const base = computeLayout(agents.length, themeDef.layoutProfile, null);
    const halfX = base.width / 2 - 0.7;
    const halfZ = base.depth / 2 - 0.6;
    const defaults = {};
    for (const id of ZONE_IDS)
      defaults[id] = {
        x: Number((base.zones[id].x / halfX).toFixed(3)),
        z: Number((base.zones[id].z / halfZ).toFixed(3)),
      };
    const xs = base.desks.map((desk) => desk.x);
    const zs = base.desks.map((desk) => desk.z);
    const propX = base.width / 2 - 0.6;
    const propZ = base.depth / 2 - 0.6;
    const deskArea = xs.length
      ? {
          minX: Math.min(...xs) / propX - 0.08,
          maxX: Math.max(...xs) / propX + 0.08,
          minZ: Math.min(...zs) / propZ - 0.08,
          maxZ: Math.max(...zs) / propZ + 0.08,
        }
      : null;
    return { defaults, deskArea, aspect: base.width / base.depth };
  }, [arranging, agents.length, themeDef.layoutProfile]);
  const graphicsChoice = useMemo(
    () =>
      resolveGraphics(
        graphics,
        {
          width: viewportWidth,
          devicePixelRatio: window.devicePixelRatio || 1,
          hardwareConcurrency: navigator.hardwareConcurrency || 8,
          deviceMemory: navigator.deviceMemory || 8,
          reducedMotion,
        },
        autoCap,
      ),
    [graphics, viewportWidth, reducedMotion, autoCap],
  );
  const preset = graphicsPreset(graphicsChoice.preset);
  const density = labelDensity ?? preset.labelDensity ?? "all";
  const detail = avatarDetail ?? preset.avatarDetail ?? "medium";
  const presentationOn = !!presentation?.enabled;
  const mask = presentationOn;
  const room = selectedRoom ?? localRoom;
  const step = presentation?.step ?? localStep;

  useEffect(() => {
    let queued = false;
    const resize = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        setViewportWidth(window.innerWidth);
      });
    };
    window.addEventListener("resize", resize, { passive: true });
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => setAutoCap(null), [graphics, viewportWidth, reducedMotion]);

  // Ordered so team mates take adjacent desks; the desk grid follows the array.
  const ordered = useMemo(() => orderByTeam(agents, teams), [agents, teams]);
  const choreography = useMemo(
    () =>
      buildChoreography({
        agents: ordered,
        handoffs,
        messages,
        artifactsByAgent,
      }),
    [ordered, handoffs, messages, artifactsByAgent],
  );

  // Moments (office/episodes.js): a recorded handoff or message between two
  // agents, or a recorded team deployment, plays once when it is new. The
  // scene choreographs them frame by frame; here they are planned, and the
  // agents in one are kept on the floor until it ends (the giver of a
  // handoff has usually just finished, and would otherwise walk out before
  // handing anything over).
  const playedRef = useRef(null);
  const episodesRef = useRef([]);
  const [episodes, setEpisodes] = useState([]);
  const [replan, setReplan] = useState(0);
  // The team whose relay the strip shows, when several are working.
  const [relayShown, setRelayShown] = useState(null);
  const knownIds = useMemo(() => new Set(ordered.map((a) => a.id)), [ordered]);
  useEffect(() => {
    // Opening the office is not the moment a handoff from a minute ago
    // happened: the first look only plays what is seconds old.
    const firstLook = playedRef.current === null;
    if (firstLook) playedRef.current = new Set();
    const now = Date.now();
    const current = episodesRef.current;
    const live = current.filter((e) => now - e.startAt < e.duration);
    const busy = new Set(live.flatMap(episodeAgents));
    const fresh = firstLook ? FIRST_LOOK_MS : EPISODE_FRESH_MS;
    const kickoffStarts = planKickoffs({
      teams: kickoffs ?? [],
      known: knownIds,
      now,
      played: playedRef.current,
      busy,
      fresh,
    });
    for (const kickoff of kickoffStarts)
      for (const id of kickoff.members) busy.add(id);
    const meetingStarts = planEpisodes({
      interactions: choreography.interactions,
      now,
      played: playedRef.current,
      busy,
      fresh,
    });
    if (
      !kickoffStarts.length &&
      !meetingStarts.length &&
      live.length === current.length
    )
      return;
    episodesRef.current = [...live, ...kickoffStarts, ...meetingStarts];
    setEpisodes(episodesRef.current);
  }, [choreography.interactions, kickoffs, knownIds, replan]);
  // Wake when the soonest moment ends: it leaves the floor, and a moment that
  // waited for one of its agents can start.
  useEffect(() => {
    if (!episodes.length) return undefined;
    const end = Math.min(...episodes.map((e) => e.startAt + e.duration));
    const timer = setTimeout(
      () => setReplan((n) => n + 1),
      Math.max(60, end - Date.now() + 40),
    );
    return () => clearTimeout(timer);
  }, [episodes]);
  /** Plays a recorded handoff again, on request, labelled as a replay. */
  const replayInteraction = useCallback(
    (interactionId) => {
      const item = choreography.interactions.find(
        (interaction) => interaction.id === interactionId,
      );
      if (!item) return;
      const now = Date.now();
      const live = episodesRef.current.filter(
        (e) => now - e.startAt < e.duration,
      );
      const [started] = planEpisodes({
        interactions: [
          { ...item, id: `replay:${item.id}:${now}`, timestamp: now },
        ],
        now,
        played: new Set(),
        busy: new Set(live.flatMap(episodeAgents)),
      });
      if (!started) return;
      episodesRef.current = [...live, { ...started, replay: true }];
      setEpisodes(episodesRef.current);
    },
    [choreography.interactions],
  );
  const held = useMemo(() => {
    const map = new Map();
    for (const episode of episodes)
      for (const id of episodeAgents(episode))
        if (!map.has(id)) map.set(id, episode);
    return map;
  }, [episodes]);
  // Desks stay put while agents come and go (stableDeskOrder): the grid
  // follows this array, and re-deriving it from the roster sent everyone to
  // a new desk whenever one agent arrived or left.
  const deskOrder = useRef([]);
  const presentAgents = useMemo(() => {
    const present = ordered.filter(
      (agent) => isOnFloor(agent) || held.has(agent.id),
    );
    const byId = new Map(present.map((agent) => [agent.id, agent]));
    deskOrder.current = stableDeskOrder(
      deskOrder.current,
      present.map((agent) => agent.id),
    );
    return deskOrder.current.map((id) => byId.get(id));
  }, [ordered, held]);
  // On the floor only for a moment: they walk out, not back to a desk.
  const heldOnly = useMemo(
    () =>
      new Set(
        presentAgents
          .filter((agent) => !isOnFloor(agent))
          .map((agent) => agent.id),
      ),
    [presentAgents],
  );
  // Team captions count who is on the floor, not the whole roster.
  const groups = useMemo(
    () => teamGroups(presentAgents, teams),
    [presentAgents, teams],
  );
  // Dashed "waiting for" lines between relay members (office/relay.js).
  const waits = useMemo(() => waitingLinks(relays ?? []), [relays]);
  // The subagents working for agents on the floor, one chip each.
  const helperChips = useMemo(
    () =>
      presentAgents.flatMap((agent) =>
        (agent.subagents ?? []).slice(0, 4).map((sub) => ({
          key: `${agent.id}:${sub.id}`,
          agentId: agent.id,
          agentName: agent.name,
          description: sub.description || "Subagent",
          eventId: sub.eventId ?? null,
        })),
      ),
    [presentAgents],
  );
  const roomList = useMemo(() => {
    if (Array.isArray(rooms) && rooms.length) return rooms;
    return ZONE_IDS.map((id) => ({ id, label: themeDef.rooms[id] ?? id }));
  }, [rooms, themeDef]);

  // Conference rooms (office/conference.js; roomPlan in office/scale.js): a
  // team relay someone is working on sits together round a table, and so
  // does each large team on a crowded floor. Nobody is hidden or shrunk: the
  // agents walk in, sit down and keep working. One plan, used by both the DOM
  // and the 3D scene, so the two never disagree about who sits where.
  const [atDesks, setAtDesks] = useState(() => new Set());
  const [invited, setInvited] = useState(() => new Set());
  const plan = useMemo(
    () =>
      roomPlan(presentAgents, {
        relays: relays ?? [],
        teamOf: (agent) => teams?.[agent.id] ?? agent.team ?? agent.role,
        atDesks,
        invited,
        // A relay member whose handoff is playing keeps its chair for it.
        holding: held,
      }),
    [presentAgents, relays, teams, atDesks, invited, held],
  );
  /** A room's team goes back to its desks. */
  const sendToDesks = useCallback((key) => {
    setAtDesks((current) => new Set(current).add(key));
    setInvited((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }, []);
  /** A team goes (back) into a conference room. */
  const bringToRoom = useCallback((key) => {
    setAtDesks((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    if (key.startsWith("team:"))
      setInvited((current) => new Set(current).add(key));
  }, []);
  const roomSizes = useMemo(
    () => new Map(plan.rooms.map((room) => [room.key, room.memberIds.length])),
    [plan],
  );

  const state = useRef({});
  state.current = {
    agents: presentAgents,
    providerSurfaces,
    onOpenProviders,
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
    graphics: graphicsChoice.preset,
    graphicsMode: graphics,
    followId,
    reducedMotion,
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
    director,
    hovered,
    plan,
    choreography,
    graphicsChoice,
    episodes,
    held,
    heldOnly,
    waits,
    relays,
    layout: arranged,
  };
  const agentKey = useMemo(
    () =>
      presentAgents
        .map(
          (a) =>
            `${a.id}:${styleKeyOf(avatarStyles?.[a.id] ?? null, a)}:${teams?.[a.id] ?? ""}`,
        )
        .join("|"),
    [presentAgents, avatarStyles, teams],
  );
  // Which beacons exist: providers with live work (see liveBeaconSurfaces).
  const beaconSurfaces = useMemo(
    () => liveBeaconSurfaces(providerSurfaces, presentAgents),
    [providerSurfaces, presentAgents],
  );
  const providerKey = useMemo(
    () =>
      beaconSurfaces
        .map((surface) => `${surface.provider}:${surface.liveSessions ?? 0}`)
        .join("|"),
    [beaconSurfaces],
  );
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
    setFailed(false);
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
    const providerLinkGroup = new THREE.Group();
    const interactionGroup = new THREE.Group();
    const activityEffectGroup = new THREE.Group();
    // Moments: the passed document, the huddle ring. Helpers: subagents.
    const episodeGroup = new THREE.Group();
    const helperGroup = new THREE.Group();
    const waitGroup = new THREE.Group();
    // Furniture this workspace placed (office/props.js).
    const propGroup = new THREE.Group();
    // The conference wing: one room per team that meets there.
    const conferenceGroup = new THREE.Group();
    scene.add(
      roomGroup,
      zoneGroup,
      providerLinkGroup,
      interactionGroup,
      waitGroup,
      activityEffectGroup,
      episodeGroup,
      helperGroup,
      propGroup,
      conferenceGroup,
      figureGroup,
    );
    const figureRes = new Resources();
    const crowd = buildCrowdField(figureGroup, figureRes);
    let roomRes = new Resources();
    let lights = createLights(
      scene,
      themeNow(),
      1,
      state.current.lighting,
    );
    let gfx = applyGraphics(
      renderer,
      scene,
      lights.sun,
      state.current.graphics,
    );
    let layout = computeLayout(
      state.current.agents.length,
      themeNow().layoutProfile,
    );
    let zones = null;
    let shell = {};
    // What is solid on the floor, and the grid used to walk round it. Both
    // are rebuilt with the room, never per frame (office/obstacles.js,
    // office/navmesh.js).
    let navObstacles = [];
    let navGrid = null;
    let figures = new Map();
    let particles = [];
    let providerBeacons = new Map();
    let providerLinks = [];
    let interactionLinks = [];
    let activityEffects = [];
    // Moment id -> its scene state (phase, spots, document token).
    const directed = new Map();
    // "agentId:subagentId" -> a helper figure and its walk.
    const helpers = new Map();
    let waitLines = [];
    // The rooms as built (conferenceLayout entries with title and colour),
    // the ones that just closed (their doors still route the walk out), who
    // sits where, and each seat's laptop state for the frame loop.
    let conferenceRes = new Resources();
    let conference = null;
    let roomLayouts = [];
    let exitLayouts = [];
    let conferenceKey = "";
    const seatMaps = new Map();
    const occupants = new Map();
    // Room key -> the slot it stands in; rooms that just left the plan (kept
    // as they were for a moment, in case the next snapshot brings them
    // back); closed rooms still being left.
    let roomSlots = new Map();
    const vanishing = new Map();
    const lingering = new Map();
    let lingerCheck = 0;
    let visible = true;
    let cameraScale = "";
    let caretOn = true;
    let cameraRestored = false;
    const minimap = minimapRef.current
      ? createMinimap(minimapRef.current, {
          onSelect: (id) => state.current.onSelect?.(id),
          onHover: (id) => hoverAgent(id),
          onSelectRoom: (id) => state.current.onSelectRoom?.(id),
          onSelectConference: (key) => focusConference(key),
        })
      : null;

    function hoverAgent(id) {
      state.current.onZoneHover?.(id);
      setHovered(id ?? null);
    }

    /** The theme, under the names this workspace gave its rooms. */
    function themeNow() {
      const base = getTheme(state.current.theme);
      return { ...base, rooms: roomNames(base, state.current.layout) };
    }

    function rebuild() {
      const themeDef = themeNow();
      // Instance buffers belong to the field, not to Resources, so they have to
      // be released before the group is emptied: switching theme rebuilds the
      // zones and would otherwise leak one set of buffers per switch.
      zones?.dispose();
      roomGroup.clear();
      zoneGroup.clear();
      propGroup.clear();
      roomRes.dispose();
      roomRes = new Resources();
      providerBeacons = new Map();
      layout = computeLayout(
        state.current.agents.length,
        themeDef.layoutProfile,
        state.current.layout,
      );
      // Furniture this workspace placed, rebuilt with the room shell.
      buildOfficeProps(propGroup, layout.props, themeDef, roomRes);
      // The same layout, read as the things an agent may not walk through.
      navObstacles = officeObstacles(layout);
      navGrid = buildNavGrid(layout, navObstacles);
      shell =
        buildRoom(roomGroup, themeDef, layout, roomRes, {
          pipeline: pipelinePanels(state.current.buildEvents ?? [], 4, {
            mask: state.current.mask,
          }),
          serviceMap: serviceMap(state.current.agents),
        }) ?? {};
      buildProviderBeacons();
      zones = buildZones(
        zoneGroup,
        themeDef,
        layout,
        state.current.agents,
        roomRes,
        {
          liveScreens: screenPlan(state.current.agents, {
            budget: gfx.screenBudget,
            selectedId: state.current.selected,
          }).live,
        },
      );
      relight();
      minimap?.setLayout(layout);
      // The conference wing, and the camera framing the floor and the wing.
      rebuildConference(true);
      if (!cameraRestored && validCamera(cameraState)) {
        cameraRestored = cam.setState(cameraState);
      }
      // Force screens to redraw with current content.
      sync(true);
    }

    function buildProviderBeacons() {
      const surfaces = liveBeaconSurfaces(
        state.current.providerSurfaces,
        state.current.agents,
      );
      if (!surfaces.length) return;
      const colors = {
        "claude-code": 0xd97745,
        codex: 0x16a085,
        copilot: 0x6487e8,
        cursor: 0x8a78e6,
        gemini: 0x4285f4,
        antigravity: 0xa568e8,
        opencode: 0x27b68a,
        aider: 0xd19a45,
        windsurf: 0x35a7c8,
      };
      const start = -((surfaces.length - 1) * 0.72) / 2;
      surfaces.forEach((surface, index) => {
        const group = new THREE.Group();
        group.position.set(start + index * 0.72, 0, -layout.scale * 0.42);
        group.userData.providerSurfaceId = surface.id;
        const color = colors[surface.provider] ?? 0x7890a8;
        const base = new THREE.Mesh(
          roomRes.cylinder(0.2, 0.25, 0.12, 18),
          roomRes.material(0x26384b, { metalness: 0.55 }),
        );
        base.position.y = 0.06;
        const core = new THREE.Mesh(
          roomRes.octahedron(0.14),
          roomRes.material(color, {
            emissive: color,
            emissiveIntensity: surface.liveSessions ? 1.15 : 0.35,
            metalness: 0.25,
          }),
        );
        core.position.y = 0.34;
        core.userData.providerSurfaceId = surface.id;
        const ring = new THREE.Mesh(
          roomRes.ring(0.2, 0.225, 32),
          roomRes.material(color, {
            emissive: color,
            emissiveIntensity: 0.35,
            side: THREE.DoubleSide,
          }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.2;
        group.add(base, core, ring);
        group.userData.core = core;
        group.userData.live = Boolean(surface.liveSessions);
        roomGroup.add(group);
        if (!providerBeacons.has(surface.provider))
          providerBeacons.set(surface.provider, group);
      });
    }

    function rebuildProviderLinks() {
      for (const link of providerLinks) link.line.geometry.dispose();
      providerLinks = [];
      providerLinkGroup.clear();
      for (const agent of state.current.agents) {
        if (!agent.activeProviderRun || !agent.provider) continue;
        const fig = figures.get(agent.id);
        const beacon = providerBeacons.get(agent.provider);
        if (!fig || !beacon) continue;
        const color = fig.color ?? 0x7890a8;
        const geometry = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(),
          new THREE.Vector3(),
        ]);
        const material = roomRes.cached(
          `provider-link:${color}`,
          () =>
            new THREE.LineBasicMaterial({
              color,
              transparent: true,
              opacity: 0.38,
            }),
        );
        const line = new THREE.Line(geometry, material);
        line.frustumCulled = false;
        providerLinkGroup.add(line);
        providerLinks.push({ line, fig, beacon });
      }
    }

    function rebuildInteractionLinks() {
      for (const link of interactionLinks) link.line.geometry.dispose();
      interactionLinks = [];
      interactionGroup.clear();
      for (const interaction of state.current.choreography?.interactions ??
        []) {
        const from = figures.get(interaction.fromAgentId);
        const to = figures.get(interaction.toAgentId);
        if (!from || !to) continue;
        const geometry = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(),
          new THREE.Vector3(),
        ]);
        const isMessage = interaction.kind === "message";
        const interactionColor = isMessage ? 0x4d9dc7 : 0x8868d8;
        const line = new THREE.Line(
          geometry,
          roomRes.cached(
            `interaction-line:${interaction.kind}`,
            () =>
              new THREE.LineBasicMaterial({
                color: interactionColor,
                transparent: true,
                opacity: isMessage ? 0.46 : 0.58,
              }),
          ),
        );
        line.frustumCulled = false;
        const token = new THREE.Mesh(
          isMessage ? roomRes.sphere(0.06) : roomRes.octahedron(0.075),
          roomRes.material(interactionColor, {
            emissive: interactionColor,
            emissiveIntensity: 0.9,
          }),
        );
        if (interaction.evidenceId != null)
          token.userData.buildEventId = interaction.evidenceId;
        interactionGroup.add(line, token);
        interactionLinks.push({ line, token, from, to, interaction });
      }
    }

    function rebuildActivityEffects() {
      activityEffects = [];
      activityEffectGroup.clear();
      const colors = EFFECT_COLORS;
      const activityProp = (cue, color) => {
        const group = new THREE.Group();
        const material = roomRes.material(color, {
          emissive: color,
          emissiveIntensity: 0.72,
        });
        const dark = roomRes.material(0x26384b, {
          emissive: color,
          emissiveIntensity: 0.18,
        });
        const add = (geometry, mat, x, y, z) => {
          const mesh = new THREE.Mesh(geometry, mat);
          mesh.position.set(x, y, z);
          mesh.userData.agentId = cue.agentId;
          group.add(mesh);
          return mesh;
        };
        if (["command", "code"].includes(cue.prop)) {
          add(roomRes.box(0.2, 0.13, 0.035), dark, 0, 0, 0);
          add(roomRes.box(0.16, 0.085, 0.012), material, 0, 0.01, -0.025);
          add(roomRes.box(0.11, 0.018, 0.08), dark, 0, -0.08, 0.035);
        } else if (["sources", "plan"].includes(cue.prop)) {
          for (let index = 0; index < 3; index += 1)
            add(
              roomRes.box(0.18 - index * 0.018, 0.025, 0.12),
              index % 2 ? dark : material,
              index * 0.012,
              index * 0.032,
              0,
            );
        } else if (["artifact", "trace"].includes(cue.prop)) {
          add(roomRes.box(0.14, 0.18, 0.018), material, 0, 0, 0);
          add(roomRes.box(0.09, 0.012, 0.012), dark, 0, 0.045, -0.018);
          add(roomRes.box(0.09, 0.012, 0.012), dark, 0, 0.012, -0.018);
        } else if (cue.prop === "message") {
          add(roomRes.sphere(0.075), material, 0, 0.02, 0);
          const tail = add(
            roomRes.cone(0.035, 0.08),
            material,
            0.045,
            -0.045,
            0,
          );
          tail.rotation.z = -0.55;
        } else if (cue.prop === "test run") {
          for (let index = 0; index < 3; index += 1)
            add(
              roomRes.box(0.055, 0.055, 0.055),
              index === 2 ? material : dark,
              (index - 1) * 0.075,
              0,
              0,
            );
        } else if (cue.prop === "query") {
          add(roomRes.cylinder(0.09, 0.09, 0.05, 18), dark, 0, -0.055, 0);
          add(roomRes.cylinder(0.09, 0.09, 0.05, 18), material, 0, 0.015, 0);
          add(roomRes.cylinder(0.09, 0.09, 0.05, 18), dark, 0, 0.085, 0);
        } else if (cue.prop === "pipeline") {
          for (let index = 0; index < 3; index += 1)
            add(
              roomRes.box(0.06, 0.06, 0.06),
              index === 1 ? material : dark,
              (index - 1) * 0.11,
              0,
              0,
            );
          add(roomRes.box(0.22, 0.018, 0.018), material, 0, 0, 0.02);
        } else if (cue.prop === "notebook") {
          const page = add(roomRes.box(0.15, 0.012, 0.11), material, 0, 0, 0);
          page.rotation.x = -0.22;
          add(roomRes.box(0.15, 0.09, 0.012), dark, 0, 0.06, 0.055);
        } else if (cue.prop === "dataset") {
          add(roomRes.cylinder(0.1, 0.1, 0.12, 20), dark, 0, 0, 0);
          add(
            roomRes.ring(0.055, 0.095, 20),
            material,
            0,
            0.065,
            0,
          ).rotation.x = -Math.PI / 2;
        } else if (cue.prop === "chart") {
          [0.07, 0.12, 0.18].forEach((height, index) =>
            add(
              roomRes.box(0.045, height, 0.04),
              index === 2 ? material : dark,
              (index - 1) * 0.065,
              height / 2 - 0.08,
              0,
            ),
          );
        } else if (["issue", "failure"].includes(cue.prop)) {
          add(roomRes.cone(0.09, 0.18), material, 0, 0, 0);
        } else {
          add(roomRes.octahedron(0.075), material, 0, 0, 0);
        }
        group.position.set(0.48, 0.72, 0);
        return group;
      };
      for (const cue of state.current.choreography?.cues ?? []) {
        if (cue.activity === "IDLE" || cue.effect === "quiet") continue;
        const fig = figures.get(cue.agentId);
        if (!fig) continue;
        // At a conference table the laptop carries the activity's colour
        // and the seated pose says the rest; a floor ring would sit under
        // the table.
        if (fig.seatKey) continue;
        const color = colors[cue.effect] ?? 0x6f86b8;
        const group = new THREE.Group();
        group.userData.agentId = cue.agentId;
        const ring = new THREE.Mesh(
          roomRes.ring(0.38, 0.42, 32),
          roomRes.material(color, {
            emissive: color,
            emissiveIntensity: 0.55,
            transparent: true,
            opacity: 0.7,
            side: THREE.DoubleSide,
          }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.userData.agentId = cue.agentId;
        group.add(ring);
        if (cue.prop) {
          const prop = activityProp(cue, color);
          group.add(prop);
        }
        activityEffectGroup.add(group);
        activityEffects.push({ group, fig, cue });
      }
    }

    /**
     * Dashed "waiting for" lines: a team member whose relay step is queued
     * behind a colleague's, drawn to that colleague (office/relay.js).
     */
    function rebuildWaitLines() {
      for (const link of waitLines) link.line.geometry.dispose();
      waitLines = [];
      waitGroup.clear();
      for (const wait of state.current.waits ?? []) {
        const from = figures.get(wait.fromAgentId);
        const to = figures.get(wait.toAgentId);
        if (!from || !to) continue;
        const geometry = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(),
          new THREE.Vector3(),
        ]);
        const line = new THREE.Line(
          geometry,
          roomRes.cached(
            "wait-line",
            () =>
              new THREE.LineDashedMaterial({
                color: 0x7d8fa6,
                dashSize: 0.18,
                gapSize: 0.14,
                transparent: true,
                opacity: 0.75,
              }),
          ),
        );
        line.frustumCulled = false;
        waitGroup.add(line);
        waitLines.push({ line, from, to });
      }
    }

    /**
     * The rooms the wing shows: the plan's (roomPlan in office/scale.js),
     * plus closed ones whose members are still walking out. Each keeps the
     * slot it had, so no room moves while another opens or closes.
     */
    function sceneRooms() {
      const planned = state.current.plan?.rooms ?? [];
      const open = new Set(planned.map((room) => room.key));
      for (const key of [...lingering.keys(), ...vanishing.keys()])
        if (open.has(key)) {
          lingering.delete(key);
          vanishing.delete(key);
        }
      const rooms = [
        ...[...lingering.values()].map((entry) => ({
          ...entry.room,
          closing: true,
        })),
        ...[...vanishing.values()].map((entry) => entry.room),
        ...planned,
      ];
      roomSlots = assignSeats(
        roomSlots,
        rooms.map((room) => room.key),
        MAX_SLOTS,
      );
      return rooms
        .filter((room) => roomSlots.has(room.key))
        .map((room) => ({ ...room, slot: roomSlots.get(room.key) }));
    }

    /**
     * Builds the conference wing (office/conferenceScene.js) when its rooms
     * change: one opens or closes, a team outgrows its table, or the floor
     * or the theme changes. A room whose team has left the plan stays up,
     * marked as closing, while they walk out; the frame loop takes it down
     * once it is empty.
     */
    function rebuildConference(force = false) {
      const planned = new Set(
        (state.current.plan?.rooms ?? []).map((room) => room.key),
      );
      // A room that leaves the plan stays as it was for a moment first: a
      // relay step finishing and its handoff starting arrive one render
      // apart, and nobody should stand up between the two.
      for (const room of roomLayouts)
        if (
          !planned.has(room.key) &&
          !room.closing &&
          !vanishing.has(room.key) &&
          !lingering.has(room.key)
        )
          vanishing.set(room.key, { room: room.plan, since: Date.now() });
      const rooms = sceneRooms();
      const key = [
        state.current.theme,
        layout.width,
        layout.depth,
        ...rooms.map(
          (room) =>
            `${room.key}@${room.slot}:${seatCount(room.memberIds.length)}${
              room.closing ? ":closing" : ""
            }`,
        ),
      ].join("|");
      if (!force && key === conferenceKey) return;
      conferenceKey = key;
      const agentsById = new Map(
        state.current.agents.map((agent) => [agent.id, agent]),
      );
      const next = conferenceLayout(rooms, layout).map((geometry, index) => {
        const room = rooms[index];
        const first = agentsById.get(room.memberIds[0]);
        return {
          ...geometry,
          plan: room,
          title: room.title,
          kind: room.kind,
          closing: Boolean(room.closing),
          color:
            room.kind === "workflow"
              ? WORKFLOW_ROOM_COLOR
              : (first?.color ?? "#7d8cc4"),
        };
      });
      // Rooms no longer built still route anyone walking out of them.
      const built = new Set(next.map((room) => `${room.key}@${room.slot}`));
      exitLayouts = [...roomLayouts, ...exitLayouts]
        .filter((room) => !built.has(`${room.key}@${room.slot}`))
        .slice(0, MAX_SLOTS);
      const lids = conference?.lids();
      conference?.dispose();
      conferenceGroup.clear();
      conferenceRes.dispose();
      conferenceRes = new Resources();
      roomLayouts = next;
      for (const roomKey of [...seatMaps.keys()])
        if (!next.some((room) => room.key === roomKey && !room.closing))
          seatMaps.delete(roomKey);
      conference = next.length
        ? buildConferenceRooms(
            conferenceGroup,
            next,
            themeNow(),
            conferenceRes,
            { lids },
          )
        : null;
      minimap?.setLayout(layout, {
        rooms: next,
        bounds: sceneBounds(layout, next),
      });
      frameScene(!force);
    }

    /**
     * Fits the camera to the floor and the wing beside it. A room opening
     * glides the view out to include it, unless the viewer has moved the
     * camera themselves (then Reset shows everything; office/camera.js).
     */
    function frameScene(smooth = false) {
      const bounds = roomLayouts.length
        ? sceneBounds(layout, roomLayouts)
        : null;
      const key = [
        layout.scale,
        layout.width,
        layout.depth,
        bounds?.minX ?? 0,
        bounds?.maxX ?? 0,
        bounds?.minZ ?? 0,
        bounds?.maxZ ?? 0,
      ]
        .map((n) => Number(n).toFixed(2))
        .join(":");
      if (key === cameraScale) return;
      cameraScale = key;
      cam.frame(
        layout.scale,
        { ...layout, bounds },
        { smooth, reducedMotion: state.current.reducedMotion },
      );
    }

    /**
     * A room that stayed out of the plan past its grace closes: its members
     * get up and walk out (sync gives them their desks again). A closed room
     * comes down once everyone has walked out of it.
     */
    function settleRooms() {
      const now = Date.now();
      let left = false;
      for (const [key, entry] of vanishing)
        if (now - entry.since > ROOM_GRACE_MS) {
          vanishing.delete(key);
          lingering.set(key, { room: entry.room, since: now });
          left = true;
        }
      if (left) {
        rebuildConference();
        sync();
      }
      let closed = false;
      for (const [key, entry] of lingering) {
        const room = roomLayouts.find((r) => r.key === key);
        const age = now - entry.since;
        let occupied = false;
        if (room)
          for (const fig of figures.values())
            if (inRoom(room, fig.pos.x, fig.pos.z)) {
              occupied = true;
              break;
            }
        if (
          (!occupied && age > ROOM_LINGER_MIN_MS) ||
          age > ROOM_LINGER_MAX_MS
        ) {
          lingering.delete(key);
          closed = true;
        }
      }
      if (closed) rebuildConference();
    }

    /**
     * Subagent helpers. Each open subagent of an agent on the floor (the
     * snapshot's `agent.subagents`: delegations not yet heard back from) is
     * a small helper that steps out of its parent to a slot beside the
     * desk. When the subagent reports back it walks to the parent and folds
     * into it. Nothing here is invented: no delegation, no helper.
     */
    function syncHelpers(now) {
      const reduced = state.current.reducedMotion;
      const wanted = new Map();
      for (const agent of state.current.agents) {
        const fig = figures.get(agent.id);
        if (!fig) continue;
        (agent.subagents ?? []).slice(0, 4).forEach((sub, index) => {
          wanted.set(`${agent.id}:${sub.id}`, { agent, fig, index });
        });
      }
      for (const [key, helper] of helpers) {
        if (wanted.has(key) || helper.phase === "returning") continue;
        helper.phase = "returning";
        helper.from.copy(helper.pos);
        helper.start = now;
        helper.ms = reduced ? 0 : HELPER_RETURN_MS;
      }
      for (const [key, want] of wanted) {
        const home = want.fig.home ?? { x: want.fig.to.x, z: want.fig.to.z };
        const spot = helperSpot(home, want.index);
        let helper = helpers.get(key);
        if (!helper || helper.phase === "returning") {
          if (helper) helperGroup.remove(helper.group);
          const group = createHelperFigure(
            want.agent.color ?? "#8aa8bd",
            figureRes,
          );
          group.traverse((object) => {
            if (object.isMesh) object.userData.agentId = want.agent.id;
          });
          const tether = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([
              new THREE.Vector3(),
              new THREE.Vector3(),
            ]),
            figureRes.cached(
              `helper-tether:${want.agent.color}`,
              () =>
                new THREE.LineBasicMaterial({
                  color: want.agent.color ?? "#8aa8bd",
                  transparent: true,
                  opacity: 0.45,
                }),
            ),
          );
          tether.frustumCulled = false;
          helperGroup.add(group, tether);
          helper = {
            key,
            agentId: want.agent.id,
            group,
            tether,
            pos: want.fig.pos.clone(),
            from: want.fig.pos.clone(),
            to: new THREE.Vector3(spot.x, 0.08, spot.z),
            start: now,
            ms: reduced ? 0 : HELPER_WALK_MS,
            phase: "arriving",
            facing: spot.facing,
            seed: helpers.size * 1.7,
          };
          helpers.set(key, helper);
        } else if (
          Math.abs(helper.to.x - spot.x) > 0.01 ||
          Math.abs(helper.to.z - spot.z) > 0.01
        ) {
          // The parent moved (a new zone): follow it.
          helper.from.copy(helper.pos);
          helper.to.set(spot.x, 0.08, spot.z);
          helper.start = now;
          helper.ms = reduced ? 0 : HELPER_WALK_MS;
          helper.phase = "arriving";
        }
        helper.facing = spot.facing;
      }
    }

    function animateHelpers(time) {
      const reduced = state.current.reducedMotion;
      for (const [key, helper] of helpers) {
        const parent = figures.get(helper.agentId);
        const t = helper.ms
          ? Math.min(1, (time - helper.start) / helper.ms)
          : 1;
        const eased = t * t * (3 - 2 * t);
        if (helper.phase === "returning") {
          // Back to the parent, folding into it over the last stretch.
          const target = parent?.pos ?? helper.from;
          helper.pos.lerpVectors(helper.from, target, eased);
          helper.group.scale.setScalar(
            Math.max(0.01, 1 - Math.max(0, (t - 0.55) / 0.45)),
          );
          if (t >= 1) {
            helperGroup.remove(helper.group, helper.tether);
            helper.tether.geometry.dispose();
            helpers.delete(key);
            continue;
          }
        } else {
          helper.pos.lerpVectors(helper.from, helper.to, eased);
          helper.group.scale.setScalar(
            helper.phase === "arriving" ? 0.3 + 0.7 * eased : 1,
          );
          if (t >= 1) helper.phase = "present";
        }
        const moving = t < 1;
        const hover =
          reduced || moving
            ? 0
            : Math.sin(time * 0.003 + helper.seed) * 0.035 + 0.035;
        helper.group.position.set(helper.pos.x, 0.08 + hover, helper.pos.z);
        const toward =
          moving && helper.phase === "returning" && parent
            ? facingToward(
                helper.pos.x,
                helper.pos.z,
                parent.pos.x,
                parent.pos.z,
              )
            : helper.facing;
        helper.group.rotation.y = toward;
        const points = helper.tether.geometry.attributes.position;
        if (parent) {
          points.setXYZ(0, parent.pos.x, 0.95, parent.pos.z);
          points.setXYZ(1, helper.pos.x, 0.68, helper.pos.z);
        }
        points.needsUpdate = true;
        helper.tether.visible = Boolean(parent) && helper.phase !== "returning";
      }
    }

    const EXIT = () => ({
      x: layout.width / 2 - 0.7,
      z: layout.depth / 2 - 0.65,
      facing: -Math.PI / 2,
      zone: "desk",
    });
    const handGiver = new THREE.Vector3();
    const handReceiver = new THREE.Vector3();

    /** A point in front of a figure, turned with it (yaw 0 faces -z). */
    function frontPoint(fig, out, { forward = 0.4, side = 0, height = 1.05 }) {
      const c = Math.cos(fig.renderYaw);
      const s = Math.sin(fig.renderYaw);
      const lz = -forward;
      out.set(
        fig.pos.x + side * c + lz * s,
        fig.pos.y + height,
        fig.pos.z - side * s + lz * c,
      );
      return out;
    }

    function walkFig(fig, spot, ms, time) {
      fig.from.copy(fig.pos);
      fig.to.set(spot.x, 0.08, spot.z);
      fig.walkStart = time;
      fig.walkMs = Math.max(1, ms);
      fig.walking = true;
    }

    function onFloor(x, z) {
      const hx = layout.width / 2 - 0.55;
      const hz = layout.depth / 2 - 0.55;
      return {
        x: Math.max(-hx, Math.min(hx, x)),
        z: Math.max(-hz, Math.min(hz, z)),
      };
    }

    function homeOf(fig) {
      return (
        fig.home ?? {
          x: fig.to.x,
          z: fig.to.z,
          facing: fig.targetYaw,
          zone: fig.zone,
        }
      );
    }

    /** Where a figure goes when its part is over: its spot, or the door. */
    function afterMoment(fig) {
      return state.current.heldOnly?.has(fig.id) ? EXIT() : homeOf(fig);
    }

    function beginKickoffPhase(episode, stage, phase, time) {
      const everyone = episode.members
        .map((id) => figures.get(id))
        .filter(Boolean);
      // Members with a conference seat hold the kickoff there: they walk in
      // through the door and the table is the meeting. The rest gather
      // round the meeting table on the floor.
      const members = everyone.filter((fig) => !fig.seatKey);
      const room = roomLayouts.find((r) =>
        everyone.some((fig) => fig.roomKey === r.key),
      );
      const walkMs = episode.duration * WALK_SHARE;
      if (phase === "approach") {
        const meetingRoom = roomFor(layout, "meeting");
        const spots = meetingRoom
          ? huddleSpots(meetingRoom, members.length)
          : [];
        stage.spots = new Map();
        members.forEach((fig, index) => {
          const spot = spots[index];
          if (!spot) return;
          stage.spots.set(fig.id, spot);
          fig.episode = {
            id: episode.id,
            target: { ...spot, zone: "meeting" },
          };
          fig.gesture = null;
          walkFig(fig, spot, walkMs, time);
        });
        const zone = meetingRoom ?? layout.zones[ZONE_IDS[0]];
        stage.ring = new THREE.Mesh(
          figureRes.ring(1.25, 1.36, 48),
          figureRes.material(0x8868d8, {
            emissive: 0x8868d8,
            emissiveIntensity: 0.6,
            transparent: true,
            opacity: 0.55,
            side: THREE.DoubleSide,
          }),
        );
        stage.ring.rotation.x = -Math.PI / 2;
        if (room && members.length < 2) {
          // Round the conference table the team is sitting down at.
          stage.ring.position.set(room.x, 0.07, room.z);
          stage.ringScale = (room.chairRadius + 0.4) / 1.3;
          stage.ring.scale.setScalar(stage.ringScale);
        } else stage.ring.position.set(zone.x, 0.04, zone.z + 0.35);
        episodeGroup.add(stage.ring);
      } else if (phase === "exchange") {
        everyone.forEach((fig, index) => {
          const spot = stage.spots?.get(fig.id);
          if (spot) fig.targetYaw = spot.facing;
          // The first member named on the team record opens the meeting.
          fig.gesture = index === 0 ? "talk" : "listen";
        });
      } else if (phase === "return") {
        for (const fig of members) {
          const back = afterMoment(fig);
          fig.episode = { id: episode.id, target: back };
          fig.gesture = null;
          walkFig(fig, back, walkMs, time);
          fig.targetYaw = back.facing ?? fig.targetYaw;
        }
        for (const fig of everyone) if (fig.seatKey) fig.gesture = null;
        if (stage.ring) {
          episodeGroup.remove(stage.ring);
          stage.ring = null;
        }
      }
    }

    /** Where a seated figure's laptop is, or null off a conference seat. */
    function laptopOf(fig) {
      if (!fig.seatKey) return null;
      const room = roomLayouts.find((r) => r.key === fig.roomKey);
      const seat = room?.seats[Number(fig.seatKey.split(":").pop())];
      return room && seat ? laptopSpot(room, seat) : null;
    }

    /**
     * Turns a figure toward another for a moment and keeps it turned (the
     * snapshot sync would otherwise face it back): fully on the floor, as
     * far as a chair allows at a table.
     */
    function turnFor(episode, fig, other) {
      const home = homeOf(fig);
      const toward = facingToward(fig.pos.x, fig.pos.z, other.pos.x, other.pos.z);
      let facing = toward;
      if (fig.seatKey) {
        const base = home.facing ?? 0;
        const d = Math.atan2(Math.sin(toward - base), Math.cos(toward - base));
        facing = base + Math.max(-0.6, Math.min(0.6, d));
      }
      fig.episode = { id: episode.id, target: { ...home, facing } };
      fig.targetYaw = facing;
    }

    /**
     * A moment with someone at a conference table: nobody gets up. At one
     * table the document slides across it (placeToken); between rooms, or a
     * room and a desk, it is sent over the glass. The two turn toward each
     * other, give and take, or speak and listen, from where they are.
     */
    function beginSeatedPhase(episode, stage, phase, giver, receiver) {
      const handoff = episode.kind === "handoff";
      if (phase === "approach") {
        giver.gesture = handoff ? "carry" : null;
        turnFor(episode, giver, receiver);
        if (handoff && !stage.token) {
          stage.token = createDocumentToken(figureRes);
          stage.token.traverse((object) => {
            object.userData.buildEventId = episode.evidenceId;
          });
          episodeGroup.add(stage.token);
        }
      } else if (phase === "exchange") {
        turnFor(episode, giver, receiver);
        turnFor(episode, receiver, giver);
        giver.gesture = handoff ? "give" : "talk";
        receiver.gesture = handoff ? "receive" : "listen";
      } else if (phase === "return") {
        for (const fig of [giver, receiver]) {
          const home = homeOf(fig);
          fig.episode = { id: episode.id, target: home };
          fig.targetYaw = home.facing ?? fig.targetYaw;
        }
        giver.gesture = null;
        receiver.gesture = handoff ? "hold" : null;
      }
    }

    function beginMeetingPhase(episode, stage, phase, time) {
      const giver = figures.get(episode.fromAgentId);
      const receiver = figures.get(episode.toAgentId);
      if (!giver || !receiver) return;
      const walkMs = episode.duration * WALK_SHARE;
      const handoff = episode.kind === "handoff";
      if (!stage.mode) {
        if (giver.seatKey && receiver.seatKey && giver.roomKey === receiver.roomKey)
          stage.mode = "table";
        else if (giver.seatKey || receiver.seatKey) stage.mode = "send";
        else stage.mode = "walk";
      }
      if (stage.mode !== "walk") {
        beginSeatedPhase(episode, stage, phase, giver, receiver);
        return;
      }
      if (phase === "approach") {
        const receiverHome = homeOf(receiver);
        const raw = meetingSpot(homeOf(giver), receiverHome);
        const at = onFloor(raw.x, raw.z);
        stage.spot = {
          x: at.x,
          z: at.z,
          facing: facingToward(at.x, at.z, receiverHome.x, receiverHome.z),
          receiverFacing: facingToward(
            receiverHome.x,
            receiverHome.z,
            at.x,
            at.z,
          ),
        };
        giver.episode = {
          id: episode.id,
          target: { ...stage.spot, zone: giver.zone },
        };
        giver.gesture = handoff ? "carry" : null;
        walkFig(giver, stage.spot, walkMs, time);
        if (handoff) {
          stage.token = createDocumentToken(figureRes);
          stage.token.userData.buildEventId = episode.evidenceId;
          stage.token.traverse((object) => {
            object.userData.buildEventId = episode.evidenceId;
          });
          episodeGroup.add(stage.token);
        }
      } else if (phase === "exchange") {
        giver.targetYaw = stage.spot.facing;
        const receiverHome = homeOf(receiver);
        receiver.episode = {
          id: episode.id,
          target: { ...receiverHome, facing: stage.spot.receiverFacing },
        };
        receiver.targetYaw = stage.spot.receiverFacing;
        giver.gesture = handoff ? "give" : "talk";
        receiver.gesture = handoff ? "receive" : "listen";
      } else if (phase === "return") {
        const back = afterMoment(giver);
        giver.episode = { id: episode.id, target: back };
        giver.gesture = null;
        walkFig(giver, back, walkMs, time);
        const receiverHome = homeOf(receiver);
        receiver.episode = { id: episode.id, target: receiverHome };
        receiver.targetYaw = receiverHome.facing ?? receiver.targetYaw;
        receiver.gesture = handoff ? "hold" : null;
      }
    }

    /** Where the passed document is: carried, handed over, then kept. */
    function placeToken(episode, stage, phase, t) {
      const token = stage.token;
      if (!token) return;
      const giver = figures.get(episode.fromAgentId);
      const receiver = figures.get(episode.toAgentId);
      if (!giver || !receiver) {
        token.visible = false;
        return;
      }
      token.visible = true;
      let share = 0;
      if (phase === "exchange")
        share = Math.min(1, Math.max(0, (t - 0.3) / 0.4));
      else if (phase === "return") share = 1;
      const from = stage.mode === "table" ? laptopOf(giver) : null;
      const to = stage.mode === "table" ? laptopOf(receiver) : null;
      if (from && to) {
        // Slid across the table from one laptop to the other.
        handGiver.set(from.x, 0.86, from.z);
        handReceiver.set(to.x, 0.86, to.z);
        token.position.lerpVectors(handGiver, handReceiver, share);
        token.position.y += Math.sin(share * Math.PI) * 0.14;
      } else {
        const seatedHand = (fig) => (fig.atSeat ? 0.84 : 1.05);
        frontPoint(giver, handGiver, {
          forward: 0.46,
          side: 0.22,
          height: seatedHand(giver),
        });
        frontPoint(receiver, handReceiver, {
          forward: 0.44,
          height: seatedHand(receiver),
        });
        token.position.lerpVectors(handGiver, handReceiver, share);
        // Sent between rooms, it arcs over the glass walls.
        const lift =
          stage.mode === "send"
            ? Math.max(0.22, 2.9 - token.position.y)
            : 0.22;
        token.position.y += Math.sin(share * Math.PI) * lift;
      }
      token.rotation.y = share < 0.5 ? giver.renderYaw : receiver.renderYaw;
      // Filed away once the giver has gone.
      token.scale.setScalar(
        phase === "return"
          ? Math.max(0.01, 1 - Math.max(0, (t - 0.6) / 0.4))
          : 1,
      );
    }

    function endMoment(id, stage) {
      if (stage.token) episodeGroup.remove(stage.token);
      if (stage.ring) episodeGroup.remove(stage.ring);
      for (const agentId of stage.agents ?? []) {
        const fig = figures.get(agentId);
        if (fig) fig.gesture = null;
      }
      directed.delete(id);
    }

    /**
     * Plays the moments planned in React (state.current.episodes). Under
     * reduced motion nobody walks or gestures: the caption says what
     * happened and the document rests between the two agents.
     */
    function directEpisodes(time) {
      // Nothing playing and nothing to clean up: allocate nothing this frame.
      if (!state.current.episodes?.length && !directed.size) return;
      const now = Date.now();
      const reduced = state.current.reducedMotion;
      const live = new Map(
        (state.current.episodes ?? []).map((episode) => [episode.id, episode]),
      );
      for (const [id, stage] of directed)
        if (!live.has(id)) endMoment(id, stage);
      for (const episode of live.values()) {
        const agents = episodeAgents(episode);
        if (!agents.every((id) => figures.has(id))) continue;
        let stage = directed.get(episode.id);
        if (!stage) {
          stage = { phase: null, agents };
          directed.set(episode.id, stage);
        }
        const { phase, t } = episodePhase(episode, now);
        if (phase === "done") {
          if (stage.phase !== "done") {
            endMoment(episode.id, stage);
            directed.set(episode.id, { phase: "done", agents: [] });
          }
          continue;
        }
        if (phase !== stage.phase) {
          stage.phase = phase;
          if (!reduced) {
            if (episode.kind === "kickoff")
              beginKickoffPhase(episode, stage, phase, time);
            else beginMeetingPhase(episode, stage, phase, time);
          } else if (episode.kind === "handoff" && !stage.token) {
            stage.token = createDocumentToken(figureRes);
            episodeGroup.add(stage.token);
          }
        }
        if (reduced && stage.token) {
          const giver = figures.get(episode.fromAgentId);
          const receiver = figures.get(episode.toAgentId);
          stage.token.position
            .lerpVectors(giver.pos, receiver.pos, 0.5)
            .setY(1.3);
          stage.token.visible = true;
        } else placeToken(episode, stage, phase, t);
        if (stage.ring)
          stage.ring.scale.setScalar(
            (stage.ringScale ?? 1) * (1 + Math.sin(time * 0.004) * 0.04),
          );
      }
    }

    function relight() {
      scene.remove(lights.hemi, lights.sun);
      lights.sun.shadow.map?.dispose();
      lights.sun.dispose();
      lights.hemi.dispose();
      lights = createLights(
        scene,
        themeNow(),
        layout.scale,
        state.current.lighting,
      );
      gfx = applyGraphics(renderer, scene, lights.sun, state.current.graphics);
    }

    function sync(force = false) {
      const {
        agents,
        reducedMotion,
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
          if (reducedMotion || !fig.group) {
            figureGroup.remove(fig.group);
            figures.delete(id);
          } else if (!fig.departing) {
            fig.departing = true;
            fig.from.copy(fig.pos);
            fig.to.set(layout.width / 2 - 0.7, 0.08, layout.depth / 2 - 0.65);
            fig.walkStart = now;
            fig.walkMs = 900;
            fig.walking = true;
            fig.targetYaw = -Math.PI / 2;
            // From a conference table: up, out through the door, and away.
            fig.seatKey = null;
            followRoute(
              fig,
              routeBetween([...roomLayouts, ...exitLayouts], fig.from, fig.to),
              { walkMs: 900 },
            );
          }
        }
      }
      const plan = state.current.plan;
      const slots = {};
      const testers = [];
      const reviewers = [];
      const occupied = [];
      let crowdFigures = 0;
      // The conference wing, then who sits where: a member keeps their
      // chair; newcomers spread round the table (office/conference.js).
      rebuildConference();
      const plannedRooms = new Map(
        (plan.rooms ?? []).map((room) => [room.key, room]),
      );
      const seatOf = new Map();
      for (const room of roomLayouts) {
        const current =
          plannedRooms.get(room.key) ?? vanishing.get(room.key)?.room;
        if (room.closing || !current) continue;
        room.plan = current;
        const seats = assignSeats(
          seatMaps.get(room.key) ?? new Map(),
          current.memberIds,
          room.seats.length,
          spreadSeats(current.memberIds.length, room.seats.length),
        );
        seatMaps.set(room.key, seats);
        for (const [id, index] of seats)
          seatOf.set(id, { room, seat: room.seats[index] });
      }
      const cueOf = new Map(
        (state.current.choreography?.cues ?? []).map((cue) => [
          cue.agentId,
          cue,
        ]),
      );
      agents.forEach((agent, i) => {
        let fig = figures.get(agent.id);
        const style = avatarStyles?.[agent.id] ?? null;
        const wantedKey = styleKeyOf(style, agent);
        const inMoment = state.current.held?.has(agent.id) ?? false;
        const sitting = seatOf.get(agent.id) ?? null;
        // An agent in a moment gestures, and one at a conference table sits
        // down and works, so both need limbs: never the crowd.
        let tier = "full";
        if (!inMoment && !sitting)
          tier = figureTier(agent, {
            visibleFigures: plan.visible.length,
            crowd: gfx.crowd,
            selectedId: state.current.selected,
            followId: state.current.followId,
            hoveredId: state.current.hovered,
          });
        if (
          fig &&
          (fig.styleKey !== wantedKey ||
            fig.detail !== detail ||
            fig.tier !== tier)
        ) {
          if (fig.group) figureGroup.remove(fig.group);
          figures.delete(agent.id);
          fig = carryOver(
            tier === "crowd"
              ? createCrowdFigure(agent, i, { style, detail })
              : createFigure(agent, i, figureRes, { style, detail }),
            fig,
          );
          fig.color = agent.color;
          figures.set(agent.id, fig);
          if (fig.group) figureGroup.add(fig.group);
        }
        if (!fig) {
          fig =
            tier === "crowd"
              ? createCrowdFigure(agent, i, { style, detail })
              : createFigure(agent, i, figureRes, { style, detail });
          fig.color = agent.color;
          fig.pos.set(layout.width / 2 - 0.7, 0.08, layout.depth / 2 - 0.65);
          fig.from.copy(fig.pos);
          fig.to.copy(fig.pos);
          fig.placed = true;
          fig.yaw = fig.targetYaw = fig.renderYaw = Math.PI / 2;
          if (fig.group) {
            fig.group.position.copy(fig.pos);
            fig.group.rotation.y = fig.yaw;
          }
          figures.set(agent.id, fig);
          if (fig.group) figureGroup.add(fig.group);
        }
        if (fig.tier === "crowd") crowdFigures++;
        // Called back while walking out (a moment needs it): turn round.
        if (fig.departing) fig.departing = false;
        // A moment that ended leaves nothing behind on the figure.
        if (!inMoment) {
          fig.episode = null;
          fig.gesture = null;
        }
        const activity = activityOf(agent);
        // The room serving this kind of work in this office, or the desk
        // when no room does (office/zones.js).
        const zoneId = zoneForActivity(activity, layout);
        let target;
        if (sitting) {
          // At a conference table the agent works where it sits, whatever
          // the activity: the laptop and the seated pose say what it is.
          target = {
            x: sitting.seat.x,
            z: sitting.seat.z,
            facing: sitting.seat.facing,
            zone: "conference",
          };
        } else if (zoneId === "desk") {
          // The desk anchor sits under the desktop, so an agent sent to it
          // stands inside its own desk. deskSeat() is the chair in front.
          target = {
            ...deskSeat(
              layout.desks[i] ?? layout.desks[layout.desks.length - 1],
            ),
            zone: "desk",
          };
        } else {
          slots[zoneId] = (slots[zoneId] ?? 0) + 1;
          const slot =
            layout.zones[zoneId].slots[(slots[zoneId] - 1) % SLOT_COUNT];
          // Simple collision avoidance: steer around slots already taken.
          target = { ...avoidCollisions(slot, occupied), zone: zoneId };
        }
        if (!sitting) occupied.push({ x: target.x, z: target.z });
        fig.seatKey = sitting
          ? `${sitting.room.key}:${sitting.seat.index}`
          : null;
        fig.roomKey = sitting?.room.key ?? null;
        const message = messageFor(messages, agent.id, { mask });
        // The activity's own spot, kept so a moment can walk back to it; while
        // a moment plays, its spot replaces the destination.
        fig.home = target;
        fig.waiting = Boolean(agent.relay) && activity === "IDLE";
        const goal = fig.episode?.target ?? target;
        const completed = applyAgentState(fig, agent, goal, {
          now,
          reducedMotion,
          talking: !!message,
        });
        // A walk into, out of or between conference rooms goes through the
        // doors and round the table, never through the glass. Any other walk
        // crosses the open floor, where the navigation grid keeps it out of
        // the desks, the rooms and the furniture (office/navmesh.js). A grid
        // that cannot find a way returns nothing and the walk goes straight,
        // because an agent that never arrives is worse than one that clips a
        // desk on the way.
        if (fig.walking && fig.walkStart === now) {
          const doors = routeBetween(
            [...roomLayouts, ...exitLayouts],
            fig.from,
            goal,
            sitting && goal === target ? sitting.seat.index : null,
          );
          if (doors.length) followRoute(fig, doors);
          else if (navGrid)
            followRoute(
              fig,
              findPath(navGrid, navObstacles, fig.from, goal) ?? [],
            );
        }
        // The laptop at a seat glows in the colour of its owner's activity.
        const cue = cueOf.get(agent.id);
        fig.screenColor = EFFECT_COLORS[cue?.effect] ?? EFFECT_COLORS.quiet;
        fig.typing = TYPING.has(activity) || activity === MANUAL_ACTIVITY;
        fig.attention = ["WAITING_APPROVAL", "BLOCKED", "ERROR"].includes(
          activity,
        );
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
          qaLabel: themeNow().rooms.qa,
          mask,
        }),
      );
      zones?.updateReview(
        reviewers.map((a) => clean(a.name, 20)),
        reviewChips(reviewers, artifactsByAgent, 3, { mask }),
      );
      zones?.updateHandoff(handoffCard(handoffs, agents, { mask }));
      // The break-area sign counted grouped idle agents; nobody is grouped.
      zones?.updateCluster(0);
      // Each room's wall board, from the plan and the relay records.
      if (conference) {
        const palette = themeNow().palette;
        const relays = new Map(
          (state.current.relays ?? []).map((relay) => [
            `workflow:${relay.workflowId}`,
            relay,
          ]),
        );
        for (const room of roomLayouts)
          conference.updateBoard(
            room.key,
            boardLines(
              room,
              plannedRooms.get(room.key) ?? vanishing.get(room.key)?.room,
              relays.get(room.key),
            ),
            { bg: palette.screenBg, fg: palette.screenFg },
          );
      }
      shell.updatePipeline?.(pipelinePanels(buildEvents ?? [], 4, { mask }));
      shell.updateServiceMap?.(serviceMap(agents));
      rebuildProviderLinks();
      rebuildInteractionLinks();
      rebuildActivityEffects();
      rebuildWaitLines();
      syncHelpers(now);
      // Counts only, so a browser test can prove the batching happened rather
      // than trusting the unit test. No agent data, no paths.
      window.__officeScale = {
        agents: agents.length,
        clustered: 0,
        rooms: roomLayouts.filter((room) => !room.closing).length,
        roomed: seatOf.size,
        visibleFigures: agents.length,
        crowdFigures,
        liveScreens: zones?.monitors.size ?? 0,
        deskMeshes: zones?.deskField?.meshes().length ?? 0,
      };
    }

    /**
     * Moves the walk state onto a replacement record so a figure that changes
     * tier or style resumes where it stood instead of snapping to its desk.
     */
    function carryOver(next, previous) {
      if (!previous) return next;
      next.pos.copy(previous.pos);
      next.from.copy(previous.from);
      next.to.copy(previous.to);
      next.yaw = previous.yaw;
      next.targetYaw = previous.targetYaw;
      next.renderYaw = previous.renderYaw;
      next.walking = previous.walking;
      next.walkStart = previous.walkStart;
      next.walkMs = previous.walkMs;
      next.placed = previous.placed;
      next.prev = previous.prev;
      next.route = previous.route;
      next.episode = previous.episode;
      next.gesture = previous.gesture;
      next.home = previous.home;
      next.waiting = previous.waiting;
      next.seatKey = previous.seatKey;
      next.roomKey = previous.roomKey;
      next.atSeat = previous.atSeat;
      if (next.group) {
        next.group.position.copy(next.pos);
        next.group.rotation.y = next.renderYaw;
      }
      return next;
    }

    /** Centres the camera on a conference room's table. */
    function focusConference(key) {
      const room = roomLayouts.find((r) => r.key === key);
      if (room) cam.focus({ x: room.x, z: room.z }, 1.5);
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
        [
          figureGroup,
          helperGroup,
          episodeGroup,
          activityEffectGroup,
          interactionGroup,
          zoneGroup,
          roomGroup,
          conferenceGroup,
        ],
        true,
      );
      // A conference room's glass stands between the camera and the agents
      // inside, so it only counts when nothing else is under the pointer.
      let room = null;
      for (const hit of hits) {
        const data = hit.object.userData ?? {};
        // A hidden object is not something the pointer can reach; three's
        // raycaster does not check visibility, so walk up.
        if (!shownInScene(hit.object)) continue;
        if (data.agentId != null) return { kind: "agent", id: data.agentId };
        if (data.roomKey != null) {
          room ??= data.roomKey;
          continue;
        }
        if (data.artifactId != null)
          return { kind: "artifact", id: data.artifactId };
        if (data.buildEventId != null)
          return { kind: "event", id: data.buildEventId };
        if (data.monitorAgentId != null)
          return { kind: "monitor", id: data.monitorAgentId };
        if (data.providerSurfaceId != null)
          return { kind: "provider", id: data.providerSurfaceId };
        // Batched desks carry their agent per instance, not per mesh.
        const instanced = agentAt(hit);
        if (instanced != null) return { kind: "monitor", id: instanced };
      }
      return room ? { kind: "room", id: room } : null;
    }
    let down = null;
    let hoveredId = null;
    let lastMove = 0;
    const pointerdown = (e) => {
      if (e.button !== 0) return;
      if (state.current.director) setDirector(false);
      down = [e.clientX, e.clientY];
    };
    const pointerup = (e) => {
      if (e.button !== 0) return;
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5)
        return;
      const hit = pick(e);
      if (!hit) return;
      if (hit.kind === "agent") state.current.onSelect?.(hit.id);
      else if (hit.kind === "room") focusConference(hit.id);
      else if (hit.kind === "artifact") state.current.onOpenArtifact?.(hit.id);
      else if (hit.kind === "event") state.current.onOpenEvent?.(hit.id);
      else if (hit.kind === "monitor") {
        if (state.current.onOpenMonitor) state.current.onOpenMonitor(hit.id);
        else state.current.onSelect?.(hit.id);
      } else if (hit.kind === "provider")
        state.current.onOpenProviders?.(hit.id);
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
    const restored = () => setSceneVersion((version) => version + 1);
    const contextmenu = (e) => {
      const hit = pick(e);
      if (hit?.kind === "agent" || hit?.kind === "monitor")
        openContext(e, hit.id);
    };
    renderer.domElement.addEventListener("contextmenu", contextmenu);
    renderer.domElement.addEventListener("pointerdown", pointerdown);
    renderer.domElement.addEventListener("pointerup", pointerup);
    renderer.domElement.addEventListener("pointermove", pointermove);
    renderer.domElement.addEventListener("webglcontextlost", lost);
    renderer.domElement.addEventListener("webglcontextrestored", restored);

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
    // Reused each frame so label de-collision allocates nothing in the loop.
    const pending = [];
    const crowdRecords = [];
    let frame = 0;
    let last = 0;
    let caretAt = 0;
    let performanceFrames = 0;
    let performanceTime = 0;
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
      if (visible && state.current.graphicsMode === "auto") {
        performanceFrames += 1;
        performanceTime += dtMs;
        if (performanceFrames >= 120) {
          const average = performanceTime / performanceFrames;
          if (average > 28 && state.current.graphics !== "low")
            setAutoCap(lowerGraphics(state.current.graphics));
          performanceFrames = 0;
          performanceTime = 0;
        }
      }
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
      cam.setFollow(followed ? followed.pos : null);
      cam.update(reducedMotion);
      directEpisodes(time);
      crowdRecords.length = 0;
      occupants.clear();
      for (const fig of figures.values()) {
        // In its chair, not on the way to it: it sits and works there. True
        // at a conference seat and at the agent's own desk, which has a
        // chair of its own — an agent working at its desk is sitting at it.
        const home = fig.home;
        const hasChair =
          home?.zone === "conference" ? Boolean(fig.seatKey) : home?.zone === "desk";
        fig.atSeat =
          hasChair &&
          !fig.walking &&
          Math.abs(fig.pos.x - home.x) < 0.05 &&
          Math.abs(fig.pos.z - home.z) < 0.05;
        animateFigure(fig, time, {
          reducedMotion,
          running,
          dtMs,
          rate: gfx.animationRate ?? 1,
          selected: selected === fig.id,
        });
        if (fig.departing && !fig.walking) {
          figureGroup.remove(fig.group);
          figures.delete(fig.id);
          continue;
        }
        if (fig.tier === "crowd") crowdRecords.push(fig);
        if (fig.seatKey) {
          // Its laptop opens once it has sat down (conferenceScene.js).
          fig.occupant ??= {};
          fig.occupant.seated = fig.atSeat;
          fig.occupant.color = fig.screenColor;
          fig.occupant.typing = fig.typing;
          fig.occupant.attention = fig.attention;
          occupants.set(fig.seatKey, fig.occupant);
        }
        const label = labels.current[fig.id];
        if (label) {
          place(label, fig.pos.x, fig.atSeat ? 2.12 : 2.4, fig.pos.z);
          // A clipped (quiet) label takes no room from the others.
          if (label.style.visibility !== "hidden" && label.offsetWidth > 2)
            pending.push({
              id: fig.id,
              el: label,
              x: parseFloat(label.style.left) || 0,
              y: parseFloat(label.style.top) || 0,
              w: label.offsetWidth || 120,
              h: label.offsetHeight || 22,
            });
        }
      }
      conference?.animate(occupants, time, dt, reducedMotion);
      if (time - lingerCheck > 200) {
        lingerCheck = time;
        if (lingering.size || vanishing.size) settleRooms();
        // How many have reached their chairs and sat down: a count only,
        // for the browser tests (see window.__officeScale in sync).
        if (window.__officeScale) {
          let seated = 0;
          for (const occupant of occupants.values())
            if (occupant.seated) seated += 1;
          window.__officeScale.seated = seated;
        }
      }
      for (const [provider, beacon] of providerBeacons) {
        const label = beaconLabels.current[provider];
        if (label) place(label, beacon.position.x, 0.78, beacon.position.z);
      }
      for (const child of roomGroup.children) {
        if (!child.userData?.core) continue;
        child.userData.core.rotation.y += reducedMotion ? 0 : dt * 0.7;
        if (child.userData.live && !reducedMotion)
          child.userData.core.position.y =
            0.34 + Math.sin(time * 0.003) * 0.035;
      }
      for (const { line, fig, beacon } of providerLinks) {
        const points = line.geometry.attributes.position;
        points.setXYZ(0, beacon.position.x, 0.34, beacon.position.z);
        points.setXYZ(1, fig.pos.x, 0.72, fig.pos.z);
        points.needsUpdate = true;
      }
      for (const { line, token, from, to, interaction } of interactionLinks) {
        const points = line.geometry.attributes.position;
        points.setXYZ(0, from.pos.x, 0.82, from.pos.z);
        points.setXYZ(1, to.pos.x, 0.82, to.pos.z);
        points.needsUpdate = true;
        // While its moment plays, the document in hand replaces the token;
        // a message between a conference table and elsewhere keeps it, as
        // nobody walks over to say it.
        const stage = directed.get(interaction.id);
        token.visible =
          !stage || (!stage.token && Boolean(stage.mode) && stage.mode !== "walk");
        const seed = String(interaction.id)
          .split("")
          .reduce((sum, character) => sum + character.charCodeAt(0), 0);
        let progress = reducedMotion ? 0.5 : (time * 0.00035 + seed * 0.01) % 1;
        if (interaction.kind === "message")
          progress = 1 - Math.abs(progress * 2 - 1);
        token.position.lerpVectors(from.pos, to.pos, progress);
        token.position.y = 0.86 + Math.sin(progress * Math.PI) * 0.42;
        if (!reducedMotion) {
          token.rotation.x += dt * 1.8;
          token.rotation.y += dt * 2.4;
        }
      }
      for (const { line, from, to } of waitLines) {
        const points = line.geometry.attributes.position;
        // Across a conference table, above its top rather than under it.
        const y = from.atSeat && to.atSeat ? 0.98 : 0.5;
        points.setXYZ(0, from.pos.x, y, from.pos.z);
        points.setXYZ(1, to.pos.x, y, to.pos.z);
        points.needsUpdate = true;
        line.computeLineDistances();
      }
      if (helpers.size) animateHelpers(time);
      // Helper chips and moment captions exist only while something plays,
      // so an idle office allocates nothing for them.
      if (helpers.size)
        for (const key in helperRefs.current) {
          const el = helperRefs.current[key];
          const helper = helpers.get(key);
          if (!el) continue;
          if (!helper || helper.phase === "returning") {
            el.style.visibility = "hidden";
            continue;
          }
          place(el, helper.pos.x, 1.32, helper.pos.z);
        }
      // Each room's sign hangs over its door, on the corridor side, clear
      // of the table; it is spread with the agent labels so it never covers
      // a name.
      for (const room of roomLayouts) {
        const el = roomRefs.current[room.key];
        if (!el) continue;
        place(el, room.bounds.minX, 2.75, room.z);
        if (el.style.visibility !== "hidden")
          pending.push({
            id: `room:${room.key}`,
            el,
            x: Number.parseFloat(el.style.left) || 0,
            y: Number.parseFloat(el.style.top) || 0,
            w: el.offsetWidth || 140,
            h: el.offsetHeight || 26,
          });
      }
      if (state.current.episodes?.length)
        for (const episode of state.current.episodes) {
          const el = momentRefs.current[episode.id];
          if (!el) continue;
          let x = 0;
          let z = 0;
          let count = 0;
          for (const agentId of episodeAgents(episode)) {
            const fig = figures.get(agentId);
            if (!fig) continue;
            x += fig.pos.x;
            z += fig.pos.z;
            count += 1;
          }
          if (!count) {
            el.style.visibility = "hidden";
            continue;
          }
          // At their feet: above their heads it covered the name labels and,
          // at the back of the room, the relay strip.
          place(el, x / count, 0, z / count);
        }
      for (const { group, fig, cue } of activityEffects) {
        group.position.set(fig.pos.x, 0.035, fig.pos.z);
        const pulse = reducedMotion
          ? 1
          : 1 + Math.sin(time * 0.004 + String(cue.agentId).length) * 0.08;
        group.scale.setScalar(pulse);
        if (!reducedMotion && group.children[1])
          group.children[1].rotation.y += dt * 2.2;
      }
      for (const [team, el] of Object.entries(teamRefs.current)) {
        if (!el) continue;
        // Members at a conference table have the room's sign instead.
        const members = [...figures.values()].filter(
          (f) => state.current.teams?.[f.id] === team && !f.seatKey,
        );
        if (!members.length) {
          el.style.visibility = "hidden";
          continue;
        }
        const x = members.reduce((sum, f) => sum + f.pos.x, 0) / members.length;
        const z = members.reduce((sum, f) => sum + f.pos.z, 0) / members.length;
        place(el, x, 3.2, z);
        if (el.style.visibility !== "hidden")
          pending.push({
            id: `team:${team}`,
            el,
            x: Number.parseFloat(el.style.left) || 0,
            y: Number.parseFloat(el.style.top) || 0,
            w: el.offsetWidth || 120,
            h: el.offsetHeight || 20,
          });
      }
      // An isometric room puts several figures at nearly the same screen
      // point, so the raw projection stacks their labels into an unreadable
      // pile. Push the collisions apart before the browser paints.
      if (pending.length > 1) {
        const spread = spreadLabels(pending);
        for (const item of pending) {
          const y = spread.get(item.id);
          if (y != null && Math.abs(y - item.y) > 0.5)
            item.el.style.top = `${y}px`;
        }
      }
      pending.length = 0;
      crowd.sync(crowdRecords);
      const hoveredFig = state.current.hovered
        ? figures.get(state.current.hovered)
        : null;
      if (previewRef.current && hoveredFig)
        place(previewRef.current, hoveredFig.pos.x, 3.1, hoveredFig.pos.z);
      particles = particles.filter((p) => {
        const alive = p.update(time, dt);
        if (!alive) p.dispose();
        return alive;
      });
      minimap?.draw({
        figures: figures.values(),
        selected,
        theme: themeNow(),
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
      focusConference,
      focusAgent: (id) => {
        const fig = figures.get(id);
        if (fig) cam.focus({ x: fig.pos.x, z: fig.pos.z }, 1.65);
      },
      placeAtCluster: (el) => {
        if (!el) return;
        const z = roomFor(layout, "breakArea") ?? layout.zones[ZONE_IDS[0]];
        place(el, z.x, 2.4, z.z + 0.3);
      },
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
      renderer.domElement.removeEventListener("contextmenu", contextmenu);
      renderer.domElement.removeEventListener("pointerdown", pointerdown);
      renderer.domElement.removeEventListener("pointerup", pointerup);
      renderer.domElement.removeEventListener("pointermove", pointermove);
      renderer.domElement.removeEventListener("webglcontextlost", lost);
      renderer.domElement.removeEventListener("webglcontextrestored", restored);
      minimap?.dispose();
      cam.dispose();
      particles.forEach((p) => p.dispose());
      for (const link of providerLinks) link.line.geometry.dispose();
      for (const link of interactionLinks) link.line.geometry.dispose();
      for (const link of waitLines) link.line.geometry.dispose();
      for (const helper of helpers.values()) helper.tether.geometry.dispose();
      zones?.dispose();
      crowd.dispose();
      conference?.dispose();
      conferenceRes.dispose();
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
  }, [sceneVersion]);

  useEffect(() => {
    api.current?.rebuild();
    // graphics is here because the screen budget is baked into the desks.
  }, [theme, agentKey, providerKey, graphicsChoice.preset, layoutKey]);

  // The handoff card states its age and leaves once its window passes, so it
  // needs a clock while there are handoffs; nothing else in the scene ticks.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!handoffs?.length) return undefined;
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [handoffs]);

  useEffect(() => {
    api.current?.sync();
  }, [
    agents,
    reducedMotion,
    testResults,
    buildEvents,
    artifactsByAgent,
    handoffs,
    clock,
    messages,
    choreography,
    mask,
    detail,
    // Selection, follow and hover keep an agent's figure in full detail.
    selected,
    followId,
    hovered,
    // An agent in a moment is drawn in full, and a relay's waiting lines
    // follow its steps.
    episodes,
    waits,
    // A room opening or closing walks its team in or out.
    plan,
  ]);

  useEffect(() => {
    api.current?.setGraphics();
  }, [graphicsChoice.preset]);

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

  // The director reads the current floor from a ref, so a data refresh (a new
  // array every snapshot) no longer restarts the tour at the first agent.
  const floorRef = useRef(presentAgents);
  floorRef.current = presentAgents;
  const hasFloor = presentAgents.length > 0;
  useEffect(() => {
    if (!director || reducedMotion || presentationOn || !hasFloor)
      return undefined;
    let index = 0;
    const focusNext = () => {
      const floor = floorRef.current;
      if (!floor.length) return;
      const agent = floor[index % floor.length];
      index += 1;
      if (agent) api.current?.focusAgent(agent.id);
    };
    focusNext();
    const timer = setInterval(focusNext, 6500);
    return () => clearInterval(timer);
  }, [director, reducedMotion, presentationOn, hasFloor]);

  const keydown = (e) => {
    const a = api.current;
    if (!a) return;
    if (
      [
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "+",
        "=",
        "-",
        "_",
      ].includes(e.key)
    )
      setDirector(false);
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
  const hoveredAgent = agents.find((a) => a.id === hovered) ?? null;
  const preview = hoverPreview(hoveredAgent, { mask });
  const reviewers = ordered.filter((a) => activityOf(a) === "REVIEWING");
  const chips = reviewChips(reviewers, artifactsByAgent, 3, { mask });
  const buildStrip = Array.isArray(buildEvents)
    ? pipelinePanels(buildEvents, 2, { mask }).filter((p) => p.id != null)
    : [];
  const handoff = handoffCard(handoffs, ordered, { mask });
  // Only a handoff between two known agents has a moment to play again.
  const replayable =
    handoff?.id != null &&
    choreography.interactions.some(
      (interaction) =>
        interaction.id === handoff.id && interaction.kind === "handoff",
    );
  const nameOf = (id) =>
    ordered.find((agent) => agent.id === id)?.name ?? "An agent";
  // A relay is shown while someone on it is working (or stuck); a stalled
  // one is on the Dependency map and the Timeline, not the floor.
  const liveRelays = (relays ?? []).filter((relay) =>
    relay.steps.some(
      (step) => step.state === "active" || step.state === "blocked",
    ),
  );
  const latestMoment = episodes.at(-1) ?? null;
  // Walking into a conference room and back is something a screen reader
  // cannot see, so the office says it: from the plan, once per change.
  const [roomNews, setRoomNews] = useState("");
  const roomTitles = useRef(new Map());
  useEffect(() => {
    const open = new Map(plan.rooms.map((room) => [room.key, room]));
    const before = roomTitles.current;
    const opened = [...open.values()].filter((room) => !before.has(room.key));
    const closed = [...before].filter(([key]) => !open.has(key));
    roomTitles.current = new Map(
      [...open].map(([key, room]) => [key, room.title]),
    );
    if (opened.length)
      setRoomNews(
        opened
          .map(
            (room) =>
              `${room.title} is meeting in a conference room: ${room.memberIds.length} at the table.`,
          )
          .join(" "),
      );
    else if (closed.length)
      setRoomNews(
        closed.map(([, title]) => `${title} went back to their desks.`).join(" "),
      );
  }, [plan]);
  const announcement = [
    latestMoment
      ? `${momentText(latestMoment, nameOf, mask).title}. ${momentSource(latestMoment)}.`
      : "",
    roomNews,
  ]
    .filter(Boolean)
    .join(" ");
  const liveLinks = useMemo(
    () => liveLinkSummaries({ agents: presentAgents, choreography }),
    [presentAgents, choreography],
  );
  // The link strip describes the selected agent only; the newest link in the
  // whole office said nothing about who the user had chosen.
  const selectedAgent = selected
    ? (presentAgents.find((a) => a.id === selected) ?? null)
    : null;
  const selectedLinks = selectedAgent
    ? liveLinks.filter(
        (link) =>
          link.to === selectedAgent.name || link.from === selectedAgent.name,
      )
    : [];
  // Studio and Operations name their floor; the other themes derive it from
  // the theme name, which the chip beside it already shows.
  const floorLabel =
    themeDef.floorLabel &&
    themeDef.floorLabel.toLowerCase() !== String(themeDef.label).toLowerCase()
      ? themeDef.floorLabel.charAt(0) +
        themeDef.floorLabel.slice(1).toLowerCase()
      : null;
  const selectRoom = (id) => {
    if (onSelectRoom) onSelectRoom(id === room ? null : id);
    else setLocalRoom(id === room ? null : id);
  };

  return (
    <div
      className={[
        "office-wrap",
        failed ? "office-failed" : "",
        `office-theme-${themeDef.id}`,
        `office-light-${lighting}`,
        presentationOn ? "office-presentation" : "",
        presentationOn && presentation?.largeLabels !== false
          ? "office-large-labels"
          : "",
        `office-labels-${density}`,
        agents.some((agent) => agent.activeProviderRun)
          ? "office-has-live"
          : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {arranging && arrangePlan
        ? createPortal(
            <OfficeArranger
              layout={arranged}
              defaults={arrangePlan.defaults}
              deskArea={arrangePlan.deskArea}
              functionNames={getTheme(theme).rooms}
              aspect={arrangePlan.aspect}
              onSave={(next) => onArrangeSave?.(next)}
              onClose={() => onArrangeClose?.()}
            />,
            document.body,
          )
        : null}
      {context &&
        createPortal(
          <div className="agent-context-backdrop" onPointerDown={closeContext}>
            <div
              className="agent-context"
              ref={contextRef}
              role="menu"
              aria-label="Agent actions"
              style={{ left: context.x, top: context.y }}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  closeContext();
                }
                if (["ArrowDown", "ArrowUp", "Tab"].includes(e.key)) {
                  e.preventDefault();
                  const buttons = [
                    ...contextRef.current.querySelectorAll(
                      "button:not(:disabled)",
                    ),
                  ];
                  const index = buttons.indexOf(document.activeElement);
                  const direction =
                    e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)
                      ? -1
                      : 1;
                  buttons[
                    (index + direction + buttons.length) % buttons.length
                  ]?.focus();
                }
              }}
            >
              <strong>
                {agents.find((a) => a.id === context.id)?.name ?? "Agent"}
              </strong>
              <button
                role="menuitem"
                onClick={() => {
                  onSelect?.(context.id);
                  closeContext();
                }}
              >
                Inspect agent & task
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setLocalFollow(context.id);
                  onSelect?.(context.id);
                  closeContext();
                }}
              >
                Follow in 3D
              </button>
              <button
                role="menuitem"
                disabled={!agents.find((a) => a.id === context.id)?.runId}
                onClick={() => {
                  onOpenMonitor?.(context.id);
                  closeContext();
                }}
              >
                Open recorded run
              </button>
              <button role="menuitem" onClick={closeContext}>
                Close
              </button>
            </div>
          </div>,
          // In fullscreen only the fullscreen element is painted, so the menu
          // has to live inside it or it opens invisibly.
          document.fullscreenElement ?? document.body,
        )}
      <div className="office-meta">
        <span>
          <i className="dot blue" aria-hidden="true" /> {themeDef.label}
          {floorLabel ? (
            <span className="office-floor">{floorLabel}</span>
          ) : null}
          {followedAgent && (
            <em className="office-follow">Following {followedAgent.name}</em>
          )}
        </span>
        {!failed ? (
          <span>
            {plan.rooms.length || plan.reason === "at-desks" ? (
              <button
                type="button"
                className="office-rooms-toggle"
                onClick={() => {
                  if (plan.rooms.length) {
                    setAtDesks(
                      (current) =>
                        new Set([
                          ...current,
                          ...plan.rooms.map((room) => room.key),
                        ]),
                    );
                    setInvited(new Set());
                  } else setAtDesks(new Set());
                }}
                title={
                  plan.rooms.length
                    ? "Every team leaves its conference room and walks back to its desks"
                    : "Teams working together walk back into their conference rooms"
                }
              >
                {plan.rooms.length
                  ? "Everyone back to desks"
                  : "Use conference rooms"}
              </button>
            ) : null}
            <em className="office-quality" title={graphicsChoice.reason}>
              {graphicsChoice.preset} ·{" "}
              {graphics === "auto" ? "auto" : "manual"}
            </em>
          </span>
        ) : null}
      </div>
      {/* Provider presence is shown once, in the top-bar pulse, and in the 3D
          beacons here. The scene no longer adds a third copy as a DOM dock. */}
      {!failed && selectedLinks.length > 0 && (
        <div
          className="office-live-links"
          role="group"
          aria-label={`Recorded links for ${selectedAgent?.name ?? "the selected agent"}`}
        >
          {selectedLinks.slice(0, 1).map((link) => (
            <button
              type="button"
              key={link.id}
              className={`link-${link.tone}`}
              onClick={() => {
                if (link.kind === "provider" && link.evidenceId) {
                  const agent = presentAgents.find(
                    (item) => item.runId === link.evidenceId,
                  );
                  if (agent) onOpenMonitor?.(agent.id);
                } else if (link.evidenceId) onOpenEvent?.(link.evidenceId);
              }}
              disabled={!link.evidenceId}
              title={`${link.from} to ${link.to}: ${link.label}`}
            >
              <i aria-hidden="true" />
              <span>
                <strong>
                  {link.from} {"->"} {link.to}
                </strong>
                <small>{link.label}</small>
              </span>
            </button>
          ))}
        </div>
      )}
      <div
        className={`office-canvas ${failed ? "is-failed" : ""}`}
        ref={host}
        role="group"
        tabIndex={failed ? -1 : 0}
        onKeyDown={keydown}
        aria-label="Office scene. Arrow keys pan, plus and minus zoom, F follows the selected agent."
      >
        {!failed && showMap && (
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
        {!failed && presentAgents.length === 0 && (
          <div className="office-floor-empty" role="status">
            <strong>The office is ready.</strong>
            <span>Agents will walk in when recorded work begins.</span>
          </div>
        )}
        {!failed &&
          presentAgents.map((agent) => {
            const tone = statusTone(agent);
            const inferred = agent.activityProvenance === "inferred";
            const manual = !inferred && activityOf(agent) === MANUAL_ACTIVITY;
            const chip = hostChip(agent);
            const style = avatarStyles?.[agent.id] ?? null;
            const pron = pronounsOf(style);
            const shown = showLabel(agent, density, selected);
            const message = messageFor(messages, agent.id, { mask });
            const provider = providerLabel(agent);
            const describedBy = `scene-desc-${agent.id}`;
            const role = momentRole(held.get(agent.id), agent.id, nameOf);
            // On the floor only for a moment: it has finished, so there is no
            // assistant at work to name.
            const momentOnly = heldOnly.has(agent.id);
            // Round a busy conference table the room's chip names the team,
            // and a label per chair would bury the room: each one waits for
            // a hover, a selection, keyboard focus or a moment, unless its
            // agent needs attention. The button itself never leaves.
            const seatRoom = plan.roomOf.get(agent.id);
            const quietSeat =
              Boolean(seatRoom) &&
              (roomSizes.get(seatRoom) ?? 0) >= QUIET_ROOM_SIZE &&
              (tone === "green" || tone === "gray") &&
              selected !== agent.id &&
              hovered !== agent.id &&
              followId !== agent.id &&
              !held.has(agent.id) &&
              !message;
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
                  quietSeat ? "scene-label-seated" : "",
                  message ? "scene-label-talking" : "",
                  inferred ? "is-inferred" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-describedby={describedBy}
                // Which agent is selected was a colour and a ring only; the
                // roster beside it has said so all along.
                aria-pressed={selected === agent.id}
                onClick={() => onSelect?.(agent.id)}
                onContextMenu={(e) => openContext(e, agent.id)}
                onKeyDown={(e) => {
                  if (
                    e.key === "ContextMenu" ||
                    (e.shiftKey && e.key === "F10")
                  )
                    openContext(e, agent.id);
                }}
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
                    ? `${activityLabel(agent)} · ${
                        // The 3D monitor masks this same field; a browser
                        // tooltip that does not would show the full private
                        // path while the footer claims paths are masked.
                        mask ? maskPrivate(agent.taskTitle) : agent.taskTitle
                      }`
                    : activityLabel(agent)
                }
                style={{ "--agent-color": agent.color }}
              >
                <i className={`dot ${tone}`} aria-hidden="true" />
                {agent.name}
                {pron && <span className="scene-pronouns">{pron}</span>}
                {/* An agent created from a session is named after its
                    provider; the badge would only repeat the name. */}
                {provider !== agent.name && !momentOnly ? (
                  <span className="scene-provider">{provider}</span>
                ) : null}
                {role ? (
                  <span className="scene-moment-role">{role}</span>
                ) : null}
                {chip && <span className="scene-host">Host: {chip}</span>}
                <span className="scene-activity">
                  {activityLabel(agent)}
                  {inferred ? " (inferred)" : ""}
                  {manual ? " (manual)" : ""}
                </span>
                {/* Screen readers hear the state the label shows on hover:
                    activity, whether it was inferred, and the provider. */}
                <span id={describedBy} className="sr-only">
                  {activityLabel(agent)}
                  {inferred ? ", inferred from tool names" : ""}
                  {manual
                    ? ", a manual task: nothing reports its activity"
                    : ""}
                  , {provider}
                  {agent.taskTitle && !mask ? `, ${agent.taskTitle}` : ""}
                </span>
                {message && (
                  <span className="scene-message">
                    “{message.summary}” · {message.attribution}
                  </span>
                )}
              </button>
            );
          })}
        {/* Each provider beacon carries its name, so the glowing marker on the
            floor says what it is: the assistant behind live work. */}
        {!failed &&
          beaconSurfaces.map((surface) => {
            const name =
              PROVIDER_LABELS[surface.provider] ??
              surface.label ??
              surface.provider;
            const live = surface.liveSessions ?? 0;
            const detail = live
              ? `${live} live session${live === 1 ? "" : "s"}`
              : "managed run";
            return (
              <button
                key={surface.provider}
                type="button"
                ref={(el) => {
                  beaconLabels.current[surface.provider] = el;
                }}
                className="beacon-label"
                style={{ visibility: "hidden" }}
                onClick={() => onOpenProviders?.(surface.id)}
                aria-label={`${name}: ${detail}. Open connections.`}
                title={`${name}: ${detail}. The beacon links this assistant to the agent doing the work.`}
              >
                <i aria-hidden="true" data-provider={surface.provider} />
                {name}
                <small>{detail}</small>
              </button>
            );
          })}
        {!failed &&
          groups.map((group) => {
            // A team at its desks can meet round a conference table from its
            // own caption; a team in a room has the room's chip instead.
            const key = `team:${group.team}`;
            if (plan.rooms.some((room) => room.key === key))
              return (
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
              );
            const full = plan.rooms.length >= MAX_ROOMS;
            return (
              <button
                key={group.team}
                type="button"
                ref={(el) => {
                  teamRefs.current[group.team] = el;
                }}
                className="scene-team is-control"
                style={{ visibility: "hidden" }}
                disabled={full}
                onClick={() => bringToRoom(key)}
                aria-label={`${group.team}: meet in a conference room`}
                title={
                  full
                    ? "Every conference room is in use"
                    : "Walk this team into a conference room to work round one table"
                }
              >
                {group.team} · {group.agentIds.length} · Meet
              </button>
            );
          })}
        {/* Conference rooms: a sign over each door names the team and how
            many sit at the table; hover or focus opens what they are doing
            and the way back to their desks. */}
        {!failed &&
          plan.rooms.map((room) => {
            const summary = activitySummary(room, ACTIVITY_LABELS);
            const first = presentAgents.find(
              (agent) => agent.id === room.memberIds[0],
            );
            const color =
              room.kind === "workflow"
                ? WORKFLOW_ROOM_COLOR
                : (first?.color ?? "#7d8cc4");
            const seated = room.memberIds.length;
            return (
              <div
                key={room.key}
                ref={(el) => {
                  if (el) roomRefs.current[room.key] = el;
                  else delete roomRefs.current[room.key];
                }}
                className="scene-room"
                role="group"
                aria-label={`${room.title} conference room`}
                style={{ visibility: "hidden", "--room-color": color }}
              >
                <button
                  type="button"
                  className="scene-room-look"
                  onClick={() => api.current?.focusConference(room.key)}
                  title="Look into this room"
                  aria-label={`${room.title}: ${seated} at the table${
                    summary ? `, ${summary}` : ""
                  }${
                    room.overflow ? `, ${room.overflow} more at their desks` : ""
                  }. Look into the room.`}
                >
                  <strong>{room.title}</strong>
                  <span className="scene-room-count">{seated}</span>
                </button>
                <div className="scene-room-more">
                  <small>
                    {seated} at the table{summary ? ` · ${summary}` : ""}
                    {room.overflow
                      ? ` · ${room.overflow} more at their desks`
                      : ""}
                  </small>
                  <button
                    type="button"
                    className="scene-room-leave"
                    onClick={() => sendToDesks(room.key)}
                    title="Everyone in this room walks back to their desk"
                    aria-label={`${room.title}: back to desks`}
                  >
                    Back to desks
                  </button>
                </div>
              </div>
            );
          })}
        {/* Subagents: one chip over each helper, opening the recorded
            delegation that started it. */}
        {!failed &&
          helperChips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              ref={(el) => {
                if (el) helperRefs.current[chip.key] = el;
                else delete helperRefs.current[chip.key];
              }}
              className="scene-helper"
              style={{ visibility: "hidden" }}
              onClick={() =>
                chip.eventId
                  ? onOpenEvent?.(chip.eventId)
                  : onSelect?.(chip.agentId)
              }
              aria-label={`Subagent of ${chip.agentName}: ${mask ? maskPrivate(chip.description) : chip.description}`}
              title={`Subagent working for ${chip.agentName}: ${mask ? maskPrivate(chip.description) : chip.description}`}
            >
              <i aria-hidden="true" />
              {clean(
                mask ? maskPrivate(chip.description) : chip.description,
                30,
              )}
            </button>
          ))}
        {/* A playing moment's caption: what passed between whom, and whether
            it was recorded, simulated or replayed. Opens the event. */}
        {!failed &&
          episodes.map((episode) => {
            const text = momentText(episode, nameOf, mask);
            return (
              <button
                key={episode.id}
                type="button"
                ref={(el) => {
                  if (el) momentRefs.current[episode.id] = el;
                  else delete momentRefs.current[episode.id];
                }}
                className={`scene-moment moment-${episode.kind}`}
                style={{ visibility: "hidden" }}
                onClick={() =>
                  episode.evidenceId && onOpenEvent?.(episode.evidenceId)
                }
                title={`${text.title}${text.line ? `: ${text.line}` : ""}. Open the recorded event.`}
              >
                <strong>{text.title}</strong>
                {text.line ? <span>{text.line}</span> : null}
                {text.detail ? <small>{text.detail}</small> : null}
                <em>{momentSource(episode)}</em>
              </button>
            );
          })}
        {!failed && liveRelays.length > 0 && (
          <RelayStrip
            relays={liveRelays}
            current={relayShown}
            onPick={setRelayShown}
            onSelect={onSelect}
            mask={mask}
          />
        )}
        <div className="sr-only" role="status" aria-live="polite">
          {announcement}
        </div>
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
              {preview.manual && !preview.inferred ? " (manual)" : ""}
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
            <strong>
              Handoff{" "}
              <time dateTime={new Date(handoff.at).toISOString()}>
                · {handoff.age}
              </time>
            </strong>
            <span>
              {handoff.from} → {handoff.to}
            </span>
            <span>{handoff.title || "task title not recorded"}</span>
            {handoff.id != null && onOpenEvent && (
              <button onClick={() => onOpenEvent(handoff.id)}>
                Open handoff event
              </button>
            )}
            {replayable ? (
              <button
                type="button"
                onClick={() => replayInteraction(handoff.id)}
                disabled={reducedMotion}
                title={
                  reducedMotion
                    ? "Moments do not play with reduced motion on"
                    : "Play this recorded handoff again in the office"
                }
              >
                Replay the handoff
              </button>
            ) : null}
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
        {/* Always mounted while the scene runs: the scene binds the minimap to
            this canvas once, when it is built, so a canvas that appeared only
            after the map toggle was never drawn. The toggle just shows it. */}
        {!failed && (
          <canvas
            ref={minimapRef}
            className="office-minimap"
            width={150}
            height={110}
            hidden={!showMap}
            role="img"
            // It promised a click to people who cannot click: the dots and
            // rooms it draws are the roster and the room signs, which are
            // ordinary controls.
            aria-label="Office minimap: the floor, its conference rooms and where each agent stands. The agent list repeats it in text."
            title="Click an agent dot to select it, or a room to focus it"
          />
        )}
        {failed && (
          <div className="scene-fallback" role="status">
            <h3>The team is still here.</h3>
            <p>
              3D rendering stopped. Provider observation and task execution
              continue independently.
            </p>
            <button
              className="button primary"
              type="button"
              onClick={() => setSceneVersion((version) => version + 1)}
            >
              Retry 3D workspace
            </button>
            <p>Select an agent below to keep working in the accessible view.</p>
            {agents.map((a) => (
              <button key={a.id} onClick={() => onSelect?.(a.id)}>
                {a.name} · {a.role ?? providerLabel(a)} · {activityLabel(a)}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="office-bottom">
        <span className="office-hint">
          <MousePointer2 size={13} aria-hidden="true" />
          <span className="office-hint-text">
            Drag to orbit · Scroll to zoom · Arrows pan · F follows
          </span>
        </span>
        <div className="camera-tools">
          {selected && (
            <button
              title="Selected agent actions"
              aria-label="Selected agent actions"
              onClick={(event) => openContext(event, selected)}
            >
              <MoreHorizontal size={16} />
            </button>
          )}
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
            title={showMap ? "Hide office map" : "Show office map"}
            aria-label={showMap ? "Hide office map" : "Show office map"}
            aria-pressed={showMap}
            onClick={() => setShowMap((value) => !value)}
          >
            <MapIcon size={15} />
          </button>
          <button
            title="Live camera director"
            aria-label="Live camera director"
            aria-pressed={director}
            disabled={reducedMotion || presentationOn || !presentAgents.length}
            onClick={() => {
              setLocalFollow(null);
              setDirector((value) => !value);
            }}
          >
            <Video size={15} />
          </button>
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
            title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            aria-pressed={fullscreen}
            onClick={() => {
              const el = host.current?.parentElement;
              if (document.fullscreenElement) document.exitFullscreen?.();
              else el?.requestFullscreen?.().catch(() => {});
            }}
          >
            {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        </div>
      </div>
    </div>
  );
}
