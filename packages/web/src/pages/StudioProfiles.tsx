import { useEffect, useMemo, useState } from 'preact/hooks';
import { api, type WriterProfileSummary, type WriterReadyProfile } from '../api.ts';
import { EntityId } from '../components/ui/EntityId.tsx';
import { href } from '../router.ts';

function sourceFormulaIds(profile: WriterReadyProfile): string[] {
  const ids = profile.guidelines.flatMap((guideline) =>
    guideline.sourceRuleIds
      .map((ref) => ref.split(':')[0])
      .filter((formulaId): formulaId is string => Boolean(formulaId)),
  );
  return [...new Set(ids)];
}

export function StudioProfilesPage() {
  const [profiles, setProfiles] = useState<WriterProfileSummary[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.listWriterProfiles()
      .then((result) => setProfiles(result.profiles))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const visible = useMemo(() => {
    if (!profiles) return [];
    const needle = query.trim().toLocaleLowerCase('vi');
    if (!needle) return profiles;
    return profiles.filter((profile) =>
      profile.id.toLocaleLowerCase().includes(needle)
      || profile.label.toLocaleLowerCase('vi').includes(needle)
      || `v${profile.version}`.includes(needle)
      || profile.readiness.toLocaleLowerCase().includes(needle),
    );
  }, [profiles, query]);

  return (
    <div>
      <div class="page-header">
        <div>
          <h1 class="page-title">Writer Profiles</h1>
          <p class="page-lead" style={{ marginBottom: 0 }}>
            Thư viện Profile do Studio quản lý. Writer chỉ chọn và ghim một phiên bản để viết.
          </p>
        </div>
        <a class="btn secondary" href={href({ name: 'studio' })}>← Studio</a>
      </div>

      {error && <p class="error">{error}</p>}

      <section class="panel">
        <label class="field">
          <span>Tìm Profile</span>
          <input
            type="search"
            value={query}
            onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
            placeholder="Nhập tên, ID, phiên bản hoặc trạng thái…"
            autofocus
          />
        </label>

        {!profiles && !error && <p class="muted">Đang tải…</p>}
        {profiles && profiles.length === 0 && (
          <p class="muted">Chưa có Profile nào. Profile được publish từ một phiên Studio.</p>
        )}
        {profiles && profiles.length > 0 && visible.length === 0 && (
          <p class="muted">Không tìm thấy Profile khớp “{query.trim()}”.</p>
        )}
        {visible.length > 0 && (
          <ul class="list" style={{ marginTop: '0.75rem' }}>
            {visible.map((profile) => (
              <li key={profile.id} class="pack-row">
                <div>
                  <a href={href({ name: 'studio-profile', id: profile.id })}>
                    <strong>{profile.label}</strong>
                  </a>
                  <div class="meta">
                    <EntityId id={profile.id} label="Profile ID" />
                    <span>v{profile.version}</span>
                    <span class={profile.readiness === 'VALIDATED' ? 'chip ok' : 'chip warn'}>
                      {profile.readiness}
                    </span>
                    <span>{profile.guidelineCount} guideline</span>
                    <span>{new Date(profile.createdAt).toLocaleString()}</span>
                  </div>
                </div>
                <a class="btn secondary" href={href({ name: 'studio-profile', id: profile.id })}>
                  Mở
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function StudioProfilePage({ id }: { id: string }) {
  const [profile, setProfile] = useState<WriterReadyProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.getWriterProfile(id)
      .then(setProfile)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [id]);

  if (error) {
    return (
      <div>
        <p class="error">{error}</p>
        <a class="btn secondary" href={href({ name: 'studio-profiles' })}>← Writer Profiles</a>
      </div>
    );
  }
  if (!profile) return <p class="muted">Đang tải…</p>;

  const formulaIds = sourceFormulaIds(profile);

  return (
    <div>
      <div class="page-header">
        <div>
          <div class="row" style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <h1 class="page-title" style={{ marginBottom: 0 }}>{profile.label}</h1>
            <span class={profile.readiness === 'VALIDATED' ? 'chip ok' : 'chip warn'}>
              {profile.readiness}
            </span>
            <EntityId id={profile.id} label="Profile ID" />
          </div>
          <p class="page-lead" style={{ marginBottom: 0 }}>
            Phiên bản v{profile.version} · tạo {new Date(profile.createdAt).toLocaleString()}
          </p>
        </div>
        <a class="btn secondary" href={href({ name: 'studio-profiles' })}>← Writer Profiles</a>
      </div>

      <section class="panel">
        <h2>Phạm vi và lời hứa biên tập</h2>
        <div class="meta" style={{ marginBottom: '0.75rem' }}>
          <span>Ngôn ngữ: {profile.scope.language}</span>
          {profile.scope.genre && <span>Thể loại: {profile.scope.genre}</span>}
          {profile.scope.contentModes.map((mode) => <span key={mode} class="chip">{mode}</span>)}
        </div>
        <p style={{ marginBottom: 0 }}>
          {profile.editorialPromise || 'Profile này chưa có lời hứa biên tập.'}
        </p>
      </section>

      <section class="panel" style={{ marginTop: '1rem' }}>
        <h2>Nguồn Formula ({formulaIds.length})</h2>
        {formulaIds.length === 0 ? (
          <p class="muted" style={{ marginBottom: 0 }}>
            Profile này không lưu rule nguồn — có thể là Profile thử hoặc bản được tạo thủ công.
          </p>
        ) : (
          <ul class="list">
            {formulaIds.map((formulaId) => (
              <li key={formulaId} class="pack-row">
                <EntityId id={formulaId} label="Formula ID" />
                <a class="btn secondary" href={href({ name: 'training-formula', id: formulaId })}>
                  Mở Formula
                </a>
              </li>
            ))}
          </ul>
        )}
        <p class="muted" style={{ marginBottom: 0, marginTop: '0.65rem' }}>
          Profile cũ chưa lưu ID phiên Studio; rule nguồn bên dưới vẫn giữ được đường truy ngược về Formula.
        </p>
      </section>

      <section class="panel" style={{ marginTop: '1rem' }}>
        <h2>Guidelines ({profile.guidelines.length})</h2>
        {profile.guidelines.length === 0 ? (
          <p class="muted">Không có guideline.</p>
        ) : (
          <ul class="list">
            {profile.guidelines.map((guideline) => (
              <li key={guideline.id}>
                <strong>{guideline.instruction}</strong>
                <div class="meta">
                  <EntityId id={guideline.id} label="Guideline ID" />
                  <span class={guideline.priority === 'CORE' ? 'chip warn' : 'chip'}>
                    {guideline.priority}
                  </span>
                </div>
                {guideline.when && <p style={{ margin: '0.35rem 0 0' }}><strong>Khi:</strong> {guideline.when}</p>}
                {guideline.avoidWhen && (
                  <p style={{ margin: '0.15rem 0 0' }}><strong>Tránh khi:</strong> {guideline.avoidWhen}</p>
                )}
                {guideline.sourceRuleIds.length > 0 && (
                  <div class="meta" style={{ marginTop: '0.4rem' }}>
                    {guideline.sourceRuleIds.map((ruleRef) => (
                      <EntityId key={ruleRef} id={ruleRef} label="Rule nguồn" />
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section class="panel" style={{ marginTop: '1rem' }}>
        <h2>Không được làm ({profile.antiPatterns.length})</h2>
        {profile.antiPatterns.length === 0 ? (
          <p class="muted">Không có mục nào.</p>
        ) : (
          <ul class="list">
            {profile.antiPatterns.map((pattern, index) => (
              <li key={`${index}-${pattern}`}>
                <div class="row" style={{ gap: '0.5rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <EntityId
                    id={`${profile.id}:anti-pattern:${index + 1}`}
                    label="ID tham chiếu"
                    displayId={`AP-${String(index + 1).padStart(2, '0')}`}
                  />
                  <span>{pattern}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
