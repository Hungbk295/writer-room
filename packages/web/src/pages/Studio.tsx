/**
 * Formula Studio (SDD §12b, ADR-13) — browse rules across videos, pick them, see what
 * overlaps, and (P3, added 2026-08-10) let an LLM propose one generic merged
 * statement per cluster for a human to accept / edit-then-accept / reject.
 *
 * P2 (picking + clustering) stays fully token-free; P3 adds exactly one place that
 * spends a token — the "Ghép bằng LLM" button — and even then only PROPOSES
 * (ADR-13): nothing enters "Formula ghép" without an explicit human decision below.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  api,
  type PoolRule,
  type RuleCluster,
  type RuleProposal,
  type RuleRef,
  type StudioSession,
  type StudioSessionSummary,
} from '../api.ts';
import { href } from '../router.ts';
import { originLabel, statusBadgeClass } from './Training.tsx';
import { DeleteButton } from '../components/ui/DeleteButton.tsx';

function refKey(ref: RuleRef): string {
  return `${ref.formulaId}::${ref.ruleId}`;
}

/** `RuleProposal.decision`/`FormulaRule.mergeOrigin` share the same three-state shape
 * conceptually (pending/accepted-as-is/accepted-edited) but are different enums at
 * different stages of the pipeline (proposal vs. committed compound rule) — kept as
 * two small local labels rather than one shared lookup, since forcing them into one
 * table would need a translation layer for no real reuse (only 1-2 call sites each). */
