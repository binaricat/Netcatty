/**
 * Bridges between the legacy single-file CloudAdapter interface and the
 * shared EncryptedObjectStorage surface used by plugin sync Providers.
 */

import type {
  EncryptedObjectAccount,
  EncryptedObjectDeleteResult,
  EncryptedObjectReadResult,
  EncryptedObjectStorage,
  EncryptedObjectStorageCapabilities,
  EncryptedObjectWriteResult,
} from '../../../domain/encryptedObjectStorage';
// EncryptedObjectStorageCapabilities used for session capability gating.
import {
  DEFAULT_ENCRYPTED_SYNC_OBJECT_KEY,
} from '../../../domain/encryptedObjectStorage';
import type {
  OAuthTokens,
  ProviderAccount,
  SyncedFile,
} from '../../../domain/sync';
import type { CloudAdapter } from './index';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function syncedFileToBytes(syncedFile: SyncedFile): Uint8Array {
  return textEncoder.encode(JSON.stringify(syncedFile));
}

function bytesToSyncedFile(bytes: Uint8Array): SyncedFile {
  const raw = textDecoder.decode(bytes);
  // Require a complete JSON object. Do not accept a valid prefix with trailing
  // garbage — that hides provider corruption from read-and-verify recovery.
  return JSON.parse(raw) as SyncedFile;
}

/** Thrown when a conditional write is rejected (revision / precondition). */
export class ConditionalWriteConflictError extends Error {
  readonly code = 'conditional_write_conflict';

  constructor(message = 'Encrypted object conditional write was rejected', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConditionalWriteConflictError';
  }
}

export function isConditionalWriteConflictError(error: unknown): boolean {
  if (error instanceof ConditionalWriteConflictError) return true;
  if (!error || typeof error !== 'object') return false;
  const maybe = error as { name?: unknown; code?: unknown; message?: unknown; data?: { pluginCode?: unknown } };
  if (maybe.name === 'ConditionalWriteConflictError') return true;
  if (maybe.code === 'conditional_write_conflict' || maybe.code === -32009 || maybe.code === 'failed_precondition') {
    return true;
  }
  if (maybe.data?.pluginCode === 'failed_precondition') return true;
  return typeof maybe.message === 'string'
    && /failed[_ ]precondition|expectedRevision|revision mismatch|conditional write/i.test(maybe.message);
}

/**
 * Adapt a legacy CloudAdapter into EncryptedObjectStorage.
 * Uses a single default object key matching the historical vault file name.
 */
export function cloudAdapterAsEncryptedObjectStorage(
  adapter: CloudAdapter,
  providerId: string,
  options: {
    objectKey?: string;
    capabilities?: EncryptedObjectStorageCapabilities;
  } = {},
): EncryptedObjectStorage {
  const objectKey = options.objectKey ?? DEFAULT_ENCRYPTED_SYNC_OBJECT_KEY;
  const capabilities: EncryptedObjectStorageCapabilities = options.capabilities ?? {
    revisions: false,
    conditionalWrites: false,
    atomicReplacement: true,
  };

  return {
    providerId,
    async connect(): Promise<{ account: EncryptedObjectAccount }> {
      if (!adapter.isAuthenticated) {
        throw new Error(`Cloud provider ${providerId} is not authenticated`);
      }
      await adapter.initializeSync();
      const account = adapter.accountInfo;
      if (!account) {
        return { account: { id: providerId } };
      }
      return { account: { ...account } };
    },
    async disconnect(): Promise<void> {
      adapter.signOut();
    },
    async getAccount(): Promise<EncryptedObjectAccount | null> {
      return adapter.accountInfo ? { ...adapter.accountInfo } : null;
    },
    async getCapabilities(): Promise<EncryptedObjectStorageCapabilities> {
      return { ...capabilities };
    },
    async readObject(key: string): Promise<EncryptedObjectReadResult> {
      if (key !== objectKey) {
        return { found: false, key, bytes: null };
      }
      const file = await adapter.download();
      if (!file) return { found: false, key, bytes: null };
      const bytes = syncedFileToBytes(file);
      return {
        found: true,
        key,
        bytes,
        revision: file.meta?.version != null ? String(file.meta.version) : undefined,
        contentType: 'application/json',
      };
    },
    async writeObject(key: string, bytes: Uint8Array): Promise<EncryptedObjectWriteResult> {
      if (key !== objectKey) {
        throw new Error(`Cloud adapter ${providerId} only supports object key ${objectKey}`);
      }
      const syncedFile = bytesToSyncedFile(bytes);
      // Skip a pre-upload GET for `created`. The single-object vault path does not
      // consume that flag, and WebDAV already pays for pad+verify inside upload.
      await adapter.upload(syncedFile);
      return {
        created: false,
        revision: syncedFile.meta?.version != null ? String(syncedFile.meta.version) : undefined,
      };
    },
    async deleteObject(key: string): Promise<EncryptedObjectDeleteResult> {
      if (key !== objectKey) {
        return { deleted: false };
      }
      const existing = await adapter.download();
      if (!existing) return { deleted: false };
      await adapter.deleteSync();
      return { deleted: true };
    },
  };
}

