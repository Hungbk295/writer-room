/**
 * Màn 3 · Keyword — "keyword nào chạy tiếp?" (plan spy-analyst-workflow §G).
 * Bảng keyword theo ngách: lần search cuối, khoá 3 ngày, tỉ lệ mới, outlier đã
 * tìm ra. Tick → Tìm mới: ước tính quota (dryRun) → ghi chú mục đích → chạy →
 * tiến độ. Thêm keyword hàng loạt vào ngách đang xem.
 */
import { useEffect, useState } from 'preact/hooks';
import { api, type BoardRunDetail, type SpyKeywordRunResponse } from '../../api.ts';
import { Panel, Row } from '../../components/ui/Layout.tsx';
import { loadKeywords, loadRunDetail } from './data.ts';
import {
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
    <div class="stack">
      <Row style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <span class="muted" style={{ fontSize: '0.8rem' }}>Ngách</span>
        <select
          class="input spy-select-sm"
          value={filter === undefined ? '_all' : filter ?? '_none'}
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            setFilter(v === '_all' ? undefined : v === '_none' ? null : v);
          }}
        >
          <option value="_all">Tất cả ngách</option>
          {niches.map((n) => <option key={n ?? '_none'} value={n ?? '_none'}>{nicheLabel(n)}</option>)}
        </select>
      </Row>

      <LoadState state={state} empty={!state.loading && !state.error && rows.length === 0} />
      {rows.length > 0 && (
        <div class="spy-table-wrap">
          <table class="spy-kw-table">
            <thead>
              <tr>
                <th>
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
                    <td>
                      <input
                        type="checkbox"
                        disabled={locked || k.status === 'rejected'}
                        checked={checked.has(k.termKey)}
                        onChange={() => toggle(k.termKey)}
                        title={locked ? 'Đã search trong 3 ngày qua' : undefined}
                      />
                    </td>
                    <td>
                      {k.term}
                      {k.status !== 'active' && <span class="muted" style={{ marginLeft: '0.35rem', fontSize: '0.72rem' }}>({k.status})</span>}
                    </td>
                    <td class="muted">{nicheLabel(k.niche)}</td>
                    <td>
                      {relDate(k.lastCheckedAt)}
                      {locked && <span class="spy-lock" title={`Mở lại ${new Date(k.lockedUntil!).toLocaleString('vi-VN')}`}> 🔒 còn {lockLeft(k.lockedUntil!)}</span>}
                    </td>
                    <td class="num">{fmtInt(k.lastNResults)}</td>
                    <td class="num">{k.newRate !== null ? `${Math.round(k.newRate * 100)}%` : '—'}</td>
                    <td class="num">{k.outliersFound}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
    return <p class="muted" style={{ margin: 0, fontSize: '0.8rem' }}>Tick keyword (không bị khoá) để chạy Tìm mới.</p>;
  }

  const card = running?.card;
  const pct = card && card.nItems ? Math.round(((card.itemsDone ?? 0) / card.nItems) * 100) : 0;
  return (
    <Panel class="stack">
      <strong>Tìm mới — {termKeys.length || card?.nItems || 0} keyword</strong>
      {!estimate && !running && (
        <Row style={{ gap: '0.5rem' }}>
          <button class="btn secondary spy-btn-sm" disabled={busy} onClick={() => void doEstimate()}>Ước tính quota</button>
        </Row>
      )}
      {estimate && !running && (
        <div class="stack" style={{ gap: '0.5rem' }}>
          <p style={{ margin: 0, fontSize: '0.84rem' }}>
            Tốn <b>{estimate.estimatedSearchCalls}</b> lượt search · còn <b>{estimate.quotaRemaining}</b> hôm nay
            {estimate.locked && estimate.locked.length > 0 && <span class="muted"> · {estimate.locked.length} keyword bị bỏ qua (đã search trong 3 ngày)</span>}
          </p>
          <input
            class="input"
            placeholder="Ghi chú mục đích (tuỳ chọn) — vd: tìm kênh nhỏ đang lên"
            value={note}
            maxLength={500}
            onInput={(e) => setNote((e.target as HTMLInputElement).value)}
          />
          <Row style={{ gap: '0.5rem' }}>
            <button class="btn teal spy-btn-sm" disabled={busy || estimate.estimatedSearchCalls === 0} onClick={() => void doRun()}>Chạy</button>
            <button class="btn secondary spy-btn-sm" disabled={busy} onClick={() => setEstimate(null)}>Huỷ</button>
          </Row>
        </div>
      )}
      {card && (
        <div class="stack" style={{ gap: '0.4rem' }}>
          <Row style={{ gap: '0.5rem', alignItems: 'center' }}>
            {runStatusChip(card.status)}
            <span class="muted" style={{ fontSize: '0.8rem' }}>
              {card.itemsDone ?? 0}/{card.nItems ?? 0} keyword · {card.searchCalls} search · {card.nNew ?? 0} video mới · {card.newChannels} kênh đề xuất
              {card.nSkipped ? ` · ${card.nSkipped} bỏ qua` : ''}
            </span>
          </Row>
          <div class="spy-progress"><div class="spy-progress-fill" style={{ width: `${pct}%` }} /></div>
          {card.status !== 'running' && (
            <button class="btn secondary spy-btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setRunning(null)}>Đóng</button>
          )}
        </div>
      )}
      {error && <p class="error" style={{ margin: 0, fontSize: '0.82rem' }}>{error}</p>}
    </Panel>
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
    <details class="spy-details">
      <summary>Thêm keyword hàng loạt</summary>
      <div class="stack" style={{ gap: '0.5rem', marginTop: '0.5rem' }}>
        <textarea
          class="input"
          rows={4}
          placeholder="Mỗi dòng một keyword"
          value={text}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        />
        <Row style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            class="input spy-select-sm"
            placeholder="Ngách (vd side-hustle)"
            value={group}
            onInput={(e) => setGroup((e.target as HTMLInputElement).value)}
          />
          <button class="btn teal spy-btn-sm" disabled={busy || terms.length === 0} onClick={() => void submit()}>
            Thêm {terms.length} keyword (active)
          </button>
        </Row>
        {msg && <p class={msg.ok ? 'ok' : 'error'} style={{ margin: 0, fontSize: '0.82rem' }}>{msg.text}</p>}
      </div>
    </details>
  );
}
