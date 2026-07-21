import type { Host, SSHKey } from "../domain/models";
import { isEncryptedCredentialPlaceholder, sanitizeCredentialValue } from "../domain/credentials";
import { resolveVaultCsvHostKeyPath } from "../domain/vaultImport";
import {
  readExportableRememberedKeyPassphrases,
  type DefaultKeyPassphraseVerificationRead,
} from "./defaultKeyPassphrases";

export interface VaultCsvCredentialOptions {
  keyPathsById: Map<string, string>;
  keyPassphrasesById: Map<string, string>;
  keyPassphrases: Map<string, string>;
  unreadablePassphraseCount: number;
}

export async function buildVaultCsvCredentialOptions(
  hosts: Host[],
  keys: SSHKey[],
  readPassphrases?: (
    keyPath: string,
  ) => Promise<DefaultKeyPassphraseVerificationRead>,
): Promise<VaultCsvCredentialOptions> {
  const exportableHosts = hosts.filter((host) => host.protocol !== "serial");
  const referenceKeysById = new Map(keys.map((key) => [key.id, key] as const));
  const keyPathsById = new Map(keys.flatMap((key) => (
    key.source === "reference" && key.filePath?.trim()
      ? [[key.id, key.filePath.trim()] as const]
      : []
  )));
  const keyPaths = Array.from(new Set(exportableHosts
    .map((host) => resolveVaultCsvHostKeyPath(host, { keyPathsById }))
    .filter(Boolean)));
  const reads = new Map<string, DefaultKeyPassphraseVerificationRead>();
  const readForExport = readPassphrases ?? (async (keyPath: string) => {
    const remembered = await readExportableRememberedKeyPassphrases(keyPath, keys);
    return {
      ...remembered,
      present: remembered.unreadable || remembered.values.length > 0,
    };
  });
  await Promise.all(keyPaths.map(async (keyPath) => {
    try {
      reads.set(keyPath, await readForExport(keyPath));
    } catch {
      reads.set(keyPath, { values: [], unreadable: true, present: true });
    }
  }));

  const keyPassphrasesById = new Map<string, string>();
  const keyPassphrases = new Map<string, string>();
  const unreadableKeyPaths = new Set<string>();
  for (const host of exportableHosts) {
    const keyPath = resolveVaultCsvHostKeyPath(host, { keyPathsById });
    if (!keyPath) continue;
    const read = reads.get(keyPath);
    const verifiedSideStoreValue = read?.values.length === 1 && !read.unreadable
      ? read.values[0]
      : undefined;
    const sideStoreIsAmbiguous = Boolean(
      read && (read.unreadable || read.values.length > 1),
    );
    if (host.identityFileId) {
      const key = referenceKeysById.get(host.identityFileId);
      if (key?.source !== "reference" || key.savePassphrase === false) continue;
      const keyValue = sanitizeCredentialValue(key.passphrase);
      const hasSavedCredentialState = key.savePassphrase === true || Boolean(key.passphrase);
      const selected = keyValue ?? (hasSavedCredentialState ? verifiedSideStoreValue : undefined);
      if (selected) {
        keyPassphrasesById.set(host.identityFileId, selected);
      } else if (
        isEncryptedCredentialPlaceholder(key.passphrase)
        || (hasSavedCredentialState && sideStoreIsAmbiguous)
      ) {
        unreadableKeyPaths.add(keyPath);
      }
      continue;
    }

    const selected = verifiedSideStoreValue;
    if (selected) {
      keyPassphrases.set(keyPath, selected);
    } else if (sideStoreIsAmbiguous || !reads.has(keyPath)) {
      unreadableKeyPaths.add(keyPath);
    }
  }

  return {
    keyPathsById,
    keyPassphrasesById,
    keyPassphrases,
    unreadablePassphraseCount: unreadableKeyPaths.size,
  };
}
