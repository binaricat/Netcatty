/**
 * OneDrive OAuth Adapter - PKCE Loopback Flow with MSAL
 * 
 * Uses MSAL-style Authorization Code Grant with PKCE.
 * Data is stored in the app's special folder.
 * 
 * Flow:
 * 1. Generate PKCE challenge
 * 2. Open browser with auth URL
 * 3. User authorizes, redirected to loopback
 * 4. Exchange code for tokens
 * 5. Use Graph API to manage sync file
 */

import {
  SYNC_CONSTANTS,
  ONEDRIVE_REAUTH_REQUIRED_MARKER,
  isOneDriveReauthRequiredMessage,
  type OAuthTokens,
  type ProviderAccount,
  type SyncedFile,
  type PKCEChallenge,
} from '../../../domain/sync';
import { netcattyBridge } from '../netcattyBridge';
import { arrayBufferToBase64, generateRandomBytes } from '../EncryptionService';

// ============================================================================
// Types
// ============================================================================

export interface OneDriveUserInfo {
  id: string;
  displayName: string;
  mail?: string;
  userPrincipalName: string;
}

export interface DriveItem {
  id: string;
  name: string;
  lastModifiedDateTime: string;
  size?: number;
  '@microsoft.graph.downloadUrl'?: string;
}

const ONEDRIVE_SCOPES = [
  'https://graph.microsoft.com/Files.ReadWrite.AppFolder',
  'https://graph.microsoft.com/User.Read',
  'offline_access',
];

const ONEDRIVE_SCOPE = ONEDRIVE_SCOPES.join(' ');

/**
 * Raised when the OneDrive refresh token can no longer be exchanged for a new
 * access token (expired / revoked / consent withdrawn). The user must
 * re-authorize; silent refresh cannot recover. CloudSyncManager detects this to
 * surface a clear "reconnect" state instead of a raw error.
 *
 * The message always carries ONEDRIVE_REAUTH_REQUIRED_MARKER so the condition is
 * still detectable after the error is re-wrapped (e.g. `new Error(String(err))`)
 * as it bubbles through the provider-agnostic sync pipeline.
 */
export class OneDriveReauthRequiredError extends Error {
  constructor(message = 'OneDrive session expired, please reconnect.') {
    super(
      isOneDriveReauthRequiredMessage(message)
        ? message
        : `${ONEDRIVE_REAUTH_REQUIRED_MARKER}: ${message}`
    );
    this.name = 'OneDriveReauthRequiredError';
  }
}

export const isOneDriveReauthRequiredError = (error: unknown): boolean => {
  if (error instanceof OneDriveReauthRequiredError) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return isOneDriveReauthRequiredMessage(message);
};

const isUnauthorizedError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return message.includes(' 401') ||
    message.includes('401 -') ||
    lower.includes('unauthenticated') ||
    lower.includes('invalidauthenticationtoken');
};

// ============================================================================
// PKCE Utilities
// ============================================================================

/**
 * Base64 URL encoding (no padding, URL-safe chars)
 */
const base64UrlEncode = (bytes: Uint8Array): string => {
  const base64 = arrayBufferToBase64(bytes);
  return base64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
};

/**
 * Generate a cryptographically random code verifier
 */
const generateCodeVerifier = (): string => {
  const bytes = generateRandomBytes(32);
  return base64UrlEncode(bytes);
};

/**
 * Generate code challenge from verifier (S256)
 */
const generateCodeChallenge = async (verifier: string): Promise<string> => {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
};

/**
 * Generate PKCE challenge
 */
export const generatePKCEChallenge = async (): Promise<PKCEChallenge> => {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = base64UrlEncode(generateRandomBytes(16));

  return {
    codeVerifier,
    codeChallenge,
    state,
  };
};

// ============================================================================
// OAuth Flow
// ============================================================================

/**
 * Build authorization URL for OneDrive OAuth
 */
export const buildAuthUrl = async (
  redirectUri: string
): Promise<{ url: string; pkce: PKCEChallenge }> => {
  const pkce = await generatePKCEChallenge();

  const params = new URLSearchParams({
    client_id: SYNC_CONSTANTS.ONEDRIVE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: ONEDRIVE_SCOPE,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: 'S256',
    state: pkce.state,
    response_mode: 'query',
    prompt: 'consent',
  });

  return {
    url: `${SYNC_CONSTANTS.ONEDRIVE_AUTH_URL}?${params.toString()}`,
    pkce,
  };
};

/**
 * Exchange authorization code for tokens
 */
