import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React, { useEffect, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import {
  EMPTY_VAULT_SNAPSHOT,
  publishVaultSnapshot,
  useVaultSnapshot,
  useVaultSnapshotField,
} from '../state/vaultSnapshotStore.ts';
import {
  publishAppShellDomainSlice,
  useAppShellProps,
} from './appShellPropsStore.ts';
import { registerAppHandlers } from './appHandlersBridge.ts';
import { resolveTerminalVaultInitialized } from '../../components/terminal/restoredSessionGate.ts';
import { terminalLayerAreEqual } from '../../components/terminalLayerMemo.ts';
import {
  terminalLayerViewCtxEqual,
  terminalLayerWorkspaceCtxEqual,
} from '../../components/terminalLayer/terminalLayerViewMemo.ts';
import type { Host, Identity, SSHKey } from '../../domain/models.ts';

const storageBacking = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storageBacking.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storageBacking.set(key, value);
    },
    removeItem: (key: string) => {
      storageBacking.delete(key);
    },
    clear: () => {
      storageBacking.clear();
    },
  },
});

const { VaultHost } = await import('./hosts/VaultHost.tsx');

test('VaultHost keeps isVaultInitialized synchronized with hydrated hosts, keys, and identities for Terminal boot (#4428)', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevActEnv = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;

  (globalThis as Record<string, unknown>).window = dom.window;
  (globalThis as Record<string, unknown>).document = dom.window.document;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

  const host: Host = {
    id: 'host-1',
    label: 'test-myhost',
    hostname: '10.243.2.249',
    port: 22,
    username: 'user1',
    authMethod: 'key',
    identityFileId: 'key-1',
    tags: [],
    createdAt: 0,
  };
  const key: SSHKey = {
    id: 'key-1',
    label: 'Imported Key',
    type: 'ED25519',
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----',
    publicKey: 'ssh-ed25519 AAAA test',
    passphrase: 'secret',
    source: 'imported',
    category: 'key',
    created: 0,
  };
  const identity: Identity = {
    id: 'id-1',
    label: 'User Identity',
    username: 'user1',
    authMethod: 'key',
    keyId: 'key-1',
    createdAt: 0,
  };

  publishVaultSnapshot(EMPTY_VAULT_SNAPSHOT);
  registerAppHandlers({} as never);

  // Mirror TerminalHost's layout-effect slice publication order (sibling after VaultHost).
  function TerminalHostMirror() {
    const vault = useVaultSnapshot();
    useLayoutEffect(() => {
      publishAppShellDomainSlice('terminal', { terminalHosts: vault.hosts });
    }, [vault.hosts]);
    return null;
  }

  const syncedBoots: Array<{
    hostCount: number;
    keyCount: number;
    identityCount: number;
    hasPrivateKey: boolean;
  }> = [];

  function SyncedTerminal({
    vaultInitializedOverride,
    hosts,
    keys,
    identities,
  }: {
    vaultInitializedOverride: boolean;
    hosts: readonly Host[];
    keys: readonly SSHKey[];
    identities: readonly Identity[];
  }) {
    const sharedVaultInitialized = useVaultSnapshotField('isVaultInitialized');
    const vaultInitialized = resolveTerminalVaultInitialized(
      sharedVaultInitialized,
      vaultInitializedOverride,
    );

    useEffect(() => {
      if (!vaultInitialized) return;
      syncedBoots.push({
        hostCount: hosts.length,
        keyCount: keys.length,
        identityCount: identities.length,
        hasPrivateKey: Boolean(keys[0]?.privateKey),
      });
      // Intentionally matches useTerminalEffects' boot effect dep shape (gated on vaultInitialized, not keys).
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vaultInitialized]);

    return null;
  }

  function ShellHarness() {
    const { domains } = useAppShellProps();
    const vaultDomain = domains?.vault as
      | { isVaultInitialized?: boolean; keys?: readonly SSHKey[]; identities?: readonly Identity[] }
      | undefined;
    const terminalDomain = domains?.terminal as
      | { terminalHosts?: readonly Host[] }
      | undefined;

    return React.createElement(
      React.Fragment,
      null,
      React.createElement(VaultHost),
      React.createElement(TerminalHostMirror),
      vaultDomain && terminalDomain
        ? React.createElement(SyncedTerminal, {
            vaultInitializedOverride: vaultDomain.isVaultInitialized ?? false,
            hosts: terminalDomain.terminalHosts ?? [],
            keys: vaultDomain.keys ?? [],
            identities: vaultDomain.identities ?? [],
          })
        : null,
    );
  }

  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    await React.act(async () => {
      root.render(React.createElement(ShellHarness));
    });
    assert.equal(syncedBoots.length, 0, 'restored terminal must not boot before vault hydration');

    // Publish hydrated hosts, keys, identities, and isVaultInitialized together.
    await React.act(async () => {
      publishVaultSnapshot({
        ...EMPTY_VAULT_SNAPSHOT,
        isVaultInitialized: true,
        hosts: [host],
        keys: [key],
        identities: [identity],
      });
    });

    assert.deepEqual(syncedBoots, [
      {
        hostCount: 1,
        keyCount: 1,
        identityCount: 1,
        hasPrivateKey: true,
      },
    ]);
  } finally {
    await React.act(async () => {
      root.unmount();
    });
    publishVaultSnapshot(EMPTY_VAULT_SNAPSHOT);
    registerAppHandlers(null);
    (globalThis as Record<string, unknown>).window = prevWindow;
    (globalThis as Record<string, unknown>).document = prevDocument;
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = prevActEnv;
  }
});

test('terminal layer memo comparators propagate isVaultInitialized changes', () => {
  const baseLayerProps = {
    isVaultInitialized: false,
    hosts: [],
    sessions: [],
  };
  assert.equal(
    terminalLayerAreEqual(baseLayerProps, { ...baseLayerProps, isVaultInitialized: true }),
    false,
  );
  assert.equal(
    terminalLayerWorkspaceCtxEqual(
      { isVaultInitialized: false },
      { isVaultInitialized: true },
    ),
    false,
  );
  assert.equal(
    terminalLayerViewCtxEqual(
      { isVaultInitialized: false },
      { isVaultInitialized: true },
    ),
    false,
  );

  const appViewSource = readFileSync(new URL('./AppView.tsx', import.meta.url), 'utf8');
  const supportSource = readFileSync(
    new URL('../../components/terminalLayer/TerminalLayerSupport.tsx', import.meta.url),
    'utf8',
  );
  assert.match(appViewSource, /<TerminalLayerMount[\s\S]*?isVaultInitialized=\{isVaultInitialized\}/);
  assert.match(supportSource, /vaultInitializedOverride=\{isVaultInitialized\}/);
});
