/**
 * S3 Compatible Adapter - delegates to Electron main-process cloudSyncBridge.
 */

import {
  SYNC_CONSTANTS,
  type S3Config,
  type SyncedFile,
  type ProviderAccount,
  type OAuthTokens,
} from '../../../domain/sync';
import { netcattyBridge } from '../netcattyBridge';

const normalizeEndpoint = (endpoint: string): string => {
  const trimmed = endpoint.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
};

export class S3Adapter {
  private config: S3Config | null;
  private resource: string | null;
  private account: ProviderAccount | null;

  constructor(config?: S3Config, resourceId?: string) {
    this.config = config
      ? { ...config, endpoint: normalizeEndpoint(config.endpoint) }
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
      throw new Error('Missing S3 config');
    }
    const bridge = netcattyBridge.get();
    if (!bridge?.cloudSyncS3Initialize) {
      throw new Error('S3 sync requires the Netcatty desktop sync bridge');
    }
    const result = await bridge.cloudSyncS3Initialize(this.config);
    this.resource = result?.resourceId || this.getObjectKey();
    return this.resource;
  }

  async upload(syncedFile: SyncedFile): Promise<string> {
    if (!this.config) {
      throw new Error('Missing S3 config');
    }
    const bridge = netcattyBridge.get();
    if (!bridge?.cloudSyncS3Upload) {
      throw new Error('S3 sync requires the Netcatty desktop sync bridge');
    }
    const result = await bridge.cloudSyncS3Upload(this.config, syncedFile);
    this.resource = result?.resourceId || this.getObjectKey();
    return this.resource;
  }

  async download(): Promise<SyncedFile | null> {
    if (!this.config) {
      throw new Error('Missing S3 config');
    }
    const bridge = netcattyBridge.get();
    if (!bridge?.cloudSyncS3Download) {
      throw new Error('S3 sync requires the Netcatty desktop sync bridge');
    }
    const result = await bridge.cloudSyncS3Download(this.config);
    return (result?.syncedFile ?? null) as SyncedFile | null;
  }

  async deleteSync(): Promise<void> {
    if (!this.config) {
      return;
    }
    const bridge = netcattyBridge.get();
    if (!bridge?.cloudSyncS3Delete) {
      throw new Error('S3 sync requires the Netcatty desktop sync bridge');
    }
    await bridge.cloudSyncS3Delete(this.config);
  }

  getTokens(): OAuthTokens | null {
    return null;
  }

  private getObjectKey(): string {
    if (!this.config) {
      throw new Error('Missing S3 config');
    }
    const prefix = (this.config.prefix || '').trim().replace(/^\/+|\/+$/g, '');
    if (!prefix) {
      return SYNC_CONSTANTS.SYNC_FILE_NAME;
    }
    return `${prefix}/${SYNC_CONSTANTS.SYNC_FILE_NAME}`;
  }

  private buildAccountInfo(config: S3Config | null): ProviderAccount | null {
    if (!config) return null;
    const name = `${config.bucket} (${config.region})`;
    const id = `${config.bucket}@${config.endpoint}`;
    return { id, name };
  }
}

export default S3Adapter;
