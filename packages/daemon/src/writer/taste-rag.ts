/**
 * Taste RAG retrieval for Writer — Hiếu TV editorial decision memory (QMD `hieutv`).
 *
 * Correct query path (NOT plain `qmd search` keyword dumps):
 *   qmd query -c hieutv -n 8 -C 24 --no-rerank --format json \
 *     $'intent: …\nlex: …\nvec: …\nhyde: …'
 *
 * Rules:
 *  - Prefer decision_case / decisions/* paths (geometry), not topic sources/*
 *  - Never treat snippets as evidence — open full document before applying
 *  - Precedents are HOW to decide; Source Pack remains WHAT facts may be used
 *
 * Fallback: filesystem keyword scan under store/decisions if QMD fails.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { APP_ROOT } from '../paths.ts';

export interface TastePrecedent {
  /** Path relative to the taste store root (e.g. decisions/…/dc_….md). */
  path: string;
  title: string;
  score: number;
  decisionType?: string;
  /** Body from FULL document (not search snippet). */
  excerpt: string;
  source: 'qmd' | 'filesystem';
  qmdUri?: string;
}

export interface TasteRagResult {
  precedents: TastePrecedent[];
  warnings: string[];
  query: string;
  collection: string;
  mode: 'fast' | 'precise' | 'filesystem';
}

const DEFAULT_COLLECTION = 'hieutv';
const DEFAULT_LIMIT = 5;
/** Full decision sections kept for the agent — still bounded for envelope size. */
const EXCERPT_MAX = 1400;
const QMD_FAST_TIMEOUT_MS = 20_000;
const QMD_PRECISE_TIMEOUT_MS = 90_000;

export function tasteRagStoreRoot(): string {
  return (
    process.env.WRITER_TASTE_RAG_ROOT?.trim() ||
    join(APP_ROOT, 'hieutv-taste-rag', 'store')
  );
}

export function tasteRagCollection(): string {
  return process.env.WRITER_TASTE_RAG_COLLECTION?.trim() || DEFAULT_COLLECTION;
}

function qmdBin(): string {
  return process.env.QMD_BIN?.trim() || 'qmd';
}

/** `fast` = --no-rerank (explore); `precise` = rerank on (writing). */
export function tasteRagMode(): 'fast' | 'precise' {
  const m = (process.env.WRITER_TASTE_RAG_MODE ?? 'fast').toLowerCase();
  return m === 'precise' ? 'precise' : 'fast';
}

