/**
 * Hook-đối-thủ contract: types, validators, and the two pre-write prompts.
 *
 * The library file is craft only. This module does not classify 9 topic groups
 * and does not enumerate every competitor type — the agent asks a few questions,
 * then returns 3–5 openings for a human to pick.
 */

export const COMPETITOR_HOOK_TYPES = [
  'crisis-by-hour',
  'forked-paths',
  'stat-open',
  'direct-question',
  'street-paradox',
  'personal-recall',
] as const;

export type CompetitorHookType = typeof COMPETITOR_HOOK_TYPES[number];

export const HOOK_TYPE_LABELS: Record<CompetitorHookType, string> = {
  'crisis-by-hour': 'Khủng hoảng cụ thể theo giờ',
  'forked-paths': 'Song lộ phân kỳ',
  'stat-open': 'Mở bằng số liệu/%',
  'direct-question': 'Câu hỏi trực diện',
  'street-paradox': 'Quan sát ngoại cảnh/nghịch lý',
  'personal-recall': 'Hồi ức cá nhân/case thật',
};

export interface HookCandidate {
  id: string;
  type: CompetitorHookType;
  typeLabel: string;
  text: string;
}

export interface SelectedHook {
  id: string;
  type: CompetitorHookType;
  typeLabel: string;
  text: string;
}

export interface HookClarify {
  questions: string[];
  answers?: string[];
}

function requiredString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isHookType(value: string): value is CompetitorHookType {
  return (COMPETITOR_HOOK_TYPES as readonly string[]).includes(value);
}

export function validateClarifyOutput(
  parsed: unknown,
): { ok: true; questions: string[] } | { ok: false; errorCode: string; reason: string } {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, errorCode: 'AGENT_SCHEMA', reason: 'clarify output is not an object' };
  }
  const raw = (parsed as { questions?: unknown }).questions;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) {
    return {
      ok: false,
      errorCode: 'AGENT_SCHEMA',
      reason: 'questions must be an array of 1–4 non-empty strings',
    };
  }
  const questions: string[] = [];
  for (const [i, item] of raw.entries()) {
    const text = requiredString(item);
    if (!text) {
      return {
        ok: false,
        errorCode: 'AGENT_SCHEMA',
        reason: `questions[${i}] must be a non-empty string`,
      };
    }
    questions.push(text);
  }
  return { ok: true, questions };
}

export function validateSuggestOutput(
  parsed: unknown,
): { ok: true; candidates: HookCandidate[] } | { ok: false; errorCode: string; reason: string } {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, errorCode: 'AGENT_SCHEMA', reason: 'suggest output is not an object' };
  }
  const raw = (parsed as { candidates?: unknown }).candidates;
  if (!Array.isArray(raw) || raw.length < 3 || raw.length > 5) {
    return {
      ok: false,
      errorCode: 'AGENT_SCHEMA',
      reason: 'candidates must be an array of 3–5 hooks',
    };
  }
  const candidates: HookCandidate[] = [];
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== 'object') {
      return { ok: false, errorCode: 'AGENT_SCHEMA', reason: `candidates[${i}] must be an object` };
    }
    const row = item as Record<string, unknown>;
    const typeRaw = requiredString(row['type']);
    if (!typeRaw || !isHookType(typeRaw)) {
      return {
        ok: false,
        errorCode: 'AGENT_SCHEMA',
        reason:
          `candidates[${i}].type must be one of: ${COMPETITOR_HOOK_TYPES.join(', ')}`,
      };
    }
    const text = requiredString(row['text']);
    if (!text) {
      return {
        ok: false,
        errorCode: 'AGENT_SCHEMA',
        reason: `candidates[${i}].text must be a non-empty string`,
      };
    }
    const id = requiredString(row['id']) ?? `h${i + 1}`;
    candidates.push({
      id,
      type: typeRaw,
      typeLabel: HOOK_TYPE_LABELS[typeRaw],
      text,
    });
  }
  const ids = new Set(candidates.map((c) => c.id));
  if (ids.size !== candidates.length) {
    return { ok: false, errorCode: 'AGENT_SCHEMA', reason: 'candidates must have unique id values' };
  }
  return { ok: true, candidates };
}

export function buildClarifyPrompt(opts: {
  title: string;
  brief: string;
  audience: string;
}): string {
  return [
    '# Writer v2 — HOOK CLARIFY (hỏi để làm rõ title, chưa viết bài)',
    '',
    'You are NOT writing the article and NOT proposing hooks yet. Ask the fewest',
    'questions that make the title specific enough to open a video.',
    '',
    `## Title\n${opts.title}`,
    '',
    `## Brief\n${opts.brief || '(chưa có)'}`,
    '',
    `## Audience\n${opts.audience || '(chưa có)'}`,
    '',
    '## Rules',
    '',
    '1. Ask 1–4 questions. Never more than 4.',
    '2. Do not re-ask anything already answered in Title, Brief, or Audience.',
    '3. Useful kinds of gap, if they are actually missing:',
    '   - ai đang xem, đang kẹt ở đâu',
    '   - góc mở bài (cảnh / hai lối / câu hỏi tự soi / số liệu có nguồn)',
    '   - món nợ người xem phải mang vào video (một cảnh, một câu hỏi, một hình)',
    '4. Do not invent numbers. Do not classify the title into a taxonomy.',
    '5. Vietnamese. Short questions a human can answer in one line each.',
    '',
    'Write JSON to `out/result.json`:',
    '',
    '```json',
    '{ "questions": ["...", "..."] }',
    '```',
  ].join('\n');
}

export function buildSuggestPrompt(opts: {
  title: string;
  brief: string;
  audience: string;
  answers: Array<{ question: string; answer: string }>;
}): string {
  const qa = opts.answers
    .map((row, i) => `${i + 1}. ${row.question}\n   → ${row.answer}`)
    .join('\n');
  return [
    '# Writer v2 — HOOK SUGGEST (gợi ý vài câu mở, chưa viết bài)',
    '',
    'Read `input/hook-library.md` for competitor opening frames (Anh Ba Tài Chính,',
    'Ông Chú Tài Chính). Borrow STRUCTURE only. Never copy a competitor sentence.',
    'Never take a number, case or person from the library — it is not a source of facts.',
    '',
    `## Title\n${opts.title}`,
    '',
    `## Brief\n${opts.brief || '(chưa có)'}`,
    '',
    `## Audience\n${opts.audience || '(chưa có)'}`,
    '',
    '## Clarifying answers',
    qa || '(none)',
    '',
    '## What to produce',
    '',
    'Write 3–5 NEW hooks for THIS title. Each hook is 1–3 Vietnamese sentences.',
    'Vary the types. Allowed `type` values:',
    '',
    ...COMPETITOR_HOOK_TYPES.map((t) => `- \`${t}\` — ${HOOK_TYPE_LABELS[t]}`),
    '',
    '## Hard rules',
    '',
    '1. Do not copy competitor wording. Frame only.',
    '2. Do not invent percentages, tiền, tuổi, năm, or "N lần". If a stat-open needs a',
    '   figure you do not have, skip that type or write a scene with no number.',
    '3. No "Hôm nay mình sẽ chia sẻ…", no greeting.',
    '4. A hypothetical person may not have a name AND an age AND a place.',
    '5. Do not write the rest of the script.',
    '',
    'Write JSON to `out/result.json`:',
    '',
    '```json',
    '{ "candidates": [ { "id": "h1", "type": "direct-question", "text": "..." } ] }',
    '```',
  ].join('\n');
}
