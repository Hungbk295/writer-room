/**
 * /spy/loop — Spy Auto-Loop dashboard
 *
 * Component tree:
 *   SpyLoopPage
 *     TopicSwitcher
 *     LoopKpiRow + TickActions + DryRunPlanModal
 *     tabs: InboxTab | KeywordBoardTab | StudiedTab | ReportsTab
 *   LoopSettingsPanel (bottom of page)
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  api,
  type InboxItem,
  type Keyword,
  type KeywordStatus,
  type LoopStatus,
  type StoredReport,
  type ReportSummaryJson,
  type SpyLoopSettings,
  type TickPlan,
  type Topic,
} from '../api.ts';
import { href } from '../router.ts';
import { CustomSelect, Field, Input } from '../components/ui/Forms.tsx';
import { Stack, Row, Panel } from '../components/ui/Layout.tsx';
import { Chip } from '../components/ui/Chip.tsx';

// ─── dev mock flag ────────────────────────────────────────────────────────────
// Query params are embedded in the hash (#/spy/loop?mock=1), not location.search
function hashQuery(): URLSearchParams {
  if (typeof location === 'undefined') return new URLSearchParams();
  const hash = location.hash.replace(/^#\/?[^?]*/, '');
  return new URLSearchParams(hash);
}
const IS_MOCK = hashQuery().has('mock');

// ─── helpers ──────────────────────────────────────────────────────────────────
function fmtSub(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}
function fmtViews(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
}
function relDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return 'vừa xong';
  if (h < 24) return `${h} giờ trước`;
  return `${Math.floor(h / 24)} ngày trước`;
}

function tickStatusChip(status: string) {
  const v = status === 'done' ? 'default' :
            status === 'running' ? 'writer' :
            status === 'failed' ? 'bad' : 'warn';
  return <Chip variant={v}>{status}</Chip>;
}

