import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachTokenRefreshPersistence,
  handleProviderReauthRequiredImpl,
  persistRefreshedProviderTokensImpl,
} from './stateAndSecurityMethods.ts';
import { inspectProviderRemoteStateImpl } from './authMethods.ts';
import {
  ONEDRIVE_REAUTH_REQUIRED_MARKER,
  isProviderReadyForSync,
  type OAuthTokens,
  type ProviderConnection,
} from '../../../domain/sync.ts';

const newTokens = (): OAuthTokens => ({
  accessToken: 'fresh-access',
  refreshToken: 'rotated-refresh',
  expiresAt: Date.now() + 3_600_000,
  tokenType: 'Bearer',
});

function createManager() {
  const saved: Array<{ provider: string; tokens?: OAuthTokens }> = [];
  let notified = 0;
  const manager = {
    providerDecryptSeq: { onedrive: 0, google: 0 } as Record<string, number>,
    adapters: new Map<string, { signOut: () => void }>(),
    state: {
      providers: {
        onedrive: {
          provider: 'onedrive',
          status: 'connected',
          tokens: { accessToken: 'old', refreshToken: 'old-refresh', tokenType: 'Bearer' },
          account: { id: 'u1' },
          resourceId: 'file-1',
        } as ProviderConnection,
      } as Record<string, ProviderConnection>,
    },
    saveProviderConnection: async (provider: string, connection: { tokens?: OAuthTokens }) => {
      saved.push({ provider, tokens: connection.tokens });
    },
    notifyStateChange: () => {
      notified += 1;
    },
  };
  return { manager, saved, getNotified: () => notified };
}

test('persistRefreshedProviderTokens updates state, persists, and notifies', async () => {
  const { manager, saved, getNotified } = createManager();
  const tokens = newTokens();

  persistRefreshedProviderTokensImpl.call(manager, 'onedrive', tokens);
  // saveProviderConnection is fire-and-forget; let microtasks flush.
  await Promise.resolve();

  assert.deepEqual(manager.state.providers.onedrive.tokens, tokens);
  // Other fields are preserved.
  assert.equal(manager.state.providers.onedrive.account?.id, 'u1');
  assert.equal(manager.state.providers.onedrive.resourceId, 'file-1');
  assert.equal(manager.state.providers.onedrive.status, 'connected');

  assert.equal(saved.length, 1);
  assert.equal(saved[0].provider, 'onedrive');
  assert.deepEqual(saved[0].tokens, tokens);

  // Decrypt sequence is bumped so an in-flight decrypt cannot clobber the write.
  assert.equal(manager.providerDecryptSeq.onedrive, 1);
  assert.equal(getNotified(), 1);
});

test('persistRefreshedProviderTokens is a no-op when the provider was disconnected', async () => {
  const { manager, saved } = createManager();
  // Simulate a disconnect happening during the async refresh.
  manager.state.providers.onedrive = { provider: 'onedrive', status: 'disconnected' };

  persistRefreshedProviderTokensImpl.call(manager, 'onedrive', newTokens());
  await Promise.resolve();

  assert.equal(saved.length, 0);
  assert.equal(manager.state.providers.onedrive.tokens, undefined);
});

test('attachTokenRefreshPersistence wires adapters that expose setOnTokensRefreshed', () => {
  const { manager, saved } = createManager();
  let registered: ((tokens: OAuthTokens) => void) | null = null;
  const adapter = {
    setOnTokensRefreshed(cb: (tokens: OAuthTokens) => void) {
      registered = cb;
    },
  };

  attachTokenRefreshPersistence.call(manager, 'onedrive', adapter as never);
  assert.equal(typeof registered, 'function');

  // Invoking the registered callback persists, proving the wiring is correct.
  const tokens = newTokens();
  registered!(tokens);
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].tokens, tokens);
});

test('attachTokenRefreshPersistence is a no-op for adapters without the hook', () => {
  const { manager } = createManager();
  // Adapter without setOnTokensRefreshed (e.g. GitHub) must not throw.
  assert.doesNotThrow(() =>
    attachTokenRefreshPersistence.call(manager, 'github', {} as never),
  );
});

test('handleProviderReauthRequired clears OneDrive tokens and stops it being sync-ready', async () => {
  const { manager, saved } = createManager();
  let signedOut = false;
  manager.adapters.set('onedrive', { signOut: () => { signedOut = true; } });

  const handled = handleProviderReauthRequiredImpl.call(
    manager,
    'onedrive',
    new Error(
      `Download failed: ${ONEDRIVE_REAUTH_REQUIRED_MARKER}: OneDrive session expired, please reconnect. (AADSTS70000)`,
    ),
  );
  await Promise.resolve();

  assert.equal(handled, true);
  assert.equal(signedOut, true);
  // Stale adapter is evicted.
  assert.equal(manager.adapters.has('onedrive'), false);

  const conn = manager.state.providers.onedrive;
  assert.equal(conn.tokens, undefined);
  assert.equal(conn.status, 'error');
  // Account is preserved for display; error message is cleaned of the marker.
  assert.equal(conn.account?.id, 'u1');
  assert.ok(conn.error && !conn.error.includes(ONEDRIVE_REAUTH_REQUIRED_MARKER));
  assert.match(conn.error ?? '', /please reconnect/);

  // Crucial: cleared tokens => not ready for sync => auto-sync won't retry.
  assert.equal(isProviderReadyForSync(conn), false);

  // Persisted the cleared connection.
  assert.equal(saved.length, 1);
  assert.equal(saved[0].tokens, undefined);
});

test('handleProviderReauthRequired ignores non-OneDrive providers and unrelated errors', () => {
  const { manager } = createManager();

  // Wrong provider.
  assert.equal(
    handleProviderReauthRequiredImpl.call(
      manager,
      'google',
      new Error(`${ONEDRIVE_REAUTH_REQUIRED_MARKER}: x`),
    ),
    false,
  );

  // OneDrive but an ordinary (retryable) error — must not clear tokens.
  assert.equal(
    handleProviderReauthRequiredImpl.call(manager, 'onedrive', new Error('network timeout')),
    false,
  );
  assert.ok(manager.state.providers.onedrive.tokens);
});

test('inspectProviderRemoteState clears OneDrive tokens on a reauth-required download error', async () => {
  const { manager, saved } = createManager();
  // Provide the manager surface inspectProviderRemoteState touches.
  Object.assign(manager, {
    handleProviderReauthRequired(provider: string, error: unknown) {
      return handleProviderReauthRequiredImpl.call(manager, provider as never, error);
    },
    createSyncedFileSignature: async () => null,
    loadSyncAnchor: () => null,
  });

  const adapter = {
    resourceId: 'file-1',
    download: async () => {
      throw new Error(
        `Download failed: ${ONEDRIVE_REAUTH_REQUIRED_MARKER}: OneDrive session expired, please reconnect.`,
      );
    },
  };

  const result = await inspectProviderRemoteStateImpl.call(manager, 'onedrive', adapter as never);
  await Promise.resolve();

  // The inspection reports an error (so callers fail closed)...
  assert.ok(result.error);
  // ...and the dead credentials were cleared so the provider is no longer ready.
  assert.equal(manager.state.providers.onedrive.tokens, undefined);
  assert.equal(isProviderReadyForSync(manager.state.providers.onedrive), false);
  assert.equal(saved.length, 1);
});
