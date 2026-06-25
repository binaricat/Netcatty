import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '../../../application/i18n/I18nProvider.tsx';
import { VaultArtifactCard } from './VaultArtifactCard.tsx';

test('VaultArtifactCard renders note artifact title', () => {
  const html = renderToStaticMarkup(
    <I18nProvider locale="en">
      <VaultArtifactCard
        artifact={{
          kind: 'vault.note',
          noteId: 'note-1',
          title: 'Runbook',
          group: 'ops/prod',
        }}
      />
    </I18nProvider>,
  );

  assert.match(html, /Runbook/);
  assert.match(html, /ops\/prod/);
});

test('VaultArtifactCard renders host batch summary', () => {
  const html = renderToStaticMarkup(
    <I18nProvider locale="en">
      <VaultArtifactCard
        artifact={{
          kind: 'vault.hosts.batch',
          addedCount: 2,
          preview: [{ label: 'Web', hostname: '10.0.0.1' }],
        }}
      />
    </I18nProvider>,
  );

  assert.match(html, /Added 2 hosts/);
  assert.match(html, /Web/);
});
