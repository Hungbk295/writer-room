/**
 * quota-coordinator.ts — MỘT lease duy nhất cho mọi việc tiêu quota.
 *
 * VÌ SAO CẦN: kế toán quota của một tick là HIỆU SỐ sổ giữa lúc lấy baseline và
 * lúc đọc (`charged()` trong loop/runner.ts). Sổ là của cả ngày và không mang
 * `tick_id`. Bất cứ thứ gì tiêu quota xen vào giữa hai mốc đó — tick khác, hay
 * một `videosByIds` gọi thẳng từ dashboard — đều bị cộng nhầm vào tick. Không
 * có lỗi nào được ném ra; báo cáo chỉ đơn giản là sai.
 *
 * Khoá quanh riêng entrypoint tick KHÔNG đủ: một direct lookup chen vào giữa
 * baseline và report vẫn làm nhiễm delta dù chẳng có tick nào chạy song song.
 * Nên lease phải phủ TOÀN BỘ logical charged work.
 *
 * REENTRANCY THEO CHỦ SỞ HỮU, KHÔNG THEO CỜ:
 * `runTick` bên trong nó gọi hàng loạt call tiêu quota. Nếu lease không
 * reentrant thì tick tự deadlock với chính mình, và deadlock đó KHÔNG ném lỗi —
 * nó biểu hiện thành tick treo im lặng. Nhưng cách sửa sai hiển nhiên nhất
 * ("đang locked thì cho đi qua") còn tệ hơn: khi đó *bất kỳ* caller nào cũng
 * bypass được, direct lookup lách vào đúng lúc tick đang giữ lease, và ta có một
 * cơ chế trông như đã khoá nhưng không khoá gì — bằng chứng giả.
 *
 * Nên: chỉ ĐÚNG CHỦ đang giữ lease mới được đi xuyên qua. Chủ sở hữu truyền qua
 * `AsyncLocalStorage`, sống qua mọi `await` trong cùng chuỗi async. Caller độc
 * lập luôn phải xếp hàng.
 *
 * ĐIỀU KIỆN ĐỂ BỎ LEASE NÀY (đừng bỏ mà không làm): thay kế toán "hiệu số sổ"
 * bằng **charge event mang `tick_id`** — mỗi lần consume ghi một dòng gắn với
 * tick, tổng theo tick_id. Chừng nào còn tính bằng hiệu số thì chạy song song =
 * số liệu sai, và sai một cách im lặng.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError } from './errors.ts';

/** 'tick' = một vòng loop; 'api' = một lời gọi Data API lẻ. */
export type LeaseKind = 'tick' | 'api';

export interface LeaseOwner {
  /** Danh tính duy nhất — so sánh bằng tham chiếu, không bằng nhãn. */
  readonly id: symbol;
  readonly kind: LeaseKind;
  readonly label: string;
  /** topicId khi kind='tick'. */
  readonly topicId: string | null;
}

export interface LeaseHolderInfo {
  kind: LeaseKind;
  label: string;
  topicId: string | null;
}

export class QuotaCoordinator {
  private holder: LeaseOwner | null = null;
  private readonly waiters: Array<() => void> = [];
  private readonly storage = new AsyncLocalStorage<LeaseOwner>();

  /**
   * Ai đang giữ lease — ĐỒNG BỘ, chỉ đọc.
   *
   * Route HTTP dùng hàm này để trả 409 trước khi bắn tick fire-and-forget: khi
   * đã lỡ bắn thì rejection quan sát được quá muộn, HTTP đã trả 200 rồi. Đây
   * KHÔNG phải khoá thứ hai — nó không giữ, không nhả, chỉ đọc.
   */
  currentHolder(): LeaseHolderInfo | null {
    if (!this.holder) return null;
    return { kind: this.holder.kind, label: this.holder.label, topicId: this.holder.topicId };
  }

  /** topicId của tick đang chạy; null khi không có tick nào giữ lease. */
  tickRunningFor(): string | null {
    return this.holder?.kind === 'tick' ? this.holder.topicId : null;
  }

  /** true khi chuỗi async hiện tại đang nằm TRONG lease của chính nó. */
  private ownsCurrentLease(): boolean {
    const current = this.storage.getStore();
    return Boolean(current && this.holder && current.id === this.holder.id);
  }

  /**
   * Chạy `fn` dưới lease.
   *
   * - Đang ở trong lease của CHÍNH MÌNH → chạy thẳng (reentrant, không deadlock).
   * - `kind='tick'` mà một tick khác đang giữ → ném `conflict` NGAY, không xếp
   *   hàng: xếp hàng ngầm sẽ làm người bấm nút tưởng đã chạy rồi chờ vô hạn.
   * - Còn lại → chờ tới lượt.
   */
  async runExclusive<T>(
    spec: { kind: LeaseKind; label: string; topicId?: string | null },
    fn: () => Promise<T>,
  ): Promise<T> {
    if (this.ownsCurrentLease()) return fn();

    if (spec.kind === 'tick' && this.holder?.kind === 'tick') {
      throw new AppError(
        'conflict',
        `Đang chạy tick cho topic '${this.holder.topicId ?? this.holder.label}'. ` +
        'P0 tuần tự hoá mọi việc tiêu quota vì kế toán tính bằng hiệu số sổ.',
        { retryable: true },
      );
    }

    // check-then-acquire: KHÔNG được chèn `await` giữa vòng while và phép gán
    // holder bên dưới — JS đơn luồng nên đoạn này nguyên tử, và cả route lẫn
    // test đều dựa vào tính chất đó.
    while (this.holder !== null) {
      await new Promise<void>((resolve) => { this.waiters.push(resolve); });
      if (spec.kind === 'tick' && this.holder?.kind === 'tick') {
        throw new AppError(
          'conflict',
          `Đang chạy tick cho topic '${this.holder.topicId ?? this.holder.label}'.`,
          { retryable: true },
        );
      }
    }

    const owner: LeaseOwner = {
      id: Symbol(spec.label),
      kind: spec.kind,
      label: spec.label,
      topicId: spec.topicId ?? null,
    };
    this.holder = owner;
    try {
      return await this.storage.run(owner, fn);
    } finally {
      this.holder = null;
      const next = this.waiters.shift();
      if (next) next();
    }
  }
}

/**
 * Coordinator mặc định dùng khi không ai inject.
 *
 * `SpyService` tạo và chia sẻ instance của riêng nó; cái này chỉ để một
 * `QuotaCountingDataApi` dựng lẻ (test cũ, script) vẫn có lease hợp lệ thay vì
 * âm thầm chạy không điều phối.
 */
export const defaultQuotaCoordinator = new QuotaCoordinator();
