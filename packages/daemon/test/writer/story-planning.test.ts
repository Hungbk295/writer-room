import { describe, expect, test } from 'bun:test';
import { HOOK_TYPE_LABELS, type SelectedHook } from '../../src/writer/hook-doi-thu.ts';
import {
  CONFRONT_SCHEMA_VERSION,
  DIVERGE_SCHEMA_VERSION,
  effectiveHookFromConfront,
  selectedEvidenceIdsFromConfront,
  validateConfrontArtifact,
  validateDivergeArtifact,
  type ConfrontArtifact,
  type DivergeArtifact,
  type StoryHypothesis,
} from '../../src/writer/story-planning.ts';
import { RESEARCH_MAP_SCHEMA_VERSION, type ResearchMap } from '../../src/writer/research-map.ts';

function hypotheses(): [StoryHypothesis, StoryHypothesis, StoryHypothesis] {
  return [
    {
      id: 'h-contradiction',
      provocation: 'CONTRADICTION',
      thesisHypothesis: 'An toàn tài chính nằm ở quyền đổi hướng, không chỉ ở việc gom thêm tài sản.',
      beliefBefore: 'Khán giả xem số dư lớn là thước đo duy nhất của sự an toàn.',
      beliefAfter: 'Khán giả xem khả năng từ chối một lựa chọn xấu là phần cốt lõi của an toàn.',
      centralTension: 'Một tài sản có thể làm bảng cân đối đẹp hơn nhưng khóa đời sống bằng cam kết cứng.',
      hookDebt: 'Giải thích vì sao thứ trông an toàn lại có thể lấy mất lối thoát.',
      beatQuestions: [
        'Một quyết định tài chính lấy đi những lựa chọn nào?',
        'Khoảng đệm thay đổi quyền thương lượng ra sao?',
      ],
      evidenceNeeds: [
        'Cần kiểm tra mối liên hệ giữa chi phí cố định và khả năng đổi việc.',
        'Nguồn nào mô tả được giá trị thực tế của một khoảng đệm?',
      ],
      falsifiers: ['Nếu cam kết tài chính lớn không làm hẹp lựa chọn thì luận điểm này thất bại.'],
      proposedPayoff: 'Người xem có một phép thử dựa trên quyền lựa chọn trước khi mua thêm tài sản.',
    },
    {
      id: 'h-zoom',
      provocation: 'ZOOM_IN',
      thesisHypothesis: 'Cơ chế đáng nhìn là khoảng thời gian một người có thể chịu được trước khi buộc phải nhận lời.',
      beliefBefore: 'Khán giả cho rằng mức lương hiện tại quyết định toàn bộ sức mạnh thương lượng.',
      beliefAfter: 'Khán giả nhận ra thời gian dự phòng mới quyết định họ có thể chờ một thỏa thuận tốt hay không.',
      centralTension: 'Dòng tiền hàng tháng biến thời gian thành áp lực ngay cả khi thu nhập trên giấy rất cao.',
      hookDebt: 'Làm rõ khoảnh khắc đồng hồ tài chính bắt đầu ép một quyết định nghề nghiệp.',
      beatQuestions: [
        'Khoản chi nào làm đồng hồ lựa chọn chạy nhanh nhất?',
        'Một khoảng chờ thay đổi cách đàm phán thế nào?',
      ],
      evidenceNeeds: [
        'Kiểm tra cơ chế chi phí cố định tác động đến thời gian ra quyết định.',
        'Dữ liệu nào phân biệt thu nhập cao với quyền trì hoãn một lời đề nghị?',
      ],
      falsifiers: ['Nếu thời gian dự phòng không đổi hành vi thương lượng thì cơ chế này không đứng vững.'],
      proposedPayoff: 'Người xem biết đo sức mạnh thương lượng bằng thời gian thay vì chỉ bằng lương.',
    },
    {
      id: 'h-inversion',
      provocation: 'INVERSION',
      thesisHypothesis: 'Sự linh hoạt chỉ có ích khi nó phục vụ một cam kết; giữ mọi cửa mở mãi có thể thành né tránh.',
      beliefBefore: 'Khán giả tin càng nhiều lựa chọn thì một kế hoạch sống càng tốt.',
      beliefAfter: 'Khán giả phân biệt quyền đổi hướng có chủ đích với thói quen không chịu chọn.',
      centralTension: 'Tự do bảo vệ con người khỏi quyết định tệ nhưng cũng có thể trì hoãn quyết định đáng làm.',
      hookDebt: 'Chỉ ra điểm mà quyền lựa chọn đảo chiều thành cái cớ để đứng yên.',
      beatQuestions: [
        'Khi nào một lựa chọn mở còn tạo giá trị?',
        'Dấu hiệu nào cho thấy sự linh hoạt đã biến thành trì hoãn?',
      ],
      evidenceNeeds: [
        'Cần đối chiếu lợi ích của linh hoạt với chi phí của việc không cam kết.',
        'Bằng chứng nào cho thấy một giới hạn tự đặt có thể cải thiện hành động?',
      ],
      falsifiers: ['Nếu thêm lựa chọn luôn làm quyết định tốt hơn thì phép đảo chiều này bị bác bỏ.'],
      proposedPayoff: 'Người xem có tiêu chí để đóng một cánh cửa mà không đánh mất quyền tự chủ.',
    },
  ];
}

