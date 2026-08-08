import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { AppError } from './errors.ts';
import type { ArtifactRef } from './schema.ts';

function safeExtension(name: string): string {
  const extension = extname(name).toLowerCase();
  return /^[.][a-z0-9]{1,8}$/.test(extension) ? extension : '';
}

export class ArtifactStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(join(this.root, '.tmp'), { recursive: true });
  }

  private destination(hash: string, extension: string): { absolutePath: string; relativePath: string } {
    const relativePath = join(hash.slice(0, 2), `${hash}${extension}`);
    return { absolutePath: join(this.root, relativePath), relativePath };
  }

  async putBuffer(buffer: Uint8Array, options: { mimeType: string; name?: string }): Promise<ArtifactRef> {
    const hash = createHash('sha256').update(buffer).digest('hex');
    const extension = safeExtension(options.name ?? '');
    const destination = this.destination(hash, extension);
    await mkdir(dirname(destination.absolutePath), { recursive: true });
    try {
      await stat(destination.absolutePath);
    } catch {
      const tempPath = join(this.root, '.tmp', randomUUID());
      await writeFile(tempPath, buffer, { flag: 'wx' });
      try {
        await rename(tempPath, destination.absolutePath);
      } catch (error) {
        await unlink(tempPath).catch(() => undefined);
        try {
          await stat(destination.absolutePath);
        } catch {
          throw error;
        }
      }
    }
    return {
      hash,
      relativePath: destination.relativePath,
      byteLength: buffer.byteLength,
      mimeType: options.mimeType,
    };
  }

  async putFile(path: string, options: { mimeType: string; name?: string }): Promise<ArtifactRef> {
    const hash = createHash('sha256');
    await pipeline(createReadStream(path), hash);
    const digest = hash.digest('hex');
    const extension = safeExtension(options.name ?? path);
    const destination = this.destination(digest, extension);
    await mkdir(dirname(destination.absolutePath), { recursive: true });
    try {
      await stat(destination.absolutePath);
    } catch {
      const tempPath = join(this.root, '.tmp', randomUUID());
      await pipeline(createReadStream(path), createWriteStream(tempPath, { flags: 'wx' }));
      try {
        await rename(tempPath, destination.absolutePath);
      } catch (error) {
        await unlink(tempPath).catch(() => undefined);
        try {
          await stat(destination.absolutePath);
        } catch {
          throw error;
        }
      }
    }
    const metadata = await stat(destination.absolutePath);
    return {
      hash: digest,
      relativePath: destination.relativePath,
      byteLength: metadata.size,
      mimeType: options.mimeType,
    };
  }

  async resolve(ref: ArtifactRef, maximumBytes = 8 * 1024 * 1024): Promise<string> {
    let root: string;
    let path: string;
    try {
      root = await realpath(this.root);
      path = await realpath(join(this.root, ref.relativePath));
    } catch (error) {
      throw new AppError('asset_unavailable', 'Artifact không còn trên disk', { cause: error });
    }
    const pathFromRoot = relative(root, path);
    if (
      pathFromRoot === '..' ||
      pathFromRoot.startsWith(`..${sep}`) ||
      pathFromRoot.startsWith('/') ||
      pathFromRoot.startsWith('\\')
    ) {
      throw new AppError('asset_unavailable', 'Artifact nằm ngoài artifact root');
    }
    const metadata = await stat(path);
    if (metadata.size !== ref.byteLength) {
      throw new AppError('asset_unavailable', 'Artifact size không khớp manifest');
    }
    if (metadata.size > maximumBytes) {
      throw new AppError('quota_exceeded', `Artifact vượt giới hạn ${maximumBytes} bytes`);
    }
    const digest = createHash('sha256');
    await pipeline(createReadStream(path), digest);
    if (digest.digest('hex') !== ref.hash) {
      throw new AppError('asset_unavailable', 'Artifact hash không khớp manifest');
    }
    return path;
  }

  async read(ref: ArtifactRef, maximumBytes = 8 * 1024 * 1024): Promise<Buffer> {
    return readFile(await this.resolve(ref, maximumBytes));
  }
}
