/**
 * Shared PKCE + OAuth token lifecycle base for loopback OAuth CloudSync adapters
 * (GoogleDriveAdapter and OneDriveAdapter).
 */

import type {
  OAuthTokens,
  PKCEChallenge,
  ProviderAccount,
} from '../../../domain/sync';
import { arrayBufferToBase64, generateRandomBytes } from '../EncryptionService';

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
 * Generate PKCE challenge (RFC 7636 S256)
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

export abstract class OAuthPKCEAdapterBase {
  protected tokens: OAuthTokens | null = null;
  protected fileId: string | null = null;
  protected account: ProviderAccount | null = null;
  protected pkceChallenge: PKCEChallenge | null = null;
  protected onTokensRefreshed: ((tokens: OAuthTokens) => void) | null = null;

  constructor(tokens?: OAuthTokens, fileId?: string) {
    if (tokens) {
      this.tokens = tokens;
    }
    this.fileId = fileId || null;
  }

  protected abstract buildProviderAuthUrl(
    redirectUri: string
  ): Promise<{ url: string; pkce: PKCEChallenge }>;

  protected abstract exchangeProviderCode(
    code: string,
    codeVerifier: string,
    redirectUri: string
  ): Promise<OAuthTokens>;

  protected abstract refreshProviderToken(refreshToken: string): Promise<OAuthTokens>;

  protected abstract fetchProviderUserInfo(accessToken: string): Promise<ProviderAccount>;

  protected abstract validateProviderToken(accessToken: string): Promise<boolean>;

  protected mergeRefreshedTokens(refreshed: OAuthTokens, _priorRefreshToken: string): OAuthTokens {
    return refreshed;
  }

  protected normalizeRefreshError(error: unknown): unknown {
    return error;
  }

  protected createExpiredTokenError(context: 'setTokens' | 'ensureValidToken'): Error {
    return new Error(
      context === 'setTokens' ? 'Token expired and no refresh token' : 'Token expired'
    );
  }

  /**
   * Register a callback that receives refreshed tokens so the caller can
   * persist them. Passing null removes the callback.
   */
  setOnTokensRefreshed(callback: ((tokens: OAuthTokens) => void) | null): void {
    this.onTokensRefreshed = callback;
  }

  protected async refreshTokens(refreshToken: string): Promise<OAuthTokens> {
    let refreshed: OAuthTokens;
    try {
      refreshed = await this.refreshProviderToken(refreshToken);
    } catch (error) {
      throw this.normalizeRefreshError(error);
    }
    const merged = this.mergeRefreshedTokens(refreshed, refreshToken);
    this.tokens = merged;
    try {
      this.onTokensRefreshed?.(merged);
    } catch {
      // Persistence is best-effort; a failed save must not abort the sync that
      // triggered the refresh — the fresh tokens still work for this session.
    }
    return merged;
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
    const { url, pkce } = await this.buildProviderAuthUrl(redirectUri);
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

    this.tokens = await this.exchangeProviderCode(
      code,
      this.pkceChallenge.codeVerifier,
      redirectUri
    );
    this.pkceChallenge = null;

    this.account = await this.fetchProviderUserInfo(this.tokens.accessToken);

    return this.tokens;
  }

  /**
   * Set tokens from storage
   */
  async setTokens(tokens: OAuthTokens): Promise<void> {
    this.tokens = tokens;

    if (tokens.expiresAt && Date.now() > tokens.expiresAt - 60000) {
      if (tokens.refreshToken) {
        this.tokens = await this.refreshTokens(tokens.refreshToken);
      } else {
        throw this.createExpiredTokenError('setTokens');
      }
    }

    if (await this.validateProviderToken(this.tokens.accessToken)) {
      this.account = await this.fetchProviderUserInfo(this.tokens.accessToken);
    } else {
      throw new Error('Token is invalid');
    }
  }

  /**
   * Ensure token is fresh
   */
  protected async ensureValidToken(): Promise<string> {
    if (!this.tokens) {
      throw new Error('Not authenticated');
    }

    if (this.tokens.expiresAt && Date.now() > this.tokens.expiresAt - 60000) {
      if (this.tokens.refreshToken) {
        this.tokens = await this.refreshTokens(this.tokens.refreshToken);
      } else {
        throw this.createExpiredTokenError('ensureValidToken');
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
    this.onTokensRefreshed = null;
  }

  /**
   * Get tokens for storage
   */
  getTokens(): OAuthTokens | null {
    return this.tokens;
  }
}
