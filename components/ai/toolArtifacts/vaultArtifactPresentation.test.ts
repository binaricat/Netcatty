import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveVaultArtifactVisualKind } from './vaultArtifactPresentation.tsx';

test('resolveVaultArtifactVisualKind distinguishes note vs host tools', () => {
  assert.equal(
    resolveVaultArtifactVisualKind(
      { kind: 'vault.note', noteId: 'n1', title: 'Doc' },
      'vault_notes_create',
    ),
    'noteCreate',
  );
  assert.equal(
    resolveVaultArtifactVisualKind(
      { kind: 'vault.host', hostId: 'h1', label: 'Web', hostname: '10.0.0.1' },
      'host_get',
    ),
    'host',
  );
  assert.equal(
    resolveVaultArtifactVisualKind(
      {
        kind: 'vault.hosts.batch',
        sourceTool: 'vault_hosts_import',
        addedCount: 2,
        preview: [],
      },
      'vault_hosts_import',
    ),
    'hostImport',
  );
  assert.equal(
    resolveVaultArtifactVisualKind(
      {
        kind: 'vault.hosts.batch',
        sourceTool: 'vault_hosts_create',
        addedCount: 2,
        preview: [],
      },
      'vault_hosts_create',
    ),
    'hostCreate',
  );
});
