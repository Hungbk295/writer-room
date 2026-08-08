import { useCallback, useEffect, useState } from 'preact/hooks';
import { api, type WriterPack, type WriterPackSummary } from '../api.ts';
import { href } from '../router.ts';

export function WriterPage() {
  const [packs, setPacks] = useState<WriterPackSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const data = await api.listWriterPacks();
    setPacks(data.packs);
  }, []);

  useEffect(() => {
    void refresh().catch((err) => setError(err.message));
  }, [refresh]);

  const remove = async (id: string) => {
    if (!confirm('Xoá pack này?')) return;
    try {
      await api.deleteWriterPack(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <h1 class="page-title">Writer</h1>
      <p class="page-lead">
        Source Pack staging — chọn transcript trong Spy rồi gửi sang đây để đọc / copy / tải.
      </p>

      {error && <p class="error">{error}</p>}

      <section class="panel">
        <h2>Packs ({packs.length})</h2>
        {packs.length === 0 ? (
          <div class="empty-state">
            <p class="muted">
              Chưa có pack. Mở một Spy run, tick video có transcript, bấm{' '}
              <strong>Gửi Writer</strong>.
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
                    {pack.warnings.length > 0 && (
                      <span class="chip warn">{pack.warnings.length} cảnh báo</span>
                    )}
                  </div>
                </div>
                <div class="row" style={{ gap: '0.5rem' }}>
                  <a class="btn secondary" href={href({ name: 'writer-pack', id: pack.id })}>
                    Xem
                  </a>
                  <button class="btn danger" type="button" onClick={() => void remove(pack.id)}>
                    Xoá
                  </button>
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

  if (error) {
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

  return (
    <div>
      <div class="page-header">
        <div>
          <h1 class="page-title">{pack.title || pack.channelTitle || 'Source Pack'}</h1>
          <p class="page-lead" style={{ marginBottom: 0 }}>
            {pack.channelTitle && `${pack.channelTitle} · `}
            {pack.wordCount.toLocaleString()} từ · {pack.videoIds.length} video
          </p>
        </div>
        <a class="btn secondary" href={href({ name: 'writer' })}>← Writer</a>
      </div>

      <div class="row" style={{ margin: '1rem 0' }}>
        <button class="btn teal" type="button" onClick={() => void copy()}>
          {copied ? 'Đã copy' : 'Copy markdown'}
        </button>
        <button class="btn secondary" type="button" onClick={download}>
          Tải .md
        </button>
        {pack.spyRunId && (
          <a class="btn secondary" href={href({ name: 'spy-run', id: pack.spyRunId })}>
            Mở Spy run
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
