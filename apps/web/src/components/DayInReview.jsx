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
  RUN_STATUS_LABELS,
} from "../hooks/useApi.js";
import ProviderBadge from "./ProviderBadge.jsx";
import Provenance from "./Provenance.jsx";
import EmptyState from "./EmptyState.jsx";
import EventLink from "./EventLink.jsx";
import { buildChapter } from "../hooks/viewLogic.js";

/* Chapter assembly is in ../hooks/viewLogic.js (covered by node:test). */
export { buildChapter };

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
 * "Day in review": a playback assembled from recorded events for a date range.
 *
 * Honesty rules this component follows:
 *  - Every beat is a stored event and links to it; there is no narration, no
 *    generated summary, and no invented progress.
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
    try {
      reducedMotion.current =
        globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ??
        false;
    } catch {
      reducedMotion.current = false;
    }
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
      for (const run of inRange.slice(0, 40)) {
        try {
          const detail = await apiFetch(`/runs/${encodeURIComponent(run.id)}`);
          built.push(
            buildChapter(
              detail?.run ?? run,
              detail?.events ?? [],
              detail?.artifacts ?? [],
            ),
          );
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

  const flat = useMemo(
    () =>
      chapters.flatMap((chapter) =>
        chapter.beats.map((beat) => ({ chapter, beat })),
      ),
    [chapters],
  );

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

  return (
    <section className="as-dayreview" aria-label="Day in review">
      <header className="as-section-head">
        <h3>
          <CalendarDays size={14} aria-hidden="true" /> Day in review
        </h3>
        <span className="as-tag">assembled from recorded events</span>
      </header>
      <p className="as-muted as-small">
        Every beat below is a stored event, shown in the order it was recorded,
        with a link to the event and to the artifact it produced. Agent Space
        writes no narration and adds no commentary.
      </p>

      <div className="as-row as-wrap as-dayreview-range">
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
            : `Assemble ${inRange.length} run${inRange.length === 1 ? "" : "s"}`}
        </button>
      </div>

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
          <div
            className="as-row as-wrap as-dayreview-controls"
            role="group"
            aria-label="Playback controls"
          >
            <button
              type="button"
              className="icon-button"
              onClick={() => setIndex((value) => Math.max(0, value - 1))}
              disabled={index === 0}
              aria-label="Previous beat"
            >
              <SkipBack size={14} />
            </button>
            <button
              type="button"
              className="button"
              onClick={() => setPlaying((value) => !value)}
              aria-pressed={playing}
              disabled={reducedMotion.current}
              title={
                reducedMotion.current
                  ? "Auto-advance is off because this browser asks for reduced motion. Step with the arrows."
                  : undefined
              }
            >
              {playing ? <Pause size={12} /> : <Play size={12} />}{" "}
              {playing ? "Pause" : "Play"}
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() =>
                setIndex((value) => Math.min(flat.length - 1, value + 1))
              }
              disabled={index >= flat.length - 1}
              aria-label="Next beat"
            >
              <SkipForward size={14} />
            </button>
            <label className="as-scrubber as-dayreview-scrubber">
              Beat {flat.length ? index + 1 : 0} of {flat.length}
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
                    : "no beats"
                }
              />
            </label>
            <span className="as-muted as-small">
              {chapters.length} run{chapters.length === 1 ? "" : "s"} ·{" "}
              {totalEvents} recorded events · {flat.length} milestones
            </span>
          </div>

          <ol className="as-dayreview-list" aria-label="Recorded chapters">
            {chapters.map((chapter) => {
              const containsCurrent = current?.chapter.runId === chapter.runId;
              return (
                <li
                  key={chapter.runId}
                  className={`as-dayreview-chapter ${containsCurrent ? "active" : ""}`}
                >
                  <header className="as-row as-wrap">
                    <ProviderBadge
                      provider={chapter.provider}
                      mode={chapter.mode}
                      size="small"
                    />
                    <strong>{maskText(chapter.title, presentation)}</strong>
                    <span className="as-tag">
                      {RUN_STATUS_LABELS[chapter.status] ?? chapter.status}
                    </span>
                    <span className="as-muted as-small">
                      {formatTime(chapter.startedAt)}
                      {chapter.endedAt
                        ? ` · ${formatElapsed(new Date(chapter.endedAt) - new Date(chapter.startedAt))}`
                        : " · still running"}
                    </span>
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
                  {!chapter.unavailable && chapter.beats.length === 0 ? (
                    <p className="as-muted as-small">
                      No milestone events are retained for this run
                      {chapter.eventCount
                        ? ` (${chapter.eventCount} other events recorded).`
                        : "; retention may have removed them."}
                    </p>
                  ) : null}

                  <ol className="as-dayreview-beats">
                    {chapter.beats.map((beat) => {
                      const isCurrent =
                        containsCurrent && current?.beat.id === beat.id;
                      return (
                        <li
                          key={beat.id}
                          className={`as-dayreview-beat ${isCurrent ? "current" : ""}`}
                          aria-current={isCurrent ? "step" : undefined}
                        >
                          <time
                            dateTime={new Date(beat.timestamp).toISOString()}
                          >
                            {formatTime(beat.timestamp)}
                          </time>
                          <span className="as-event-kind">{beat.kind}</span>
                          <span className="as-event-msg">
                            {maskText(beat.text, presentation, 6)}
                          </span>
                          {beat.file ? (
                            <code className="as-mono as-small">
                              {presentation
                                ? basename(beat.file)
                                : maskPath(beat.file, false)}
                            </code>
                          ) : null}
                          <Provenance value={beat.provenance} />
                          <EventLink
                            size="small"
                            event={beat.event}
                            runId={chapter.runId}
                            label="cite"
                            showProvenance={false}
                            onOpenEvent={onOpenEvent}
                          />
                        </li>
                      );
                    })}
                  </ol>

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
