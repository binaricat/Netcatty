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
  SMBConfig,
} from '../../../domain/sync';

/**
 * Unified adapter interface
 */
export interface CloudAdapter {
  readonly isAuthenticated: boolean;
  readonly accountInfo: ProviderAccount | null;
  readonly resourceId: string | null;
  
  signOut(): void;
  initializeSync(): Promise<string | null>;
  upload(syncedFile: SyncedFile): Promise<string>;
  download(): Promise<SyncedFile | null>;
  deleteSync(): Promise<void>;
  getTokens(): OAuthTokens | null;
}

/**
 * Create adapter for a specific provider
 */
export const createAdapter = async (
  provider: CloudProvider,
  tokens?: OAuthTokens,
  resourceId?: string,
  config?: WebDAVConfig | S3Config | SMBConfig
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
      return new WebDAVAdapter(config as WebDAVConfig | undefined, resourceId);
    }
    case 's3': {
      const { S3Adapter } = await import('./S3Adapter');
      return new S3Adapter(config as S3Config | undefined, resourceId);
    }
    case 'smb': {
      const { SMBAdapter } = await import('./SMBAdapter');
      return new SMBAdapter(config as SMBConfig | undefined, resourceId);
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
};
