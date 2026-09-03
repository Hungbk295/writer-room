import { describe, expect, test } from 'bun:test';
import {
  buildResearchPrompt,
  coverageMapFromResearchMap,
  deriveAuthorizedClaimPermissions,
  deriveFactsLedger,
  RESEARCH_MAP_SCHEMA_VERSION,
  RESEARCH_PROMPT_VERSION,
  validateResearchMap,
  type ResearchMapAgentOutput,
} from '../../src/writer/research-map.ts';

const PACK = [
  '# Source Pack — UNTRUSTED REFERENCE MATERIAL',
  '',
  '## Video một',
  '',
  '- videoId: `v1`',
  '',
  '### Transcript',
  '',
  'Quỹ dự phòng tạo ra khoảng trống để một người có thể đổi việc.',
  '',
  '## Video hai',
  '',
  '- videoId: `v2`',
  '',
  '### Transcript',
  '',
  'Khoản vay dài hạn có thể làm giảm khả năng đổi hướng nghề nghiệp.',
  '',
  '## Video ba',
  '',
  '- videoId: `v3`',
  '',
  '### Transcript',
  '',
  'Một kế hoạch tốt vẫn cần chừa chỗ cho tình huống bất ngờ.',
].join('\n');

const VIDEO_IDS = ['v1', 'v2', 'v3'];
const ORIGIN_GROUPS = { v1: 'origin-a', v2: 'origin-b', v3: 'origin-a' } as const;
const CONTEXT = {
  packMarkdown: PACK,
  videoIds: VIDEO_IDS,
  originGroupByVideoId: ORIGIN_GROUPS,
} as const;

function validMap(): ResearchMapAgentOutput {
  return {
    schemaVersion: RESEARCH_MAP_SCHEMA_VERSION,
    sourceAudit: [
      {
        videoId: 'v1',
        mainClaim: 'Quỹ dự phòng bảo vệ khả năng đổi việc.',
        angle: 'quyền lựa chọn',
        limitations: ['không định lượng mức quỹ'],
      },
      {
        videoId: 'v2',
        mainClaim: 'Nợ dài hạn làm hẹp lựa chọn nghề nghiệp.',
        angle: 'chi phí cơ hội',
        limitations: [],
      },
      {
        videoId: 'v3',
        mainClaim: 'Kế hoạch cần khoảng đệm.',
        angle: 'bất định',
        limitations: [],
      },
    ],
    claims: [
      {
        id: 'claim-choice',
        text: 'Khoảng đệm tài chính bảo vệ quyền đổi hướng.',
        status: 'MULTI_SOURCE_ATTESTED',
        evidenceIds: ['e-choice-1', 'e-choice-2'],
        caveats: ['pack không đo mức tác động'],
      },
      {
        id: 'claim-buffer',
        text: 'Kế hoạch tốt cần chừa chỗ cho bất ngờ.',
        status: 'ATTESTED',
        evidenceIds: ['e-buffer-1'],
        caveats: [],
      },
    ],
    evidence: [
      {
        id: 'e-choice-1',
        claimId: 'claim-choice',
        videoId: 'v1',
        quote: 'Quỹ dự phòng tạo ra khoảng trống để một người có thể đổi việc.',
        relation: 'SUPPORTS',
      },
      {
        id: 'e-choice-2',
        claimId: 'claim-choice',
        videoId: 'v2',
        quote: 'Khoản vay dài hạn có thể làm giảm khả năng đổi hướng nghề nghiệp.',
        relation: 'QUALIFIES',
      },
      {
        id: 'e-buffer-1',
        claimId: 'claim-buffer',
        videoId: 'v3',
        quote: 'Một kế hoạch tốt vẫn cần chừa chỗ cho tình huống bất ngờ.',
        relation: 'SUPPORTS',
      },
    ],
    conflicts: [],
    openQuestions: ['Mức quỹ nào phù hợp với từng người?'],
    overusedAngles: ['liệt kê tỷ lệ ngân sách'],
  };
}

function copyMap(): ResearchMapAgentOutput {
  return structuredClone(validMap());
}

const LOSS_PACK = [
  '# Source Pack — UNTRUSTED REFERENCE MATERIAL',
  '',
  '## Video loss',
  '',
  '- videoId: `v-loss`',
  '',
  '### Transcript',
  '',
  'năm ngoái tôi lỗ gần 800 triệu',
].join('\n');

