import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPluginImporterDestination,
  buildPluginImporterSafePreview,
  mergePluginImporterDrafts,
  normalizePluginImporterRecords,
} from './pluginImporter.ts';

test('plugin importer drafts receive host-owned identities and reject malformed records', () => {
  const result = normalizePluginImporterRecords([
    { type: 'draft', draft: { kind: 'host', value: { id: 'plugin-id', label: 'Prod', hostname: 'prod.test', username: 'root', tags: [], os: 'linux' } } },
    { type: 'draft', draft: { kind: 'identity', value: { id: 'plugin-id', label: 'Deploy', username: 'deploy', authMethod: 'password', password: 'secret' } } },
    { type: 'draft', draft: { kind: 'group', value: { path: 'Imported/Prod' } } },
    { type: 'draft', draft: { kind: 'snippet', value: { label: 'Broken' } } },
    { type: 'warning', message: 'Provider warning' },
  ]);
  assert.equal(result.hosts.length, 1);
  assert.notEqual(result.hosts[0].id, 'plugin-id');
  assert.equal(result.identities.length, 1);
  assert.notEqual(result.identities[0].id, 'plugin-id');
  assert.deepEqual(result.groups, ['Imported/Prod']);
  assert.deepEqual(result.warnings, ['Provider warning']);
  assert.deepEqual(result.errors, ['Importer returned an invalid snippet draft.']);
});

test('plugin importer uses canonical Unicode character limits without truncating valid secrets', () => {
  const label = '😀'.repeat(512);
  const password = '🔒'.repeat(65_536);
  const result = normalizePluginImporterRecords([
    { type: 'draft', draft: { kind: 'identity', value: {
      label, username: 'root', authMethod: 'password', password,
    } } },
  ]);

  assert.deepEqual(result.errors, []);
  assert.equal(result.identities[0].label, label);
  assert.equal(result.identities[0].password, password);
});

test('plugin importer host drafts preserve unavailable namespaced configuration', () => {
  const result = normalizePluginImporterRecords([{ type: 'draft', draft: {
    kind: 'host',
    value: {
      label: 'Custom transport',
      hostname: 'opaque-target',
      username: '',
      tags: [],
      os: 'linux',
      protocol: 'plugin:com.example.transport.connection',
      pluginConnection: {
        providerId: 'com.example.transport.connection',
        configuration: { endpoint: 'opaque-target' },
      },
    },
  } }]);
  assert.equal(result.hosts[0].protocol, 'plugin:com.example.transport.connection');
  assert.deepEqual(result.hosts[0].pluginConnection?.configuration, { endpoint: 'opaque-target' });
});

test('plugin importer host drafts can use opaque provider configuration without an SSH hostname', () => {
  const result = normalizePluginImporterRecords([{ type: 'draft', draft: {
    kind: 'host',
    value: {
      label: 'Opaque service',
      protocol: 'plugin:com.example.transport.connection',
      pluginConnection: {
        providerId: 'com.example.transport.connection',
        configuration: { account: 'production' },
      },
    },
  } }]);
  assert.equal(result.hosts.length, 1);
  assert.equal(result.hosts[0].hostname, 'com.example.transport.connection');
  assert.deepEqual(result.hosts[0].pluginConnection?.configuration, { account: 'production' });
});

test('plugin importer rejects plugin host drafts whose protocol does not match the provider ID', () => {
  const result = normalizePluginImporterRecords([{ type: 'draft', draft: {
    kind: 'host',
    value: {
      label: 'Mismatched service',
      protocol: 'plugin:com.example.other.connection',
      pluginConnection: {
        providerId: 'com.example.transport.connection',
        configuration: { account: 'production' },
      },
    },
  } }]);
  assert.deepEqual(result.hosts, []);
  assert.deepEqual(result.errors, ['Importer returned an invalid host draft.']);
});

test('plugin importer rejects unknown host protocols instead of persisting an unsafe cast', () => {
  const result = normalizePluginImporterRecords([{ type: 'draft', draft: {
    kind: 'host',
    value: {
      label: 'Unsupported transport',
      hostname: 'host.test',
      protocol: 'rdp',
    },
  } }]);
  assert.deepEqual(result.hosts, []);
  assert.deepEqual(result.errors, ['Importer returned an invalid host draft.']);
});

