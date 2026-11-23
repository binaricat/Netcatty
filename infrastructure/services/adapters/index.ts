/**
 * Cloud Sync Adapters - Unified Export
 */

import type {
  CloudProvider,
  SyncedFile,
  OAuthTokens,
  ProviderAccount,
  WebDAVConfig,
  S3Config,
} from '../../../domain/sync';
import { isBuiltinCloudProvider } from '../../../domain/sync';
import type { EncryptedObjectStorage } from '../../../domain/encryptedObjectStorage';
import {
  cloudAdapterAsEncryptedObjectStorage,
  encryptedObjectStorageAsCloudAdapter,
  webdavEncryptedObjectCapabilities,
} from './encryptedObjectStorageBridge';

/**
 * Unified adapter interface
 */
export interface CloudAdapter {
  readonly isAuthenticated: boolean;
  readonly accountInfo: ProviderAccount | null;
  readonly resourceId: string | null;
  /** Validator tied to the exact snapshot read or successfully written. */
  readonly remoteValidator?: { signature: string; etag: string };
  inspectRemote?(etag: string): Promise<{ remoteFile: SyncedFile | null; notModified?: boolean }>;
  
  signOut(): void;
  initializeSync(): Promise<string | null>;
  upload(syncedFile: SyncedFile, options?: { signal?: AbortSignal }): Promise<string>;
  download(options?: { signal?: AbortSignal }): Promise<SyncedFile | null>;
  deleteSync(options?: { signal?: AbortSignal }): Promise<void>;
  getTokens(): OAuthTokens | null;
}

export type { EncryptedObjectStorage };

/**
 * Create adapter for a specific provider.
 * Built-in providers keep their dedicated adapters. Namespaced plugin provider
 * IDs require an EncryptedObjectStorage factory (plugin host bridge).
 */
export const createAdapter = async (
  provider: CloudProvider,
  tokens?: OAuthTokens,
  resourceId?: string,
  config?: WebDAVConfig | S3Config,
  options?: {
    /** Plugin sync storage factory for namespaced provider IDs. */
    createPluginStorage?: (providerId: string) => EncryptedObjectStorage | Promise<EncryptedObjectStorage>;
  },
): Promise<CloudAdapter> => {
  switch (provider) {
    case 'github': {
      const { GitHubAdapter } = await import('./GitHubAdapter');
      return new GitHubAdapter(tokens, resourceId);
    }
    case 'google': {
      const { GoogleDriveAdapter } = await import('./GoogleDriveAdapter');
      return new GoogleDriveAdapter(tokens, resourceId);
    }
    case 'onedrive': {
      const { OneDriveAdapter } = await import('./OneDriveAdapter');
      return new OneDriveAdapter(tokens, resourceId);
    }
    case 'webdav': {
      const { WebDAVAdapter } = await import('./WebDAVAdapter');
      // Production WebDAV path runs through EncryptedObjectStorage so plugin
      // providers and WebDAV share one encrypt→write / read→decrypt surface.
      const raw = new WebDAVAdapter(config as WebDAVConfig | undefined, resourceId);
      const storage = cloudAdapterAsEncryptedObjectStorage(raw, 'webdav', {
        capabilities: webdavEncryptedObjectCapabilities(),
      });
      return encryptedObjectStorageAsCloudAdapter(storage, {
        account: raw.accountInfo,
        // Match raw WebDAVAdapter: config present ⇒ authenticated for cache reuse.
        initiallyAuthenticated: raw.isAuthenticated,
        // Preserve constructor/persisted resourceId; refresh from raw after connect.
        resourceId: raw.resourceId ?? resourceId ?? null,
        resolveResourceId: () => raw.resourceId,
        // WebDAVAdapter.upload already performs pad + strict body verify; skip the
        // shared bridge's second full re-read to avoid write amplification.
        assumeVerifiedWrites: true,
        remoteInspection: raw,
      });
    }
    case 's3': {
      const { S3Adapter } = await import('./S3Adapter');
      return new S3Adapter(config as S3Config | undefined, resourceId);
    }
    default: {
      if (isBuiltinCloudProvider(provider)) {
        throw new Error(`Unknown provider: ${provider}`);
      }
      if (!options?.createPluginStorage) {
        throw new Error(
          `Plugin sync provider ${provider} is unavailable (missing or not registered)`,
        );
      }
      const storage = await options.createPluginStorage(provider);
      // Credentials/config already validated by getConnectedAdapter; report
      // authenticated so the manager reuses this instance across sync calls.
      // rebindSession: plugin runtimes can restart while availability membership
      // stays unchanged, so ensureConnected must re-issue connect() with the
      // saved configuration/credential instead of skipping after the first call.
      return encryptedObjectStorageAsCloudAdapter(storage, {
        initiallyAuthenticated: true,
        resourceId: resourceId ?? null,
        rebindSession: true,
      });
    }
  }
};

/**
 * View a CloudAdapter as EncryptedObjectStorage. WebDAV is the first built-in
 * adapted through this shared surface for configuration, secrets, upload,
 * download, verification, and recovery exercises.
 */
export const asEncryptedObjectStorage = (
  provider: CloudProvider,
  adapter: CloudAdapter,
): EncryptedObjectStorage =>
  cloudAdapterAsEncryptedObjectStorage(adapter, provider, {
    capabilities: provider === 'webdav'
      ? webdavEncryptedObjectCapabilities()
      : {
        revisions: provider === 'github',
        conditionalWrites: false,
        atomicReplacement: provider === 'webdav' || provider === 's3',
      },
  });
