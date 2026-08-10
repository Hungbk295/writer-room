import { useState } from 'preact/hooks';

/**
 * Two-step delete control that does not depend on `window.confirm`
 * (WKWebView / some Tauri setups can swallow or auto-cancel native dialogs).
 */
export function DeleteButton({
  label = 'Xoá',
  confirmLabel = 'Xác nhận xoá',
  title,
  onDelete,
  disabled,
}: {
  label?: string;
  confirmLabel?: string;
  /** Shown next to confirm, e.g. item name */
  title?: string;
  onDelete: () => Promise<void> | void;
  disabled?: boolean;
}) {
  const [phase, setPhase] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setPhase('busy');
    setError(null);
    try {
      await onDelete();
      setPhase('idle');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('confirm');
    }
  };

  if (phase === 'confirm' || phase === 'busy') {
    return (
      <div class="row" style={{ gap: '0.35rem', alignItems: 'center', flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
        {error && <span class="error" style={{ fontSize: '0.78rem', maxWidth: '10rem' }}>{error}</span>}
        <button
          type="button"
          class="btn danger"
          disabled={phase === 'busy' || disabled}
          title={title ? `Xoá ${title}` : confirmLabel}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void run();
          }}
        >
          {phase === 'busy' ? 'Đang xoá…' : confirmLabel}
        </button>
        <button
          type="button"
          class="btn secondary"
          disabled={phase === 'busy'}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setPhase('idle');
            setError(null);
          }}
        >
          Huỷ
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      class="btn danger"
      disabled={disabled}
      title={title ? `Xoá ${title}` : label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setPhase('confirm');
        setError(null);
      }}
    >
      {label}
    </button>
  );
}
