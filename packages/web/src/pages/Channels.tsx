import { useEffect, useState } from 'preact/hooks';
import {
  api,
  type ChannelProfile,
  type ChannelStyleSummary,
  type EditorialNotebook,
  type EditorialSuggestion,
  type GeneralPackSummary,
  type LessonKind,
  type ReusableProcedure,
} from '../api.ts';
import { href } from '../router.ts';

const KIND_LABEL: Record<LessonKind, string> = {
  KEEP: 'Nên giữ',
  AVOID: 'Nên tránh',
  TRY: 'Nên thử',
};

interface ProfileDraft {
  id: string;
  displayName: string;
  topic: string;
  youtubeIds: string;
  audience: string;
  defaultGeneralPack: string;
  defaultFormulaId: string;
  defaultStyle: string;
  defaultProcedure: string;
}

const EMPTY_PROFILE: ProfileDraft = {
  id: '', displayName: '', topic: '', youtubeIds: '', audience: '',
  defaultGeneralPack: '', defaultFormulaId: '', defaultStyle: '', defaultProcedure: '',
};

function draftOf(profile: ChannelProfile): ProfileDraft {
  return {
    id: profile.id,
    displayName: profile.displayName,
    topic: profile.topic,
    youtubeIds: profile.youtubeIds.join('\n'),
    audience: profile.audience ?? '',
    defaultGeneralPack: profile.defaultGeneralPack ?? '',
    defaultFormulaId: profile.defaultFormulaId ?? '',
    defaultStyle: profile.defaultStyle ?? '',
    defaultProcedure: profile.defaultProcedure ?? '',
  };
}

function payloadOf(draft: ProfileDraft) {
  return {
    id: draft.id.trim(),
    displayName: draft.displayName.trim(),
    topic: draft.topic.trim(),
    youtubeIds: draft.youtubeIds.split(/[\n,]/).map((value) => value.trim()).filter(Boolean),
    ...(draft.audience.trim() ? { audience: draft.audience.trim() } : {}),
    ...(draft.defaultGeneralPack ? { defaultGeneralPack: draft.defaultGeneralPack } : {}),
    ...(draft.defaultFormulaId ? { defaultFormulaId: draft.defaultFormulaId } : {}),
    ...(draft.defaultStyle ? { defaultStyle: draft.defaultStyle } : {}),
    ...(draft.defaultProcedure ? { defaultProcedure: draft.defaultProcedure } : {}),
  };
}

