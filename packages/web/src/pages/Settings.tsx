import { useEffect, useState } from 'preact/hooks';
import { api, type SpySettings } from '../api.ts';
import { CustomSelect, Field, Input } from '../components/ui/Forms.tsx';

export function SettingsPage() {
  const [settings, setSettings] = useState<SpySettings | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [clearKey, setClearKey] = useState(false);
  const [concurrency, setConcurrency] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

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
      setOk('✓ Đã lưu cấu hình Spy thành công.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const copyPath = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedPath(label);
    setTimeout(() => setCopiedPath(null), 1500);
  };

  return (
    <div class="settings-container">
      <div class="page-header" style={{ marginBottom: '0.5rem' }}>
        <div>
          <h1 class="page-title">Cấu hình Hệ thống</h1>
          <p class="page-lead" style={{ marginBottom: 0 }}>
            Tùy chỉnh API key và số luồng thu thập dữ liệu Spy. Cấu hình tự động lưu vào <code>data/config/spy.json</code>.
          </p>
        </div>
        <span class="chip ok">Hot Reload Enabled</span>
      </div>

      {ok && (
        <div class="banner ok">
          <span>{ok}</span>
          <button type="button" class="banner-close" onClick={() => setOk(null)}>✕</button>
        </div>
      )}
      {error && (
        <div class="banner error">
          <span>{error}</span>
          <button type="button" class="banner-close" onClick={() => setError(null)}>✕</button>
        </div>
      )}

      <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        {/* Section 1: YouTube API */}
        <section class="settings-section-card">
          <div class="settings-card-header">
            <h3>🔑 YouTube Data API v3</h3>
            {settings?.hasApiKey ? (
              <span class="chip ok">✓ Key active (••••{settings.apiKeyLast4 ?? ''})</span>
            ) : (
              <span class="chip warn">⚡ Chưa cài Key (Scrape fallback)</span>
            )}
          </div>

          <Field
            label="YouTube Data API Key"
            sublabel="(Tùy chọn — Tăng hạn ngạch quota và lấy metadata chuẩn)"
          >
            <div class="settings-input-group">
              <Input
                type={showKey ? 'text' : 'password'}
                autoComplete="off"
                placeholder={
                  settings?.hasApiKey
                    ? `••••••••${settings.apiKeyLast4 ?? ''} (Nhập mới để thay thế)`
                    : 'AIzaSy…'
                }
                value={apiKey}
                onInput={(e) => {
                  setApiKey((e.target as HTMLInputElement).value);
                  setClearKey(false);
                }}
              />
              <button
                type="button"
                class="toggle-password-btn"
                title={showKey ? 'Ẩn API Key' : 'Hiện API Key'}
                onClick={() => setShowKey(!showKey)}
              >
                {showKey ? '🙈' : '👁'}
              </button>
            </div>
          </Field>

          {settings?.hasApiKey && (
            <div class="field-checkbox-wrap">
              <label class="field-checkbox">
                <input
                  type="checkbox"
                  checked={clearKey}
                  onChange={(e) => setClearKey((e.target as HTMLInputElement).checked)}
                />
                Xóa API Key đã lưu (Quay lại chế độ Scrape mặc định)
              </label>
            </div>
          )}

          <div class="settings-hint-box">
            <strong>💡 Mẹo:</strong> Khi không cài API Key, hệ thống vẫn có thể bóc tách transcript và metadata qua YouTube web parser fallback. Thêm API Key chính thức sẽ nâng tốc độ và độ tin cậy khi Spy các kênh lớn.
          </div>
        </section>

        {/* Section 2: Harvest Concurrency */}
        <section class="settings-section-card">
          <div class="settings-card-header">
            <h3>⚡ Luồng Thu thập Data (Concurrency)</h3>
          </div>

          <Field
            label="Số luồng chạy song song"
            sublabel="Giới hạn từ 1 đến 4 luồng đồng thời"
          >
            <CustomSelect
              value={String(concurrency)}
              onChange={(val) => setConcurrency(Number(val))}
              options={[
                { value: '1', label: '1 Luồng — An toàn & êm ái (Khuyến nghị)', description: 'Giảm tải CPU và quota' },
                { value: '2', label: '2 Luồng — Cân bằng tốt (Nhanh)', description: 'Tối ưu tốc độ cho đa số máy' },
                { value: '3', label: '3 Luồng — Tốc độ cao', description: 'Cần mạng ổn định' },
                { value: '4', label: '4 Luồng — Tối đa công suất', description: 'Tải dữ liệu nhiều kênh nhanh nhất' },
              ]}
            />
          </Field>
        </section>

        {/* Save Bar */}
        <div class="row" style={{ justifyContent: 'flex-end', gap: '0.75rem' }}>
          <button class="btn teal" disabled={busy} type="submit" style={{ minWidth: '130px' }}>
            {busy ? 'Đang lưu…' : 'Lưu Cấu Hình'}
          </button>
        </div>
      </form>

      {/* Section 3: Read-only paths */}
      {settings && (
        <section class="settings-section-card" style={{ marginTop: '0.5rem' }}>
          <div class="settings-card-header">
            <h3>📁 Thư mục Lưu trữ Dữ liệu (Read-Only)</h3>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
            <div>
              <span class="muted small" style={{ display: 'block', marginBottom: '0.35rem' }}>Data Root (Thư mục dữ liệu chính)</span>
              <div class="settings-path-box">
                <span class="path-code">{settings.dataRoot}</span>
                <button
                  type="button"
                  class="btn secondary icon-btn"
                  style={{ height: '32px', fontSize: '0.78rem', padding: '0 0.6rem' }}
                  onClick={() => void copyPath(settings.dataRoot, 'data')}
                >
                  {copiedPath === 'data' ? '✓ Đã copy' : '📋 Copy'}
                </button>
              </div>
            </div>

            <div>
              <span class="muted small" style={{ display: 'block', marginBottom: '0.35rem' }}>Spy Root (Thư mục lưu bài thu hoạch Spy)</span>
              <div class="settings-path-box">
                <span class="path-code">{settings.spyRoot}</span>
                <button
                  type="button"
                  class="btn secondary icon-btn"
                  style={{ height: '32px', fontSize: '0.78rem', padding: '0 0.6rem' }}
                  onClick={() => void copyPath(settings.spyRoot, 'spy')}
                >
                  {copiedPath === 'spy' ? '✓ Đã copy' : '📋 Copy'}
                </button>
              </div>
            </div>
          </div>

          <div class="settings-hint-box" style={{ background: 'rgba(18, 22, 28, 0.03)', borderColor: 'var(--line)' }}>
            ℹ️ Bạn có thể thay đổi vị trí lưu dữ liệu mặc định bằng cách thiết lập biến môi trường <code>WRITER_ROOM_DATA_DIR</code> trước khi khởi chạy Daemon.
          </div>
        </section>
      )}
    </div>
  );
}
