import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendEditorialSuggestions,
  approveEditorialSuggestion,
  createChannelProfile,
  dismissEditorialSuggestion,
  getEditorialNotebook,
  listChannelProfiles,
  listEditorialSuggestions,
  updateEditorialNotebook,
} from '../../src/writer/channel-profile.ts';
import {
  createReusableProcedure,
  getReusableProcedure,
  updateReusableProcedure,
} from '../../src/writer/reusable-procedure.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wr-channel-memory-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Hồ sơ kênh + Sổ tay biên tập', () => {
  test('fresh install accepts zero profiles; owner creates channels explicitly', async () => {
    expect(await listChannelProfiles(dir)).toEqual([]);
    await createChannelProfile({
      id: 'tai-chinh', displayName: 'Kênh Tài chính', topic: 'Tài chính cá nhân',
      youtubeIds: ['UC-own', 'UC-own'], audience: 'Người đi làm',
    }, dir);
    const channels = await listChannelProfiles(dir);
    expect(channels).toHaveLength(1);
    expect(channels[0]).toEqual(expect.objectContaining({
      id: 'tai-chinh', youtubeIds: ['UC-own'], topic: 'Tài chính cá nhân',
    }));
    expect((await getEditorialNotebook('tai-chinh', dir))?.markdown).toContain('Kinh nghiệm đã duyệt');
  });

  test('editorial save uses a content hash to reject stale overwrites', async () => {
    await createChannelProfile({ id: 'lich-su', displayName: 'Kênh Lịch sử', topic: 'Lịch sử' }, dir);
    const first = (await getEditorialNotebook('lich-su', dir))!;
    const saved = await updateEditorialNotebook('lich-su', `${first.markdown}\n- Không hiện đại hóa lời nhân vật.`, dir, first.hash);
    expect(saved.hash).not.toBe(first.hash);
    await expect(updateEditorialNotebook('lich-su', 'stale', dir, first.hash)).rejects.toThrow('sửa ở nơi khác');
  });

  test('agent suggestions stay in inbox until the owner approves one', async () => {
    await createChannelProfile({ id: 'tai-chinh', displayName: 'Kênh Tài chính', topic: 'Tài chính' }, dir);
    const suggestion = {
      kind: 'AVOID' as const,
      text: 'Không mở ba đoạn liên tiếp bằng cùng một cấu trúc câu.',
      reason: 'Editor đã bắt lỗi lặp nhịp ở phần cuối.',
      sourceRunId: 'run-123',
    };
    await appendEditorialSuggestions('tai-chinh', [suggestion], dir);
    expect((await listEditorialSuggestions('tai-chinh', dir))[0]).toEqual(suggestion);
    expect((await getEditorialNotebook('tai-chinh', dir))!.markdown).not.toContain(suggestion.text);

    const approved = await approveEditorialSuggestion('tai-chinh', suggestion, dir);
    expect(approved.markdown).toContain(suggestion.text);
    expect(await listEditorialSuggestions('tai-chinh', dir)).toEqual([]);
  });

  test('owner can dismiss a suggestion without changing the editorial notebook', async () => {
    await createChannelProfile({ id: 'lich-su', displayName: 'Kênh Lịch sử', topic: 'Lịch sử' }, dir);
    const suggestion = { kind: 'TRY' as const, text: 'Thử mở bài bằng một mốc thời gian.' };
    await appendEditorialSuggestions('lich-su', [suggestion], dir);
    const before = (await getEditorialNotebook('lich-su', dir))!;

    await dismissEditorialSuggestion('lich-su', suggestion, dir);

    expect(await listEditorialSuggestions('lich-su', dir)).toEqual([]);
    expect((await getEditorialNotebook('lich-su', dir))!.hash).toBe(before.hash);
  });
});

describe('Quy trình dùng lại', () => {
  test('writes and updates a native SKILL.md shape', async () => {
    const created = await createReusableProcedure({
      id: 'viet-video-tai-chinh',
      description: 'Dùng khi viết video tài chính cần kiểm tra số liệu và chốt hành động rõ ràng.',
      instructions: '# Quy trình\n\n1. Lập facts ledger.\n2. Kiểm tra lại mọi phép tính trước khi giao bài.',
    }, dir);
    expect(created.path).toBe('.agents/skills/viet-video-tai-chinh/SKILL.md');
    const raw = await Bun.file(join(dir, created.path)).text();
    expect(raw).toContain('name: viet-video-tai-chinh');
    expect(raw).toContain('description:');

    const updated = await updateReusableProcedure(created.id, {
      id: created.id,
      description: created.description,
      instructions: `${created.instructions}\n3. Đọc lại phần kết riêng một lần.`,
    }, dir);
    expect(updated.hash).not.toBe(created.hash);
    expect((await getReusableProcedure(created.id, dir))?.instructions).toContain('phần kết');
  });
});
