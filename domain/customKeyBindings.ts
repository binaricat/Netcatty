import { CustomKeyBindings } from './models';

const SYNC_VERSION_FIELD = '__netcattySyncVersion';
const SYNC_ORIGIN_FIELD = '__netcattySyncOrigin';

export interface CustomKeyBindingsStorageRecord {
  bindings: CustomKeyBindings;
  version: number;
  origin: string;
}

export const serializeCustomKeyBindings = (bindings: CustomKeyBindings): string =>
  JSON.stringify(bindings);

export const areCustomKeyBindingsEqual = (a: CustomKeyBindings, b: CustomKeyBindings): boolean =>
  serializeCustomKeyBindings(a) === serializeCustomKeyBindings(b);

export const parseCustomKeyBindingsStorageRecord = (
  value: unknown,
): CustomKeyBindingsStorageRecord | null => {
  let candidate = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }

  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const record = candidate as Record<string, unknown>;
  if (
    typeof record.version === 'number' &&
    typeof record.origin === 'string' &&
    record.bindings &&
    typeof record.bindings === 'object'
  ) {
    return {
      version: record.version,
      origin: record.origin,
      bindings: record.bindings as CustomKeyBindings,
    };
  }

  if (
    typeof record[SYNC_VERSION_FIELD] === 'number' &&
    typeof record[SYNC_ORIGIN_FIELD] === 'string' &&
    record.bindings &&
    typeof record.bindings === 'object'
  ) {
    return {
      version: record[SYNC_VERSION_FIELD] as number,
      origin: record[SYNC_ORIGIN_FIELD] as string,
      bindings: record.bindings as CustomKeyBindings,
    };
  }

  return {
    version: 0,
    origin: 'legacy',
    bindings: candidate as CustomKeyBindings,
  };
};

export const serializeCustomKeyBindingsStorageRecord = (
  record: CustomKeyBindingsStorageRecord,
): string =>
  JSON.stringify({
    [SYNC_VERSION_FIELD]: record.version,
    [SYNC_ORIGIN_FIELD]: record.origin,
    bindings: record.bindings,
  });

export const nextCustomKeyBindingsSyncVersion = (
  currentVersion: number,
  now: number = Date.now(),
): number => Math.max(now, currentVersion + 1);

export const shouldApplyIncomingCustomKeyBindingsRecord = (
  current: Pick<CustomKeyBindingsStorageRecord, 'version' | 'origin'>,
  incoming: Pick<CustomKeyBindingsStorageRecord, 'version' | 'origin'>,
): boolean => {
  if (incoming.version !== current.version) {
    return incoming.version > current.version;
  }

  return incoming.origin > current.origin;
};

export const updateCustomKeyBinding = (
  bindings: CustomKeyBindings,
  bindingId: string,
  scheme: 'mac' | 'pc',
  newKey: string,
): CustomKeyBindings => ({
  ...bindings,
  [bindingId]: {
    ...bindings[bindingId],
    [scheme]: newKey,
  },
});

export const resetCustomKeyBinding = (
  bindings: CustomKeyBindings,
  bindingId: string,
  scheme?: 'mac' | 'pc',
): CustomKeyBindings => {
  if (!scheme) {
    const { [bindingId]: _removed, ...rest } = bindings;
    return rest;
  }

  const existing = bindings[bindingId];
  if (!existing) {
    return bindings;
  }

  const nextBinding = { ...existing };
  delete nextBinding[scheme];

  if (Object.keys(nextBinding).length === 0) {
    const { [bindingId]: _removed, ...rest } = bindings;
    return rest;
  }

  return {
    ...bindings,
    [bindingId]: nextBinding,
  };
};
