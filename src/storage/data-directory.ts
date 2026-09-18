import path from 'node:path';
import fs from 'node:fs/promises';

type DataRootGlobal = typeof globalThis & { DATA_ROOT?: unknown };

export type StoragePaths = {
  root: string;
  databasePath: string;
  backupDirectory: string;
};

export function resolveStoragePaths(): StoragePaths {
  const dataRoot = (globalThis as DataRootGlobal).DATA_ROOT;
  if (typeof dataRoot !== 'string' || !dataRoot.trim()) {
    throw new Error('SillyTavern DATA_ROOT is unavailable; persistent storage cannot start');
  }

  const root = path.join(dataRoot, 'weavememory');
  return {
    root,
    databasePath: path.join(root, 'weavememory.sqlite'),
    backupDirectory: path.join(root, 'backups')
  };
}

export async function ensureStorageDirectories(paths: StoragePaths): Promise<void> {
  await fs.mkdir(paths.root, { recursive: true });
  await fs.mkdir(paths.backupDirectory, { recursive: true });
}
