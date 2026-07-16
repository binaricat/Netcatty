/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  SYNC_STORAGE_KEYS,
  type CloudProvider,
  type ConvergentProviderBaselineV2,
  type ConvergentReplicaRecordV2,
  type MasterKeyConfig,
} from '../../../domain/sync';
import {
  assertValidConvergentSyncState,
  canonicalizeConvergentSyncState,
  stripConvergentSyncEnvelope,
} from '../../../domain/convergentSync';
import {
  decryptLocalStorageValue,
  encryptLocalStorageValue,
} from './encryptedLocalStorage';

const PROVIDERS: CloudProvider[] = ['github', 'google', 'onedrive', 'webdav', 's3'];

export function convergentProviderBaselineKeyImpl(this: any, provider: CloudProvider): string {
  return `${SYNC_STORAGE_KEYS.CONVERGENT_PROVIDER_BASELINE}_${provider}`;
}

function requireLocalEncryptionKey(manager: any): CryptoKey {
  const key = manager.state.unlockedKey?.derivedKey;
  if (!key) throw new Error('Convergent sync encryption key is unavailable');
  return key;
}

export async function saveConvergentReplicaImpl(
  this: any,
  record: ConvergentReplicaRecordV2,
): Promise<void> {
  if (record.schemaVersion !== 2) throw new Error('Unsupported convergent replica schema');
  assertValidConvergentSyncState(record.state);
  const normalized: ConvergentReplicaRecordV2 = {
    schemaVersion: 2,
    state: canonicalizeConvergentSyncState(record.state),
    updatedAt: record.updatedAt,
  };
  if (this.saveToStorage(
    SYNC_STORAGE_KEYS.CONVERGENT_REPLICA,
    await encryptLocalStorageValue(normalized, requireLocalEncryptionKey(this)),
  ) === false) throw new Error('Unable to persist convergent sync replica');
}

export async function loadConvergentReplicaImpl(this: any): Promise<ConvergentReplicaRecordV2 | null> {
  const encoded = this.loadFromStorage(SYNC_STORAGE_KEYS.CONVERGENT_REPLICA) as unknown;
  if (!encoded) return null;
  if (typeof encoded !== 'string') throw new Error('Convergent replica record is invalid');
  const record = await decryptLocalStorageValue<ConvergentReplicaRecordV2>(
    encoded,
    requireLocalEncryptionKey(this),
  );
  if (record?.schemaVersion !== 2 || !Number.isFinite(record.updatedAt)) {
    throw new Error('Convergent replica record has an unsupported schema');
  }
  assertValidConvergentSyncState(record.state);
  return {
    schemaVersion: 2,
    state: canonicalizeConvergentSyncState(record.state),
    updatedAt: record.updatedAt,
  };
}

export async function saveConvergentProviderBaselineImpl(
  this: any,
  baseline: ConvergentProviderBaselineV2,
): Promise<void> {
  if (baseline.schemaVersion !== 2) throw new Error('Unsupported convergent baseline schema');
  assertValidConvergentSyncState(baseline.state);
  const normalized: ConvergentProviderBaselineV2 = {
    ...baseline,
    materializedPayload: stripConvergentSyncEnvelope(baseline.materializedPayload),
    state: canonicalizeConvergentSyncState(baseline.state),
  };
  if (this.saveToStorage(
    this.convergentProviderBaselineKey(baseline.provider),
    await encryptLocalStorageValue(normalized, requireLocalEncryptionKey(this)),
  ) === false) throw new Error(`Unable to persist convergent baseline for ${baseline.provider}`);
}

export async function loadConvergentProviderBaselineImpl(
  this: any,
  provider: CloudProvider,
): Promise<ConvergentProviderBaselineV2 | null> {
  const encoded = this.loadFromStorage(this.convergentProviderBaselineKey(provider)) as unknown;
  if (!encoded) return null;
  if (typeof encoded !== 'string') throw new Error(`Convergent baseline for ${provider} is invalid`);
  const baseline = await decryptLocalStorageValue<ConvergentProviderBaselineV2>(
    encoded,
    requireLocalEncryptionKey(this),
  );
  if (baseline?.schemaVersion !== 2 || baseline.provider !== provider) {
    throw new Error(`Convergent baseline for ${provider} has an unsupported schema`);
  }
  assertValidConvergentSyncState(baseline.state);
  return {
    ...baseline,
    materializedPayload: stripConvergentSyncEnvelope(baseline.materializedPayload),
    state: canonicalizeConvergentSyncState(baseline.state),
  };
}

