import { useEffect, useRef, useState } from 'preact/hooks';

export interface EntityIdProps {
  /** Exact persisted ID (or documented composite reference) copied to the clipboard. */
  id: string | number;
  /** Names the entity without forcing every screen to use the generic word "ID". */
  label?: string;
  /** Optional compact text for composite references whose meaningful suffix must stay visible. */
  displayId?: string;
}

export function shortEntityId(id: string | number): string {
  const value = String(id);
  return value.length > 16 ? `${value.slice(0, 8)}…` : value;
}

async function writeToClipboard(value: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // Some embedded/local webviews expose the API but reject it; use the local fallback.
  }

  const field = document.createElement('textarea');
  field.value = value;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.appendChild(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  if (!copied) throw new Error('Clipboard unavailable');
}

/**
 * A quiet, copyable identifier for persistent cards in Formula/Training screens.
 * The card stays readable while the full exact ID remains one click away.
 */
export function EntityId({ id, label = 'ID', displayId }: EntityIdProps) {
  const value = String(id);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const resetTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
  }, []);

  const copyId = async (event: MouseEvent) => {
    // ID badges often sit inside clickable cards; copying must not open/select them.
    event.preventDefault();
    event.stopPropagation();

    try {
      await writeToClipboard(value);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }

    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopyState('idle'), 1400);
  };

  const visibleValue = displayId ?? shortEntityId(value);
  const visibleText = copyState === 'copied'
    ? 'Đã chép'
    : copyState === 'failed'
      ? 'Không chép được'
      : `${label}: ${visibleValue}`;

  return (
    <button
      type="button"
      class={`entity-id${copyState === 'copied' ? ' copied' : ''}${copyState === 'failed' ? ' failed' : ''}`}
      title={`${label}: ${value} — bấm để chép mã đầy đủ`}
      aria-label={`Chép mã ${label} đầy đủ: ${value}`}
      onClick={(event) => void copyId(event)}
    >
      {visibleText}
    </button>
  );
}
