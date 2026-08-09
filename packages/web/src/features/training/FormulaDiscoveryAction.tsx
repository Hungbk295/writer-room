import { useState } from 'preact/hooks';
import {
  api,
  type FormulaDiscoveryStatus,
  type FormulaSummary,
  type SpyVideoRow,
  type TrainingPreflightBlocker,
} from '../../api.ts';
import { href } from '../../router.ts';
import { useFormulaDiscoveryPoll } from '../../hooks.ts';

type Phase = 'idle' | 'preflighting' | 'blocked' | 'running' | 'done' | 'failed';

/** Human-readable mapping for the grounding-validator / agent-turn error codes
 * `LaneScheduler`/`training-core` can produce (SDD §5.2 commit-rule branches).
 * Falls back to the raw code for anything not explicitly listed. */
function describeErrorCode(code: string | undefined): string {
  switch (code) {
    case 'AGENT_EXIT':
      return 'AGENT_EXIT — agent thoát bất thường trước khi ghi kết quả';
    case 'AGENT_NO_OUTPUT':
      return 'AGENT_NO_OUTPUT — agent không ghi ra kết quả nào';
    case 'AGENT_SCHEMA':
      return 'AGENT_SCHEMA — kết quả agent trả về sai định dạng mong đợi';
    case 'AGENT_UNGROUNDED':
      return 'AGENT_UNGROUNDED — agent trích dẫn không có trong transcript';
    case 'AGENT_SANDBOX_VIOLATION':
      return 'AGENT_SANDBOX_VIOLATION — agent cố truy cập ngoài phạm vi cho phép';
    default:
      return code ? `Lỗi: ${code}` : 'Lỗi không xác định';
  }
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
