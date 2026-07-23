import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const triple = process.env.WRITER_ROOM_TARGET_TRIPLE
  || process.env.TAURI_ENV_TARGET_TRIPLE
  || (process.platform === 'darwin'
    ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
    : process.platform === 'win32'
      ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc`
      : `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-gnu`);

const targets: Record<string, string> = {
  'aarch64-apple-darwin': 'bun-darwin-arm64',
  'x86_64-apple-darwin': 'bun-darwin-x64',
  'aarch64-pc-windows-msvc': 'bun-windows-arm64',
  'x86_64-pc-windows-msvc': 'bun-windows-x64',
  'aarch64-unknown-linux-gnu': 'bun-linux-arm64',
  'x86_64-unknown-linux-gnu': 'bun-linux-x64',
};

const bunTarget = targets[triple];
if (!bunTarget) throw new Error(`Unsupported Writer Room target triple: ${triple}`);
const extension = triple.includes('windows') ? '.exe' : '';
const outputDir = join(root, 'binaries');
await mkdir(outputDir, { recursive: true });

for (const [name, entry] of [['writer-room-engine', 'src/bridge.ts'], ['writer-room-runner', 'src/pane-runner.ts']] as const) {
  const output = join(outputDir, `${name}-${triple}${extension}`);
  const child = Bun.spawn([process.execPath, 'build', join(root, entry), '--compile', `--target=${bunTarget}`, `--outfile=${output}`], {
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`Bun compile failed for ${name} (${code})`);
}

console.log(`Writer Room sidecars ready for ${triple}`);