test('plugin importer rejects overlong host protocols before draft spreading', () => {
  const result = normalizePluginImporterRecords([{ type: 'draft', draft: {
    kind: 'host',
    value: {
      label: 'Overlong transport',
      hostname: 'host.test',
      protocol: 'plugin:'.concat('a'.repeat(193)),
    },
  } }]);
  assert.deepEqual(result.hosts, []);
  assert.deepEqual(result.errors, ['Importer returned an invalid host draft.']);
});

test('plugin importer validates supported host fields before sanitizing drafts', () => {
  assert.doesNotThrow(() => normalizePluginImporterRecords([{ type: 'draft', draft: {
    kind: 'host',
    value: {
      label: 'Malformed host',
      hostname: 'host.test',
      notes: 5,
    },
  } }]));
  const result = normalizePluginImporterRecords([{ type: 'draft', draft: {
    kind: 'host',
    value: {
      label: 'Malformed host',
      hostname: 'host.test',
      notes: 5,
    },
  } }]);
  assert.deepEqual(result.hosts, []);
  assert.deepEqual(result.errors, ['Importer returned an invalid host draft.']);
});

test('plugin importer preserves validated host fields without retaining arbitrary draft properties', () => {
  const result = normalizePluginImporterRecords([{ type: 'draft', draft: {
    kind: 'host',
    value: {
      label: 'Imported host',
      hostname: 'host.test',
      username: 'alice',
      group: 'Imported',
      notes: '  visible notes  ',
      port: 2222,
      deviceType: 'network',
      sftpFileProtocol: 'scp',
      pinned: true,
      unsafeExtra: 'discarded',
    },
  } }]);
  assert.equal(result.hosts.length, 1);
  assert.equal(result.hosts[0].group, 'Imported');
  assert.equal(result.hosts[0].notes, 'visible notes');
  assert.equal(result.hosts[0].port, 2222);
  assert.equal(result.hosts[0].deviceType, 'network');
  assert.equal(result.hosts[0].sftpFileProtocol, 'scp');
  assert.equal(result.hosts[0].pinned, true);
  assert.equal(Object.hasOwn(result.hosts[0] as unknown as Record<string, unknown>, 'unsafeExtra'), false);
});

test('plugin importer drops startup commands from host drafts', () => {
  const result = normalizePluginImporterRecords([{ type: 'draft', draft: {
    kind: 'host',
    value: {
      label: 'Imported host',
      hostname: 'host.test',
      startupCommand: 'rm -rf /tmp/example',
    },
  } }]);
  assert.equal(result.hosts.length, 1);
  assert.equal(result.hosts[0].startupCommand, undefined);
});

test('plugin importer drops hidden plaintext built-in credential fields from host drafts', () => {
  const result = normalizePluginImporterRecords([{ type: 'draft', draft: {
    kind: 'host',
    value: {
      label: 'Imported host',
      hostname: 'host.test',
      telnetUsername: 'admin',
      telnetPassword: 'plaintext',
      savePassword: true,
    },
  } }]);
  assert.equal(result.hosts.length, 1);
  assert.equal(result.hosts[0].telnetUsername, undefined);
  assert.equal(result.hosts[0].telnetPassword, undefined);
  assert.equal(result.hosts[0].savePassword, undefined);
});

test('plugin importer rejects malformed supported host enum fields', () => {
  for (const [key, value] of [
    ['deviceType', 'router'],
    ['sftpFileProtocol', 'ftp'],
  ] as const) {
    const result = normalizePluginImporterRecords([{ type: 'draft', draft: {
      kind: 'host',
      value: {
        label: 'Malformed host',
        hostname: 'host.test',
        [key]: value,
      },
    } }]);
    assert.deepEqual(result.hosts, []);
    assert.deepEqual(result.errors, ['Importer returned an invalid host draft.']);
  }
});