function validDiverge(): DivergeArtifact {
  return {
    schemaVersion: DIVERGE_SCHEMA_VERSION,
    hypotheses: hypotheses(),
  };
}

function researchMap(): ResearchMap {
  return {
    schemaVersion: RESEARCH_MAP_SCHEMA_VERSION,
    sourceAudit: [
      { videoId: 'v1', mainClaim: 'Quỹ dự phòng tạo lựa chọn.', angle: 'quyền đổi hướng', originGroup: 'g1', limitations: [] },
      { videoId: 'v2', mainClaim: 'Chi phí cứng thu hẹp thời gian.', angle: 'dòng tiền', originGroup: 'g2', limitations: [] },
      { videoId: 'v3', mainClaim: 'Khoảng chờ hỗ trợ đàm phán.', angle: 'thời gian', originGroup: 'g3', limitations: [] },
      { videoId: 'v4', mainClaim: 'Linh hoạt có hai mặt.', angle: 'xung đột', originGroup: 'g4', limitations: [] },
      { videoId: 'v5', mainClaim: 'Một kết luận đã bị bác bỏ.', angle: 'rủi ro', originGroup: 'g5', limitations: [] },
    ],
    claims: [
      {
        id: 'c-choice',
        text: 'Khoảng đệm bảo vệ quyền đổi hướng.',
        status: 'ATTESTED',
        evidenceIds: ['e-choice'],
        independentOriginGroups: ['g1'],
        caveats: [],
      },
      {
        id: 'c-cost',
        text: 'Chi phí cố định làm hẹp thời gian ra quyết định.',
        status: 'ATTESTED',
        evidenceIds: ['e-cost'],
        independentOriginGroups: ['g2'],
        caveats: [],
      },
      {
        id: 'c-wait',
        text: 'Khoảng chờ thay đổi vị thế thương lượng.',
        status: 'ATTESTED',
        evidenceIds: ['e-wait'],
        independentOriginGroups: ['g3'],
        caveats: [],
      },
      {
        id: 'c-disputed',
        text: 'Nhiều lựa chọn luôn làm quyết định tốt hơn.',
        status: 'DISPUTED',
        evidenceIds: ['e-disputed-for', 'e-disputed-against'],
        independentOriginGroups: ['g4', 'g5'],
        caveats: ['nguồn không thống nhất theo bối cảnh'],
      },
      {
        id: 'c-rejected',
        text: 'Mọi tài sản đều làm con người tự do hơn.',
        status: 'REJECTED',
        evidenceIds: ['e-rejected'],
        independentOriginGroups: ['g5'],
        caveats: [],
      },
    ],
    evidence: [
      { id: 'e-choice', claimId: 'c-choice', videoId: 'v1', quote: 'Khoảng đệm giúp một người có thể đổi hướng.', relation: 'SUPPORTS' },
      { id: 'e-cost', claimId: 'c-cost', videoId: 'v2', quote: 'Chi phí cố định làm thời gian lựa chọn ngắn lại.', relation: 'QUALIFIES' },
      { id: 'e-wait', claimId: 'c-wait', videoId: 'v3', quote: 'Thời gian chờ cho phép từ chối một thỏa thuận kém.', relation: 'SUPPORTS' },
      { id: 'e-disputed-for', claimId: 'c-disputed', videoId: 'v4', quote: 'Một số lựa chọn bổ sung có thể cải thiện quyết định.', relation: 'SUPPORTS' },
      { id: 'e-disputed-against', claimId: 'c-disputed', videoId: 'v5', quote: 'Quá nhiều lựa chọn đôi khi làm chậm hành động.', relation: 'CONTRADICTS' },
      { id: 'e-rejected', claimId: 'c-rejected', videoId: 'v5', quote: 'Tài sản không tự động tạo ra tự do.', relation: 'SUPPORTS' },
    ],
    conflicts: [{ claimIds: ['c-choice', 'c-disputed'], explanation: 'Quyền chọn và quá tải lựa chọn là hai cơ chế khác nhau.' }],
    openQuestions: [],
    overusedAngles: [],
  };
}

