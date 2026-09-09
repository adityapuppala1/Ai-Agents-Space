import fs from "node:fs";

/**
 * Incremental JSONL tailer shared by every observer.
 *
 * Provider transcripts grow while a session runs, so callers keep a byte
 * offset per file and ask for "everything complete since then". A partial
 * trailing line (no newline yet) is never returned; it is picked up on the
 * next call once the provider finishes writing it.
 */

const CHUNK_SIZE = 64 * 1024;
/** A single line longer than this is skipped rather than buffered forever. */
const MAX_LINE_BYTES = 32 * 1024 * 1024;

/** `fs.statSync` that returns null instead of throwing. */
export function fileStat(path) {
  try {
    return fs.statSync(path);
  } catch {
    return null;
  }
}

/** Parses one JSONL line; returns null for blank, invalid, or non-object lines. */
export function parseJsonLine(line) {
  if (typeof line !== "string") return null;
  const text = line.trim();
  if (!text || text[0] !== "{") return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

/**
 * Reads complete lines starting at byte `offset`.
 *
 * Returns `{ lines: [{ line, offset }], offset, eof, size, reset }` where
 * each `line` is a string without its trailing `\r\n`/`\n`, `offset` on a
 * line is the byte position where that line starts (stable id material),
 * the top-level `offset` is the byte position after the last complete line,
 * and `eof` is true when nothing (or only a partial line) remains. `reset`
 * is true when the file shrank below the requested offset (rotated or
 * truncated), in which case reading restarted from 0.
 */
export function readNewLines(path, offset = 0, { maxBytes = 1_000_000 } = {}) {
  const stat = fileStat(path);
  if (!stat || !stat.isFile()) {
    return {
      lines: [],
      offset: offset ?? 0,
      eof: true,
      size: 0,
      missing: true,
    };
  }
  let start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  let reset = false;
  if (start > stat.size) {
    start = 0;
    reset = true;
  }
  if (start === stat.size) {
    return { lines: [], offset: start, eof: true, size: stat.size, reset };
  }

  let fd;
  try {
    fd = fs.openSync(path, "r");
  } catch {
    return { lines: [], offset: start, eof: true, size: stat.size, reset };
  }
  const chunks = [];
  let total = 0;
  let position = start;
  let sawNewline = false;
  let reachedEnd = false;
  try {
    while (true) {
      const chunk = Buffer.allocUnsafe(CHUNK_SIZE);
      const bytesRead = fs.readSync(fd, chunk, 0, CHUNK_SIZE, position);
      if (bytesRead <= 0) {
        reachedEnd = true;
        break;
      }
      const slice = chunk.subarray(0, bytesRead);
      chunks.push(slice);
      total += bytesRead;
      position += bytesRead;
      if (slice.includes(0x0a)) sawNewline = true;
      // Stop once we have enough bytes and at least one complete line; keep
      // going when a single line straddles the budget, up to a hard cap.
      if (total >= maxBytes && sawNewline) break;
      if (total >= MAX_LINE_BYTES) break;
    }
  } finally {
    fs.closeSync(fd);
  }

  const buffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total);
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline === -1) {
    // Only a partial line so far. If it is absurdly long, skip it entirely so
    // the tailer cannot stall on a corrupt file.
    if (total >= MAX_LINE_BYTES) {
      return {
        lines: [],
        offset: start + total,
        eof: reachedEnd || start + total >= stat.size,
        size: stat.size,
        reset,
        skippedBytes: total,
      };
    }
    return { lines: [], offset: start, eof: true, size: stat.size, reset };
  }

  const lines = [];
  let lineStart = 0;
  while (lineStart <= lastNewline) {
    const newline = buffer.indexOf(0x0a, lineStart);
    if (newline === -1 || newline > lastNewline) break;
    let end = newline;
    if (end > lineStart && buffer[end - 1] === 0x0d) end -= 1;
    const line = buffer.toString("utf8", lineStart, end);
    if (line.length) lines.push({ line, offset: start + lineStart });
    lineStart = newline + 1;
  }
  const nextOffset = start + lastNewline + 1;
  return {
    lines,
    offset: nextOffset,
    // eof: no further complete line exists yet (a partial tail still counts).
    eof: reachedEnd || position >= stat.size,
    size: stat.size,
    reset,
  };
}

/**
 * Reads the last `maxBytes` of a file and returns its complete lines. Used
 * for cheap "what happened most recently" summaries without scanning the
 * whole transcript.
 */
export function readTailLines(path, { maxBytes = 64 * 1024 } = {}) {
  const stat = fileStat(path);
  if (!stat || !stat.isFile() || stat.size === 0) return [];
  const start = Math.max(0, stat.size - maxBytes);
  const result = readNewLines(path, start, { maxBytes: maxBytes * 2 });
  // The first line is likely cut when we did not start at 0.
  return start > 0 ? result.lines.slice(1) : result.lines;
}
