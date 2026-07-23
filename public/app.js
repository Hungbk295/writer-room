const state = {
  activeTab: 'room', runs: [], activeId: null, details: null,
  versions: [], selectedVersionId: null, compare: false, compareVersionId: null,
  articles: [], activeArticleId: null, articleDetails: null, includeArchived: false,
  agents: [], models: {}, customModelSlots: new Set(), health: null, consoleOpen: false, consoleRole: 'writer', logs: [],
  poller: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const esc = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

const nativeInvoke = window.__TAURI__?.core?.invoke;

async function webCall(method, params = {}) {
  const routes = {
    health: ['GET', '/api/health'],
    'models.list': ['GET', '/api/models'],
    'agents.list': ['GET', '/api/agents'],
    'agents.save': ['PUT', '/api/agents', { agents: params.agents }],
    'runs.list': ['GET', '/api/runs'],
    'runs.create': ['POST', '/api/runs', params],
    'runs.get': ['GET', `/api/runs/${encodeURIComponent(params.id)}`],
    'runs.logs': ['GET', `/api/runs/${encodeURIComponent(params.id)}/logs`],
    'runs.cancel': ['DELETE', `/api/runs/${encodeURIComponent(params.id)}`],
    'runs.retry': ['POST', `/api/runs/${encodeURIComponent(params.id)}/retry`, {}],
    'runs.retry-snapshot': ['POST', `/api/runs/${encodeURIComponent(params.id)}/retry-snapshot`, {}],
    'runs.retry-current-agent': ['POST', `/api/runs/${encodeURIComponent(params.id)}/retry-current-agent`, {}],
    'runs.human': ['POST', `/api/runs/${encodeURIComponent(params.id)}/human`, params.brief],
    'runs.continue': ['POST', `/api/runs/${encodeURIComponent(params.id)}/continue`, { note: params.note }],
    'runs.accept': ['POST', `/api/runs/${encodeURIComponent(params.id)}/accept`, { reason: params.reason }],
    'runs.export-draft': ['POST', `/api/runs/${encodeURIComponent(params.id)}/export-draft`, { round: params.round }],
    'articles.get': ['GET', `/api/articles/${encodeURIComponent(params.id)}`],
    'articles.export': ['POST', `/api/articles/${encodeURIComponent(params.id)}/export`, {}],
    'articles.backup': ['POST', '/api/articles/backup', {}],
    'articles.archive': ['POST', `/api/articles/${encodeURIComponent(params.id)}/${params.archived === false ? 'restore' : 'archive'}`, {}],
  };
  if (method === 'articles.list') {
    const query = new URLSearchParams();
    if (params.query) query.set('query', params.query);
    if (params.includeArchived) query.set('archived', '1');
    routes[method] = ['GET', `/api/articles?${query}`];
  }
  const route = routes[method];
  if (!route) throw new Error(`Unsupported call: ${method}`);
  const [verb, path, body] = route;
  const response = await fetch(path, {
    method: verb,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function call(method, params = {}) {
  if (nativeInvoke) return nativeInvoke('writer_room_call', { method, params });
  return webCall(method, params);
}

function toast(message, error = false) {
  const existing = $('.app-toast');
  existing?.remove();
  const el = document.createElement('div');
  el.className = `app-toast ${error ? 'error' : ''}`;
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 3600);
}

const STAGES = {
  writer_init: 'Agent 1 đang chuẩn bị evidence', awaiting_human: 'Chờ bạn khóa angle & hook',
  writer_human: 'Agent 1 đang viết bản chấm điểm', editor: 'Agent 2 đang biên tập',
  writer_revision: 'Agent 1 đang sửa', awaiting_round_human: 'Chờ note biên tập',
  needs_human: 'Cần quyết định của bạn', seo: 'Agent 3 đang kiểm SEO',
  complete: 'Hoàn tất', failed: 'Cần xử lý lỗi', cancelled: 'Đã dừng',
};

const ACTIVE_STAGES = new Set(['writer_init', 'writer_human', 'editor', 'writer_revision', 'seo']);
const WAITING_STAGES = new Set(['awaiting_human', 'awaiting_round_human', 'needs_human']);
const stageLabel = (value) => STAGES[value] || value;
const latestScore = (run) => run?.scores?.at(-1)?.score ?? null;
const dateLabel = (value) => value ? new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—';

function markdown(value, compact = false) {
  const lines = String(value || '').replaceAll('\r', '').split('\n');
  const out = [];
  let list = [];
  const flush = () => {
    if (!list.length) return;
    out.push(`<ul class="bullet-list">${list.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`);
    list = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const item = line.match(/^[-*]\s+(.+)/);
    if (item) { list.push(item[1]); continue; }
    flush();
    if (!line.trim()) out.push('<div class="paragraph-gap"></div>');
    else if (/^###\s+/.test(line)) out.push(`<h4>${esc(line.replace(/^###\s+/, ''))}</h4>`);
    else if (/^##\s+/.test(line)) out.push(`<h3>${esc(line.replace(/^##\s+/, ''))}</h3>`);
    else if (/^#\s+/.test(line)) out.push(`<h2>${esc(line.replace(/^#\s+/, ''))}</h2>`);
    else out.push(`<p>${esc(line)}</p>`);
  }
  flush();
  return `<article class="rendered-script ${compact ? 'compact' : ''}">${out.join('')}</article>`;
}

function statusDot(stage) {
  if (ACTIVE_STAGES.has(stage)) return 'running';
  if (WAITING_STAGES.has(stage)) return 'waiting';
  if (stage === 'failed' || stage === 'cancelled') return 'failed';
  return '';
}

async function loadHealth() {
  const el = $('#health');
  try {
    state.health = await call('health');
    const missing = Object.entries(state.health.tools || {}).filter(([, ready]) => !ready).map(([name]) => name);
    el.className = `health ${state.health.ok ? 'ok' : 'bad'}`;
    el.innerHTML = `<i></i>${esc(state.health.mock ? 'Mock mode · sẵn sàng' : state.health.ok ? `${state.health.transport || 'runtime'} · 3 agents sẵn sàng` : `Thiếu: ${missing.join(', ')}`)}`;
  } catch (error) {
    el.className = 'health bad';
    el.innerHTML = `<i></i>${esc(error.message)}`;
  }
}

async function loadRuns({ selectNewest = false, details = true } = {}) {
  state.runs = await call('runs.list');
  if (selectNewest && state.runs[0]) state.activeId = state.runs[0].id;
  if (state.activeId && !state.runs.some((run) => run.id === state.activeId)) state.activeId = state.runs[0]?.id || null;
  renderRail();
  if (details && state.activeId) await loadDetails();
}

async function loadDetails() {
  if (!state.activeId) return;
  try {
    const next = await call('runs.get', { id: state.activeId });
    if (state.details?.state.id === next.state.id && state.details.state.revision === next.state.revision) {
      if (state.consoleOpen) await loadLogs();
      return;
    }
    state.details = next;
    buildVersions();
    renderRoom();
    renderInspector();
    if (state.consoleOpen) await loadLogs();
  } catch (error) {
    toast(error.message, true);
  }
}

function buildVersions() {
  const details = state.details;
  const rows = [];
  if (details?.initial) rows.push({ id: 'init', label: 'Init', kind: 'init', title: 'Evidence, insight & exploratory draft', value: details.initial });
  if (details?.humanBrief) rows.push({ id: 'human', label: 'Human brief', kind: 'human', title: 'Quyết định của người viết', value: details.humanBrief });
  for (const round of details?.rounds || []) {
    if (round.draft) rows.push({ id: `draft-${round.round}`, label: `Draft ${round.round}`, kind: 'draft', title: `Bản viết · vòng ${round.round}`, value: round.draft, round: round.round, score: round.score });
    if (round.review) rows.push({ id: `review-${round.round}`, label: `Review ${round.round}`, kind: 'review', title: `Nhận xét · vòng ${round.round}`, value: round.review, round: round.round, score: round.score });
  }
  if (details?.seo) rows.push({ id: 'seo', label: 'SEO', kind: 'seo', title: 'SEO review', value: details.seo });
  state.versions = rows;
  if (!rows.some((row) => row.id === state.selectedVersionId)) {
    state.selectedVersionId = rows.at(-1)?.id || null;
  }
  if (!rows.some((row) => row.id === state.compareVersionId) || state.compareVersionId === state.selectedVersionId) {
    state.compareVersionId = rows.find((row) => row.id !== state.selectedVersionId)?.id || null;
  }
}

function renderRail() {
  const list = $('#rail-list');
  const query = $('#rail-search').value.trim().toLocaleLowerCase('vi');
  if (state.activeTab === 'library') {
    const rows = state.articles.filter((item) => !query || `${item.title} ${item.excerpt}`.toLocaleLowerCase('vi').includes(query));
    $('#rail-kicker').textContent = 'ARTICLE LIBRARY';
    $('#rail-title').textContent = 'Bài đã hoàn tất';
    $('#new-run').classList.add('hidden');
    $('#rail-count').textContent = `${rows.length} bài`;
    list.innerHTML = rows.length ? rows.map((item) => `
      <button class="rail-item ${item.id === state.activeArticleId ? 'active' : ''}" data-article="${esc(item.id)}" type="button">
        <i class="rail-dot ${item.status === 'archived' ? 'failed' : ''}"></i>
        <span class="rail-copy"><strong>${esc(item.title)}</strong><small>Final r${item.acceptedRound} · ${dateLabel(item.updatedAt)}</small></span>
        <span class="rail-score">${item.finalScore ?? '—'}</span>
      </button>`).join('') : '<p class="rail-empty">Chưa có bài final phù hợp.</p>';
    $$('[data-article]').forEach((button) => button.addEventListener('click', () => selectArticle(button.dataset.article)));
    return;
  }
  if (state.activeTab === 'agents') {
    $('#rail-kicker').textContent = 'AGENT SLOTS';
    $('#rail-title').textContent = 'Runtime profiles';
    $('#new-run').classList.add('hidden');
    $('#rail-count').textContent = '3 slots cố định';
    list.innerHTML = state.agents.map((agent, index) => `<div class="rail-item static"><i class="rail-dot running"></i><span class="rail-copy"><strong>Agent ${index + 1}</strong><small>${esc(agent.adapter)} · ${esc(agent.model || 'provider default')}</small></span></div>`).join('');
    return;
  }
  const rows = state.runs.filter((run) => !query || run.config.title.toLocaleLowerCase('vi').includes(query));
  $('#rail-kicker').textContent = 'PROJECTS';
  $('#rail-title').textContent = 'Bài đang viết';
  $('#new-run').classList.remove('hidden');
  $('#rail-count').textContent = `${rows.length} run`;
  list.innerHTML = rows.length ? rows.map((run) => `
    <button class="rail-item ${run.id === state.activeId ? 'active' : ''}" data-run="${esc(run.id)}" type="button">
      <i class="rail-dot ${statusDot(run.stage)}"></i>
      <span class="rail-copy"><strong>${esc(run.config.title)}</strong><small>${esc(stageLabel(run.stage))} · ${dateLabel(run.updatedAt)}</small></span>
      <span class="rail-score">${latestScore(run) ?? '—'}</span>
    </button>`).join('') : '<p class="rail-empty">Chưa có run. Nhấn ＋ để bắt đầu.</p>';
  $$('[data-run]').forEach((button) => button.addEventListener('click', async () => {
    state.activeId = button.dataset.run;
    state.selectedVersionId = null;
    state.compare = false;
    renderRail();
    await loadDetails();
  }));
}

function renderVersionRibbon() {
  const ribbon = $('#version-ribbon');
  ribbon.innerHTML = state.versions.length ? state.versions.map((row, index) => `
    <button class="version-chip ${row.kind === 'review' ? 'review' : ''} ${row.id === state.selectedVersionId ? 'active' : ''}" data-version="${row.id}" type="button">
      <span>${String(index + 1).padStart(2, '0')}</span>${esc(row.label)}${row.score == null ? '' : ` · ${row.score}`}
    </button>`).join('') : '<span class="muted">Agent artifacts sẽ xuất hiện tại đây.</span>';
  $$('[data-version]').forEach((button) => button.addEventListener('click', () => {
    state.selectedVersionId = button.dataset.version;
    if (state.compareVersionId === state.selectedVersionId) state.compareVersionId = state.versions.find((row) => row.id !== state.selectedVersionId)?.id || null;
    renderRoom();
    renderInspector();
  }));
  const compareSelect = $('#compare-version');
  const options = state.versions.filter((row) => row.id !== state.selectedVersionId);
  compareSelect.innerHTML = options.map((row) => `<option value="${row.id}" ${row.id === state.compareVersionId ? 'selected' : ''}>${esc(row.label)}</option>`).join('');
  compareSelect.classList.toggle('hidden', !state.compare);
  $('#compare-toggle').textContent = state.compare ? 'Một bản' : 'So sánh';
  $('#compare-toggle').disabled = state.versions.length < 2;
}

function renderInit(init) {
  return `<div class="article-paper">
    <div class="article-meta"><span class="pill">${init.evidenceLedger.length} evidence</span><span class="pill">${init.insightStatements.length} insight</span><span class="pill orange">3 angle · 6 hook</span><button class="outline-button compact-button" data-export-draft="init" type="button">✦ Xuất TXT</button></div>
    <section class="section-card"><h3>Insight statements</h3>${init.insightStatements.map((item) => `<p><strong>${esc(item.statement)}</strong><br><small>${esc(item.tension)} · evidence ${esc(item.evidenceIds.join(', '))}</small></p>`).join('')}</section>
    ${markdown(init.draftMarkdown)}
  </div>`;
}

function renderHumanBrief(brief) {
  const initial = state.details?.initial;
  const angle = initial?.outlineOptions.find((item) => item.id === brief.selectedAngleId);
  const hook = brief.selectedHookId === 'custom' ? brief.customHook : initial?.hookOptions.find((item) => item.id === brief.selectedHookId)?.text;
  return `<div class="article-paper"><div class="section-card"><h3>${esc(angle?.label || brief.selectedAngleId)}</h3><p>${esc(angle?.angle || '')}</p></div><div class="section-card"><h3>Hook đã khóa</h3><p>${esc(hook || '')}</p></div><div class="section-card"><h3>Phỏng vấn người viết</h3>${Object.entries(brief.answers || {}).map(([key, value]) => `<p><small>${esc(key)}</small><br>${esc(value || 'Không bổ sung')}</p>`).join('')}</div></div>`;
}

function renderDraft(row) {
  return `<div class="article-paper"><div class="article-meta"><span class="pill">Draft ${row.round}</span>${row.score == null ? '' : `<span class="pill orange">Score ${row.score}</span>`}<button class="outline-button compact-button" data-export-draft="${row.round}" type="button">✦ Xuất TXT</button></div>${markdown(row.value.draftMarkdown)}${row.value.changeLog?.length ? `<section class="section-card"><h3>Change log</h3><ul class="bullet-list">${row.value.changeLog.map((item) => `<li>${esc(item)}</li>`).join('')}</ul></section>` : ''}</div>`;
}

function renderReview(row) {
  const review = row.value;
  return `<div class="article-paper"><div class="article-meta"><span class="score-big ${review.verdict === 'pass' ? '' : 'fail'}">${row.score ?? review.modelOverall ?? '—'}</span><span class="pill ${review.verdict === 'pass' ? '' : 'orange'}">${esc(review.verdict)}</span></div>
    <section class="section-card review-card"><h3>Editor summary</h3><p>${esc(review.summary)}</p></section>
    <div class="score-grid">${review.criteriaScores.map((item) => `<div class="score-row"><strong>${esc(item.criterion)}</strong><b>${item.score} × ${item.weight}</b><p>${esc(item.evidence)}${item.fix ? `<br><strong>Fix:</strong> ${esc(item.fix)}` : ''}</p></div>`).join('')}</div>
    ${review.blockingIssues.length ? `<section class="section-card review-card"><h3>Blocking issues</h3><ul class="bullet-list">${review.blockingIssues.map((item) => `<li>${esc(item)}</li>`).join('')}</ul></section>` : ''}
    ${review.revisionPlan.length ? `<section class="section-card"><h3>Revision plan</h3><ol class="bullet-list">${review.revisionPlan.map((item) => `<li>${esc(item)}</li>`).join('')}</ol></section>` : ''}</div>`;
}

function renderSeo(seo) {
  return `<div class="article-paper"><div class="article-meta"><span class="score-big">${seo.score}</span><span class="pill">${esc(seo.verdict)}</span></div>
    <div class="score-grid">${seo.checks.map((item) => `<div class="score-row"><strong>${esc(item.criterion)}</strong><b>${item.score}</b><p>${esc(item.evidence)}${item.recommendation ? `<br>${esc(item.recommendation)}` : ''}</p></div>`).join('')}</div>
    <section class="section-card"><h3>Title suggestions</h3><ul class="bullet-list">${seo.titleSuggestions.map((item) => `<li>${esc(item)}</li>`).join('') || '<li>Giữ title hiện tại</li>'}</ul></section>
    <section class="section-card"><h3>Keywords</h3><p>${esc(seo.keywords.join(' · '))}</p></section></div>`;
}

function renderVersion(row) {
  if (!row) return '<div class="empty-state"><p>Chưa có artifact.</p></div>';
  if (row.kind === 'init') return renderInit(row.value);
  if (row.kind === 'human') return renderHumanBrief(row.value);
  if (row.kind === 'draft') return renderDraft(row);
  if (row.kind === 'review') return renderReview(row);
  return renderSeo(row.value);
}

function riskFlags(option) {
  return [...(option.riskFlags || []), `truth ${option.truthRisk || '—'}`, `clickbait ${option.clickbaitRisk || '—'}`]
    .filter((item) => !item.endsWith('—')).map((item) => `<i>${esc(item)}</i>`).join('');
}

function renderAuthorRoom(init) {
  return `<form id="human-form" class="author-room">
    <section class="author-intro"><span class="kicker">AUTHOR ROOM · HUMAN GATE</span><h2>Agent đã chuẩn bị dữ liệu. Bạn khóa góc nhìn.</h2><p>Không có lựa chọn mặc định. Hãy chọn angle đúng với insight khán giả của bạn; sau đó UI mới mở đúng hai hook thuộc angle đó.</p></section>
    <section class="author-step"><h3>1 · Chọn angle / throughline</h3><p>Mỗi angle là một giả thuyết biên tập khác nhau, có evidence và payoff riêng.</p><div class="option-grid">
      ${init.outlineOptions.map((option) => `<label class="option-card"><input type="radio" name="angle" value="${esc(option.id)}"><strong>${esc(option.label)}${option.recommended ? ' · Agent đề xuất' : ''}</strong><span>${esc(option.angle)}</span><small>${esc(option.centralQuestion)}<br><b>Payoff:</b> ${esc(option.audiencePayoff)}</small><small class="evidence-line">${esc(option.evidenceIds.join(' · '))}</small><span class="option-risk">${riskFlags(option)}</span></label>`).join('')}
    </div></section>
    <section id="hook-step" class="author-step muted-step"><h3>2 · Chọn hook</h3><p id="hook-help">Chọn angle trước để xem đúng hai hook liên quan.</p><div class="hook-grid">
      ${init.hookOptions.map((hook) => `<label class="option-card hook-card" data-angle="${esc(hook.angleId)}" hidden><input type="radio" name="hook" value="${esc(hook.id)}"><strong>${esc(hook.label)} · ${esc(hook.strategy)}</strong><span>${esc(hook.text)}</span><small><b>Promise:</b> ${esc(hook.promise)}<br><b>Open loop:</b> ${esc(hook.openLoop)}</small><small class="evidence-line">${esc(hook.evidenceIds.join(' · '))}</small><span class="option-risk">${riskFlags(hook)}</span></label>`).join('')}
      <label class="option-card hook-card custom-hook" data-angle="custom" hidden><input type="radio" name="hook" value="custom"><strong>Hook của bạn</strong><span>Tôi muốn tự viết câu mở.</span><textarea id="custom-hook" rows="4" placeholder="Nhập hook riêng; Agent sẽ giữ lời hứa này xuyên suốt bài."></textarea></label>
    </div></section>
    <section class="author-step"><h3>3 · Bổ sung insight của bạn</h3><p>Đây là các evidence gap Agent không thể tự suy ra từ dữ liệu.</p><div class="question-list">${init.interviewQuestions.map((item) => `<label class="field">${esc(item.question)}<span class="question-why">${esc(item.why)} · ${esc(item.gapType)}</span><textarea name="question-${esc(item.id)}" rows="3" placeholder="Có thể bỏ trống nếu dữ liệu hiện tại đã đủ."></textarea></label>`).join('')}</div></section>
    <div class="author-actions"><span id="human-error" class="error"></span><button class="primary-button" type="submit">Khóa brief & cho Agent 1 viết</button></div>
    <details class="initial-preview"><summary>Xem exploratory draft Agent đã tạo</summary><div style="margin: 8px 0;"><button class="outline-button compact-button" data-export-draft="init" type="button">✦ Xuất TXT</button></div>${markdown(init.draftMarkdown, true)}</details>
  </form>`;
}

function bindAuthorRoom() {
  const form = $('#human-form');
  if (!form) return;
  $$('input[name="angle"]').forEach((input) => input.addEventListener('change', () => {
    $$('[data-angle]').forEach((card) => { card.hidden = card.dataset.angle !== input.value && card.dataset.angle !== 'custom'; });
    $$('input[name="hook"]').forEach((hook) => { hook.checked = false; });
    $('#hook-step').classList.remove('muted-step');
    $('#hook-help').textContent = 'Chọn một trong đúng hai hook của angle này, hoặc nhập hook riêng.';
  }));
  $('#custom-hook')?.addEventListener('focus', () => {
    const input = $('input[name="hook"][value="custom"]');
    if (input) input.checked = true;
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const angle = $('input[name="angle"]:checked')?.value;
    const hook = $('input[name="hook"]:checked')?.value;
    const errorEl = $('#human-error');
    if (!angle || !hook) { errorEl.textContent = 'Hãy chọn một angle và một hook.'; return; }
    const customHook = $('#custom-hook')?.value.trim() || '';
    if (hook === 'custom' && !customHook) { errorEl.textContent = 'Hãy nhập hook riêng.'; return; }
    const answers = Object.fromEntries((state.details.initial.interviewQuestions || []).map((item) => [item.id, form.elements[`question-${item.id}`]?.value || '']));
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      await call('runs.human', { id: state.activeId, brief: { selectedAngleId: angle, selectedHookId: hook, customHook, answers } });
      toast('Đã khóa human brief. Agent 1 đang viết bản đầu tiên.');
      await loadRuns();
    } catch (error) { errorEl.textContent = error.message; button.disabled = false; }
  });
}

function renderRoom() {
  if (!state.details) return;
  const run = state.details.state;
  $('#document-title').textContent = run.config.title;
  $('#document-kicker').textContent = stageLabel(run.stage);
  renderVersionRibbon();
  const content = $('#document-content');
  if (run.stage === 'awaiting_human' && state.details.initial && !state.details.humanBrief) {
    content.className = 'document-content wide';
    content.innerHTML = renderAuthorRoom(state.details.initial);
    bindAuthorRoom();
    return;
  }
  const selected = state.versions.find((row) => row.id === state.selectedVersionId);
  if (!selected) {
    content.className = 'document-content empty-state';
    content.innerHTML = `<div class="empty-icon">◌</div><h2>${esc(stageLabel(run.stage))}</h2><p>Artifact đầu tiên sẽ hiện ở đây ngay khi Agent hoàn tất.</p>`;
    return;
  }
  if (state.compare) {
    const compare = state.versions.find((row) => row.id === state.compareVersionId);
    content.className = 'document-content wide';
    content.innerHTML = `<div class="compare-grid"><section class="compare-pane"><h2>${esc(selected.title)}</h2>${renderVersion(selected)}</section><section class="compare-pane"><h2>${esc(compare?.title || 'Chọn phiên bản')}</h2>${renderVersion(compare)}</section></div>`;
  } else {
    content.className = 'document-content';
    content.innerHTML = renderVersion(selected);
  }
}

function evidenceInspector(init, selectedRow) {
  if (!init) return '';
  let ids = [];
  if (selectedRow?.kind === 'human' && state.details.humanBrief) {
    const hook = init.hookOptions.find((item) => item.id === state.details.humanBrief.selectedHookId);
    const angle = init.outlineOptions.find((item) => item.id === state.details.humanBrief.selectedAngleId);
    ids = [...new Set([...(angle?.evidenceIds || []), ...(hook?.evidenceIds || [])])];
  }
  const evidence = ids.length ? init.evidenceLedger.filter((item) => ids.includes(item.id)) : init.evidenceLedger.slice(0, 8);
  return `<div class="inspector-block"><h3>${ids.length ? 'Evidence cho lựa chọn' : 'Evidence ledger'}</h3>${evidence.map((item) => `<div class="evidence-item"><code>${esc(item.id)} · ${esc(item.kind)} · ${esc(item.confidence)}</code><p>${esc(item.text)}</p><small>${esc(item.sourceRef)}</small></div>`).join('')}</div>`;
}

function renderInspector() {
  const root = $('#inspector-content');
  const details = state.details;
  if (!details) { root.innerHTML = '<p class="muted">Chọn một run để xem tiến độ.</p>'; return; }
  const run = details.state;
  const score = latestScore(run);
  const job = run.currentJob;
  const selected = state.versions.find((row) => row.id === state.selectedVersionId);
  const active = ACTIVE_STAGES.has(run.stage);
  root.innerHTML = `<div class="inspector-block">
    <div class="status-line"><span>Stage</span><strong>${esc(stageLabel(run.stage))}</strong></div>
    <div class="status-line"><span>Round</span><strong>${run.round} / ${run.config.maxRounds}</strong></div>
    <div class="status-line"><span>Score</span><strong>${score ?? '—'} / ${run.config.targetScore}</strong></div>
    <div class="status-line"><span>Human gate</span><strong>${run.config.humanGate === 'every_round' ? 'Mỗi vòng' : 'Sau init'}</strong></div>
  </div>
  ${job ? `<div class="inspector-block"><h3>Durable job</h3><div class="job-health"><strong>${esc(job.kind)} · attempt ${job.attempt}</strong><small>${esc(job.adapter)} · heartbeat ${dateLabel(job.lastHeartbeatAt || job.startedAt)}<br>${esc(job.status)}</small><div class="progress-track"></div></div></div>` : ''}
  ${run.error ? `<div class="inspector-block"><h3>Lỗi cần xử lý</h3><p class="error-block">${esc(run.error)}</p></div>` : ''}
  <div class="inspector-block"><h3>Hành động</h3><div class="inspector-actions">
    ${run.stage === 'failed' ? '<button class="primary-button" data-action="retry-current-agent" type="button">Dùng Agent hiện tại & Retry</button><button class="outline-button" data-action="retry-snapshot" type="button">Retry cùng cấu hình cũ</button>' : ''}
    ${run.stage === 'awaiting_round_human' ? '<label class="field">Note cho vòng sửa<textarea id="round-note" rows="4" placeholder="Điểm nào Agent phải giữ hoặc sửa?"></textarea></label><button class="primary-button" data-action="continue" type="button">Tiếp tục vòng sửa</button><button class="outline-button" data-action="accept" type="button">Chấp nhận bản hiện tại</button>' : ''}
    ${run.stage === 'needs_human' ? '<label class="field">Lý do override<textarea id="accept-reason" rows="3" placeholder="Vì sao bản này đủ tốt dù chưa đạt target?"></textarea></label><button class="primary-button" data-action="accept" type="button">Chấp nhận & kiểm SEO</button>' : ''}
    ${active ? '<button class="danger-button" data-action="cancel" type="button">Dừng run</button>' : ''}
    ${state.health?.transport === 'tmux' ? `<code class="attach-command">tmux attach -t ${esc(run.tmuxSession)}</code>` : ''}
  </div></div>
  ${selected?.kind === 'review' ? `<div class="inspector-block"><h3>Blockers</h3>${selected.value.blockingIssues.length ? `<ul class="bullet-list">${selected.value.blockingIssues.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : '<p class="muted">Không có blocking issue.</p>'}</div>` : ''}
  ${evidenceInspector(details.initial, selected)}`;
  $$('[data-action]').forEach((button) => button.addEventListener('click', () => runAction(button.dataset.action, button)));
}

async function runAction(action, button) {
  button.disabled = true;
  try {
    if (action === 'retry') await call('runs.retry', { id: state.activeId });
    if (action === 'retry-snapshot') await call('runs.retry-snapshot', { id: state.activeId });
    if (action === 'retry-current-agent') await call('runs.retry-current-agent', { id: state.activeId });
    if (action === 'continue') await call('runs.continue', { id: state.activeId, note: $('#round-note')?.value || '' });
    if (action === 'accept') await call('runs.accept', { id: state.activeId, reason: $('#accept-reason')?.value || 'Human editorial override' });
    if (action === 'cancel') {
      if (!window.confirm('Dừng run đang chạy? Artifacts đã hoàn tất vẫn được giữ.')) return;
      await call('runs.cancel', { id: state.activeId });
    }
    await loadRuns();
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
}

async function loadArticles() {
  const query = state.activeTab === 'library' ? $('#rail-search').value.trim() : '';
  state.articles = await call('articles.list', { query, includeArchived: state.includeArchived });
  if (state.activeArticleId && !state.articles.some((item) => item.id === state.activeArticleId)) state.activeArticleId = null;
  renderRail();
  if (state.activeArticleId) await selectArticle(state.activeArticleId, false);
}

async function selectArticle(id, updateRail = true) {
  state.activeArticleId = id;
  state.articleDetails = await call('articles.get', { id });
  if (updateRail) renderRail();
  renderLibrary();
}

function renderLibrary() {
  const root = $('#library-content');
  const value = state.articleDetails;
  if (!value) {
    $('#library-title').textContent = 'Bài đã hoàn tất';
    $('#open-source-run').classList.add('hidden');
    root.className = 'document-content empty-state';
    root.innerHTML = '<div class="empty-icon">□</div><h2>Chưa chọn bài</h2><p>Library chỉ lưu bản final đã chấp nhận; draft và review vẫn ở source run.</p>';
    return;
  }
  const { article, versions } = value;
  const current = versions[0];
  $('#library-title').textContent = article.title;
  $('#open-source-run').classList.remove('hidden');
  root.className = 'document-content';
  root.innerHTML = `<div class="article-paper"><div class="article-meta"><span class="pill">Final r${article.acceptedRound}</span><span class="pill">Score ${article.finalScore ?? '—'}</span><span class="pill orange">SEO ${esc(article.seoVerdict || '—')}</span><span class="pill ${article.status === 'archived' ? 'red' : ''}">${esc(article.status)}</span></div>${markdown(current?.markdown || '')}<section class="section-card"><h3>Version history</h3>${versions.map((version) => `<p><strong>Version ${version.versionNo}</strong> · round ${version.acceptedRound} · ${dateLabel(version.createdAt)}<br><small>SHA ${esc(version.markdownSha256.slice(0, 16))} · ${esc(version.draftArtifactRelpath)}</small></p>`).join('')}<div class="toolbar-actions"><button class="outline-button" id="export-article" type="button">Export Markdown</button><button class="outline-button" id="archive-article" type="button">${article.status === 'archived' ? 'Khôi phục' : 'Lưu trữ'}</button></div></section></div>`;
  $('#export-article').addEventListener('click', async () => {
    const receipt = await call('articles.export', { id: article.id });
    toast(`Đã export: ${receipt.path}`);
  });
  $('#archive-article').addEventListener('click', async () => {
    await call('articles.archive', { id: article.id, archived: article.status !== 'archived' });
    toast(article.status === 'archived' ? 'Đã khôi phục bài.' : 'Đã lưu trữ bài.');
    state.articleDetails = null;
    state.activeArticleId = null;
    await loadArticles();
    renderLibrary();
  });
}

const AGENT_META = [
  { slot: 'agent-1', role: 'Writer · evidence, init, revision' },
  { slot: 'agent-2', role: 'Editor · weighted score & blockers' },
  { slot: 'agent-3', role: 'SEO · final metadata review' },
];
const ADAPTERS = {
  claude: { label: 'Claude Code', executable: 'claude' },
  codex: { label: 'Codex CLI', executable: 'codex' },
  gemini: { label: 'Gemini CLI', executable: 'gemini' },
  agy: { label: 'Antigravity CLI', executable: 'agy' },
  mock: { label: 'Mock (test)', executable: 'mock' },
};

function parseArgs(value) {
  const result = [];
  const rx = /"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s]+)/g;
  for (const match of value.matchAll(rx)) result.push((match[1] || match[2] || match[3] || '').replace(/\\(["\\])/g, '$1'));
  return result.filter(Boolean);
}
const formatArgs = (args) => (args || []).map((arg) => /\s|["']/.test(arg) ? JSON.stringify(arg) : arg).join(' ');
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

function commandPreview(profile) {
  const model = profile.model ? ` --model ${quote(profile.model)}` : '';
  const args = profile.args?.length ? ` ${profile.args.map(quote).join(' ')}` : '';
  if (profile.adapter === 'codex') return `${profile.executable} exec --sandbox read-only${model}${args} -`;
  if (profile.adapter === 'gemini') return `${profile.executable} --approval-mode plan${model}${args} -p <stdin>`;
  if (profile.adapter === 'agy') return `${profile.executable}${model}${args} --print <prompt>`;
  if (profile.adapter === 'mock') return 'mock adapter · tests only';
  return `${profile.executable} -p --permission-mode dontAsk --tools "" --no-session-persistence --safe-mode${model}${args}`;
}

async function loadModels() {
  state.models = await call('models.list');
}

async function loadAgents() {
  state.agents = await call('agents.list');
  renderAgents();
  renderRail();
}

function renderAgents() {
  const root = $('#agents-grid');
  root.innerHTML = state.agents.map((profile, index) => {
    const options = state.models[profile.adapter] || [];
    const knownModel = options.some((option) => option.id === profile.model);
    const customModel = state.customModelSlots.has(profile.slot) || Boolean(profile.model && !knownModel);
    const selectedModel = customModel ? '__custom__' : profile.model;
    return `<article class="agent-card"><div class="agent-head"><div><span class="kicker">SLOT ${index + 1}</span><h2>Agent ${index + 1}</h2><small>${esc(AGENT_META[index].role)}</small></div><span class="pill">${profile.enabled ? 'ON' : 'OFF'}</span></div><div class="agent-fields">
      <label class="field">Provider<select data-agent="adapter" data-slot="${profile.slot}">${Object.entries(ADAPTERS).map(([key, item]) => `<option value="${key}" ${key === profile.adapter ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}</select></label>
      <label class="field">Model<select data-agent="modelChoice" data-slot="${profile.slot}">
        <option value="" ${selectedModel === '' ? 'selected' : ''}>Provider default</option>
        ${options.map((option) => `<option value="${esc(option.id)}" ${selectedModel === option.id ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}
        <option value="__custom__" ${customModel ? 'selected' : ''}>Custom model…</option>
      </select></label>
      ${customModel ? `<label class="field model-custom">Custom model ID<input data-agent="model" data-slot="${profile.slot}" value="${esc(profile.model)}" placeholder="Nhập model ID chính xác"></label>` : ''}
      <label class="field">Executable<input data-agent="executable" data-slot="${profile.slot}" value="${esc(profile.executable)}" placeholder="claude / codex / gemini"></label>
      <label class="field">Extra args<input data-agent="args" data-slot="${profile.slot}" value="${esc(formatArgs(profile.args))}" placeholder="--reasoning-effort high"></label>
      <label class="field">System instruction<textarea data-agent="systemPrompt" data-slot="${profile.slot}" rows="5" placeholder="Quy tắc riêng cho slot này…">${esc(profile.systemPrompt)}</textarea></label>
      <label class="agent-toggle"><input data-agent="enabled" data-slot="${profile.slot}" type="checkbox" ${profile.enabled ? 'checked' : ''}> Bật agent trong loop</label>
    </div><code class="agent-preview">${esc(commandPreview(profile))}</code></article>`;
  }).join('');
  $$('[data-agent]').forEach((input) => input.addEventListener(input.matches('select, [type="checkbox"]') ? 'change' : 'input', () => updateAgent(input)));
}

function updateAgent(input) {
  const profile = state.agents.find((item) => item.slot === input.dataset.slot);
  if (!profile) return;
  const field = input.dataset.agent;
  if (field === 'adapter') {
    profile.adapter = input.value;
    profile.executable = ADAPTERS[input.value]?.executable || input.value;
    profile.model = '';
    state.customModelSlots.delete(profile.slot);
  } else if (field === 'modelChoice') {
    if (input.value === '__custom__') {
      state.customModelSlots.add(profile.slot);
      if ((state.models[profile.adapter] || []).some((option) => option.id === profile.model)) profile.model = '';
    } else {
      state.customModelSlots.delete(profile.slot);
      profile.model = input.value;
    }
  } else if (field === 'args') profile.args = parseArgs(input.value);
  else if (field === 'enabled') profile.enabled = input.checked;
  else profile[field] = input.value;
  if (field === 'adapter' || field === 'modelChoice') renderAgents();
  else input.closest('.agent-card').querySelector('.agent-preview').textContent = commandPreview(profile);
}

function defaultProfiles() {
  return AGENT_META.map((meta, index) => ({
    slot: meta.slot,
    name: `Agent ${index + 1}`,
    role: index === 0 ? 'writer' : index === 1 ? 'editor' : 'seo',
    adapter: index === 0 ? 'claude' : index === 1 ? 'codex' : 'agy',
    executable: index === 0 ? 'claude' : index === 1 ? 'codex' : 'agy',
    model: index === 2 ? 'Gemini 3.5 Flash (High)' : '',
    args: [],
    systemPrompt: '',
    enabled: true,
  }));
}

async function saveAgents(profiles = state.agents) {
  try {
    state.agents = await call('agents.save', { agents: profiles });
    renderAgents();
    renderRail();
    await loadHealth();
    $('#agents-notice').className = 'notice';
    $('#agents-notice').textContent = 'Đã lưu. Run đang chạy giữ snapshot cũ; cấu hình mới áp dụng từ run kế tiếp.';
  } catch (error) {
    $('#agents-notice').className = 'notice error';
    $('#agents-notice').textContent = error.message;
  }
}

async function loadLogs() {
  if (!state.activeId) { $('#console-output').textContent = 'Chưa chọn run.'; return; }
  state.logs = await call('runs.logs', { id: state.activeId });
  const patterns = { writer: /writer/i, editor: /editor/i, seo: /seo/i };
  const rows = state.logs.filter((item) => state.consoleRole === 'process'
    ? item.name === 'process.log'
    : patterns[state.consoleRole].test(item.name));
  $('#console-output').textContent = rows.length ? rows.map((item) => `── ${item.name} ──\n${item.content}`).join('\n\n') : `Chưa có log của ${state.consoleRole}.`;
  const output = $('#console-output');
  output.scrollTop = output.scrollHeight;
}

function selectTab(tab) {
  state.activeTab = tab;
  $$('.top-tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
  ['room', 'library', 'agents'].forEach((name) => $(`#${name}-view`).classList.toggle('hidden', name !== tab));
  $('#rail-search').value = '';
  renderRail();
  if (tab === 'library') { void loadArticles(); renderLibrary(); }
  if (tab === 'agents') void loadModels().then(loadAgents).catch((error) => toast(error.message, true));
}

function openNewDialog() {
  $('#create-error').textContent = '';
  $('#new-run-dialog').showModal();
}

function bindEvents() {
  $$('.top-tab').forEach((button) => button.addEventListener('click', () => selectTab(button.dataset.tab)));
  $$('[data-open-new]').forEach((button) => button.addEventListener('click', openNewDialog));
  $('#new-run').addEventListener('click', openNewDialog);
  $('#close-new').addEventListener('click', () => $('#new-run-dialog').close());
  $('#cancel-new').addEventListener('click', () => $('#new-run-dialog').close());
  $('#refresh').addEventListener('click', () => state.activeTab === 'library' ? loadArticles() : loadRuns());
  $('#rail-search').addEventListener('input', () => {
    clearTimeout($('#rail-search')._timer);
    $('#rail-search')._timer = setTimeout(() => state.activeTab === 'library' ? loadArticles() : renderRail(), 180);
  });
  $('#compare-toggle').addEventListener('click', () => { state.compare = !state.compare; renderRoom(); });
  $('#compare-version').addEventListener('change', (event) => { state.compareVersionId = event.target.value; renderRoom(); });
  $('#toggle-inspector').addEventListener('click', () => $('.workspace-shell').classList.add('inspector-open'));
  $('#close-inspector').addEventListener('click', () => $('.workspace-shell').classList.remove('inspector-open'));
  $('#toggle-console').addEventListener('click', async () => {
    state.consoleOpen = !state.consoleOpen;
    $('#console-drawer').classList.toggle('open', state.consoleOpen);
    $('#toggle-console').innerHTML = `${state.consoleOpen ? 'Đóng' : 'Mở'} console <span>${state.consoleOpen ? '⌄' : '⌃'}</span>`;
    if (state.consoleOpen) await loadLogs();
  });
  $$('.console-tab').forEach((button) => button.addEventListener('click', async () => {
    state.consoleRole = button.dataset.console;
    $$('.console-tab').forEach((item) => item.classList.toggle('active', item === button));
    await loadLogs();
  }));
  $('#save-agents').addEventListener('click', () => saveAgents());
  $('#reset-agents').addEventListener('click', () => saveAgents(defaultProfiles()));
  $('#open-source-run').addEventListener('click', async () => {
    const runId = state.articleDetails?.article?.runId;
    if (!runId) return;
    state.activeId = runId;
    state.selectedVersionId = null;
    selectTab('room');
    await loadRuns();
  });
  $('#backup-library').addEventListener('click', async () => {
    try {
      const receipt = await call('articles.backup');
      toast(`Đã tạo SQLite snapshot: ${receipt.path}`);
    } catch (error) { toast(error.message, true); }
  });
  document.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-export-draft]');
    if (!btn) return;
    const round = btn.dataset.exportDraft;
    if (!state.activeId) return;
    btn.disabled = true;
    const origText = btn.textContent;
    btn.textContent = 'Đang xuất…';
    try {
      const res = await call('runs.export-draft', { id: state.activeId, round });
      toast(`Đã xuất draft (${round}) ra ${res.filename}`);
    } catch (err) {
      toast(err.message || String(err), true);
    } finally {
      btn.disabled = false;
      btn.textContent = origText;
    }
  });
  $('#create-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[type="submit"]');
    const data = new FormData(form);
    submit.disabled = true;
    $('#create-error').textContent = '';
    try {
      const created = await call('runs.create', {
        title: data.get('title'), sourcePack: data.get('sourcePack'),
        targetScore: Number(data.get('targetScore')), maxRounds: Number(data.get('maxRounds')),
        humanGate: data.get('humanGate'), timeoutMinutes: Number(data.get('timeoutMinutes')),
        guidePath: data.get('guidePath'), criteriaPath: data.get('criteriaPath'),
      });
      state.activeId = created.id;
      state.selectedVersionId = null;
      form.reset();
      $('#new-run-dialog').close();
      toast('Đã tạo run. Agent 1 đang chuẩn bị init.');
      selectTab('room');
      await loadRuns();
    } catch (error) { $('#create-error').textContent = error.message; }
    finally { submit.disabled = false; }
  });
}

async function boot() {
  bindEvents();
  await Promise.all([loadHealth(), loadModels(), loadRuns({ selectNewest: true })]);
  await loadAgents();
  renderRail();
  const listen = window.__TAURI__?.event?.listen;
  if (nativeInvoke && listen) {
    let refreshTimer;
    await listen('writer-room://engine-event', ({ payload }) => {
      const message = payload || {};
      if (message.event !== 'run.state') return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        if (state.activeTab === 'room') void loadRuns({ details: true });
        if (state.consoleOpen && state.consoleRole === 'process') void loadLogs();
        if (state.activeTab === 'library' && message.payload?.state?.stage === 'complete') void loadArticles();
      }, 60);
    });
    await listen('writer-room://terminal-output', ({ payload }) => {
      if (!state.consoleOpen || payload?.role !== state.consoleRole) return;
      const output = $('#console-output');
      output.textContent = `${output.textContent === `Chưa có log của ${state.consoleRole}.` ? '' : output.textContent}${payload.chunk || ''}`.slice(-200_000);
      output.scrollTop = output.scrollHeight;
    });
  } else {
    state.poller = setInterval(async () => {
      if (document.hidden) return;
      try {
        if (state.activeTab === 'room') await loadRuns({ details: true });
        else if (state.activeTab === 'library') await loadArticles();
      } catch { /* the next poll can recover */ }
    }, 1800);
  }
}

void boot().catch((error) => toast(error.message, true));