const SELECTED_HOOK: SelectedHook = {
  id: 'hook-human',
  type: 'direct-question',
  typeLabel: HOOK_TYPE_LABELS['direct-question'],
  text: 'Nếu một công việc lương cao khiến bạn không thể rời đi, nó còn là an toàn không?',
};

function rebuiltZoom(): StoryHypothesis {
  const original = hypotheses()[1];
  return {
    ...original,
    beliefAfter: 'Khán giả nhận ra chi phí cứng và thời gian dự phòng cùng quyết định quyền từ chối.',
  };
}

function validConfront(): ConfrontArtifact {
  const originalZoom = hypotheses()[1];
  const rebuilt = rebuiltZoom();
  return {
    schemaVersion: CONFRONT_SCHEMA_VERSION,
    assessments: [
      {
        hypothesisId: 'h-contradiction',
        verdict: 'KEEP',
        supportClaimIds: ['c-choice'],
        counterClaimIds: [],
        falsifierHits: [],
        unsupportedEvidenceNeeds: [],
        deltas: [],
      },
      {
        hypothesisId: 'h-zoom',
        verdict: 'REBUILD',
        supportClaimIds: ['c-cost', 'c-wait'],
        counterClaimIds: [],
        falsifierHits: [],
        unsupportedEvidenceNeeds: [originalZoom.evidenceNeeds[1]!],
        deltas: [
          {
            field: 'beliefAfter',
            before: originalZoom.beliefAfter,
            after: rebuilt.beliefAfter,
            reason: 'Nguồn chỉ hỗ trợ cơ chế kết hợp giữa chi phí và khoảng chờ.',
            claimIds: ['c-cost', 'c-wait'],
          },
        ],
        rebuiltHypothesis: rebuilt,
      },
      {
        hypothesisId: 'h-inversion',
        verdict: 'REJECT',
        supportClaimIds: [],
        counterClaimIds: ['c-disputed'],
        falsifierHits: [hypotheses()[2].falsifiers[0]!],
        unsupportedEvidenceNeeds: [],
        deltas: [],
      },
    ],
    selectedHypothesisId: 'h-zoom',
    hookVerdict: {
      status: 'KEEP',
      rationale: 'Câu hỏi vẫn đúng hướng và không khẳng định một con số.',
      claimIds: ['c-cost'],
    },
    finalPlan: {
      coreInsight: 'Quyền từ chối phụ thuộc cả chi phí cứng lẫn thời gian dự phòng.',
      memoryAnchor: { kind: 'equation', value: 'quyền lựa chọn = khoảng chờ - áp lực cố định' },
      progression: [
        {
          beat: 'Lối thoát',
          newInformation: 'Khoảng đệm bảo vệ quyền đổi hướng.',
          characterOrArgumentChange: 'Từ nhìn số dư sang nhìn lựa chọn.',
          visualAnchor: 'Một cánh cửa còn mở.',
        },
        {
          beat: 'Đồng hồ',
          newInformation: 'Chi phí cố định làm thời gian lựa chọn ngắn lại.',
          characterOrArgumentChange: 'Áp lực được nhìn như một chiếc đồng hồ.',
          visualAnchor: 'Lịch đếm ngược.',
        },
        {
          beat: 'Vị thế',
          newInformation: 'Khoảng chờ cho phép từ chối một thỏa thuận kém.',
          characterOrArgumentChange: 'Thời gian trở thành sức mạnh thương lượng.',
          visualAnchor: 'Hai lời đề nghị trên bàn.',
        },
      ],
      endingPayoff: {
        resolvesOpening: 'Lương cao không đủ nếu người nhận không còn quyền rời đi.',
        audienceCanDo: 'Đo khoảng chờ và áp lực cố định trước một cam kết mới.',
      },
      cutList: ['Không biến video thành danh sách tỷ lệ ngân sách.'],
    },
    beatEvidence: [
      { beatIndex: 0, claimIds: ['c-choice'], evidenceIds: ['e-choice'] },
      { beatIndex: 1, claimIds: ['c-cost'], evidenceIds: ['e-cost'] },
      { beatIndex: 2, claimIds: ['c-wait'], evidenceIds: ['e-wait'] },
    ],
  };
}