// ─── TopicSwitcher ────────────────────────────────────────────────────────────
function TopicSwitcher({ topics, current, onChange }: { topics: Topic[]; current: string; onChange: (id: string) => void }) {
  const options = topics.map((t) => ({ value: t.topicId, label: t.label, description: t.status !== 'active' ? t.status : undefined }));
  return (
    <Row style={{ gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '1rem' }}>
      <span class="muted" style={{ fontSize: '0.85rem' }}>Chủ đề:</span>
      <CustomSelect<string>
        value={current}
        onChange={(val) => {
          onChange(val);
          // Sync URL
          const u = new URL(location.href);
          u.searchParams.set('topic', val);
          // For hash router we embed query in hash
          location.hash = href({ name: 'spy-loop', topic: val }).replace(/^#/, '');
        }}
        options={options}
        placeholder="Chọn chủ đề…"
      />
    </Row>
  );
}

// ─── LoopKpiRow ───────────────────────────────────────────────────────────────
function LoopKpiRow({ status }: { status: LoopStatus | null }) {
  if (!status) return <p class="muted">Đang tải KPI…</p>;
  const q = status.quota;
  return (
    <div class="kv-grid" style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem 2rem', marginBottom: '1rem' }}>
      {q && <>
        <div><span class="muted">Search quota</span><strong> {q.searchUsed}/{q.searchBudget}</strong> <span class="muted">(còn {q.searchRemainingDay} hôm nay)</span></div>
        <div><span class="muted">Unit quota</span><strong> {q.generalUsed.toLocaleString()}/{q.generalLimit.toLocaleString()}</strong></div>
      </>}
      <div><span class="muted">New</span> <strong>{status.inboxTotal}</strong></div>
      <div><span class="muted">Shortlisted</span> <strong>{status.shortlistedTotal}</strong></div>
      <div><span class="muted">Studied</span> <strong>{status.studiedTotal}</strong></div>
      <div><span class="muted">Keyword pending</span> <strong>{status.keywordsPending}</strong></div>
      {status.lastTick && (
        <div>
          <span class="muted">Tick cuối</span>{' '}
          {tickStatusChip(status.lastTick.status)}{' '}
          <span class="muted">{relDate(status.lastTick.startedAt)}</span>
          {status.lastTick.error && <span class="error" title={status.lastTick.error}> ⚠</span>}
        </div>
      )}
      {status.nextTickAt && (
        <div><span class="muted">Tick tiếp theo</span> <strong>{fmtDate(status.nextTickAt)}</strong></div>
      )}
    </div>
  );
}

// ─── DryRunPlanModal ──────────────────────────────────────────────────────────
function DryRunPlanModal({ plan, onClose }: { plan: TickPlan; onClose: () => void }) {
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div class="panel stack" style={{ maxWidth: '38rem', width: '90vw', maxHeight: '80vh', overflow: 'auto' }}>
        <h2 style={{ marginBottom: '0.5rem' }}>Kế hoạch Tick (dry-run)</h2>
        <p class="muted">Ước tính — chưa gọi API thật.</p>
        {plan.warnings.length > 0 && (
          <ul class="error">{plan.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        )}
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Bước</th>
              <th style={{ textAlign: 'right', padding: '4px 8px' }}>Search</th>
              <th style={{ textAlign: 'right', padding: '4px 8px' }}>Unit</th>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Ghi chú</th>
            </tr>
          </thead>
          <tbody>
            {plan.steps.map((s) => (
              <tr key={s.step} style={{ borderTop: '1px solid var(--border, #333)' }}>
                <td style={{ padding: '4px 8px' }}>{s.step}</td>
                <td style={{ textAlign: 'right', padding: '4px 8px' }}>{s.estimatedSearchCalls}</td>
                <td style={{ textAlign: 'right', padding: '4px 8px' }}>{s.estimatedGeneralUnits}</td>
                <td style={{ padding: '4px 8px' }} class="muted">{s.note}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid var(--border, #333)', fontWeight: 600 }}>
              <td style={{ padding: '4px 8px' }}>Tổng</td>
              <td style={{ textAlign: 'right', padding: '4px 8px' }}>{plan.totalSearchCalls}</td>
              <td style={{ textAlign: 'right', padding: '4px 8px' }}>{plan.totalGeneralUnits}</td>
              <td />
            </tr>
          </tfoot>
        </table>
        <Row style={{ gap: '0.5rem', marginTop: '1rem' }}>
          <button class="btn secondary" onClick={onClose}>Đóng</button>
        </Row>
      </div>
    </div>
  );
}

// ─── TickActions ──────────────────────────────────────────────────────────────
function TickActions({ topicId, onDone }: { topicId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dryPlan, setDryPlan] = useState<TickPlan | null>(null);

  const runDry = async () => {
    setError(null);
    setBusy(true);
    try {
      if (IS_MOCK) {
        const { MOCK_REPORT_SUMMARY: ms } = await import('../features/spy-loop/mock.ts');
        const fake: TickPlan = {
          topicId,
          quotaDay: '2026-08-20',
          dryRun: true,
          steps: [
            { step: 'EXPAND', estimatedSearchCalls: 0, estimatedGeneralUnits: 4, keywords: [], note: '2 kênh shortlisted chưa expand' },
            { step: 'SEARCH', estimatedSearchCalls: 3, estimatedGeneralUnits: 0, keywords: ms.newKeywords, note: 'keyword pending có df_chan ≥ 2' },
            { step: 'ENRICH', estimatedSearchCalls: 0, estimatedGeneralUnits: 82, keywords: [], note: '41 kênh mới × 2 unit' },
            { step: 'AUTO-TRIAGE', estimatedSearchCalls: 0, estimatedGeneralUnits: 0, keywords: [], note: 'fit + learn gates (faceless hint KHÔNG auto-reject)' },
            { step: 'REPORT', estimatedSearchCalls: 0, estimatedGeneralUnits: 0, keywords: [], note: 'tạo daily_reports + Telegram' },
          ],
          totalSearchCalls: 3,
          totalGeneralUnits: 86,
          canProceed: true,
          warnings: ['Telegram chưa cấu hình — báo cáo chỉ lưu DB'],
        };
        setDryPlan(fake);
      } else {
        const result = await api.loopTick({ topicId, dryRun: true });
        if ('steps' in result) setDryPlan(result as TickPlan);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const runReal = async () => {
    if (!confirm('Chạy tick thật sẽ tiêu quota YouTube Data API. Tiếp tục?')) return;
    setError(null);
    setBusy(true);
    try {
      if (IS_MOCK) {
        await new Promise((r) => setTimeout(r, 800));
      } else {
        await api.loopTick({ topicId, dryRun: false });
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Row style={{ gap: '0.5rem', marginBottom: '0.5rem' }}>
        <button class="btn secondary" disabled={busy} onClick={() => void runDry()}>
          {busy ? '…' : 'Dry-run'}
        </button>
        <button class="btn teal" disabled={busy} onClick={() => void runReal()}>
          {busy ? 'Đang chạy…' : 'Chạy tick ngay'}
        </button>
      </Row>
      {error && <p class="error">{error}</p>}
      {dryPlan && <DryRunPlanModal plan={dryPlan} onClose={() => setDryPlan(null)} />}
    </div>
  );
}

// ─── FacelessBadge ────────────────────────────────────────────────────────────
/**
 * Ba trạng thái, và chỉ một trong ba được đọc như KẾT LUẬN:
 *
 *   1. `facelessScore` có giá trị → verdict thật từ agent vision → badge đặc.
 *      Ở P0 trường này luôn null, nên nhánh này chưa bao giờ chạy.
 *   2. Chỉ có `facelessHint` → badge nét đứt, mờ, luôn kèm chữ "đoán từ chữ".
 *      Đây là suy đoán từ title/description; sai lệch cao (design §3).
 *   3. Không có gì → "chưa xác định". KHÔNG bịa ra một con số.
 */
function FacelessBadge({
  score,
  signals,
  hint,
  hintReasons,
}: {
  score: number | null;
  signals: string[];
  hint: number | null;
  hintReasons: string[];
}) {
  if (score != null) {
    const variant = score >= 0.75 ? 'default' : score <= 0.35 ? 'bad' : 'warn';
    const label = score >= 0.75 ? 'faceless' : score <= 0.35 ? 'có mặt' : 'mixed';
    const title = signals.length > 0
      ? `Kết luận vision — ${signals.join(' · ')}`
      : 'Kết luận vision';
    return <Chip variant={variant} title={title}>{label} {(score * 100).toFixed(0)}%</Chip>;
  }

  if (hint != null) {
    const title = hintReasons.length > 0
      ? `PHỎNG ĐOÁN từ văn bản, chưa có kết luận vision:\n· ${hintReasons.join('\n· ')}`
      : 'PHỎNG ĐOÁN từ văn bản, chưa có kết luận vision';
    return (
      <span
        class="chip"
        title={title}
        style={{
          border: '1px dashed var(--border, #555)',
          background: 'transparent',
          opacity: 0.75,
          fontStyle: 'italic',
        }}
      >
        faceless? {(hint * 100).toFixed(0)}% (đoán từ chữ)
      </span>
    );
  }

  return (
    <span class="chip muted" title="Chưa có tín hiệu văn bản và chưa có vòng vision" style={{ opacity: 0.6 }}>
      chưa xác định
    </span>
  );
}

// ─── ThumbGrid ────────────────────────────────────────────────────────────────
function ThumbGrid({ urls }: { urls: string[] }) {
  const shown = urls.slice(0, 6);
  if (shown.length === 0) {
    return (
      <div
        class="muted"
        style={{
          width: 168, height: 94, flexShrink: 0, borderRadius: 2,
          border: '1px dashed var(--border, #444)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem', textAlign: 'center',
        }}
      >
        chưa có thumbnail
      </div>
    );
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 2, width: 168, flexShrink: 0 }}>
      {shown.map((url, i) => (
        <img key={i} src={url} alt="" loading="lazy"
          style={{ width: '100%', aspectRatio: '16/9', objectFit: 'cover', borderRadius: 2 }}
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
      ))}
    </div>
  );
}

// ─── InboxRow ─────────────────────────────────────────────────────────────────
function InboxRow({
  item,
  selected,
  onSelect,
  onDecide,
}: {
  item: InboxItem;
  selected: boolean;
  onSelect: () => void;
  onDecide: (status: 'shortlisted' | 'rejected', neg?: string) => void;
}) {
  const [showReasons, setShowReasons] = useState(false);

  const handleRejectNeg = () => {
    const kw = prompt('Thêm negative keyword (bỏ trống để bỏ qua):', item.foundVia.term ?? '');
    onDecide('rejected', kw ?? undefined);
  };

  return (
    <div
      class={`spy-run-card ${selected ? 'inbox-row-selected' : ''}`}
      style={{ cursor: 'pointer', outline: selected ? '2px solid var(--teal, #0d9488)' : 'none' }}
      onClick={onSelect}
    >
      <div class="spy-run-card-summary" style={{ alignItems: 'flex-start', gap: '0.75rem' }}>
        <ThumbGrid urls={item.thumbnails} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>
            <a href={item.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
              {item.title}
            </a>
            {item.handle && <span class="muted"> {item.handle}</span>}
          </div>
          <div class="meta" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 8px', marginBottom: 4 }}>
            <span>{fmtSub(item.subscriberCount)} sub</span>
            <span>median {fmtViews(item.medianViews)} view{item.medianViewsVsOwn != null ? ` (×${item.medianViewsVsOwn.toFixed(1)} own)` : ''}</span>
            <FacelessBadge
              score={item.facelessScore}
              signals={item.facelessSignals}
              hint={item.facelessHint}
              hintReasons={item.facelessHintReasons}
            />
            <Chip>fit {item.fitScore}</Chip>
            <Chip variant="other">learn {item.learnValueScore}</Chip>
            {item.foundVia.term && <span class="muted">via «{item.foundVia.term}»</span>}
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--muted, #888)', marginBottom: 4 }}>
            <button class="btn secondary" style={{ fontSize: '0.75rem', padding: '2px 6px' }}
              onClick={(e) => { e.stopPropagation(); setShowReasons((v) => !v); }}>
              {showReasons ? 'Thu gọn lý do' : 'Xem lý do fit'}
            </button>
            {showReasons && (
              <ul style={{ marginTop: 4, paddingLeft: '1rem' }}>
                {item.fitReasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            )}
          </div>
          <Row style={{ gap: '0.4rem' }} onClick={(e) => e.stopPropagation()}>
            <button class="btn teal" style={{ fontSize: '0.8rem', padding: '3px 10px' }}
              onClick={() => onDecide('shortlisted')}>S Shortlist</button>
            <button class="btn secondary" style={{ fontSize: '0.8rem', padding: '3px 10px' }}
              onClick={() => onDecide('rejected')}>R Reject</button>
            <button class="btn secondary" style={{ fontSize: '0.8rem', padding: '3px 10px' }}
              onClick={handleRejectNeg}>X Reject+neg</button>
          </Row>
        </div>
      </div>
    </div>
  );
}

// ─── InboxDetailPane ──────────────────────────────────────────────────────────
function InboxDetailPane({ item }: { item: InboxItem }) {
  return (
    <div class="panel stack video-inspector-pane" style={{ minWidth: 260, maxWidth: 340, position: 'sticky', top: '1rem' }}>
      <h3 style={{ marginBottom: '0.5rem' }}>{item.title}</h3>
      {item.handle && <p class="muted">{item.handle}</p>}
      <ul style={{ fontSize: '0.85rem', paddingLeft: '1rem' }}>
        <li><strong>Fit score:</strong> {item.fitScore ?? '—'}</li>
        <li><strong>Learn value:</strong> {item.learnValueScore ?? '—'}</li>
        <li><strong>Sub:</strong> {fmtSub(item.subscriberCount)}</li>
        <li><strong>Median views:</strong> {fmtViews(item.medianViews)}</li>
        <li><strong>Tìm qua:</strong> {item.foundVia.relation} {item.foundVia.term ? `«${item.foundVia.term}»` : ''}</li>
        <li><strong>Thấy lần đầu:</strong> {fmtDate(item.firstSeenAt)}</li>
        {item.decidedReason && (
          <li><strong>Loop tự quyết vì:</strong> <code>{item.decidedReason}</code></li>
        )}
      </ul>
      <div>
        <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: 4 }}>Lý do fit:</div>
        <ul style={{ fontSize: '0.8rem', paddingLeft: '1rem' }}>
          {item.fitReasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      </div>
      <div>
        <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: 4 }}>Learn value:</div>
        <ul style={{ fontSize: '0.8rem', paddingLeft: '1rem' }}>
          {item.learnValueReasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      </div>
      {/*
        Hai khối TÁCH BẠCH, cố ý không gộp: một bên là suy đoán từ chữ (có thể
        sai nhiều), một bên là kết luận thật. Gộp lại là cách nhanh nhất để
        người duyệt tưởng máy đã "biết" kênh này faceless (design §3).
      */}
      <div style={{ borderTop: '1px solid var(--border, #333)', paddingTop: '0.6rem' }}>
        <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: 4 }}>
          Tín hiệu văn bản <span class="muted" style={{ fontWeight: 400 }}>(đoán)</span>
        </div>
        {item.facelessHint == null ? (
          <p class="muted" style={{ fontSize: '0.8rem', margin: 0 }}>
            Không đủ tín hiệu văn bản để đoán.
          </p>
        ) : (
          <>
            <p style={{ fontSize: '0.8rem', margin: '0 0 4px', fontStyle: 'italic' }}>
              faceless? {(item.facelessHint * 100).toFixed(0)}% — phỏng đoán từ title/mô tả, KHÔNG phải kết luận.
            </p>
            {item.facelessHintReasons.length > 0 && (
              <ul style={{ fontSize: '0.8rem', paddingLeft: '1rem', margin: 0 }}>
                {item.facelessHintReasons.map((reason, i) => <li key={i}>{reason}</li>)}
              </ul>
            )}
          </>
        )}
      </div>

      <div style={{ borderTop: '1px solid var(--border, #333)', paddingTop: '0.6rem' }}>
        <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: 4 }}>Kết luận vision</div>
        {item.facelessScore == null ? (
          <p class="muted" style={{ fontSize: '0.8rem', margin: 0 }}>
            Chưa có — sẽ do agent chấm sau.
          </p>
        ) : (
          <>
            <p style={{ fontSize: '0.8rem', margin: '0 0 4px' }}>
              <strong>{(item.facelessScore * 100).toFixed(0)}%</strong> faceless
            </p>
            {item.facelessSignals.length > 0 && (
              <ul style={{ fontSize: '0.8rem', paddingLeft: '1rem', margin: 0 }}>
                {item.facelessSignals.map((sig, i) => <li key={i}>{sig}</li>)}
              </ul>
            )}
          </>
        )}
      </div>

      {(item.langDetected || item.langEvidence) && (
        <div style={{ borderTop: '1px solid var(--border, #333)', paddingTop: '0.6rem' }}>
          <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: 4 }}>Ngôn ngữ</div>
          {item.langDetected && (
            <p style={{ fontSize: '0.8rem', margin: '0 0 4px' }}>
              {item.langDetected}
              {item.langConfidence != null && (
                <span class="muted"> ({(item.langConfidence * 100).toFixed(0)}%)</span>
              )}
            </p>
          )}
          {item.langEvidence && (
            <p
              class={item.langEvidence.canJustifyRejection ? undefined : 'muted'}
              style={{
                fontSize: '0.8rem',
                margin: 0,
                // Chỉ bằng chứng khai báo mới được đọc như căn cứ loại kênh;
                // heuristic từ title in nghiêng, mờ, kèm chữ "không dùng để reject".
                fontStyle: item.langEvidence.canJustifyRejection ? 'normal' : 'italic',
              }}
            >
              {item.langEvidence.summary}
            </p>
          )}
        </div>
      )}
      <a class="btn secondary" href={item.url} target="_blank" rel="noopener noreferrer">
        Mở YouTube ↗
      </a>
    </div>
  );
}

// ─── ColdStartPanel (B5) ──────────────────────────────────────────────────────
/**
 * Hai đường gieo hạt TỰ LỰC (design §1.2). Dự án tồn tại để thay thế các
 * provider dữ liệu ngoài, nên ngay cả bước cold start cũng không được gọi họ.
 *   1. Dán kênh mình tự biết → resolve bằng channels.list (rẻ, có vào sổ quota).
 *   2. Nạp kênh đã spy sẵn trong corpus → 0 quota.
 */
function ColdStartPanel({ topicId, onChanged }: { topicId: string; onChanged: () => void }) {
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState<'manual' | 'corpus' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [notFound, setNotFound] = useState<string[]>([]);

  const lines = raw.split('\n').map((line) => line.trim()).filter((line) => line !== '');

  const submitManual = async () => {
    if (lines.length === 0) return;
    setBusy('manual');
    setError(null);
    setResult(null);
    setNotFound([]);
    try {
      const res = IS_MOCK
        ? { added: lines.length, skippedKnown: 0, notFound: [] as string[] }
        : await api.addManualCandidates(topicId, lines);
      setResult(`Đã thêm ${res.added} kênh · bỏ qua ${res.skippedKnown} kênh đã có`);
      setNotFound(res.notFound);
      if (res.added > 0) {
        setRaw('');
        onChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const submitCorpus = async () => {
    setBusy('corpus');
    setError(null);
    setResult(null);
    setNotFound([]);
    try {
      const res = IS_MOCK
        ? { added: 20, skippedKnown: 0 }
        : await api.importCorpus(topicId);
      setResult(`Đã nạp ${res.added} kênh từ corpus · bỏ qua ${res.skippedKnown} kênh đã có (0 quota)`);
      if (res.added > 0) onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel class="stack" style={{ marginBottom: '1rem' }}>
      <h3 style={{ fontSize: '0.9rem', marginBottom: 0 }}>Gieo hạt cho chủ đề</h3>
      <p class="muted" style={{ fontSize: '0.8rem', margin: 0 }}>
        Ngày đầu Inbox rỗng là bình thường — nạp kênh vào đây để có cái mà duyệt ngay,
        không cần chờ tick tốn search quota.
      </p>
      <Field label="Nhập kênh thủ công — mỗi dòng một kênh (URL, @handle hoặc UC-id)">
        <textarea
          class="input"
          rows={4}
          value={raw}
          placeholder={'https://www.youtube.com/@soitaichinh247\n@tienkhon\nUCxxxxxxxxxxxxxxxxxxxxxx'}
          onInput={(e) => setRaw((e.target as HTMLTextAreaElement).value)}
          style={{ width: '100%', fontFamily: 'inherit', resize: 'vertical' }}
        />
      </Field>
      <Row style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
        <button class="btn teal" disabled={busy !== null || lines.length === 0} onClick={() => void submitManual()}>
          {busy === 'manual' ? 'Đang resolve…' : `Nhập kênh thủ công${lines.length > 0 ? ` (${lines.length})` : ''}`}
        </button>
        <button class="btn secondary" disabled={busy !== null} onClick={() => void submitCorpus()}>
          {busy === 'corpus' ? 'Đang nạp…' : 'Nạp kênh đã spy (0 quota)'}
        </button>
      </Row>
      {result && <p style={{ fontSize: '0.85rem', margin: 0 }}>{result}</p>}
      {notFound.length > 0 && (
        <div class="error" style={{ fontSize: '0.8rem' }}>
          Không resolve được {notFound.length} dòng:
          <ul style={{ paddingLeft: '1rem', margin: '2px 0 0' }}>
            {notFound.map((line, i) => <li key={i}><code>{line}</code></li>)}
          </ul>
        </div>
      )}
      {error && <p class="error" style={{ fontSize: '0.85rem', margin: 0 }}>{error}</p>}
    </Panel>
  );
}

// ─── InboxTab ─────────────────────────────────────────────────────────────────
/** Một quyết định đã gửi đi, giữ lại để `u` hoàn tác. */
interface PastDecision {
  item: InboxItem;
  index: number;
  status: 'shortlisted' | 'rejected';
}

function InboxTab({ topicId }: { topicId: string }) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState<number>(0);
  // optimistic removal: channelId đã quyết định, ẩn khỏi danh sách
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  // Ngăn xếp undo — `u` lấy quyết định gần nhất.
  const [undoStack, setUndoStack] = useState<PastDecision[]>([]);

  const load = async () => {
    setLoading(true);
    try {
      if (IS_MOCK) {
        const { MOCK_INBOX_ITEMS } = await import('../features/spy-loop/mock.ts');
        setItems(MOCK_INBOX_ITEMS);
      } else {
        // Không truyền `sort`: mặc định của server đã là fit × learn_value,
        // và faceless hint chỉ được dùng để phá hoà (design §5.1).
        const data = await api.loopInbox({ topic: topicId, limit: 50 });
        setItems(data.items);
      }
      setRemoved(new Set());
      setUndoStack([]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [topicId]);

  const decide = async (
    item: InboxItem,
    status: 'shortlisted' | 'rejected',
    negativeKeyword?: string,
  ) => {
    const index = items.findIndex((row) => row.channelId === item.channelId);
    // Optimistic remove
    setRemoved((prev) => new Set([...prev, item.channelId]));
    setUndoStack((prev) => [...prev, { item, index, status }]);

    try {
      if (!IS_MOCK) {
        await api.loopDecide({ topicId, channelIds: [item.channelId], status, negativeKeyword });
      } else {
        await new Promise((r) => setTimeout(r, 200));
      }
    } catch (err) {
      // Rollback cả hai thay đổi lạc quan.
      setRemoved((prev) => {
        const next = new Set(prev);
        next.delete(item.channelId);
        return next;
      });
      setUndoStack((prev) => prev.filter((entry) => entry.item.channelId !== item.channelId));
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * B6 — hoàn tác quyết định gần nhất. Không cần endpoint mới: `decide` với
   * `status: 'new'` đưa kênh về lại hàng chờ duyệt, và dòng được chèn lại
   * đúng vị trí cũ.
   */
  const undoLast = async () => {
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    setUndoStack((prev) => prev.slice(0, -1));
    setRemoved((prev) => {
      const next = new Set(prev);
      next.delete(last.item.channelId);
      return next;
    });
    // Dòng đã bị lọc khỏi `items` chưa? Không — `items` giữ nguyên, chỉ `removed`
    // ẩn nó đi. Nhưng nếu load lại trong lúc đó thì phải chèn lại.
    setItems((prev) => {
      if (prev.some((row) => row.channelId === last.item.channelId)) return prev;
      const next = [...prev];
      next.splice(Math.min(last.index, next.length), 0, {
        ...last.item, status: 'new', decidedBy: null, decidedReason: null, decidedAt: null,
      });
      return next;
    });
    try {
      if (!IS_MOCK) {
        await api.loopDecide({ topicId, channelIds: [last.item.channelId], status: 'new' });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Phím tắt j/k/s/r/x/u/Enter — bỏ qua khi con trỏ đang ở ô nhập liệu
  useEffect(() => {
    const visible = items.filter((item) => !removed.has(item.channelId));
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === 'u') { void undoLast(); e.preventDefault(); return; }

      const cur = visible[selectedIdx];
      if (!cur) return;
      if (e.key === 'j') { setSelectedIdx((i) => Math.min(i + 1, visible.length - 1)); e.preventDefault(); }
      else if (e.key === 'k') { setSelectedIdx((i) => Math.max(i - 1, 0)); e.preventDefault(); }
      else if (e.key === 's') { void decide(cur, 'shortlisted'); e.preventDefault(); }
      else if (e.key === 'r') { void decide(cur, 'rejected'); e.preventDefault(); }
      else if (e.key === 'x') {
        const kw = prompt('Negative keyword:', cur.foundVia.term ?? '');
        void decide(cur, 'rejected', kw ?? undefined);
        e.preventDefault();
      } else if (e.key === 'Enter') { window.open(cur.url, '_blank', 'noopener'); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [items, selectedIdx, removed, undoStack]);

  const visible = items.filter((item) => !removed.has(item.channelId));
  const selectedItem = visible[selectedIdx] ?? null;

  return (
    <div>
      <ColdStartPanel topicId={topicId} onChanged={() => void load()} />

      {loading && <p class="muted">Đang tải Inbox…</p>}
      {error && <p class="error">{error}</p>}

      {!loading && visible.length === 0 && (
        <p class="muted">Inbox trống — không có kênh chờ duyệt. 🎉</p>
      )}

      {!loading && visible.length > 0 && (
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <Row style={{ gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <p class="muted" style={{ fontSize: '0.8rem', margin: 0 }}>
                {visible.length} kênh · sắp theo fit × learn_value · phím j/k di chuyển,
                s=shortlist, r=reject, x=reject+neg, u=hoàn tác, Enter=YouTube
              </p>
              {undoStack.length > 0 && (
                <button
                  class="btn secondary"
                  style={{ fontSize: '0.75rem', padding: '2px 8px' }}
                  onClick={() => void undoLast()}
                >
                  ↶ Hoàn tác ({undoStack.length})
                </button>
              )}
            </Row>
            {visible.map((item, idx) => (
              <InboxRow
                key={item.channelId}
                item={item}
                selected={idx === selectedIdx}
                onSelect={() => setSelectedIdx(idx)}
                onDecide={(status, neg) => void decide(item, status, neg)}
              />
            ))}
          </div>
          {selectedItem && <InboxDetailPane item={selectedItem} />}
        </div>
      )}
    </div>
  );
}

// ─── KeywordBoardTab ──────────────────────────────────────────────────────────
function KeywordBoardTab({ topicId }: { topicId: string }) {
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newTerm, setNewTerm] = useState('');
  const [addBusy, setAddBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      if (IS_MOCK) {
        const { MOCK_KEYWORDS } = await import('../features/spy-loop/mock.ts');
        setKeywords(MOCK_KEYWORDS);
      } else {
        const data = await api.loopKeywords(topicId);
        setKeywords(data.keywords);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [topicId]);

  const addKeyword = async () => {
    const term = newTerm.trim();
    if (!term) return;
    setAddBusy(true);
    try {
      if (IS_MOCK) {
        const kw: Keyword = { topicId, termKey: term.toLowerCase().replace(/\s+/g, '-'), displayTerm: term, relation: 'user', status: 'pending', yieldChannels: 0, lastSearchedAt: null, addedAt: new Date().toISOString(), addedBy: 'user' };
        setKeywords((prev) => [...prev, kw]);
      } else {
        const { keyword } = await api.addKeyword({ topicId, displayTerm: term });
        setKeywords((prev) => [...prev, keyword]);
      }
      setNewTerm('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddBusy(false);
    }
  };

  const rejectKeyword = async (termKey: string, negative: boolean) => {
    try {
      if (!IS_MOCK) {
        await api.decideKeywords({ topicId, termKeys: [termKey], status: 'rejected', negative });
      }
      setKeywords((prev) => prev.map((k) => k.termKey === termKey ? { ...k, status: 'rejected' } : k));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (loading) return <p class="muted">Đang tải keyword…</p>;
  if (error) return <p class="error">{error}</p>;

  const cols: KeywordStatus[] = ['pending', 'searched', 'exhausted', 'rejected'];
  const colLabel: Record<string, string> = { pending: 'Chờ search', searched: 'Đã search', exhausted: 'Cạn kiệt', rejected: 'Đã từ chối' };

  return (
    <div class="stack" style={{ gap: '1rem' }}>
      <form style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}
        onSubmit={(e) => { e.preventDefault(); void addKeyword(); }}>
        <Field label="Thêm keyword" style={{ flex: 1 }}>
          <Input value={newTerm} onInput={(e) => setNewTerm((e.target as HTMLInputElement).value)} placeholder="vd. quản lý nợ" />
        </Field>
        <button class="btn teal" disabled={addBusy || !newTerm.trim()}>Thêm</button>
      </form>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
        {cols.map((col) => {
          const kws = keywords.filter((k) => k.status === col);
          return (
            <Panel key={col}>
              <h3 style={{ marginBottom: '0.5rem', fontSize: '0.9rem' }}>{colLabel[col]} <Chip>{kws.length}</Chip></h3>
              {kws.length === 0 ? <p class="muted" style={{ fontSize: '0.8rem' }}>Trống</p> : (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {kws.map((k) => (
                    <li key={k.termKey} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: '0.85rem' }}>
                      <span style={{ flex: 1 }}>
                        {k.displayTerm}
                        {k.status === 'searched' && <span class="muted"> · {k.yieldChannels} kênh</span>}
                      </span>
                      {col !== 'rejected' && (
                        <button class="btn secondary" style={{ fontSize: '0.7rem', padding: '2px 5px' }}
                          onClick={() => void rejectKeyword(k.termKey, false)} title="Reject">✕</button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          );
        })}
      </div>
    </div>
  );
}

// ─── StudiedTab ───────────────────────────────────────────────────────────────
type StudiedChannel = Awaited<ReturnType<typeof api.loopStudied>>['channels'][number];

function StudiedTab({ topicId }: { topicId: string }) {
  const [channels, setChannels] = useState<StudiedChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    (IS_MOCK
      ? Promise.resolve({ channels: [] })
      : api.loopStudied(topicId)
    ).then((d) => { setChannels(d.channels); setError(null); })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [topicId]);

  if (loading) return <p class="muted">Đang tải studied…</p>;
  if (error) return <p class="error">{error}</p>;
  if (channels.length === 0) return <p class="muted">Chưa có kênh nào được scan sâu.</p>;

  return (
    <ul class="list" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {channels.map((ch) => (
        <li key={ch.channelId} class="spy-run-card">
          <div class="spy-run-card-summary">
            <div class="spy-run-card-copy">
              <strong>{ch.title}</strong>
              {ch.handle && <span class="muted"> {ch.handle}</span>}
              <div class="meta">
                <Chip>fit {ch.fitScore ?? '—'}</Chip>
                <Chip variant="other">learn {ch.learnValueScore ?? '—'}</Chip>
                {ch.decidedAt && <span class="muted">{fmtDate(ch.decidedAt)}</span>}
              </div>
            </div>
            {ch.spyRunId && (
              <a class="btn secondary" href={href({ name: 'spy-run', id: ch.spyRunId })}>Xem Spy run →</a>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

// ─── DeltaStrip ───────────────────────────────────────────────────────────────
function DeltaStrip({ delta }: { delta: ReportSummaryJson['delta'] }) {
  const rows = [
    { label: 'Kênh mới', prev: delta.newCandidatesPrev, curr: null },
    { label: 'Inbox', prev: delta.inboxTotalPrev, curr: null },
    { label: 'Shortlisted', prev: delta.shortlistedTotalPrev, curr: null },
    { label: 'Studied', prev: delta.studiedTotalPrev, curr: null },
    { label: 'Keyword pending', prev: delta.keywordsPendingPrev, curr: null },
  ].filter((r) => r.prev != null);

  if (rows.length === 0 && delta.userDecisionsSinceLast.shortlisted === 0 && delta.userDecisionsSinceLast.rejected === 0) return null;

  return (
    <div style={{ background: 'var(--surface-alt, #1a1a2e)', borderRadius: 6, padding: '0.75rem 1rem', fontSize: '0.85rem', marginTop: '0.75rem' }}>
      <strong>So với {delta.vsDate ?? 'hôm qua'}:</strong>
      {rows.map((r) => <span key={r.label} class="muted" style={{ marginLeft: 8 }}>{r.label}: {r.prev}</span>)}
      {delta.userDecisionsSinceLast.shortlisted > 0 && (
        <span style={{ marginLeft: 8 }}>Bạn shortlist {delta.userDecisionsSinceLast.shortlisted}, reject {delta.userDecisionsSinceLast.rejected}</span>
      )}
    </div>
  );
}

// ─── ReportsTab ───────────────────────────────────────────────────────────────
function ReportsTab({ topicId }: { topicId: string }) {
  const [reports, setReports] = useState<StoredReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ markdown: string; summary: ReportSummaryJson | null } | null>(null);
  const [resendBusy, setResendBusy] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      if (IS_MOCK) {
        const { MOCK_REPORTS } = await import('../features/spy-loop/mock.ts');
        setReports(MOCK_REPORTS);
      } else {
        const data = await api.loopReports(topicId);
        setReports(data.reports);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [topicId]);

  const openReport = async (id: string) => {
    try {
      if (IS_MOCK) {
        const { MOCK_REPORT_MARKDOWN, MOCK_REPORT_SUMMARY, MOCK_REPORTS } = await import('../features/spy-loop/mock.ts');
        const rpt = MOCK_REPORTS.find((r) => r.reportId === id);
        if (rpt) setSelected({ markdown: MOCK_REPORT_MARKDOWN, summary: MOCK_REPORT_SUMMARY });
      } else {
        const data = await api.loopReport(id);
        setSelected({ markdown: data.markdown, summary: data.summary });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const resend = async (id: string) => {
    setResendBusy(id);
    try {
      if (!IS_MOCK) await api.resendReport(id);
      else await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResendBusy(null);
    }
  };

  if (loading) return <p class="muted">Đang tải báo cáo…</p>;
  if (error) return <p class="error">{error}</p>;
  if (reports.length === 0) return <p class="muted">Chưa có báo cáo nào.</p>;

  return (
    <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
      <ul class="list" style={{ minWidth: 200, maxWidth: 260, flexShrink: 0 }}>
        {reports.map((r) => (
          <li key={r.reportId} style={{ marginBottom: 4 }}>
            <button class="btn secondary" style={{ width: '100%', textAlign: 'left' }}
              onClick={() => void openReport(r.reportId)}>
              <div>{r.reportDate}</div>
              <div style={{ fontSize: '0.75rem' }} class="muted">
                {Object.keys(r.deliveredJson).filter((k) => r.deliveredJson[k]).map((k) => (
                  <Chip key={k} style={{ fontSize: '0.7rem' }}>{k}</Chip>
                ))}
              </div>
            </button>
            <button class="btn secondary" disabled={resendBusy === r.reportId}
              style={{ fontSize: '0.75rem', padding: '2px 6px', marginTop: 2 }}
              onClick={() => void resend(r.reportId)}>
              {resendBusy === r.reportId ? '…' : 'Resend Telegram'}
            </button>
          </li>
        ))}
      </ul>
      {selected && (
        <div style={{ flex: 1, minWidth: 0 }}>
          {selected.summary?.delta && <DeltaStrip delta={selected.summary.delta} />}
          <pre class="pre" style={{ marginTop: '0.75rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {selected.markdown}
          </pre>
        </div>
      )}
    </div>
  );
}

// ─── LoopSettingsPanel ────────────────────────────────────────────────────────
/**
 * Ghi vào `config/spy-loop.json` (route `PUT /api/settings/spy-loop`) — FILE
 * RIÊNG, không bao giờ chung `spy.json`: `spyConfigSchema` là `.strict()` và
 * `loadConfig()` nuốt lỗi parse, nên một key lạ trong `spy.json` sẽ xoá sạch
 * `youtubeDataApiKey` mà không báo gì (hard gate G4).
 */
function LoopSettingsPanel() {
  const [settings, setSettings] = useState<SpyLoopSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [telegramToken, setTelegramToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [tickHour, setTickHour] = useState('15:30');
  const [digestHour, setDigestHour] = useState('08:00');
  const [enabled, setEnabled] = useState(false);
  const [telegramEnabled, setTelegramEnabled] = useState(false);

  const apply = (s: SpyLoopSettings) => {
    setSettings(s);
    setEnabled(s.enabled);
    setTickHour(s.tickHourLocal);
    setDigestHour(s.digestHourLocal);
    setChatId(s.telegram?.chatId ?? '');
    setTelegramEnabled(s.telegram?.enabled ?? false);
  };

  useEffect(() => {
    (IS_MOCK
      ? import('../features/spy-loop/mock.ts').then((m) => m.MOCK_SETTINGS)
      : api.getSpyLoopSettings()
    ).then((s) => {
      apply(s);
      setLoading(false);
    }).catch((err) => { setError(err.message); setLoading(false); });
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const body: Parameters<typeof api.putSpyLoopSettings>[0] = {
        enabled,
        tickHourLocal: tickHour,
        digestHourLocal: digestHour,
        telegram: {
          chatId,
          enabled: telegramEnabled,
          // Token rỗng = "giữ nguyên": không gửi lên để khỏi ghi đè bằng chuỗi rỗng.
          ...(telegramToken ? { botToken: telegramToken } : {}),
        },
      };
      const saved = IS_MOCK
        ? { ...settings!, enabled, tickHourLocal: tickHour, digestHourLocal: digestHour }
        : await api.putSpyLoopSettings(body);
      apply(saved);
      setTelegramToken('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return null;

  return (
    <Panel class="stack" style={{ marginTop: '2rem' }}>
      <h2>Cài đặt Spy Loop</h2>
      <p class="muted" style={{ fontSize: '0.8rem', margin: 0 }}>
        Lưu ở <code>config/spy-loop.json</code> — tách khỏi <code>config/spy.json</code> để
        không bao giờ làm mất YouTube Data API key.
      </p>
      {error && <p class="error">{error}</p>}
      <Row style={{ gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input type="checkbox" checked={enabled} onInput={(e) => setEnabled((e.target as HTMLInputElement).checked)} />
          Bật auto-loop
        </label>
        <Field label="Giờ tick (VN, HH:MM)">
          <Input value={tickHour} placeholder="15:30" onInput={(e) => setTickHour((e.target as HTMLInputElement).value)} style={{ width: '6rem' }} />
        </Field>
        <Field label="Giờ digest (VN, HH:MM)">
          <Input value={digestHour} placeholder="08:00" onInput={(e) => setDigestHour((e.target as HTMLInputElement).value)} style={{ width: '6rem' }} />
        </Field>
      </Row>
      <Row style={{ gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input type="checkbox" checked={telegramEnabled} onInput={(e) => setTelegramEnabled((e.target as HTMLInputElement).checked)} />
          Gửi Telegram
        </label>
        <Field label="Telegram bot token (để trống nếu không đổi)" style={{ flex: 1 }}>
          <Input
            type="password"
            placeholder={settings?.telegram?.botTokenSet ? 'Đã lưu — nhập để thay' : 'Chưa cấu hình'}
            value={telegramToken}
            onInput={(e) => setTelegramToken((e.target as HTMLInputElement).value)}
          />
        </Field>
        <Field label="Chat ID" style={{ flex: 1 }}>
          <Input placeholder="-100xxxxxxxxx" value={chatId} onInput={(e) => setChatId((e.target as HTMLInputElement).value)} />
        </Field>
      </Row>
      <div>
        <button class="btn teal" disabled={saving} onClick={() => void save()}>
          {saving ? 'Đang lưu…' : 'Lưu cài đặt'}
        </button>
      </div>
    </Panel>
  );
}

// ─── SpyLoopPage ──────────────────────────────────────────────────────────────
type Tab = 'inbox' | 'keywords' | 'studied' | 'reports';

export function SpyLoopPage({ topic }: { topic?: string }) {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [currentTopicId, setCurrentTopicId] = useState<string>(topic ?? '');
  const [loopStatus, setLoopStatus] = useState<LoopStatus | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('inbox');
  const [loadErr, setLoadErr] = useState<string | null>(null);

  // Load topics
  useEffect(() => {
    (IS_MOCK
      ? import('../features/spy-loop/mock.ts').then((m) => m.MOCK_TOPICS)
      : api.listTopics().then((d) => d.topics)
    ).then((ts) => {
      setTopics(ts);
      if (!currentTopicId && ts.length > 0) setCurrentTopicId(ts[0]!.topicId);
    }).catch((err) => setLoadErr(err.message));
  }, []);

  // Poll loop status (5s while running)
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const fetchStatus = async (id: string) => {
    if (!id) return;
    try {
      const s = IS_MOCK
        ? await import('../features/spy-loop/mock.ts').then((m) => m.MOCK_LOOP_STATUS)
        : await api.loopStatus(id);
      setLoopStatus(s);
      const isRunning = s.lastTick?.status === 'running';
      statusTimerRef.current = setTimeout(() => void fetchStatus(id), isRunning ? 5000 : 30000);
    } catch {
      statusTimerRef.current = setTimeout(() => void fetchStatus(id), 15000);
    }
  };

  useEffect(() => {
    if (!currentTopicId) return;
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    void fetchStatus(currentTopicId);
    return () => { if (statusTimerRef.current) clearTimeout(statusTimerRef.current); };
  }, [currentTopicId]);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'inbox', label: 'Inbox' },
    { id: 'keywords', label: 'Keywords' },
    { id: 'studied', label: 'Studied' },
    { id: 'reports', label: 'Báo cáo' },
  ];

  return (
    <div>
      <div class="page-header">
        <div>
          <h1 class="page-title">Spy Loop {IS_MOCK && <Chip variant="warn">MOCK</Chip>}</h1>
          <p class="page-lead" style={{ marginBottom: 0 }}>
            Tìm kênh đối thủ tự động theo chủ đề — duyệt Inbox hàng ngày.
          </p>
        </div>
        <a class="btn secondary" href={href({ name: 'spy' })}>← Spy</a>
      </div>

      {loadErr && <p class="error" style={{ marginTop: '1rem' }}>{loadErr}</p>}

      {topics.length > 0 && (
        <TopicSwitcher topics={topics} current={currentTopicId} onChange={setCurrentTopicId} />
      )}
      {topics.length === 0 && !loadErr && (
        <p class="muted">Chưa có topic nào. Tạo topic qua API hoặc import file finance-vi.json.</p>
      )}

      {currentTopicId && (
        <>
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: '1rem' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <LoopKpiRow status={loopStatus} />
            </div>
            <TickActions topicId={currentTopicId} onDone={() => void fetchStatus(currentTopicId)} />
          </div>

          <div class="feed-filter-tabs" style={{ display: 'flex', gap: '0.25rem', marginBottom: '1rem', borderBottom: '1px solid var(--border, #333)', paddingBottom: '0.5rem' }}>
            {tabs.map((t) => (
              <button
                key={t.id}
                class={`btn ${activeTab === t.id ? 'teal' : 'secondary'}`}
                style={{ fontSize: '0.85rem' }}
                onClick={() => setActiveTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {activeTab === 'inbox' && <InboxTab topicId={currentTopicId} />}
          {activeTab === 'keywords' && <KeywordBoardTab topicId={currentTopicId} />}
          {activeTab === 'studied' && <StudiedTab topicId={currentTopicId} />}
          {activeTab === 'reports' && <ReportsTab topicId={currentTopicId} />}
        </>
      )}

      <LoopSettingsPanel />
    </div>
  );
}
