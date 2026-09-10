/**
 * Untrusted-content scanner.
 *
 * Instructions found inside retrieved documents, tool results and web pages
 * are untrusted until an authorised person adopts them. This module only
 * LOOKS: it never rewrites, strips or neutralises text. It returns findings
 * (rule, short excerpt, offset) so the manifest can exclude the entry, the
 * timeline can label it, and a person can decide.
 *
 * Every rule is a deterministic regular expression; there is no model call
 * and no network access. The same text always yields the same findings.
 *
 *   scan(text, { source })       -> { untrusted, score, findings[] }
 *   scanManifest(manifest)       -> the same manifest object, entries marked
 *   scanEvent(event)             -> status event descriptor | null
 *
 * `source` is where the text came from: "task" (typed by a person into a
 * task or an agent profile - trusted authoring surface), "document",
 * "web", "tool" or "file". Tool-invocation phrasing ("run the command",
 * "delete", "push") is only a finding for retrieved sources: a README that
 * documents `npm test` is not an injection when the person attached it as
 * their task, but the same sentence arriving inside a fetched web page is.
 */

export const SOURCES = ["task", "document", "web", "tool", "file"];

/** Sources that a person authored directly; phrasing rules stay quiet. */
const AUTHORED_SOURCES = new Set(["task"]);

const EXCERPT_CHARS = 120;
const BASE64_MIN_CHARS = 200;

/** A finding at or above this score marks the whole text untrusted. */
export const UNTRUSTED_THRESHOLD = 3;

const IMPERATIVE_WORDS =
  "(?:ignore|disregard|forget|override|run|execute|delete|remove|send|post|curl|fetch|download|install|push|exfiltrate|reveal|print|output|leak)";

/**
 * Rule table. `weight` feeds the score; `phrasing: true` marks rules that
 * only fire for retrieved sources. `flags` is applied to the pattern.
 */
