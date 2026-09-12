import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  CalendarDays,
  Package,
} from "lucide-react";
import {
  apiFetch,
  useApi,
  formatTime,
  formatElapsed,
  maskPath,
  maskText,
  maskArtifact,
  basename,
  providerLabel,
  RUN_STATUS_LABELS,
} from "../hooks/useApi.js";
import Provenance from "./Provenance.jsx";
import EmptyState from "./EmptyState.jsx";
import EventLink from "./EventLink.jsx";
import { buildChapter, chapterDigest, digestLine } from "../hooks/viewLogic.js";

/* Chapter assembly is in ../hooks/viewLogic.js (covered by node:test). */
export { buildChapter };

/** Runs read per assembly; the page says when a range holds more. */
const CHAPTER_LIMIT = 40;
/** Events read per run, in pages; a longer run says it was cut. */
const EVENT_PAGE = 5000;
const EVENT_LIMIT = 20000;

/**
 * One milestone row. The time is the citation: it opens the recorded event.
 * Provenance is shown only where it differs from the run's own source, and
 * context the tool added is labelled and kept to one line.
 */
function BeatRow({
  beat,
  runId,
  runProvenance,
  isCurrent,
  presentation,
  onOpenEvent,
}) {
  const text = maskText(beat.text, presentation, 6);
  return (
    <li
      className={`dr-beat${isCurrent ? " current" : ""}${beat.injected ? " is-injected" : ""}`}
      aria-current={isCurrent ? "step" : undefined}
    >
      <EventLink
        size="small"
        event={beat.event}
        runId={runId}
        label={formatTime(beat.timestamp)}
        describe={`${beat.label}: ${String(text).slice(0, 80)}`}
        showTime={false}
        showProvenance={false}
        onOpenEvent={onOpenEvent}
      />
      <span className="dr-kind">
        {beat.injected ? "Added by the tool" : beat.label}
      </span>
      <span className="dr-text">
        {text}
        {beat.file ? (
          <code className="dr-file">
            {presentation ? basename(beat.file) : maskPath(beat.file, false)}
          </code>
        ) : null}
      </span>
      {beat.provenance && beat.provenance !== runProvenance ? (
        <Provenance value={beat.provenance} />
      ) : (
        <span aria-hidden="true" />
      )}
    </li>
  );
}

function startOfDay(date) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value.getTime();
}

