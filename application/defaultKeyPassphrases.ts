import type { SSHKey } from "../domain/models";
import { isEncryptedCredentialPlaceholder } from "../domain/credentials";
import { STORAGE_KEY_DEFAULT_KEY_PASSPHRASES } from "../infrastructure/config/storageKeys";
import { localStorageAdapter } from "../infrastructure/persistence/localStorageAdapter";
import { encryptField, decryptField } from "../infrastructure/persistence/secureFieldAdapter";
import { netcattyBridge } from "../infrastructure/services/netcattyBridge";

function defaultKeyPassphrasePathKey(keyPath: string): string {
  const isWindowsPath = /^[A-Za-z]:[\\/]/u.test(keyPath) || /^[\\/]{2}/u.test(keyPath);
  if (!isWindowsPath) return keyPath;
  const normalized = keyPath.replace(/\\/g, "/");
  return normalized.toLowerCase();
}

function matchingPathKeys(keyPaths: string[]): Set<string> {
  return new Set(keyPaths.map(defaultKeyPassphrasePathKey));
}

export async function resolveDefaultKeyPassphraseAliases(keyPath: string): Promise<string[]> {
  const aliases = new Set([keyPath]);
  const isWindowsPath = /^[A-Za-z]:[\\/]/u.test(keyPath) || /^\\\\/u.test(keyPath);
  const normalizedKeyPath = isWindowsPath ? keyPath.replace(/\\/g, "/") : keyPath;
  aliases.add(normalizedKeyPath);
  try {
    const homeDir = await netcattyBridge.get()?.getHomeDir?.();
    if (!homeDir) return [...aliases];

    const normalizedHome = homeDir.replace(/\\/g, "/").replace(/\/$/u, "");
    const comparableHome = defaultKeyPassphrasePathKey(normalizedHome);
    const comparableKeyPath = defaultKeyPassphrasePathKey(normalizedKeyPath);
    if (comparableKeyPath.startsWith(`${comparableHome}/`)) {
      aliases.add(`~/${normalizedKeyPath.slice(normalizedHome.length + 1)}`);
    } else if (normalizedKeyPath.startsWith("~/")) {
      const suffix = normalizedKeyPath.slice(2);
      aliases.add(`${normalizedHome}/${suffix}`);
      const nativeHome = homeDir.replace(/[\\/]+$/u, "");
      const nativeSeparator = homeDir.includes("\\") ? "\\" : "/";
      aliases.add(`${nativeHome}${nativeSeparator}${suffix.replace(/\//g, nativeSeparator)}`);
    }
  } catch {
    // The renderer bridge may be unavailable in tests or web fallback mode.
  }
  return [...aliases];
}

export async function saveDefaultKeyPassphrase(keyPath: string, passphrase: string): Promise<void> {
  const aliases = await resolveDefaultKeyPassphraseAliases(keyPath);
  const encrypted = await encryptField(passphrase) ?? passphrase;
  const store = localStorageAdapter.read<Record<string, string>>(STORAGE_KEY_DEFAULT_KEY_PASSPHRASES) ?? {};
  const aliasKeys = matchingPathKeys(aliases);
  for (const storedPath of Object.keys(store)) {
    if (storedPath !== keyPath && aliasKeys.has(defaultKeyPassphrasePathKey(storedPath))) {
      delete store[storedPath];
    }
  }
  store[keyPath] = encrypted;
  localStorageAdapter.write(STORAGE_KEY_DEFAULT_KEY_PASSPHRASES, store);
}

function matchingStoreEntriesChanged(
  previous: Record<string, string>,
  latest: Record<string, string> | null,
  aliasKeys: Set<string>,
): boolean {
  const paths = new Set([
    ...Object.keys(previous),
    ...Object.keys(latest ?? {}),
  ]);
  for (const path of paths) {
    if (
      aliasKeys.has(defaultKeyPassphrasePathKey(path))
      && previous[path] !== latest?.[path]
    ) return true;
  }
  return false;
}