/**
 * Adapt EncryptedObjectStorage into the legacy CloudAdapter surface so the
 * existing encrypt→upload / download→decrypt manager path can drive WebDAV and
 * plugin providers through one code path.
 *
 * Authentication and resourceId must match pre-bridge CloudAdapter semantics:
 * config-backed providers (WebDAV) report authenticated as soon as credentials
 * exist so getConnectedAdapter can reuse the cached instance; resourceId must
 * preserve the persisted path (or the backing adapter's authoritative id) rather
 * than always forcing the default object key.
 */
export function encryptedObjectStorageAsCloudAdapter(
  storage: EncryptedObjectStorage,
  options: {
    objectKey?: string;
    account?: ProviderAccount | null;
    /** When true, getConnectedAdapter reuses this instance without recreating. */
    initiallyAuthenticated?: boolean;
    /** Seeded resource id (e.g. path restored from provider connection storage). */
    resourceId?: string | null;
    /**
     * Prefer the backing adapter's resource id after connect/upload (WebDAV sets
     * `/netcatty-vault.json` via initializeSync; plugins may use object keys).
     */
    resolveResourceId?: () => string | null | undefined;
    /**
     * When true, re-issue connect() even if a prior session was established.
     * Required for plugin providers whose in-process clients die on runtime
     * restart/replace while the CloudAdapter cache stays alive.
     */
    rebindSession?: boolean;
    /**
     * When true, skip the host full-byte re-read after writeObject. Use only when
     * the backing storage already performs Netcatty-grade write verification
     * (WebDAV pad+verify). Plugin providers keep host-owned verify.
     */
    assumeVerifiedWrites?: boolean;
    remoteInspection?: Pick<CloudAdapter, 'inspectRemote' | 'remoteValidator'>;
  } = {},
): CloudAdapter {
  const objectKey = options.objectKey ?? DEFAULT_ENCRYPTED_SYNC_OBJECT_KEY;
  let account: ProviderAccount | null = options.account ?? null;
  let resourceId: string | null = options.resourceId ?? null;
  let authenticated = options.initiallyAuthenticated === true;
  /** Distinct from credential presence: plugin providers need an explicit connect. */
  let sessionConnected = false;
  /**
   * Last observed remote revision for conditional writes.
   * - string: known revision
   * - null: confirmed absent (must-not-exist write)
   * - undefined: unknown / unconditional
   */
  let lastRevision: string | null | undefined;

  const refreshResourceId = (fallback?: string | null): string | null => {
    const resolved = options.resolveResourceId?.();
    if (typeof resolved === 'string' && resolved.length > 0) {
      resourceId = resolved;
      return resourceId;
    }
    if (typeof fallback === 'string' && fallback.length > 0) {
      resourceId = fallback;
      return resourceId;
    }
    return resourceId;
  };

  let capabilities: EncryptedObjectStorageCapabilities | null = null;

  const ensureConnected = async (): Promise<void> => {
    if (sessionConnected && !options.rebindSession) return;
    // rebindSession: always re-run connect so a replaced plugin runtime gets a
    // fresh client. Connect is expected to be idempotent when still healthy.
    const result = await storage.connect();
    account = result.account;
    capabilities = await storage.getCapabilities();
    authenticated = true;
    sessionConnected = true;
    refreshResourceId(objectKey);
  };

  /** After I/O failure, force the next ensureConnected to re-issue connect(). */
  const markSessionStale = (): void => {
    sessionConnected = false;
  };

  return {
    get isAuthenticated() {
      return authenticated;
    },
    get accountInfo() {
      return account;
    },
    get resourceId() {
      return resourceId;
    },
    get remoteValidator() {
      return options.remoteInspection?.remoteValidator;
    },
    inspectRemote: options.remoteInspection?.inspectRemote?.bind(options.remoteInspection),
    signOut() {
      authenticated = false;
      sessionConnected = false;
      lastRevision = undefined;
      capabilities = null;
      account = null;
      resourceId = null;
      // Fire-and-forget is intentional for CloudAdapter.signOut sync API;
      // disconnectProvider should call initializeSync/connect after a full await
      // path when a future async signOut is added to CloudAdapter.
      void Promise.resolve(storage.disconnect()).catch(() => {
        // Plugin runtime may already be gone; local sign-out still succeeds.
      });
    },
    async initializeSync(): Promise<string | null> {
      try {
        await ensureConnected();
        return refreshResourceId(objectKey);
      } catch (error) {
        markSessionStale();
        throw error;
      }
    },
    async upload(syncedFile: SyncedFile, uploadOptions?: { signal?: AbortSignal }): Promise<string> {
      try {
        await ensureConnected();
        const bytes = syncedFileToBytes(syncedFile);
        if (
          capabilities?.maxObjectBytes != null
          && bytes.byteLength > capabilities.maxObjectBytes
        ) {
          throw new Error(
            `Encrypted object exceeds provider maxObjectBytes (${capabilities.maxObjectBytes})`,
          );
        }
        if (
          capabilities?.maxObjects != null
          && capabilities.maxObjects < 1
        ) {
          throw new Error(
            `Encrypted object provider reports maxObjects < 1 (${capabilities.maxObjects})`,
          );
        }
        const conditional = capabilities?.conditionalWrites === true;
        let writeResult: EncryptedObjectWriteResult;
        try {
          writeResult = await storage.writeObject(objectKey, bytes, {
            ...(conditional && lastRevision !== undefined
              ? { expectedRevision: lastRevision }
              : {}),
            signal: uploadOptions?.signal,
          });
        } catch (writeError) {
          if (conditional && isConditionalWriteConflictError(writeError)) {
            throw new ConditionalWriteConflictError(
              writeError instanceof Error ? writeError.message : String(writeError),
              { cause: writeError },
            );
          }
          throw writeError;
        }
        if (options.assumeVerifiedWrites === true) {
          // Backing adapter already verified (e.g. WebDAV pad+verify). Still honor
          // maxObjectBytes above and refresh revision from the write result.
          if (typeof writeResult.revision === 'string' && writeResult.revision.length > 0) {
            lastRevision = writeResult.revision;
          }
        } else {
          // Host-owned write verification: re-read and compare ciphertext bytes.
          const verified = await storage.readObject(objectKey, { signal: uploadOptions?.signal });
          if (!verified.found || !verified.bytes) {
            throw new Error('Encrypted object write verification failed: object missing after write');
          }
          if (verified.bytes.byteLength !== bytes.byteLength) {
            throw new Error('Encrypted object write verification failed: size mismatch');
          }
          for (let i = 0; i < bytes.byteLength; i += 1) {
            if (verified.bytes[i] !== bytes[i]) {
              throw new Error('Encrypted object write verification failed: content mismatch');
            }
          }
          if (typeof writeResult.revision === 'string' && writeResult.revision.length > 0) {
            lastRevision = writeResult.revision;
          } else if (typeof verified.revision === 'string' && verified.revision.length > 0) {
            lastRevision = verified.revision;
          } else {
            lastRevision = undefined;
          }
        }
        authenticated = true;
        return refreshResourceId(objectKey) ?? objectKey;
      } catch (error) {
        markSessionStale();
        throw error;
      }
    },
    async download(downloadOptions?: { signal?: AbortSignal }): Promise<SyncedFile | null> {
      try {
        await ensureConnected();
        const result = await storage.readObject(objectKey, { signal: downloadOptions?.signal });
        if (!result.found || !result.bytes) {
          // Confirmed absence: next conditional write must use expectedRevision null.
          lastRevision = null;
          return null;
        }
        if (typeof result.revision === 'string' && result.revision.length > 0) {
          lastRevision = result.revision;
        } else {
          lastRevision = undefined;
        }
        return bytesToSyncedFile(result.bytes);
      } catch (error) {
        markSessionStale();
        throw error;
      }
    },
    async deleteSync(deleteOptions?: { signal?: AbortSignal }): Promise<void> {
      try {
        await ensureConnected();
        await storage.deleteObject(objectKey, {
          ...(typeof lastRevision === 'string' ? { expectedRevision: lastRevision } : {}),
          signal: deleteOptions?.signal,
        });
        lastRevision = null;
      } catch (error) {
        markSessionStale();
        throw error;
      }
    },
    getTokens(): OAuthTokens | null {
      return null;
    },
  };
}

/**
 * WebDAV-specific capabilities: atomic replacement via temp+MOVE, no native revisions.
 */
export function webdavEncryptedObjectCapabilities(): EncryptedObjectStorageCapabilities {
  return {
    revisions: false,
    conditionalWrites: false,
    atomicReplacement: true,
  };
}
