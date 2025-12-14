/**
 * Cloud Sync Adapters - Unified Export
 */

export { GitHubAdapter, type DeviceFlowState } from './GitHubAdapter';
export { GoogleDriveAdapter } from './GoogleDriveAdapter';
export { OneDriveAdapter } from './OneDriveAdapter';

import { GitHubAdapter } from './GitHubAdapter';
import { GoogleDriveAdapter } from './GoogleDriveAdapter';
import { OneDriveAdapter } from './OneDriveAdapter';
import type { CloudProvider, SyncedFile, OAuthTokens, ProviderAccount } from '../../../domain/sync';

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
export const createAdapter = (
  provider: CloudProvider,
  tokens?: OAuthTokens,
  resourceId?: string
): CloudAdapter => {
  switch (provider) {
    case 'github':
      return new GitHubAdapter(tokens, resourceId);
    case 'google':
      return new GoogleDriveAdapter(tokens, resourceId);
    case 'onedrive':
      return new OneDriveAdapter(tokens, resourceId);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
};