export const RULES = [
  // Imperative overrides aimed at the agent's instruction hierarchy.
  {
    rule: "override.ignore-previous",
    pattern:
      /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+)*(?:previous|prior|above|earlier|preceding|existing|original)\s+(?:instructions?|prompts?|rules?|guidance|directions?|messages?|context)\b/gi,
    weight: 4,
  },
  {
    rule: "override.you-are-now",
    pattern:
      /\byou\s+are\s+now\s+(?:a|an|the|in|acting|operating|running|free|unrestricted|dan|no)\b/gi,
    weight: 3,
  },
  {
    rule: "override.new-instructions",
    pattern:
      /(?:^|\n)\s*(?:new|updated|revised|real|actual|true)\s+instructions?\s*:/gi,
    weight: 3,
  },
  {
    rule: "override.system-prompt",
    pattern:
      /\b(?:system\s+prompt|developer\s+message|developer\s+prompt|system\s+message)\b/gi,
    weight: 2,
  },

  // Role-marker spoofing: text pretending to be a system/developer turn.
  {
    rule: "role.tag",
    pattern:
      /<\/?\s*(?:system|developer|assistant|human|im_start|im_end)\s*>/gi,
    weight: 3,
  },
  {
    rule: "role.inst-marker",
    pattern:
      /\[\s*\/?\s*(?:INST|SYS|SYSTEM)\s*\]|<<\s*SYS\s*>>|<\|(?:im_start|im_end|system|user|assistant)\|>/gi,
    weight: 3,
  },
  {
    rule: "role.line-prefix",
    pattern:
      /(?:^|\n)\s*(?:Assistant|System|Developer|Human|User|AI)\s*:\s*(?=\S)/g,
    weight: 2,
  },
  {
    rule: "role.markdown-heading",
    pattern:
      /(?:^|\n)\s*#{1,6}\s*(?:instruction|instructions|system|system prompt|new task|override)\s*(?:\n|$)/gi,
    weight: 2,
  },

  // Hidden text: comments carrying imperatives, zero-width runs, long
  // base64 blobs that a reader cannot audit by eye.
  {
    rule: "hidden.html-comment",
    pattern: new RegExp(
      `<!--(?:(?!-->)[\\s\\S]){0,2000}?\\b${IMPERATIVE_WORDS}\\b(?:(?!-->)[\\s\\S]){0,2000}?-->`,
      "gi",
    ),
    weight: 3,
  },
  {
    rule: "hidden.zero-width",
    // U+200B..U+200D, U+2060, U+FEFF - built from code points so the source
    // file stays plain ASCII and no editor can silently strip the class.
    pattern: new RegExp(
      `[${String.fromCharCode(0x200b, 0x200c, 0x200d, 0x2060, 0xfeff)}]{2,}`,
      "g",
    ),
    weight: 2,
  },
  {
    rule: "hidden.base64-blob",
    pattern: new RegExp(`[A-Za-z0-9+/]{${BASE64_MIN_CHARS},}={0,2}`, "g"),
    weight: 2,
  },

  // Exfiltration cues.
  {
    rule: "exfil.send-to-url",
    pattern:
      /\b(?:send|post|upload|forward|transmit|submit|exfiltrate)\b[^\n]{0,120}?\bto\s+https?:\/\//gi,
    weight: 4,
  },
  {
    rule: "exfil.curl-data",
    pattern:
      /\bcurl\b[^\n]{0,200}?\s(?:-d|--data(?:-\w+)?|-F|--form|-T|--upload-file)\b/gi,
    weight: 3,
  },
  {
    rule: "exfil.post-contents",
    pattern:
      /\b(?:post|send|upload|paste|share|leak|reveal|print|dump)\s+(?:the\s+|all\s+|every\s+|your\s+)*(?:contents?|secrets?|credentials?|tokens?|api\s+keys?|passwords?|environment|env\s+vars?|\.env|private\s+keys?)\b/gi,
    weight: 3,
  },

  // Tool-invocation phrasing aimed at the agent. Only counted for retrieved
  // sources (document, web, tool, file), never for task text.
  {
    rule: "tool.run-command",
    pattern:
      /\b(?:run|execute|invoke|launch)\s+(?:the\s+|this\s+|that\s+|following\s+)?(?:command|script|shell|program|binary|following)\b/gi,
    weight: 2,
    phrasing: true,
  },
  {
    rule: "tool.execute",
    pattern:
      /\b(?:execute|eval|evaluate)\s+(?:the\s+|this\s+|that\s+)?(?:code|snippet|payload|following)\b/gi,
    weight: 2,
    phrasing: true,
  },
  {
    rule: "tool.delete",
    pattern:
      /\b(?:delete|remove|wipe|erase|rm\s+-rf)\s+(?:all\s+|every\s+|the\s+|your\s+)*(?:files?|folders?|directory|directories|repo|repository|database|tables?|history|logs?|branch(?:es)?|\S*\/\S*)\b/gi,
    weight: 2,
    phrasing: true,
  },
  {
    rule: "tool.push",
    pattern:
      /\b(?:push|force[- ]push|commit\s+and\s+push|deploy|publish)\s+(?:this|these|the|all|your|it|to)\b/gi,
    weight: 2,
    phrasing: true,
  },
];

function normalizeSource(source) {
  const value = String(source ?? "document").toLowerCase();
  if (SOURCES.includes(value)) return value;
  if (value === "url" || value === "page" || value === "http") return "web";
  if (value === "knowledge" || value === "doc") return "document";
  return "document";
}

function excerptAt(text, offset, length) {
  const start = Math.max(0, offset - 20);
  const end = Math.min(text.length, offset + Math.max(length, 1) + 60);
  let out = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (out.length > EXCERPT_CHARS) out = `${out.slice(0, EXCERPT_CHARS - 1)}…`;
  return out;
}

/**
 * scan(text, { source = "document", maxFindings = 50 })
 *
 * Returns `{ untrusted, score, source, findings }`. The text is never
 * modified. `findings[]` are ordered by offset and each carries the rule
 * id, a short excerpt (for a person to judge) and the character offset.
 */
export function scan(text, { source = "document", maxFindings = 50 } = {}) {
  const src = normalizeSource(source);
  const input = typeof text === "string" ? text : String(text ?? "");
  const findings = [];
  let score = 0;
  if (!input.trim())
    return { untrusted: false, score: 0, source: src, findings };
  const authored = AUTHORED_SOURCES.has(src);
  for (const rule of RULES) {
    if (rule.phrasing && authored) continue;
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match;
    let count = 0;
    while ((match = pattern.exec(input)) !== null) {
      if (match[0].length === 0) {
        pattern.lastIndex++;
        continue;
      }
      // Offsets point at the matched token, not the preceding newline.
      const lead = match[0].match(/^\s*/)?.[0].length ?? 0;
      const offset = match.index + lead;
      findings.push({
        rule: rule.rule,
        excerpt: excerptAt(input, offset, match[0].length - lead),
        offset,
        weight: rule.weight,
      });
      score += rule.weight;
      count++;
      if (count >= 10 || findings.length >= maxFindings) break;
    }
    if (findings.length >= maxFindings) break;
  }
  findings.sort((a, b) => a.offset - b.offset);
  return {
    untrusted: score >= UNTRUSTED_THRESHOLD,
    score,
    source: src,
    findings,
  };
}

