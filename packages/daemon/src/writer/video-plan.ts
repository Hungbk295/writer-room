export const WRITER_MEMORY_ANCHOR_KINDS = [
  'name',
  'equation',
  'contrast',
  'image',
] as const;

export type WriterMemoryAnchorKind = typeof WRITER_MEMORY_ANCHOR_KINDS[number];

/** Beat grammar (SDD 006): how a beat is played — its form. */
export const WRITER_BEAT_MODES = [
  'canh',
  'mo-so',
  'phan-bac',
  'cuc-tri',
  'zoom-chu',
  'doi-y',
] as const;

export type WriterBeatMode = typeof WRITER_BEAT_MODES[number];

/** Beat grammar (SDD 006): the lateral turn applied to the beat's familiar object. */
export const WRITER_BEAT_TURNS = [
  'doi-don-vi',
  'doi-chu-the',
  'doi-thang',
  'doi-ten',
  'doi-thoi-diem',
  'doi-cau-hoi',
] as const;

export type WriterBeatTurn = typeof WRITER_BEAT_TURNS[number];

/** Beat grammar (SDD 006): the one thread that runs through the whole piece. */
export const WRITER_FRAME_KINDS = ['nhan-vat', 'an-du', 'con-so'] as const;

export type WriterFrameKind = typeof WRITER_FRAME_KINDS[number];

/** A shorter familiarObject/whyNotEarlier is a writer who has not actually chosen a turn. */
const MIN_BEAT_DETAIL_LENGTH = 12;

/** Coverage-map source sequences are capped the same length STUDY may report. */
const MAX_SOURCE_SEQUENCE_LENGTH = 12;

/** A `coverageMap[].sequence` entry set: the six modes plus the escape hatch. */
export const WRITER_BEAT_SEQUENCE_TOKENS = [...WRITER_BEAT_MODES, 'khac'] as const;

export type WriterBeatSequenceToken = typeof WRITER_BEAT_SEQUENCE_TOKENS[number];

export interface WriterVideoPlanBeat {
  beat: string;
  newInformation: string;
  characterOrArgumentChange: string;
  visualAnchor: string;
  /** How this beat is played (SDD 006 §3 Mode table). */
  mode: WriterBeatMode;
  /** The lateral turn this beat applies to `familiarObject` (SDD 006 §3 Phép lật table). */
  turn: WriterBeatTurn;
  /** The familiar object the turn is applied to. */
  familiarObject: string;
  /** Why this beat could not stand earlier in the piece. */
  whyNotEarlier: string;
}

/**
 * A compact editorial contract for packaging an idea as a video. It decides what
 * the audience should remember and how information advances, without prescribing
 * prose, headings, or a fixed number of visible sections in the final script.
 */
export interface WriterVideoPlan {
  coreInsight: string;
  memoryAnchor: {
    kind: WriterMemoryAnchorKind;
    value: string;
  };
  /** The one thread that runs through the whole piece (SDD 006 §3 Khuôn table). */
  frame: {
    kind: WriterFrameKind;
    value: string;
  };
  progression: WriterVideoPlanBeat[];
  endingPayoff: {
    resolvesOpening: string;
    audienceCanDo: string;
    /** The straight answer to the hook's question that the ending must NOT be. */
    directAnswer: string;
    /** The hook's question, reframed — this is what the ending actually resolves to. */
    reframedQuestion: string;
  };
  cutList: string[];
}

