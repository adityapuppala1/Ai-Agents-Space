// What each agent's 3D portrait on the Agents page shows, from recorded state
// only: an agent with work sits at its laptop in the pose the office uses at a
// conference table (typing, reading, a raised hand for an approval, hands in
// the lap when blocked); an agent with none stands beside an empty chair. The
// laptop screen takes the activity's colour. Pure: no three, no DOM, so
// node:test covers it; office/portraitStage.js draws it.
import { activityOf } from "./data.js";

const TYPING = new Set(["CODING", "COMMANDING", "DEBUGGING", "MANUAL"]);
const READING = new Set(["RESEARCHING", "ANALYZING", "TESTING", "REVIEWING"]);
const ATTENTION = new Set(["WAITING_APPROVAL", "BLOCKED", "ERROR", "STALE"]);

/** Laptop screen colour per kind of work (the office's effect colours). */
export const SCREEN_TONES = Object.freeze({
  typing: 0x28a17d,
  reading: 0x5b8be0,
  talking: 0x7a75dc,
  approval: 0xd39d3e,
  alarm: 0xc84f4f,
  quiet: 0x6f86b8,
});

/**
 * The portrait for `agent` in directory state `state` ("attention" |
 * "working" | "idle", from agentState in hooks/viewLogic.js):
 * { seated, laptop, typing, tone, attention, key }. `key` changes exactly
 * when the drawing must change.
 */
export function portraitScene(agent, state = "idle") {
  const activity = activityOf(agent);
  const busy = state !== "idle";
  let tone = "quiet";
  if (TYPING.has(activity)) tone = "typing";
  else if (READING.has(activity)) tone = "reading";
  else if (activity === "MESSAGING" || activity === "DELEGATING")
    tone = "talking";
  else if (activity === "WAITING_APPROVAL") tone = "approval";
  else if (activity === "BLOCKED" || activity === "ERROR") tone = "alarm";
  return {
    seated: busy,
    laptop: busy,
    typing: busy && TYPING.has(activity),
    tone,
    attention: ATTENTION.has(activity),
    key: [
      activity,
      state,
      agent?.color ?? "",
      agent?.provider ?? "",
      agent?.role ?? "",
    ].join("|"),
  };
}

/**
 * How often a portrait redraws, per second: a working agent moves, an idle
 * one only breathes, and under reduced motion nothing animates at all (it is
 * drawn when its state changes).
 */
export function portraitFps(scene, { reducedMotion = false } = {}) {
  if (reducedMotion) return 0;
  return scene?.seated ? 24 : 8;
}
