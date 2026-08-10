import { AppError, asAppError } from './errors.ts';
import type { SpyStore } from './store.ts';
import type { Operation, OperationKind } from './schema.ts';

/** Trần chờ tối đa của OperationManager.wait — khớp với trần 600s khai báo ở spy_wait. */
export const MAX_WAIT_MS = 600_000;

export interface OperationContext {
  readonly operationId: string;
  readonly signal: AbortSignal;
  progress(progress: number, total: number, step: string): void;
}

export class OperationManager {
  private readonly controllers = new Map<string, AbortController>();
  private readonly completions = new Map<string, Promise<void>>();

  constructor(private readonly store: SpyStore) {}

  reconcile(): number {
    return this.store.reconcileInterruptedOperations();
  }

  start(input: {
    kind: OperationKind;
    ownerSubject: string;
    idempotencyKey: string;
    request: unknown;
    initialize?: (operation: Operation) => string | null;
    work: (context: OperationContext) => Promise<string | null>;
  }): Operation {
    const result = this.store.createOrGetOperation({
      kind: input.kind,
      ownerSubject: input.ownerSubject,
      idempotencyKey: input.idempotencyKey,
      request: input.request,
    });
    if (!result.created) return result.operation;
    try {
      const initialRef = input.initialize?.(result.operation) ?? null;
      if (initialRef !== null) this.store.updateOperation(result.operation.id, { resultRef: initialRef });
    } catch (error) {
      // Without this, a throwing initialize() leaves the row stuck at 'queued'
      // forever — run() below (which would otherwise resolve it) never gets called.
      const appError = asAppError(error);
      this.store.updateOperation(result.operation.id, {
        status: 'failed',
        step: 'failed',
        errorCode: appError.code,
        errorMessage: appError.message.slice(0, 2_000),
      });
      throw error;
    }
    const controller = new AbortController();
    this.controllers.set(result.operation.id, controller);
    const completion = this.run(result.operation.id, controller, input.work);
    this.completions.set(result.operation.id, completion);
    void completion.finally(() => {
      this.controllers.delete(result.operation.id);
      this.completions.delete(result.operation.id);
    });
    return this.store.getOperation(result.operation.id)!;
  }

  private async run(
    operationId: string,
    controller: AbortController,
    work: (context: OperationContext) => Promise<string | null>,
  ): Promise<void> {
    this.store.updateOperation(operationId, { status: 'running', step: 'starting' });
    const context: OperationContext = {
      operationId,
      signal: controller.signal,
      progress: (progress, total, step) => {
        this.store.updateOperation(operationId, { progress, total, step });
      },
    };
    try {
      const resultRef = await work(context);
      if (controller.signal.aborted) throw new AppError('cancelled', 'Operation đã bị hủy');
      this.store.updateOperation(operationId, {
        status: 'completed',
        progress: 1,
        total: 1,
        step: 'completed',
        ...(resultRef === null ? {} : { resultRef }),
      });
    } catch (error) {
      const appError = controller.signal.aborted
        ? new AppError('cancelled', 'Operation đã bị hủy')
        : asAppError(error);
      this.store.updateOperation(operationId, {
        status: appError.code === 'cancelled' ? 'cancelled' : 'failed',
        step: appError.code === 'cancelled' ? 'cancelled' : 'failed',
        errorCode: appError.code,
        errorMessage: appError.message.slice(0, 2_000),
      });
    }
  }

  cancel(operationId: string): Operation {
    const operation = this.store.getOperation(operationId);
    if (!operation) throw new AppError('not_found', 'Operation không tồn tại');
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(operation.status)) return operation;
    this.controllers.get(operationId)?.abort();
    return this.store.updateOperation(operationId, {
      status: 'cancelled',
      step: 'cancelled',
      errorCode: 'cancelled',
      errorMessage: 'Cancelled by caller',
    });
  }

  async wait(operationId: string, timeoutMs = 30_000): Promise<Operation> {
    const current = this.store.getOperation(operationId);
    if (!current) throw new AppError('not_found', 'Operation không tồn tại');
    const completion = this.completions.get(operationId);
    if (completion) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          completion,
          new Promise<void>((resolve) => {
            // Trần 10 phút: đủ cho harvest dài, vẫn chặn được caller truyền timeout vô hạn.
            timer = setTimeout(resolve, Math.max(0, Math.min(timeoutMs, MAX_WAIT_MS)));
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    return this.store.getOperation(operationId)!;
  }
}