async function loadDefaultKeyPassphraseOnce(keyPath: string): Promise<{
  retry: boolean;
  value: string | null;
}> {
  const store = localStorageAdapter.read<Record<string, string>>(STORAGE_KEY_DEFAULT_KEY_PASSPHRASES);
  if (!store) return { retry: false, value: null };
  const aliases = await resolveDefaultKeyPassphraseAliases(keyPath);
  const aliasKeys = matchingPathKeys(aliases);
  const storedPaths = Object.keys(store).filter((path) => (
    aliasKeys.has(defaultKeyPassphrasePathKey(path))
  ));
  const exactIndex = storedPaths.indexOf(keyPath);
  if (exactIndex > 0) {
    storedPaths.unshift(storedPaths.splice(exactIndex, 1)[0]);
  }

  const invalidEntries = new Map<string, string>();
  for (const storedPath of storedPaths) {
    const decrypted = await decryptField(store[storedPath]);
    if (decrypted && !isEncryptedCredentialPlaceholder(decrypted)) {
      const latestStore = localStorageAdapter.read<Record<string, string>>(STORAGE_KEY_DEFAULT_KEY_PASSPHRASES);
      if (matchingStoreEntriesChanged(store, latestStore, aliasKeys)) {
        return { retry: true, value: null };
      }
      if (latestStore) {
        let changed = false;
        for (const duplicatePath of storedPaths) {
          if (duplicatePath !== storedPath && duplicatePath in latestStore) {
            delete latestStore[duplicatePath];
            changed = true;
          }
        }
        if (changed) {
          localStorageAdapter.write(STORAGE_KEY_DEFAULT_KEY_PASSPHRASES, latestStore);
        }
      }
      return { retry: false, value: decrypted };
    }
    invalidEntries.set(storedPath, store[storedPath]);
  }
  if (invalidEntries.size > 0) {
    const latestStore = localStorageAdapter.read<Record<string, string>>(STORAGE_KEY_DEFAULT_KEY_PASSPHRASES);
    if (matchingStoreEntriesChanged(store, latestStore, aliasKeys)) {
      return { retry: true, value: null };
    }
    if (latestStore) {
      let changed = false;
      for (const [storedPath, invalidValue] of invalidEntries) {
        if (latestStore[storedPath] === invalidValue) {
          delete latestStore[storedPath];
          changed = true;
        }
      }
      if (changed) {
        localStorageAdapter.write(STORAGE_KEY_DEFAULT_KEY_PASSPHRASES, latestStore);
      }
    }
  }
  return { retry: false, value: null };
}

export async function loadDefaultKeyPassphrase(keyPath: string): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await loadDefaultKeyPassphraseOnce(keyPath);
    if (!result.retry) return result.value;
  }
  return null;
}

export type DefaultKeyPassphraseExportRead =
  | { status: "missing" }
  | { status: "readable"; value: string }
  | { status: "unreadable" };

async function readDefaultKeyPassphraseForExportOnce(
  keyPath: string,
): Promise<{ retry: boolean; result: DefaultKeyPassphraseExportRead }> {
  const aliases = await resolveDefaultKeyPassphraseAliases(keyPath);
  const aliasKeys = matchingPathKeys(aliases);
  const store = localStorageAdapter.read<Record<string, string>>(STORAGE_KEY_DEFAULT_KEY_PASSPHRASES);
  if (!store) return { retry: false, result: { status: "missing" } };

  const storedPaths = Object.keys(store).filter((path) => (
    aliasKeys.has(defaultKeyPassphrasePathKey(path))
  ));
  const exactIndex = storedPaths.indexOf(keyPath);
  if (exactIndex > 0) {
    storedPaths.unshift(storedPaths.splice(exactIndex, 1)[0]);
  }
  if (storedPaths.length === 0) return { retry: false, result: { status: "missing" } };

  for (const storedPath of storedPaths) {
    try {
      const decrypted = await decryptField(store[storedPath]);
      if (decrypted && !isEncryptedCredentialPlaceholder(decrypted)) {
        const latestStore = localStorageAdapter.read<Record<string, string>>(STORAGE_KEY_DEFAULT_KEY_PASSPHRASES);
        if (matchingStoreEntriesChanged(store, latestStore, aliasKeys)) {
          return { retry: true, result: { status: "unreadable" } };
        }
        return { retry: false, result: { status: "readable", value: decrypted } };
      }
    } catch {
      // Export must not mutate saved credentials when secure storage is unavailable.
    }
  }
  const latestStore = localStorageAdapter.read<Record<string, string>>(STORAGE_KEY_DEFAULT_KEY_PASSPHRASES);
  if (matchingStoreEntriesChanged(store, latestStore, aliasKeys)) {
    return { retry: true, result: { status: "unreadable" } };
  }
  return { retry: false, result: { status: "unreadable" } };
}

export async function readDefaultKeyPassphraseForExport(
  keyPath: string,
): Promise<DefaultKeyPassphraseExportRead> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const read = await readDefaultKeyPassphraseForExportOnce(keyPath);
    if (!read.retry) return read.result;
  }
  return { status: "unreadable" };
}

export function removeDefaultKeyPassphrases(keyPaths: string[]): void {
  const store = localStorageAdapter.read<Record<string, string>>(STORAGE_KEY_DEFAULT_KEY_PASSPHRASES);
  if (!store) return;
  const pathKeys = matchingPathKeys(keyPaths);
  let changed = false;
  for (const storedPath of Object.keys(store)) {
    if (pathKeys.has(defaultKeyPassphrasePathKey(storedPath))) {
      delete store[storedPath];
      changed = true;
    }
  }
  if (changed) {
    localStorageAdapter.write(STORAGE_KEY_DEFAULT_KEY_PASSPHRASES, store);
  }
}