function requiredString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Loose equality for "did this just restate the same sentence" checks. */
function normalizeMeaning(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** All overlapping length-3 windows of a sequence, as `>`-joined keys. */
function slidingWindows3(sequence: readonly string[]): Set<string> {
  const windows = new Set<string>();
  for (let i = 0; i + 3 <= sequence.length; i += 1) {
    windows.add(sequence.slice(i, i + 3).join('>'));
  }
  return windows;
}

export interface ValidateWriterVideoPlanOptions {
  /**
   * The mode sequence of each source video the pack covers (from
   * `StudyArtifact.coverageMap[].sequence`), already parsed by the caller.
   * When given, the outline's own mode sequence must not share a 3-beat
   * window with any of them (ignoring `khac`, which is not a real mode).
   */
  sourceSequences?: readonly (readonly string[])[];
}

export function validateWriterVideoPlan(
  raw: unknown,
  opts: ValidateWriterVideoPlanOptions = {},
): { ok: true; videoPlan: WriterVideoPlan } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'videoPlan must be an object' };
  }
  const plan = raw as Record<string, unknown>;
  const coreInsight = requiredString(plan['coreInsight']);
  if (!coreInsight) {
    return { ok: false, reason: 'videoPlan.coreInsight must be a non-empty string' };
  }

  const anchorRaw = plan['memoryAnchor'];
  if (!anchorRaw || typeof anchorRaw !== 'object') {
    return { ok: false, reason: 'videoPlan.memoryAnchor must be an object' };
  }
  const anchor = anchorRaw as Record<string, unknown>;
  const kind = requiredString(anchor['kind']);
  if (!kind || !WRITER_MEMORY_ANCHOR_KINDS.includes(kind as WriterMemoryAnchorKind)) {
    return {
      ok: false,
      reason: `videoPlan.memoryAnchor.kind must be one of: ${WRITER_MEMORY_ANCHOR_KINDS.join(', ')}`,
    };
  }
  const anchorValue = requiredString(anchor['value']);
  if (!anchorValue) {
    return { ok: false, reason: 'videoPlan.memoryAnchor.value must be a non-empty string' };
  }

  const frameRaw = plan['frame'];
  if (!frameRaw || typeof frameRaw !== 'object') {
    return { ok: false, reason: 'videoPlan.frame must be an object' };
  }
  const frameObj = frameRaw as Record<string, unknown>;
  const frameKind = requiredString(frameObj['kind']);
  if (!frameKind || !WRITER_FRAME_KINDS.includes(frameKind as WriterFrameKind)) {
    return {
      ok: false,
      reason: `videoPlan.frame.kind must be one of: ${WRITER_FRAME_KINDS.join(', ')}`,
    };
  }
  const frameValue = requiredString(frameObj['value']);
  if (!frameValue) {
    return { ok: false, reason: 'videoPlan.frame.value must be a non-empty string' };
  }

  const progressionRaw = plan['progression'];
  if (!Array.isArray(progressionRaw) || progressionRaw.length < 2 || progressionRaw.length > 8) {
    return { ok: false, reason: 'videoPlan.progression must contain 2–8 advancing beats' };
  }
  const progression: WriterVideoPlanBeat[] = [];
  for (const [index, rawBeat] of progressionRaw.entries()) {
    if (!rawBeat || typeof rawBeat !== 'object') {
      return { ok: false, reason: `videoPlan.progression[${index}] must be an object` };
    }
    const beat = rawBeat as Record<string, unknown>;
    const label = requiredString(beat['beat']);
    const newInformation = requiredString(beat['newInformation']);
    const characterOrArgumentChange = requiredString(beat['characterOrArgumentChange']);
    const visualAnchor = requiredString(beat['visualAnchor']);
    if (!label || !newInformation || !characterOrArgumentChange || !visualAnchor) {
      return {
        ok: false,
        reason:
          `videoPlan.progression[${index}] needs non-empty beat, newInformation, `
          + 'characterOrArgumentChange, and visualAnchor',
      };
    }
    const mode = requiredString(beat['mode']);
    const turn = requiredString(beat['turn']);
    const familiarObject = requiredString(beat['familiarObject']);
    const whyNotEarlier = requiredString(beat['whyNotEarlier']);
    if (
      !mode || !WRITER_BEAT_MODES.includes(mode as WriterBeatMode)
      || !turn || !WRITER_BEAT_TURNS.includes(turn as WriterBeatTurn)
      || !familiarObject || familiarObject.length < MIN_BEAT_DETAIL_LENGTH
      || !whyNotEarlier || whyNotEarlier.length < MIN_BEAT_DETAIL_LENGTH
    ) {
      return {
        ok: false,
        reason:
          `videoPlan.progression[${index}].mode/turn/familiarObject/whyNotEarlier invalid: `
          + `mode must be one of ${WRITER_BEAT_MODES.join(', ')}, turn must be one of `
          + `${WRITER_BEAT_TURNS.join(', ')}, familiarObject and whyNotEarlier must be `
          + `non-empty strings of at least ${MIN_BEAT_DETAIL_LENGTH} characters`,
      };
    }
    progression.push({
      beat: label,
      newInformation,
      characterOrArgumentChange,
      visualAnchor,
      mode: mode as WriterBeatMode,
      turn: turn as WriterBeatTurn,
      familiarObject,
      whyNotEarlier,
    });
  }

  for (let index = 1; index < progression.length; index += 1) {
    if (progression[index]!.mode === progression[index - 1]!.mode) {
      return {
        ok: false,
        reason:
          `videoPlan.progression[${index}]: adjacent beats share mode `
          + `("${progression[index]!.mode}")`,
      };
    }
    if (progression[index]!.turn === progression[index - 1]!.turn) {
      return {
        ok: false,
        reason:
          `videoPlan.progression[${index}]: adjacent beats share turn `
          + `("${progression[index]!.turn}")`,
      };
    }
  }

  const modeCounts = new Map<WriterBeatMode, number>();
  for (const beat of progression) {
    modeCounts.set(beat.mode, (modeCounts.get(beat.mode) ?? 0) + 1);
  }
  for (const [mode, count] of modeCounts) {
    const limit = mode === 'doi-y' ? 1 : 2;
    if (count > limit) {
      return {
        ok: false,
        reason: `videoPlan.progression: mode overused ("${mode}" used ${count} times, max ${limit})`,
      };
    }
  }
  if (progression.length > 0 && progression[progression.length - 1]!.mode === 'doi-y') {
    return {
      ok: false,
      reason: 'videoPlan.progression: mode overused ("doi-y" must not be the last beat)',
    };
  }

  if (opts.sourceSequences?.length) {
    const outlineWindows = slidingWindows3(progression.map((beat) => beat.mode));
    if (outlineWindows.size > 0) {
      for (const sourceSequence of opts.sourceSequences) {
        const realModes = sourceSequence.filter((token) => token !== 'khac');
        const sourceWindows = slidingWindows3(realModes);
        for (const window of sourceWindows) {
          if (outlineWindows.has(window)) {
            return {
              ok: false,
              reason:
                `videoPlan.progression: outline copies source sequence `
                + `(mode window "${window}" matches a coverageMap[].sequence)`,
            };
          }
        }
      }
    }
  }

  const endingRaw = plan['endingPayoff'];
  if (!endingRaw || typeof endingRaw !== 'object') {
    return { ok: false, reason: 'videoPlan.endingPayoff must be an object' };
  }
  const ending = endingRaw as Record<string, unknown>;
  const resolvesOpening = requiredString(ending['resolvesOpening']);
  const audienceCanDo = requiredString(ending['audienceCanDo']);
  if (!resolvesOpening || !audienceCanDo) {
    return {
      ok: false,
      reason: 'videoPlan.endingPayoff needs non-empty resolvesOpening and audienceCanDo',
    };
  }
  const directAnswer = requiredString(ending['directAnswer']);
  const reframedQuestion = requiredString(ending['reframedQuestion']);
  if (!directAnswer || !reframedQuestion) {
    return {
      ok: false,
      reason: 'videoPlan.endingPayoff needs non-empty directAnswer and reframedQuestion',
    };
  }
  if (normalizeMeaning(directAnswer) === normalizeMeaning(resolvesOpening)) {
    return {
      ok: false,
      reason:
        'videoPlan.endingPayoff: ending answers the hook directly '
        + '(directAnswer must not equal resolvesOpening)',
    };
  }

  const cutListRaw = plan['cutList'];
  if (!Array.isArray(cutListRaw) || cutListRaw.length > 8) {
    return { ok: false, reason: 'videoPlan.cutList must be an array with at most 8 items' };
  }
  const cutList: string[] = [];
  for (const [index, item] of cutListRaw.entries()) {
    const value = requiredString(item);
    if (!value) {
      return { ok: false, reason: `videoPlan.cutList[${index}] must be a non-empty string` };
    }
    cutList.push(value);
  }

  return {
    ok: true,
    videoPlan: {
      coreInsight,
      memoryAnchor: {
        kind: kind as WriterMemoryAnchorKind,
        value: anchorValue,
      },
      frame: {
        kind: frameKind as WriterFrameKind,
        value: frameValue,
      },
      progression,
      endingPayoff: { resolvesOpening, audienceCanDo, directAnswer, reframedQuestion },
      cutList,
    },
  };
}

/** Parses and validates one `coverageMap[index].sequence` entry (SDD 006 §4). */
export function parseCoverageSequence(
  raw: unknown,
  index: number,
): { ok: true; sequence: WriterBeatSequenceToken[] } | { ok: false; reason: string } {
  if (raw === undefined) return { ok: true, sequence: [] };
  if (!Array.isArray(raw) || raw.length > MAX_SOURCE_SEQUENCE_LENGTH) {
    return {
      ok: false,
      reason:
        `coverageMap[${index}].sequence must be an array of at most `
        + `${MAX_SOURCE_SEQUENCE_LENGTH} items`,
    };
  }
  const sequence: WriterBeatSequenceToken[] = [];
  for (const token of raw) {
    if (typeof token !== 'string' || !WRITER_BEAT_SEQUENCE_TOKENS.includes(token as WriterBeatSequenceToken)) {
      return {
        ok: false,
        reason:
          `coverageMap[${index}].sequence entries must be one of: `
          + `${WRITER_BEAT_SEQUENCE_TOKENS.join(', ')}`,
      };
    }
    sequence.push(token as WriterBeatSequenceToken);
  }
  return { ok: true, sequence };
}
