/** Spy daemon — HTTP API for Tauri shell. */

export {
  APP_ROOT,
  configDir,
  dataRoot,
  ensureDir,
  pathExists,
  spyConfigPath,
  spyDbPath,
  spyRoot,
  writerExportsRoot,
} from './paths.ts';
export {
  createWriterPack,
  deleteWriterPack,
  getWriterPack,
  listWriterPacks,
  mergeIntoWriterPack,
  renameWriterPack,
} from './writer-packs.ts';
export { acquireLock, readLock, releaseLock } from './lock.ts';
export { SPY_FEATURE, assertSpyEnabled } from './features.ts';
export { startHttpServer, createHttpApp, createHandler } from './http.ts';

import { startHttpServer } from './http.ts';

if (import.meta.main) {
  await startHttpServer();
}
