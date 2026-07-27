import { STORAGE_KEY_PLUGIN_IMPORT_TRANSACTION } from '../../infrastructure/config/storageKeys';

type TransactionStorage = {
  read<T>(key: string): T | null;
  readString(key: string): string | null;
  write<T>(key: string, value: T): boolean;
  writeString(key: string, value: string): boolean;
  remove(key: string): void;
};

type PreviousEntry = { key: string; value: string | null };
type PreparedJournal = {
  version: 1;
  phase: 'prepared';
  previous: PreviousEntry[];
};
type CommittedJournal = { version: 1; phase: 'committed' };
type ImportJournal = PreparedJournal | CommittedJournal;

const restorePrevious = (storage: TransactionStorage, previous: PreviousEntry[]) => {
  for (const entry of previous) {
    if (entry.value === null) {
      storage.remove(entry.key);
      if (storage.readString(entry.key) !== null) {
        throw new Error(`Vault importer rollback failed for ${entry.key}`);
      }
    } else if (
      !storage.writeString(entry.key, entry.value)
      || storage.readString(entry.key) !== entry.value
    ) {
      throw new Error(`Vault importer rollback failed for ${entry.key}`);
    }
  }
};

const parseJournal = (value: unknown, allowedKeys: ReadonlySet<string>): ImportJournal | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const journal = value as Partial<ImportJournal>;
  if (journal.version !== 1 || (journal.phase !== 'prepared' && journal.phase !== 'committed')) return null;
  if (journal.phase === 'committed') return { version: 1, phase: 'committed' };
  const previous = (journal as Partial<PreparedJournal>).previous;
  if (!Array.isArray(previous) || previous.length === 0 || previous.length > allowedKeys.size) return null;
  const seen = new Set<string>();
  for (const entry of previous) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.key !== 'string' || !allowedKeys.has(entry.key) || seen.has(entry.key)
      || (entry.value !== null && typeof entry.value !== 'string')) return null;
    seen.add(entry.key);
  }
  return { version: 1, phase: 'prepared', previous: previous as PreviousEntry[] };
};

export function recoverPluginImporterTransaction(
  storage: TransactionStorage,
  allowedKeys: ReadonlySet<string>,
): 'none' | 'rolled-back' | 'committed' | 'discarded' {
  if (storage.readString(STORAGE_KEY_PLUGIN_IMPORT_TRANSACTION) === null) return 'none';
  const raw = storage.read<unknown>(STORAGE_KEY_PLUGIN_IMPORT_TRANSACTION);
  if (raw === null) {
    storage.remove(STORAGE_KEY_PLUGIN_IMPORT_TRANSACTION);
    return 'discarded';
  }
  const journal = parseJournal(raw, allowedKeys);
  if (!journal) {
    storage.remove(STORAGE_KEY_PLUGIN_IMPORT_TRANSACTION);
    return 'discarded';
  }
  if (journal.phase === 'prepared') restorePrevious(storage, journal.previous);
  storage.remove(STORAGE_KEY_PLUGIN_IMPORT_TRANSACTION);
  return journal.phase === 'prepared' ? 'rolled-back' : 'committed';
}

export function commitPluginImporterTransaction(
  storage: TransactionStorage,
  writes: ReadonlyArray<readonly [key: string, value: unknown]>,
): void {
  if (storage.readString(STORAGE_KEY_PLUGIN_IMPORT_TRANSACTION) !== null) {
    throw new Error('An unfinished Vault import recovery record already exists');
  }
  const keys = new Set(writes.map(([key]) => key));
  if (keys.size !== writes.length || keys.has(STORAGE_KEY_PLUGIN_IMPORT_TRANSACTION)) {
    throw new Error('Vault importer transaction keys are invalid');
  }
  const previous = writes.map(([key]) => ({ key, value: storage.readString(key) }));
  const prepared: PreparedJournal = { version: 1, phase: 'prepared', previous };
  if (!storage.write(STORAGE_KEY_PLUGIN_IMPORT_TRANSACTION, prepared)) {
    throw new Error('Vault storage rejected the importer transaction journal');
  }
  try {
    for (const [key, value] of writes) {
      const expected = JSON.stringify(value);
      if (expected === undefined
        || !storage.write(key, value)
        || storage.readString(key) !== expected) {
        throw new Error(`Vault storage rejected importer transaction key ${key}`);
      }
    }
    const committed: CommittedJournal = { version: 1, phase: 'committed' };
    if (!storage.write(STORAGE_KEY_PLUGIN_IMPORT_TRANSACTION, committed)) {
      throw new Error('Vault storage rejected the importer transaction commit marker');
    }
  } catch (error) {
    restorePrevious(storage, previous);
    storage.remove(STORAGE_KEY_PLUGIN_IMPORT_TRANSACTION);
    throw error;
  }
  storage.remove(STORAGE_KEY_PLUGIN_IMPORT_TRANSACTION);
}
