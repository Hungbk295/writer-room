import { exec } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  AgentAdapter, AgentProfile, AgentRole, EditorArtifact, HumanBrief, HumanRoundNote, JobDescriptor,
  JobResultEnvelope, RunConfig, RunState, SeoArtifact, WriterDraftArtifact, WriterInitArtifact,
} from './domain.ts';
import {
  SCHEMA_VERSION, calculateEditorScore, extractJson, normalizeConfig, normalizeHumanBrief,
  parseEditor, parseSeo, parseWriterDraft, parseWriterInit, passesTarget,
} from './domain.ts';
import { editorPrompt, seoPrompt, writerHumanPrompt, writerInitPrompt, writerRevisionPrompt } from './prompts.ts';
import { APP_DATA_ROOT, RunStore } from './store.ts';

function openFolder(folderPath: string, filePath?: string): void {
  const platform = process.platform;
  if (platform === 'darwin') {
    if (filePath) {
      exec(`open -R "${filePath.replaceAll('"', '\\"')}"`, (err) => {
        if (err) exec(`open "${folderPath.replaceAll('"', '\\"')}"`);
      });
    } else {
      exec(`open "${folderPath.replaceAll('"', '\\"')}"`);
    }
  } else if (platform === 'win32') {
    if (filePath) {
      exec(`explorer.exe /select,"${filePath.replaceAll('"', '\\"')}"`, (err) => {
        if (err) exec(`explorer.exe "${folderPath.replaceAll('"', '\\"')}"`);
      });
    } else {
      exec(`explorer.exe "${folderPath.replaceAll('"', '\\"')}"`);
    }
  } else {
    exec(`xdg-open "${folderPath.replaceAll('"', '\\"')}"`);
  }
}
import { TmuxController } from './tmux.ts';
import { AgentSettingsStore } from './agents.ts';
import type { TerminalController } from './terminal.ts';
import {
  appendAttempt, classifyFailure, createJobRecord, finishAttempt, logicalJobKey,
  readHeartbeat, settleRecord, sha256,
} from './supervisor.ts';
import { ArticleLibrary } from './library.ts';
import { loadModelCatalog } from './model-catalog.ts';

const ACTIVE_STAGES = new Set([
  'writer_init', 'writer_human', 'editor', 'writer_revision', 'seo',
]);

