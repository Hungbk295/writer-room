/**
 * Lenient parse of agent `out/result.json`.
 *
 * Real agents (especially long prose drafts) often write:
 *   - raw newlines / tabs inside JSON strings instead of `\n` / `\t`
 *   - raw `"` dialogue quotes inside string values without `\"`
 *
 * Strict `JSON.parse` then fails ("Unterminated string", "Expected '}'",
 * "Bad control character") and the stage collapses to opaque `AGENT_SCHEMA`
 * even when the payload is otherwise fine (e.g. Claude run 7d626c50).
 *
 * Also tolerates trailing NDJSON / chatter after a complete top-level object.
 */

export type ParseAgentJsonResult =
  | { ok: true; value: unknown; repaired: boolean }
  | { ok: false; error: string };

function isJsonTokenBoundary(c: string | undefined): boolean {
  if (c === undefined) return true;
  return (
    c === ','
    || c === '}'
    || c === ']'
    || c === ':'
    || c === '"'
    || /\s/.test(c)
  );
}

/**
 * After a candidate closing `"`, skip whitespace and decide whether this looks
 * like a real JSON string terminator (next structural token) vs prose.
 *
 * Handles the common trap: `"hi", then more` — comma alone is not enough;
 * after the comma we require a plausible next JSON token (`"key"`, `{`, `[`,
 * number, true/false/null), not continuing prose (`then`, Vietnamese text…).
 */
export function looksLikeJsonStringEnd(raw: string, quoteIndex: number): boolean {
  let i = quoteIndex + 1;
  while (i < raw.length && /\s/.test(raw[i]!)) i++;
  if (i >= raw.length) return true;

  const n = raw[i]!;
  if (n === '}' || n === ']' || n === ':') return true;

  if (n === ',') {
    let j = i + 1;
    while (j < raw.length && /\s/.test(raw[j]!)) j++;
    if (j >= raw.length) return true;
    const m = raw[j]!;
    if (m === '"' || m === '{' || m === '[' || m === '-') return true;
    if (m >= '0' && m <= '9') return true;
    // true / false / null — require full literal + boundary (not "then"/"nullify")
    if (m === 't') {
      return raw.slice(j, j + 4) === 'true' && isJsonTokenBoundary(raw[j + 4]);
    }
    if (m === 'f') {
      return raw.slice(j, j + 5) === 'false' && isJsonTokenBoundary(raw[j + 5]);
    }
    if (m === 'n') {
      return raw.slice(j, j + 4) === 'null' && isJsonTokenBoundary(raw[j + 4]);
    }
    return false;
  }

  return false;
}

/**
 * Single-pass repair inside JSON text:
 *  - raw control chars inside strings → `\n` / `\t` / …
 *  - unescaped prose `"` inside strings → `\"` (when look-ahead is not a terminator)
 *
 * Outside strings, text is left unchanged so structural whitespace stays valid.
 */
