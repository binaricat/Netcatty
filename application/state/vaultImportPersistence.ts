import type { ManagedSource } from "../../domain/models";
import {
  STORAGE_KEY_GROUPS,
  STORAGE_KEY_MANAGED_SOURCES,
} from "../../infrastructure/config/storageKeys";
import { commitPluginImporterTransaction } from "./pluginImporterTransaction";

type VaultImportMetadataStorage = {
  read<T>(key: string): T | null;
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
  additionalWrites: ReadonlyArray<readonly [key: string, value: unknown]> = [],
): { persisted: boolean; groups: string[]; sources: ManagedSource[] } {
  const groups = updateGroups(readStoredArray<string>(
    STORAGE_KEY_GROUPS,
    storage.readString(STORAGE_KEY_GROUPS),
  ));
  const sources = updateSources(readStoredArray<ManagedSource>(
    STORAGE_KEY_MANAGED_SOURCES,
    storage.readString(STORAGE_KEY_MANAGED_SOURCES),
  ));
  commitPluginImporterTransaction(storage, [
    ...additionalWrites,
    [STORAGE_KEY_GROUPS, groups],
    [STORAGE_KEY_MANAGED_SOURCES, sources],
  ]);
  return { persisted: true, groups, sources };
}
