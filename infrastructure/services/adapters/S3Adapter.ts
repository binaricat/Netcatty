/**
 * S3 Compatible Adapter - AWS SDK v3
 */

import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
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

const toBodyString = async (body: unknown): Promise<string> => {
  if (!body) return '';
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  if (body instanceof Blob) {
    return await body.text();
  }
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    return await new Response(body).text();
  }
  if (typeof (body as { transformToString?: () => Promise<string> }).transformToString === 'function') {
    return await (body as { transformToString: () => Promise<string> }).transformToString();
  }
  throw new Error('Unsupported S3 response body');
};

export class S3Adapter {
  private config: S3Config | null;
  private resource: string | null;
  private account: ProviderAccount | null;
  private client: S3Client | null;

  constructor(config?: S3Config, resourceId?: string) {
    this.config = config
      ? { ...config, endpoint: normalizeEndpoint(config.endpoint) }
      : null;
    this.resource = resourceId || null;
    this.account = this.buildAccountInfo(this.config);
    this.client = this.config ? this.createClient(this.config) : null;
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
    this.client = null;
  }

  async initializeSync(): Promise<string | null> {
    if (!this.config) {
      throw new Error('Missing S3 config');
    }
    const bridge = netcattyBridge.get();
    if (bridge?.cloudSyncS3Initialize) {
      const result = await bridge.cloudSyncS3Initialize(this.config);
      this.resource = result?.resourceId || this.getObjectKey();
      return this.resource;
    }
    const client = this.getClient();
    try {
      await client.send(new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: this.getObjectKey(),
      }));
    } catch (error) {
      if (this.isNotFound(error)) {
        // File doesn't exist yet.
      } else if (this.isAccessDenied(error)) {
        throw new Error('S3 access denied');
      } else {
        throw error;
      }
    }
    this.resource = this.getObjectKey();
    return this.resource;
  }

  async upload(syncedFile: SyncedFile): Promise<string> {
    if (!this.config) {
      throw new Error('Missing S3 config');
    }
    const bridge = netcattyBridge.get();
    if (bridge?.cloudSyncS3Upload) {
      const result = await bridge.cloudSyncS3Upload(this.config, syncedFile);
      this.resource = result?.resourceId || this.getObjectKey();
      return this.resource;
    }
    const body = JSON.stringify(syncedFile);
    const client = this.getClient();
    await client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: this.getObjectKey(),
      Body: body,
      ContentType: 'application/json',
    }));
    this.resource = this.getObjectKey();
    return this.resource;
  }

  async download(): Promise<SyncedFile | null> {
    if (!this.config) {
      throw new Error('Missing S3 config');
    }
    const bridge = netcattyBridge.get();
    if (bridge?.cloudSyncS3Download) {
      const result = await bridge.cloudSyncS3Download(this.config);
      return (result?.syncedFile ?? null) as SyncedFile | null;
    }
    const client = this.getClient();
    try {
      const response = await client.send(new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: this.getObjectKey(),
      }));
      const text = await toBodyString(response.Body);
      if (!text) return null;
      return JSON.parse(text) as SyncedFile;
    } catch (error) {
      if (this.isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async deleteSync(): Promise<void> {
    if (!this.config) {
      return;
    }
    const bridge = netcattyBridge.get();
    if (bridge?.cloudSyncS3Delete) {
      await bridge.cloudSyncS3Delete(this.config);
      return;
    }
    const client = this.getClient();
    try {
      await client.send(new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: this.getObjectKey(),
      }));
    } catch (error) {
      if (this.isNotFound(error)) {
        return;
      }
      throw error;
    }
  }

  getTokens(): OAuthTokens | null {
    return null;
  }

  private getClient(): S3Client {
    if (!this.config || !this.client) {
      if (this.config?.allowInsecure) {
        throw new Error('S3 insecure connections require the Netcatty desktop sync bridge');
      }
      throw new Error('Missing S3 config');
    }
    return this.client;
  }

  private createClient(config: S3Config): S3Client | null {
    const clientConfig: ConstructorParameters<typeof S3Client>[0] = {
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle ?? true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        sessionToken: config.sessionToken,
      },
    };

    if (
      config.allowInsecure
      && typeof globalThis.process !== 'undefined'
      && typeof require === 'function'
    ) {
      const https = require('https');
      const { NodeHttpHandler } = require('@smithy/node-http-handler');
      clientConfig.requestHandler = new NodeHttpHandler({
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      });
    } else if (config.allowInsecure) {
      return null;
    }

    return new S3Client(clientConfig);
  }

  private isNotFound(error: unknown): boolean {
    return Boolean((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404);
  }

  private isAccessDenied(error: unknown): boolean {
    return Boolean((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 403);
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
