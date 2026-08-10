/**
 * Formula Studio (SDD §12b, ADR-13) — browse rules across videos, pick them, and see
 * what overlaps.
 *
 * This is the P2 slice: everything on this screen is deterministic app code on the
 * daemon side. No model is called and no token is spent by anything here — the LLM
 * only enters at SYNTHESIZE (P3), which is why `SIMILAR` clusters currently show
 * "chờ bước ghép" instead of a merged rule.
 */
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import {
  api,
  type PoolRule,
  type RuleRef,
  type StudioSession,
  type StudioSessionSummary,
} from '../api.ts';
import { href } from '../router.ts';
import { originLabel, statusBadgeClass } from './Training.tsx';

function refKey(ref: RuleRef): string {
  return `${ref.formulaId}::${ref.ruleId}`;
}

export function StudioListPage() {
  const [sessions, setSessions] = useState<StudioSessionSummary[] | null>(null);
  const [genre, setGenre] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    void api.listStudioSessions()
      .then((r) => setSessions(r.sessions))
      .catch((e) => setError(e.message));
  }, []);

  useEffect(reload, [reload]);

  async function create(e: Event) {
    e.preventDefault();
    if (!genre.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const session = await api.createStudioSession(genre.trim());
      location.hash = href({ name: 'studio-session', id: session.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div class="page-header">
        <div>
          <h1 class="page-title">Formula Studio</h1>
          <p class="page-lead">
            Chọn rule từ nhiều video, xem chỗ trùng, ghép thành Formula cho một <strong>thể loại</strong>.
            Bước chọn và gom nhóm không tốn token.
          </p>
        </div>
      </div>

      <section class="panel">
        <h2>Phiên mới</h2>
        <form class="row" style={{ gap: '0.5rem', alignItems: 'center' }} onSubmit={create}>
          <input
            style={{ flex: 1 }}
            placeholder="Tên thể loại, ví dụ: kể chuyện tài chính cá nhân"
            value={genre}
            onInput={(e) => setGenre((e.target as HTMLInputElement).value)}
          />
          <button class="btn" type="submit" disabled={!genre.trim() || busy}>
            {busy ? 'Đang tạo…' : 'Tạo phiên'}
          </button>
        </form>
        <p class="muted" style={{ marginBottom: 0, marginTop: '0.5rem' }}>
          Formula ghép thuộc về một thể loại nội dung, không thuộc về một kênh — một kênh có nhiều
          kiểu bài khác nhau.
        </p>
      </section>

      <section class="panel" style={{ marginTop: '1rem' }}>
        <h2>Phiên đã có</h2>
        {error && <p class="error">{error}</p>}
        {!sessions && <p class="muted">Đang tải…</p>}
        {sessions && sessions.length === 0 && <p class="muted">Chưa có phiên nào.</p>}
        {sessions && sessions.length > 0 && (
          <ul class="list">
            {sessions.map((s) => (
              <li key={s.id}>
                <div class="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <a href={href({ name: 'studio-session', id: s.id })}><strong>{s.genre}</strong></a>
                  <span class={s.status === 'EMPTY' ? 'chip' : statusBadgeClass(s.status)}>
                    {s.status === 'EMPTY' ? 'chưa có rule' : s.status}
                  </span>
                </div>
                <div class="meta">
                  <span>{s.pickCount} rule đã chọn</span>
                  <span>{s.ruleCount} rule trong bản ghép</span>
                  <span>{new Date(s.updatedAt).toLocaleString()}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function StudioSessionPage({ id }: { id: string }) {
  const [session, setSession] = useState<StudioSession | null>(null);
  const [pool, setPool] = useState<PoolRule[] | null>(null);
  const [showOlder, setShowOlder] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api.getStudioSession(id).then(setSession).catch((e) => setError(e.message));
  }, [id]);

  useEffect(() => {
    void api.listRulePool(showOlder).then((r) => setPool(r.rules)).catch((e) => setError(e.message));
  }, [showOlder]);

  const picked = useMemo(
    () => new Set((session?.picks ?? []).map(refKey)),
    [session],
  );

  const visible = useMemo(() => {
    if (!pool) return [];
    const q = query.trim().toLowerCase();
    if (!q) return pool;
    return pool.filter(
      (r) => r.statement.toLowerCase().includes(q) || r.channelTitle.toLowerCase().includes(q),
    );
  }, [pool, query]);

  async function togglePick(rule: PoolRule) {
    if (!session || saving) return;
    const key = refKey(rule);
    const next = picked.has(key)
      ? session.picks.filter((p) => refKey(p) !== key)
      : [...session.picks, { formulaId: rule.formulaId, ruleId: rule.ruleId }];
    setSaving(true);
    setError(null);
    try {
      // The server re-clusters and rebuilds on every pick change, so the response is
      // always the full truth — no local guessing about what the clusters became.
      setSession(await api.setStudioPicks(session.id, next));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function promote() {
    if (!session || saving) return;
    setSaving(true);
    setError(null);
    try {
      setSession(await api.promoteStudioCompound(session.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (error && !session) {
    return (
      <div>
        <p class="error">{error}</p>
        <a class="btn secondary" href={href({ name: 'studio' })}>← Studio</a>
      </div>
    );
  }
  if (!session) return <p class="muted">Đang tải…</p>;

  const similar = session.clusters.filter((c) => c.kind === 'SIMILAR');
  const single = session.clusters.filter((c) => c.kind === 'SINGLE');

  return (
    <div>
      <div class="page-header">
        <div>
          <h1 class="page-title" style={{ marginBottom: 0 }}>{session.genre}</h1>
          <p class="page-lead" style={{ marginBottom: 0 }}>
            {session.picks.length} rule đã chọn · {similar.length} nhóm trùng · {single.length} rule riêng
          </p>
        </div>
        <a class="btn secondary" href={href({ name: 'studio' })}>← Studio</a>
      </div>

      {error && <p class="error">{error}</p>}

      <section class="panel">
        <div class="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ marginBottom: 0 }}>Kho rule</h2>
          <label class="row" style={{ gap: '0.35rem', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={showOlder}
              onChange={(e) => setShowOlder((e.target as HTMLInputElement).checked)}
            />
            <span class="muted">Hiện cả bản cũ</span>
          </label>
        </div>
        <p class="muted" style={{ marginTop: '0.25rem' }}>
          Mặc định chỉ hiện bản mới nhất của mỗi video. Bật "hiện cả bản cũ" để so rule trước và
          sau khi tinh chỉnh.
        </p>
        <input
          style={{ width: '100%', marginTop: '0.5rem' }}
          placeholder="Lọc theo nội dung rule hoặc tên kênh…"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />

        {!pool && <p class="muted">Đang tải kho rule…</p>}
        {pool && pool.length === 0 && (
          <p class="muted">
            Chưa có Formula nào. Tạo vài Formula từ trang Spy (nút "🧪 Tìm Formula") rồi quay lại.
          </p>
        )}
        {pool && pool.length > 0 && (
          <ul class="list" style={{ marginTop: '0.5rem' }}>
            {visible.map((rule) => {
              const key = refKey(rule);
              const on = picked.has(key);
              return (
                <li
                  key={key}
                  onClick={() => void togglePick(rule)}
                  style={{ cursor: 'pointer', opacity: saving ? 0.6 : 1 }}
                >
                  <div class="row" style={{ gap: '0.5rem', alignItems: 'flex-start' }}>
                    <input type="checkbox" checked={on} readOnly style={{ marginTop: '0.25rem' }} />
                    <div style={{ flex: 1 }}>
                      <strong>{rule.statement}</strong>
                      <div class="meta">
                        <span>{rule.channelTitle}</span>
                        <span>{originLabel(rule.formulaOrigin)}</span>
                        {rule.formulaVersion > 1 && <span>v{rule.formulaVersion}</span>}
                        <span>{rule.evidenceCount} bằng chứng</span>
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section class="panel" style={{ marginTop: '1rem' }}>
        <h2>Nhóm trùng ({similar.length})</h2>
        <p class="muted" style={{ marginTop: 0 }}>
          Những rule nói gần giống nhau, đến từ các video khác nhau. Đây là chỗ cần một quyết định
          ghép — bước ghép bằng LLM chưa làm (P3), nên hiện chỉ hiển thị.
        </p>
        {similar.length === 0 && <p class="muted">Chưa có nhóm trùng nào.</p>}
        {similar.map((cluster) => (
          <div key={cluster.id} class="panel" style={{ marginTop: '0.5rem', background: 'rgba(31,138,122,0.05)' }}>
            <div class="row" style={{ justifyContent: 'space-between' }}>
              <strong>{cluster.members.length} rule giống nhau</strong>
              <span class="chip warn">chờ bước ghép</span>
            </div>
            <ul class="list" style={{ marginTop: '0.4rem' }}>
              {cluster.members.map((m) => (
                <li key={`${m.sourceFormulaId}-${m.sourceRuleId}`}>
                  {m.statement}
                  <div class="meta"><span>{m.channelTitle}</span></div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section class="panel" style={{ marginTop: '1rem' }}>
        <div class="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ marginBottom: 0 }}>
            Formula ghép {session.compound && <span class={statusBadgeClass(session.compound.status)}>{session.compound.status}</span>}
          </h2>
          {session.compound && session.compound.rules.length > 0 && session.compound.status === 'DRAFT' && (
            <button class="btn" onClick={() => void promote()} disabled={saving}>
              Duyệt thành TRIAL
            </button>
          )}
        </div>
        {!session.compound || session.compound.rules.length === 0 ? (
          <p class="muted" style={{ marginBottom: 0 }}>
            Chưa có rule nào vào bản ghép. Rule không trùng với rule nào khác sẽ vào thẳng đây;
            rule nằm trong nhóm trùng phải qua bước ghép trước.
          </p>
        ) : (
          <>
            {session.compound.warnings.map((w) => (
              <p key={w} class="muted"><span class="chip warn">Cảnh báo</span> {w}</p>
            ))}
            <ul class="list">
              {session.compound.rules.map((rule) => (
                <li key={rule.id}>
                  <strong>{rule.statement}</strong>
                  <div class="meta">
                    <span>{rule.mergeOrigin === 'CARRIED' ? 'giữ nguyên' : 'đã ghép'}</span>
                    <span>từ {(rule.sources ?? []).length} nguồn</span>
                  </div>
                  <div class="meta">
                    {(rule.sources ?? []).map((s) => (
                      <span key={`${s.sourceFormulaId}-${s.sourceRuleId}`}>{s.channelTitle}</span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
