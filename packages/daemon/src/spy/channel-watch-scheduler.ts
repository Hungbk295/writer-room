import type { SpyService } from '@writer-room/spy';
import { LOCAL_PUBLIC_WATCHLIST } from '@writer-room/spy';
import { loadChannelWatchConfig } from './channel-watch-config.ts';

function localDate(timezone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now);
}

function isPastHour(hour: string, timezone: string, now: Date): boolean {
  const [rawHour, rawMinute] = hour.split(':').map(Number);
  const wantedHour = rawHour ?? 0;
  const wantedMinute = rawMinute ?? 0;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(now);
  const value = (key: string) => Number(parts.find((part) => part.type === key)?.value ?? 0);
  return (value('hour') % 24) * 60 + value('minute') >= (wantedHour * 60 + wantedMinute);
}

/**
 * Bounded daily collector.  It is intentionally independent of LoopScheduler:
 * disabled config makes it a zero-provider-call kill switch.
 */
export class ChannelWatchScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private running = false;

  constructor(
    private readonly spy: SpyService,
    private readonly dataDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(): void {
    // Startup must not leave an unhandled rejection if a stale config or a
    // provider bug slips through.  The next scheduled tick remains alive.
    void this.tick().catch((error) => {
      console.error('[channel-watch] initial daily tick failed:', error instanceof Error ? error.message : String(error));
    }).finally(() => this.schedule());
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const config = await loadChannelWatchConfig(this.dataDir);
      if (!config.enabled || !isPastHour(config.dailyHourLocal, config.timezone, this.now())) return 0;
      const today = localDate(config.timezone, this.now());
      const relations = this.spy.store.listPublicCompetitors(LOCAL_PUBLIC_WATCHLIST)
        .filter((relation) => relation.watchStatus === 'followed' && relation.cadence === 'daily');
      let attempted = 0;
      // Concurrency remains 1: each inspectVideo can take up to 90 seconds.
      for (const relation of relations) {
        const existing = this.spy.store.listPublicObservationRuns(LOCAL_PUBLIC_WATCHLIST, relation.competitorChannelId, 10)
          .some((run) => run.planKind === 'daily' && run.localDate === today && run.planVersion === 'public-vph-collect/v1');
        if (existing) continue;
        attempted += 1;
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(), config.perRelationWallClockMs);
        try {
          await this.spy.observePublicChannel({
            youtubeUcId: relation.competitorChannelId,
            watchlistId: LOCAL_PUBLIC_WATCHLIST,
            planKind: 'daily', localDate: today,
            playlistLimit: config.playlistLimit, inspectCap: config.inspectCap, now: this.now(), signal: controller.signal,
          });
        } finally {
          clearTimeout(deadline);
        }
      }
      return attempted;
    } finally {
      this.running = false;
    }
  }

  private schedule(): void {
    if (this.disposed) return;
    this.timer = setTimeout(() => {
      void this.tick().catch((error) => {
        console.error('[channel-watch] daily tick failed:', error instanceof Error ? error.message : String(error));
      }).finally(() => this.schedule());
    }, 60 * 60 * 1000);
  }
}
