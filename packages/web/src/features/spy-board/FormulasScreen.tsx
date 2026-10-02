/**
 * Màn "Công thức" — render báo cáo verify công thức (schema v1,
 * spy-runs/<topic>/*-formula-verify.json) do run ghi ra.
 * Mỗi công thức = 1 card: skeleton + verdict + độ lặp theo tier kênh
 * + bảng 5 slot (slot xoay điền từ trigger pool, slot bền = lõi).
 */
import type { BoardFormula, BoardFormulasReport, FormulaSlot, FormulaVerdict } from '../../api.ts';
import { Badge, fmtNum, Icon, LoadState, useLoad } from './lib.tsx';
import { loadFormulas } from './data.ts';

const SLOT_ORDER = ['trigger', 'visible_behavior', 'contradiction', 'mechanism', 'title_render'] as const;
const SLOT_LABEL: Record<(typeof SLOT_ORDER)[number], string> = {
  trigger: 'Trigger',
  visible_behavior: 'Hành vi thấy được',
  contradiction: 'Nghịch lý kinh tế',
  mechanism: 'Cơ chế tiền',
  title_render: 'Title',
};

const VERDICT: Record<string, { tone: 'success' | 'warning' | 'danger' | 'secondary'; label: string }> = {
  live: { tone: 'success', label: 'SỐNG' },
  weak: { tone: 'warning', label: 'YẾU' },
  rejected: { tone: 'danger', label: 'LOẠI' },
};

function verdictBadge(v: string) {
  const d = VERDICT[v as FormulaVerdict] ?? { tone: 'secondary' as const, label: v.toUpperCase() };
  return <Badge tone={d.tone}>{d.label}</Badge>;
}

function SlotRow({ name, slot }: { name: (typeof SLOT_ORDER)[number]; slot: FormulaSlot | string | undefined }) {
  if (!slot) return null;
  const desc = typeof slot === 'string' ? slot : slot.desc;
  const examples = typeof slot === 'string' ? undefined : slot.examples;
  const rotating = typeof slot === 'string' ? undefined : slot.rotating;
  return (
    <tr>
      <td style={{ width: '1%', whiteSpace: 'nowrap', fontWeight: 600 }}>{SLOT_LABEL[name]}</td>
      <td style={{ width: '1%', whiteSpace: 'nowrap' }}>
        {rotating === true && <Badge tone="primary">XOAY</Badge>}
        {rotating === false && <Badge>BỀN</Badge>}
        {name === 'mechanism' && <Badge tone="warning">LÕI</Badge>}
      </td>
      <td>
        {desc}
        {examples && examples.length > 0 && (
          <div class="sb-slot-examples">vd: {examples.slice(0, 4).join(' · ')}</div>
        )}
      </td>
    </tr>
  );
}

