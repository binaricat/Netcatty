import { migrateLegacyCommandBlocklist } from '../../domain/commandBlocklist';
import { DEFAULT_COMMAND_BLOCKLIST } from '../../infrastructure/ai/types';
import { STORAGE_KEY_AI_COMMAND_BLOCKLIST } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';

export function persistCommandBlocklistSetting(blocklist: string[]): boolean {
  return localStorageAdapter.write(STORAGE_KEY_AI_COMMAND_BLOCKLIST, blocklist);
}

export function readCommandBlocklistSetting(): string[] {
  const stored = localStorageAdapter.read<string[]>(STORAGE_KEY_AI_COMMAND_BLOCKLIST);
  if (stored != null && !Array.isArray(stored)) {
    return [...DEFAULT_COMMAND_BLOCKLIST];
  }

  const current = stored ?? [...DEFAULT_COMMAND_BLOCKLIST];
  const migrated = stored == null ? current : migrateLegacyCommandBlocklist(current);
  if (
    stored == null
    || migrated.length !== current.length
    || migrated.some((pattern, index) => pattern !== current[index])
  ) {
    persistCommandBlocklistSetting(migrated);
  }
  return migrated;
}
