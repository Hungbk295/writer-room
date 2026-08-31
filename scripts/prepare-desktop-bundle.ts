/**
 * Assemble immutable release resources for Tauri.
 *
 * This script intentionally excludes writer-room-data: the installed app must
 * start with an empty database and obtain credentials from its own user.
 * Run it on the target OS/CPU (or the matching CI runner), not by attempting
 * to cross-compile a macOS release on Windows or vice versa.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const resources = join(root, 'src-tauri', 'resources');
const bin = join(resources, 'bin');
const web = join(resources, 'web');
const isWindows = process.platform === 'win32';
const exe = isWindows ? '.exe' : '';
const vendorYtDlp = join(root, 'vendor', 'yt-dlp', `${process.platform}-${process.arch}`, `yt-dlp${exe}`);

function run(command: string[], label: string) {
  const result = Bun.spawnSync(command, { cwd: root, stdout: 'inherit', stderr: 'inherit' });
  if (result.exitCode !== 0) throw new Error(`${label} thất bại (exit ${result.exitCode})`);
}

if (!existsSync(join(root, 'packages', 'web', 'dist', 'index.html'))) {
  throw new Error('Chưa có packages/web/dist. Hãy chạy bun run ui:build trước.');
}
if (!existsSync(vendorYtDlp)) {
  throw new Error(`Thiếu yt-dlp runtime: ${vendorYtDlp}. Đặt binary đúng OS/CPU vào vendor/yt-dlp/<platform>-<arch>/.`);
}

rmSync(resources, { recursive: true, force: true });
mkdirSync(bin, { recursive: true });
run([
  'bun', 'build', '--compile', '--target=bun',
  '--outfile', join(bin, `writer-room-daemon${exe}`),
  'packages/daemon/src/index.ts',
], 'Biên dịch Writer Room daemon');
cpSync(vendorYtDlp, join(bin, `yt-dlp${exe}`));
if (!isWindows) run(['chmod', '+x', join(bin, 'yt-dlp')], 'Cấp quyền chạy yt-dlp');
cpSync(join(root, 'packages', 'web', 'dist'), web, { recursive: true });

console.log(`Desktop resources ready for ${process.platform}-${process.arch}: ${resources}`);