export async function removeDefaultKeyPassphraseAliases(keyPaths: string[]): Promise<string[]> {
  const before = localStorageAdapter.read<Record<string, string>>(STORAGE_KEY_DEFAULT_KEY_PASSPHRASES) ?? {};
  const aliases = Array.from(new Set((await Promise.all(
    keyPaths.map(resolveDefaultKeyPassphraseAliases),
  )).flat()));
  const aliasKeys = matchingPathKeys(aliases);
  const latest = localStorageAdapter.read<Record<string, string>>(STORAGE_KEY_DEFAULT_KEY_PASSPHRASES) ?? {};
  const matchingPaths = new Set([...Object.keys(before), ...Object.keys(latest)].filter((path) => (
    aliasKeys.has(defaultKeyPassphrasePathKey(path))
  )));
  for (const path of matchingPaths) {
    if (before[path] !== latest[path]) {
      return [];
    }
  }
  let changed = false;
  for (const path of matchingPaths) {
    if (path in latest) {
      delete latest[path];
      changed = true;
    }
  }
  if (changed) {
    localStorageAdapter.write(STORAGE_KEY_DEFAULT_KEY_PASSPHRASES, latest);
  }
  return aliases;
}

export async function deleteVaultKey(args: {
  keyId: string;
  getKeys: () => SSHKey[];
  updateKeys: (keys: SSHKey[]) => void;
}): Promise<void> {
  const keys = args.getKeys();
  const key = keys.find((candidate) => candidate.id === args.keyId);
  if (!key) return;

  args.updateKeys(keys.filter((candidate) => candidate.id !== args.keyId));
  if (key.source !== "reference" || !key.filePath) return;

  const deletedAliases = await resolveDefaultKeyPassphraseAliases(key.filePath);
  const deletedAliasKeys = matchingPathKeys(deletedAliases);
  const currentReferencePathKeys = matchingPathKeys(args.getKeys()
    .filter((candidate) => candidate.source === "reference" && candidate.filePath)
    .map((candidate) => candidate.filePath!));
  const pathStillReferenced = [...currentReferencePathKeys]
    .some((path) => deletedAliasKeys.has(path));
  if (!pathStillReferenced) {
    removeDefaultKeyPassphrases(deletedAliases);
  }
}

export function clearReferenceKeyPassphrases(keys: SSHKey[], keyPaths: string[]): SSHKey[] {
  const pathKeys = matchingPathKeys(keyPaths);
  let changed = false;
  const updated = keys.map((key) => {
    if (
      key.source === "reference"
      && key.filePath
      && pathKeys.has(defaultKeyPassphrasePathKey(key.filePath))
      && key.passphrase
    ) {
      changed = true;
      return { ...key, passphrase: undefined, savePassphrase: false };
    }
    return key;
  });
  return changed ? updated : keys;
}

export function clearKeyPassphrasesByIds(keys: SSHKey[], keyIds: string[] = []): SSHKey[] {
  if (keyIds.length === 0) return keys;
  const ids = new Set(keyIds);
  let changed = false;
  const updated = keys.map((key) => {
    if (ids.has(key.id) && key.passphrase) {
      changed = true;
      return { ...key, passphrase: undefined, savePassphrase: false };
    }
    return key;
  });
  return changed ? updated : keys;
}

export function shouldUpdateReferenceKeyPassphrase(key?: SSHKey | null): boolean {
  return Boolean(
    key &&
      (!key.passphrase || isEncryptedCredentialPlaceholder(key.passphrase)),
  );
}

export async function rememberKeyPassphrase(args: {
  keyPath: string;
  passphrase: string;
  keys: SSHKey[];
  getKeys?: () => SSHKey[];
  updateKeys: (keys: SSHKey[]) => Promise<unknown> | unknown;
  setCurrentKeys?: (keys: SSHKey[]) => void;
}): Promise<void> {
  const { keyPath, passphrase, keys, getKeys, updateKeys, setCurrentKeys } = args;
  const aliases = await resolveDefaultKeyPassphraseAliases(keyPath);
  const aliasKeys = matchingPathKeys(aliases);
  await saveDefaultKeyPassphrase(keyPath, passphrase);

  let changed = false;
  const updated = (getKeys?.() ?? keys).map((key) => {
    if (
      key.source !== "reference"
      || !key.filePath
      || !aliasKeys.has(defaultKeyPassphrasePathKey(key.filePath))
    ) return key;
    changed = true;
    return { ...key, passphrase, savePassphrase: true };
  });
  if (!changed) return;
  setCurrentKeys?.(updated);
  await updateKeys(updated);
}
