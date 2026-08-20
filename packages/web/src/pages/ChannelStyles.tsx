/**
 * Channel styles reader.
 *
 * A channel style is one markdown file in `writer-room-data/channel-styles/`
 * saying how THIS channel sounds — it is what "Restyle" applies to a finished
 * Writer v2 run. This screen is read-only on purpose: styles are authored by a
 * human in the editor, and the only thing the UI owes them is a way to read the
 * whole file before picking one.
 */
import { useEffect, useState } from 'preact/hooks';
import { api, type ChannelStyle, type ChannelStyleSummary } from '../api.ts';
import { href } from '../router.ts';

export function ChannelStylesPage({ path }: { path?: string }) {
  const [styles, setStyles] = useState<ChannelStyleSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [style, setStyle] = useState<ChannelStyle | null>(null);
  const [styleError, setStyleError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    void api
      .listChannelStyles()
      .then((d) => { if (alive) setStyles(d.styles); })
      .catch((err) => {
        if (!alive) return;
        setStyles([]);
        setListError(err instanceof Error ? err.message : String(err));
      });
    return () => { alive = false; };
  }, []);

  // `path` comes from the hash, so an unknown file name must fail visibly here
  // rather than silently showing the previous style.
  useEffect(() => {
    if (!path) {
      setStyle(null);
      setStyleError(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setStyle(null);
    setStyleError(null);
    setCopied(false);
    void api
      .getChannelStyle(path)
      .then((d) => { if (alive) setStyle(d); })
      .catch((err) => {
        if (alive) setStyleError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [path]);

  const copy = async () => {
    if (!style) return;
    try {
      await navigator.clipboard.writeText(style.markdown);
      setCopied(true);
    } catch (err) {
      setStyleError(`Không copy được style: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div>
      <div class="page-header">
        <div>
          <h1 class="page-title">Style kênh</h1>
          <p class="page-lead" style={{ marginBottom: 0 }}>
            Mỗi file markdown trong <code>writer-room-data/channel-styles/</code> là một giọng kênh.
            Đọc toàn văn ở đây trước khi bấm Restyle trong Writer v2.
          </p>
        </div>
        <a class="btn secondary" href={href({ name: 'writer-v2' })}>← Writer v2</a>
      </div>

      {listError && <p class="error">{listError}</p>}

      {styles && styles.length === 0 && !listError && (
        <section class="panel">
          <div class="empty-state">
            <p class="muted" style={{ margin: 0 }}>
              Chưa có style kênh nào. Tạo một file <code>.md</code> trong{' '}
              <code>writer-room-data/channel-styles/</code> — tiêu đề <code># …</code> ở dòng đầu
              thành tên style, dòng <code>&lt;!-- version: N --&gt;</code> thành phiên bản.
            </p>
          </div>
        </section>
      )}

      {!styles && !listError && <p class="muted">Đang tải…</p>}

      {styles && styles.length > 0 && (
        <div class="training-detail-grid">
          <section class="panel">
            <h2>{styles.length} style</h2>
            <ul class="list" style={{ marginTop: '0.75rem' }}>
              {styles.map((s) => {
                const active = s.path === path;
                return (
                  <li
                    key={s.path}
                    class="pack-row"
                    style={active ? { borderColor: 'var(--teal)', background: 'rgba(31, 138, 122, 0.1)' } : undefined}
                  >
                    <div>
                      <a href={href({ name: 'channel-styles', path: s.path })}>
                        <strong>{s.title}</strong>
                      </a>
                      <div class="meta">
                        <span>{s.path}</span>
                        {s.version !== null && <span>v{s.version}</span>}
                        <span>{s.wordCount} từ</span>
                      </div>
                    </div>
                    <a class="btn secondary" href={href({ name: 'channel-styles', path: s.path })}>
                      {active ? 'Đang đọc' : 'Đọc'}
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>

          <section class="panel">
            {!path && <p class="muted">Chọn một style bên trái để đọc toàn văn.</p>}
            {path && loading && <p class="muted">Đang mở {path}…</p>}
            {styleError && <p class="error">{styleError}</p>}
            {style && (
              <>
                <div class="row" style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <h2 style={{ margin: 0 }}>{style.title}</h2>
                  {style.version !== null && <span class="chip">v{style.version}</span>}
                  <span class="chip">{style.wordCount} từ</span>
                  <button class="btn secondary" type="button" onClick={() => void copy()}>
                    {copied ? '✓ Đã copy' : 'Copy markdown'}
                  </button>
                </div>
                <div class="meta" style={{ marginTop: '0.4rem' }}>
                  <span>{style.path}</span>
                  <span>hash {style.hash.slice(0, 12)}</span>
                </div>
                <pre class="pre" style={{ marginTop: '0.75rem', maxHeight: 'none' }}>{style.markdown}</pre>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
