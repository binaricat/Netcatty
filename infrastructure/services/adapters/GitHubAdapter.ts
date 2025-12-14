/**
 * GitHub OAuth Adapter - Device Flow Implementation
 * 
 * Uses Device Authorization Grant (RFC 8628) which doesn't require a client secret.
 * Perfect for desktop apps where the secret cannot be securely stored.
 * 
 * Flow:
 * 1. Request device code from GitHub
 * 2. User opens browser and enters the code
 * 3. Poll for access token until user completes auth
 * 4. Use Gist API for sync file storage
 */

import {
  SYNC_CONSTANTS,
  type OAuthTokens,
  type ProviderAccount,
  type SyncedFile,
  type GitHubDeviceCodeResponse,
} from '../../../domain/sync';

// ============================================================================
// Types
// ============================================================================

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
}

export interface GitHubGist {
  id: string;
  description: string;
  files: Record<string, { content: string; filename: string }>;
  created_at: string;
  updated_at: string;
  history?: Array<{
    version: string;
    committed_at: string;
  }>;
}

export interface DeviceFlowState {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  interval: number;
}

// ============================================================================
// Device Flow Authentication
// ============================================================================

/**
 * Start GitHub Device Flow authentication
 * Returns codes for user to enter in browser
 */
export const startDeviceFlow = async (): Promise<DeviceFlowState> => {
  const response = await fetch(SYNC_CONSTANTS.GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: SYNC_CONSTANTS.GITHUB_CLIENT_ID,
      scope: 'gist read:user',
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub device flow initiation failed: ${response.statusText}`);
  }

  const data: GitHubDeviceCodeResponse = await response.json();

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresAt: Date.now() + data.expires_in * 1000,
    interval: data.interval,
  };
};

/**
 * Poll for access token after user authorizes
 */
export const pollForToken = async (
  deviceCode: string,
  interval: number,
  expiresAt: number,
  onPending?: () => void
): Promise<OAuthTokens | null> => {
  const pollInterval = Math.max(interval, 5) * 1000; // Minimum 5 seconds

  while (Date.now() < expiresAt) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));

    const response = await fetch(SYNC_CONSTANTS.GITHUB_ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: SYNC_CONSTANTS.GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    const data = await response.json();

    if (data.access_token) {
      return {
        accessToken: data.access_token,
        tokenType: data.token_type || 'bearer',
        scope: data.scope,
      };
    }

    if (data.error === 'authorization_pending') {
      onPending?.();
      continue;
    }

    if (data.error === 'slow_down') {
      // Increase interval as requested
      await new Promise(resolve => setTimeout(resolve, 5000));
      continue;
    }

    if (data.error === 'expired_token') {
      throw new Error('Device code expired. Please try again.');
    }

    if (data.error === 'access_denied') {
      throw new Error('User denied authorization.');
    }

    if (data.error) {
      throw new Error(`GitHub auth error: ${data.error_description || data.error}`);
    }
  }

  throw new Error('Device code expired. Please try again.');
};

// ============================================================================
// User Info
// ============================================================================

/**
 * Get authenticated user info
 */
export const getUserInfo = async (accessToken: string): Promise<ProviderAccount> => {
  const response = await fetch(`${SYNC_CONSTANTS.GITHUB_API_BASE}/user`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/vnd.github.v3+json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get user info: ${response.statusText}`);
  }

  const user: GitHubUser = await response.json();

  return {
    id: String(user.id),
    email: user.email || undefined,
    name: user.name || user.login,
    avatarUrl: user.avatar_url,
  };
};

/**
 * Validate access token is still valid
 */
export const validateToken = async (accessToken: string): Promise<boolean> => {
  try {
    const response = await fetch(`${SYNC_CONSTANTS.GITHUB_API_BASE}/user`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/vnd.github.v3+json',
      },
    });
    return response.ok;
  } catch {
    return false;
  }
};

// ============================================================================
// Gist Operations
// ============================================================================

/**
 * Find existing Netcatty sync gist
 */
export const findSyncGist = async (accessToken: string): Promise<string | null> => {
  // List user's gists and find ours
  const response = await fetch(`${SYNC_CONSTANTS.GITHUB_API_BASE}/gists?per_page=100`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/vnd.github.v3+json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to list gists: ${response.statusText}`);
  }

  const gists: GitHubGist[] = await response.json();
  
  const syncGist = gists.find(g => 
    g.description === SYNC_CONSTANTS.GIST_DESCRIPTION &&
    g.files[SYNC_CONSTANTS.SYNC_FILE_NAME]
  );

  return syncGist?.id || null;
};

/**
 * Create a new sync gist
 */
export const createSyncGist = async (
  accessToken: string,
  syncedFile: SyncedFile
): Promise<string> => {
  const response = await fetch(`${SYNC_CONSTANTS.GITHUB_API_BASE}/gists`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      description: SYNC_CONSTANTS.GIST_DESCRIPTION,
      public: false,
      files: {
        [SYNC_CONSTANTS.SYNC_FILE_NAME]: {
          content: JSON.stringify(syncedFile, null, 2),
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create gist: ${response.statusText}`);
  }

  const gist: GitHubGist = await response.json();
  return gist.id;
};

/**
 * Update existing sync gist
 */