const ROLE_BY_STAGE: Partial<Record<NonNullable<RunState['failedStage']>, AgentRole>> = {
  writer_init: 'writer',
  writer_human: 'writer',
  editor: 'editor',
  writer_revision: 'writer',
  seo: 'seo',
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function abortError(): Error {
  const error = new Error('run cancelled');
  error.name = 'AbortError';
  return error;
}

function createId(): string {
  const stamp = Date.now().toString(36);
  const random = crypto.randomUUID().slice(0, 8);
  return `r-${stamp}-${random}`;
}

function mockArtifact(kind: string): unknown {
  if (kind === 'writer-init') {
    return {
      draftMarkdown: '# Bản init\n\nĐây là bản nháp đầu tiên để mở cuộc trò chuyện với tác giả.',
      evidenceLedger: [
        { id: 'E1', kind: 'claim', text: 'Khán giả thường bắt đầu từ một niềm tin phổ biến.', sourceRef: 'input:title', confidence: 'low', corroborationIds: [], contradictionIds: ['E2'] },
        { id: 'E2', kind: 'scene', text: 'Một khoảnh khắc nhỏ có thể làm thay đổi cách nhìn.', sourceRef: 'mock:source-pack', confidence: 'medium', corroborationIds: [], contradictionIds: ['E1'] },
        { id: 'E3', kind: 'fact', text: 'Bài cần trả một lời hứa cụ thể thay vì chỉ gây tò mò.', sourceRef: 'mock:writer-guide', confidence: 'high', corroborationIds: [], contradictionIds: [] },
      ],
      insightStatements: [
        { id: 'I1', statement: 'Khán giả tìm fact nhưng ở lại vì một niềm tin của họ bị thử thách.', audiencePriorBelief: 'Fact tự tạo ra sức hút.', audienceDesireOrFear: 'Sợ bị bỏ lại hoặc hiểu sai.', tension: 'Biết nhiều chưa chắc nhìn đúng.', evidenceIds: ['E1', 'E3'], counterEvidenceIds: ['E2'] },
        { id: 'I2', statement: 'Một cảnh thật biến thông tin trừu tượng thành trải nghiệm.', audiencePriorBelief: 'Giải thích đủ là thuyết phục.', audienceDesireOrFear: 'Muốn cảm thấy câu chuyện liên quan đến mình.', tension: 'Giải thích và trải nghiệm không giống nhau.', evidenceIds: ['E2'], counterEvidenceIds: [] },
        { id: 'I3', statement: 'Hook mạnh là hợp đồng có payoff, không phải câu gây sốc.', audiencePriorBelief: 'Càng giật càng giữ người.', audienceDesireOrFear: 'Muốn được thưởng cho thời gian xem.', tension: 'Tò mò không payoff làm mất niềm tin.', evidenceIds: ['E3'], counterEvidenceIds: [] },
      ],
      outlineOptions: [
        { id: 'outline-a', label: 'Mâu thuẫn', rationale: 'Đi từ niềm tin phổ biến đến điều bị che khuất.', angle: 'Mâu thuẫn trung tâm', centralQuestion: 'Điều gì ta đang hiểu sai?', hypothesis: 'Niềm tin phổ biến che mất nguyên nhân thật.', throughline: 'Niềm tin → vết nứt → bằng chứng → cách nhìn mới', audiencePayoff: 'Một cách nhìn có thể áp dụng ngay.', beats: ['beat-a1: Niềm tin cũ', 'beat-a2: Vết nứt', 'beat-a3: Bằng chứng và cách nhìn mới'], evidenceIds: ['E1', 'E3'], riskFlags: ['Cần human xác nhận tension audience'], recommended: true },
        { id: 'outline-b', label: 'Hành trình', rationale: 'Theo một khoảnh khắc thay đổi.', angle: 'Trước và sau', centralQuestion: 'Khoảnh khắc nào tạo thay đổi?', hypothesis: 'Một chi tiết nhỏ làm nhân vật đổi lựa chọn.', throughline: 'Trước → biến cố → lựa chọn → sau', audiencePayoff: 'Nhìn thấy thay đổi qua một cảnh cụ thể.', beats: ['beat-b1: Trước', 'beat-b2: Biến cố', 'beat-b3: Lựa chọn và sau'], evidenceIds: ['E2'], riskFlags: ['Cần chi tiết trải nghiệm từ human'], recommended: false },
        { id: 'outline-c', label: 'Điều tra', rationale: 'Kiểm từng giả thuyết.', angle: 'Câu hỏi cần kiểm chứng', centralQuestion: 'Giả thuyết nào còn đứng vững?', hypothesis: 'Phản chứng dẫn tới câu chuyện tốt hơn.', throughline: 'Câu hỏi → giả thuyết → phản chứng → kết luận', audiencePayoff: 'Hiểu vì sao kết luận đáng tin.', beats: ['beat-c1: Câu hỏi', 'beat-c2: Giả thuyết và phản chứng', 'beat-c3: Kết luận'], evidenceIds: ['E1', 'E2', 'E3'], riskFlags: [], recommended: false },
      ],
      hookOptions: [
        { id: 'hook-a', angleId: 'outline-a', label: 'Nghịch lý', rationale: 'Tạo căng thẳng nhận thức.', text: 'Điều ai cũng tin có thể chính là thứ làm ta nhìn sai.', strategy: 'contradiction', promise: 'Chỉ ra niềm tin sai và nguyên nhân thật.', openLoop: 'Niềm tin nào đang sai?', payoffBeatId: 'beat-a3', evidenceIds: ['E1', 'E3'], truthRisk: 'medium', clickbaitRisk: 'low', recommended: true },
        { id: 'hook-a2', angleId: 'outline-a', label: 'Hệ quả', rationale: 'Mở bằng cái giá của niềm tin cũ.', text: 'Cái giá lớn nhất không nằm ở việc ta thiếu thông tin.', strategy: 'consequence', promise: 'Giải thích cái giá thật.', openLoop: 'Cái giá đó là gì?', payoffBeatId: 'beat-a3', evidenceIds: ['E1', 'E3'], truthRisk: 'medium', clickbaitRisk: 'medium', recommended: false },
        { id: 'hook-b', angleId: 'outline-b', label: 'Khoảnh khắc', rationale: 'Mở bằng cảnh thật.', text: 'Tôi chỉ đổi ý sau một khoảnh khắc rất nhỏ.', strategy: 'scene', promise: 'Tái hiện khoảnh khắc thay đổi.', openLoop: 'Điều gì đã xảy ra?', payoffBeatId: 'beat-b2', evidenceIds: ['E2'], truthRisk: 'medium', clickbaitRisk: 'low', recommended: true },
        { id: 'hook-b2', angleId: 'outline-b', label: 'Câu hỏi trải nghiệm', rationale: 'Mời khán giả bước vào lựa chọn.', text: 'Bạn sẽ làm gì nếu khoảnh khắc ấy xảy ra với mình?', strategy: 'question', promise: 'Cho thấy lựa chọn và hệ quả.', openLoop: 'Lựa chọn nào sẽ được đưa ra?', payoffBeatId: 'beat-b3', evidenceIds: ['E2'], truthRisk: 'low', clickbaitRisk: 'low', recommended: false },
        { id: 'hook-c', angleId: 'outline-c', label: 'Câu hỏi', rationale: 'Mở một điều chưa được trả lời.', text: 'Nếu vấn đề chưa bao giờ nằm ở chỗ ta vẫn nghĩ thì sao?', strategy: 'question', promise: 'Kiểm chứng nguyên nhân thay thế.', openLoop: 'Vấn đề thật nằm ở đâu?', payoffBeatId: 'beat-c3', evidenceIds: ['E1', 'E2'], truthRisk: 'medium', clickbaitRisk: 'low', recommended: true },
        { id: 'hook-c2', angleId: 'outline-c', label: 'Phản chứng', rationale: 'Mở bằng dữ kiện làm đổi giả thuyết.', text: 'Chỉ một chi tiết không khớp đã làm toàn bộ giả thuyết đổi hướng.', strategy: 'contradiction', promise: 'Cho thấy chi tiết và giả thuyết mới.', openLoop: 'Chi tiết nào không khớp?', payoffBeatId: 'beat-c2', evidenceIds: ['E2', 'E3'], truthRisk: 'medium', clickbaitRisk: 'low', recommended: false },
      ],
      interviewQuestions: [
        { id: 'audience', question: 'Khán giả nói họ tin điều gì, nhưng thật ra đang sợ hoặc mong điều gì?', why: 'Tìm tension thật.', gapType: 'audience', relatedOptionIds: ['outline-a', 'outline-c'] },
        { id: 'scene', question: 'Khoảnh khắc cụ thể nào khiến bạn đổi cách nhìn?', why: 'Tìm cảnh và chi tiết.', gapType: 'experience', relatedOptionIds: ['outline-b'] },
        { id: 'voice', question: 'Câu nào bạn sẽ nói tự nhiên, và kiểu câu nào bạn tuyệt đối không nói?', why: 'Khóa giọng.', gapType: 'voice', relatedOptionIds: ['outline-a', 'outline-b', 'outline-c'] },
      ],
      selfNotes: ['Mock artifact for local proof'],
    };
  }
  if (kind.startsWith('writer-')) {
    return {
      draftMarkdown: `# Bản ${kind}\n\nĐiều ai cũng tin có thể chính là thứ làm ta nhìn sai.\n\nĐây là bản đầy đủ giữ lại insight và giọng của người viết, đồng thời giải quyết phản biện theo từng vòng.`,
      changeLog: ['Giữ hook đã chọn', 'Làm rõ mâu thuẫn và payoff'],
      appliedHumanInsights: ['Audience tension', 'Lived moment'],
      preservedHumanSignals: ['Natural phrase'],
    };
  }
  if (kind.startsWith('editor-r')) {
    const round = Number(kind.match(/r(\d+)/)?.[1] ?? 1);
    const passed = round >= 2;
    return {
      summary: passed ? 'Bài đã rõ, có giọng và trả đúng lời hứa.' : 'Bài có hướng nhưng payoff còn mỏng.',
      criteriaScores: [
        { criterion: 'Hook', score: passed ? 9.3 : 8, weight: 1, evidence: 'Mở bài nêu mâu thuẫn.', fix: passed ? '' : 'Làm lời hứa cụ thể hơn.' },
        { criterion: 'Insight', score: passed ? 9.2 : 8, weight: 1, evidence: 'Có tension và cách nhìn mới.', fix: passed ? '' : 'Thêm cảnh chứng minh.' },
      ],
      blockingIssues: [],
      revisionPlan: passed ? [] : ['Tăng độ cụ thể của payoff và cảnh trung tâm.'],
      verdict: passed ? 'pass' : 'revise',
      modelOverall: passed ? 9.25 : 8,
    };
  }
  if (kind === 'seo') {
    return {
      score: 8.8,
      verdict: 'strong',
      checks: [{ criterion: 'search intent', score: 8.8, evidence: 'Title and opening align.', recommendation: 'Keep wording natural.' }],
      titleSuggestions: [],
      descriptionOutline: ['Promise', 'Value and chapters', 'CTA'],
      keywords: ['youtube topic'],
      notes: ['Mock SEO review'],
    };
  }
  throw new Error(`no mock artifact for ${kind}`);
}

export class Orchestrator {
  private active = new Map<string, AbortController>();
  readonly terminal: TerminalController;
  /** Compatibility alias for callers that still display the dev transport as tmux. */
  readonly tmux: TerminalController;

  constructor(
    readonly store = new RunStore(),
    private readonly mock = process.env.WRITER_ROOM_MOCK === '1',
    readonly agentSettings = new AgentSettingsStore(),
    terminal?: TerminalController,
    library?: ArticleLibrary,
  ) {
    this.terminal = terminal ?? new TmuxController(mock);
    this.tmux = this.terminal;
    this.library = library ?? new ArticleLibrary(join(dirname(this.store.root), 'library.sqlite'));
  }

  readonly library: ArticleLibrary;

  async init(): Promise<void> {
    await this.store.init();
    this.library.init();
    await this.library.reconcile(this.store);
    for (const state of await this.store.listStates()) {
      await this.store.ensureProcessLog(state).catch(() => {});
      if (ACTIVE_STAGES.has(state.stage)) {
        await this.store.writeState({
          ...state,
          interrupted: true,
          recoveryStatus: 'scheduled',
          currentJob: state.currentJob ? { ...state.currentJob, status: 'interrupted' } : undefined,
          error: undefined,
        });
        this.launch(state.id, (signal) => this.resumeActive(state.id, signal));
      }
    }
  }

  health() {
    return this.terminal.health(this.agentSettings.list());
  }

  agents(): AgentProfile[] {
    return this.agentSettings.list();
  }

  models() {
    return loadModelCatalog(this.agentSettings.list());
  }

  saveAgents(raw: unknown): AgentProfile[] {
    return this.agentSettings.save(raw);
  }

  articles(query = '', includeArchived = false) {
    return this.library.list(query, includeArchived);
  }

  article(id: string) {
    return this.library.get(id);
  }

  archiveArticle(id: string, archived: boolean): void {
    this.library.setArchived(id, archived);
  }

  exportArticle(id: string) {
    return this.library.exportArticle(id);
  }

  async exportDraft(id: string, round: string | number): Promise<{ path: string; filename: string; folder: string }> {
    const state = await this.store.readState(id);
    const roundStr = String(round).trim();
    let draftMarkdown: string | undefined;
    let roundLabel: string;

    if (roundStr === 'init' || roundStr === '0') {
      const artifact = await this.store.readArtifact<WriterInitArtifact>(id, 'writer-init.json');
      draftMarkdown = artifact?.draftMarkdown;
      roundLabel = 'init';
    } else {
      const roundNum = Number(roundStr);
      if (isNaN(roundNum)) throw new Error(`Invalid round: ${roundStr}`);
      const artifact = await this.store.readArtifact<WriterDraftArtifact>(id, `draft-r${roundNum}.json`);
      draftMarkdown = artifact?.draftMarkdown;
      roundLabel = `r${roundNum}`;
    }

    if (!draftMarkdown) throw new Error(`Bản draft (${roundLabel}) không tồn tại hoặc rỗng.`);

    const safeTitle = state.config.title
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[đĐ]/g, (char) => (char === 'đ' ? 'd' : 'D'))
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'draft';

    const filename = `${safeTitle}-draft-${roundLabel}.txt`;
    const directory = join(APP_DATA_ROOT, 'exports');
    await mkdir(directory, { recursive: true });
    const filePath = join(directory, filename);
    await writeFile(filePath, draftMarkdown, 'utf8');

    openFolder(directory, filePath);

    return { path: filePath, filename, folder: directory };
  }

  backupLibrary() {
    return this.library.backup();
  }

  async create(rawConfig: unknown): Promise<RunState> {
    const config = normalizeConfig({
      ...(rawConfig as Record<string, unknown>),
      agentProfiles: this.agentSettings.list(),
    });
    const health = await this.health();
    if (!health.ok) {
      const missing = Object.entries(health.tools).filter(([, path]) => !path).map(([name]) => name);
      throw new Error(`Missing required local tools: ${missing.join(', ')}`);
    }
    const id = createId();
    const now = new Date().toISOString();
    const state: RunState = {
      schemaVersion: SCHEMA_VERSION,
      id,
      tmuxSession: `wr-${id}`,
      createdAt: now,
      updatedAt: now,
      stage: 'writer_init',
      config,
      round: 0,
      scores: [],
      revision: 0,
      recoveryStatus: 'none',
    };
    try {
      await this.store.create(state);
    } catch (error) {
      const message = (error as Error).message;
      if (/operation not permitted|eacces|eperm/i.test(message)) {
        throw new Error(`Cannot read an instruction file. macOS may be blocking Downloads; grant terminal Full Disk Access or choose readable copies. ${message}`);
      }
      throw error;
    }
    await this.terminal.ensureSession(state.tmuxSession, this.store.runDir(id));
    this.launch(id, (signal) => this.runInitial(id, signal));
    return state;
  }

  async submitHuman(id: string, raw: unknown): Promise<RunState> {
    const state = await this.store.readState(id);
    if (state.stage !== 'awaiting_human') throw new Error(`run is not awaiting initial human input (stage=${state.stage})`);
    const initial = await this.requireArtifact<WriterInitArtifact>(id, 'writer-init.json');
    const brief = normalizeHumanBrief(raw, initial);
    await this.store.writeArtifact(id, 'human-brief.json', brief);
    const next = { ...state, stage: 'writer_human' as const, error: undefined };
    await this.store.writeState(next);
    this.launch(id, (signal) => this.runAfterHuman(id, signal));
    return next;
  }

  async continueRound(id: string, noteValue: unknown): Promise<RunState> {
    const state = await this.store.readState(id);
    if (state.stage !== 'awaiting_round_human') throw new Error(`run is not at a round human gate (stage=${state.stage})`);
    const note = typeof noteValue === 'string' ? noteValue.trim() : '';
    const artifact: HumanRoundNote = { afterRound: state.round, note, submittedAt: new Date().toISOString() };
    await this.store.writeArtifact(id, `human-note-r${state.round}.json`, artifact);
    const next = { ...state, stage: 'writer_revision' as const, error: undefined };
    await this.store.writeState(next);
    this.launch(id, (signal) => this.runRevisionFrom(id, state.round, signal));
    return next;
  }

  async acceptCurrent(id: string, reasonValue: unknown): Promise<RunState> {
    const state = await this.store.readState(id);
    if (state.stage !== 'awaiting_round_human' && state.stage !== 'needs_human') {
      throw new Error(`current round cannot be accepted from stage=${state.stage}`);
    }
    if (state.round < 1) throw new Error('no scored round to accept');
    const reason = typeof reasonValue === 'string' && reasonValue.trim() ? reasonValue.trim() : 'Human editorial override';
    const next: RunState = {
      ...state,
      stage: 'seo',
      acceptedRound: state.round,
      acceptedBy: 'human',
      humanOverrideReason: reason,
      error: undefined,
    };
    await this.store.writeState(next);
    this.launch(id, (signal) => this.runSeo(id, signal));
    return next;
  }

  async cancel(id: string): Promise<RunState> {
    this.active.get(id)?.abort();
    this.active.delete(id);
    const state = await this.store.readState(id);
    await this.terminal.killSession(state.tmuxSession).catch(() => {});
    const next = { ...state, stage: 'cancelled' as const, currentJob: undefined, error: undefined };
    await this.store.writeState(next);
    return next;
  }

  private launch(id: string, task: (signal: AbortSignal) => Promise<void>): void {
    if (this.active.has(id)) throw new Error('run already has an active task');
    const controller = new AbortController();
    this.active.set(id, controller);
    void task(controller.signal)
      .catch((error) => this.fail(id, error))
      .finally(() => this.active.delete(id));
  }

  private async fail(id: string, error: unknown): Promise<void> {
    const current = await this.store.readState(id).catch(() => null);
    if (!current || current.stage === 'cancelled' || (error as Error).name === 'AbortError') return;
    await this.store.writeState({
      ...current,
      stage: 'failed',
      failedStage: ACTIVE_STAGES.has(current.stage) ? current.stage as RunState['failedStage'] : current.failedStage,
      currentJob: undefined,
      recoveryStatus: 'action_required',
      error: (error as Error).message || String(error),
    });
  }

  async retry(id: string): Promise<RunState> {
    const state = await this.store.readState(id);
    if (state.stage !== 'failed' || !state.failedStage) throw new Error(`run is not retryable (stage=${state.stage})`);
    const role = ROLE_BY_STAGE[state.failedStage];
    const previous = role ? state.config.agentProfiles.find((profile) => profile.role === role) : undefined;
    const current = role ? this.agentSettings.list().find((profile) => profile.role === role && profile.enabled) : undefined;
    if (previous && current && JSON.stringify(previous) !== JSON.stringify(current)) {
      return this.retryWithCurrentAgent(id);
    }
    return this.retrySnapshot(id);
  }

  async retrySnapshot(id: string): Promise<RunState> {
    const state = await this.store.readState(id);
    if (state.stage !== 'failed' || !state.failedStage) throw new Error(`run is not retryable (stage=${state.stage})`);
    const next: RunState = {
      ...state,
      stage: state.failedStage,
      failedStage: undefined,
      currentJob: undefined,
      recoveryStatus: 'scheduled',
      manualRetryRequested: true,
      error: undefined,
    };
    await this.store.writeState(next);
    this.launch(id, (signal) => this.resumeActive(id, signal));
    return next;
  }

  async retryWithCurrentAgent(id: string): Promise<RunState> {
    const state = await this.store.readState(id);
    if (state.stage !== 'failed' || !state.failedStage) throw new Error(`run is not retryable (stage=${state.stage})`);
    const role = ROLE_BY_STAGE[state.failedStage];
    if (!role) throw new Error(`failed stage has no agent role (stage=${state.failedStage})`);
    const replacement = this.agentSettings.list().find((profile) => profile.role === role && profile.enabled);
    if (!replacement) throw new Error(`no enabled current agent for role=${role}`);
    const previous = state.config.agentProfiles.find((profile) => profile.role === role);
    if (!previous) throw new Error(`run has no agent snapshot for role=${role}`);
    const agentProfiles = state.config.agentProfiles.map((profile) => profile.role === role
      ? { ...replacement, args: [...replacement.args] }
      : profile);
    await this.store.appendProcessEvent(id, {
      event: 'agent.profile.replaced',
      stage: state.failedStage,
      role,
      reason: 'failed-run recovery requested by human',
      previous: {
        slot: previous.slot, adapter: previous.adapter, executable: previous.executable,
        model: previous.model || 'provider-default', args: previous.args,
      },
      next: {
        slot: replacement.slot, adapter: replacement.adapter, executable: replacement.executable,
        model: replacement.model || 'provider-default', args: replacement.args,
      },
    });
    await this.store.writeState({ ...state, config: { ...state.config, agentProfiles } });
    return this.retrySnapshot(id);
  }

  private async resumeActive(id: string, signal: AbortSignal): Promise<void> {
    let state = await this.store.readState(id);
    await this.store.writeState({ ...state, recoveryStatus: 'resuming', error: undefined });
    state = await this.store.readState(id);
    if (state.stage === 'writer_init') return this.runInitial(id, signal);
    if (state.stage === 'writer_human') {
      const brief = await this.store.readArtifact<HumanBrief>(id, 'human-brief.json');
      if (!brief) {
        await this.store.writeState({ ...state, stage: 'awaiting_human', recoveryStatus: 'none', currentJob: undefined });
        return;
      }
      return this.runAfterHuman(id, signal);
    }
    if (state.stage === 'editor') {
      const draft = await this.requireArtifact<WriterDraftArtifact>(id, `draft-r${state.round}.json`);
      return this.reviewLoop(id, state.round, draft, signal);
    }
    if (state.stage === 'writer_revision') return this.runRevisionFrom(id, state.round, signal);
    if (state.stage === 'seo') return this.runSeo(id, signal);
  }

  private async runInitial(id: string, signal: AbortSignal): Promise<void> {
    const state = await this.store.readState(id);
    const [guide, sourcePack] = await Promise.all([
      this.store.readInput(id, 'writer-guide.txt'),
      this.store.readInput(id, 'source-pack.txt'),
    ]);
    const artifact = await this.runRole(id, state, 'writer', 'writer-init', writerInitPrompt(state.config, guide, sourcePack), parseWriterInit, signal);
    await this.store.writeArtifact(id, 'writer-init.json', artifact);
    const latest = await this.store.readState(id);
    await this.store.writeState({ ...latest, stage: 'awaiting_human', currentJob: undefined, recoveryStatus: 'none', interrupted: false, error: undefined });
  }

  private async runAfterHuman(id: string, signal: AbortSignal): Promise<void> {
    const state = await this.store.readState(id);
    const [guide, sourcePack, initial, human] = await Promise.all([
      this.store.readInput(id, 'writer-guide.txt'),
      this.store.readInput(id, 'source-pack.txt'),
      this.requireArtifact<WriterInitArtifact>(id, 'writer-init.json'),
      this.requireArtifact<HumanBrief>(id, 'human-brief.json'),
    ]);
    const existing = await this.store.readArtifact<WriterDraftArtifact>(id, 'draft-r1.json');
    const draft = existing ?? await this.runRole(id, state, 'writer', 'writer-human', writerHumanPrompt(state.config, guide, sourcePack, initial, human), parseWriterDraft, signal);
    if (!existing) await this.store.writeArtifact(id, 'draft-r1.json', draft);
    const latest = await this.store.readState(id);
    await this.store.writeState({ ...latest, round: 1, stage: 'editor', currentJob: undefined, recoveryStatus: 'none', interrupted: false });
    await this.reviewLoop(id, 1, draft, signal);
  }

  private async runRevisionFrom(id: string, previousRound: number, signal: AbortSignal): Promise<void> {
    const state = await this.store.readState(id);
    const [guide, sourcePack, previous, review, human, humanNote] = await Promise.all([
      this.store.readInput(id, 'writer-guide.txt'),
      this.store.readInput(id, 'source-pack.txt'),
      this.requireArtifact<WriterDraftArtifact>(id, `draft-r${previousRound}.json`),
      this.requireArtifact<EditorArtifact>(id, `review-r${previousRound}.json`),
      this.requireArtifact<HumanBrief>(id, 'human-brief.json'),
      this.store.readArtifact<HumanRoundNote>(id, `human-note-r${previousRound}.json`),
    ]);
    const nextRound = previousRound + 1;
    const existing = await this.store.readArtifact<WriterDraftArtifact>(id, `draft-r${nextRound}.json`);
    const draft = existing ?? await this.runRole(
      id, state, 'writer', `writer-r${nextRound}`,
      writerRevisionPrompt(state.config, guide, sourcePack, previous, review, nextRound, human, humanNote),
      parseWriterDraft, signal,
    );
    if (!existing) await this.store.writeArtifact(id, `draft-r${nextRound}.json`, draft);
    const latest = await this.store.readState(id);
    await this.store.writeState({ ...latest, round: nextRound, stage: 'editor', currentJob: undefined });
    await this.reviewLoop(id, nextRound, draft, signal);
  }

  private async reviewLoop(id: string, firstRound: number, firstDraft: WriterDraftArtifact, signal: AbortSignal): Promise<void> {
    let round = firstRound;
    let draft = firstDraft;
    while (true) {
      if (signal.aborted) throw abortError();
      let state = await this.store.readState(id);
      const criteria = await this.store.readInput(id, 'editor-criteria.txt');
      const existingReview = await this.store.readArtifact<EditorArtifact>(id, `review-r${round}.json`);
      const review = existingReview ?? await this.runRole(
        id, state, 'editor', `editor-r${round}`,
        editorPrompt(state.config, criteria, draft, round), parseEditor, signal,
      );
      const reviewArtifact = existingReview
        ? `artifacts/review-r${round}.json`
        : await this.store.writeArtifact(id, `review-r${round}.json`, review);
      const score = calculateEditorScore(review);
      const passed = passesTarget(review, state.config.targetScore);
      const scores = [...state.scores.filter((item) => item.round !== round), {
        round,
        score,
        passed,
        reviewArtifact,
        draftArtifact: `artifacts/draft-r${round}.json`,
      }].sort((a, b) => a.round - b.round);
      state = { ...state, round, scores, currentJob: undefined };
      if (passed) {
        await this.store.writeState({ ...state, stage: 'seo', acceptedRound: round, acceptedBy: 'target' });
        await this.runSeo(id, signal);
        return;
      }
      if (round >= state.config.maxRounds) {
        await this.store.writeState({ ...state, stage: 'needs_human' });
        return;
      }
      if (state.config.humanGate === 'every_round') {
        await this.store.writeState({ ...state, stage: 'awaiting_round_human' });
        return;
      }

      const [guide, sourcePack, human] = await Promise.all([
        this.store.readInput(id, 'writer-guide.txt'),
        this.store.readInput(id, 'source-pack.txt'),
        this.requireArtifact<HumanBrief>(id, 'human-brief.json'),
      ]);
      const nextRound = round + 1;
      await this.store.writeState({ ...state, stage: 'writer_revision' });
      draft = await this.runRole(
        id, state, 'writer', `writer-r${nextRound}`,
        writerRevisionPrompt(state.config, guide, sourcePack, draft, review, nextRound, human, null),
        parseWriterDraft, signal,
      );
      await this.store.writeArtifact(id, `draft-r${nextRound}.json`, draft);
      round = nextRound;
      const latest = await this.store.readState(id);
      await this.store.writeState({ ...latest, round, stage: 'editor', currentJob: undefined });
    }
  }

  private async runSeo(id: string, signal: AbortSignal): Promise<void> {
    const state = await this.store.readState(id);
    if (!state.acceptedRound) throw new Error('SEO requires an accepted round');
    const draft = await this.requireArtifact<WriterDraftArtifact>(id, `draft-r${state.acceptedRound}.json`);
    const existing = await this.store.readArtifact<SeoArtifact>(id, 'seo.json');
    const seo = existing ?? await this.runRole<SeoArtifact>(id, state, 'seo', 'seo', seoPrompt(state.config, draft), parseSeo, signal);
    if (!existing) await this.store.writeArtifact(id, 'seo.json', seo);
    const latest = await this.store.readState(id);
    await this.store.writeState({ ...latest, stage: 'complete', currentJob: undefined, recoveryStatus: 'none', interrupted: false, error: undefined });
    const complete = await this.store.readState(id);
    try {
      const receipt = this.library.publish(complete, draft, seo);
      await this.store.writeArtifact(id, 'library-published.json', { ...receipt, schemaVersion: 1, publishedAt: new Date().toISOString() });
    } catch (error) {
      await this.store.writeState({
        ...complete,
        error: `Bài đã hoàn tất nhưng Library cần đồng bộ lại: ${(error as Error).message}`,
      });
    }
  }

  private async runRole<T>(
    id: string,
    baseState: RunState,
    role: AgentRole,
    kind: string,
    prompt: string,
    validate: (raw: unknown) => T,
    signal: AbortSignal,
  ): Promise<T> {
    if (this.mock) return validate(mockArtifact(kind));
    const inputHash = sha256(prompt);
    const jobKey = logicalJobKey(kind, role, inputHash);
    let record = await this.store.readJobRecord(id, jobKey) ?? createJobRecord(jobKey, inputHash, kind, role);
    let lastError = record.attempts.at(-1)?.error ?? '';

    // A result may have been written just before a process/app restart. Validate
    // it before launching anything else, then settle the logical job once.
    for (const prior of [...record.attempts].reverse()) {
      const envelope = await this.store.readResult(prior.resultPath);
      if (!envelope || envelope.exitCode !== 0 || envelope.timedOut) continue;
      try {
        const value = validate(extractJson(envelope.stdout));
        record = settleRecord(record, sha256(envelope.stdout));
        await this.store.writeJobRecord(id, record);
        return value;
      } catch (error) {
        lastError = (error as Error).message;
      }
    }

    const initialState = await this.store.readState(id);
    const waveMaxAttempts = initialState.manualRetryRequested ? record.attempts.length + 3 : 3;
    let attempt = record.attempts.length + 1;
    while (attempt <= waveMaxAttempts) {
      if (signal.aborted) throw abortError();
      const state = await this.store.readState(id);
      const profile = state.config.agentProfiles.find((item) => item.role === role);
      if (!profile) throw new Error(`no configured profile for ${role}`);
      const adapter: AgentAdapter = profile.adapter;

      const previous = record.attempts.at(-1);
      if (previous && !previous.finishedAt && state.currentJob?.jobKey === jobKey && await this.terminal.isRoleRunning?.(baseState.tmuxSession, role)) {
        try {
          const existing = await this.waitResult(id, previous.resultPath, state.config.timeoutMinutes * 60_000, Math.max(120_000, Math.floor(state.config.timeoutMinutes * 30_000)), previous.heartbeatPath, signal);
          if (existing.exitCode === 0 && !existing.timedOut) {
            const value = validate(extractJson(existing.stdout));
            record = settleRecord(record, sha256(existing.stdout));
            await this.store.writeJobRecord(id, record);
            return value;
          }
        } catch (error) {
          lastError = (error as Error).message;
        }
      }

      const jobId = `${Date.now().toString(36)}-${kind}-a${attempt}`;
      const resultPath = this.store.path(id, 'jobs', `${jobId}.result.json`);
      const logPath = this.store.path(id, 'logs', `${jobId}.log`);
      const heartbeatPath = this.store.path(id, 'jobs', `${jobId}.heartbeat.json`);
      const timeoutMs = state.config.timeoutMinutes * 60_000;
      const stallTimeoutMs = Math.min(timeoutMs, Math.max(120_000, Math.floor(timeoutMs / 2)));
      const job: JobDescriptor = {
        schemaVersion: SCHEMA_VERSION,
        id: jobId,
        runId: id,
        kind,
        role,
        adapter,
        profile,
        cwd: this.store.runDir(id),
        promptPath: '',
        resultPath,
        logPath,
        heartbeatPath,
        jobKey,
        inputHash,
        timeoutMs,
        stallTimeoutMs,
      };
      const repair = lastError ? [
        prompt,
        '',
        'Your previous attempt could not be accepted:',
        lastError,
        'Return a corrected JSON object only. Do not discuss the error.',
      ].join('\n') : prompt;
      const files = await this.store.writeJob(id, job, repair);
      record = appendAttempt(record, {
        id: jobId,
        attempt,
        descriptorPath: files.descriptorPath,
        resultPath,
        logPath,
        heartbeatPath,
        startedAt: new Date().toISOString(),
      });
      await this.store.writeJobRecord(id, record);
      await this.store.writeState({
        ...state,
        manualRetryRequested: false,
        recoveryStatus: 'none',
        currentJob: {
          id: jobId,
          jobKey,
          kind,
          role,
          adapter,
          attempt,
          startedAt: new Date().toISOString(),
          logPath,
          heartbeatPath,
          status: attempt === 1 ? 'launching' : 'retrying',
        },
      });
      await this.store.appendProcessEvent(id, {
        event: 'agent.attempt.started',
        stage: state.stage,
        round: state.round,
        jobId,
        jobKey,
        attempt,
        role,
        kind,
        adapter,
        executable: profile.executable,
        model: profile.model || 'provider-default',
        prompt: `jobs/${jobId}.prompt.md`,
        result: `jobs/${jobId}.result.json`,
        log: `logs/${jobId}.log`,
      });
      await this.terminal.runJob(baseState.tmuxSession, role, this.store.runDir(id), files.descriptorPath);
      let envelope: JobResultEnvelope | null = null;
      try {
        envelope = await this.waitResult(id, resultPath, timeoutMs + 10_000, stallTimeoutMs, heartbeatPath, signal);
        if (envelope.exitCode !== 0 || envelope.timedOut) {
          throw new Error(`${adapter} exited ${envelope.exitCode}${envelope.timedOut ? ' after timeout' : ''}: ${(envelope.error || envelope.stderr).slice(-1200)}`);
        }
        const value = validate(extractJson(envelope.stdout));
        record = settleRecord(record, sha256(envelope.stdout));
        await this.store.writeJobRecord(id, record);
        await this.store.appendProcessEvent(id, {
          event: 'agent.attempt.succeeded',
          stage: state.stage,
          round: state.round,
          jobId,
          jobKey,
          attempt,
          role,
          kind,
          adapter,
          executable: profile.executable,
          model: profile.model || 'provider-default',
          exitCode: envelope.exitCode,
          outputBytes: Buffer.byteLength(envelope.stdout),
          durationMs: Date.parse(envelope.finishedAt) - Date.parse(envelope.startedAt),
          result: `jobs/${jobId}.result.json`,
          log: `logs/${jobId}.log`,
        });
        return value;
      } catch (error) {
        lastError = (error as Error).message;
        const retryClass = classifyFailure(error);
        record = finishAttempt(record, jobId, retryClass, lastError);
        await this.store.writeJobRecord(id, record);
        await this.store.appendProcessEvent(id, {
          event: 'agent.attempt.failed',
          stage: state.stage,
          round: state.round,
          jobId,
          jobKey,
          attempt,
          role,
          kind,
          adapter,
          executable: profile.executable,
          model: profile.model || 'provider-default',
          retryClass,
          error: lastError,
          exitCode: envelope?.exitCode ?? null,
          timedOut: envelope?.timedOut ?? false,
          willRetry: retryClass !== 'permanent' && retryClass !== 'cancelled' && attempt < waveMaxAttempts,
          result: `jobs/${jobId}.result.json`,
          log: `logs/${jobId}.log`,
        });
        if (retryClass === 'cancelled') throw error;
        if (retryClass === 'permanent') throw new Error(`${kind} requires user action: ${lastError}`);
        if (attempt < waveMaxAttempts) {
          const retryDelay = attempt === 1 ? 1_000 : attempt === 2 ? 3_000 : 10_000;
          const latest = await this.store.readState(id);
          await this.store.writeState({
            ...latest,
            currentJob: latest.currentJob ? {
              ...latest.currentJob,
              status: 'retrying',
              retryAt: new Date(Date.now() + retryDelay).toISOString(),
            } : undefined,
            error: `Attempt ${attempt} failed (${retryClass}); retrying safely.`,
          });
          await sleep(retryDelay);
        }
      }
      attempt += 1;
    }
    throw new Error(`${kind} failed after ${record.attempts.length} durable attempts: ${lastError}`);
  }

  private async waitResult(id: string, path: string, timeoutMs: number, stallTimeoutMs: number, heartbeatPath: string, signal: AbortSignal): Promise<JobResultEnvelope> {
    const end = Date.now() + timeoutMs;
    let lastStateUpdate = 0;
    while (Date.now() < end) {
      if (signal.aborted) throw abortError();
      try { return JSON.parse(await readFile(path, 'utf8')) as JobResultEnvelope; }
      catch {
        const heartbeat = await readHeartbeat(heartbeatPath);
        if (heartbeat) {
          const lastOutput = Date.parse(heartbeat.lastOutputAt);
          if (Number.isFinite(lastOutput) && Date.now() - lastOutput > stallTimeoutMs) {
            throw new Error(`job stalled with no output for ${Math.round(stallTimeoutMs / 1000)} seconds`);
          }
          if (Date.now() - lastStateUpdate > 2_000) {
            const state = await this.store.readState(id);
            if (state.currentJob) {
              await this.store.writeState({
                ...state,
                currentJob: {
                  ...state.currentJob,
                  status: 'running',
                  lastHeartbeatAt: heartbeat.updatedAt,
                  lastOutputAt: heartbeat.lastOutputAt,
                },
              });
            }
            lastStateUpdate = Date.now();
          }
        }
        await sleep(500);
      }
    }
    throw new Error(`job result timeout: ${path}`);
  }

  private async requireArtifact<T>(id: string, name: string): Promise<T> {
    const value = await this.store.readArtifact<T>(id, name);
    if (!value) throw new Error(`missing artifact: ${name}`);
    return value;
  }
}
