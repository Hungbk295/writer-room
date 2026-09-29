/**
 * Màn 3 · Keyword — "keyword nào chạy tiếp?" (plan spy-analyst-workflow §G).
 * Bảng keyword theo ngách: lần search cuối, khoá 3 ngày, tỉ lệ mới, outlier đã
 * tìm ra. Tick → Tìm mới: ước tính quota (dryRun) → ghi chú mục đích → chạy →
 * tiến độ. Thêm keyword hàng loạt vào ngách đang xem. Giao diện TailPanel —
 * CSS ở board.css.
 */
import { useEffect, useState } from 'preact/hooks';
import { api, type BoardRunDetail, type SpyKeywordRunResponse } from '../../api.ts';
import { loadKeywords, loadRunDetail } from './data.ts';
import {
  Badge,
  Icon,
  IS_MOCK,
  LoadState,
  fmtInt,
  nicheLabel,
  relDate,
  runStatusChip,
  useLoad,
} from './lib.tsx';

export function KeywordsScreen({ topicId, niche, niches, refreshKey, onRunFinished }: {
  topicId: string;
  /** undefined = mọi ngách. */
  niche: string | null | undefined;
  niches: Array<string | null>;
  refreshKey: number;
  onRunFinished: () => void;
}) {
  const [filter, setFilter] = useState<string | null | undefined>(niche);
  useEffect(() => setFilter(niche), [niche]);
  const [bump, setBump] = useState(0);
  const state = useLoad(() => loadKeywords(topicId, filter), [topicId, filter, refreshKey, bump]);
  const rows = state.data?.data ?? [];
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setChecked(new Set()), [topicId, filter]);

  const selectable = rows.filter((k) => !k.lockedUntil && k.status !== 'rejected');
  const allChecked = selectable.length > 0 && selectable.every((k) => checked.has(k.termKey));
  const toggle = (key: string) => {
    const next = new Set(checked);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setChecked(next);
  };

  return (
    <div class="sb-stack">
      <div class="sb-card sb-toolbar">
        <label class="sb-field">
          <span class="sb-field-label">Ngách</span>
          <select
            class="sb-select"
            value={filter === undefined ? '_all' : filter ?? '_none'}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              setFilter(v === '_all' ? undefined : v === '_none' ? null : v);
            }}
          >
            <option value="_all">Tất cả ngách</option>
            {niches.map((n) => <option key={n ?? '_none'} value={n ?? '_none'}>{nicheLabel(n)}</option>)}
          </select>
        </label>
      </div>

      <LoadState state={state} empty={!state.loading && !state.error && rows.length === 0} />
      {rows.length > 0 && (
        <section class="sb-card sb-card-flush">
          <div class="sb-table-wrap">
            <table class="sb-table">
              <thead>
                <tr>
                  <th class="sb-th-check">
                    <input
                      type="checkbox"
                      checked={allChecked}
                      onChange={() => setChecked(allChecked ? new Set() : new Set(selectable.map((k) => k.termKey)))}
                      aria-label="Chọn tất cả keyword chạy được"
                    />
                  </th>
                  <th>Keyword</th>
                  <th>Ngách</th>
                  <th>Search lần cuối</th>
                  <th class="num">Kết quả</th>
                  <th class="num" title="Video chưa từng thấy ÷ tổng kết quả, lần search gần nhất">Tỉ lệ mới</th>
                  <th class="num">Outlier tìm ra</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((k) => {
                  const locked = Boolean(k.lockedUntil);
                  return (
                    <tr key={k.termKey} class={checked.has(k.termKey) ? 'is-checked' : ''}>
                      <td class="sb-th-check">
                        <input
                          type="checkbox"
                          disabled={locked || k.status === 'rejected'}
                          checked={checked.has(k.termKey)}
                          onChange={() => toggle(k.termKey)}
                          title={locked ? 'Đã search trong 3 ngày qua' : undefined}
                        />
                      </td>
                      <td class="sb-strong">
                        {k.term}
                        {k.status !== 'active' && <span class="sb-hint sb-ml">({k.status})</span>}
                      </td>
                      <td class="sb-hint">{nicheLabel(k.niche)}</td>
                      <td>
                        <span class="sb-mr">{relDate(k.lastCheckedAt)}</span>
                        {locked && (
                          <Badge tone="warning" title={`Mở lại ${new Date(k.lockedUntil!).toLocaleString('vi-VN')}`}>
                            <Icon name="lock" size={12} />còn {lockLeft(k.lockedUntil!)}
                          </Badge>
                        )}
                      </td>
                      <td class="num">{fmtInt(k.lastNResults)}</td>
                      <td class="num">
                        {k.newRate !== null ? (
                          <span class="sb-rate">
                            <span class="sb-progress sb-progress-thin"><span class="sb-progress-fill" style={{ width: `${Math.round(k.newRate * 100)}%` }} /></span>
                            {Math.round(k.newRate * 100)}%
                          </span>
                        ) : '—'}
                      </td>
                      <td class="num">{k.outliersFound}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <RunBox
        topicId={topicId}
        termKeys={[...checked]}
        onFinished={() => { setChecked(new Set()); setBump((b) => b + 1); onRunFinished(); }}
      />
      <BulkAdd topicId={topicId} niche={filter ?? null} onAdded={() => setBump((b) => b + 1)} />
    </div>
  );
}

function lockLeft(untilIso: string): string {
  const h = Math.max(0, Math.ceil((Date.parse(untilIso) - Date.now()) / 3_600_000));
  return h >= 24 ? `${Math.ceil(h / 24)} ngày` : `${h} giờ`;
}

// ── Tìm mới: ước tính → ghi chú → chạy → tiến độ ───────────────────────────

function RunBox({ topicId, termKeys, onFinished }: {
  topicId: string;
  termKeys: string[];
  onFinished: () => void;
}) {
  const [estimate, setEstimate] = useState<SpyKeywordRunResponse | null>(null);
  const [note, setNote] = useState('');
  const [running, setRunning] = useState<BoardRunDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setEstimate(null), [termKeys.join('|')]);

  const doEstimate = async () => {
    setBusy(true);
    setError(null);
    try {
      setEstimate(IS_MOCK
        ? { runId: null, keywords: termKeys, estimatedSearchCalls: termKeys.length, quotaRemaining: 87, locked: [] }
        : await api.spyKeywordRun({ topicId, termKeys, dryRun: true }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doRun = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = IS_MOCK
        ? { runId: 'run-1' }
        : await api.spyKeywordRun({ topicId, termKeys, note: note.trim() || undefined });
      if (!res.runId) throw new Error('Không tạo được lượt chạy');
      const runId = res.runId;
      // Poll tới khi lượt chạy rời trạng thái running.
      for (let i = 0; i < 600; i++) {
        const detail = await loadRunDetail(runId);
        setRunning(detail);
        if (detail.card.status !== 'running') break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      setEstimate(null);
      setNote('');
      onFinished();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (termKeys.length === 0 && !running) {
    return <div class="sb-empty sb-card">Tick keyword (không bị khoá) để chạy Tìm mới.</div>;
  }

  const card = running?.card;
  const pct = card && card.nItems ? Math.round(((card.itemsDone ?? 0) / card.nItems) * 100) : 0;
  return (
    <section class="sb-card sb-stack">
      <h2 class="sb-h2">Tìm mới — {termKeys.length || card?.nItems || 0} keyword</h2>
      {!estimate && !running && (
        <div class="sb-actions">
          <button class="sb-btn secondary" disabled={busy} onClick={() => void doEstimate()}>Ước tính quota</button>
        </div>
      )}
      {estimate && !running && (
        <div class="sb-stack sb-stack-sm">
          <p class="sb-text">
            Tốn <b>{estimate.estimatedSearchCalls}</b> lượt search · còn <b>{estimate.quotaRemaining}</b> hôm nay
            {estimate.locked && estimate.locked.length > 0 && <span class="sb-hint"> · {estimate.locked.length} keyword bị bỏ qua (đã search trong 3 ngày)</span>}
          </p>
          <input
            class="sb-input"
            placeholder="Ghi chú mục đích (tuỳ chọn) — vd: tìm kênh nhỏ đang lên"
            value={note}
            maxLength={500}
            onInput={(e) => setNote((e.target as HTMLInputElement).value)}
          />
          <div class="sb-actions">
            <button class="sb-btn primary" disabled={busy || estimate.estimatedSearchCalls === 0} onClick={() => void doRun()}>
              <Icon name="play" size={16} />Chạy
            </button>
            <button class="sb-btn secondary" disabled={busy} onClick={() => setEstimate(null)}>Huỷ</button>
          </div>
        </div>
      )}
      {card && (
        <div class="sb-stack sb-stack-sm">
          <div class="sb-actions">
            {runStatusChip(card.status)}
            <span class="sb-hint">
              {card.itemsDone ?? 0}/{card.nItems ?? 0} keyword · {card.searchCalls} search · {card.nNew ?? 0} video mới · {card.newChannels} kênh đề xuất
              {card.nSkipped ? ` · ${card.nSkipped} bỏ qua` : ''}
            </span>
          </div>
          <div class="sb-progress"><div class="sb-progress-fill" style={{ width: `${pct}%` }} /></div>
          {card.status !== 'running' && (
            <button class="sb-btn secondary sm" style={{ alignSelf: 'flex-start' }} onClick={() => setRunning(null)}>Đóng</button>
          )}
        </div>
      )}
      {error && <div class="sb-alert">{error}</div>}
    </section>
  );
}

// ── Thêm keyword hàng loạt ─────────────────────────────────────────────────

function BulkAdd({ topicId, niche, onAdded }: { topicId: string; niche: string | null; onAdded: () => void }) {
  const [text, setText] = useState('');
  const [group, setGroup] = useState(niche ?? '');
  useEffect(() => setGroup(niche ?? ''), [niche]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const terms = text.split('\n').map((t) => t.trim()).filter(Boolean);

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      if (IS_MOCK) {
        setMsg({ ok: true, text: `(mock) Đã thêm ${terms.length} keyword` });
      } else {
        const res = await api.spyKeywordBulkAdd({ topicId, terms, group: group.trim() || undefined, activate: true });
        setMsg({ ok: true, text: `Đã thêm ${res.added}, bật lại ${res.reactivated}${res.skipped.length ? `, bỏ qua ${res.skipped.length}` : ''}` });
      }
      setText('');
      onAdded();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <details class="sb-card sb-details">
      <summary><Icon name="plus" size={16} />Thêm keyword hàng loạt</summary>
      <div class="sb-stack sb-stack-sm sb-details-body">
        <textarea
          class="sb-input"
          rows={4}
          placeholder="Mỗi dòng một keyword"
          value={text}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        />
        <div class="sb-actions">
          <input
            class="sb-input sb-input-auto"
            placeholder="Ngách (vd side-hustle)"
            value={group}
            onInput={(e) => setGroup((e.target as HTMLInputElement).value)}
          />
          <button class="sb-btn primary" disabled={busy || terms.length === 0} onClick={() => void submit()}>
            Thêm {terms.length} keyword (active)
          </button>
        </div>
        {msg && <div class={`sb-alert ${msg.ok ? 'ok' : ''}`}>{msg.text}</div>}
      </div>
    </details>
  );
}
