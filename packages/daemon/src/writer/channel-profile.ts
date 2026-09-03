import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, publishingChannelsRoot } from '../paths.ts';

const CHANNEL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_MARKDOWN_BYTES = 128 * 1024;

export interface ChannelProfile {
  id: string;
  displayName: string;
  topic: string;
  youtubeIds: string[];
  audience?: string;
  defaultGeneralPack?: string;
  defaultFormulaId?: string;
  defaultStyle?: string;
  defaultProcedure?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelProfileInput {
  id: string;
  displayName: string;
  topic: string;
  youtubeIds?: string[];
  audience?: string;
  defaultGeneralPack?: string;
  defaultFormulaId?: string;
  defaultStyle?: string;
  defaultProcedure?: string;
}

export interface EditorialNotebook {
  channelId: string;
  path: string;
  markdown: string;
  hash: string;
  wordCount: number;
}

export type LessonKind = 'KEEP' | 'AVOID' | 'TRY';

export interface EditorialSuggestion {
  kind: LessonKind;
  text: string;
  reason?: string;
  sourceRunId?: string;
}

function channelDir(channelId: string, dataDir: string): string {
  assertChannelId(channelId);
  return join(publishingChannelsRoot(dataDir), channelId);
}

function profilePath(channelId: string, dataDir: string): string {
  return join(channelDir(channelId, dataDir), 'channel.json');
}

function editorialPath(channelId: string, dataDir: string): string {
  return join(channelDir(channelId, dataDir), 'editorial.md');
}

function inboxPath(channelId: string, dataDir: string): string {
  return join(channelDir(channelId, dataDir), 'inbox.md');
}

function cleanOptional(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next ? next : undefined;
}

function cleanLine(value: string, label: string, max = 500): string {
  const next = value.replace(/\s+/g, ' ').trim();
  if (!next) throw new Error(`${label} bắt buộc`);
  if (next.length > max) throw new Error(`${label} quá dài (tối đa ${max} ký tự)`);
  return next;
}

function normalizeYoutubeIds(ids: string[] | undefined): string[] {
  return [...new Set((ids ?? []).map((id) => id.trim()).filter(Boolean))];
}

function normalizeInput(input: ChannelProfileInput): ChannelProfileInput {
  const id = input.id.trim().toLowerCase();
  assertChannelId(id);
  return {
    id,
    displayName: cleanLine(input.displayName, 'Tên kênh', 120),
    topic: cleanLine(input.topic, 'Chủ đề', 200),
    youtubeIds: normalizeYoutubeIds(input.youtubeIds),
    ...(cleanOptional(input.audience) ? { audience: cleanOptional(input.audience) } : {}),
    ...(cleanOptional(input.defaultGeneralPack) ? { defaultGeneralPack: cleanOptional(input.defaultGeneralPack) } : {}),
    ...(cleanOptional(input.defaultFormulaId) ? { defaultFormulaId: cleanOptional(input.defaultFormulaId) } : {}),
    ...(cleanOptional(input.defaultStyle) ? { defaultStyle: cleanOptional(input.defaultStyle) } : {}),
    ...(cleanOptional(input.defaultProcedure) ? { defaultProcedure: cleanOptional(input.defaultProcedure) } : {}),
  };
}

function isProfile(value: unknown): value is ChannelProfile {
  const p = value as Partial<ChannelProfile> | null;
  return Boolean(
    p && typeof p === 'object'
    && typeof p.id === 'string' && CHANNEL_ID.test(p.id)
    && typeof p.displayName === 'string' && p.displayName.trim()
    && typeof p.topic === 'string' && p.topic.trim()
    && Array.isArray(p.youtubeIds)
    && typeof p.createdAt === 'string'
    && typeof p.updatedAt === 'string',
  );
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}

export function assertChannelId(id: string): void {
  if (!CHANNEL_ID.test(id) || id.length > 80) {
    throw new Error('channelId chỉ gồm chữ thường, số và dấu gạch ngang (tối đa 80 ký tự)');
  }
}

export function hashEditorial(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

export async function getChannelProfile(channelId: string, dataDir: string): Promise<ChannelProfile | null> {
  try {
    const parsed = JSON.parse(await readFile(profilePath(channelId, dataDir), 'utf8')) as unknown;
    return isProfile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function listChannelProfiles(dataDir: string): Promise<ChannelProfile[]> {
  const root = publishingChannelsRoot(dataDir);
  await ensureDir(root);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const profiles = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && CHANNEL_ID.test(entry.name))
    .map((entry) => getChannelProfile(entry.name, dataDir)));
  return profiles
    .filter((profile): profile is ChannelProfile => Boolean(profile))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'vi'));
}