function toDateInput(ms) {
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * "Day in review": what each run in a date range did, assembled from recorded
 * events. Each run shows counts of its milestones (prompts, files edited,
 * commands, tests, approvals, errors), the files it touched and a few key
 * moments; the full milestone list is one click away. Playback steps through
 * the key moments.
 *
 * Honesty rules this component follows:
 *  - Every moment is a stored event and links to it; the digest is counts of
 *    recorded events, never narration, a generated summary or progress.
 *  - Text a tool added to the conversation (attachment lists, reminders) is
 *    labelled "Added by the tool" instead of passing as the person's prompt.
 *  - Artifacts are cited by their real id and opened through the inspector.
 *  - Runs whose events were removed by retention say so instead of showing an
 *    empty chapter.
 *  - Auto-advance is disabled under `prefers-reduced-motion`; stepping stays.
 *
 * @param {{
 *   workspaceId: string,
 *   runs?: any[],                       // optional; otherwise GET /api/workspaces/:id/runs
 *   onOpenRun?: (runId: string) => void,
 *   onOpenEvent?: (ref: { runId:string, eventId:string, event:any }) => void,
 *   presentation?: boolean,
 *   date?: string                       // yyyy-mm-dd; defaults to today
 * }} props
 */
export default function DayInReview({
  workspaceId,
  runs: givenRuns,
  onOpenRun,
  onOpenEvent,
  presentation = false,
  date,
}) {
  const today = toDateInput(Date.now());
  const [from, setFrom] = useState(date ?? today);
  const [to, setTo] = useState(date ?? today);
  const [chapters, setChapters] = useState([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const reducedMotion = useRef(false);

  useEffect(() => {
    let query = null;
    try {
      query =
        globalThis.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
    } catch {
      query = null;
    }
    if (!query) {
      reducedMotion.current = false;
      return undefined;
    }
    // Subscribed, not read once: every other surface reacts when the OS
    // setting changes, and a review that keeps auto-advancing until a reload
    // is exactly what the person just asked it to stop doing.
    const apply = () => {
      reducedMotion.current = query.matches;
    };
    apply();
    query.addEventListener?.("change", apply);
    return () => query.removeEventListener?.("change", apply);
  }, []);

  const fetched = useApi(
    givenRuns ? null : `/workspaces/${encodeURIComponent(workspaceId)}/runs`,
  );
  const allRuns = useMemo(() => {
    const source =
      givenRuns ??
      (Array.isArray(fetched.data) ? fetched.data : (fetched.data?.runs ?? []));
    return Array.isArray(source) ? source : [];
  }, [givenRuns, fetched.data]);

  const inRange = useMemo(() => {
    const start = startOfDay(`${from}T00:00:00`);
    const end = startOfDay(`${to}T00:00:00`) + 24 * 3600 * 1000 - 1;
    return allRuns
      .filter((run) => {
        if (!run.startedAt) return false;
        const at = new Date(run.startedAt).getTime();
        return at >= start && at <= end;
      })
      .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
  }, [allRuns, from, to]);

  const assemble = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const built = [];
      for (const run of inRange.slice(0, CHAPTER_LIMIT)) {
        try {
          const id = encodeURIComponent(run.id);
          const detail = await apiFetch(`/runs/${id}`);
          // The run detail carries only its first 1000 events; read the rest
          // page by page so the counts describe the whole run.
          const events = [...(detail?.events ?? [])];
          let more = events.length >= 1000;
          while (more && events.length < EVENT_LIMIT) {
            const after = events.at(-1)?.sequence ?? 0;
            const page = await apiFetch(
              `/runs/${id}/events?after=${after}&limit=${EVENT_PAGE}`,
            );
            const list = page?.events ?? [];
            events.push(...list);
            more = list.length === EVENT_PAGE;
          }
          built.push({
            ...buildChapter(
              detail?.run ?? run,
              events,
              detail?.artifacts ?? [],
            ),
            truncated: more,
          });
        } catch (err) {
          built.push({
            ...buildChapter(run, [], []),
            unavailable: err?.message ?? "This run's events could not be read.",
          });
        }
      }
      setChapters(built);
      setIndex(0);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [inRange]);

  useEffect(() => {
    setChapters([]);
    setPlaying(false);
  }, [from, to, workspaceId]);

  const digests = useMemo(
    () =>
      new Map(
        chapters.map((chapter) => [chapter.runId, chapterDigest(chapter)]),
      ),
    [chapters],
  );
  // Playback steps through the key moments, not every recorded milestone:
  // hundreds of beats cannot be followed one at a time.
  const flat = useMemo(
    () =>
      chapters.flatMap((chapter) =>
        (digests.get(chapter.runId)?.keyMoments ?? []).map((beat) => ({
          chapter,
          beat,
        })),
      ),
    [chapters, digests],
  );
  const [openAll, setOpenAll] = useState(() => new Set());
  const toggleAll = (runId, open) =>
    setOpenAll((current) => {
      const next = new Set(current);
      if (open) next.add(runId);
      else next.delete(runId);
      return next;
    });

  useEffect(() => {
    if (!playing || flat.length === 0) return undefined;
    if (reducedMotion.current) {
      setPlaying(false);
      return undefined;
    }
    const timer = setInterval(() => {
      setIndex((value) => {
        if (value + 1 >= flat.length) {
          setPlaying(false);
          return value;
        }
        return value + 1;
      });
    }, 1400);
    return () => clearInterval(timer);
  }, [playing, flat.length]);

  const current = flat[index] ?? null;
  const totalEvents = chapters.reduce(
    (sum, chapter) => sum + chapter.eventCount,
    0,
  );
  const dayTotals = useMemo(() => {
    const counts = {
      prompts: 0,
      commands: 0,
      tests: 0,
      approvals: 0,
      delegations: 0,
      errors: 0,
    };
    const files = new Set();
    for (const digest of digests.values()) {
      for (const key of Object.keys(counts)) counts[key] += digest.counts[key];
      for (const file of digest.files) files.add(file.path);
    }
    return digestLine(counts, [...files]);
  }, [digests]);

  return (
    <section className="as-dayreview dr" aria-label="Day in review">
      <header className="dr-head">
        <p className="dr-lead">
          <CalendarDays size={15} aria-hidden="true" /> What each run did,
          assembled from recorded events. Every moment links to the event it
          came from; Agent Space adds no narration.
        </p>
        <div className="dr-range">
          <label className="as-inline-label">
            From
            <input
              type="date"
              value={from}
              max={to}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label className="as-inline-label">
            To
            <input
              type="date"
              value={to}
              min={from}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="button primary"
            onClick={assemble}
            disabled={loading || inRange.length === 0}
          >
            {loading
              ? "Assembling…"
              : `Assemble ${Math.min(inRange.length, CHAPTER_LIMIT)} run${Math.min(inRange.length, CHAPTER_LIMIT) === 1 ? "" : "s"}`}
          </button>
        </div>
        {inRange.length > CHAPTER_LIMIT ? (
          <p className="as-muted as-small">
            {inRange.length} runs started in this range; the first{" "}
            {CHAPTER_LIMIT} are assembled. Narrow the range to see the rest.
          </p>
        ) : null}
      </header>

      {fetched.error ? (
        <EmptyState
          compact
          title="Runs could not be loaded"
          error={fetched.error}
          missingRoutes={["GET /api/workspaces/:id/runs"]}
        />
      ) : null}
      {error ? (
        <div className="form-error" role="alert">
          {error.message}
        </div>
      ) : null}

      {!loading && chapters.length === 0 && inRange.length === 0 ? (
        <EmptyState
          compact
          icon={<CalendarDays size={20} />}
          title="No runs started in this range"
          description="Pick a day when an agent worked, or widen the range."
        />
      ) : null}

      {chapters.length ? (
        <>
          <div className="dr-summary">
            <p>
              <strong>
                {chapters.length} run{chapters.length === 1 ? "" : "s"}
              </strong>
              {dayTotals ? ` · ${dayTotals}` : ""}
            </p>
            <p className="as-muted as-small">
              From {totalEvents.toLocaleString()} recorded events
              {chapters.some((chapter) => chapter.truncated)
                ? `; runs longer than ${EVENT_LIMIT.toLocaleString()} events are counted up to that point`
                : ""}
              .
            </p>
          </div>
          <div
            className="dr-controls"
            role="group"
            aria-label="Playback controls"
          >
            <button
              type="button"
              className="icon-button"
              onClick={() => setIndex((value) => Math.max(0, value - 1))}
              disabled={index === 0}
              aria-label="Previous moment"
            >
              <SkipBack size={14} />
            </button>
            <button
              type="button"
              className="button"
              onClick={() => setPlaying((value) => !value)}
              aria-pressed={playing}
              disabled={reducedMotion.current || flat.length === 0}
              title={
                reducedMotion.current
                  ? "Auto-advance is off because this browser asks for reduced motion. Step with the arrows."
                  : undefined
              }
            >
              {playing ? <Pause size={12} /> : <Play size={12} />}{" "}
              {playing ? "Pause" : "Play key moments"}
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() =>
                setIndex((value) => Math.min(flat.length - 1, value + 1))
              }
              disabled={index >= flat.length - 1}
              aria-label="Next moment"
            >
              <SkipForward size={14} />
            </button>
            <label className="as-scrubber dr-scrubber">
              Moment {flat.length ? index + 1 : 0} of {flat.length}
              <input
                type="range"
                min={0}
                max={Math.max(0, flat.length - 1)}
                value={index}
                onChange={(event) => setIndex(Number(event.target.value))}
                disabled={flat.length === 0}
                aria-valuetext={
                  current
                    ? `${formatTime(current.beat.timestamp)} ${current.beat.text}`
                    : "no moments"
                }
              />
            </label>
          </div>

          <ol
            className="as-dayreview-list dr-list"
            aria-label="Recorded chapters"
          >
            {chapters.map((chapter) => {
              const digest = digests.get(chapter.runId);
              const containsCurrent = current?.chapter.runId === chapter.runId;
              const provider =
                chapter.provider && chapter.provider !== "manual"
                  ? providerLabel(chapter.provider)
                  : null;
              // A provider run's events come from the provider; only an event
              // with a different source (a person's decision, the system)
              // carries its own provenance chip.
              const runProvenance =
                chapter.mode === "observed" || chapter.mode === "managed"
                  ? "provider"
                  : null;
              const line = digest
                ? digestLine(digest.counts, digest.files)
                : "";
              const showAll = openAll.has(chapter.runId);
              const timing = `${formatTime(chapter.startedAt)}${
                chapter.endedAt
                  ? ` · ${formatElapsed(new Date(chapter.endedAt) - new Date(chapter.startedAt))}`
                  : " · still running"
              }`;
              return (
                <li
                  key={chapter.runId}
                  className={`as-dayreview-chapter dr-chapter ${containsCurrent ? "active" : ""}`}
                >
                  <header className="dr-chapter-head">
                    <div className="dr-chapter-title">
                      <strong>{maskText(chapter.title, presentation)}</strong>
                      <span className="as-muted as-small">
                        {[
                          provider,
                          RUN_STATUS_LABELS[chapter.status] ?? chapter.status,
                          timing,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>
                    {onOpenRun ? (
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => onOpenRun(chapter.runId)}
                      >
                        Open run
                      </button>
                    ) : null}
                  </header>

                  {chapter.unavailable ? (
                    <p className="as-error-text">{chapter.unavailable}</p>
                  ) : null}
                  {chapter.truncated ? (
                    <p className="as-muted as-small">
                      Counted from the first {EVENT_LIMIT.toLocaleString()}{" "}
                      events; this run recorded more. Open the run for the rest.
                    </p>
                  ) : null}
                  {!chapter.unavailable && chapter.beats.length === 0 ? (
                    <p className="as-muted as-small">
                      No milestone events are retained for this run
                      {chapter.eventCount
                        ? ` (${chapter.eventCount} other events recorded).`
                        : "; retention may have removed them."}
                    </p>
                  ) : null}

                  {line ? <p className="dr-digest">{line}</p> : null}
                  {digest?.files.length ? (
                    <p className="dr-files">
                      <span className="as-muted">Files: </span>
                      {digest.files
                        .slice(0, 6)
                        .map((file) => basename(file.path))
                        .join(", ")}
                      {digest.files.length > 6
                        ? ` and ${digest.files.length - 6} more`
                        : ""}
                    </p>
                  ) : null}

                  {digest?.keyMoments.length ? (
                    <>
                      <h4 className="dr-subhead">Key moments</h4>
                      <ol className="dr-beats">
                        {digest.keyMoments.map((beat) => (
                          <BeatRow
                            key={beat.id}
                            beat={beat}
                            runId={chapter.runId}
                            runProvenance={runProvenance}
                            isCurrent={
                              containsCurrent && current?.beat.id === beat.id
                            }
                            presentation={presentation}
                            onOpenEvent={onOpenEvent}
                          />
                        ))}
                      </ol>
                    </>
                  ) : null}

                  {digest && digest.beats.length > digest.keyMoments.length ? (
                    <details
                      className="dr-all"
                      open={showAll}
                      onToggle={(event) =>
                        toggleAll(chapter.runId, event.currentTarget.open)
                      }
                    >
                      <summary>
                        All {digest.beats.length} recorded milestones
                        {digest.counts.injected
                          ? ` (${digest.counts.injected} added by the tool)`
                          : ""}
                      </summary>
                      {showAll ? (
                        <ol className="dr-beats">
                          {digest.beats.map((beat) => (
                            <BeatRow
                              key={beat.id}
                              beat={beat}
                              runId={chapter.runId}
                              runProvenance={runProvenance}
                              isCurrent={false}
                              presentation={presentation}
                              onOpenEvent={onOpenEvent}
                            />
                          ))}
                        </ol>
                      ) : null}
                    </details>
                  ) : null}

                  {chapter.artifacts.length ? (
                    <div className="as-row as-wrap as-dayreview-artifacts">
                      <Package size={12} aria-hidden="true" />
                      <span className="as-muted as-small">Produced:</span>
                      {chapter.artifacts.map((artifact) => {
                        const shown = maskArtifact(artifact, presentation);
                        return (
                          <button
                            key={artifact.id}
                            type="button"
                            className="as-chip"
                            onClick={() => onOpenRun?.(chapter.runId)}
                            aria-label={`Open the run that produced ${shown.title}`}
                          >
                            {shown.title}
                            {!presentation && artifact.kind
                              ? ` · ${artifact.kind}`
                              : ""}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </>
      ) : null}
    </section>
  );
}
