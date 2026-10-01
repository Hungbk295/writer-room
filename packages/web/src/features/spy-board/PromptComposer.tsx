/**
 * Soạn prompt cho agent — card dùng chung ở Màn 1/2/3. Người chọn mẫu việc, xem
 * tóm tắt dữ liệu đã tick, thêm ghi chú → server tạo phiếu + prompt → người bấm
 * Copy rồi dán vào CLI có MCP Writer Room. Kết quả hiện ở Màn 5 · Agent.
 */
import { useState } from 'preact/hooks';
import type { AgentSelection, AgentTemplate } from '../../api.ts';
import { createTask } from './data.ts';
import { Icon, nicheLabel } from './lib.tsx';

export const AGENT_LABEL: Record<AgentTemplate, string> = {
  compare_niches: 'So sánh tệp',
  outlier_patterns: 'Phân tích outlier',
  audience_pains: 'Nỗi đau khán giả',
  keyword_ideas: 'Đề xuất keyword',
  next_steps: 'Lượt tiếp theo',
};

/** Mẫu hợp lệ theo ngữ cảnh + dữ liệu đã chọn (cùng điều kiện với server). */
export function validTemplates(ctx: 'niches' | 'videos' | 'keywords', o: { videos?: number; niche?: string | null }): AgentTemplate[] {
  if (ctx === 'niches') return ['compare_niches'];
  if (ctx === 'keywords') return o.niche === undefined ? [] : ['keyword_ideas', 'next_steps'];
  const n = o.videos ?? 0;
  const out: AgentTemplate[] = [];
  if (n >= 2) out.push('outlier_patterns');
  if (n >= 1) out.push('audience_pains');
  out.push('keyword_ideas', 'next_steps');
  return out;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { return document.execCommand('copy'); } finally { ta.remove(); }
  }
}

export function CopyButton({ text, label = 'Copy prompt' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      class="sb-btn secondary"
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} size={16} />{copied ? 'Đã copy ✓' : label}
    </button>
  );
}

export function PromptComposer({ topicId, templates, niche, selection, summary, emptyHint, onClose }: {
  topicId: string;
  templates: AgentTemplate[];
  /** undefined = không gắn ngách (Màn 1). */
  niche: string | null | undefined;
  selection: AgentSelection;
  summary: string;
  emptyHint?: string;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<AgentTemplate | null>(null);
  const template = picked && templates.includes(picked) ? picked : templates[0] ?? null;
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ promptId: string; promptText: string } | null>(null);

  const create = async () => {
    if (!template) return;
    setBusy(true);
    setError(null);
    try {
      setMade(await createTask(topicId, { template, niche, selection, note: note.trim() || undefined }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="sb-card sb-stack sb-stack-sm">
      <div class="sb-bar">
        <h2 class="sb-h2">Soạn prompt cho agent</h2>
        <button class="sb-btn secondary sm" onClick={onClose}>Đóng</button>
      </div>

      {templates.length === 0 ? (
        <div class="sb-empty">{emptyHint ?? 'Chưa có mẫu phù hợp với dữ liệu đã chọn.'}</div>
      ) : (
        <>
          <div class="sb-tabs">
            {templates.map((t) => (
              <button key={t} class={`sb-nav-item ${template === t ? 'active' : ''}`} onClick={() => { setPicked(t); setMade(null); }}>
                {AGENT_LABEL[t]}
              </button>
            ))}
          </div>
          <div class="sb-text">
            {niche !== undefined && <span class="sb-mr">Ngách: <b>{nicheLabel(niche)}</b> ·</span>}
            {summary}
          </div>
          <input
            class="sb-input"
            placeholder="Ghi chú cho agent (tuỳ chọn)"
            value={note}
            maxLength={500}
            onInput={(e) => setNote((e.target as HTMLInputElement).value)}
          />
          <div class="sb-actions">
            <button class="sb-btn primary" disabled={busy || !template} onClick={() => void create()}>
              <Icon name="sparkles" size={16} />Tạo prompt
            </button>
          </div>
        </>
      )}
      {error && <div class="sb-alert">{error}</div>}

      {made && (
        <div class="sb-stack sb-stack-sm">
          <pre class="sb-code" aria-label="Prompt">{made.promptText}</pre>
          <div class="sb-actions">
            <CopyButton text={made.promptText} />
            <span class="sb-hint">Dán vào Claude/Codex CLI có MCP Writer Room. Kết quả sẽ hiện ở màn 5 · Agent.</span>
          </div>
        </div>
      )}
    </section>
  );
}