function lossMap(claimText: string): ResearchMapAgentOutput {
  return {
    schemaVersion: RESEARCH_MAP_SCHEMA_VERSION,
    sourceAudit: [{
      videoId: 'v-loss',
      mainClaim: 'Nguồn mô tả một khoản lỗ.',
      angle: 'rủi ro',
      limitations: [],
    }],
    claims: [{
      id: 'claim-loss',
      text: claimText,
      status: 'ATTESTED',
      evidenceIds: ['e-loss'],
      caveats: [],
    }],
    evidence: [{
      id: 'e-loss',
      claimId: 'claim-loss',
      videoId: 'v-loss',
      quote: 'năm ngoái tôi lỗ gần 800 triệu',
      relation: 'SUPPORTS',
    }],
    conflicts: [],
    openQuestions: [],
    overusedAngles: [],
  };
}

const LOSS_CONTEXT = {
  packMarkdown: LOSS_PACK,
  videoIds: ['v-loss'],
  originGroupByVideoId: { 'v-loss': 'origin-loss' },
} as const;

function promptJsonExample(prompt: string): unknown {
  const match = prompt.match(/```json\n([\s\S]+?)\n```/u);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!);
}

describe('RESEARCH prompt contract', () => {
  test('teaches exact Transcript grounding, code-owned provenance, and the strict allowlist', () => {
    const prompt = buildResearchPrompt();
    expect(RESEARCH_PROMPT_VERSION).toBe('writer-v2-research-v1');
    for (const key of [
      'schemaVersion',
      'sourceAudit',
      'claims',
      'evidence',
      'conflicts',
      'openQuestions',
      'overusedAngles',
      'videoId',
      'mainClaim',
      'angle',
      'limitations',
      'id',
      'text',
      'status',
      'evidenceIds',
      'caveats',
      'claimId',
      'quote',
      'relation',
      'claimIds',
      'explanation',
    ]) {
      expect(prompt).toContain(`\`${key}\``);
    }
    expect(prompt).toContain('substring CHÍNH XÁC');
    expect(prompt).toContain('ĐÚNG videoId');
    expect(prompt).toContain('Không lấy title, heading, `videoId`, URL hoặc metadata');
    expect(prompt).toContain('KHÔNG khai `originGroup`');
    expect(prompt).toContain('KHÔNG khai `independentOriginGroups`');
    expect(prompt).toContain('Coordinator đã biết provenance và sẽ tự điền cả hai');
    expect(prompt).toContain('Không gợi ý outline, hook, thesis, beat, beat order');
    expect(prompt).toContain('PACK CHỨNG THỰC GÌ');
    expect(prompt).toContain('“Có người mất gần một tỷ trong một năm.” vì số đã trôi');
    expect(prompt).toContain('Có cả positive evidence và CONTRADICTS');
    expect(prompt).toContain('không quá 61440 bytes');

    const example = promptJsonExample(prompt) as ResearchMapAgentOutput;
    expect(example.sourceAudit.every((source) => !('originGroup' in source))).toBe(true);
    expect(example.claims.every((claim) => !('independentOriginGroups' in claim))).toBe(true);
    const examplePack = [
      '## Video một',
      '',
      '- videoId: `video-1`',
      '',
      '### Transcript',
      '',
      'Khoảng đệm giúp một người còn lựa chọn đổi hướng.',
      'Một cam kết rõ ràng đôi khi giúp quyết định dứt khoát hơn.',
      '',
      '## Video hai',
      '',
      '- videoId: `video-2`',
      '',
      '### Transcript',
      '',
      'Cam kết cố định có thể làm thời gian lựa chọn ngắn lại.',
    ].join('\n');
    expect(validateResearchMap(example, {
      packMarkdown: examplePack,
      videoIds: ['video-1', 'video-2'],
      originGroupByVideoId: { 'video-1': 'group-a', 'video-2': 'group-b' },
    }).ok).toBe(true);
  });
});

