/**
 * Màn 5 · Agent — "agent đã phân tích gì, áp dụng gì?" (plan spy-analyst-workflow §J).
 * Danh sách phiếu (mới nhất trước); phiếu đã nộp mở ra xem kết quả theo mẫu.
 * Agent chỉ đề xuất — mọi thay đổi (tạm dừng, thêm keyword, Tìm mới, Đào sâu,
 * Theo dõi) do người bấm nút áp dụng ngay trên dòng đó.
 */
import { createContext } from 'preact';
import { useContext, useState } from 'preact/hooks';
import { api, type AgentResultMap, type AgentTemplate, type BoardAgentTask } from '../../api.ts';
import { loadLabels, loadTasks, type IdLabels } from './data.ts';
import { Badge, IS_MOCK, Icon, LoadState, type IconName, nicheLabel, relDate, useLoad, type BadgeTone } from './lib.tsx';
import { AGENT_LABEL, CopyButton } from './PromptComposer.tsx';

const NO_LABELS: IdLabels = { videos: {}, channels: {} };
const LabelsContext = createContext<IdLabels>(NO_LABELS);

function short(text: string, n = 56): string {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

export function AgentScreen({ topicId, refreshKey }: { topicId: string; refreshKey: number }) {
  const state = useLoad(() => loadTasks(topicId), [topicId, refreshKey]);
  const labels = useLoad(() => loadLabels(topicId), [topicId, refreshKey]);
  const [open, setOpen] = useState<string | null>(null);
  const rows = state.data ?? [];

  return (
    <LabelsContext.Provider value={labels.data ?? NO_LABELS}>
    <div class="sb-stack">
      <LoadState state={state} empty={!state.loading && !state.error && rows.length === 0} />
      {rows.length > 0 && (
        <section class="sb-card sb-card-flush">
          <div class="sb-list sb-list-flush">
            {rows.map((t) => (
              <TaskRow key={t.promptId} task={t} topicId={topicId} open={open === t.promptId} onToggle={() => setOpen(open === t.promptId ? null : t.promptId)} />
            ))}
          </div>
        </section>
      )}
    </div>
    </LabelsContext.Provider>
  );
}

function TaskRow({ task, topicId, open, onToggle }: { task: BoardAgentTask; topicId: string; open: boolean; onToggle: () => void }) {
  const pending = task.status === 'pending';
  const sub = [
    task.template === 'compare_niches' ? 'mọi ngách' : `ngách ${nicheLabel(task.niche)}`,
    relDate(task.createdAt),
    task.submittedBy ? `nộp bởi ${task.submittedBy}` : null,
    task.note ? `“${task.note}”` : null,
  ].filter(Boolean).join(' · ');
  return (
    <div class={`sb-run ${open ? 'is-open' : ''}`}>
      <div class="sb-task-head">
        <button class="sb-list-row" onClick={onToggle} aria-expanded={open}>
          <div class="sb-list-main">
            <div class="sb-list-title">{AGENT_LABEL[task.template]}</div>
            <div class="sb-list-sub">{sub}</div>
          </div>
          <div class="sb-list-side">
            <Badge tone={pending ? 'warning' : 'success'}>{pending ? 'Chờ kết quả' : 'Đã nộp'}</Badge>
          </div>
        </button>
        {pending && <div class="sb-task-copy"><CopyButton text={task.promptText} label="Copy lại prompt" /></div>}
      </div>
      {open && (
        <div class="sb-run-body">
          {task.result
            ? <TaskResult task={task} topicId={topicId} />
            : <div class="sb-empty">Agent chưa nộp kết quả. Copy prompt, dán vào CLI có MCP Writer Room rồi tải lại.</div>}
        </div>
      )}
    </div>
  );
}

// ── Nút áp dụng: chạy → ✓ hoặc lỗi ngay tại dòng ───────────────────────────

function Apply({ label, done, run, disabled, primary, icon }: {
  label: string;
  done?: string;
  primary?: boolean;
  icon?: IconName;
  run: () => Promise<unknown>;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (IS_MOCK) await new Promise((r) => setTimeout(r, 400));
      else await run();
      setOk(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span class="sb-apply">
      {ok
        ? <Badge tone="success"><Icon name="check" size={12} />{done ?? 'Đã áp dụng'}</Badge>
        : <button class={`sb-btn ${primary ? 'primary' : 'secondary sm'}`} disabled={busy || disabled} onClick={() => void go()}>
            {icon && <Icon name={icon} size={16} />}{busy ? 'Đang chạy…' : label}
          </button>}
      {err && <span class="sb-apply-err">{err}</span>}
    </span>
  );
}

function VideoChips({ ids }: { ids: string[] }) {
  const labels = useContext(LabelsContext);
  return (
    <span class="sb-chips">
      {ids.map((id) => {
        const title = labels.videos[id];
        return (
          <a
            key={id}
            class="sb-chip"
            href={`https://www.youtube.com/watch?v=${id}`}
            target="_blank"
            rel="noreferrer"
            title={title ? `${title} · ${id}` : id}
          >
            {title ? short(title) : id}
          </a>
        );
      })}
    </span>
  );
}

function ChannelName({ id }: { id: string }) {
  const name = useContext(LabelsContext).channels[id];
  return <a href={`https://www.youtube.com/channel/${id}`} target="_blank" rel="noreferrer" title={id}>{name ?? id}</a>;
}

// ── Hiển thị kết quả theo mẫu ───────────────────────────────────────────────

function TaskResult({ task, topicId }: { task: BoardAgentTask; topicId: string }) {
  const t = task.template as AgentTemplate;
  const r = task.result;
  if (!r) return null;
  if (t === 'compare_niches') return <CompareView r={r as AgentResultMap['compare_niches']} />;
  if (t === 'outlier_patterns') return <PatternsView r={r as AgentResultMap['outlier_patterns']} />;
  if (t === 'audience_pains') return <PainsView r={r as AgentResultMap['audience_pains']} />;
  if (t === 'keyword_ideas') return <KeywordIdeasView r={r as AgentResultMap['keyword_ideas']} task={task} topicId={topicId} />;
  return <NextStepsView r={r as AgentResultMap['next_steps']} task={task} topicId={topicId} />;
}

const VERDICT: Record<'choose' | 'maybe' | 'drop', { tone: BadgeTone; label: string }> = {
  choose: { tone: 'success', label: 'Chọn' },
  maybe: { tone: 'warning', label: 'Cân nhắc' },
  drop: { tone: 'danger', label: 'Bỏ' },
};

function Section({ title, children }: { title: string; children: preact.ComponentChildren }) {
  return (
    <div class="sb-result-section">
      <h3 class="sb-h3">{title}</h3>
      {children}
    </div>
  );
}

function CompareView({ r }: { r: AgentResultMap['compare_niches'] }) {
  return (
    <div class="sb-stack sb-stack-sm">
      <div class="sb-verdict-line">
        {r.pick
          ? <><Badge tone="success">Chốt</Badge><b>{r.pick}</b></>
          : <Badge tone="warning">Chưa đủ bằng chứng</Badge>}
      </div>
      <div class="sb-table-wrap sb-table-boxed">
        <table class="sb-table">
          <thead><tr><th>Ngách</th><th>Kết luận</th><th>Lý do</th></tr></thead>
          <tbody>
            {r.ranking.map((x, i) => (
              <tr key={x.niche}>
                <td class="sb-strong"><span class="sb-rank">{i + 1}</span>{x.niche}</td>
                <td><Badge tone={VERDICT[x.verdict].tone}>{VERDICT[x.verdict].label}</Badge></td>
                <td class="sb-wrap">{x.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {r.missingEvidence.length > 0 && (
        <Section title="Còn thiếu bằng chứng">
          <ul class="sb-bullets">{r.missingEvidence.map((m) => <li key={m}>{m}</li>)}</ul>
        </Section>
      )}
    </div>
  );
}

function PatternsView({ r }: { r: AgentResultMap['outlier_patterns'] }) {
  return (
    <div class="sb-stack sb-stack-sm">
      <div class="sb-grid sb-grid-2">
        {r.patterns.map((p) => (
          <div key={p.name} class="sb-subcard">
            <div class="sb-list-title sb-semibold">{p.name}</div>
            <p class="sb-text sb-mt">{p.description}</p>
            <div class="sb-mt"><VideoChips ids={p.videoIds} /></div>
          </div>
        ))}
      </div>
      {r.titleTemplates.length > 0 && (
        <Section title="Khuôn tiêu đề">
          <ul class="sb-bullets">{r.titleTemplates.map((t) => <li key={t}>{t}</li>)}</ul>
        </Section>
      )}
    </div>
  );
}

const FREQ: Record<'high' | 'medium' | 'low', { tone: BadgeTone; label: string }> = {
  high: { tone: 'danger', label: 'Rất hay gặp' },
  medium: { tone: 'warning', label: 'Khá hay gặp' },
  low: { tone: 'secondary', label: 'Ít gặp' },
};

function PainsView({ r }: { r: AgentResultMap['audience_pains'] }) {
  return (
    <div class="sb-stack sb-stack-sm">
      {r.pains.map((p) => (
        <div key={p.pain} class="sb-subcard">
          <div class="sb-bar">
            <div class="sb-list-title sb-semibold">{p.pain}</div>
            <Badge tone={FREQ[p.frequency].tone}>{FREQ[p.frequency].label}</Badge>
          </div>
          {p.quotes.map((q) => (
            <blockquote key={q.text} class="sb-quote">
              {q.text}
              <cite><VideoChips ids={[q.videoId]} /></cite>
            </blockquote>
          ))}
        </div>
      ))}
      {r.questions.length > 0 && (
        <Section title="Câu hỏi lặp lại">
          <ul class="sb-bullets">{r.questions.map((q) => <li key={q}>{q}</li>)}</ul>
        </Section>
      )}
    </div>
  );
}

function KeywordIdeasView({ r, task, topicId }: { r: AgentResultMap['keyword_ideas']; task: BoardAgentTask; topicId: string }) {
  return (
    <div class="sb-stack sb-stack-sm">
      <Section title={`Nên dừng (${r.stop.length})`}>
        {r.stop.length === 0 ? <div class="sb-hint">Không có keyword nào cần dừng.</div> : (
          <div class="sb-table-wrap sb-table-boxed">
            <table class="sb-table">
              <thead><tr><th>Keyword</th><th>Lý do</th><th /></tr></thead>
              <tbody>
                {r.stop.map((s) => (
                  <tr key={s.termKey}>
                    <td class="sb-strong">{s.termKey}</td>
                    <td class="sb-wrap">{s.reason}</td>
                    <td class="sb-act">
                      <Apply
                        label="Tạm dừng"
                        done="Đã tạm dừng"
                        run={() => api.spyKeywordDecide({ topic_id: topicId, term_keys: [s.termKey], to_status: 'paused', reason: s.reason })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section title={`Nên thử (${r.try.length})`}>
        {r.try.length === 0 ? <div class="sb-hint">Agent không đề xuất keyword mới.</div> : (
          <div class="sb-table-wrap sb-table-boxed">
            <table class="sb-table">
              <thead><tr><th>Keyword</th><th>Lý do</th><th>Bằng chứng</th><th /></tr></thead>
              <tbody>
                {r.try.map((k) => (
                  <tr key={k.term}>
                    <td class="sb-strong">{k.term}</td>
                    <td class="sb-wrap">{k.reason}</td>
                    <td><VideoChips ids={k.evidenceVideoIds} /></td>
                    <td class="sb-act">
                      <Apply
                        label="Thêm (chờ duyệt)"
                        done="Đã thêm"
                        run={() => api.spyKeywordBulkAdd({ topicId, terms: [k.term], group: task.niche ?? undefined, activate: false })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

function byPriority<T extends { priority: number }>(xs: T[]): T[] {
  return [...xs].sort((a, b) => a.priority - b.priority);
}

function Priority({ n }: { n: number }) {
  return <Badge tone={n <= 1 ? 'danger' : n === 2 ? 'warning' : 'secondary'}>Ưu tiên {n}</Badge>;
}

function NextStepsView({ r, task, topicId }: { r: AgentResultMap['next_steps']; task: BoardAgentTask; topicId: string }) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };
  const deep = byPriority(r.deepdive);
  return (
    <div class="sb-stack sb-stack-sm">
      <Section title={`Tìm mới (${r.discover.length})`}>
        {r.discover.length === 0 ? <div class="sb-hint">Không có đề xuất.</div> : (
          <div class="sb-list sb-list-inner">
            {byPriority(r.discover).map((d) => (
              <div key={d.termKey} class="sb-step">
                <div class="sb-list-main">
                  <div class="sb-list-title"><Priority n={d.priority} /> <span class="sb-strong">{d.termKey}</span></div>
                  <div class="sb-list-sub">{d.reason}</div>
                </div>
                <Apply label="Tìm mới" done="Đã chạy" run={() => api.spyKeywordRun({ topicId, termKeys: [d.termKey], note: `Agent ${task.promptId}` })} />
              </div>
            ))}
          </div>
        )}
      </Section>
      <Section title={`Đào sâu (${r.deepdive.length})`}>
        {r.deepdive.length === 0 ? <div class="sb-hint">Không có đề xuất.</div> : (
          <>
            <div class="sb-list sb-list-inner">
              {deep.map((d) => (
                <label key={d.videoId} class="sb-step sb-step-pick">
                  <input type="checkbox" checked={picked.has(d.videoId)} onChange={() => toggle(d.videoId)} />
                  <div class="sb-list-main">
                    <div class="sb-list-title"><Priority n={d.priority} /> <VideoChips ids={[d.videoId]} /></div>
                    <div class="sb-list-sub">{d.reason}</div>
                  </div>
                </label>
              ))}
            </div>
            <div class="sb-actions sb-mt">
              {/* key theo tập tick: đổi tick thì ✓ tự reset. */}
              <Apply
                key={[...picked].join('|')}
                primary
                icon="layers"
                disabled={picked.size === 0}
                label={`Đào sâu ${picked.size} video`}
                done={`Đã đưa ${picked.size} video vào Đào sâu`}
                run={() => api.boardDeepDive({ topicId, videoIds: [...picked], note: `Agent ${task.promptId}`, niche: task.niche ?? undefined })}
              />
            </div>
          </>
        )}
      </Section>
      <Section title={`Theo dõi (${r.follow.length})`}>
        {r.follow.length === 0 ? <div class="sb-hint">Không có đề xuất.</div> : (
          <div class="sb-list sb-list-inner">
            {r.follow.map((f) => (
              <div key={f.channelId} class="sb-step">
                <div class="sb-list-main">
                  <div class="sb-list-title sb-strong"><ChannelName id={f.channelId} /></div>
                  <div class="sb-list-sub">{f.reason}</div>
                </div>
                <Apply label="Theo dõi" done="Đã đưa vào chờ duyệt" run={() => api.addManualCandidates(topicId, [f.channelId])} />
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
