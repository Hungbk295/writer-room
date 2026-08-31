import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  api,
  type WriterPack,
  type WriterPackSummary,
} from '../api.ts';
import { href } from '../router.ts';
import { DeleteButton } from '../components/ui/DeleteButton.tsx';

export function WriterPage() {
  const [packs, setPacks] = useState<WriterPackSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const packData = await api.listWriterPacks();
      setPacks(packData.packs);
      setError(null);
    } catch (err) {
      setPacks([]);
      setError(`Packs: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const removePack = async (id: string) => {
    setError(null);
    await api.deleteWriterPack(id);
    setPacks((prev) => prev.filter((p) => p.id !== id));
  };

  return (
    <div>
      <div class="page-header">
        <div>
          <h1 class="page-title">Source Packs</h1>
          <p class="page-lead">
            Quản lý các transcript pack thu thập từ Spy để phục vụ viết bài.
          </p>
        </div>
        <div class="row" style={{ gap: '0.5rem' }}>
          <a class="btn teal" href={href({ name: 'writer-v2' })}>Đi đến Writer v2 →</a>
        </div>
      </div>

      {error && <p class="error">{error}</p>}

      <section class="panel">
        <h2>Source Packs ({packs.length})</h2>
        {packs.length === 0 ? (
          <div class="empty-state">
            <p class="muted">
              Chưa có pack. Mở Spy → <strong>Gửi Writer</strong>.
            </p>
            <a class="btn teal" href={href({ name: 'spy' })}>Đến Spy</a>
          </div>
        ) : (
          <ul class="list">
            {packs.map((pack) => (
              <li key={pack.id} class="pack-row">
                <div>
                  <a href={href({ name: 'writer-pack', id: pack.id })}>
                    <strong>{pack.title || pack.channelTitle || 'Source Pack'}</strong>
                  </a>
                  <div class="meta">
                    <span>{pack.wordCount.toLocaleString()} từ</span>
                    <span>{pack.videoCount} video</span>
                    <span>{new Date(pack.createdAt).toLocaleString()}</span>
                  </div>
                </div>
                <div class="row pack-row-actions" style={{ gap: '0.5rem' }}>
                  <a class="btn secondary" href={href({ name: 'writer-pack', id: pack.id })}>
                    Xem
                  </a>
                  <DeleteButton
                    title={pack.title || pack.channelTitle || 'pack'}
                    onDelete={() => removePack(pack.id)}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function WriterPackPage({ id }: { id: string }) {
  const [pack, setPack] = useState<WriterPack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);

  useEffect(() => {
    void api.getWriterPack(id)
      .then(setPack)
      .catch((err) => setError(err.message));
  }, [id]);

  const copy = async () => {
    if (!pack) return;
    await navigator.clipboard.writeText(pack.markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const download = () => {
    if (!pack) return;
    const blob = new Blob([pack.markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${pack.title || 'source-pack'}.md`.replace(/[^\w.-]+/g, '-');
    a.click();
    URL.revokeObjectURL(url);
  };

  const startRename = () => {
    if (!pack) return;
    setRenameDraft(pack.title || pack.channelTitle || '');
    setRenaming(true);
  };

  const submitRename = async (e: Event) => {
    e.preventDefault();
    if (!pack || !renameDraft.trim() || renameBusy) return;
    setRenameBusy(true);
    setError(null);
    try {
      const updated = await api.renameWriterPack(pack.id, renameDraft.trim());
      setPack(updated);
      setRenaming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRenameBusy(false);
    }
  };

  if (error && !pack) {
    return (
      <div>
        <p class="error">{error}</p>
        <a class="btn secondary" href={href({ name: 'writer' })}>← Writer</a>
      </div>
    );
  }

  if (!pack) {
    return <p class="muted">Đang tải…</p>;
  }

  const displayName = pack.title || pack.channelTitle || 'Source Pack';

  return (
    <div>
      <div class="page-header">
        <div>
          <div class="row" style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            {renaming ? (
              <form
                class="row"
                style={{ gap: '0.4rem', alignItems: 'center', flex: 1 }}
                onSubmit={submitRename}
              >
                <input
                  style={{ flex: 1, minWidth: '12rem' }}
                  value={renameDraft}
                  onInput={(e) => setRenameDraft((e.target as HTMLInputElement).value)}
                  autofocus
                />
                <button class="btn" type="submit" disabled={renameBusy || !renameDraft.trim()}>
                  {renameBusy ? 'Đang lưu…' : 'Lưu'}
                </button>
                <button
                  class="btn secondary"
                  type="button"
                  disabled={renameBusy}
                  onClick={() => setRenaming(false)}
                >
                  Huỷ
                </button>
              </form>
            ) : (
              <h1 class="page-title" style={{ marginBottom: 0 }}>{displayName}</h1>
            )}
          </div>
          <p class="page-lead" style={{ marginBottom: 0 }}>
            {pack.channelTitle && `${pack.channelTitle} · `}
            {pack.wordCount.toLocaleString()} từ · {pack.videoIds.length} video
          </p>
        </div>
        <div class="row" style={{ gap: '0.5rem' }}>
          {!renaming && (
            <button class="btn secondary" type="button" onClick={startRename}>
              Đổi tên
            </button>
          )}
          <a class="btn secondary" href={href({ name: 'writer' })}>← Writer</a>
        </div>
      </div>

      {error && <p class="error">{error}</p>}

      <div class="row" style={{ margin: '1rem 0' }}>
        <button class="btn teal" type="button" onClick={() => void copy()}>
          {copied ? 'Đã copy' : 'Copy markdown'}
        </button>
        <button class="btn secondary" type="button" onClick={download}>
          Tải .md
        </button>
        {pack.spyRunId && (
          <a class="btn secondary" href={href({ name: 'spy-run', id: pack.spyRunId })}>
            Mở Spy run gốc
          </a>
        )}
      </div>

      {pack.warnings.length > 0 && (
        <p class="muted">Cảnh báo: {pack.warnings.join(' · ')}</p>
      )}

      <section class="panel">
        <pre class="pre">{pack.markdown}</pre>
      </section>
    </div>
  );
}