/** Pull editorial sections from a FULL decision Markdown file. */
export function excerptFromDecisionMarkdown(md: string, maxChars = EXCERPT_MAX): {
  title: string;
  decisionType?: string;
  memoryType?: string;
  excerpt: string;
} {
  const titleMatch = md.match(/^#\s+(.+)$/m);
  const title = titleMatch?.[1]?.trim() || 'Taste precedent';
  const typeMatch = md.match(/^decision_type:\s*["']?([^\n"']+)/m);
  const decisionType = typeMatch?.[1]?.trim();
  const memMatch = md.match(/^memory_type:\s*["']?([^\n"']+)/m);
  const memoryType = memMatch?.[1]?.trim();

  const sections: string[] = [];
  for (const heading of [
    'Editorial situation',
    'Editorial problem',
    'Observed choice',
    'Decision boundary',
    'Transfer conditions',
    'Do not transfer blindly',
  ]) {
    const re = new RegExp(
      `## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |\\n---|$)`,
      'i',
    );
    const m = md.match(re);
    if (m?.[1]?.trim()) {
      sections.push(`### ${heading}\n${m[1].trim()}`);
    }
  }
  let body = sections.join('\n\n') || md.replace(/^---[\s\S]*?---\s*/, '').trim();
  if (body.length > maxChars) {
    body = `${body.slice(0, maxChars)}\n…`;
  }
  return { title, decisionType, memoryType, excerpt: body };
}

/** Map qmd://hieutv/decisions/... → absolute filesystem path under store/. */
export function qmdUriToStorePath(uri: string, storeRoot: string, collection: string): string | null {
  // Strip optional :line #docid suffixes
  const clean = uri.replace(/:\d+\s+#\w+$/, '').replace(/:\d+$/, '').trim();
  const prefix = `qmd://${collection}/`;
  if (!clean.startsWith(prefix)) return null;
  const rel = clean.slice(prefix.length).replace(/^store\//, '');
  return join(storeRoot, rel);
}

/**
 * Build a structured Situation Query for `qmd query`.
 * Grammar: every line MUST be intent: | lex: | vec: | hyde: — no blank lines, no markdown.
 * Lines are single-line (no embedded newlines inside values).
 */
export interface SituationQueryFields {
  intent: string;
  lex: string;
  vec: string;
  hyde: string;
}

/** Flatten LLM (or code) fields into a single structured QMD query document. */
export function formatStructuredQuery(fields: SituationQueryFields): string {
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
  return [
    `intent: ${clean(fields.intent)}`,
    `lex: ${clean(fields.lex)}`,
    `vec: ${clean(fields.vec)}`,
    `hyde: ${clean(fields.hyde)}`,
  ].join('\n');
}

/**
 * Fallback when the plan agent omitted a valid query block: geometry + situation,
 * still NOT a raw title keyword dump as the sole signal.
 */
export function buildStructuredSituationQuery(input: {
  title?: string;
  brief: string;
  situation?: string;
  geometryTags?: string[];
  decisionType?: string;
}): string {
  const angle = (
    input.situation?.trim()
    || input.title?.trim()
    || input.brief.trim()
    || 'quyết định biên tập tài chính cá nhân'
  )
    .replace(/\s+/g, ' ')
    .slice(0, 220);
  const briefFlat = input.brief.trim().replace(/\s+/g, ' ').slice(0, 280);
  const tags = (input.geometryTags ?? [])
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 8);
  const geometryLex = [
    'decision_case',
    input.decisionType?.toLowerCase() || 'hook_strategy',
    ...tags,
    'contrast',
    'transfer',
  ].join(' ');

  return formatStructuredQuery({
    intent:
      'Tìm precedent về lựa chọn biên tập tương tự, không tìm nội dung/chủ đề tương tự. '
      + 'Ưu tiên memory_type decision_case trong decisions/.',
    lex: geometryLex,
    vec:
      `Tình huống biên tập: ${angle}. `
      + (briefFlat ? `Brief bài: ${briefFlat}. ` : '')
      + 'Cần decision geometry (hook/angle/depth/close/transfer), không tóm tắt chủ đề video nguồn.',
    hyde:
      `Một decision_case editorial cho situation "${angle}", observed choice rõ, `
      + 'có transfer conditions và do-not-transfer, không clone catchphrase kênh.',
  });
}

/**
 * Preferred path: Situation Query fields produced by the plan LLM for ONE decision.
 * Incomplete fields fall back to geometry+situation builder.
 */
export function structuredQueryFromDecision(input: {
  decisionType: string;
  situation: string;
  geometryTags?: string[];
  rhetoricalNeed?: string;
  audience?: string;
  epistemicRisk?: string;
  query?: Partial<SituationQueryFields>;
  title?: string;
  brief?: string;
}): string {
  const q = input.query;
  if (
    q
    && typeof q.intent === 'string' && q.intent.trim()
    && typeof q.lex === 'string' && q.lex.trim()
    && typeof q.vec === 'string' && q.vec.trim()
    && typeof q.hyde === 'string' && q.hyde.trim()
  ) {
    // Ensure decision_case + decisionType appear in lex for BM25
    let lex = q.lex.trim();
    if (!/decision_case/i.test(lex)) lex = `decision_case ${lex}`;
    if (input.decisionType && !lex.toLowerCase().includes(input.decisionType.toLowerCase())) {
      lex = `${input.decisionType.toLowerCase()} ${lex}`;
    }
    return formatStructuredQuery({
      intent: q.intent,
      lex,
      vec: q.vec,
      hyde: q.hyde,
    });
  }
  return buildStructuredSituationQuery({
    title: input.title,
    brief: input.brief || input.situation,
    situation: [
      input.situation,
      input.audience ? `Audience: ${input.audience}` : '',
      input.rhetoricalNeed ? `Rhetorical need: ${input.rhetoricalNeed}` : '',
      input.epistemicRisk ? `Risk: ${input.epistemicRisk}` : '',
    ]
      .filter(Boolean)
      .join(' '),
    geometryTags: input.geometryTags,
    decisionType: input.decisionType,
  });
}

export interface QmdQueryHit {
  file: string;
  score: number;
  title?: string;
  snippet?: string;
  docid?: string;
}

/** Extract JSON array from qmd stdout (may include progress lines on stderr-ish stdout). */
export function parseQmdQueryJson(stdout: string): QmdQueryHit[] {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(stdout.slice(start, end + 1)) as Array<Record<string, unknown>>;
    if (!Array.isArray(arr)) return [];
    return arr
      .map((row) => ({
        file: String(row['file'] ?? ''),
        score: typeof row['score'] === 'number' ? row['score'] : Number(row['score'] ?? 0),
        title: typeof row['title'] === 'string' ? row['title'] : undefined,
        snippet: typeof row['snippet'] === 'string' ? row['snippet'] : undefined,
        docid: typeof row['docid'] === 'string' ? row['docid'] : undefined,
      }))
      .filter((h) => h.file.startsWith('qmd://'));
  } catch {
    return [];
  }
}

/** Prefer decision_case paths; demote sources/* topic dumps. */
export function rankDecisionHits(hits: QmdQueryHit[]): QmdQueryHit[] {
  const scored = hits.map((h) => {
    let boost = 0;
    if (h.file.includes('/decisions/')) boost += 2;
    if (h.snippet?.includes('decision_case') || h.snippet?.includes('memory_type: decision_case')) {
      boost += 1.5;
    }
    if (h.file.includes('/sources/')) boost -= 2;
    if (h.file.includes('/patterns/') || h.file.includes('/principles/')) boost -= 0.5;
    return { hit: h, key: h.score + boost };
  });
  scored.sort((a, b) => b.key - a.key || b.hit.score - a.hit.score);
  // de-dupe by file
  const seen = new Set<string>();
  const out: QmdQueryHit[] = [];
  for (const s of scored) {
    if (seen.has(s.hit.file)) continue;
    seen.add(s.hit.file);
    out.push(s.hit);
  }
  return out;
}

/** @deprecated Prefer parseQmdQueryJson — kept for older search-text fixtures in tests. */
export function parseQmdSearchText(stdout: string): Array<{ path: string; score: number; title?: string }> {
  // If JSON present, map to old shape
  const jsonHits = parseQmdQueryJson(stdout);
  if (jsonHits.length > 0) {
    return jsonHits.map((h) => ({ path: h.file, score: h.score, title: h.title }));
  }
  const hits: Array<{ path: string; score: number; title?: string }> = [];
  const blocks = stdout.split(/\n(?=qmd:\/\/)/);
  for (const block of blocks) {
    const pathMatch = block.match(/^qmd:\/\/[^\s]+/m);
    if (!pathMatch) continue;
    let path = pathMatch[0]!;
    path = path.replace(/:\d+\s+#\w+$/, '').replace(/:\d+$/, '');
    const scoreMatch = block.match(/Score:\s*(\d+)%/i);
    const score = scoreMatch ? Number(scoreMatch[1]) / 100 : 0;
    const titleMatch = block.match(/^Title:\s*(.+)$/m);
    hits.push({ path, score, title: titleMatch?.[1]?.trim() });
  }
  const best = new Map<string, { path: string; score: number; title?: string }>();
  for (const h of hits) {
    const prev = best.get(h.path);
    if (!prev || h.score > prev.score) best.set(h.path, h);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

async function runQmd(
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; error?: string }> {
  if (process.env.WRITER_TASTE_RAG_SKIP_QMD === '1') {
    return { stdout: '', stderr: '', error: 'qmd skipped (WRITER_TASTE_RAG_SKIP_QMD=1)' };
  }
  const bin = qmdBin();
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, ...args], {
      cwd: APP_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    });
  } catch (err) {
    return {
      stdout: '',
      stderr: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const kill = () => {
    try {
      proc.kill();
    } catch {
      // ignore
    }
  };

  const timeout = new Promise<{ stdout: string; stderr: string; error: string }>((resolve) => {
    setTimeout(() => {
      kill();
      resolve({ stdout: '', stderr: '', error: `qmd timed out after ${timeoutMs}ms` });
    }, timeoutMs);
  });

  const finished = (async () => {
    try {
      const outS = proc.stdout;
      const errS = proc.stderr;
      const [stdout, stderr, exitCode] = await Promise.all([
        outS && typeof outS !== 'number' ? new Response(outS).text() : Promise.resolve(''),
        errS && typeof errS !== 'number' ? new Response(errS).text() : Promise.resolve(''),
        proc.exited,
      ]);
      if (exitCode !== 0 && !stdout.includes('[')) {
        return {
          stdout: stdout || '',
          stderr: stderr || '',
          error: stderr.trim() || `qmd exit ${exitCode}`,
        };
      }
      return { stdout, stderr };
    } catch (err) {
      return {
        stdout: '',
        stderr: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  })();

  return Promise.race([finished, timeout]);
}

/**
 * `qmd query -c hieutv … --format json` with a structured Situation Query.
 * Fast: --no-rerank -C 24; Precise: rerank, -C 40.
 */
export async function runQmdStructuredQuery(
  structuredQuery: string,
  opts: {
    collection?: string;
    limit?: number;
    mode?: 'fast' | 'precise';
  } = {},
): Promise<{ hits: QmdQueryHit[]; error?: string; raw: string }> {
  const collection = opts.collection ?? tasteRagCollection();
  const limit = opts.limit ?? 8;
  const mode = opts.mode ?? tasteRagMode();
  const timeoutMs = mode === 'precise' ? QMD_PRECISE_TIMEOUT_MS : QMD_FAST_TIMEOUT_MS;

  const args = [
    'query',
    '-c',
    collection,
    '-n',
    String(limit),
    '-C',
    mode === 'precise' ? '40' : '24',
    '--format',
    'json',
  ];
  if (mode === 'fast') args.push('--no-rerank');
  args.push(structuredQuery);

  const res = await runQmd(args, timeoutMs);
  if (res.error && !res.stdout.includes('[')) {
    return { hits: [], error: res.error, raw: res.stdout };
  }
  const hits = rankDecisionHits(parseQmdQueryJson(res.stdout));
  return { hits, raw: res.stdout, error: hits.length === 0 ? 'qmd query returned no hits' : undefined };
}

/** Full document via `qmd get`, then disk fallback. */
export async function loadFullDecisionDoc(
  qmdUri: string,
  storeRoot: string,
  collection: string,
): Promise<{ md: string; via: 'qmd-get' | 'disk' } | null> {
  // 1) qmd get — authoritative when available
  const get = await runQmd(['get', qmdUri], 12_000);
  if (!get.error && get.stdout.trim().length > 80) {
    // qmd get may prefix line numbers "N: content" — strip if present
    let md = get.stdout;
    if (/^\s*\d+:\s/m.test(md.split('\n').slice(0, 5).join('\n'))) {
      md = md
        .split('\n')
        .map((line) => line.replace(/^\s*\d+:\s?/, ''))
        .join('\n');
    }
    return { md, via: 'qmd-get' };
  }

  // 2) Disk under store root
  const abs = qmdUriToStorePath(qmdUri, storeRoot, collection);
  if (!abs) return null;
  try {
    const md = await readFile(abs, 'utf8');
    return { md, via: 'disk' };
  } catch {
    return null;
  }
}

async function listDecisionFiles(dir: string, acc: string[] = []): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const name = String(ent.name);
      const full = join(dir, name);
      if (ent.isFile() && name.endsWith('.md')) acc.push(full);
      else if (ent.isDirectory()) await listDecisionFiles(full, acc);
    }
  } catch {
    return acc;
  }
  return acc;
}

async function filesystemRetrieve(
  query: string,
  storeRoot: string,
  limit: number,
): Promise<TastePrecedent[]> {
  const decisionsRoot = join(storeRoot, 'decisions');
  const files = await listDecisionFiles(decisionsRoot);
  const tokens = [
    ...query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 2),
    'hook',
    'opening',
    'contrast',
    'case',
    'transfer',
    'decision',
  ];
  const uniq = [...new Set(tokens)];
  if (uniq.length === 0 || files.length === 0) return [];

  const scored: Array<{ path: string; score: number }> = [];
  for (const file of files) {
    let md: string;
    try {
      md = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    if (!md.includes('decision_case') && !md.includes('decision_type:')) continue;
    const lower = md.toLowerCase();
    let score = 0;
    for (const t of uniq) {
      if (lower.includes(t)) score += 1;
    }
    const conf = Number(md.match(/^confidence:\s*([0-9.]+)/m)?.[1] ?? 0);
    if (score > 0) scored.push({ path: file, score: score + conf * 0.1 });
  }
  scored.sort((a, b) => b.score - a.score);
  const maxS = Math.max(...scored.map((s) => s.score), 1);
  const out: TastePrecedent[] = [];
  for (const row of scored.slice(0, limit)) {
    try {
      const md = await readFile(row.path, 'utf8');
      const parsed = excerptFromDecisionMarkdown(md);
      out.push({
        path: relative(storeRoot, row.path).replace(/\\/g, '/'),
        title: parsed.title,
        score: Math.min(1, row.score / maxS),
        decisionType: parsed.decisionType,
        excerpt: parsed.excerpt,
        source: 'filesystem',
      });
    } catch {
      // skip
    }
  }
  return out;
}

/**
 * Core retrieve: structured QMD query string → full-doc precedents.
 * `structured` must already be valid intent/lex/vec/hyde lines.
 */
export async function retrieveWithStructuredQuery(
  structured: string,
  opts: {
    limit?: number;
    collection?: string;
    storeRoot?: string;
    mode?: 'fast' | 'precise';
    /** Extra text for filesystem fallback keyword scan. */
    fallbackText?: string;
  } = {},
): Promise<TasteRagResult> {
  const collection = opts.collection ?? tasteRagCollection();
  const storeRoot = opts.storeRoot ?? tasteRagStoreRoot();
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const mode = opts.mode ?? tasteRagMode();
  const warnings: string[] = [];

  const candidateN = Math.max(limit + 3, 8);
  const openN = Math.min(Math.max(limit, 3), 6);

  const qmd = await runQmdStructuredQuery(structured, {
    collection,
    limit: candidateN,
    mode,
  });

  if (!qmd.error && qmd.hits.length > 0) {
    const decided = qmd.hits.filter(
      (h) => h.file.includes('/decisions/') || h.snippet?.includes('decision_case'),
    );
    const pool = decided.length > 0 ? decided : qmd.hits;
    if (decided.length === 0) {
      warnings.push('qmd hits lacked decisions/ paths — using ranked pool as-is');
    }

    const precedents: TastePrecedent[] = [];
    for (const hit of pool.slice(0, openN)) {
      const full = await loadFullDecisionDoc(hit.file, storeRoot, collection);
      if (!full) {
        warnings.push(`could not open full doc: ${hit.file}`);
        continue;
      }
      const parsed = excerptFromDecisionMarkdown(full.md);
      if (
        parsed.memoryType &&
        parsed.memoryType !== 'decision_case' &&
        !hit.file.includes('/decisions/')
      ) {
        continue;
      }
      const abs = qmdUriToStorePath(hit.file, storeRoot, collection);
      precedents.push({
        path: abs
          ? relative(storeRoot, abs).replace(/\\/g, '/')
          : hit.file.replace(`qmd://${collection}/`, ''),
        title: hit.title || parsed.title,
        score: hit.score,
        decisionType: parsed.decisionType,
        excerpt: parsed.excerpt,
        source: 'qmd',
        qmdUri: hit.file,
      });
      if (precedents.length >= limit) break;
    }

    if (precedents.length > 0) {
      return { precedents, warnings, query: structured, collection, mode };
    }
    warnings.push('qmd hits found but no full decision docs loaded — filesystem fallback');
  } else if (qmd.error) {
    warnings.push(`qmd query: ${qmd.error}`);
  }

  const fsHits = await filesystemRetrieve(
    opts.fallbackText || structured,
    storeRoot,
    limit,
  );
  if (fsHits.length === 0) {
    warnings.push('Taste RAG: no precedents found');
  }
  return {
    precedents: fsHits,
    warnings,
    query: structured,
    collection,
    mode: 'filesystem',
  };
}

/**
 * Retrieve for ONE editorial decision (FM3-style): query from LLM decision fields.
 */
export async function retrieveForEditorialDecision(
  decision: {
    decisionType: string;
    situation: string;
    geometryTags?: string[];
    rhetoricalNeed?: string;
    audience?: string;
    epistemicRisk?: string;
    query?: Partial<SituationQueryFields>;
  },
  opts: {
    limit?: number;
    title?: string;
    brief?: string;
    mode?: 'fast' | 'precise';
    collection?: string;
    storeRoot?: string;
  } = {},
): Promise<TasteRagResult> {
  const structured = structuredQueryFromDecision({
    ...decision,
    title: opts.title,
    brief: opts.brief,
  });
  return retrieveWithStructuredQuery(structured, {
    limit: opts.limit ?? 2,
    mode: opts.mode,
    collection: opts.collection,
    storeRoot: opts.storeRoot,
    fallbackText: [decision.situation, decision.decisionType, ...(decision.geometryTags ?? [])].join(
      ' ',
    ),
  });
}

/**
 * @deprecated Prefer plan→retrieveForEditorialDecision. Kept for tests / one-shot tools.
 * Title/brief template path — does NOT reflect "LLM builds key at decision time".
 */
export async function retrieveTastePrecedents(
  brief: string,
  opts: {
    limit?: number;
    collection?: string;
    storeRoot?: string;
    title?: string;
    mode?: 'fast' | 'precise';
  } = {},
): Promise<TasteRagResult> {
  const structured = buildStructuredSituationQuery({
    title: opts.title,
    brief: brief.trim() || 'editorial decision hook transfer',
  });
  return retrieveWithStructuredQuery(structured, {
    limit: opts.limit,
    collection: opts.collection,
    storeRoot: opts.storeRoot,
    mode: opts.mode,
    fallbackText: [opts.title, brief].filter(Boolean).join(' '),
  });
}