export function clearConvergentSyncStorageImpl(this: any, confirmed: boolean): void {
  if (!confirmed) throw new Error('Explicit confirmation is required to remove convergent sync state');
  this.removeFromStorage(SYNC_STORAGE_KEYS.CONVERGENT_REPLICA);
  for (const provider of PROVIDERS) {
    this.removeFromStorage(this.convergentProviderBaselineKey(provider));
  }
}

function encryptedSyncStorageKeys(manager: any): string[] {
  const keys = new Set<string>([
    manager.syncBaseKey(),
    manager.syncSnapshotsKey(),
    SYNC_STORAGE_KEYS.CONVERGENT_REPLICA,
  ]);
  for (const provider of PROVIDERS) {
    keys.add(manager.syncBaseKey(provider));
    keys.add(manager.syncSnapshotsKey(provider));
    keys.add(manager.convergentProviderBaselineKey(provider));
  }
  return [...keys];
}

/**
 * Re-encrypt every derived-key local record before committing the new master
 * configuration. Values are prepared first, concurrent changes abort the
 * transaction, and any write failure rolls all keys back to their exact prior
 * ciphertext.
 */
export async function reencryptSyncStorageImpl(
  this: any,
  oldKey: CryptoKey,
  newKey: CryptoKey,
  newConfig: MasterKeyConfig,
): Promise<void> {
  const keys = encryptedSyncStorageKeys(this);
  const previousConfig = (
    this.loadFromStorage(SYNC_STORAGE_KEYS.MASTER_KEY_CONFIG)
    ?? this.state.masterKeyConfig
  ) as MasterKeyConfig | null;
  const originals = new Map<string, string | null>();
  const replacements = new Map<string, string>();
  for (const key of keys) {
    const encoded = this.loadFromStorage(key) as unknown;
    if (encoded == null) {
      originals.set(key, null);
      continue;
    }
    if (typeof encoded !== 'string') throw new Error(`Encrypted sync record ${key} is invalid`);
    originals.set(key, encoded);
    const value = await decryptLocalStorageValue<unknown>(encoded, oldKey);
    replacements.set(key, await encryptLocalStorageValue(value, newKey));
  }
  for (const [key, original] of originals) {
    const current = this.loadFromStorage(key) as unknown;
    if ((current ?? null) !== original) {
      throw new Error('Sync data changed while the master key was being rotated');
    }
  }
  const currentConfig = this.loadFromStorage(
    SYNC_STORAGE_KEYS.MASTER_KEY_CONFIG,
  ) as MasterKeyConfig | null;
  if (JSON.stringify(currentConfig) !== JSON.stringify(previousConfig)) {
    throw new Error('Master key configuration changed while it was being rotated');
  }
  const committed: string[] = [];
  try {
    for (const [key, replacement] of replacements) {
      if (this.saveToStorage(key, replacement) === false) {
        throw new Error(`Unable to persist re-encrypted sync record: ${key}`);
      }
      committed.push(key);
    }
    if (this.saveToStorage(SYNC_STORAGE_KEYS.MASTER_KEY_CONFIG, newConfig) === false) {
      throw new Error('Unable to persist the new master key configuration');
    }
  } catch (error) {
    for (const key of committed.reverse()) {
      const original = originals.get(key);
      if (original !== undefined) this.saveToStorage(key, original);
    }
    if (previousConfig) this.saveToStorage(SYNC_STORAGE_KEYS.MASTER_KEY_CONFIG, previousConfig);
    else this.removeFromStorage(SYNC_STORAGE_KEYS.MASTER_KEY_CONFIG);
    throw error;
  }
}
