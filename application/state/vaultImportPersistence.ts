import type { ManagedSource } from "../../domain/models";
import {
  STORAGE_KEY_GROUPS,
  STORAGE_KEY_MANAGED_SOURCES,
} from "../../infrastructure/config/storageKeys";

type VaultImportMetadataStorage = {
  readString(key: string): string | null;
  write<T>(key: string, value: T): boolean;
  writeString(key: string, value: string): boolean;
  remove(key: string): void;
};

export const readStoredArray = <T>(key: string, value: string | null): T[] => {
  if (value === null) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed as T[];
  } catch {
    // Report the same safe error for malformed JSON and non-array values.
  }
  throw new Error(`Saved Vault data is unreadable for ${key}`);
};

export function persistVaultImportMetadata(
  storage: VaultImportMetadataStorage,
  updateGroups: (current: string[]) => string[],
  updateSources: (current: ManagedSource[]) => ManagedSource[],
): { persisted: boolean; groups: string[]; sources: ManagedSource[] } {
  const previousGroups = storage.readString(STORAGE_KEY_GROUPS);
  const previousSources = storage.readString(STORAGE_KEY_MANAGED_SOURCES);
  const groups = updateGroups(readStoredArray<string>(STORAGE_KEY_GROUPS, previousGroups));
  const sources = updateSources(readStoredArray<ManagedSource>(
    STORAGE_KEY_MANAGED_SOURCES,
    previousSources,
  ));
  if (!storage.write(STORAGE_KEY_GROUPS, groups)) {
    return { persisted: false, groups, sources };
  }
  if (!storage.write(STORAGE_KEY_MANAGED_SOURCES, sources)) {
    if (previousGroups === null) storage.remove(STORAGE_KEY_GROUPS);
    else if (!storage.writeString(STORAGE_KEY_GROUPS, previousGroups)) {
      throw new Error("Vault import metadata rollback failed");
    }
    if (storage.readString(STORAGE_KEY_GROUPS) !== previousGroups) {
      throw new Error("Vault import metadata rollback failed");
    }
    return { persisted: false, groups, sources };
  }
  return { persisted: true, groups, sources };
}
