import { useState } from 'preact/hooks';
import {
  api,
  DEFAULT_AGENT_OPTIONS,
  type DefaultAgentId,
  type FormulaDiscoveryStatus,
  type FormulaSummary,
  type SpyVideoRow,
  type TrainingPreflightBlocker,
} from '../../api.ts';
import { href } from '../../router.ts';
import { useFormulaDiscoveryPoll } from '../../hooks.ts';
import { termSubmitLineWithAutoRetry } from '../../components/terminal/terminalApi.ts';
import { terminals } from '../../components/terminal/terminalStore.ts';

type Phase = 'idle' | 'preflighting' | 'blocked' | 'running' | 'done' | 'failed';

/** Human-readable mapping for the grounding-validator / agent-turn error codes
 * `LaneScheduler`/`training-core` can produce (SDD §5.2 commit-rule branches).
 * Falls back to the raw code for anything not explicitly listed. */
export function describeErrorCode(code: string | undefined, reason?: string | null): string {
  let base: string;
  switch (code) {
    case 'AGENT_EXIT':
      base = 'AGENT_EXIT — agent thoát bất thường trước khi ghi kết quả';
      break;
    case 'AGENT_NO_OUTPUT':
      base = 'AGENT_NO_OUTPUT — agent không ghi ra kết quả nào';
      break;
    case 'AGENT_SCHEMA':
      base = 'AGENT_SCHEMA — kết quả agent trả về sai định dạng mong đợi';
      break;
    case 'DRAFT_LENGTH':
      base = 'DRAFT_LENGTH — độ dài script không nằm trong khoảng cho phép (nén ~25-45% so với video gốc)';
      break;
    case 'AGENT_UNGROUNDED':
      base = 'AGENT_UNGROUNDED — agent trích dẫn không có trong transcript';
      break;
    case 'AGENT_INCOMPLETE':
      base = 'AGENT_INCOMPLETE — Formula thiếu payoff có bằng chứng';
      break;
    case 'AGENT_SANDBOX_VIOLATION':
      base = 'AGENT_SANDBOX_VIOLATION — agent cố truy cập ngoài phạm vi cho phép';
      break;
    default:
      base = code ? `Lỗi: ${code}` : 'Lỗi không xác định';
  }
  if (reason?.trim()) return `${base}\n${reason.trim()}`;
  return base;
}

export function FormulaDiscoveryAction({ video }: { video: SpyVideoRow }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [blockers, setBlockers] = useState<TrainingPreflightBlocker[]>([]);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [formula, setFormula] = useState<FormulaSummary | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setPhase('idle');
    setBlockers([]);
    setBatchId(null);
    setFormula(null);
    setErrorCode(null);
    setError(null);
  };

  const onDone = async (status: FormulaDiscoveryStatus) => {
    if (status.status === 'COMMITTED') {
      try {
        const { formulas } = await api.listFormulas();
        const matches = formulas
          .filter((f) => f.sourceBatchId === batchId)
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        setFormula(matches[0] ?? null);
        setPhase('done');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPhase('failed');
      }
      return;
    }
    setErrorCode(status.errorCode ?? status.status ?? 'UNKNOWN');
    setPhase('failed');
  };

  useFormulaDiscoveryPoll(
    phase === 'running' ? batchId : null,
    phase === 'running' ? video.id : null,
    (status) => void onDone(status),
  );

  const start = async () => {
    setError(null);
    setPhase('preflighting');
    try {
      const preflight = await api.trainingPreflight(video.id);
      if (!preflight.ready) {
        setBlockers(preflight.blockers);
        setPhase('blocked');
        return;
      }
      const dispatch = await api.startFormulaDiscovery(video.id);
      setBatchId(dispatch.batchId);
      if (dispatch.status === 'BLOCKED') {
        setBlockers(dispatch.blockers ?? []);
        setPhase('blocked');
      } else if (dispatch.status === 'FAILED') {
        setErrorCode(dispatch.reason ?? 'FAILED');
        setPhase('failed');
      } else {
        // DISPATCHED or WAITING_LANE — either way, start polling ledger status.
        setPhase('running');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('failed');
    }
  };

  const disabledReason = video.transcriptStatus !== 'ok'
    ? 'Video chưa có transcript — lấy transcript trước khi tìm Formula'
    : undefined;

  if (phase === 'idle') {
    return (
      <button
        class="btn secondary"
        type="button"
        disabled={!!disabledReason}
        title={disabledReason}
        onClick={() => void start()}
      >
        🧪 Tìm Formula
      </button>
    );
  }

  if (phase === 'preflighting') {
    return <span class="chip">🧪 Đang kiểm tra…</span>;
  }

  if (phase === 'blocked') {
    return (
      <div class="stack" style={{ gap: '0.35rem' }}>
        <span class="chip warn">🧪 Không thể chạy</span>
        {blockers.map((b) => (
          <p key={b.code} class="error" style={{ margin: 0, fontSize: '0.82rem' }}>{b.message}</p>
        ))}
        <button class="btn secondary" type="button" onClick={reset}>Thử lại</button>
      </div>
    );
  }

  if (phase === 'running') {
    return <span class="chip warn">🧪 Đang phân tích…</span>;
  }

  if (phase === 'done') {
    return (
      <div class="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
        <span class="chip ok">🧪 Đã có Formula</span>
        {formula ? (
          <a class="btn teal" href={href({ name: 'training-formula', id: formula.id })}>
            Xem Formula →
          </a>
        ) : (
          <span class="muted" style={{ fontSize: '0.82rem' }}>
            Không tìm thấy Formula vừa tạo — xem danh sách Formula.
          </span>
        )}
      </div>
    );
  }

  // phase === 'failed'
  return (
    <div class="stack" style={{ gap: '0.35rem' }}>
      <p class="error" style={{ margin: 0, fontSize: '0.82rem' }}>
        {error || describeErrorCode(errorCode ?? undefined)}
      </p>
      <button class="btn secondary" type="button" onClick={reset}>Thử lại</button>
    </div>
  );
}