test('plugin importer remaps provider-local key and identity references into host-owned IDs', () => {
  const result = normalizePluginImporterRecords([
    { type: 'draft', draft: { kind: 'key', value: {
      id: 'provider-key', label: 'Key', type: 'ED25519', privateKey: 'private',
    } } },
    { type: 'draft', draft: { kind: 'identity', value: {
      id: 'provider-identity', label: 'Identity', username: 'root', authMethod: 'key', keyId: 'provider-key',
    } } },
    { type: 'draft', draft: { kind: 'host', value: {
      label: 'Host', hostname: 'host.test', identityId: 'provider-identity', identityFileId: 'provider-key',
    } } },
  ]);
  assert.equal(result.identities[0].keyId, result.keys[0].id);
  assert.equal(result.hosts[0].identityId, result.identities[0].id);
  assert.equal(result.hosts[0].identityFileId, result.keys[0].id);
});

test('plugin importer maps plugin credential references to imported host-owned credentials', () => {
  const result = normalizePluginImporterRecords([
    { type: 'draft', draft: { kind: 'identity', value: {
      id: 'provider-credential', label: 'Plugin password', username: 'root', authMethod: 'password', password: 'secret',
    } } },
    { type: 'draft', draft: { kind: 'host', value: {
      label: 'Plugin host',
      protocol: 'plugin:com.example.transport.connection',
      pluginConnection: {
        providerId: 'com.example.transport.connection',
        configuration: {},
        credentialId: 'provider-credential',
      },
    } } },
  ]);
  assert.equal(result.errors.length, 0);
  assert.equal(result.hosts[0].pluginConnection?.credentialId, result.identities[0].id);
});

test('plugin importer rejects unresolved plugin credential references instead of silently dropping them', () => {
  const result = normalizePluginImporterRecords([
    { type: 'draft', draft: { kind: 'host', value: {
      label: 'Plugin host',
      protocol: 'plugin:com.example.transport.connection',
      pluginConnection: {
        providerId: 'com.example.transport.connection',
        configuration: {},
        credentialId: 'missing-credential',
      },
    } } },
  ]);
  assert.equal(result.hosts[0].pluginConnection?.credentialId, undefined);
  assert.deepEqual(result.errors, ['Importer returned an unresolved plugin credential reference.']);
});

test('plugin importer rejects unresolved standard Vault references instead of committing incomplete drafts', () => {
  const result = normalizePluginImporterRecords([
    { type: 'draft', draft: { kind: 'identity', value: {
      label: 'Missing key identity', username: 'root', authMethod: 'key', keyId: 'missing-key',
    } } },
    { type: 'draft', draft: { kind: 'host', value: {
      label: 'Missing credentials host', hostname: 'host.test',
      identityId: 'missing-identity',
      telnetIdentityId: 'missing-telnet-identity',
      identityFileId: 'missing-host-key',
    } } },
  ]);

  assert.equal(result.identities[0].keyId, undefined);
  assert.equal(result.hosts[0].identityId, undefined);
  assert.equal(result.hosts[0].telnetIdentityId, undefined);
  assert.equal(result.hosts[0].identityFileId, undefined);
  assert.deepEqual(result.errors, [
    'Importer returned an unresolved identity key reference.',
    'Importer returned an unresolved host identity reference.',
    'Importer returned an unresolved host Telnet identity reference.',
    'Importer returned an unresolved host key reference.',
  ]);
});

test('plugin importer rejects plugin credential references to duplicate identity source ids', () => {
  const result = normalizePluginImporterRecords([
    { type: 'draft', draft: { kind: 'identity', value: {
      id: 'duplicate-credential', label: 'First identity', username: 'first', authMethod: 'password', password: 'first',
    } } },
    { type: 'draft', draft: { kind: 'identity', value: {
      id: 'duplicate-credential', label: 'Second identity', username: 'second', authMethod: 'password', password: 'second',
    } } },
    { type: 'draft', draft: { kind: 'host', value: {
      label: 'Plugin host', hostname: 'plugin.test', protocol: 'plugin:com.example.transport.connection',
      identityId: 'duplicate-credential',
      pluginConnection: {
        providerId: 'com.example.transport.connection',
        configuration: {},
        credentialId: 'duplicate-credential',
      },
    } } },
  ]);

  assert.equal(result.hosts[0].pluginConnection?.credentialId, undefined);
  assert.equal(result.hosts[0].identityId, undefined);
  assert.deepEqual(result.errors, [
    'Importer returned a duplicate identity source ID.',
    'Importer returned an ambiguous plugin credential reference.',
  ]);
});