function FormulaCard({ f }: { f: BoardFormula }) {
  const rep = f.repeatability;
  const rejected = f.verdict === 'rejected';
  return (
    <div class={`sb-card sb-formula ${rejected ? 'sb-formula-rejected' : ''}`}>
      <div class="sb-formula-head">
        <Badge>{f.id}</Badge>
        <h3 class="sb-formula-skeleton">{f.skeleton}</h3>
        {verdictBadge(f.verdict)}
      </div>

      {rep && (
        <div class="sb-formula-rep">
          <span title="Kênh <10K subs lặp skeleton"><Badge tone="success">&lt;10K: {rep.channels_lt10k ?? 0}</Badge></span>
          <span title="Kênh 10–50K subs"><Badge>10–50K: {rep.channels_10_50k ?? 0}</Badge></span>
          <span title="Kênh >50K subs"><Badge>&gt;50K: {rep.channels_gt50k ?? 0}</Badge></span>
          {rep.proof && <span class="sb-slot-examples">{rep.proof}</span>}
        </div>
      )}

      {f.reject_reason && <div class="sb-alert">{f.reject_reason}</div>}

      {f.slots && (
        <div class="sb-table-wrap">
          <table class="sb-table sb-slot-table">
            <thead>
              <tr><th>Slot</th><th>Kiểu</th><th>Nội dung</th></tr>
            </thead>
            <tbody>
              {SLOT_ORDER.map((s) => <SlotRow key={s} name={s} slot={f.slots?.[s]} />)}
            </tbody>
          </table>
        </div>
      )}

      {f.packaging && f.packaging.length > 0 && (
        <div class="sb-formula-pack">
          <span class="sb-slot-label">Cách đóng gói:</span>
          {f.packaging.map((p) => <code key={p} class="sb-pack-code">{p}</code>)}
        </div>
      )}

      {f.evidence && f.evidence.length > 0 && (
        <div class="sb-table-wrap">
          <table class="sb-table">
            <thead>
              <tr><th>Kênh</th><th class="num">Subs</th><th class="num">Video</th><th class="num">Top views</th><th>Ghi chú</th><th>Thấy lần cuối</th></tr>
            </thead>
            <tbody>
              {f.evidence.map((e) => (
                <tr key={e.channel}>
                  <td>{e.channel}</td>
                  <td class={`num ${e.subs != null && e.subs < 10_000 ? 'sb-score-hot' : ''}`}>{e.subs == null ? '—' : fmtNum(e.subs)}</td>
                  <td class="num">{e.videos ?? '—'}</td>
                  <td class="num">{fmtNum(e.topViews)}</td>
                  <td>{e.note ?? ''}</td>
                  <td>{e.lastSeen ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function FormulasScreen({ topicId }: { topicId: string }) {
  const state = useLoad(() => loadFormulas(topicId), [topicId]);
  const report: BoardFormulasReport | null = state.data?.data ?? null;
  const formulas = (report?.formulas ?? []).slice().sort((a, b) => {
    const order: Record<string, number> = { live: 0, weak: 1, rejected: 2 };
    return (order[a.verdict] ?? 3) - (order[b.verdict] ?? 3);
  });

  return (
    <div class="sb-stack">
      <LoadState state={state} empty={!state.loading && !state.error && report === null} />
      {!report && !state.loading && !state.error && (
        <div class="sb-empty">
          Chưa có báo cáo verify — một lượt verify ghi file JSON vào <code>writer-room-data/spy-runs/{topicId}/</code> sẽ hiện ở đây.
        </div>
      )}

      {report && (
        <>
          <div class="sb-card">
            <div class="sb-formula-meta">
              <Badge><Icon name="clock" size={12} />{String(report.meta?.date ?? '—')}</Badge>
              <Badge>verify: {String(report.meta?.verifyRule ?? '—')}</Badge>
              {report.meta?.runId && <Badge title={String(report.meta.runId)}>run {String(report.meta.runId).slice(0, 8)}</Badge>}
              {state.data?.file && <Badge>{state.data.file}</Badge>}
            </div>
          </div>

          <div class="sb-stack">
            {formulas.map((f) => <FormulaCard key={f.id} f={f} />)}
          </div>

          {report.keywordHealth && report.keywordHealth.length > 0 && (
            <div class="sb-card">
              <h3 class="sb-card-sub">Sức khoẻ keyword (probe)</h3>
              <div class="sb-table-wrap">
                <table class="sb-table">
                  <thead><tr><th>Keyword</th><th class="num">Median views</th><th class="num">Outliers</th><th>Nhận định</th></tr></thead>
                  <tbody>
                    {report.keywordHealth.map((k) => (
                      <tr key={k.term}>
                        <td>{k.term}</td>
                        <td class="num">{fmtNum(k.medianViews)}</td>
                        <td class="num">{k.outliers ?? '—'}</td>
                        <td>{k.note ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {report.modelChannels && report.modelChannels.length > 0 && (
            <div class="sb-card">
              <h3 class="sb-card-sub">Kênh mẫu</h3>
              <div class="sb-formula-pack">
                {report.modelChannels.map((c) => (
                  <Badge key={c.channel} tone="primary" title={c.why}>
                    {c.channel}{c.subs != null ? ` (${fmtNum(c.subs)})` : ''}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {report.nextActions && report.nextActions.length > 0 && (
            <div class="sb-card">
              <h3 class="sb-card-sub">Bước tiếp theo</h3>
              <ul class="sb-actions">
                {report.nextActions.map((a, i) => (
                  <li key={i}>
                    {a.type && <Badge>{a.type}</Badge>} {a.title ?? a.item ?? ''}{a.from ? ` (từ ${a.from})` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