type InteractivePhase = 'idle' | 'starting' | 'started' | 'blocked' | 'failed';

/**
 * Semi-auto "PTY tương tác" path (2026-08-10, user: "tự mở agent terminal, gửi
 * message, đợi session xong thì tôi sẽ tự tạo và import kết quả" — modeled on their
 * own dna-spy pattern). Unlike `FormulaDiscoveryAction` above, this does NOT poll
 * for completion and does NOT auto-create the Formula — it opens a REAL interactive
 * terminal (no `-p` one-shot flag, never auto-exits) pre-seeded with `prompt.md` +
 * `input/envelope.json` in its cwd, and a placeholder `DRAFT` Formula appears in the
 * Formula tab immediately. The user drives the session by hand, then goes to that
 * Formula's page and clicks "Import kết quả" (`ImportFormulaResultAction`,
 * `Training.tsx`) once it has written `out/result.json`.
 */
export function InteractiveFormulaDiscoveryAction({ video }: { video: SpyVideoRow }) {
  const [phase, setPhase] = useState<InteractivePhase>('idle');
  const [templateId, setTemplateId] = useState<DefaultAgentId>('grok');
  const [blockers, setBlockers] = useState<TrainingPreflightBlocker[]>([]);
  const [formulaId, setFormulaId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setError(null);
    setPhase('starting');
    try {
      const result = await api.startInteractiveFormulaDiscovery(video.id, templateId);
      if (result.status === 'BLOCKED') {
        setBlockers(result.blockers ?? []);
        setPhase('blocked');
        return;
      }
      if (result.status !== 'STARTED' || !result.launchSpec || !result.formulaId) {
        setError(result.reason ?? 'Không khởi động được phiên tương tác');
        setPhase('failed');
        return;
      }
      const spec = result.launchSpec;
      const sessionId = await terminals.launchTab({
        executable: spec.executable,
        args: spec.args,
        cwd: spec.cwd,
        env: spec.env ?? {},
        agentId: templateId,
        title: `Tìm Formula (${templateId}) — ${video.title}`,
        readOnly: false,
      });
      if (result.initialMessage) {
        // The CLI's TUI needs a moment to finish booting before it will accept
        // typed input — same precedent as the interactive-launch bugs found earlier
        // today, verified by hand: sending too early is silently swallowed.
        const message = result.initialMessage;
        setTimeout(() => {
          void termSubmitLineWithAutoRetry(sessionId, message, {
            onAutoRetry: () => console.info('[formula-discovery] retried Enter after quiet PTY window'),
            onRetryError: (err) => console.warn('[formula-discovery] quiet-window Enter retry failed', err),
          }).catch((err) => {
            setError(err instanceof Error ? err.message : 'Không gửi được nhiệm vụ vào PTY');
            setPhase('failed');
          });
        }, 1200);
      }
      setFormulaId(result.formulaId);
      setPhase('started');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('failed');
    }
  };

  const disabledReason = video.transcriptStatus !== 'ok'
    ? 'Video chưa có transcript — lấy transcript trước khi tìm Formula'
    : undefined;

  if (phase === 'idle') {
    return (
      <div class="row" style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          value={templateId}
          onChange={(e) => setTemplateId((e.target as HTMLSelectElement).value as DefaultAgentId)}
        >
          {DEFAULT_AGENT_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
        <button
          class="btn secondary"
          type="button"
          disabled={!!disabledReason}
          title={disabledReason}
          onClick={() => void start()}
        >
          🧪 Tìm Formula (PTY tương tác)
        </button>
      </div>
    );
  }

  if (phase === 'starting') {
    return <span class="chip warn">🧪 Đang mở phiên…</span>;
  }

  if (phase === 'blocked') {
    return (
      <div class="stack" style={{ gap: '0.35rem' }}>
        <span class="chip warn">🧪 Không thể chạy</span>
        {blockers.map((b) => (
          <p key={b.code} class="error" style={{ margin: 0, fontSize: '0.82rem' }}>{b.message}</p>
        ))}
        <button class="btn secondary" type="button" onClick={() => setPhase('idle')}>Thử lại</button>
      </div>
    );
  }

  if (phase === 'started' && formulaId) {
    return (
      <div class="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
        <span class="chip ok">🧪 Phiên đã mở</span>
        <a class="btn teal" href={href({ name: 'training-formula', id: formulaId })}>
          Xem Formula (chờ import) →
        </a>
      </div>
    );
  }

  // phase === 'failed'
  return (
    <div class="stack" style={{ gap: '0.35rem' }}>
      <p class="error" style={{ margin: 0, fontSize: '0.82rem' }}>{error}</p>
      <button class="btn secondary" type="button" onClick={() => setPhase('idle')}>Thử lại</button>
    </div>
  );
}