function editorialTemplate(displayName: string): string {
  return [
    `# Sổ tay biên tập — ${displayName}`,
    '',
    '> Chỉ ghi các quyết định bền vững mà mọi writer của kênh này phải tuân theo.',
    '',
    '## Ưu tiên',
    '',
    '- ',
    '',
    '## Điều cấm',
    '',
    '- ',
    '',
    '## Kinh nghiệm đã duyệt',
    '',
  ].join('\n');
}

function inboxTemplate(displayName: string): string {
  return [
    `# Kinh nghiệm chờ duyệt — ${displayName}`,
    '',
    '> Các tổng kết của agent nằm ở đây cho tới khi người viết duyệt vào sổ tay.',
    '',
  ].join('\n');
}

export async function createChannelProfile(input: ChannelProfileInput, dataDir: string): Promise<ChannelProfile> {
  const clean = normalizeInput(input);
  if (await getChannelProfile(clean.id, dataDir)) throw new Error(`Kênh "${clean.id}" đã tồn tại`);
  const dir = channelDir(clean.id, dataDir);
  await ensureDir(dir);
  const now = new Date().toISOString();
  const profile: ChannelProfile = { ...clean, youtubeIds: clean.youtubeIds ?? [], createdAt: now, updatedAt: now };
  await atomicWrite(profilePath(clean.id, dataDir), `${JSON.stringify(profile, null, 2)}\n`);
  await atomicWrite(editorialPath(clean.id, dataDir), editorialTemplate(profile.displayName));
  await atomicWrite(inboxPath(clean.id, dataDir), inboxTemplate(profile.displayName));
  return profile;
}

export async function updateChannelProfile(
  channelId: string,
  input: ChannelProfileInput,
  dataDir: string,
): Promise<ChannelProfile> {
  const current = await getChannelProfile(channelId, dataDir);
  if (!current) throw new Error('Hồ sơ kênh không tồn tại');
  const clean = normalizeInput({ ...input, id: channelId });
  const profile: ChannelProfile = {
    ...clean,
    youtubeIds: clean.youtubeIds ?? [],
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  };
  await atomicWrite(profilePath(channelId, dataDir), `${JSON.stringify(profile, null, 2)}\n`);
  return profile;
}

export async function getEditorialNotebook(channelId: string, dataDir: string): Promise<EditorialNotebook | null> {
  const profile = await getChannelProfile(channelId, dataDir);
  if (!profile) return null;
  const path = editorialPath(channelId, dataDir);
  let markdown: string;
  try {
    markdown = await readFile(path, 'utf8');
  } catch {
    markdown = editorialTemplate(profile.displayName);
    await atomicWrite(path, markdown);
  }
  return {
    channelId,
    path: `channels/${channelId}/editorial.md`,
    markdown,
    hash: hashEditorial(markdown),
    wordCount: markdown.trim() ? markdown.trim().split(/\s+/).length : 0,
  };
}

export async function updateEditorialNotebook(
  channelId: string,
  markdown: string,
  dataDir: string,
  expectedHash?: string,
): Promise<EditorialNotebook> {
  const current = await getEditorialNotebook(channelId, dataDir);
  if (!current) throw new Error('Hồ sơ kênh không tồn tại');
  if (expectedHash && expectedHash !== current.hash) {
    throw new Error('Sổ tay đã được sửa ở nơi khác; tải lại trước khi lưu');
  }
  if (!markdown.trim()) throw new Error('Sổ tay không được để trống');
  if (Buffer.byteLength(markdown, 'utf8') > MAX_MARKDOWN_BYTES) {
    throw new Error('Sổ tay quá lớn (tối đa 128 KB)');
  }
  const normalized = `${markdown.trimEnd()}\n`;
  await atomicWrite(editorialPath(channelId, dataDir), normalized);
  return (await getEditorialNotebook(channelId, dataDir))!;
}

function suggestionLine(suggestion: EditorialSuggestion): string {
  const kind = suggestion.kind;
  if (kind !== 'KEEP' && kind !== 'AVOID' && kind !== 'TRY') {
    throw new Error('Loại kinh nghiệm phải là KEEP, AVOID hoặc TRY');
  }
  const text = cleanLine(suggestion.text, 'Kinh nghiệm', 500).replace(/<!--|-->/g, '');
  const reason = cleanOptional(suggestion.reason)?.replace(/\s+/g, ' ').replace(/<!--|-->/g, '');
  const source = cleanOptional(suggestion.sourceRunId)?.replace(/[^a-zA-Z0-9-]/g, '');
  return `- [ ] [${kind}] ${text}${reason ? ` — ${reason}` : ''}${source ? ` <!-- run:${source} -->` : ''}`;
}

