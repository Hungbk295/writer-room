/**
 * LoopScheduler — lập lịch chạy spy loop hàng ngày.
 *
 * Vấn đề: daemon KHÔNG chạy 24/7 (Tauri spawn khi mở app, không có launchd).
 * Giải pháp:
 *   - setTimeout tới giờ tick (15:30 VN) nhưng cap 1h rồi re-evaluate
 *   - Catch-up on boot: nếu lastTick.quotaDay < quotaDay(now) VÀ đã qua giờ due → runTick
 *   - Digest 08:00 VN sáng: đọc lại daily_reports, gửi lại, idempotent qua deliveredJson.telegram_digest
 *   - Lock per-topic: in-memory Set<topicId>
 *
 * Khởi động trong createHttpApp (http.ts), dispose trong shutdown.
 */
import type { SpyService } from '@writer-room/spy';
import { quotaDay } from '@writer-room/spy';
import type { SpyLoopAdapter, TickResult } from './loop-contract.ts';
import { loadSpyLoopConfig } from './loop-config.ts';
import { sendTelegramReport } from './report-telegram.ts';

// ─── Helpers thời gian ────────────────────────────────────────────────────────

/** Parse "HH:MM" → { hours, minutes } */
function parseHHMM(s: string): { hours: number; minutes: number } {
  const parts = s.split(':').map(Number);
  return { hours: parts[0] ?? 15, minutes: parts[1] ?? 30 };
}

/** Giây tính từ nửa đêm, trong timezone cho trước. */
function localSecondsOfDay(timezone: string, now: Date): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // 'en-CA' + hour12:false trả 24h; nửa đêm ra '24' ở một số ICU → chuẩn hoá.
  return (get('hour') % 24) * 3600 + get('minute') * 60 + get('second');
}

/**
 * Tính ms còn lại tới HH:MM trong timezone cho trước.
 * Nếu đã qua giờ đó trong ngày hôm nay → trả ms tới ngày mai cùng giờ.
 */
export function msUntilLocalHHMM(
  hourStr: string,
  timezone: string,
  now: Date = new Date(),
): number {
  const { hours, minutes } = parseHHMM(hourStr);
  const nowSecs = localSecondsOfDay(timezone, now);
  const dueSecs = hours * 3600 + minutes * 60;
  let deltaSec = dueSecs - nowSecs;
  if (deltaSec <= 0) deltaSec += 86400; // đã qua → lần kế tiếp là ngày mai
  return deltaSec * 1000;
}

/**
 * Hôm nay ở timezone đó đã qua HH:MM chưa?
 *
 * Phải là một phép so sánh RIÊNG, không suy ra từ `msUntilLocalHHMM`. Bản cũ
 * đoán "đã quá giờ" bằng `msToDue > 23h`, nghĩa là nó chỉ đúng trong ĐÚNG 1 giờ
 * sau giờ due; mở app lúc 21:00 với tick 15:30 cho msToDue = 18.5h → bị coi là
 * "chưa tới giờ" và catch-up không bao giờ chạy. Đó chính là kịch bản mà
 * catch-up-on-boot sinh ra để phục vụ (design §2.2: "Mở app lúc 21:00 vẫn có
 * tick hôm đó").
 */
export function isPastLocalHHMM(hourStr: string, timezone: string, now: Date = new Date()): boolean {
  const { hours, minutes } = parseHHMM(hourStr);
  return localSecondsOfDay(timezone, now) >= hours * 3600 + minutes * 60;
}

/** Tính quotaDay dựa vào Pacific time (import từ @writer-room/spy). */
function currentQuotaDay(now: Date = new Date()): string {
  return quotaDay(now);
}

// ─── LoopScheduler ───────────────────────────────────────────────────────────

/** Sự kiện báo tick xong — đủ để dựng một notification, không kéo theo DB. */
export interface TickDoneEvent {
  topicId: string;
  topicLabel: string;
  tickId: string;
  detail: string;
  result: TickResult;
}

export interface LoopSchedulerOptions {
  loop: SpyLoopAdapter;
  spy: SpyService;
  dataDir: string;
  /**
   * Tiêm từ `createHttpApp`, KHÔNG import `notifications.ts` ở đây: scheduler
   * được `http.ts` dựng, nên import ngược lại sẽ tạo vòng.
   */
  onTickDone?: (event: TickDoneEvent) => void | Promise<void>;
  /** Override `new Date()` cho test với fake clock. */
  now?: () => Date;
}

export class LoopScheduler {
  private readonly loop: SpyLoopAdapter;
  private readonly spy: SpyService;
  private readonly dataDir: string;
  private readonly onTickDone: ((event: TickDoneEvent) => void | Promise<void>) | null;
  private readonly now: () => Date;

  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private digestTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  /** In-memory lock: Set<topicId> đang chạy tick. */
  private readonly running = new Set<string>();

