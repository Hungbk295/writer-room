/**
 * Hộp Đào sâu trên Màn 2 (plan spy-analyst-workflow §H bước 6): video đã tick →
 * kiểm tra trước (cái nào đã có comment/transcript sẽ bị bỏ qua) → ghi chú →
 * chạy → tiến độ từng video. Comment/transcript đọc sau qua agent
 * (spy_read_video_material) hoặc tab Lượt chạy.
 */
import { useEffect, useState } from 'preact/hooks';
import { api, type BoardDeepDiveResponse, type BoardRunDetail } from '../../api.ts';
import { loadLabels, loadRunDetail } from './data.ts';
import { VideoRef } from './VideoRef.tsx';
import { Badge, IS_MOCK, Icon, runStatusChip, useLoad } from './lib.tsx';

export function DeepDiveBox({ topicId, niche, videoIds: initialIds, onClose, onFinished }: {
  topicId: string;
  niche: string | null;
  videoIds: string[];
  onClose: () => void;
  onFinished: () => void;
}) {
  // Chốt danh sách lúc mở hộp — chạy xong lưới bỏ tick, hộp vẫn phải nói về đúng các video đã đào.
  const [videoIds] = useState(initialIds);
  const [plan, setPlan] = useState<BoardDeepDiveResponse | null>(null);
  const [note, setNote] = useState('');
  const [running, setRunning] = useState<BoardRunDetail | null>(null);
  const labels = useLoad(() => loadLabels(topicId, videoIds, []), [topicId, videoIds.join(',')]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    setPlan(null);
    setError(null);
    (IS_MOCK
      ? Promise.resolve<BoardDeepDiveResponse>({
          dryRun: true,
          plan: videoIds.map((videoId, i) => ({ videoId, commentsPresent: i === 0, transcriptPresent: false })),
          toWork: videoIds.length,
        })
      : api.boardDeepDive({ topicId, videoIds, dryRun: true })
    ).then(
      (p) => { if (!dead) setPlan(p); },
      (e: unknown) => { if (!dead) setError(e instanceof Error ? e.message : String(e)); },
    );
    return () => { dead = true; };
  }, [topicId, videoIds.join('|')]);

  const doRun = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = IS_MOCK
        ? { runId: 'run-1' }
        : await api.boardDeepDive({ topicId, videoIds, note: note.trim() || undefined, niche: niche ?? undefined });
      if (!res.runId) throw new Error('Không tạo được lượt Đào sâu');
      // Mỗi video tốn yt-dlp vài chục giây — poll thưa hơn Tìm mới.
      for (let i = 0; i < 900; i++) {
        const detail = await loadRunDetail(res.runId);
        setRunning(detail);
        if (detail.card.status !== 'running') break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      onFinished();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const withComments = plan?.plan.filter((p) => p.commentsPresent).length ?? 0;
  const withTranscript = plan?.plan.filter((p) => p.transcriptPresent).length ?? 0;
  const card = running?.card;
  const pct = card && card.nItems ? Math.round(((card.itemsDone ?? 0) / card.nItems) * 100) : 0;

  return (
    <section class="sb-card sb-stack">
      <div class="sb-bar">
        <h2 class="sb-h2">Đào sâu — {videoIds.length} video</h2>
        {!busy && <button class="sb-btn secondary sm" onClick={onClose}>Đóng</button>}
      </div>
      <p class="sb-text sb-hint">Kéo ~100 comment + transcript mỗi video. Cái đã có thì bỏ qua, không kéo lại.</p>

      {!plan && !error && <div class="sb-skel" />}
      {plan && !running && (
        <div class="sb-stack sb-stack-sm">
          <p class="sb-text">
            Cần làm <b>{plan.toWork}</b>/{videoIds.length} video
            {withComments > 0 && <span class="sb-hint"> · {withComments} đã có comment</span>}
            {withTranscript > 0 && <span class="sb-hint"> · {withTranscript} đã có transcript</span>}
          </p>
          <div class="sb-list sb-list-inner">
            {plan.plan.map((p) => (
              <div key={p.videoId} class="sb-step">
                <div class="sb-list-main">
                  <VideoRef id={p.videoId} label={labels.data?.videos[p.videoId]} />
                </div>
                <span class="sb-actions">
                  {p.commentsPresent ? <Badge tone="secondary">đã có comment</Badge> : <Badge tone="primary">sẽ kéo comment</Badge>}
                  {p.transcriptPresent ? <Badge tone="secondary">đã có transcript</Badge> : <Badge tone="primary">sẽ kéo transcript</Badge>}
                </span>
              </div>
            ))}
          </div>
          <input
            class="sb-input"
            placeholder="Ghi chú mục đích (tuỳ chọn) — vd: tìm nỗi đau khán giả của outlier"
            value={note}
            maxLength={500}
            onInput={(e) => setNote((e.target as HTMLInputElement).value)}
          />
          <div class="sb-actions">
            <button class="sb-btn primary" disabled={busy || plan.toWork === 0} onClick={() => void doRun()}>
              <Icon name="play" size={16} />Chạy
            </button>
            {plan.toWork === 0 && <span class="sb-hint">Mọi video đã có đủ comment và transcript.</span>}
          </div>
        </div>
      )}
      {card && (
        <div class="sb-stack sb-stack-sm">
          <div class="sb-actions">
            {runStatusChip(card.status)}
            <span class="sb-hint">
              {card.itemsDone ?? 0}/{card.nItems ?? 0} video · {card.nNew ?? 0} có tư liệu mới · {card.units} unit
              {card.nSkipped ? ` · ${card.nSkipped} bỏ qua` : ''}
            </span>
          </div>
          <div class="sb-progress"><div class="sb-progress-fill" style={{ width: `${pct}%` }} /></div>
          {card.status !== 'running' && (
            <p class="sb-text sb-hint">Xong. Xem chi tiết từng video ở màn “4 · Lượt chạy”.</p>
          )}
        </div>
      )}
      {error && <div class="sb-alert">{error}</div>}
    </section>
  );
}
