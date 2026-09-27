/**
 * Panel Keyword health của Spy Board — bảng keyword của 1 topic,
 * group theo ngách (group_key) bằng sub-tab, sort click, multi-select
 * cho bulk action (Run now / Activate / Pause) và form bulk-add.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  api,
  type DashKeywordRow,
  type KeywordStatus,
} from '../../api.ts';
import { Field, Input } from '../../components/ui/Forms.tsx';
import { Chip } from '../../components/ui/Chip.tsx';
import { Panel, Row } from '../../components/ui/Layout.tsx';
import {
  IS_MOCK,
  UNGROUPED,
  fmtInt,
  fmtNum,
  groupKeywords,
  kwStatusChip,
  relDate,
  TrendBadge,
} from './lib.tsx';

type SortKey =
  | 'display_term'
  | 'status'
  | 'last_checked_at'
  | 'last_n_results'
  | 'last_median_views'
  | 'last_n_followed'
  | 'outliers_28d'
  | 'channels_discovered';

const COLS: Array<{ key: SortKey; label: string; numeric?: boolean; hint?: string }> = [
  { key: 'display_term', label: 'Keyword' },
  { key: 'status', label: 'Trạng thái' },
  { key: 'last_checked_at', label: 'Chạy cuối' },
  { key: 'last_n_results', label: 'KQ', numeric: true, hint: 'Video trả về lần chạy gần nhất' },
  { key: 'last_median_views', label: 'Median views', numeric: true, hint: 'Median views + trend so với lần trước' },
  { key: 'last_n_followed', label: 'Followed', numeric: true, hint: 'Hit thuộc kênh đang follow (% theo KQ)' },
  { key: 'outliers_28d', label: 'Outlier 28d', numeric: true, hint: 'Video outlier keyword này sinh ra trong 28 ngày' },
  { key: 'channels_discovered', label: 'Kênh mới', numeric: true, hint: 'Kênh phát hiện qua keyword' },
];

function sortValue(row: DashKeywordRow, key: SortKey): number | string {
  switch (key) {
    case 'display_term': return row.display_term;
    case 'status': return row.status;
    case 'last_checked_at': return row.last_checked_at ?? '';
    case 'last_n_results': return row.last_n_results ?? -1;
    case 'last_median_views': return row.last_median_views ?? -1;
    case 'last_n_followed': return row.last_n_followed ?? -1;
    case 'outliers_28d': return row.outliers_28d ?? -1;
    case 'channels_discovered': return row.channels_discovered ?? -1;
  }
}

const GROUP_LABEL: Record<string, string> = { [UNGROUPED]: 'Chưa gán' };
function groupLabel(key: string): string {
  return GROUP_LABEL[key] ?? key;
}

export function KeywordHealthPanel({ topicId, checked, onCheckedChange, onRequestRun, refreshKey }: {
  topicId: string;
  checked: ReadonlySet<string>;
  onCheckedChange: (next: Set<string>) => void;
  onRequestRun: (termKeys: string[]) => void;
  refreshKey: number;
}) {
  const [rows, setRows] = useState<DashKeywordRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('outliers_28d');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [groupTab, setGroupTab] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkGroup, setBulkGroup] = useState('');
  const [bulkActivate, setBulkActivate] = useState(true);
  const selectAllRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    try {
      if (IS_MOCK) {
        const { MOCK_DASH_KEYWORDS } = await import('./mock.ts');
        setRows(MOCK_DASH_KEYWORDS);
      } else {
        // Sort server chỉ hỗ trợ vài cột và outliers_28d là field mới —
        // lấy limit cao rồi sort client, an toàn với cả backend cũ.
        const res = await api.dashKeywords(topicId, { limit: 500 });
        setRows(res.data ?? []);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    onCheckedChange(new Set());
    setGroupTab('');
    void load();
  }, [topicId, refreshKey]);

  const groups = useMemo(() => groupKeywords(rows), [rows]);
  const groupKeys = useMemo(
    () => [...groups.keys()].sort((a, b) => (a === UNGROUPED ? 1 : b === UNGROUPED ? -1 : a.localeCompare(b))),
    [groups],
  );

  const visible = useMemo(() => {
    const list = groupTab === '' ? rows : (groups.get(groupTab) ?? []);
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      const va = sortValue(a, sortKey);
      const vb = sortValue(b, sortKey);
      if (typeof va === 'string' || typeof vb === 'string') {
        return String(va).localeCompare(String(vb)) * dir;
      }
      return (va - vb) * dir;
    });
  }, [rows, groups, groupTab, sortKey, sortDir]);

  const allVisibleChecked = visible.length > 0 && visible.every((r) => checked.has(r.term_key));
  const someVisibleChecked = visible.some((r) => checked.has(r.term_key));
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = !allVisibleChecked && someVisibleChecked;
  }, [allVisibleChecked, someVisibleChecked]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'display_term' || key === 'status' ? 'asc' : 'desc');
    }
  };

  const toggleAll = () => {
    const next = new Set(checked);
    if (allVisibleChecked) visible.forEach((r) => next.delete(r.term_key));
    else visible.forEach((r) => next.add(r.term_key));
    onCheckedChange(next);
  };

  const toggle = (termKey: string) => {
    const next = new Set(checked);
    if (next.has(termKey)) next.delete(termKey);
    else next.add(termKey);
    onCheckedChange(next);
  };

  const decide = async (toStatus: KeywordStatus) => {
    if (checked.size === 0) return;
    const keys = [...checked];
    setBusy(toStatus);
    setError(null);
    setNotice(null);
    try {
      if (IS_MOCK) {
        await new Promise((r) => setTimeout(r, 300));
      } else {
        await api.spyKeywordDecide({ topic_id: topicId, term_keys: keys, to_status: toStatus });
      }
      const keySet = new Set(keys);
      setRows((prev) => prev.map((r) => (keySet.has(r.term_key) ? { ...r, status: toStatus } : r)));
      onCheckedChange(new Set());
      setNotice(`Đã chuyển ${keys.length} keyword → ${toStatus}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const bulkLines = bulkText.split('\n').map((s) => s.trim()).filter((s) => s !== '');

  const submitBulk = async () => {
    if (bulkLines.length === 0) return;
    setBusy('bulk');
    setError(null);
    setNotice(null);
    try {
      const group = bulkGroup.trim();
      const res = IS_MOCK
        ? { added: bulkLines.length, reactivated: 0, skipped: [] as string[] }
        : await api.spyKeywordBulkAdd({
            topicId,
            terms: bulkLines,
            ...(group ? { group } : {}),
            activate: bulkActivate,
          });
      setNotice(`Bulk add: +${res.added} keyword${res.reactivated ? ` · ${res.reactivated} reactive` : ''}${res.skipped.length ? ` · bỏ qua ${res.skipped.length}` : ''}.`);
      setBulkText('');
      setBulkOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [rows]);

  return (
    <Panel class="stack" style={{ margin: '0 0 1rem' }}>
      <Row style={{ justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1rem' }}>Keyword health</h2>
          <p class="muted" style={{ fontSize: '0.78rem', margin: '0.2rem 0 0' }}>
            {rows.length} keyword
            {counts['active'] != null && <> · {counts['active']} active</>}
            {counts['pending'] != null && <> · {counts['pending']} chờ duyệt</>}
            {' · '}click header để sort · tick để bulk action
          </p>
        </div>
        <Row style={{ gap: '0.4rem' }}>
          <button class="btn secondary" style={{ fontSize: '0.78rem', padding: '0.25rem 0.7rem', minHeight: 0, height: 'auto' }}
            onClick={() => setBulkOpen((v) => !v)}>
            {bulkOpen ? 'Đóng form thêm' : '+ Thêm nhiều keyword'}
          </button>
          <button class="btn secondary" style={{ fontSize: '0.78rem', padding: '0.25rem 0.7rem', minHeight: 0, height: 'auto' }}
            disabled={loading} onClick={() => void load()}>
            ⟳ Refresh
          </button>
        </Row>
      </Row>

      {bulkOpen && (
        <div style={{ border: '1px solid var(--line)', borderRadius: '10px', padding: '0.75rem', background: 'rgba(255,255,255,0.4)' }}>
          <Field label="Mỗi dòng một keyword" sublabel={`(${bulkLines.length} dòng)`}>
            <textarea
              class="input"
              rows={4}
              value={bulkText}
              onInput={(e) => setBulkText((e.target as HTMLTextAreaElement).value)}
              placeholder={'trả góp 0 đồng\nbẫy tín dụng\ndọn nợ xấu'}
              style={{ width: '100%', fontFamily: 'inherit', resize: 'vertical' }}
            />
          </Field>
          <Row style={{ gap: '0.75rem', alignItems: 'flex-end', flexWrap: 'wrap', marginTop: '0.5rem' }}>
            <Field label="Ngách (group_key)" sublabel="để trống = chưa gán">
              <Input
                list="spy-kw-groups"
                value={bulkGroup}
                onInput={(e) => setBulkGroup((e.target as HTMLInputElement).value)}
                placeholder="vd. tra-gop"
                style={{ width: '12rem' }}
              />
              <datalist id="spy-kw-groups">
                {groupKeys.filter((g) => g !== UNGROUPED).map((g) => <option key={g} value={g} />)}
              </datalist>
            </Field>
            <label style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', fontSize: '0.85rem' }}>
              <input type="checkbox" checked={bulkActivate} onInput={(e) => setBulkActivate((e.target as HTMLInputElement).checked)} />
              Activate luôn (bỏ qua chờ duyệt)
            </label>
            <button class="btn teal" disabled={busy !== null || bulkLines.length === 0} onClick={() => void submitBulk()}>
              {busy === 'bulk' ? 'Đang thêm…' : `Thêm ${bulkLines.length || ''} keyword`}
            </button>
          </Row>
        </div>
      )}

      {/* Sub-tab theo ngách */}
      {groupKeys.length > 0 && (
        <div class="feed-filter-tabs" style={{ flexWrap: 'wrap' }}>
          <button
            class={`feed-tab-btn ${groupTab === '' ? 'active' : ''}`}
            onClick={() => setGroupTab('')}
          >
            Tất cả <span class="muted">({rows.length})</span>
          </button>
          {groupKeys.map((g) => (
            <button
              key={g}
              class={`feed-tab-btn ${groupTab === g ? 'active' : ''}`}
              onClick={() => setGroupTab(g)}
            >
              {groupLabel(g)} <span class="muted">({groups.get(g)!.length})</span>
            </button>
          ))}
        </div>
      )}

      {/* Action bar khi có chọn */}
      {checked.size > 0 && (
        <Row style={{ gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap', padding: '0.4rem 0.6rem', borderRadius: '8px', background: 'rgba(31,138,122,0.10)' }}>
          <strong style={{ fontSize: '0.82rem' }}>{checked.size} đã chọn</strong>
          <button class="btn teal" style={{ fontSize: '0.78rem', padding: '0.2rem 0.7rem', minHeight: 0, height: 'auto' }}
            disabled={busy !== null}
            onClick={() => onRequestRun([...checked])}>
            ▶ Run now
          </button>
          <button class="btn secondary" style={{ fontSize: '0.78rem', padding: '0.2rem 0.7rem', minHeight: 0, height: 'auto' }}
            disabled={busy !== null} onClick={() => void decide('active')}>
            {busy === 'active' ? '…' : 'Activate'}
          </button>
          <button class="btn secondary" style={{ fontSize: '0.78rem', padding: '0.2rem 0.7rem', minHeight: 0, height: 'auto' }}
            disabled={busy !== null} onClick={() => void decide('paused')}>
            {busy === 'paused' ? '…' : 'Pause'}
          </button>
          <button class="btn secondary" style={{ fontSize: '0.78rem', padding: '0.2rem 0.7rem', minHeight: 0, height: 'auto' }}
            onClick={() => onCheckedChange(new Set())}>
            Bỏ chọn
          </button>
        </Row>
      )}

      {notice && <p class="ok" style={{ margin: 0, fontSize: '0.82rem' }}>{notice}</p>}
      {error && <p class="error" style={{ margin: 0, fontSize: '0.82rem' }}>{error}</p>}

      {loading && rows.length === 0 && (
        <div class="stack" style={{ gap: '0.4rem' }}>
          {[0, 1, 2].map((i) => <div key={i} class="spy-skel" />)}
        </div>
      )}

      {!loading && rows.length === 0 && !error && (
        <p class="muted" style={{ fontSize: '0.85rem' }}>
          Chưa có keyword — mở «+ Thêm nhiều keyword» phía trên để dán list,
          hoặc thêm từng keyword ở tab Keywords.
        </p>
      )}

      {visible.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table class="spy-kw-table">
            <thead>
              <tr>
                <th style={{ width: '1.6rem' }}>
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allVisibleChecked}
                    onChange={toggleAll}
                    title="Chọn cả bảng đang hiển thị"
                  />
                </th>
                {COLS.map((c) => (
                  <th
                    key={c.key}
                    class={c.numeric ? 'num' : undefined}
                    title={c.hint}
                    onClick={() => toggleSort(c.key)}
                  >
                    {c.label}
                    {sortKey === c.key && <span> {sortDir === 'desc' ? '▼' : '▲'}</span>}
                  </th>
                ))}
                {groupTab === '' && <th>Ngách</th>}
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.term_key} class={checked.has(row.term_key) ? 'is-checked' : undefined}>
                  <td>
                    <input type="checkbox" checked={checked.has(row.term_key)} onChange={() => toggle(row.term_key)} />
                  </td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{row.display_term}</div>
                    <div class="muted" style={{ fontSize: '0.7rem', fontFamily: 'var(--font-mono)' }}>{row.term_key}</div>
                  </td>
                  <td>{kwStatusChip(row.status)}</td>
                  <td class="muted" style={{ fontSize: '0.78rem', whiteSpace: 'nowrap' }}>{relDate(row.last_checked_at)}</td>
                  <td class="num">{fmtInt(row.last_n_results)}</td>
                  <td class="num">
                    {fmtNum(row.last_median_views)}
                    {' '}
                    <TrendBadge cur={row.last_median_views} prev={row.prev_median_views} />
                  </td>
                  <td class="num">
                    {fmtInt(row.last_n_followed)}
                    {row.pct_followed != null && <span class="muted" style={{ fontSize: '0.72rem' }}> ({(row.pct_followed * 100).toFixed(0)}%)</span>}
                  </td>
                  <td class="num">
                    {(row.outliers_28d ?? 0) > 0
                      ? <strong style={{ color: 'var(--teal-deep)' }}>{row.outliers_28d}</strong>
                      : <span class="muted">{row.outliers_28d ?? '—'}</span>}
                  </td>
                  <td class="num">{fmtInt(row.channels_discovered)}</td>
                  {groupTab === '' && (
                    <td>
                      {row.group_key
                        ? <Chip variant="other">{row.group_key}</Chip>
                        : <span class="muted" style={{ fontSize: '0.75rem' }}>—</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && rows.length > 0 && visible.length === 0 && (
        <p class="muted" style={{ fontSize: '0.85rem' }}>Ngách này chưa có keyword nào.</p>
      )}
    </Panel>
  );
}
