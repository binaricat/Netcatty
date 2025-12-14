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
  type OAuthTokens,
  type ProviderAccount,
  type SyncedFile,
  type PKCEChallenge,
} from '../../../domain/sync';
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
    scope: 'Files.ReadWrite.AppFolder User.Read offline_access',
    code_challenge: pkce.codeChallenge,
    code_challenge_method: 'S256',
    state: pkce.state,
    response_mode: 'query',
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
  const response = await fetch(SYNC_CONSTANTS.ONEDRIVE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: SYNC_CONSTANTS.ONEDRIVE_CLIENT_ID,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
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

/**
 * Ensure app folder exists and find sync file
 */
export const findSyncFile = async (accessToken: string): Promise<string | null> => {
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

/**
 * Create or update sync file in app folder
 */
export const uploadSyncFile = async (
  accessToken: string,
  syncedFile: SyncedFile
): Promise<string> => {
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

/**
 * Delete sync file
 */
export const deleteSyncFile = async (
  accessToken: string,
  fileId: string
): Promise<void> => {
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

  constructor(tokens?: OAuthTokens, fileId?: string) {
    if (tokens) {
      this.tokens = tokens;
    }
    this.fileId = fileId || null;
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
        this.tokens = await refreshAccessToken(tokens.refreshToken);
      } else {
        throw new Error('Token expired and no refresh token');
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
        this.tokens = await refreshAccessToken(this.tokens.refreshToken);
      } else {
        throw new Error('Token expired');
      }
    }

    return this.tokens.accessToken;
  }

  /**
   * Sign out
   */
  signOut(): void {
    this.tokens = null;
    this.fileId = null;
    this.account = null;
    this.pkceChallenge = null;
  }

  /**
   * Initialize or find sync file
   */
  async initializeSync(): Promise<string | null> {
    const accessToken = await this.ensureValidToken();
    this.fileId = await findSyncFile(accessToken);
    return this.fileId;
  }

  /**
   * Upload sync file
   */
  async upload(syncedFile: SyncedFile): Promise<string> {
    const accessToken = await this.ensureValidToken();
    this.fileId = await uploadSyncFile(accessToken, syncedFile);
    return this.fileId;
  }

  /**
   * Download sync file
   */
  async download(): Promise<SyncedFile | null> {
    const accessToken = await this.ensureValidToken();

    if (!this.fileId) {
      this.fileId = await findSyncFile(accessToken);
    }

    return downloadSyncFile(accessToken, this.fileId || undefined);
  }

  /**
   * Delete sync data
   */
  async deleteSync(): Promise<void> {
    if (!this.tokens || !this.fileId) {
      return;
    }

    const accessToken = await this.ensureValidToken();
    await deleteSyncFile(accessToken, this.fileId);
    this.fileId = null;
  }

  /**
   * Get tokens for storage
   */
  getTokens(): OAuthTokens | null {
    return this.tokens;
  }
}

export default OneDriveAdapter;