export function ChannelsPage({ id }: { id?: string }) {
  const [channels, setChannels] = useState<ChannelProfile[]>([]);
  const [selectedId, setSelectedId] = useState(id ?? '');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_PROFILE);
  const [notebook, setNotebook] = useState<EditorialNotebook | null>(null);
  const [editorial, setEditorial] = useState('');
  const [suggestions, setSuggestions] = useState<EditorialSuggestion[]>([]);
  const [generalPacks, setGeneralPacks] = useState<GeneralPackSummary[]>([]);
  const [styles, setStyles] = useState<ChannelStyleSummary[]>([]);
  const [procedures, setProcedures] = useState<ReusableProcedure[]>([]);
  const [procedureId, setProcedureId] = useState('');
  const [procedureDescription, setProcedureDescription] = useState('');
  const [procedureInstructions, setProcedureInstructions] = useState('');
  const [newProcedure, setNewProcedure] = useState(false);
  const [manualKind, setManualKind] = useState<LessonKind>('TRY');
  const [manualLesson, setManualLesson] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadCatalogs = async () => {
    const [channelData, generalData, styleData, procedureData] = await Promise.all([
      api.listChannelProfiles(), api.listGeneralPacks(),
      api.listChannelStyles(), api.listReusableProcedures(),
    ]);
    setChannels(channelData.channels);
    setGeneralPacks(generalData.packs);
    setStyles(styleData.styles);
    setProcedures(procedureData.procedures);
    if (!id && !selectedId && channelData.channels[0]) setSelectedId(channelData.channels[0].id);
  };

  useEffect(() => {
    void loadCatalogs().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    if (id) setSelectedId(id);
  }, [id]);

  useEffect(() => {
    if (!selectedId || creating) {
      setNotebook(null);
      setSuggestions([]);
      return;
    }
    const profile = channels.find((channel) => channel.id === selectedId);
    if (profile) setDraft(draftOf(profile));
    void Promise.all([api.getEditorialNotebook(selectedId), api.listEditorialSuggestions(selectedId)])
      .then(([nextNotebook, inbox]) => {
        setNotebook(nextNotebook);
        setEditorial(nextNotebook.markdown);
        setSuggestions(inbox.suggestions);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [selectedId, creating, channels]);

  useEffect(() => {
    if (newProcedure || !procedureId) return;
    const procedure = procedures.find((item) => item.id === procedureId);
    if (!procedure) return;
    setProcedureDescription(procedure.description);
    setProcedureInstructions(procedure.instructions);
  }, [procedureId, procedures, newProcedure]);

  const saveProfile = async () => {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const payload = payloadOf(draft);
      const saved = creating
        ? await api.createChannelProfile(payload)
        : await api.updateChannelProfile(selectedId, payload);
      await loadCatalogs();
      setCreating(false);
      setSelectedId(saved.id);
      location.hash = href({ name: 'publishing-channels', id: saved.id });
      setNotice(creating ? 'Đã tạo Hồ sơ kênh và sổ tay trống.' : 'Đã lưu Hồ sơ kênh.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  const saveEditorial = async () => {
    if (!notebook || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const saved = await api.updateEditorialNotebook(selectedId, editorial, notebook.hash);
      setNotebook(saved); setEditorial(saved.markdown);
      setNotice('Đã lưu Sổ tay biên tập. Bài mới sẽ pin bản này khi Save configuration.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  const approve = async (suggestion: EditorialSuggestion) => {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const saved = await api.approveEditorialSuggestion(selectedId, suggestion);
      const inbox = await api.listEditorialSuggestions(selectedId);
      setNotebook(saved); setEditorial(saved.markdown); setSuggestions(inbox.suggestions);
      setNotice('Đã duyệt kinh nghiệm vào Sổ tay biên tập.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  const dismiss = async (suggestion: EditorialSuggestion) => {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await api.dismissEditorialSuggestion(selectedId, suggestion);
      setSuggestions((await api.listEditorialSuggestions(selectedId)).suggestions);
      setNotice('Đã bỏ qua kinh nghiệm này.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  const addManualSuggestion = async () => {
    if (!manualLesson.trim() || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await api.addEditorialSuggestion(selectedId, { kind: manualKind, text: manualLesson.trim() });
      setSuggestions((await api.listEditorialSuggestions(selectedId)).suggestions);
      setManualLesson(''); setNotice('Đã thêm ghi chú vào hộp chờ.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  const saveProcedure = async () => {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const saved = newProcedure
        ? await api.createReusableProcedure({
            id: procedureId, description: procedureDescription, instructions: procedureInstructions,
          })
        : await api.updateReusableProcedure(procedureId, {
            description: procedureDescription, instructions: procedureInstructions,
          });
      const data = await api.listReusableProcedures();
      setProcedures(data.procedures); setProcedureId(saved.id); setNewProcedure(false);
      setNotice(`Đã lưu ${saved.path}. Có thể chọn nó làm quy trình mặc định của kênh.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  const selected = channels.find((channel) => channel.id === selectedId);

  return (
    <div>
      <div class="page-head">
        <div>
          <h1>Kênh & kinh nghiệm</h1>
          <p class="muted">Hồ sơ kênh → sổ tay đã duyệt → tổng kết sau bài → quy trình dùng lại.</p>
        </div>
        <button class="btn teal" type="button" onClick={() => {
          setCreating(true); setSelectedId(''); setDraft(EMPTY_PROFILE); setNotebook(null); setSuggestions([]);
          setNotice(null); setError(null); location.hash = href({ name: 'publishing-channels' });
        }}>+ Tạo Hồ sơ kênh</button>
      </div>

      {error && <p class="error">{error}</p>}
      {notice && <p class="success">{notice}</p>}

      <div class="channel-memory-layout">
        <aside class="panel channel-memory-list">
          <h2>Kênh của tôi</h2>
          {channels.length === 0 && <p class="muted">Chưa có kênh. Tạo thủ công; app không lấy kênh đối thủ để tạo hộ.</p>}
          {channels.map((channel) => (
            <a
              key={channel.id}
              class={`channel-memory-item ${selectedId === channel.id && !creating ? 'active' : ''}`}
              href={href({ name: 'publishing-channels', id: channel.id })}
              onClick={() => { setCreating(false); setSelectedId(channel.id); }}
            >
              <strong>{channel.displayName}</strong>
              <span>{channel.topic}</span>
            </a>
          ))}
        </aside>

        <div class="channel-memory-main">
          {(creating || selected) && (
            <section class="panel">
              <h2>1. Hồ sơ kênh</h2>
              <p class="muted">Đây là kênh xuất bản của anh, không phải topic research hay kênh đối thủ trong Spy.</p>
              <div class="form-grid-3">
                <label class="field"><span>Mã kênh</span><input value={draft.id} disabled={!creating} placeholder="tai-chinh" onInput={(e) => setDraft({ ...draft, id: (e.target as HTMLInputElement).value })} /></label>
                <label class="field"><span>Tên hiển thị</span><input value={draft.displayName} onInput={(e) => setDraft({ ...draft, displayName: (e.target as HTMLInputElement).value })} /></label>
                <label class="field"><span>Chủ đề chính</span><input value={draft.topic} placeholder="Tài chính cá nhân" onInput={(e) => setDraft({ ...draft, topic: (e.target as HTMLInputElement).value })} /></label>
              </div>
              <label class="field"><span>Khán giả mặc định</span><input value={draft.audience} onInput={(e) => setDraft({ ...draft, audience: (e.target as HTMLInputElement).value })} /></label>
              <label class="field"><span>YouTube channel ID của mình (mỗi dòng một ID, chỉ là alias)</span><textarea value={draft.youtubeIds} onInput={(e) => setDraft({ ...draft, youtubeIds: (e.target as HTMLTextAreaElement).value })} /></label>
              <div class="form-grid-2">
                <label class="field"><span>General Pack mặc định</span><select value={draft.defaultGeneralPack} onChange={(e) => setDraft({ ...draft, defaultGeneralPack: (e.target as HTMLSelectElement).value })}><option value="">Không đặt</option>{generalPacks.map((item) => <option value={item.path}>{item.title}</option>)}</select></label>
                <label class="field"><span>Style mặc định (chỉ dùng khi restyle)</span><select value={draft.defaultStyle} onChange={(e) => setDraft({ ...draft, defaultStyle: (e.target as HTMLSelectElement).value })}><option value="">Không đặt</option>{styles.map((item) => <option value={item.path}>{item.title}</option>)}</select></label>
                <label class="field"><span>Quy trình dùng lại mặc định</span><select value={draft.defaultProcedure} onChange={(e) => setDraft({ ...draft, defaultProcedure: (e.target as HTMLSelectElement).value })}><option value="">Không đặt</option>{procedures.map((item) => <option value={item.id}>{item.id}</option>)}</select></label>
              </div>
              <button class="btn teal" type="button" disabled={busy} onClick={() => void saveProfile()}>{busy ? 'Đang lưu…' : creating ? 'Tạo kênh' : 'Lưu hồ sơ'}</button>
            </section>
          )}

          {!creating && selected && notebook && (
            <>
              <section class="panel" style={{ marginTop: '1rem' }}>
                <h2>2. Sổ tay biên tập</h2>
                <p class="muted">Source of truth do người viết duyệt. Writer chỉ đọc file này ở WRITE; không dùng làm nguồn dữ kiện.</p>
                <textarea class="editorial-editor" value={editorial} onInput={(e) => setEditorial((e.target as HTMLTextAreaElement).value)} />
                <div class="row" style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <button class="btn teal" type="button" disabled={busy || editorial === notebook.markdown} onClick={() => void saveEditorial()}>Lưu sổ tay</button>
                  <span class="muted small">{notebook.wordCount} từ · sha256 {notebook.hash.slice(0, 12)}…</span>
                </div>
              </section>

              <section class="panel" style={{ marginTop: '1rem' }}>
                <h2>3. Kinh nghiệm chờ duyệt</h2>
                <p class="muted">Tổng kết của agent không tự thành luật. Duyệt từng điều có giá trị bền vững.</p>
                {suggestions.length === 0 && <p class="muted">Chưa có đề xuất.</p>}
                <div class="lesson-list">
                  {suggestions.map((suggestion, index) => (
                    <div class="lesson-card" key={`${suggestion.sourceRunId ?? 'manual'}-${index}`}>
                      <div><span class={`chip lesson-${suggestion.kind.toLowerCase()}`}>{KIND_LABEL[suggestion.kind]}</span>{suggestion.sourceRunId && <span class="muted small"> run {suggestion.sourceRunId.slice(0, 8)}</span>}</div>
                      <strong>{suggestion.text}</strong>
                      {suggestion.reason && <p class="muted small">{suggestion.reason}</p>}
                      <div class="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
                        <button class="btn secondary" type="button" disabled={busy} onClick={() => void approve(suggestion)}>Duyệt vào sổ tay</button>
                        <button class="btn ghost" type="button" disabled={busy} onClick={() => void dismiss(suggestion)}>Bỏ qua</button>
                      </div>
                    </div>
                  ))}
                </div>
                <div class="row" style={{ gap: '0.5rem', alignItems: 'end', marginTop: '0.75rem' }}>
                  <label class="field" style={{ maxWidth: '9rem' }}><span>Loại</span><select value={manualKind} onChange={(e) => setManualKind((e.target as HTMLSelectElement).value as LessonKind)}><option value="KEEP">Nên giữ</option><option value="AVOID">Nên tránh</option><option value="TRY">Nên thử</option></select></label>
                  <label class="field" style={{ flex: 1 }}><span>Ghi chú thủ công</span><input value={manualLesson} onInput={(e) => setManualLesson((e.target as HTMLInputElement).value)} /></label>
                  <button class="btn secondary" type="button" disabled={busy || !manualLesson.trim()} onClick={() => void addManualSuggestion()}>Thêm vào hộp chờ</button>
                </div>
              </section>
            </>
          )}

          <section class="panel" style={{ marginTop: '1rem' }}>
            <div class="row between" style={{ alignItems: 'center' }}><div><h2>4. Quy trình dùng lại</h2><p class="muted">Mỗi quy trình là một SKILL.md chuẩn, có mô tả kích hoạt và hướng dẫn thực hiện.</p></div><button class="btn secondary" type="button" onClick={() => { setNewProcedure(true); setProcedureId(''); setProcedureDescription(''); setProcedureInstructions(''); }}>+ Quy trình mới</button></div>
            <label class="field"><span>Quy trình</span><select value={procedureId} disabled={newProcedure} onChange={(e) => setProcedureId((e.target as HTMLSelectElement).value)}><option value="">Chọn quy trình…</option>{procedures.map((item) => <option value={item.id}>{item.id}</option>)}</select></label>
            <label class="field"><span>Mã quy trình</span><input value={procedureId} disabled={!newProcedure} placeholder="viet-video-tai-chinh" onInput={(e) => setProcedureId((e.target as HTMLInputElement).value)} /></label>
            <label class="field"><span>Mô tả kích hoạt (khi nào Codex nên dùng)</span><textarea value={procedureDescription} onInput={(e) => setProcedureDescription((e.target as HTMLTextAreaElement).value)} /></label>
            <label class="field"><span>Hướng dẫn từng bước</span><textarea class="procedure-editor" value={procedureInstructions} onInput={(e) => setProcedureInstructions((e.target as HTMLTextAreaElement).value)} /></label>
            <button class="btn teal" type="button" disabled={busy || !procedureId} onClick={() => void saveProcedure()}>{newProcedure ? 'Tạo SKILL.md' : 'Lưu quy trình'}</button>
          </section>
        </div>
      </div>
    </div>
  );
}
