/**
 * Google Drive OAuth Adapter - PKCE Loopback Flow
 * 
 * Uses Authorization Code Grant with PKCE (RFC 7636) and loopback redirect.
 * Data is stored in appDataFolder (hidden, app-specific folder).
 * 
 * Flow:
 * 1. Generate PKCE challenge
 * 2. Open browser with auth URL
 * 3. User authorizes, redirected to loopback
 * 4. Exchange code for tokens
 * 5. Use Drive API to manage sync file
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

export interface GoogleUserInfo {
  id: string;
  email: string;
  name: string;
  picture: string;
}

export interface DriveFile {
  id: string;
  name: string;
  modifiedTime: string;
  size?: string;
}

// ============================================================================
// PKCE Utilities
// ============================================================================

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
 * Build authorization URL for Google OAuth
 */
export const buildAuthUrl = async (
  redirectUri: string
): Promise<{ url: string; pkce: PKCEChallenge }> => {
  const pkce = await generatePKCEChallenge();

  const params = new URLSearchParams({
    client_id: SYNC_CONSTANTS.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email',
    code_challenge: pkce.codeChallenge,
    code_challenge_method: 'S256',
    state: pkce.state,
    access_type: 'offline',
    prompt: 'consent',
  });

  return {
    url: `${SYNC_CONSTANTS.GOOGLE_AUTH_URL}?${params.toString()}`,
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
  const response = await fetch(SYNC_CONSTANTS.GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: SYNC_CONSTANTS.GOOGLE_CLIENT_ID,
      client_secret: SYNC_CONSTANTS.GOOGLE_CLIENT_SECRET,
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
  const response = await fetch(SYNC_CONSTANTS.GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: SYNC_CONSTANTS.GOOGLE_CLIENT_ID,
      client_secret: SYNC_CONSTANTS.GOOGLE_CLIENT_SECRET,
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
    refreshToken: refreshToken, // Keep existing refresh token
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
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error('Failed to get user info');
  }

  const user: GoogleUserInfo = await response.json();

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.picture,
  };
};

/**
 * Validate access token
 */
export const validateToken = async (accessToken: string): Promise<boolean> => {
  try {
    const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    return response.ok;
  } catch {
    return false;
  }
};

// ============================================================================
// Drive Operations (appDataFolder)
// ============================================================================

/**
 * Find sync file in appDataFolder
 */
export const findSyncFile = async (accessToken: string): Promise<string | null> => {
  const params = new URLSearchParams({
    spaces: 'appDataFolder',
    q: `name = '${SYNC_CONSTANTS.SYNC_FILE_NAME}'`,
    fields: 'files(id, name, modifiedTime)',
  });

  const response = await fetch(
    `${SYNC_CONSTANTS.GOOGLE_DRIVE_API}/files?${params.toString()}`,
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    console.error('Drive API error:', response.status, errorData);
    throw new Error(`Failed to search Drive: ${errorData.error?.message || response.status}`);
  }

  const data = await response.json();
  return data.files?.[0]?.id || null;
};

/**
 * Create sync file in appDataFolder
 */
export const createSyncFile = async (
  accessToken: string,
  syncedFile: SyncedFile
): Promise<string> => {
  const metadata = {
    name: SYNC_CONSTANTS.SYNC_FILE_NAME,
    parents: ['appDataFolder'],
  };

  const form = new FormData();
  form.append(
    'metadata',
    new Blob([JSON.stringify(metadata)], { type: 'application/json' })
  );
  form.append(
    'file',
    new Blob([JSON.stringify(syncedFile, null, 2)], { type: 'application/json' })
  );

  const response = await fetch(
    `${SYNC_CONSTANTS.GOOGLE_DRIVE_API.replace('/v3', '/upload/v3')}/files?uploadType=multipart`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
      body: form,
    }
  );

  if (!response.ok) {
    throw new Error('Failed to create file');
  }

  const data = await response.json();
  return data.id;
};

/**
 * Update sync file
 */
export const updateSyncFile = async (
  accessToken: string,
  fileId: string,
  syncedFile: SyncedFile
): Promise<void> => {
  const response = await fetch(
    `${SYNC_CONSTANTS.GOOGLE_DRIVE_API.replace('/v3', '/upload/v3')}/files/${fileId}?uploadType=media`,
    {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(syncedFile, null, 2),
    }
  );

  if (!response.ok) {
    throw new Error('Failed to update file');
  }
};

/**
 * Download sync file
 */
export const downloadSyncFile = async (
  accessToken: string,
  fileId: string
): Promise<SyncedFile | null> => {
  const response = await fetch(
    `${SYNC_CONSTANTS.GOOGLE_DRIVE_API}/files/${fileId}?alt=media`,
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error('Failed to download file');
  }

  return response.json();
};

/**
 * Delete sync file
 */
export const deleteSyncFile = async (
  accessToken: string,
  fileId: string
): Promise<void> => {
  const response = await fetch(
    `${SYNC_CONSTANTS.GOOGLE_DRIVE_API}/files/${fileId}`,
    {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok && response.status !== 404) {
    throw new Error('Failed to delete file');
  }
};

// ============================================================================
// Google Drive Adapter Class
// ============================================================================

export class GoogleDriveAdapter {
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

    if (this.fileId) {
      await updateSyncFile(accessToken, this.fileId, syncedFile);
      return this.fileId;
    } else {
      this.fileId = await createSyncFile(accessToken, syncedFile);
      return this.fileId;
    }
  }

  /**
   * Download sync file
   */
  async download(): Promise<SyncedFile | null> {
    const accessToken = await this.ensureValidToken();

    if (!this.fileId) {
      this.fileId = await findSyncFile(accessToken);
    }

    if (!this.fileId) {
      return null;
    }

    return downloadSyncFile(accessToken, this.fileId);
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

export default GoogleDriveAdapter;
