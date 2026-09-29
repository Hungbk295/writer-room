/**
 * Tab "Board" của 1 topic spy — 5 màn, mỗi màn một quyết định (plan
 * spy-analyst-workflow §G): Chọn tệp → Ngách → Keyword → Lượt chạy → Agent.
 * Thanh trên: độ tươi dữ liệu (lượt Theo dõi / Tìm mới gần nhất). Bảng điểm tải
 * một lần ở đây, dùng cho Màn 1, hàng số của Màn 2 và danh sách ngách.
 * Giao diện theo phong cách TailPanel, CSS scope dưới `.spy-board` (board.css).
 */
import { useState } from 'preact/hooks';
import type { BoardScorecardRow } from '../../api.ts';
import { loadScorecard } from './data.ts';
import { AgentScreen } from './AgentScreen.tsx';
import { KeywordsScreen } from './KeywordsScreen.tsx';
import { NicheScreen } from './NicheScreen.tsx';
import { RunsScreen } from './RunsScreen.tsx';
import { ScorecardScreen } from './ScorecardScreen.tsx';
import { Badge, Icon, IS_MOCK, LoadState, nicheLabel, relDate, useLoad } from './lib.tsx';
import './board.css';

type Screen = 'scorecard' | 'niche' | 'keywords' | 'runs' | 'agent';

const SCREENS: Array<{ key: Screen; label: string; question: string }> = [
  { key: 'scorecard', label: '1 · Chọn tệp', question: 'Tệp nào cho kênh nhỏ sàn view cao nhất?' },
  { key: 'niche', label: '2 · Ngách', question: 'Học video/kênh nào, đào sâu gì?' },
  { key: 'keywords', label: '3 · Keyword', question: 'Keyword nào chạy tiếp?' },
  { key: 'runs', label: '4 · Lượt chạy', question: 'Có đang tốn quota vô ích không?' },
  { key: 'agent', label: '5 · Agent', question: 'Agent đã phân tích gì, áp dụng gì?' },
];

export function SpyBoardTab({ topicId }: { topicId: string }) {
  const [screen, setScreen] = useState<Screen>('scorecard');
  const [niche, setNiche] = useState<string | null | undefined>(undefined);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey((k) => k + 1);

  const board = useLoad(() => loadScorecard(topicId), [topicId, refreshKey]);
  const rows: BoardScorecardRow[] = board.data?.data ?? [];
  const niches = rows.map((r) => r.niche);
  if (!niches.includes(null)) niches.push(null);
  // Màn 2 cần một ngách cụ thể: mặc định ngách sàn cao nhất.
  const nicheForScreen2 = niche !== undefined
    ? niche
    : [...rows].filter((r) => r.niche !== null).sort((a, b) => (b.floorSmall ?? -1) - (a.floorSmall ?? -1))[0]?.niche ?? null;
  const current = SCREENS.find((s) => s.key === screen)!;

  return (
    <div class="spy-board">
      <div class="sb-page-head">
        <div>
          <h1 class="sb-h1">{current.label.replace(/^\d · /, '')}</h1>
          <p class="sb-sub">{current.question}</p>
        </div>
        <div class="sb-fresh">
          {IS_MOCK && <Badge tone="warning">mock</Badge>}
          <Badge><Icon name="clock" size={12} />Theo dõi: {relDate(board.data?.freshness.lastTrackAt)}</Badge>
          <Badge><Icon name="clock" size={12} />Tìm mới: {relDate(board.data?.freshness.lastDiscoverAt)}</Badge>
          <button class="sb-btn secondary" onClick={refresh} disabled={board.loading}>
            <Icon name="refresh" size={16} />Tải lại
          </button>
        </div>
      </div>

      <div class="sb-nav" role="tablist">
        {SCREENS.map((s) => (
          <button key={s.key} role="tab" aria-selected={screen === s.key} class={`sb-nav-item ${screen === s.key ? 'active' : ''}`} onClick={() => setScreen(s.key)}>
            {s.label}
          </button>
        ))}
        {screen === 'niche' && (
          <select
            class="sb-select sb-nav-select"
            value={nicheForScreen2 ?? '_none'}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              setNiche(v === '_none' ? null : v);
            }}
          >
            {niches.map((n) => <option key={n ?? '_none'} value={n ?? '_none'}>{nicheLabel(n)}</option>)}
          </select>
        )}
      </div>

      {screen !== 'runs' && screen !== 'keywords' && screen !== 'agent' && <LoadState state={board} empty={!board.loading && !board.error && rows.length === 0} />}

      {screen === 'scorecard' && rows.length > 0 && (
        <ScorecardScreen topicId={topicId} rows={rows} onOpenNiche={(n) => { setNiche(n); setScreen('niche'); }} />
      )}
      {screen === 'niche' && board.data && (
        <NicheScreen
          topicId={topicId}
          niche={nicheForScreen2}
          niches={niches}
          score={rows.find((r) => r.niche === nicheForScreen2) ?? null}
          refreshKey={refreshKey}
          onChanged={refresh}
        />
      )}
      {screen === 'keywords' && (
        <KeywordsScreen topicId={topicId} niche={niche} niches={niches} refreshKey={refreshKey} onRunFinished={refresh} />
      )}
      {screen === 'runs' && <RunsScreen topicId={topicId} refreshKey={refreshKey} />}
      {screen === 'agent' && <AgentScreen topicId={topicId} refreshKey={refreshKey} />}
    </div>
  );
}