export const updateSyncGist = async (
  accessToken: string,
  gistId: string,
  syncedFile: SyncedFile
): Promise<void> => {
  const response = await fetch(`${SYNC_CONSTANTS.GITHUB_API_BASE}/gists/${gistId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: {
        [SYNC_CONSTANTS.SYNC_FILE_NAME]: {
          content: JSON.stringify(syncedFile, null, 2),
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to update gist: ${response.statusText}`);
  }
};

/**
 * Download sync file from gist
 */
export const downloadSyncGist = async (
  accessToken: string,
  gistId: string
): Promise<SyncedFile | null> => {
  const response = await fetch(`${SYNC_CONSTANTS.GITHUB_API_BASE}/gists/${gistId}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/vnd.github.v3+json',
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error(`Failed to download gist: ${response.statusText}`);
  }

  const gist: GitHubGist = await response.json();
  const file = gist.files[SYNC_CONSTANTS.SYNC_FILE_NAME];

  if (!file?.content) {
    return null;
  }

  return JSON.parse(file.content) as SyncedFile;
};

/**
 * Delete sync gist
 */
export const deleteSyncGist = async (
  accessToken: string,
  gistId: string
): Promise<void> => {
  const response = await fetch(`${SYNC_CONSTANTS.GITHUB_API_BASE}/gists/${gistId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/vnd.github.v3+json',
    },
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`Failed to delete gist: ${response.statusText}`);
  }
};

/**
 * Get gist revision history
 */
export const getGistHistory = async (
  accessToken: string,
  gistId: string
): Promise<Array<{ version: string; date: Date }>> => {
  const response = await fetch(`${SYNC_CONSTANTS.GITHUB_API_BASE}/gists/${gistId}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/vnd.github.v3+json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get gist history: ${response.statusText}`);
  }

  const gist: GitHubGist = await response.json();

  return (gist.history || []).map(h => ({
    version: h.version,
    date: new Date(h.committed_at),
  }));
};

// ============================================================================
// GitHub Adapter Class
// ============================================================================

export class GitHubAdapter {
  private accessToken: string | null = null;
  private gistId: string | null = null;
  private account: ProviderAccount | null = null;

  constructor(tokens?: OAuthTokens, gistId?: string) {
    if (tokens) {
      this.accessToken = tokens.accessToken;
    }
    this.gistId = gistId || null;
  }

  get isAuthenticated(): boolean {
    return !!this.accessToken;
  }

  get accountInfo(): ProviderAccount | null {
    return this.account;
  }

  get resourceId(): string | null {
    return this.gistId;
  }

  /**
   * Start Device Flow authentication
   */
  async startAuth(): Promise<DeviceFlowState> {
    return startDeviceFlow();
  }

  /**
   * Complete authentication by polling for token
   */
  async completeAuth(
    deviceCode: string,
    interval: number,
    expiresAt: number,
    onPending?: () => void
  ): Promise<OAuthTokens> {
    const tokens = await pollForToken(deviceCode, interval, expiresAt, onPending);
    if (!tokens) {
      throw new Error('Failed to obtain access token');
    }

    this.accessToken = tokens.accessToken;
    this.account = await getUserInfo(tokens.accessToken);

    return tokens;
  }

  /**
   * Set tokens from storage
   */
  async setTokens(tokens: OAuthTokens): Promise<void> {
    this.accessToken = tokens.accessToken;
    
    if (await validateToken(tokens.accessToken)) {
      this.account = await getUserInfo(tokens.accessToken);
    } else {
      throw new Error('Token is invalid or expired');
    }
  }

  /**
   * Sign out
   */
  signOut(): void {
    this.accessToken = null;
    this.gistId = null;
    this.account = null;
  }

  /**
   * Initialize or find sync gist
   */
  async initializeSync(): Promise<string | null> {
    if (!this.accessToken) {
      throw new Error('Not authenticated');
    }

    this.gistId = await findSyncGist(this.accessToken);
    return this.gistId;
  }

  /**
   * Upload sync file
   */
  async upload(syncedFile: SyncedFile): Promise<string> {
    if (!this.accessToken) {
      throw new Error('Not authenticated');
    }

    if (this.gistId) {
      await updateSyncGist(this.accessToken, this.gistId, syncedFile);
      return this.gistId;
    } else {
      this.gistId = await createSyncGist(this.accessToken, syncedFile);
      return this.gistId;
    }
  }

  /**
   * Download sync file
   */
  async download(): Promise<SyncedFile | null> {
    if (!this.accessToken) {
      throw new Error('Not authenticated');
    }

    if (!this.gistId) {
      this.gistId = await findSyncGist(this.accessToken);
    }

    if (!this.gistId) {
      return null;
    }

    return downloadSyncGist(this.accessToken, this.gistId);
  }

  /**
   * Delete sync data
   */
  async deleteSync(): Promise<void> {
    if (!this.accessToken || !this.gistId) {
      return;
    }

    await deleteSyncGist(this.accessToken, this.gistId);
    this.gistId = null;
  }

  /**
   * Get tokens for storage
   */
  getTokens(): OAuthTokens | null {
    if (!this.accessToken) return null;
    return {
      accessToken: this.accessToken,
      tokenType: 'bearer',
    };
  }
}

export default GitHubAdapter;