export const exchangeCodeForTokens = async (
  code: string,
  codeVerifier: string,
  redirectUri: string
): Promise<OAuthTokens> => {
  const bridge = netcattyBridge.get();
  if (bridge?.onedriveExchangeCodeForTokens) {
    return bridge.onedriveExchangeCodeForTokens({
      clientId: SYNC_CONSTANTS.ONEDRIVE_CLIENT_ID,
      code,
      codeVerifier,
      redirectUri,
      scope: ONEDRIVE_SCOPE,
    });
  }
  const response = await fetch(SYNC_CONSTANTS.ONEDRIVE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: SYNC_CONSTANTS.ONEDRIVE_CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      scope: ONEDRIVE_SCOPE,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Token exchange failed: ${error.error_description || error.error}`);
  }

  const data = await response.json();

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    tokenType: data.token_type,
    scope: data.scope,
  };
};

/**
 * Refresh access token
 */
export const refreshAccessToken = async (refreshToken: string): Promise<OAuthTokens> => {
  const bridge = netcattyBridge.get();
  if (bridge?.onedriveRefreshAccessToken) {
    return bridge.onedriveRefreshAccessToken({
      clientId: SYNC_CONSTANTS.ONEDRIVE_CLIENT_ID,
      refreshToken,
      scope: ONEDRIVE_SCOPE,
    });
  }
  const response = await fetch(SYNC_CONSTANTS.ONEDRIVE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: SYNC_CONSTANTS.ONEDRIVE_CLIENT_ID,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: ONEDRIVE_SCOPE,
    }),
  });

  if (!response.ok) {
    throw new Error('Failed to refresh token');
  }

  const data = await response.json();

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    tokenType: data.token_type,
    scope: data.scope,
  };
};

// ============================================================================
// User Info
// ============================================================================

/**
 * Get authenticated user info
 */
export const getUserInfo = async (accessToken: string): Promise<ProviderAccount> => {
  const bridge = netcattyBridge.get();
  if (bridge?.onedriveGetUserInfo) {
    const user = await bridge.onedriveGetUserInfo({ accessToken });
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarDataUrl,
    };
  }
  const response = await fetch(`${SYNC_CONSTANTS.ONEDRIVE_GRAPH_API}/me`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error('Failed to get user info');
  }

  const user: OneDriveUserInfo = await response.json();

  // Try to get profile photo
  let avatarUrl: string | undefined;
  try {
    const photoResponse = await fetch(
      `${SYNC_CONSTANTS.ONEDRIVE_GRAPH_API}/me/photo/$value`,
      {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      }
    );
    if (photoResponse.ok) {
      const blob = await photoResponse.blob();
      avatarUrl = URL.createObjectURL(blob);
    }
  } catch {
    // Photo not available
  }

  return {
    id: user.id,
    email: user.mail || user.userPrincipalName,
    name: user.displayName,
    avatarUrl,
  };
};

/**
 * Validate access token
 */
export const validateToken = async (accessToken: string): Promise<boolean> => {
  const bridge = netcattyBridge.get();
  if (bridge?.onedriveGetUserInfo) {
    try {
      await bridge.onedriveGetUserInfo({ accessToken });
      return true;
    } catch {
      return false;
    }
  }
  try {
    const response = await fetch(`${SYNC_CONSTANTS.ONEDRIVE_GRAPH_API}/me`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    return response.ok;
  } catch {
    return false;
  }
};

// ============================================================================
// OneDrive App Folder Operations
// ============================================================================

const APP_FOLDER_PATH = '/drive/special/approot';

// Eventual-consistency retry for OneDrive "not found" lookups. The Graph API
// can briefly 404 a file that was uploaded seconds ago from another device
// (most commonly when the other device is syncing through the OneDrive
// desktop client and the change has not yet reached Graph). Treating every
// 404 as authoritative "cloud is empty" lets a second device proceed to an
// empty-cloud upload path and overwrite real data (#779). We retry a small
// bounded number of times with short backoff to flush through that window.
const NOT_FOUND_RETRIES = 2;
const NOT_FOUND_BACKOFF_MS = 1500;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function retryOnNotFound<T>(
  fetchOnce: () => Promise<T | null>,
): Promise<T | null> {
  let result = await fetchOnce();
  for (let attempt = 1; attempt <= NOT_FOUND_RETRIES && result === null; attempt++) {
    await sleep(NOT_FOUND_BACKOFF_MS * attempt);
    result = await fetchOnce();
  }
  return result;
}

/**
 * Ensure app folder exists and find sync file
 */
export const findSyncFile = async (accessToken: string): Promise<string | null> => {
  const fetchOnce = async (): Promise<string | null> => {
    const bridge = netcattyBridge.get();
    if (bridge?.onedriveFindSyncFile) {
      const result = await bridge.onedriveFindSyncFile({
        accessToken,
        fileName: SYNC_CONSTANTS.SYNC_FILE_NAME,
      });
      return result.fileId || null;
    }
    try {
      const response = await fetch(
        `${SYNC_CONSTANTS.ONEDRIVE_GRAPH_API}/me${APP_FOLDER_PATH}:/${SYNC_CONSTANTS.SYNC_FILE_NAME}`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
          },
        }
      );

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new Error('Failed to find sync file');
      }

      const item: DriveItem = await response.json();
      return item.id;
    } catch {
      return null;
    }
  };

  return retryOnNotFound(fetchOnce);
};

/**
 * Create or update sync file in app folder
 */
export const uploadSyncFile = async (
  accessToken: string,
  syncedFile: SyncedFile
): Promise<string> => {
  const bridge = netcattyBridge.get();
  if (bridge?.onedriveUploadSyncFile) {
    const result = await bridge.onedriveUploadSyncFile({
      accessToken,
      fileName: SYNC_CONSTANTS.SYNC_FILE_NAME,
      syncedFile,
    });
    if (!result.fileId) {
      throw new Error('Failed to upload sync file');
    }
    return result.fileId;
  }
  const content = JSON.stringify(syncedFile, null, 2);

  const response = await fetch(
    `${SYNC_CONSTANTS.ONEDRIVE_GRAPH_API}/me${APP_FOLDER_PATH}:/${SYNC_CONSTANTS.SYNC_FILE_NAME}:/content`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: content,
    }
  );

  if (!response.ok) {
    throw new Error('Failed to upload sync file');
  }

  const item: DriveItem = await response.json();
  return item.id;
};

/**
 * Download sync file
 */
export const downloadSyncFile = async (
  accessToken: string,
  fileId?: string
): Promise<SyncedFile | null> => {
  const fetchOnce = async (): Promise<SyncedFile | null> => {
    const bridge = netcattyBridge.get();
    if (bridge?.onedriveDownloadSyncFile) {
      const result = await bridge.onedriveDownloadSyncFile({
        accessToken,
        fileId,
        fileName: SYNC_CONSTANTS.SYNC_FILE_NAME,
      });
      return (result.syncedFile as SyncedFile | null) || null;
    }
    try {
      // Can use either file ID or path
      const url = fileId
        ? `${SYNC_CONSTANTS.ONEDRIVE_GRAPH_API}/me/drive/items/${fileId}/content`
        : `${SYNC_CONSTANTS.ONEDRIVE_GRAPH_API}/me${APP_FOLDER_PATH}:/${SYNC_CONSTANTS.SYNC_FILE_NAME}:/content`;

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      });

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new Error('Failed to download sync file');
      }

      return response.json();
    } catch {
      return null;
    }
  };

  return retryOnNotFound(fetchOnce);
};

/**
 * Delete sync file
 */
export const deleteSyncFile = async (
  accessToken: string,
  fileId: string
): Promise<void> => {
  const bridge = netcattyBridge.get();
  if (bridge?.onedriveDeleteSyncFile) {
    await bridge.onedriveDeleteSyncFile({ accessToken, fileId });
    return;
  }
  const response = await fetch(
    `${SYNC_CONSTANTS.ONEDRIVE_GRAPH_API}/me/drive/items/${fileId}`,
    {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok && response.status !== 404) {
    throw new Error('Failed to delete sync file');
  }
};

// ============================================================================
// OneDrive Adapter Class
// ============================================================================

export class OneDriveAdapter {
  private tokens: OAuthTokens | null = null;
  private fileId: string | null = null;
  private account: ProviderAccount | null = null;
  private pkceChallenge: PKCEChallenge | null = null;
  /**
   * Invoked whenever the access token is silently refreshed. Lets the owner
   * (CloudSyncManager) persist the rotated tokens — Microsoft consumer refresh
   * tokens rotate on every refresh and invalidate the previous one, so without
   * persisting the new refresh token the stored one eventually goes stale and
   * forces the user to reconnect (#1189).
   */
  private onTokensRefreshed: ((tokens: OAuthTokens) => void) | null = null;

  constructor(tokens?: OAuthTokens, fileId?: string) {
    if (tokens) {
      this.tokens = tokens;
    }
    this.fileId = fileId || null;
  }

  /**
   * Register a callback that receives refreshed tokens so the caller can
   * persist them. Passing null removes the callback.
   */
  setOnTokensRefreshed(callback: ((tokens: OAuthTokens) => void) | null): void {
    this.onTokensRefreshed = callback;
  }

  /**
   * Refresh the access token using the supplied refresh token, store the
   * rotated tokens in-memory, and notify the persistence callback. Refresh
   * failures caused by a dead refresh token are normalized to
   * OneDriveReauthRequiredError so callers can prompt for reconnect.
   */
  private async refreshTokens(refreshToken: string): Promise<OAuthTokens> {
    let refreshed: OAuthTokens;
    try {
      refreshed = await refreshAccessToken(refreshToken);
    } catch (error) {
      if (isOneDriveReauthRequiredError(error)) {
        // Preserve the message (it carries the marker the bridge added) so
        // downstream layers can still detect this after any re-wrapping.
        throw new OneDriveReauthRequiredError(
          error instanceof Error ? error.message : String(error)
        );
      }
      throw error;
    }
    this.tokens = refreshed;
    try {
      this.onTokensRefreshed?.(refreshed);
    } catch {
      // Persistence is best-effort; a failed save must not abort the sync that
      // triggered the refresh — the fresh tokens still work for this session.
    }
    return refreshed;
  }

  get isAuthenticated(): boolean {
    return !!this.tokens?.accessToken;
  }

  get accountInfo(): ProviderAccount | null {
    return this.account;
  }

  get resourceId(): string | null {
    return this.fileId;
  }

  /**
   * Start OAuth flow - returns URL to open in browser
   */
  async startAuth(redirectUri: string): Promise<string> {
    const { url, pkce } = await buildAuthUrl(redirectUri);
    this.pkceChallenge = pkce;
    return url;
  }

  /**
   * Get PKCE state for verification
   */
  getPKCEState(): string | null {
    return this.pkceChallenge?.state || null;
  }

  /**
   * Complete authentication with authorization code
   */
  async completeAuth(code: string, redirectUri: string): Promise<OAuthTokens> {
    if (!this.pkceChallenge) {
      throw new Error('No PKCE challenge - start auth first');
    }

    this.tokens = await exchangeCodeForTokens(
      code,
      this.pkceChallenge.codeVerifier,
      redirectUri
    );
    this.pkceChallenge = null;

    this.account = await getUserInfo(this.tokens.accessToken);

    return this.tokens;
  }

  /**
   * Set tokens from storage
   */
  async setTokens(tokens: OAuthTokens): Promise<void> {
    this.tokens = tokens;

    // Refresh if expired
    if (tokens.expiresAt && Date.now() > tokens.expiresAt - 60000) {
      if (tokens.refreshToken) {
        this.tokens = await this.refreshTokens(tokens.refreshToken);
      } else {
        throw new OneDriveReauthRequiredError(
          'OneDrive session expired and no refresh token is available, please reconnect.'
        );
      }
    }

    if (await validateToken(this.tokens.accessToken)) {
      this.account = await getUserInfo(this.tokens.accessToken);
    } else {
      throw new Error('Token is invalid');
    }
  }

  /**
   * Ensure token is fresh
   */
  private async ensureValidToken(): Promise<string> {
    if (!this.tokens) {
      throw new Error('Not authenticated');
    }

    if (this.tokens.expiresAt && Date.now() > this.tokens.expiresAt - 60000) {
      if (this.tokens.refreshToken) {
        this.tokens = await this.refreshTokens(this.tokens.refreshToken);
      } else {
        throw new OneDriveReauthRequiredError(
          'OneDrive session expired and no refresh token is available, please reconnect.'
        );
      }
    }

    return this.tokens.accessToken;
  }

  private async runWithAuthRetry<T>(
    operation: (accessToken: string) => Promise<T>
  ): Promise<T> {
    const accessToken = await this.ensureValidToken();

    try {
      return await operation(accessToken);
    } catch (error) {
      if (isUnauthorizedError(error) && this.tokens?.refreshToken) {
        const refreshed = await this.refreshTokens(this.tokens.refreshToken);
        return await operation(refreshed.accessToken);
      }
      throw error;
    }
  }

  /**
   * Sign out
   */
  signOut(): void {
    this.tokens = null;
    this.fileId = null;
    this.account = null;
    this.pkceChallenge = null;
    this.onTokensRefreshed = null;
  }

  /**
   * Initialize or find sync file
   */
  async initializeSync(): Promise<string | null> {
    return this.runWithAuthRetry(async (accessToken) => {
      this.fileId = await findSyncFile(accessToken);
      return this.fileId;
    });
  }

  /**
   * Upload sync file
   */
  async upload(syncedFile: SyncedFile): Promise<string> {
    return this.runWithAuthRetry(async (accessToken) => {
      this.fileId = await uploadSyncFile(accessToken, syncedFile);
      return this.fileId;
    });
  }

  /**
   * Download sync file
   */
  async download(): Promise<SyncedFile | null> {
    return this.runWithAuthRetry(async (accessToken) => {
      if (!this.fileId) {
        this.fileId = await findSyncFile(accessToken);
      }
      return downloadSyncFile(accessToken, this.fileId || undefined);
    });
  }

  /**
   * Delete sync data
   */
  async deleteSync(): Promise<void> {
    if (!this.tokens || !this.fileId) {
      return;
    }

    await this.runWithAuthRetry(async (accessToken) => {
      await deleteSyncFile(accessToken, this.fileId as string);
      this.fileId = null;
    });
  }

  /**
   * Get tokens for storage
   */
  getTokens(): OAuthTokens | null {
    return this.tokens;
  }
}

export default OneDriveAdapter;
