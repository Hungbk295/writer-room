export const WRITER_MEMORY_ANCHOR_KINDS = [
  'name',
  'equation',
  'contrast',
  'image',
] as const;

export type WriterMemoryAnchorKind = typeof WRITER_MEMORY_ANCHOR_KINDS[number];

export interface WriterVideoPlanBeat {
  beat: string;
  newInformation: string;
  characterOrArgumentChange: string;
  visualAnchor: string;
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
  progression: WriterVideoPlanBeat[];
  endingPayoff: {
    resolvesOpening: string;
    audienceCanDo: string;
  };
  cutList: string[];
}

function requiredString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function validateWriterVideoPlan(
  raw: unknown,
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
    progression.push({
      beat: label,
      newInformation,
      characterOrArgumentChange,
      visualAnchor,
    });
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
      progression,
      endingPayoff: { resolvesOpening, audienceCanDo },
      cutList,
    },
  };
}
