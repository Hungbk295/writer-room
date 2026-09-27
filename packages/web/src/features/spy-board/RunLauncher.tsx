/**
 * Panel Run launcher — chọn phạm vi (keyword đã tick / theo ngách / toàn bộ
 * active), dry-run ước tính quota trước khi chạy thật, progress bar poll
 * run đang chạy, và lịch sử run gần đây.
 */
import { Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  api,
  type SpyKeywordRun,
  type SpyKeywordRunDetail,
  type SpyKeywordRunRequest,
  type SpyKeywordRunResponse,
} from '../../api.ts';
import { Field, Input } from '../../components/ui/Forms.tsx';
import { Panel, Row } from '../../components/ui/Layout.tsx';
import {
  IS_MOCK,
  fmtInt,
  normalizeRunDetail,
  relDate,
  runStatusChip,
} from './lib.tsx';

type SelMode = 'checked' | 'group' | 'all-active';

export function RunLauncherPanel({ topicId, checked, runRequest, onRunFinished, refreshKey }: {
  topicId: string;
  checked: ReadonlySet<string>;
  runRequest: { termKeys: string[]; ts: number } | null;
  onRunFinished: () => void;
  refreshKey: number;
}) {
  const [selMode, setSelMode] = useState<SelMode>('all-active');
  const [selGroup, setSelGroup] = useState('');
  const [requestedKeys, setRequestedKeys] = useState<string[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [days, setDays] = useState(28);
  const [maxResults, setMaxResults] = useState(50);
  const [cap, setCap] = useState(10);
  const [estimate, setEstimate] = useState<SpyKeywordRunResponse | null>(null);
  const [running, setRunning] = useState<SpyKeywordRunDetail | null>(null);
  const [history, setHistory] = useState<SpyKeywordRun[]>([]);
  const [expanded, setExpanded] = useState<SpyKeywordRunDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [histError, setHistError] = useState<string | null>(null);
  const mockPollRef = useRef<number | null>(null);
  const reqBodyRef = useRef<SpyKeywordRunRequest | null>(null);

  // Danh sách ngách cho select — lấy từ keywords của topic (fail thì bỏ qua, launcher vẫn dùng được)
  useEffect(() => {
    let dead = false;
    void (async () => {
      try {
        if (IS_MOCK) {
          const { MOCK_DASH_KEYWORDS } = await import('./mock.ts');
          if (dead) return;
          setGroups([...new Set(MOCK_DASH_KEYWORDS.map((k) => k.group_key).filter((g): g is string => g != null))]);
        } else {
          const res = await api.dashKeywords(topicId, { status: 'active', limit: 500 });
          if (dead) return;
          setGroups([...new Set((res.data ?? []).map((k) => k.group_key).filter((g): g is string => g != null))]);
        }
      } catch {
        /* panel khác lo error riêng */
      }
    })();
    return () => {
      dead = true;
    };
  }, [topicId, refreshKey]);

  const loadHistory = async () => {
    try {
      if (IS_MOCK) {
        const { MOCK_DASH_RUNS } = await import('./mock.ts');
        setHistory(MOCK_DASH_RUNS);
      } else {
        const res = await api.spyKeywordRuns(topicId, 20);
        setHistory(res.data ?? []);
      }
      setHistError(null);
    } catch (err) {
      setHistError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    setEstimate(null);
    setExpanded(null);
    setRunning(null);
    setSelMode('all-active');
    void loadHistory();
  }, [topicId, refreshKey]);

  // "Run now" từ bảng keyword → qua mode checked + tự estimate luôn
  const lastReqTs = useRef(0);
  useEffect(() => {
    if (!runRequest || runRequest.ts === lastReqTs.current) return;
    lastReqTs.current = runRequest.ts;
    setSelMode('checked');
    setRequestedKeys(runRequest.termKeys);
    void doEstimate({ termKeys: runRequest.termKeys });
    // scroll tới launcher
    document.getElementById('spy-run-launcher')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runRequest]);

  const buildBody = (override?: Pick<SpyKeywordRunRequest, 'termKeys'>): SpyKeywordRunRequest => {
    const body: SpyKeywordRunRequest = {
      topicId,
      publishedAfterDays: days,
      maxResults,
      scanChannelsCap: cap,
    };
    if (override?.termKeys && override.termKeys.length > 0) {
      body.termKeys = override.termKeys;
    } else if (selMode === 'checked') {
      const keys = requestedKeys.length > 0 ? requestedKeys : [...checked];
      if (keys.length > 0) body.termKeys = keys;
      else body.status = 'active'; // fallback khi không còn keyword nào được tick
    } else if (selMode === 'group' && selGroup) {
      body.group = selGroup;
    } else {
      body.status = 'active';
    }
    return body;
  };

  const selLabel = (): string => {
    if (selMode === 'checked') {
      const n = requestedKeys.length || checked.size;
      return `${n} keyword đã chọn`;
    }
    if (selMode === 'group') return selGroup ? `ngách «${selGroup}»` : 'ngách (chưa chọn)';
    return 'toàn bộ keyword active';
  };

  const doEstimate = async (override?: Pick<SpyKeywordRunRequest, 'termKeys'>) => {
    setBusy('estimate');
    setError(null);
    setNotice(null);
    try {
      const body = { ...buildBody(override), dryRun: true };
      reqBodyRef.current = buildBody(override);
      if (IS_MOCK) {
        await new Promise((r) => setTimeout(r, 250));
        const n = body.termKeys?.length ?? (body.status === 'active' ? 8 : 4);
        setEstimate({ runId: null, keywords: Array.from({ length: n }, (_, i) => body.termKeys?.[i] ?? `kw-${i}`), estimatedSearchCalls: n, quotaRemaining: 41 });
      } else {
        setEstimate(await api.spyKeywordRun(body));
      }
    } catch (err) {
      setEstimate(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const startMockRun = (req: SpyKeywordRunRequest) => {
    const keywords = req.termKeys ?? Array.from({ length: 6 }, (_, i) => `kw-${i}`);
    const run: SpyKeywordRunDetail = {
      run_id: `run-${Math.floor(Math.random() * 0xffff).toString(16)}`,
      status: 'running',
      n_keywords: keywords.length,
      keywords_done: 0,
      search_calls_used: 0,
      started_at: new Date().toISOString(),
      finished_at: null,
      items: keywords.map((term_key) => ({ term_key, status: 'done', n_results: null, n_followed: null, median_views: null, outliers_found: null, error: null })),
    };
    setRunning(run);
    mockPollRef.current = window.setInterval(() => {
      setRunning((prev) => {
        if (!prev || prev.status !== 'running') return prev;
        const done = Math.min(prev.n_keywords, prev.keywords_done + 1);
        const next = { ...prev, keywords_done: done, search_calls_used: done };
        if (done >= prev.n_keywords) {
          next.status = 'done';
          next.finished_at = new Date().toISOString();
          if (mockPollRef.current != null) window.clearInterval(mockPollRef.current);
          setHistory((h) => [{ ...next }, ...h]);
          setNotice(`Run xong ${done}/${prev.n_keywords} keyword — board đã refetch.`);
          onRunFinished();
        }
        return next;
      });
    }, 700);
  };

  const doRun = async () => {
    const body = reqBodyRef.current ?? buildBody();
    setBusy('run');
    setError(null);
    setNotice(null);
    try {
      if (IS_MOCK) {
        await new Promise((r) => setTimeout(r, 250));
        startMockRun(body);
      } else {
        const res = await api.spyKeywordRun(body);
        setEstimate(null);
        if (res.runId) {
          setNotice(`Run ${res.runId} đã bắt đầu — đang theo dõi…`);
          setRunning(normalizeRunDetail(await api.spyKeywordRunDetail(res.runId)));
        } else {
          setNotice('Run đã khởi tạo — xem tiến độ ở lịch sử run.');
          void loadHistory();
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  // Poll run thật mỗi 4s cho tới khi xong
  const runningId = running?.run_id ?? null;
  const runningStatus = running?.status ?? null;
  useEffect(() => {
    if (IS_MOCK || !runningId || runningStatus !== 'running') return;
    const t = window.setInterval(async () => {
      try {
        const detail = normalizeRunDetail(await api.spyKeywordRunDetail(runningId));
        if (detail == null) return;
        setRunning(detail);
        if (detail.status !== 'running') {
          window.clearInterval(t);
          setNotice(`Run ${runningId} ${detail.status} — ${detail.keywords_done}/${detail.n_keywords} keyword.`);
          onRunFinished();
          void loadHistory();
        }
      } catch {
        /* poll lỗi 1 nhịp không crash UI */
      }
    }, 4000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningId, runningStatus]);

  useEffect(() => () => {
    if (mockPollRef.current != null) window.clearInterval(mockPollRef.current);
  }, []);

  const toggleExpand = async (runId: string) => {
    if (expanded?.run_id === runId) {
      setExpanded(null);
      return;
    }
    try {
      if (IS_MOCK) {
        const { MOCK_DASH_RUN_DETAIL } = await import('./mock.ts');
        setExpanded({ ...MOCK_DASH_RUN_DETAIL, run_id: runId });
      } else {
        setExpanded(normalizeRunDetail(await api.spyKeywordRunDetail(runId)));
      }
    } catch (err) {
      setHistError(err instanceof Error ? err.message : String(err));
    }
  };

  const pct = running && running.n_keywords > 0 ? Math.round((running.keywords_done / running.n_keywords) * 100) : 0;

  return (
    <Panel class="stack" id="spy-run-launcher" style={{ margin: '0 0 1rem' }}>
      <div>
        <h2 style={{ margin: 0, fontSize: '1rem' }}>Run launcher</h2>
        <p class="muted" style={{ fontSize: '0.78rem', margin: '0.2rem 0 0' }}>
          Chọn phạm vi → ước tính quota → chạy. Run dùng search quota nên luôn dry-run trước.
        </p>
      </div>

      <div class="feed-filter-tabs" style={{ flexWrap: 'wrap' }}>
        <button class={`feed-tab-btn ${selMode === 'all-active' ? 'active' : ''}`} onClick={() => setSelMode('all-active')}>
          Toàn bộ active
        </button>
        <button
          class={`feed-tab-btn ${selMode === 'checked' ? 'active' : ''}`}
          onClick={() => { setSelMode('checked'); setRequestedKeys([...checked]); }}
          disabled={checked.size === 0 && requestedKeys.length === 0}
          title={checked.size === 0 ? 'Tick keyword ở bảng trên trước' : undefined}
        >
          Đã chọn ({requestedKeys.length || checked.size})
        </button>
        <button class={`feed-tab-btn ${selMode === 'group' ? 'active' : ''}`} onClick={() => setSelMode('group')}>
          Theo ngách
        </button>
      </div>

      <Row style={{ gap: '0.75rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        {selMode === 'group' && (
          <Field label="Ngách">
            <select class="input" value={selGroup} onInput={(e) => setSelGroup((e.target as HTMLSelectElement).value)} style={{ width: '12rem' }}>
              <option value="">— chọn —</option>
              {groups.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </Field>
        )}
        <Field label="Video mới trong" sublabel="ngày">
          <Input type="number" min={1} max={90} value={String(days)} onInput={(e) => setDays(Number((e.target as HTMLInputElement).value) || 28)} style={{ width: '5.5rem' }} />
        </Field>
        <Field label="Max results" sublabel="mỗi keyword">
          <Input type="number" min={1} max={100} value={String(maxResults)} onInput={(e) => setMaxResults(Number((e.target as HTMLInputElement).value) || 50)} style={{ width: '5.5rem' }} />
        </Field>
        <Field label="Cap kênh" sublabel="mỗi keyword">
          <Input type="number" min={1} max={50} value={String(cap)} onInput={(e) => setCap(Number((e.target as HTMLInputElement).value) || 10)} style={{ width: '5.5rem' }} />
        </Field>
        <button class="btn secondary" disabled={busy !== null} onClick={() => void doEstimate()}>
          {busy === 'estimate' ? 'Đang tính…' : 'Ước tính'}
        </button>
        <button
          class="btn teal"
          disabled={busy !== null || estimate === null || (running?.status === 'running')}
          title={estimate === null ? 'Ước tính trước khi chạy' : undefined}
          onClick={() => void doRun()}
        >
          {busy === 'run' ? 'Đang khởi tạo…' : `▶ Chạy (${selLabel()})`}
        </button>
      </Row>

      {estimate && (
        <div style={{ border: '1px solid var(--teal)', borderRadius: '10px', padding: '0.6rem 0.8rem', background: 'rgba(31,138,122,0.08)', fontSize: '0.85rem' }}>
          <strong>{estimate.keywords.length} keyword</strong>
          {' · '}ước tính <strong class="num">{fmtInt(estimate.estimatedSearchCalls)}</strong> search calls
          {' · '}quota còn{' '}
          <strong class="num" style={{ color: estimate.quotaRemaining < estimate.estimatedSearchCalls ? 'var(--danger)' : 'var(--teal-deep)' }}>
            {fmtInt(estimate.quotaRemaining)}
          </strong>
        </div>
      )}

      {error && <p class="error" style={{ margin: 0, fontSize: '0.82rem' }}>{error}</p>}
      {notice && <p class="ok" style={{ margin: 0, fontSize: '0.82rem' }}>{notice}</p>}

      {running && (
        <div style={{ border: '1px solid var(--line)', borderRadius: '10px', padding: '0.6rem 0.8rem' }}>
          <Row style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
            <span style={{ fontSize: '0.82rem' }}>
              Run <code>{running.run_id}</code> {runStatusChip(running.status)}
            </span>
            <span class="num" style={{ fontSize: '0.82rem' }}>{running.keywords_done}/{running.n_keywords} keyword · {pct}%</span>
          </Row>
          <div class="spy-progress">
            <div class="spy-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          {running.items.length > 0 && (
            <table class="spy-kw-table" style={{ marginTop: '0.5rem' }}>
              <thead>
                <tr><th>Keyword</th><th>Trạng thái</th><th class="num">KQ</th><th class="num">Followed</th><th class="num">Median</th><th class="num">Outlier</th><th>Lỗi</th></tr>
              </thead>
              <tbody>
                {running.items.map((it) => (
                  <tr key={it.term_key}>
                    <td class="muted" style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>{it.term_key}</td>
                    <td>{it.status === 'done' ? <span class="ok">done</span> : it.status === 'failed' ? <span class="error">failed</span> : <span class="muted">{it.status}</span>}</td>
                    <td class="num">{fmtInt(it.n_results)}</td>
                    <td class="num">{fmtInt(it.n_followed)}</td>
                    <td class="num">{fmtInt(it.median_views)}</td>
                    <td class="num">{fmtInt(it.outliers_found)}</td>
                    <td class="error" style={{ fontSize: '0.72rem' }}>{it.error ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div>
        <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0, fontSize: '0.9rem' }}>Lịch sử run</h3>
          <button class="btn secondary" style={{ fontSize: '0.72rem', padding: '0.15rem 0.6rem', minHeight: 0, height: 'auto' }} onClick={() => void loadHistory()}>⟳</button>
        </Row>
        {histError && <p class="error" style={{ margin: '0.3rem 0 0', fontSize: '0.78rem' }}>{histError}</p>}
        {!histError && history.length === 0 && <p class="muted" style={{ fontSize: '0.82rem' }}>Chưa có run nào.</p>}
        {history.length > 0 && (
          <div style={{ overflowX: 'auto', marginTop: '0.4rem' }}>
            <table class="spy-kw-table">
              <thead>
                <tr><th>Run</th><th>Trạng thái</th><th class="num">Keyword</th><th class="num">Search calls</th><th>Bắt đầu</th><th>Kết thúc</th></tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <Fragment key={r.run_id}>
                    <tr onClick={() => void toggleExpand(r.run_id)} style={{ cursor: 'pointer' }} title="Click xem items">
                      <td class="muted" style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>{r.run_id}</td>
                      <td>{runStatusChip(r.status)}</td>
                      <td class="num">{r.keywords_done}/{r.n_keywords}</td>
                      <td class="num">{fmtInt(r.search_calls_used)}</td>
                      <td class="muted" style={{ fontSize: '0.78rem' }}>{relDate(r.started_at)}</td>
                      <td class="muted" style={{ fontSize: '0.78rem' }}>{relDate(r.finished_at)}</td>
                    </tr>
                    {expanded?.run_id === r.run_id && (
                      <tr>
                        <td colSpan={6} style={{ padding: '0.4rem 0.8rem', background: 'rgba(0,0,0,0.02)' }}>
                          <table class="spy-kw-table">
                            <thead>
                              <tr><th>Keyword</th><th>Trạng thái</th><th class="num">KQ</th><th class="num">Followed</th><th class="num">Median</th><th class="num">Outlier</th></tr>
                            </thead>
                            <tbody>
                              {expanded.items.map((it) => (
                                <tr key={it.term_key}>
                                  <td class="muted" style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>{it.term_key}</td>
                                  <td>{it.status}</td>
                                  <td class="num">{fmtInt(it.n_results)}</td>
                                  <td class="num">{fmtInt(it.n_followed)}</td>
                                  <td class="num">{fmtInt(it.median_views)}</td>
                                  <td class="num">{fmtInt(it.outliers_found)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Panel>
  );
}
