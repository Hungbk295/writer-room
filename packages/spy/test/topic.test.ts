/**
 * topic.test.ts — TopicConfig schema + importTopicFiles.
 *
 * Trọng tâm: cold start KHÔNG dùng provider ngoài (ADR-AL-6). `seedChannelIds`
 * là đường 1 trong §1.2 — kênh user tự biết, 0 quota, vào thẳng Inbox.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { SpyStore } from '../src/store.ts';
import { importTopicFiles, topicConfigSchema } from '../src/topic.ts';

const roots: string[] = [];
let store: SpyStore | null = null;

afterEach(async () => {
  store?.close();
  store = null;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** dataDir = <root>/data; topic files nằm ở <root>/config/topics. */
async function setup(topicFile: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'spy-topic-'));
  roots.push(root);
  const dataDir = join(root, 'data');
  await mkdir(dataDir, { recursive: true });
  const topicsDir = join(resolve(dataDir, '..'), 'config', 'topics');
  await mkdir(topicsDir, { recursive: true });
  await writeFile(
    join(topicsDir, `${String(topicFile['topicId'])}.json`),
    JSON.stringify(topicFile, null, 2),
    'utf8',
  );
  store = new SpyStore(join(dataDir, 'spy.sqlite'));
  return { dataDir, store: store! };
}

describe('topicConfigSchema', () => {
  test('mặc định: seedChannelIds [], anchorTerms [], preferLongform true', () => {
    const config = topicConfigSchema.parse({
      topicId: 'fin',
      label: 'Finance',
      market: 'vi',
      language: 'vi',
    });
    expect(config.seedChannelIds).toEqual([]);
    expect(config.anchorTerms).toEqual([]);
    expect(config.preferLongform).toBe(true);
  });

  test('nhận seedChannelIds + anchorTerms từ file', () => {
    const config = topicConfigSchema.parse({
      topicId: 'fin',
      label: 'Finance',
      market: 'vi',
      language: 'vi',
      seedChannelIds: ['UCseed1', 'UCseed2'],
      anchorTerms: ['tiền', 'tài chính'],
      preferLongform: false,
    });
    expect(config.seedChannelIds).toEqual(['UCseed1', 'UCseed2']);
    expect(config.anchorTerms).toEqual(['tiền', 'tài chính']);
    expect(config.preferLongform).toBe(false);
  });
});

describe('importTopicFiles', () => {
  test('upsert seedChannelIds vào candidate_channels(seed_config) + topic_channels(new)', async () => {
    const { dataDir, store: db } = await setup({
      topicId: 'finance-vi',
      label: 'Tài chính cá nhân VI',
      market: 'vi',
      language: 'vi',
      seedChannelIds: ['UCseed1', 'UCseed2'],
      seedKeywords: ['lãi kép'],
    });

    const configs = await importTopicFiles(dataDir, db);
    expect(configs).toHaveLength(1);

    const candidates = db.listCandidates({ discoveredVia: 'seed_config' });
    expect(candidates.map((c) => c.channelId).sort()).toEqual(['UCseed1', 'UCseed2']);
    expect(db.countTopicChannelsByStatus('finance-vi')['new']).toBe(2);
    expect(db.listTopicKeywords('finance-vi')).toHaveLength(1);
  });

  test('import lại không kéo kênh đã reject quay về new', async () => {
    const { dataDir, store: db } = await setup({
      topicId: 'finance-vi',
      label: 'Tài chính cá nhân VI',
      market: 'vi',
      language: 'vi',
      seedChannelIds: ['UCseed1'],
    });

    await importTopicFiles(dataDir, db);
    db.decideTopicChannels('finance-vi', ['UCseed1'], 'rejected', 'user');
    await importTopicFiles(dataDir, db);

    const counts = db.countTopicChannelsByStatus('finance-vi');
    expect(counts['rejected']).toBe(1);
    expect(counts['new']).toBeUndefined();
  });

  test('không có seedChannelIds thì không tạo candidate nào', async () => {
    const { dataDir, store: db } = await setup({
      topicId: 'finance-vi',
      label: 'Tài chính cá nhân VI',
      market: 'vi',
      language: 'vi',
    });
    await importTopicFiles(dataDir, db);
    expect(db.listCandidates({})).toHaveLength(0);
    expect(db.getTopic('finance-vi')).not.toBeNull();
  });
});

describe('provenance — seed từ file topic mang nhãn seed_config', () => {
  test('provenance seed_config được ghi vào ROW THẬT trong candidate_channels', async () => {
    const { dataDir, store: db } = await setup({
      topicId: 'finance-vi',
      label: 'Tài chính cá nhân VI',
      market: 'vi',
      language: 'vi',
      seedChannelIds: ['UCseedcfg0000000000001'],
    });
    await importTopicFiles(dataDir, db);

    // Đọc lại từ ĐĨA, không tin DTO trả về: gate assert trên hàng đã lưu.
    const raw = new Database(db.databasePath, { readonly: true });
    const row = raw.prepare(
      'SELECT discovered_via FROM candidate_channels WHERE channel_id=?',
    ).get('UCseedcfg0000000000001') as { discovered_via: string } | null;
    const source = raw.prepare(
      'SELECT relation FROM topic_channel_sources WHERE topic_id=? AND channel_id=?',
    ).get('finance-vi', 'UCseedcfg0000000000001') as { relation: string } | null;
    raw.close();

    expect(row?.discovered_via).toBe('seed_config');
    expect(source?.relation).toBe('seed_config');
    // Đường tự động TUYỆT ĐỐI không được tự khai là người nhập.
    expect(row?.discovered_via).not.toBe('manual_user');
    expect(row?.discovered_via).not.toBe('manual');
  });
});