describe('validateResearchMap', () => {
  test('accepts a strict non-narrative map grounded to the correct video sections', () => {
    const result = validateResearchMap(validMap(), CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(coverageMapFromResearchMap(result.researchMap)).toEqual([
      { videoId: 'v1', mainClaim: 'Quỹ dự phòng bảo vệ khả năng đổi việc.', angle: 'quyền lựa chọn' },
      { videoId: 'v2', mainClaim: 'Nợ dài hạn làm hẹp lựa chọn nghề nghiệp.', angle: 'chi phí cơ hội' },
      { videoId: 'v3', mainClaim: 'Kế hoạch cần khoảng đệm.', angle: 'bất định' },
    ]);
    expect(result.researchMap.sourceAudit.map((source) => source.originGroup)).toEqual([
      'origin-a',
      'origin-b',
      'origin-a',
    ]);
    expect(result.researchMap.claims.map((claim) => claim.independentOriginGroups)).toEqual([
      ['origin-a', 'origin-b'],
      ['origin-a'],
    ]);
  });

  test('rejects story topology even before the generic unknown-key check', () => {
    const raw = { ...validMap(), outline: { intro: 'mở thế này' } };
    const result = validateResearchMap(raw, CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('RESEARCH_FORBIDDEN_TOPOLOGY');
    expect(result.path).toBe('$.outline');
  });

  test('rejects a real quote attributed to the wrong video', () => {
    const raw = copyMap();
    raw.evidence[0]!.quote = raw.evidence[1]!.quote;
    const result = validateResearchMap(raw, CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('RESEARCH_SOURCE_GROUNDING');
    expect(result.reason).toContain('v1');
  });

  test('does not accept section metadata as transcript evidence', () => {
    const raw = copyMap();
    raw.evidence[0]!.quote = '- videoId: `v1`';
    const result = validateResearchMap(raw, CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('RESEARCH_SOURCE_GROUNDING');
  });

  test('does not count two videos in one origin group as independent corroboration', () => {
    const raw = copyMap();
    const result = validateResearchMap(raw, {
      ...CONTEXT,
      originGroupByVideoId: { v1: 'origin-a', v2: 'origin-a', v3: 'origin-a' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('RESEARCH_ORIGIN');
    expect(result.reason).toContain('MULTI_SOURCE_ATTESTED');
  });

  test('hydrates the conservative unknown origin when no trusted provenance exists', () => {
    const raw = copyMap();
    raw.claims[0]!.status = 'ATTESTED';
    const result = validateResearchMap(raw, { packMarkdown: PACK, videoIds: VIDEO_IDS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.researchMap.sourceAudit.every((source) => source.originGroup === 'unknown')).toBe(true);
    expect(result.researchMap.claims.every(
      (claim) => claim.independentOriginGroups.length === 1
        && claim.independentOriginGroups[0] === 'unknown',
    )).toBe(true);
  });

  test('rejects either coordinator-owned provenance field in raw model output', () => {
    const declaredSource = copyMap() as ResearchMapAgentOutput & {
      sourceAudit: Array<ResearchMapAgentOutput['sourceAudit'][number] & { originGroup?: string }>;
    };
    declaredSource.sourceAudit[0]!.originGroup = 'origin-a';
    const sourceResult = validateResearchMap(declaredSource, CONTEXT);
    expect(sourceResult.ok).toBe(false);
    if (!sourceResult.ok) {
      expect(sourceResult.errorCode).toBe('RESEARCH_SCHEMA');
      expect(sourceResult.path).toBe('$.sourceAudit[0].originGroup');
    }

    const declaredClaim = copyMap() as ResearchMapAgentOutput & {
      claims: Array<ResearchMapAgentOutput['claims'][number] & { independentOriginGroups?: string[] }>;
    };
    declaredClaim.claims[0]!.independentOriginGroups = ['origin-a', 'origin-b'];
    const claimResult = validateResearchMap(declaredClaim, CONTEXT);
    expect(claimResult.ok).toBe(false);
    if (!claimResult.ok) {
      expect(claimResult.errorCode).toBe('RESEARCH_SCHEMA');
      expect(claimResult.path).toBe('$.claims[0].independentOriginGroups');
    }
  });

  test('rejects evidence/claim references that disagree in either direction', () => {
    const raw = copyMap();
    raw.claims[0]!.evidenceIds = ['e-choice-1'];
    const result = validateResearchMap(raw, CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('RESEARCH_REFERENCE');
    expect(result.reason).toContain('e-choice-2');
  });

  test('requires both supporting and contradicting evidence for DISPUTED', () => {
    const raw = copyMap();
    raw.claims[0]!.status = 'DISPUTED';
    const result = validateResearchMap(raw, CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('RESEARCH_STATUS');
  });

  test('never upgrades contradictory evidence into attested multi-source support', () => {
    const raw = copyMap();
    raw.evidence[1]!.relation = 'CONTRADICTS';

    const result = validateResearchMap(raw, CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('RESEARCH_STATUS');
    expect(result.reason).toContain('must be DISPUTED or REJECTED');
  });

  test('rejects claim-text specifics that do not exist in the claim own exact quotes', () => {
    const amountDrift = validateResearchMap(
      lossMap('Có người mất gần một tỷ chỉ trong một năm.'),
      LOSS_CONTEXT,
    );
    expect(amountDrift.ok).toBe(false);
    if (!amountDrift.ok) {
      expect(amountDrift.errorCode).toBe('RESEARCH_CLAIM_SPECIFIC');
      expect(amountDrift.reason).toContain('một tỷ');
    }

    const nameDrift = validateResearchMap(
      lossMap('Khoản lỗ gần 800 triệu được ghi nhận tại Hà Nội.'),
      LOSS_CONTEXT,
    );
    expect(nameDrift.ok).toBe(false);
    if (!nameDrift.ok) {
      expect(nameDrift.errorCode).toBe('RESEARCH_CLAIM_SPECIFIC');
      expect(nameDrift.reason).toContain('Hà Nội');
    }
  });

  test('allows claim paraphrase while preserving exact-evidence specifics', () => {
    const result = validateResearchMap(
      lossMap('Có người lỗ gần 800 triệu chỉ trong một năm.'),
      LOSS_CONTEXT,
    );
    expect(result.ok).toBe(true);
  });

  test('requires a DISPUTED claim to carry an explicit caveat or conflict payload', () => {
    const raw = copyMap();
    raw.claims[0]!.status = 'DISPUTED';
    raw.claims[0]!.caveats = [];
    raw.evidence[1]!.relation = 'CONTRADICTS';

    const missing = validateResearchMap(raw, CONTEXT);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.errorCode).toBe('RESEARCH_STATUS');
      expect(missing.reason).toContain('non-empty caveat or conflicts entry');
    }

    raw.claims[0]!.caveats = ['Hai nguồn mô tả tác động theo hướng trái ngược.'];
    expect(validateResearchMap(raw, CONTEXT).ok).toBe(true);

    raw.claims[0]!.caveats = [];
    raw.conflicts = [{
      claimIds: ['claim-choice', 'claim-buffer'],
      explanation: 'Hai cơ chế cần được giữ tách biệt khi diễn giải.',
    }];
    expect(validateResearchMap(raw, CONTEXT).ok).toBe(true);
  });

  test('fails oversize output without authorizing another raw-pack call', () => {
    const result = validateResearchMap(validMap(), {
      ...CONTEXT,
      maxBytes: 100,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('RESEARCH_ARTIFACT_OVERSIZE');
  });
});

describe('deriveFactsLedger', () => {
  test('mechanically derives at least three grounded legacy entries', () => {
    const validated = validateResearchMap(validMap(), CONTEXT);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const result = deriveFactsLedger(
      validated.researchMap,
      ['e-choice-1', 'e-choice-2', 'e-buffer-1'],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.factsLedger).toHaveLength(3);
    expect(result.factsLedger[0]).toEqual({
      fact: 'Quỹ dự phòng tạo ra khoảng trống để một người có thể đổi việc.',
      videoId: 'v1',
      quote: 'Quỹ dự phòng tạo ra khoảng trống để một người có thể đổi việc.',
    });
  });

  test('rejects a REJECTED claim even when its quote is real', () => {
    const raw = copyMap();
    raw.claims[1]!.status = 'REJECTED';
    const validated = validateResearchMap(raw, CONTEXT);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const result = deriveFactsLedger(validated.researchMap, ['e-buffer-1'], { minEntries: 1 });
    expect(result).toEqual({
      ok: false,
      errorCode: 'RESEARCH_LEDGER',
      reason: 'claim "claim-buffer" is REJECTED',
    });
  });

  test('does not label contradicting evidence as if it supported the claim', () => {
    const raw = copyMap();
    raw.evidence[2]!.relation = 'CONTRADICTS';
    raw.claims[1]!.status = 'REJECTED';
    const validated = validateResearchMap(raw, CONTEXT);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const nonRejected = structuredClone(validated.researchMap);
    nonRejected.claims[1]!.status = 'ATTESTED';
    const result = deriveFactsLedger(nonRejected, ['e-buffer-1'], { minEntries: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('CONTRADICTS');
  });

  test('collapses one exact quote reused under multiple claim IDs', () => {
    const raw = copyMap();
    const quote = raw.evidence[0]!.quote;
    raw.claims = [1, 2, 3].map((number) => ({
      id: `claim-duplicate-${number}`,
      text: `Agent-authored interpretation ${number}.`,
      status: 'ATTESTED',
      evidenceIds: [`e-duplicate-${number}`],
      caveats: [],
    }));
    raw.evidence = [1, 2, 3].map((number) => ({
      id: `e-duplicate-${number}`,
      claimId: `claim-duplicate-${number}`,
      videoId: 'v1',
      quote,
      relation: 'SUPPORTS',
    }));

    const validated = validateResearchMap(raw, CONTEXT);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const selectedIds = raw.evidence.map((item) => item.id);
    const defaultMinimum = deriveFactsLedger(validated.researchMap, selectedIds);
    expect(defaultMinimum).toEqual({
      ok: false,
      errorCode: 'RESEARCH_LEDGER',
      reason: 'factsLedger needs at least 3 unique grounded entries; got 1',
    });

    const oneEntry = deriveFactsLedger(validated.researchMap, selectedIds, { minEntries: 1 });
    expect(oneEntry.ok).toBe(true);
    if (!oneEntry.ok) return;
    expect(oneEntry.factsLedger).toEqual([{ fact: quote, videoId: 'v1', quote }]);
  });
});

describe('deriveAuthorizedClaimPermissions', () => {
  test('includes only selected claims and only their selected exact evidence', () => {
    const validated = validateResearchMap(validMap(), CONTEXT);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const result = deriveAuthorizedClaimPermissions(
      validated.researchMap,
      ['e-choice-1', 'e-buffer-1'],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.permissions).toEqual([
      {
        claimId: 'claim-choice',
        text: 'Khoảng đệm tài chính bảo vệ quyền đổi hướng.',
        status: 'MULTI_SOURCE_ATTESTED',
        caveats: ['pack không đo mức tác động'],
        evidenceIds: ['e-choice-1'],
        quotes: ['Quỹ dự phòng tạo ra khoảng trống để một người có thể đổi việc.'],
      },
      {
        claimId: 'claim-buffer',
        text: 'Kế hoạch tốt cần chừa chỗ cho bất ngờ.',
        status: 'ATTESTED',
        caveats: [],
        evidenceIds: ['e-buffer-1'],
        quotes: ['Một kế hoạch tốt vẫn cần chừa chỗ cho tình huống bất ngờ.'],
      },
    ]);
    expect(result.permissions[0]!.evidenceIds).not.toContain('e-choice-2');
  });

  test('fails closed for rejected or contradicting selected evidence', () => {
    const rejected = copyMap();
    rejected.claims[1]!.status = 'REJECTED';
    const rejectedValidated = validateResearchMap(rejected, CONTEXT);
    expect(rejectedValidated.ok).toBe(true);
    if (!rejectedValidated.ok) return;
    const rejectedResult = deriveAuthorizedClaimPermissions(
      rejectedValidated.researchMap,
      ['e-buffer-1'],
    );
    expect(rejectedResult.ok).toBe(false);
    if (!rejectedResult.ok) expect(rejectedResult.reason).toContain('REJECTED');

    const contradicted = copyMap();
    contradicted.evidence[2]!.relation = 'CONTRADICTS';
    contradicted.claims[1]!.status = 'REJECTED';
    const contradictedValidated = validateResearchMap(contradicted, CONTEXT);
    expect(contradictedValidated.ok).toBe(true);
    if (!contradictedValidated.ok) return;
    contradictedValidated.researchMap.claims[1]!.status = 'ATTESTED';
    const contradictedResult = deriveAuthorizedClaimPermissions(
      contradictedValidated.researchMap,
      ['e-buffer-1'],
    );
    expect(contradictedResult.ok).toBe(false);
    if (!contradictedResult.ok) expect(contradictedResult.reason).toContain('CONTRADICTS');
  });
});