export async function appendEditorialSuggestions(
  channelId: string,
  suggestions: EditorialSuggestion[],
  dataDir: string,
): Promise<EditorialSuggestion[]> {
  if (!(await getChannelProfile(channelId, dataDir))) throw new Error('Hồ sơ kênh không tồn tại');
  if (suggestions.length === 0) return [];
  let current = '';
  try { current = await readFile(inboxPath(channelId, dataDir), 'utf8'); } catch { /* create below */ }
  const existing = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const accepted = suggestions.filter((suggestion) => !existing.has(suggestionLine(suggestion)));
  if (accepted.length === 0) return [];
  const prefix = current.trimEnd() || inboxTemplate((await getChannelProfile(channelId, dataDir))!.displayName).trimEnd();
  await atomicWrite(inboxPath(channelId, dataDir), `${prefix}\n\n${accepted.map(suggestionLine).join('\n')}\n`);
  return accepted;
}

export async function listEditorialSuggestions(channelId: string, dataDir: string): Promise<EditorialSuggestion[]> {
  if (!(await getChannelProfile(channelId, dataDir))) throw new Error('Hồ sơ kênh không tồn tại');
  let markdown = '';
  try { markdown = await readFile(inboxPath(channelId, dataDir), 'utf8'); } catch { return []; }
  const out: EditorialSuggestion[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^- \[ \] \[(KEEP|AVOID|TRY)\] (.*?)(?: <!-- run:([a-zA-Z0-9-]+) -->)?$/);
    if (!match) continue;
    const content = match[2]!;
    const splitAt = content.lastIndexOf(' — ');
    out.push({
      kind: match[1] as LessonKind,
      text: splitAt >= 0 ? content.slice(0, splitAt) : content,
      ...(splitAt >= 0 ? { reason: content.slice(splitAt + 3) } : {}),
      ...(match[3] ? { sourceRunId: match[3] } : {}),
    });
  }
  return out;
}

export async function approveEditorialSuggestion(
  channelId: string,
  suggestion: EditorialSuggestion,
  dataDir: string,
): Promise<EditorialNotebook> {
  const target = suggestionLine(suggestion);
  const path = inboxPath(channelId, dataDir);
  const inbox = await readFile(path, 'utf8').catch(() => '');
  const lines = inbox.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trim() === target);
  if (index < 0) throw new Error('Kinh nghiệm chờ duyệt không còn tồn tại');
  lines.splice(index, 1);

  const notebook = await getEditorialNotebook(channelId, dataDir);
  if (!notebook) throw new Error('Hồ sơ kênh không tồn tại');
  const source = suggestion.sourceRunId ? ` _(run \`${suggestion.sourceRunId}\`)_` : '';
  const approved = `- [${suggestion.kind}] ${cleanLine(suggestion.text, 'Kinh nghiệm', 500)}${source}`;
  const nextEditorial = `${notebook.markdown.trimEnd()}\n${approved}\n`;
  await atomicWrite(editorialPath(channelId, dataDir), nextEditorial);
  await atomicWrite(path, `${lines.join('\n').trimEnd()}\n`);
  return (await getEditorialNotebook(channelId, dataDir))!;
}

export async function dismissEditorialSuggestion(
  channelId: string,
  suggestion: EditorialSuggestion,
  dataDir: string,
): Promise<void> {
  if (!(await getChannelProfile(channelId, dataDir))) throw new Error('Hồ sơ kênh không tồn tại');
  const path = inboxPath(channelId, dataDir);
  const inbox = await readFile(path, 'utf8').catch(() => '');
  const lines = inbox.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trim() === suggestionLine(suggestion));
  if (index < 0) throw new Error('Kinh nghiệm chờ duyệt không còn tồn tại');
  lines.splice(index, 1);
  await atomicWrite(path, `${lines.join('\n').trimEnd()}\n`);
}

export async function channelProfileExists(channelId: string, dataDir: string): Promise<boolean> {
  try {
    const info = await stat(profilePath(channelId, dataDir));
    return info.isFile() && Boolean(await getChannelProfile(channelId, dataDir));
  } catch {
    return false;
  }
}