  constructor(opts: LoopSchedulerOptions) {
    this.loop = opts.loop;
    this.spy = opts.spy;
    this.dataDir = opts.dataDir;
    this.onTickDone = opts.onTickDone ?? null;
    this.now = opts.now ?? (() => new Date());
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  start(): void {
    void this.tryTickNow().then(() => this.scheduleNextTick());
    void this.tryDigestNow().then(() => this.scheduleNextDigest());
  }

  dispose(): void {
    this.disposed = true;
    if (this.tickTimer) { clearTimeout(this.tickTimer); this.tickTimer = null; }
    if (this.digestTimer) { clearTimeout(this.digestTimer); this.digestTimer = null; }
  }

  // ─── Tick ───────────────────────────────────────────────────────────────────

  /** Kiểm tra xem có cần catch-up tick ngay khi khởi động không. */
  private async tryTickNow(): Promise<void> {
    const cfg = await loadSpyLoopConfig(this.dataDir).catch(() => null);
    if (!cfg?.enabled) return;

    const now = this.now();
    const todayQuotaDay = currentQuotaDay(now);

    // Chưa tới giờ tick hôm nay → để timer lo, không catch-up.
    if (!isPastLocalHHMM(cfg.tickHourLocal, cfg.timezone, now)) return;

    // Lấy danh sách topic active
    const topics = await this.loop.listTopics().catch(() => [] as Awaited<ReturnType<SpyLoopAdapter['listTopics']>>);
    for (const topic of topics) {
      if (topic.status !== 'active') continue;

      // Đã chạy trong quota-day này rồi → bỏ qua. Lại là so chuỗi quota-day với
      // chuỗi quota-day (`loop_ticks.quota_day`), không phải timestamp.
      const statuses = await this.loop.status(topic.topicId).catch(() => []);
      const lastTick = statuses[0]?.lastTick;
      if (lastTick && lastTick.quotaDay >= todayQuotaDay) continue;

      // Catch-up
      await this.runTick(topic.topicId);
    }
  }

  private scheduleNextTick(): void {
    if (this.disposed) return;

    void loadSpyLoopConfig(this.dataDir).then((cfg) => {
      if (!cfg.enabled) {
        // Lịch check lại sau 1h
        this.tickTimer = setTimeout(() => this.scheduleNextTick(), 3_600_000);
        return;
      }

      const now = this.now();
      const rawMs = msUntilLocalHHMM(cfg.tickHourLocal, cfg.timezone, now);
      // Cap 1h để re-evaluate sau wake từ sleep
      const delayMs = Math.min(rawMs, 3_600_000);

      this.tickTimer = setTimeout(() => {
        if (this.disposed) return;
        void this.tryTickNow().then(() => this.scheduleNextTick());
      }, delayMs);
    }).catch((err) => {
      console.error('[loop-scheduler] scheduleNextTick error:', (err as Error).message);
      // Retry sau 5 phút
      this.tickTimer = setTimeout(() => this.scheduleNextTick(), 5 * 60_000);
    });
  }

  /**
   * Chỉ chạy tick THẬT. Dry-run không đi qua đây: nó không tốn quota, không cần
   * lock, và route gọi thẳng `loop.planTick()`.
   */
  async runTick(topicId: string): Promise<TickResult | null> {
    if (this.running.has(topicId)) {
      console.warn(`[loop-scheduler] tick đang chạy cho topic ${topicId}, bỏ qua`);
      return null;
    }
    this.running.add(topicId);
    try {
      console.log(`[loop-scheduler] runTick topicId=${topicId}`);
      const result = await this.loop.tick({ topicId });
      if (result.status === 'done') {
        void this.announceTickDone(topicId, result);
      }
      return result;
    } catch (err) {
      console.error(`[loop-scheduler] runTick lỗi topic=${topicId}:`, (err as Error).message);
      return null;
    } finally {
      this.running.delete(topicId);
    }
  }

  isRunning(topicId: string): boolean {
    return this.running.has(topicId);
  }

  // ─── Digest ─────────────────────────────────────────────────────────────────

  private async tryDigestNow(): Promise<void> {
    const cfg = await loadSpyLoopConfig(this.dataDir).catch(() => null);
    if (!cfg?.enabled) return;
    if (!cfg.telegram?.enabled) return;

    const now = this.now();
    if (!isPastLocalHHMM(cfg.digestHourLocal, cfg.timezone, now)) return;

    await this.sendDigest(cfg).catch((err) => {
      console.error('[loop-scheduler] tryDigestNow error:', (err as Error).message);
    });
  }

  private scheduleNextDigest(): void {
    if (this.disposed) return;

    void loadSpyLoopConfig(this.dataDir).then((cfg) => {
      const now = this.now();
      const rawMs = msUntilLocalHHMM(cfg.digestHourLocal, cfg.timezone, now);
      const delayMs = Math.min(rawMs, 3_600_000);

      this.digestTimer = setTimeout(() => {
        if (this.disposed) return;
        void this.tryDigestNow().then(() => this.scheduleNextDigest());
      }, delayMs);
    }).catch(() => {
      this.digestTimer = setTimeout(() => this.scheduleNextDigest(), 5 * 60_000);
    });
  }

  private async sendDigest(cfg: Awaited<ReturnType<typeof loadSpyLoopConfig>>): Promise<void> {
    if (!cfg.telegram) return;

    // `daily_reports.report_date` được ghi bằng `quotaDay()` — ngày Pacific, KHÔNG
    // phải ngày UTC. Lọc bằng `new Date().toISOString().slice(0,10)` sai lệch
    // đúng một ngày ở giờ digest (08:00 VN = 18:00 Pacific hôm trước), nên digest
    // im lặng không khớp report nào và không bao giờ gửi.
    //
    // Tick 15:30 VN và digest 08:00 VN sáng hôm sau nằm CÙNG một quota-day Pacific
    // (01:30 và 18:00 cùng ngày) — đó là lý do lịch được đặt ngay sau mốc reset quota.
    //
    // CỐ Ý so sánh CHUỖI với CHUỖI. `report_date` đã LÀ một quota-day, không phải
    // timestamp — đừng "cải tiến" thành `isSameQuotaDay(r.reportDate, now)`:
    // `quotaDayOf()` NÉM lỗi với chuỗi chỉ có ngày, đúng để chặn việc parse
    // '2026-08-21' thành nửa đêm UTC rồi tụt về Pacific '2026-08-20'.
    // Chỉ dùng quotaDayOf/isSameQuotaDay cho TIMESTAMP (vd `createdAt`).
    const quotaToday = currentQuotaDay(this.now());
    const reports = await this.loop.listReports({ limit: 10 }).catch(() => []);
    const todayReports = reports.filter((r) => r.reportDate === quotaToday);

    for (const report of todayReports) {
      if (report.deliveredJson['telegram_digest']) continue;

      // Digest: chỉ gửi summary ngắn gọn (không lặp lại tick/quota chi tiết)
      const digestMarkdown = buildDigestMarkdown(report.markdown, this.now());
      try {
        await sendTelegramReport(digestMarkdown, cfg.telegram);
        await this.loop.markDelivered(report.reportId, 'telegram_digest', this.now().toISOString());
      } catch (err) {
        console.error('[loop-scheduler] sendDigest lỗi:', (err as Error).message);
      }
    }
  }

  // ─── Notification ────────────────────────────────────────────────────────────

  /**
   * Một tick xong báo qua hai đường độc lập: notification in-app (callback tiêm
   * từ `createHttpApp`) và Telegram. Đường này hỏng không được chặn đường kia.
   */
  private async announceTickDone(topicId: string, result: TickResult): Promise<void> {
    const label = await this.loop
      .getTopic(topicId)
      .then((topic) => topic?.label ?? topicId)
      .catch(() => topicId);

    if (this.onTickDone) {
      const detail = `${result.newCandidates} kênh mới · ${result.newShortlistedAuto} auto-shortlist · `
        + `${result.pendingReview} chờ duyệt · ${result.searchCallsUsed} search call`;
      try {
        await this.onTickDone({ topicId, topicLabel: label, tickId: result.tickId, detail, result });
      } catch (err) {
        console.error(`[loop-scheduler] onTickDone lỗi topic=${topicId}:`, (err as Error).message);
      }
    }

    const cfg = await loadSpyLoopConfig(this.dataDir).catch(() => null);
    if (!cfg?.telegram?.enabled) return;

    const reports = await this.loop.listReports({ topicId, limit: 1 }).catch(() => []);
    const latest = reports[0];
    if (!latest) return;
    if (latest.deliveredJson['telegram']) return;

    try {
      await sendTelegramReport(latest.markdown, cfg.telegram);
      await this.loop.markDelivered(latest.reportId, 'telegram', this.now().toISOString());
    } catch (err) {
      console.error(`[loop-scheduler] Telegram lỗi topic=${topicId} tick=${result.tickId}:`, (err as Error).message);
    }
  }
}

// ─── Digest builder ──────────────────────────────────────────────────────────

/** Rút gọn markdown report thành digest sáng sớm.
 * Bỏ các dòng Tick · Quota, thêm header "Digest sáng". */
function buildDigestMarkdown(fullMarkdown: string, now: Date = new Date()): string {
  const lines = fullMarkdown.split('\n');
  // Bỏ dòng "Tick ·" và "Quota ·" (đã báo hôm qua)
  const filtered = lines.filter((line) =>
    !line.startsWith('Tick ·') && !line.startsWith('Quota ·')
  );
  // Thêm note digest
  // Ngày HIỂN THỊ cho người đọc → giờ VN, không phải quota-day Pacific. Hai khái
  // niệm khác nhau và cố ý khác nhau ở đây.
  const today = now.toLocaleDateString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit', month: '2-digit', year: 'numeric',
  });
  return `🌅 Digest sáng ${today}\n\n${filtered.join('\n')}`;
}
