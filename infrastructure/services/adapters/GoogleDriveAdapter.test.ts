import assert from 'node:assert/strict';
import test from 'node:test';

import { GoogleDriveAdapter } from './GoogleDriveAdapter.ts';
import type { OAuthTokens } from '../../../domain/sync.ts';

type WindowGlobal = typeof globalThis & { window?: unknown };

function setBridge(bridge: Record<string, unknown>): () => void {
  const g = globalThis as WindowGlobal;
  const original = g.window;
  // Loosely typed: the real window.netcatty is a large NetcattyBridge; tests
  // only stub the handful of Google methods the adapter actually calls.
  g.window = { netcatty: bridge } as unknown as Window & typeof globalThis;
  return () => {
    g.window = original;
  };
}

const expiredTokens = (): OAuthTokens => ({
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  // Already expired so any operation forces a refresh.
  expiresAt: Date.now() - 60_000,
  tokenType: 'Bearer',
});

test('refreshing tokens during an operation fires the persistence callback with refreshed tokens', async () => {
  const refreshed: OAuthTokens = {
    accessToken: 'fresh-access',
    refreshToken: 'old-refresh',
    expiresAt: Date.now() + 3_600_000,
    tokenType: 'Bearer',
  };
  let refreshCalledWith: string | undefined;
  const remoteSyncedFile = { meta: { version: 1 }, payload: 'x' };
  const restore = setBridge({
    googleRefreshAccessToken: async ({ refreshToken }: { refreshToken: string }) => {
      refreshCalledWith = refreshToken;
      return refreshed;
    },
    googleDriveDownloadSyncFile: async ({ accessToken }: { accessToken: string }) => {
      // Operation must run with the refreshed access token.
      assert.equal(accessToken, 'fresh-access');
      return { syncedFile: remoteSyncedFile };
    },
  });

  try {
    const adapter = new GoogleDriveAdapter(expiredTokens(), 'file-1');
    const persisted: OAuthTokens[] = [];
    adapter.setOnTokensRefreshed((tokens) => persisted.push(tokens));

    const result = await adapter.download();

    assert.deepEqual(result, remoteSyncedFile);
    assert.equal(refreshCalledWith, 'old-refresh');
    assert.equal(persisted.length, 1);
    assert.deepEqual(persisted[0], refreshed);
    // Adapter also exposes the refreshed tokens for the caller to persist.
    assert.deepEqual(adapter.getTokens(), refreshed);
  } finally {
    restore();
  }
});

test('refresh preserves the prior refresh token when Google omits a new one', async () => {
  // Google's refresh response frequently has no refresh_token. The persisted
  // tokens must keep the previous refresh token, or the connection becomes
  // unrefreshable on the next launch.
  const refreshedWithoutRefreshToken: OAuthTokens = {
    accessToken: 'fresh-access',
    // No refreshToken — mirrors a real Google refresh_token response.
    expiresAt: Date.now() + 3_600_000,
    tokenType: 'Bearer',
  };
  const remoteSyncedFile = { meta: { version: 1 }, payload: 'x' };
  const restore = setBridge({
    googleRefreshAccessToken: async () => refreshedWithoutRefreshToken,
    googleDriveDownloadSyncFile: async () => ({ syncedFile: remoteSyncedFile }),
  });

  try {
    const adapter = new GoogleDriveAdapter(expiredTokens(), 'file-1');
    const persisted: OAuthTokens[] = [];
    adapter.setOnTokensRefreshed((tokens) => persisted.push(tokens));

    await adapter.download();

    assert.equal(persisted.length, 1);
    // The persisted (and in-memory) tokens carry the original refresh token.
    assert.equal(persisted[0].refreshToken, 'old-refresh');
    assert.equal(persisted[0].accessToken, 'fresh-access');
    assert.equal(adapter.getTokens()?.refreshToken, 'old-refresh');
  } finally {
    restore();
  }
});

test('setTokens refreshes an expired token and persists the refreshed tokens', async () => {
  const refreshed: OAuthTokens = {
    accessToken: 'fresh-access',
    refreshToken: 'old-refresh',
    expiresAt: Date.now() + 3_600_000,
    tokenType: 'Bearer',
  };
  const restore = setBridge({
    googleRefreshAccessToken: async () => refreshed,
    googleGetUserInfo: async () => ({
      id: 'u1',
      email: 'u@example.com',
      name: 'User',
      picture: '',
    }),
  });

  try {
    const adapter = new GoogleDriveAdapter();
    const persisted: OAuthTokens[] = [];
    adapter.setOnTokensRefreshed((tokens) => persisted.push(tokens));

    await adapter.setTokens(expiredTokens());

    assert.deepEqual(persisted, [refreshed]);
    assert.deepEqual(adapter.getTokens(), refreshed);
    assert.equal(adapter.accountInfo?.id, 'u1');
  } finally {
    restore();
  }
});

test('a persistence callback that throws does not abort the operation', async () => {
  const refreshed: OAuthTokens = {
    accessToken: 'fresh-access',
    refreshToken: 'old-refresh',
    expiresAt: Date.now() + 3_600_000,
    tokenType: 'Bearer',
  };
  const remoteSyncedFile = { meta: { version: 1 }, payload: 'x' };
  const restore = setBridge({
    googleRefreshAccessToken: async () => refreshed,
    googleDriveDownloadSyncFile: async () => ({ syncedFile: remoteSyncedFile }),
  });

  try {
    const adapter = new GoogleDriveAdapter(expiredTokens(), 'file-1');
    adapter.setOnTokensRefreshed(() => {
      throw new Error('persist boom');
    });

    // Refresh succeeds, the throwing callback is swallowed, the op completes.
    const result = await adapter.download();
    assert.deepEqual(result, remoteSyncedFile);
    assert.deepEqual(adapter.getTokens(), refreshed);
  } finally {
    restore();
  }
});

test('signOut clears the refresh persistence callback', async () => {
  const refreshed: OAuthTokens = {
    accessToken: 'fresh-access',
    refreshToken: 'old-refresh',
    expiresAt: Date.now() + 3_600_000,
    tokenType: 'Bearer',
  };
  const restore = setBridge({
    googleRefreshAccessToken: async () => refreshed,
    googleGetUserInfo: async () => ({
      id: 'u1',
      email: 'u@example.com',
      name: 'User',
      picture: '',
    }),
  });

  try {
    const adapter = new GoogleDriveAdapter(expiredTokens(), 'file-1');
    let callbackFired = false;
    adapter.setOnTokensRefreshed(() => {
      callbackFired = true;
    });
    adapter.signOut();
    // Re-arm tokens and refresh; the callback must not fire after signOut.
    await adapter.setTokens(expiredTokens());
    assert.equal(callbackFired, false);
  } finally {
    restore();
  }
});