const CONTEXT = {
  divergeArtifact: validDiverge(),
  researchMap: researchMap(),
  selectedHook: SELECTED_HOOK,
};

function copyDiverge(): DivergeArtifact {
  return structuredClone(validDiverge());
}

function copyConfront(): ConfrontArtifact {
  return structuredClone(validConfront());
}

describe('validateDivergeArtifact', () => {
  test('accepts three source-blind, materially distinct belief journeys', () => {
    const result = validateDivergeArtifact(validDiverge());
    expect(result.ok).toBe(true);
  });

  test('requires exactly three candidates and three distinct provocations', () => {
    const tooFew = { ...validDiverge(), hypotheses: hypotheses().slice(0, 2) };
    expect(validateDivergeArtifact(tooFew).ok).toBe(false);

    const duplicateProvocation = copyDiverge();
    duplicateProvocation.hypotheses[2].provocation = 'ZOOM_IN';
    const result = validateDivergeArtifact(duplicateProvocation);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('STORY_DISTINCTNESS');
  });

  test('rejects wording variants and unchanged belief shifts', () => {
    const variants = copyDiverge();
    for (const field of ['thesisHypothesis', 'beliefBefore', 'beliefAfter', 'centralTension'] as const) {
      variants.hypotheses[1][field] = variants.hypotheses[0][field];
    }
    const duplicateResult = validateDivergeArtifact(variants);
    expect(duplicateResult.ok).toBe(false);
    if (!duplicateResult.ok) expect(duplicateResult.errorCode).toBe('STORY_DISTINCTNESS');

    const unchanged = copyDiverge();
    unchanged.hypotheses[0].beliefAfter = unchanged.hypotheses[0].beliefBefore;
    const unchangedResult = validateDivergeArtifact(unchanged);
    expect(unchangedResult.ok).toBe(false);
    if (!unchangedResult.ok) expect(unchangedResult.errorCode).toBe('STORY_DISTINCTNESS');
  });

  test('rejects pinned source IDs, host names, and raw fragments', () => {
    const leakedId = copyDiverge();
    leakedId.hypotheses[0].centralTension += ' XyZ-video-42';
    const idResult = validateDivergeArtifact(leakedId, { sourceVideoIds: ['XyZ-video-42'] });
    expect(idResult.ok).toBe(false);
    if (!idResult.ok) expect(idResult.errorCode).toBe('STORY_SOURCE_LEAK');

    const leakedHost = copyDiverge();
    leakedHost.hypotheses[0].hookDebt += ' theo Kenh Tai Chinh That';
    expect(validateDivergeArtifact(leakedHost, { sourceHostNames: ['Kenh Tai Chinh That'] }).ok).toBe(false);

    const fragment = 'Câu nguyên văn rất riêng chỉ xuất hiện trong transcript gốc.';
    const leakedFragment = copyDiverge();
    leakedFragment.hypotheses[1].proposedPayoff = fragment;
    expect(validateDivergeArtifact(leakedFragment, { forbiddenSourceFragments: [fragment] }).ok).toBe(false);

    const shortId = copyDiverge();
    shortId.hypotheses[2].hookDebt += ' v1';
    expect(validateDivergeArtifact(shortId, { sourceVideoIds: ['v1'] }).ok).toBe(false);
  });

  test('rejects a finished outline disguised inside hypothesis fields', () => {
    const raw = copyDiverge();
    raw.hypotheses[0].hookDebt = 'Mở bài bằng câu hỏi, rồi chuyển sang phần 1.';
    const result = validateDivergeArtifact(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('STORY_FORBIDDEN_TOPOLOGY');
  });

  test('rejects fabricated statistics but permits a number pinned in the selected hook', () => {
    const raw = copyDiverge();
    raw.hypotheses[0].thesisHypothesis += ' Có tới 70% người bị kẹt.';
    const rejected = validateDivergeArtifact(raw);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.errorCode).toBe('STORY_SOURCE_LEAK');

    const allowed = validateDivergeArtifact(raw, {
      allowedHookText: 'Có tới 70% người bị kẹt trong lựa chọn này?',
    });
    expect(allowed.ok).toBe(true);

    const numericEvidenceNeed = copyDiverge();
    numericEvidenceNeed.hypotheses[1].evidenceNeeds[0] = 'Cần kiểm tra liệu 80% người có gặp cơ chế này.';
    expect(validateDivergeArtifact(numericEvidenceNeed).ok).toBe(false);
  });

  test('requires evidence needs to be inquiries and falsifiers to be conditions', () => {
    const assertedNeed = copyDiverge();
    assertedNeed.hypotheses[0].evidenceNeeds[0] = 'Chi phí cố định luôn làm người ta bỏ việc.';
    expect(validateDivergeArtifact(assertedNeed).ok).toBe(false);

    const assertion = copyDiverge();
    assertion.hypotheses[0].falsifiers[0] = 'Cam kết tài chính lớn làm hẹp lựa chọn.';
    expect(validateDivergeArtifact(assertion).ok).toBe(false);
  });

  test('rejects unknown keys and oversize artifacts', () => {
    const unknown = { ...validDiverge(), outline: ['mở', 'thân', 'kết'] };
    expect(validateDivergeArtifact(unknown).ok).toBe(false);
    const result = validateDivergeArtifact(validDiverge(), { maxBytes: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('STORY_ARTIFACT_OVERSIZE');
  });
});

describe('validateConfrontArtifact', () => {
  test('accepts all three assessments, a real REBUILD, and three grounded beats', () => {
    const result = validateConfrontArtifact(validConfront(), CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.selectedHypothesisId).toBe('h-zoom');
    expect(selectedEvidenceIdsFromConfront(result.artifact)).toEqual(['e-choice', 'e-cost', 'e-wait']);
    expect(effectiveHookFromConfront(SELECTED_HOOK, result.artifact)).toEqual(SELECTED_HOOK);
  });

  test('assesses every DIVERGE hypothesis exactly once', () => {
    const raw = copyConfront();
    raw.assessments[2].hypothesisId = 'h-zoom';
    raw.assessments[2].falsifierHits = [];
    const result = validateConfrontArtifact(raw, CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('STORY_REFERENCE');
  });

  test('does not KEEP a hit falsifier or a candidate without support', () => {
    const hit = copyConfront();
    hit.assessments[0].falsifierHits = [hypotheses()[0].falsifiers[0]!];
    expect(validateConfrontArtifact(hit, CONTEXT).ok).toBe(false);

    const unsupported = copyConfront();
    unsupported.assessments[0].supportClaimIds = [];
    expect(validateConfrontArtifact(unsupported, CONTEXT).ok).toBe(false);
  });

  test('requires an evidence reason for REJECT and every hook verdict', () => {
    const unexplainedCandidate = copyConfront();
    unexplainedCandidate.assessments[2].counterClaimIds = [];
    unexplainedCandidate.assessments[2].falsifierHits = [];
    unexplainedCandidate.assessments[2].unsupportedEvidenceNeeds = [];
    expect(validateConfrontArtifact(unexplainedCandidate, CONTEXT).ok).toBe(false);

    const unexplainedHook = copyConfront();
    unexplainedHook.hookVerdict.claimIds = [];
    expect(validateConfrontArtifact(unexplainedHook, CONTEXT).ok).toBe(false);
  });

  test('requires REBUILD delta provenance and an actual belief change', () => {
    const noDeltas = copyConfront();
    noDeltas.assessments[1].deltas = [];
    expect(validateConfrontArtifact(noDeltas, CONTEXT).ok).toBe(false);

    const wrongBefore = copyConfront();
    wrongBefore.assessments[1].deltas[0]!.before = 'Một bản diễn giải không có trong hypothesis gốc.';
    expect(validateConfrontArtifact(wrongBefore, CONTEXT).ok).toBe(false);

    const untrackedChange = copyConfront();
    untrackedChange.assessments[1].rebuiltHypothesis!.centralTension = 'Một tension mới chưa có delta.';
    expect(validateConfrontArtifact(untrackedChange, CONTEXT).ok).toBe(false);

    const untrackedArrayChange = copyConfront();
    untrackedArrayChange.assessments[1].rebuiltHypothesis!.falsifiers = [
      'Nếu áp lực cố định không ảnh hưởng lựa chọn thì bản rebuild này bị bác bỏ.',
    ];
    expect(validateConfrontArtifact(untrackedArrayChange, CONTEXT).ok).toBe(false);

    const trackedArrayChange = copyConfront();
    const rebuilt = trackedArrayChange.assessments[1].rebuiltHypothesis!;
    const before = JSON.stringify(rebuilt.falsifiers);
    rebuilt.falsifiers = ['Nếu áp lực cố định không ảnh hưởng lựa chọn thì bản rebuild này bị bác bỏ.'];
    trackedArrayChange.assessments[1].deltas.push({
      field: 'falsifiers',
      before,
      after: JSON.stringify(rebuilt.falsifiers),
      reason: 'Điều kiện mới kiểm tra đúng cơ chế đã được nguồn hỗ trợ.',
      claimIds: ['c-cost'],
    });
    expect(validateConfrontArtifact(trackedArrayChange, CONTEXT).ok).toBe(true);
  });

  test('never selects a REJECT hypothesis and requires one surviving hypothesis', () => {
    const selectedRejected = copyConfront();
    selectedRejected.selectedHypothesisId = 'h-inversion';
    expect(validateConfrontArtifact(selectedRejected, CONTEXT).ok).toBe(false);

    const none = copyConfront();
    for (const assessment of none.assessments) {
      assessment.verdict = 'REJECT';
      assessment.supportClaimIds = [];
      assessment.falsifierHits = [];
      assessment.deltas = [];
      delete assessment.rebuiltHypothesis;
    }
    const result = validateConfrontArtifact(none, CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('STORY_VERDICT');
  });

  test('rejects unknown and REJECTED claim references', () => {
    const unknown = copyConfront();
    unknown.assessments[0].supportClaimIds = ['c-missing'];
    expect(validateConfrontArtifact(unknown, CONTEXT).ok).toBe(false);

    const rejected = copyConfront();
    rejected.assessments[0].supportClaimIds = ['c-rejected'];
    expect(validateConfrontArtifact(rejected, CONTEXT).ok).toBe(false);
  });

  test('rejects mismatched or contradicting beat evidence', () => {
    const mismatched = copyConfront();
    mismatched.beatEvidence![0]!.evidenceIds = ['e-cost'];
    const mismatchResult = validateConfrontArtifact(mismatched, CONTEXT);
    expect(mismatchResult.ok).toBe(false);
    if (!mismatchResult.ok) expect(mismatchResult.errorCode).toBe('STORY_EVIDENCE');

    const contradicts = copyConfront();
    contradicts.beatEvidence![2] = {
      beatIndex: 2,
      claimIds: ['c-disputed'],
      evidenceIds: ['e-disputed-against'],
    };
    expect(validateConfrontArtifact(contradicts, CONTEXT).ok).toBe(false);
  });

  test('retains the minimum three unique grounded ledger entries', () => {
    const raw = copyConfront();
    raw.beatEvidence![1] = { beatIndex: 1, claimIds: ['c-choice'], evidenceIds: ['e-choice'] };
    raw.beatEvidence![2] = { beatIndex: 2, claimIds: ['c-choice'], evidenceIds: ['e-choice'] };
    const result = validateConfrontArtifact(raw, CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('STORY_EVIDENCE');
      expect(result.reason).toContain('at least 3');
    }
  });

  test('requires visible caveat language when a beat selects a DISPUTED claim', () => {
    const uncaveated = copyConfront();
    uncaveated.beatEvidence![2] = {
      beatIndex: 2,
      claimIds: ['c-disputed'],
      evidenceIds: ['e-disputed-for'],
    };
    const failed = validateConfrontArtifact(uncaveated, CONTEXT);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.errorCode).toBe('STORY_DISPUTED_UNQUALIFIED');

    uncaveated.finalPlan!.progression[2]!.newInformation =
      'Nguồn chưa thống nhất: nhiều lựa chọn có thể giúp, nhưng đôi khi cũng làm chậm hành động.';
    const passed = validateConfrontArtifact(uncaveated, CONTEXT);
    expect(passed.ok).toBe(true);
  });

  test('allows only evidence-linked hook tightening that preserves the selected promise', () => {
    const rewrite = copyConfront();
    rewrite.hookVerdict = {
      status: 'REWRITE',
      rationale: 'Nguồn hỗ trợ cơ chế chi phí cứng, nên câu hỏi cần nói rõ hơn.',
      claimIds: ['c-cost'],
      replacementHook: {
        id: 'hook-grounded-rewrite',
        type: 'direct-question',
        typeLabel: HOOK_TYPE_LABELS['direct-question'],
        text: 'Nếu một công việc lương cao nhưng chi phí cố định khiến bạn không thể rời đi, nó còn là an toàn không?',
      },
    };
    const result = validateConfrontArtifact(rewrite, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(effectiveHookFromConfront(SELECTED_HOOK, result.artifact)?.id).toBe('hook-grounded-rewrite');

    const materialChange = copyConfront();
    materialChange.hookVerdict = {
      status: 'REWRITE',
      rationale: 'Đổi sang một lời hứa khác.',
      claimIds: ['c-cost'],
      replacementHook: {
        id: 'hook-other',
        type: 'street-paradox',
        typeLabel: HOOK_TYPE_LABELS['street-paradox'],
        text: 'Ngoài phố hôm nay, người ta đang mua những món đồ không cần thiết.',
      },
    };
    const failed = validateConfrontArtifact(materialChange, CONTEXT);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.errorCode).toBe('STORY_HOOK');
  });

  test('accepts an evidence-linked terminal hook REJECT only without a plan', () => {
    const raw = copyConfront();
    raw.hookVerdict = {
      status: 'REJECT',
      rationale: 'Nguồn đối chiếu bác bỏ lời hứa chính; cần người dùng chọn hook khác.',
      claimIds: ['c-disputed'],
    };
    delete raw.selectedHypothesisId;
    delete raw.finalPlan;
    delete raw.beatEvidence;
    const result = validateConfrontArtifact(raw, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(effectiveHookFromConfront(SELECTED_HOOK, result.artifact)).toBeNull();
    expect(selectedEvidenceIdsFromConfront(result.artifact)).toEqual([]);

    const leakedPlan = { ...raw, finalPlan: validConfront().finalPlan };
    expect(validateConfrontArtifact(leakedPlan, CONTEXT).ok).toBe(false);
  });

  test('rejects unknown plan fields and oversize artifacts', () => {
    const unknown = copyConfront() as ConfrontArtifact & { finalPlan: NonNullable<ConfrontArtifact['finalPlan']> & { prose?: string } };
    unknown.finalPlan.prose = 'Một đoạn essay không thuộc plan contract.';
    expect(validateConfrontArtifact(unknown, CONTEXT).ok).toBe(false);

    const result = validateConfrontArtifact(validConfront(), { ...CONTEXT, maxBytes: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('STORY_ARTIFACT_OVERSIZE');
  });
});