function mergeOriginLabel(origin: 'CARRIED' | 'SYNTHESIZED' | 'HUMAN_EDITED' | undefined): string {
  if (origin === 'CARRIED') return 'giữ nguyên';
  if (origin === 'HUMAN_EDITED') return 'đã sửa tay';
  return 'đã ghép bằng LLM';
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

  async function remove(id: string) {
    setError(null);
    await api.deleteStudioSession(id);
    setSessions((prev) => (prev ? prev.filter((s) => s.id !== id) : prev));
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
              <li key={s.id} class="pack-row">
                <div>
                  <div class="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
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
                </div>
                <div class="row pack-row-actions" style={{ gap: '0.5rem' }}>
                  <a class="btn secondary" href={href({ name: 'studio-session', id: s.id })}>
                    Mở
                  </a>
                  <DeleteButton
                    title={s.genre}
                    onDelete={() => remove(s.id)}
                  />
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
  const [synthesizing, setSynthesizing] = useState(false);
  // Which proposal is mid-edit ("Sửa rồi duyệt") and the textarea's live value —
  // local-only until the user submits, so typing never round-trips to the server.
  const [editingProposalId, setEditingProposalId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  useEffect(() => {
    void api.getStudioSession(id).then(setSession).catch((e) => setError(e.message));
  }, [id]);

  // Poll while a SYNTHESIZE turn is in flight (P3) — the turn settles via the
  // daemon's `onItemSettled` listener writing straight to the session file, so
  // there is nothing to await on the client beyond "re-fetch until the status
  // leaves RUNNING". Mirrors `FormulaDiscoveryAction.tsx`'s poll-for-status
  // pattern, just polling the session itself instead of a separate status route
  // (see `studio-synthesize.ts`'s doc comment for why no status route exists).
  const sessionIdRef = useRef(id);
  sessionIdRef.current = id;
  useEffect(() => {
    if (session?.synthesizeStatus !== 'RUNNING') return;
    const timer = setInterval(() => {
      void api.getStudioSession(sessionIdRef.current).then(setSession).catch((e) => setError(e.message));
    }, 2000);
    return () => clearInterval(timer);
  }, [session?.synthesizeStatus]);

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

  async function synthesize() {
    if (!session || synthesizing || session.synthesizeStatus === 'RUNNING') return;
    setSynthesizing(true);
    setError(null);
    try {
      // Returns right away with `synthesizeStatus: 'RUNNING'`; the polling effect
      // above takes over from here.
      setSession(await api.synthesizeStudioProposals(session.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSynthesizing(false);
    }
  }

  async function decide(proposal: RuleProposal, decision: 'ACCEPTED' | 'REJECTED', statement?: string) {
    if (!session || saving) return;
    setSaving(true);
    setError(null);
    try {
      // The server rebuilds the compound Formula right after applying the decision,
      // so the response already reflects it — no separate rebuild round-trip needed.
      setSession(await api.decideStudioProposal(session.id, proposal.id, decision, statement));
      setEditingProposalId(null);
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
  const proposalByCluster = new Map(session.proposals.map((p) => [p.clusterId, p]));
  const pendingCount = session.proposals.filter((p) => p.decision === 'PENDING').length;
  const unproposedCount = session.clusters.filter((c) => !proposalByCluster.has(c.id)).length;

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
        <div class="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ marginBottom: 0 }}>
            Ghép bằng LLM ({similar.length} nhóm trùng · {single.length} rule riêng
            {pendingCount > 0 && ` · ${pendingCount} chờ duyệt`})
          </h2>
          <button
            class="btn"
            onClick={() => void synthesize()}
            disabled={session.clusters.length === 0 || synthesizing || session.synthesizeStatus === 'RUNNING'}
          >
            {session.synthesizeStatus === 'RUNNING' ? 'Đang ghép…' : 'Ghép bằng LLM'}
          </button>
        </div>
        <p class="muted" style={{ marginTop: '0.25rem' }}>
          LLM viết một câu chữ chung chung cho MỖI cụm — kể cả rule riêng (không còn tự động giữ
          nguyên văn, vì nguyên văn hay dính chủ đề của video gốc). LLM chỉ đề xuất; không cái nào
          vào "Formula ghép" bên dưới cho tới khi bạn Duyệt.
          {unproposedCount > 0 && ` Còn ${unproposedCount} cụm chưa có đề xuất.`}
        </p>
        {session.synthesizeStatus === 'FAILED' && (
          <p class="error">Ghép thất bại: {session.synthesizeError ?? 'không rõ lý do'}</p>
        )}
        {session.clusters.length === 0 && (
          <p class="muted">Chưa chọn rule nào ở "Kho rule" phía trên.</p>
        )}
        {session.clusters.length > 0 && (
          <ul class="list" style={{ marginTop: '0.5rem' }}>
            {session.clusters.map((cluster: RuleCluster) => {
              const proposal = proposalByCluster.get(cluster.id);
              return (
                <li key={cluster.id}>
                  <div class="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <strong>{cluster.kind === 'SIMILAR' ? `${cluster.members.length} rule giống nhau` : 'Rule riêng'}</strong>
                    {!proposal && <span class="chip warn">chưa có đề xuất</span>}
                    {proposal && proposal.decision === 'PENDING' && <span class="chip warn">chờ duyệt</span>}
                    {proposal && proposal.decision === 'ACCEPTED' && <span class="chip ok">đã duyệt</span>}
                    {proposal && proposal.decision === 'REJECTED' && <span class="chip">đã loại</span>}
                  </div>
                  <p class="meta" style={{ margin: '0.25rem 0' }}>Rule gốc:</p>
                  <ul class="list">
                    {cluster.members.map((m) => (
                      <li key={`${m.sourceFormulaId}-${m.sourceRuleId}`}>
                        {m.statement}
                        <div class="meta"><span>{m.channelTitle}</span></div>
                      </li>
                    ))}
                  </ul>
                  {proposal && (
                    <div style={{ marginTop: '0.5rem' }}>
                      {editingProposalId === proposal.id ? (
                        <div>
                          <textarea
                            style={{ width: '100%', minHeight: '3.5rem' }}
                            value={editText}
                            onInput={(e) => setEditText((e.target as HTMLTextAreaElement).value)}
                          />
                          <div class="row" style={{ gap: '0.5rem', marginTop: '0.35rem' }}>
                            <button
                              class="btn"
                              disabled={saving || !editText.trim()}
                              onClick={() => void decide(proposal, 'ACCEPTED', editText)}
                            >
                              Lưu và duyệt
                            </button>
                            <button class="btn secondary" disabled={saving} onClick={() => setEditingProposalId(null)}>
                              Huỷ
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div>
                          <strong>Đề xuất: </strong>{proposal.statement}
                          {proposal.edited && <span class="chip" style={{ marginLeft: '0.4rem' }}>đã sửa tay</span>}
                          <div class="row" style={{ gap: '0.5rem', marginTop: '0.35rem' }}>
                            <button class="btn" disabled={saving} onClick={() => void decide(proposal, 'ACCEPTED')}>
                              Duyệt
                            </button>
                            <button
                              class="btn secondary"
                              disabled={saving}
                              onClick={() => { setEditingProposalId(proposal.id); setEditText(proposal.statement); }}
                            >
                              Sửa rồi duyệt
                            </button>
                            <button class="btn secondary" disabled={saving} onClick={() => void decide(proposal, 'REJECTED')}>
                              Loại
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
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
            Chưa có rule nào vào bản ghép. Duyệt ít nhất một đề xuất ở "Ghép bằng LLM" phía trên —
            kể cả rule riêng giờ cũng phải qua một đề xuất trước khi vào đây.
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
                    <span>{mergeOriginLabel(rule.mergeOrigin)}</span>
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
