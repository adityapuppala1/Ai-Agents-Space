// Optional ambient room tone, synthesized with the WebAudio API (no assets).
// Off by default; never starts under reduced motion; stops on unmount.
//
// The tone is two detuned low sine waves through a low-pass filter at a very
// quiet gain. Nothing is recorded or sent anywhere.

const GAIN = 0.012;
const FADE = 0.9;

export function createAmbientSound({ reducedMotion = false } = {}) {
  let ctx = null;
  let nodes = null;
  let enabled = false;
  let disposed = false;

  const supported = () =>
    typeof window !== "undefined" &&
    typeof (window.AudioContext ?? window.webkitAudioContext) === "function";

  function build() {
    if (nodes || !supported()) return;
    const Ctor = window.AudioContext ?? window.webkitAudioContext;
    try {
      ctx = ctx ?? new Ctor();
    } catch {
      ctx = null;
      return;
    }
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 320;
    filter.Q.value = 0.6;
    const oscillators = [
      { freq: 58, type: "sine" },
      { freq: 87.5, type: "sine" },
      { freq: 116, type: "triangle" },
    ].map(({ freq, type }) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      const level = ctx.createGain();
      level.gain.value = type === "triangle" ? 0.18 : 0.5;
      osc.connect(level).connect(filter);
      osc.start();
      return { osc, level };
    });
    filter.connect(gain).connect(ctx.destination);
    nodes = { gain, filter, oscillators };
  }

  function ramp(to) {
    if (!ctx || !nodes) return;
    const now = ctx.currentTime;
    nodes.gain.gain.cancelScheduledValues(now);
    nodes.gain.gain.setValueAtTime(nodes.gain.gain.value, now);
    nodes.gain.gain.linearRampToValueAtTime(to, now + FADE);
  }

  const api = {
    get playing() {
      return enabled && !!nodes;
    },
    supported,
    /** Turns the tone on or off. Reduced motion keeps it off. */
    setEnabled(next) {
      if (disposed) return;
      const want = !!next && !reducedMotion;
      if (want === enabled) return;
      enabled = want;
      if (!want) {
        ramp(0);
        ctx?.suspend?.().catch(() => {});
        return;
      }
      build();
      if (!nodes) {
        enabled = false;
        return;
      }
      ctx?.resume?.().catch(() => {});
      ramp(GAIN);
    },
    setReducedMotion(next) {
      reducedMotion = !!next;
      if (reducedMotion && enabled) api.setEnabled(false);
    },
    dispose() {
      disposed = true;
      enabled = false;
      if (nodes) {
        for (const { osc, level } of nodes.oscillators) {
          try {
            osc.stop();
          } catch {
            /* already stopped */
          }
          osc.disconnect();
          level.disconnect();
        }
        nodes.filter.disconnect();
        nodes.gain.disconnect();
        nodes = null;
      }
      ctx?.close?.().catch(() => {});
      ctx = null;
    },
  };
  return api;
}