function textOf(entry) {
  if (!entry || typeof entry !== "object") return null;
  for (const key of ["text", "content", "body", "excerpt"])
    if (typeof entry[key] === "string") return entry[key];
  return null;
}

/**
 * scanManifest(manifest, { readFile })
 *
 * Marks every `files[]` and `documents[]` entry with `untrusted`,
 * `untrustedScore` and `findings`. File entries are scanned through the
 * optional `readFile(path) -> string|null` callback (the manifest itself
 * never holds file contents); document entries are scanned when they carry
 * `text`/`content`. Entries without readable text are marked
 * `untrusted: false` with `scanned: false` so nobody mistakes "not
 * checked" for "checked and clean". Returns the manifest.
 */
export function scanManifest(manifest, { readFile = null } = {}) {
  if (!manifest || typeof manifest !== "object") return manifest;
  for (const file of manifest.files ?? []) {
    if (!file || typeof file !== "object") continue;
    let text = textOf(file);
    if (text === null && readFile && file.path) {
      try {
        text = readFile(file.path);
      } catch {
        text = null;
      }
    }
    applyResult(file, text, "file");
  }
  for (const doc of manifest.documents ?? []) {
    if (!doc || typeof doc !== "object") continue;
    const source =
      doc.source === "web" || /^https?:\/\//i.test(String(doc.ref ?? ""))
        ? "web"
        : "document";
    applyResult(doc, textOf(doc), source);
  }
  return manifest;
}

function applyResult(entry, text, source) {
  if (typeof text !== "string") {
    entry.scanned = false;
    entry.untrusted = false;
    entry.untrustedScore = 0;
    entry.findings = [];
    return;
  }
  const result = scan(text, { source });
  entry.scanned = true;
  entry.untrusted = result.untrusted;
  entry.untrustedScore = result.score;
  entry.findings = result.findings.map(({ rule, excerpt, offset }) => ({
    rule,
    excerpt,
    offset,
  }));
}

const RETRIEVAL_KINDS = new Set(["web", "file.read", "tool.end"]);

export const UNTRUSTED_SUMMARY =
  "Retrieved content contains instruction-like text; treated as untrusted";

/**
 * scanEvent(event)
 *
 * For `tool.end`, `web` and `file.read` events whose `data` carries text
 * (`text`, `content`, `output`, `result`, `body`), returns a descriptor for
 * a `status` event with `provenance: "system"` - never an error, because the
 * content did nothing; it was only read. Returns null when there is nothing
 * to say. The original event is not modified.
 */
export function scanEvent(event) {
  if (!event || typeof event !== "object") return null;
  if (!RETRIEVAL_KINDS.has(event.kind)) return null;
  const data = event.data && typeof event.data === "object" ? event.data : {};
  let text = null;
  for (const key of ["text", "content", "output", "result", "body"]) {
    const value = data[key];
    if (typeof value === "string") {
      text = value;
      break;
    }
    if (Array.isArray(value)) {
      const parts = value
        .map((part) =>
          typeof part === "string"
            ? part
            : typeof part?.text === "string"
              ? part.text
              : "",
        )
        .filter(Boolean);
      if (parts.length) {
        text = parts.join("\n");
        break;
      }
    }
  }
  if (text === null) return null;
  const source =
    event.kind === "web" ||
    /web|fetch|http|browse/i.test(String(event.tool ?? ""))
      ? "web"
      : event.kind === "file.read"
        ? "file"
        : "tool";
  const result = scan(text, { source });
  if (!result.untrusted) return null;
  return {
    kind: "status",
    provenance: "system",
    summary: UNTRUSTED_SUMMARY,
    tool: event.tool ?? null,
    file: event.file ?? null,
    activity: null,
    model: null,
    usage: null,
    data: {
      untrusted: true,
      source,
      score: result.score,
      rules: [...new Set(result.findings.map((f) => f.rule))],
      findings: result.findings
        .slice(0, 10)
        .map(({ rule, excerpt, offset }) => ({ rule, excerpt, offset })),
      sourceEventId: event.id ?? event.providerEventId ?? null,
      note: "Content was recorded, not executed. Adopt it explicitly to offer it to a run.",
    },
  };
}
