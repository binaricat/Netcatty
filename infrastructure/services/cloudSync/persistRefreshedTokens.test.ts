import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachTokenRefreshPersistence,
  persistRefreshedProviderTokensImpl,
} from './stateAndSecurityMethods.ts';
import type { OAuthTokens } from '../../../domain/sync.ts';

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
    providerDecryptSeq: { onedrive: 0 } as Record<string, number>,
    state: {
      providers: {
        onedrive: {
          provider: 'onedrive',
          status: 'connected',
          tokens: { accessToken: 'old', refreshToken: 'old-refresh', tokenType: 'Bearer' },
          account: { id: 'u1' },
          resourceId: 'file-1',
        },
      },
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
  assert.equal(manager.state.providers.onedrive.account.id, 'u1');
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
  manager.state.providers.onedrive = { provider: 'onedrive', status: 'disconnected' } as never;

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