export function repairJsonStringContents(raw: string): string {
  let out = '';
  let inString = false;
  let escape = false;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;

    if (escape) {
      out += c;
      escape = false;
      continue;
    }

    if (inString && c === '\\') {
      out += c;
      escape = true;
      continue;
    }

    if (c === '"') {
      if (!inString) {
        inString = true;
        out += c;
        continue;
      }
      // Already inside a string: terminator vs content quote.
      if (looksLikeJsonStringEnd(raw, i)) {
        inString = false;
        out += c;
      } else {
        out += '\\"';
      }
      continue;
    }

    if (inString) {
      const code = c.charCodeAt(0);
      if (code < 0x20) {
        if (c === '\n') out += '\\n';
        else if (c === '\r') out += '\\r';
        else if (c === '\t') out += '\\t';
        else out += `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
    }

    out += c;
  }

  return out;
}

/**
 * Escape raw control characters (U+0000–U+001F) that appear *inside* JSON
 * strings without being part of a `\` escape. Outside strings, whitespace
 * stays as-is.
 *
 * Prefer {@link repairJsonStringContents} when unescaped `"` may also be present
 * — this function alone mis-tracks string bounds on that failure mode.
 */
export function escapeControlCharsInJsonStrings(raw: string): string {
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (escape) {
      out += c;
      escape = false;
      continue;
    }
    if (inString && c === '\\') {
      out += c;
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      out += c;
      continue;
    }
    if (inString) {
      const code = c.charCodeAt(0);
      if (code < 0x20) {
        if (c === '\n') out += '\\n';
        else if (c === '\r') out += '\\r';
        else if (c === '\t') out += '\\t';
        else out += `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
    }
    out += c;
  }
  return out;
}

/** Prefer the first balanced `{...}` object if the file has trailing junk. */
export function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (inString && c === '\\') {
      escape = true;
      continue;
    }
    if (c === '"') {
      // Same terminator heuristic so extraction works on unrepaired agent prose.
      if (!inString) {
        inString = true;
        continue;
      }
      if (looksLikeJsonStringEnd(raw, i)) {
        inString = false;
      }
      continue;
    }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Last-resort for classic writer shape `{ "title": "...", "script": "..." }`
 * when quotes/newlines inside `script` wreck structural parsers.
 * Takes script as everything from the opening quote after `"script"` until the
 * last `"` before the final closing `}` of the object.
 */
export function tryExtractTitleScriptObject(raw: string): { title: string; script: string } | null {
  const titleMatch = /"title"\s*:\s*"/i.exec(raw);
  const scriptMatch = /"script"\s*:\s*"/i.exec(raw);
  if (!titleMatch || !scriptMatch) return null;

  const titleStart = titleMatch.index + titleMatch[0].length;
  // Title ends at first unescaped " that looks like a terminator (usually before ,"script")
  let titleEnd = -1;
  for (let i = titleStart; i < raw.length; i++) {
    if (raw[i] === '\\') {
      i++;
      continue;
    }
    if (raw[i] === '"' && looksLikeJsonStringEnd(raw, i)) {
      titleEnd = i;
      break;
    }
  }
  if (titleEnd < 0) return null;

  const scriptStart = scriptMatch.index + scriptMatch[0].length;
  // Prefer the last quote before final object close.
  const closeBrace = raw.lastIndexOf('}');
  if (closeBrace < scriptStart) return null;
  let scriptEnd = -1;
  for (let i = closeBrace - 1; i >= scriptStart; i--) {
    if (raw[i] !== '"') continue;
    // Walk back if escaped
    let bs = 0;
    for (let k = i - 1; k >= scriptStart && raw[k] === '\\'; k--) bs++;
    if (bs % 2 === 1) continue;
    scriptEnd = i;
    break;
  }
  if (scriptEnd < 0) return null;

  const unescapeJsonStringBody = (body: string): string =>
    body
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');

  const title = unescapeJsonStringBody(raw.slice(titleStart, titleEnd));
  // Script body may contain raw newlines and raw quotes — take literally, only
  // unescape sequences that were already escaped.
  let script = raw.slice(scriptStart, scriptEnd);
  // If agent used real newlines, keep them; if they used \n sequences, unescape.
  if (!script.includes('\n') && script.includes('\\n')) {
    script = unescapeJsonStringBody(script);
  } else {
    // Still unescape \" and \\ that appear literally as two-char sequences.
    script = script.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }

  if (!title.trim() || !script.trim()) return null;
  return { title, script };
}

export function parseAgentResultJson(raw: string): ParseAgentJsonResult {
  const trimmed = raw.replace(/^\uFEFF/, '').trim();
  if (!trimmed) {
    return { ok: false, error: 'out/result.json is empty' };
  }

  try {
    return { ok: true, value: JSON.parse(trimmed), repaired: false };
  } catch {
    // fall through
  }

  // 1) Full string-content repair (control chars + unescaped prose quotes).
  const repaired = repairJsonStringContents(trimmed);
  try {
    return { ok: true, value: JSON.parse(repaired), repaired: true };
  } catch {
    // fall through
  }

  // 2) Legacy control-char-only path (still useful when quotes are fine).
  const escaped = escapeControlCharsInJsonStrings(trimmed);
  try {
    return { ok: true, value: JSON.parse(escaped), repaired: true };
  } catch {
    // fall through
  }

  // 3) Extract first {...} (handles trailing NDJSON / chat after the object).
  const extracted =
    extractFirstJsonObject(repaired)
    ?? extractFirstJsonObject(escaped)
    ?? extractFirstJsonObject(trimmed);
  if (extracted) {
    try {
      return { ok: true, value: JSON.parse(extracted), repaired: true };
    } catch {
      try {
        return {
          ok: true,
          value: JSON.parse(repairJsonStringContents(extracted)),
          repaired: true,
        };
      } catch {
        // fall through to title/script salvage
      }
    }
  }

  // 4) Writer-shaped salvage: title + script fields with broken quotes/newlines.
  const pair = tryExtractTitleScriptObject(trimmed);
  if (pair) {
    return { ok: true, value: pair, repaired: true };
  }

  return {
    ok: false,
    error:
      'out/result.json is not valid JSON (often unescaped newlines/quotes inside string fields, '
      + 'or trailing non-JSON after the object). Overwrite with a single JSON object: '
      + '{ "title": "...", "script": "..." } using \\n for line breaks and \\" for quotes inside strings.',
  };
}
