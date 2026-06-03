import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OneDriveAdapter,
  OneDriveReauthRequiredError,
  isOneDriveReauthRequiredError,
} from './OneDriveAdapter.ts';
import {
  ONEDRIVE_REAUTH_REQUIRED_MARKER,
  cleanOneDriveErrorMessage,
  type OAuthTokens,
} from '../../../domain/sync.ts';

type WindowGlobal = typeof globalThis & { window?: unknown };

function setBridge(bridge: Record<string, unknown>): () => void {
  const g = globalThis as WindowGlobal;
  const original = g.window;
  // Loosely typed: the real window.netcatty is a large NetcattyBridge; tests
  // only stub the handful of OneDrive methods the adapter actually calls.
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

test('isOneDriveReauthRequiredError detects the marker and the error class', () => {
  assert.equal(isOneDriveReauthRequiredError(new OneDriveReauthRequiredError()), true);
  assert.equal(
    isOneDriveReauthRequiredError(new Error(`${ONEDRIVE_REAUTH_REQUIRED_MARKER}: x`)),
    true,
  );
  // Survives re-wrapping the way the sync pipeline re-wraps errors.
  const wrapped = new Error(String(new OneDriveReauthRequiredError('boom')));
  assert.equal(isOneDriveReauthRequiredError(wrapped), true);
  assert.equal(isOneDriveReauthRequiredError(new Error('network down')), false);
});

test('cleanOneDriveErrorMessage strips the marker and wrapping prefixes', () => {
  const wrapped = `Error: OneDriveReauthRequiredError: ${ONEDRIVE_REAUTH_REQUIRED_MARKER}: OneDrive session expired, please reconnect. (AADSTS70000)`;
  assert.equal(
    cleanOneDriveErrorMessage(wrapped),
    'OneDrive session expired, please reconnect. (AADSTS70000)',
  );
  // No marker -> returned unchanged.
  assert.equal(cleanOneDriveErrorMessage('plain network error'), 'plain network error');
});

test('OneDriveReauthRequiredError always carries the marker in its message', () => {
  assert.ok(new OneDriveReauthRequiredError('hi').message.includes(ONEDRIVE_REAUTH_REQUIRED_MARKER));
  // Does not double-prefix when the marker is already present.
  const once = new OneDriveReauthRequiredError(`${ONEDRIVE_REAUTH_REQUIRED_MARKER}: hi`).message;
  assert.equal(once.indexOf(ONEDRIVE_REAUTH_REQUIRED_MARKER), once.lastIndexOf(ONEDRIVE_REAUTH_REQUIRED_MARKER));
});

test('refreshing tokens during an operation fires the persistence callback with rotated tokens', async () => {
  const rotated: OAuthTokens = {
    accessToken: 'fresh-access',
    refreshToken: 'rotated-refresh',
    expiresAt: Date.now() + 3_600_000,
    tokenType: 'Bearer',
  };
  let refreshCalledWith: string | undefined;
  // Returning a non-null synced file avoids the eventual-consistency retry loop
  // (retryOnNotFound) that backs off on a null result and would slow the test.
  const remoteSyncedFile = { meta: { version: 1 }, payload: 'x' };
  const restore = setBridge({
    onedriveRefreshAccessToken: async ({ refreshToken }: { refreshToken: string }) => {
      refreshCalledWith = refreshToken;
      return rotated;
    },
    onedriveDownloadSyncFile: async ({ accessToken }: { accessToken: string }) => {
      // Operation must run with the refreshed access token.
      assert.equal(accessToken, 'fresh-access');
      return { syncedFile: remoteSyncedFile };
    },
  });

  try {
    const adapter = new OneDriveAdapter(expiredTokens(), 'file-1');
    const persisted: OAuthTokens[] = [];
    adapter.setOnTokensRefreshed((tokens) => persisted.push(tokens));

    const result = await adapter.download();

    assert.deepEqual(result, remoteSyncedFile);
    assert.equal(refreshCalledWith, 'old-refresh');
    assert.equal(persisted.length, 1);
    assert.deepEqual(persisted[0], rotated);
    // Adapter also exposes the rotated tokens for the caller to persist.
    assert.deepEqual(adapter.getTokens(), rotated);
  } finally {
    restore();
  }
});

test('a dead refresh token surfaces OneDriveReauthRequiredError and does not fire the callback', async () => {
  const restore = setBridge({
    onedriveRefreshAccessToken: async () => {
      throw new Error(
        `${ONEDRIVE_REAUTH_REQUIRED_MARKER}: OneDrive session expired, please reconnect. (AADSTS70000)`,
      );
    },
  });

  try {
    const adapter = new OneDriveAdapter(expiredTokens(), 'file-1');
    let callbackFired = false;
    adapter.setOnTokensRefreshed(() => {
      callbackFired = true;
    });

    await assert.rejects(
      () => adapter.download(),
      (err) => {
        assert.equal(isOneDriveReauthRequiredError(err), true);
        assert.ok(err instanceof OneDriveReauthRequiredError);
        return true;
      },
    );
    assert.equal(callbackFired, false);
  } finally {
    restore();
  }
});

test('setTokens refreshes an expired token and persists the rotated tokens', async () => {
  const rotated: OAuthTokens = {
    accessToken: 'fresh-access',
    refreshToken: 'rotated-refresh',
    expiresAt: Date.now() + 3_600_000,
    tokenType: 'Bearer',
  };
  const restore = setBridge({
    onedriveRefreshAccessToken: async () => rotated,
    onedriveGetUserInfo: async () => ({ id: 'u1', email: 'u@example.com', name: 'User' }),
  });

  try {
    const adapter = new OneDriveAdapter();
    const persisted: OAuthTokens[] = [];
    adapter.setOnTokensRefreshed((tokens) => persisted.push(tokens));

    await adapter.setTokens(expiredTokens());

    assert.deepEqual(persisted, [rotated]);
    assert.deepEqual(adapter.getTokens(), rotated);
    assert.equal(adapter.accountInfo?.id, 'u1');
  } finally {
    restore();
  }
});

test('setTokens with an expired token and no refresh token requires reconnect', async () => {
  const restore = setBridge({});
  try {
    const adapter = new OneDriveAdapter();
    await assert.rejects(
      () =>
        adapter.setTokens({
          accessToken: 'old-access',
          expiresAt: Date.now() - 60_000,
          tokenType: 'Bearer',
        }),
      (err) => {
        assert.equal(isOneDriveReauthRequiredError(err), true);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('signOut clears the refresh persistence callback', async () => {
  const rotated: OAuthTokens = {
    accessToken: 'fresh-access',
    refreshToken: 'rotated-refresh',
    expiresAt: Date.now() + 3_600_000,
    tokenType: 'Bearer',
  };
  const restore = setBridge({
    onedriveRefreshAccessToken: async () => rotated,
    onedriveGetUserInfo: async () => ({ id: 'u1', email: 'u@example.com', name: 'User' }),
  });

  try {
    const adapter = new OneDriveAdapter(expiredTokens(), 'file-1');
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
