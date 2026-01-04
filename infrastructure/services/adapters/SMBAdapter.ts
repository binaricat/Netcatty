/**
 * SMB Adapter - Server Message Block Protocol
 * 
 * Provides cloud sync capabilities via SMB/CIFS file shares.
 * All operations are delegated to the Electron main process via netcattyBridge.
 */

import {
  SYNC_CONSTANTS,
  type SMBConfig,
  type SyncedFile,
  type ProviderAccount,
  type OAuthTokens,
} from '../../../domain/sync';
import { netcattyBridge } from '../netcattyBridge';
import type { CloudAdapter } from './index';

const normalizeShare = (share: string): string => {
  const trimmed = share.trim();
  // Convert smb:// URL format to UNC path format for consistency
  if (trimmed.toLowerCase().startsWith('smb://')) {
    const withoutProtocol = trimmed.slice(6);
    return `//${withoutProtocol}`;
  }
  // Ensure proper UNC path format
  if (!trimmed.startsWith('//') && !trimmed.startsWith('\\\\')) {
    return `//${trimmed}`;
  }
  return trimmed.replace(/\\/g, '/');
};

export class SMBAdapter implements CloudAdapter {
  private config: SMBConfig | null;
  private resource: string | null;
  private account: ProviderAccount | null;

  constructor(config?: SMBConfig, resourceId?: string) {
    this.config = config
      ? { ...config, share: normalizeShare(config.share) }
      : null;
    this.resource = resourceId || null;
    this.account = this.buildAccountInfo(this.config);
  }

  get isAuthenticated(): boolean {
    return !!this.config;
  }

  get accountInfo(): ProviderAccount | null {
    return this.account;
  }

  get resourceId(): string | null {
    return this.resource;
  }

  signOut(): void {
    this.config = null;
    this.resource = null;
    this.account = null;
  }

  async initializeSync(): Promise<string | null> {
    if (!this.config) {
      throw new Error('Missing SMB config');
    }
    const bridge = netcattyBridge.get();
    if (bridge?.cloudSyncSmbInitialize) {
      const result = await bridge.cloudSyncSmbInitialize(this.config);
      this.resource = result?.resourceId || this.getSyncPath();
      return this.resource;
    }
    // Fallback: just return the sync path (actual implementation is in Electron main process)
    this.resource = this.getSyncPath();
    return this.resource;
  }

  async upload(syncedFile: SyncedFile): Promise<string> {
    if (!this.config) {
      throw new Error('Missing SMB config');
    }
    const bridge = netcattyBridge.get();
    if (bridge?.cloudSyncSmbUpload) {
      const result = await bridge.cloudSyncSmbUpload(this.config, syncedFile);
      this.resource = result?.resourceId || this.getSyncPath();
      return this.resource;
    }
    throw new Error('SMB upload requires Electron main process');
  }

  async download(): Promise<SyncedFile | null> {
    if (!this.config) {
      throw new Error('Missing SMB config');
    }
    const bridge = netcattyBridge.get();
    if (bridge?.cloudSyncSmbDownload) {
      const result = await bridge.cloudSyncSmbDownload(this.config);
      return (result?.syncedFile ?? null) as SyncedFile | null;
    }
    throw new Error('SMB download requires Electron main process');
  }

  async deleteSync(): Promise<void> {
    if (!this.config) {
      return;
    }
    const bridge = netcattyBridge.get();
    if (bridge?.cloudSyncSmbDelete) {
      await bridge.cloudSyncSmbDelete(this.config);
      return;
    }
    throw new Error('SMB delete requires Electron main process');
  }

  getTokens(): OAuthTokens | null {
    return null;
  }

  private getSyncPath(): string {
    return SYNC_CONSTANTS.SYNC_FILE_NAME;
  }

  private buildAccountInfo(config: SMBConfig | null): ProviderAccount | null {
    if (!config) return null;
    try {
      // Extract server name from share path
      const share = config.share.replace(/^\/\//, '').replace(/^\\\\/, '');
      const parts = share.split(/[\/\\]/);
      const server = parts[0] || 'SMB';
      const shareName = parts[1] || '';
      const name = config.username 
        ? `${config.username}@${server}/${shareName}` 
        : `${server}/${shareName}`;
      return { id: config.share, name };
    } catch {
      return { id: config.share, name: config.share };
    }
  }
}

export default SMBAdapter;
