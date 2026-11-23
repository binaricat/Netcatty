/**
 * WebDAV Adapter - delegates to Electron main-process cloudSyncBridge.
 */

import {
  SYNC_CONSTANTS,
  type WebDAVConfig,
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

const ensureLeadingSlash = (value: string): string =>
  value.startsWith('/') ? value : `/${value}`;

export class WebDAVAdapter {
  private config: WebDAVConfig | null;
  private resource: string | null;
  private account: ProviderAccount | null;

  constructor(config?: WebDAVConfig, resourceId?: string) {
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
    return this.withWebdavErrorContext('initialize', async () => {
      if (!this.config) {
        throw new Error('Missing WebDAV config');
      }
      const bridge = netcattyBridge.get();
      if (!bridge?.cloudSyncWebdavInitialize) {
        throw new Error('WebDAV sync requires the Netcatty desktop sync bridge');
      }
      const result = await bridge.cloudSyncWebdavInitialize(this.config);
      this.resource = result?.resourceId || this.getSyncPath();
      return this.resource;
    });
  }

  async upload(syncedFile: SyncedFile): Promise<string> {
    return this.withWebdavErrorContext('upload', async () => {
      if (!this.config) {
        throw new Error('Missing WebDAV config');
      }
      const bridge = netcattyBridge.get();
      if (!bridge?.cloudSyncWebdavUpload) {
        throw new Error('WebDAV sync requires the Netcatty desktop sync bridge');
      }
      const result = await bridge.cloudSyncWebdavUpload(this.config, syncedFile);
      this.resource = result?.resourceId || this.getSyncPath();
      return this.resource;
    });
  }

  async download(): Promise<SyncedFile | null> {
    return this.withWebdavErrorContext('download', async () => {
      if (!this.config) {
        throw new Error('Missing WebDAV config');
      }
      const bridge = netcattyBridge.get();
      if (!bridge?.cloudSyncWebdavDownload) {
        throw new Error('WebDAV sync requires the Netcatty desktop sync bridge');
      }
      const result = await bridge.cloudSyncWebdavDownload(this.config);
      return (result?.syncedFile ?? null) as SyncedFile | null;
    });
  }

  async deleteSync(): Promise<void> {
    return this.withWebdavErrorContext('delete', async () => {
      if (!this.config) {
        throw new Error('Missing WebDAV config');
      }
      const bridge = netcattyBridge.get();
      if (!bridge?.cloudSyncWebdavDelete) {
        throw new Error('WebDAV sync requires the Netcatty desktop sync bridge');
      }
      await bridge.cloudSyncWebdavDelete(this.config);
    });
  }

  getTokens(): OAuthTokens | null {
    return null;
  }

  private async withWebdavErrorContext<T>(
    operation: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw this.buildWebdavError(operation, error);
    }
  }

  private buildWebdavError(operation: string, error: unknown): Error {
    const baseMessage = error instanceof Error ? error.message : String(error);
    const details: Record<string, string | number | boolean | null | undefined> = {
      operation,
    };
    const raw = error as {
      status?: number;
      statusText?: string;
      url?: string;
      method?: string;
      code?: string;
      response?: {
        status?: number;
        statusText?: string;
        url?: string;
      };
      cause?: unknown;
    };

    if (raw?.status) details.status = raw.status;
    if (raw?.statusText) details.statusText = raw.statusText;
    if (raw?.url) details.url = raw.url;
    if (raw?.method) details.method = raw.method;
    if (raw?.code) details.code = raw.code;
    if (raw?.response?.status) details.status = raw.response.status;
    if (raw?.response?.statusText) details.statusText = raw.response.statusText;
    if (raw?.response?.url) details.url = raw.response.url;
    if (raw?.cause && typeof raw.cause === 'object') {
      Object.assign(details, raw.cause as Record<string, unknown>);
      details.operation = operation;
      const cause = raw.cause as { code?: string };
      if (cause?.code) details.causeCode = cause.code;
    } else if (raw?.cause) {
      details.cause = String(raw.cause);
    }

    const err = new Error(`WebDAV ${operation} failed: ${baseMessage}`);
    (err as Error & { cause?: unknown }).cause = details;
    return err;
  }

  private getSyncPath(): string {
    return ensureLeadingSlash(SYNC_CONSTANTS.SYNC_FILE_NAME);
  }

  private buildAccountInfo(config: WebDAVConfig | null): ProviderAccount | null {
    if (!config) return null;
    try {
      const url = new URL(config.endpoint);
      const host = url.host;
      const name = config.username ? `${config.username}@${host}` : host;
      return { id: host, name };
    } catch {
      return { id: config.endpoint, name: config.endpoint };
    }
  }
}

export default WebDAVAdapter;