test('plugin importer rejects plugin credential references to duplicate key source ids', () => {
  const result = normalizePluginImporterRecords([
    { type: 'draft', draft: { kind: 'key', value: {
      id: 'duplicate-credential', label: 'First key', type: 'ED25519', privateKey: 'first',
    } } },
    { type: 'draft', draft: { kind: 'key', value: {
      id: 'duplicate-credential', label: 'Second key', type: 'RSA', privateKey: 'second',
    } } },
    { type: 'draft', draft: { kind: 'identity', value: {
      id: 'dependent-identity', label: 'Dependent identity', username: 'root', authMethod: 'key',
      keyId: 'duplicate-credential',
    } } },
    { type: 'draft', draft: { kind: 'host', value: {
      label: 'Plugin host', hostname: 'plugin.test', protocol: 'plugin:com.example.transport.connection',
      identityFileId: 'duplicate-credential',
      pluginConnection: {
        providerId: 'com.example.transport.connection',
        configuration: {},
        credentialId: 'duplicate-credential',
      },
    } } },
  ]);

  assert.equal(result.hosts[0].pluginConnection?.credentialId, undefined);
  assert.equal(result.hosts[0].identityFileId, undefined);
  assert.equal(result.identities[0].keyId, undefined);
  assert.deepEqual(result.errors, [
    'Importer returned a duplicate key source ID.',
    'Importer returned an ambiguous identity key reference.',
    'Importer returned an ambiguous plugin credential reference.',
  ]);
});

test('plugin importer merge skips duplicates and remaps relationships to retained Vault records', () => {
  const records = [
    { type: 'draft', draft: { kind: 'key', value: {
      id: 'provider-key', label: 'Key', type: 'ED25519', privateKey: 'private',
    } } },
    { type: 'draft', draft: { kind: 'identity', value: {
      id: 'provider-identity', label: 'Identity', username: 'root', authMethod: 'key', keyId: 'provider-key',
    } } },
    { type: 'draft', draft: { kind: 'host', value: {
      label: 'Host', hostname: 'host.test', username: 'root', identityId: 'provider-identity', identityFileId: 'provider-key',
    } } },
    { type: 'draft', draft: { kind: 'snippet', value: {
      label: 'Check', command: 'uptime',
    } } },
  ] as const;
  const existingDrafts = normalizePluginImporterRecords(records);
  const duplicateDrafts = normalizePluginImporterRecords(records);
  const merged = mergePluginImporterDrafts({
    hosts: existingDrafts.hosts,
    identities: existingDrafts.identities,
    keys: existingDrafts.keys,
    snippets: existingDrafts.snippets,
    customGroups: [],
  }, duplicateDrafts);
  assert.equal(merged.duplicateCount, 4);
  assert.equal(merged.addedCount, 0);
  assert.equal(merged.keys.length, 1);
  assert.equal(merged.identities.length, 1);
  assert.equal(merged.hosts.length, 1);
  assert.equal(merged.snippets.length, 1);
});

test('plugin importer keeps identical provider settings with different credentials', () => {
  const drafts = normalizePluginImporterRecords([
    { type: 'draft', draft: { kind: 'identity', value: {
      id: 'credential-a', label: 'Credential A', username: 'root', authMethod: 'password', password: 'first',
    } } },
    { type: 'draft', draft: { kind: 'identity', value: {
      id: 'credential-b', label: 'Credential B', username: 'root', authMethod: 'password', password: 'second',
    } } },
    { type: 'draft', draft: { kind: 'host', value: {
      label: 'Plugin host A',
      protocol: 'plugin:com.example.transport.connection',
      pluginConnection: {
        providerId: 'com.example.transport.connection',
        configuration: { endpoint: 'shared' },
        credentialId: 'credential-a',
      },
    } } },
    { type: 'draft', draft: { kind: 'host', value: {
      label: 'Plugin host B',
      protocol: 'plugin:com.example.transport.connection',
      pluginConnection: {
        providerId: 'com.example.transport.connection',
        configuration: { endpoint: 'shared' },
        credentialId: 'credential-b',
      },
    } } },
  ]);
  const merged = mergePluginImporterDrafts({
    hosts: [], identities: [], keys: [], snippets: [], customGroups: [],
  }, drafts);

  assert.equal(merged.hosts.length, 2);
  assert.equal(merged.identities.length, 2);
  assert.notEqual(
    merged.hosts[0].pluginConnection?.credentialId,
    merged.hosts[1].pluginConnection?.credentialId,
  );
});

