import { useEffect, useState } from 'preact/hooks';
import { api, type SpySettings } from '../api.ts';

export function SettingsPage() {
  const [settings, setSettings] = useState<SpySettings | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [concurrency, setConcurrency] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const load = async () => {
    const data = await api.getSettings();
    setSettings(data);
    setConcurrency(data.concurrency);
    setApiKey('');
    setClearKey(false);
  };

  useEffect(() => {
    void load().catch((err) => setError(err.message));
  }, []);

  const save = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const body: Parameters<typeof api.updateSettings>[0] = {
        concurrency,
      };
      if (clearKey) {
        body.youtubeDataApiKey = '';
      } else if (apiKey.trim()) {
        body.youtubeDataApiKey = apiKey.trim();
      }
      const updated = await api.updateSettings(body);
      setSettings(updated);
      setApiKey('');
      setClearKey(false);
      setOk('Đã lưu cấu hình Spy.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h1 class="page-title">Settings</h1>
      <p class="page-lead">Cấu hình Spy — lưu vào data/config/spy.json, áp dụng ngay không cần restart.</p>

      <form class="panel stack" onSubmit={save}>
        <h2>YouTube Data API</h2>
        <label>
          API key
          <input
            type="password"
            autoComplete="off"
            placeholder={
              settings?.hasApiKey
                ? `••••••••${settings.apiKeyLast4 ?? ''}`
                : 'AIza… (tuỳ chọn — tăng quota / metadata)'
            }
            value={apiKey}
            onInput={(e) => {
              setApiKey((e.target as HTMLInputElement).value);
              setClearKey(false);
            }}
          />
        </label>
        {settings?.hasApiKey && (
          <label class="check-inline">
            <input
              type="checkbox"
              checked={clearKey}
              onChange={(e) => setClearKey((e.target as HTMLInputElement).checked)}
            />
            Xoá API key đã lưu
          </label>
        )}

        <h2>Harvest</h2>
        <div class="row">
          <label>
            Concurrency
            <input
              type="number"
              min={1}
              max={4}
              value={concurrency}
              onInput={(e) => setConcurrency(Number((e.target as HTMLInputElement).value))}
            />
          </label>
        </div>

        <div class="row">
          <button class="btn teal" disabled={busy} type="submit">
            {busy ? 'Đang lưu…' : 'Lưu'}
          </button>
        </div>
        {ok && <p class="ok">{ok}</p>}
        {error && <p class="error">{error}</p>}
      </form>

      {settings && (
        <section class="panel stack">
          <h2>Đường dẫn (read-only)</h2>
          <div class="kv-grid">
            <div>
              <div class="kv-key">Data root</div>
              <p class="mono-small">{settings.dataRoot}</p>
            </div>
            <div>
              <div class="kv-key">Spy root</div>
              <p class="mono-small">{settings.spyRoot}</p>
            </div>
          </div>
          <p class="muted">
            Đổi thư mục data bằng env <code>WRITER_ROOM_DATA_DIR</code> khi chạy daemon.
          </p>
        </section>
      )}
    </div>
  );
}
