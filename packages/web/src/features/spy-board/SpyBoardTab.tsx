/**
 * Tab "Board" của 1 topic spy — gồm 3 panel: Keyword health,
 * Run launcher, Outlier board. Giữ state chọn keyword và trigger run
 * chung giữa 2 panel trên; refreshKey bump để refetch sau khi run xong.
 */
import { useState } from 'preact/hooks';
import { KeywordHealthPanel } from './KeywordHealth.tsx';
import { RunLauncherPanel } from './RunLauncher.tsx';
import { OutlierBoardPanel } from './OutlierBoard.tsx';

export function SpyBoardTab({ topicId }: { topicId: string }) {
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [runRequest, setRunRequest] = useState<{ termKeys: string[]; ts: number } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div class="stack">
      <KeywordHealthPanel
        topicId={topicId}
        checked={checked}
        onCheckedChange={(next) => setChecked(next)}
        onRequestRun={(termKeys) => setRunRequest({ termKeys, ts: Date.now() })}
        refreshKey={refreshKey}
      />
      <RunLauncherPanel
        topicId={topicId}
        checked={checked}
        runRequest={runRequest}
        onRunFinished={() => setRefreshKey((k) => k + 1)}
        refreshKey={refreshKey}
      />
      <OutlierBoardPanel topicId={topicId} refreshKey={refreshKey} />
    </div>
  );
}