test('plugin importer destination moves only newly imported hosts into the selected group', () => {
  const existingDrafts = normalizePluginImporterRecords([{ type: 'draft', draft: {
    kind: 'host',
    value: { label: 'Existing', hostname: 'existing.test', group: 'Original' },
  } }]);
  const importedDrafts = normalizePluginImporterRecords([{ type: 'draft', draft: {
    kind: 'host',
    value: { label: 'Imported', hostname: 'imported.test', group: 'Source' },
  } }]);
  const merged = mergePluginImporterDrafts({
    hosts: existingDrafts.hosts,
    identities: [],
    keys: [],
    snippets: [],
    customGroups: ['Original'],
  }, importedDrafts);

  const targeted = applyPluginImporterDestination(
    merged,
    existingDrafts.hosts.length,
    { mode: 'group', group: 'Chosen' },
    ['Original'],
  );

  assert.equal(targeted.hosts[0].group, 'Original');
  assert.equal(targeted.hosts[1].group, 'Chosen');
  assert.deepEqual(targeted.customGroups, ['Original', 'Chosen']);
  assert.equal(targeted.addedCount, 2);
});

test('plugin importer does not count a host-owned destination group as newly added', () => {
  const existingDrafts = normalizePluginImporterRecords([{ type: 'draft', draft: {
    kind: 'host',
    value: { label: 'Existing', hostname: 'existing.test', group: 'Existing Group' },
  } }]);
  const importedDrafts = normalizePluginImporterRecords([{ type: 'draft', draft: {
    kind: 'host',
    value: { label: 'Imported', hostname: 'imported.test', group: 'Source' },
  } }]);
  const merged = mergePluginImporterDrafts({
    hosts: existingDrafts.hosts,
    identities: [],
    keys: [],
    snippets: [],
    customGroups: [],
  }, importedDrafts);

  const targeted = applyPluginImporterDestination(
    merged,
    existingDrafts.hosts.length,
    { mode: 'group', group: 'Existing Group' },
  );

  assert.equal(targeted.hosts[1].group, 'Existing Group');
  assert.deepEqual(targeted.customGroups, ['Existing Group']);
  assert.equal(targeted.addedCount, 1);
});

test('plugin importer preview is bounded and never exposes secret or command payloads', () => {
  const drafts = normalizePluginImporterRecords([
    { type: 'draft', draft: { kind: 'identity', value: {
      label: 'Deploy\nidentity', username: 'root', authMethod: 'password', password: 'do-not-render',
    } } },
    { type: 'draft', draft: { kind: 'key', value: {
      label: 'Production key', type: 'ED25519', privateKey: 'private-key-material', passphrase: 'secret',
    } } },
    { type: 'draft', draft: { kind: 'snippet', value: {
      label: 'Restart service', command: 'contains-sensitive-command',
    } } },
    { type: 'warning', message: 'Check\nsource' },
    { type: 'error', message: 'Invalid\tentry' },
  ]);
  const preview = buildPluginImporterSafePreview(drafts, 2, 1);
  assert.deepEqual(preview.items, [
    { kind: 'identity', label: 'Deploy identity', detail: 'root · password' },
    { kind: 'key', label: 'Production key', detail: 'ED25519 · imported' },
  ]);
  assert.deepEqual(preview.warnings, ['Check source']);
  assert.deepEqual(preview.errors, []);
  assert.equal(preview.omittedItemCount, 1);
  assert.equal(preview.omittedDiagnosticCount, 1);
  assert.equal(JSON.stringify(preview).includes('do-not-render'), false);
  assert.equal(JSON.stringify(preview).includes('private-key-material'), false);
  assert.equal(JSON.stringify(preview).includes('contains-sensitive-command'), false);
});
