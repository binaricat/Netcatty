import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ConvergentSyncPanel } from './ConvergentSyncPanel.tsx';
import type { ConvergentMigrationPreview } from '../../domain/sync.ts';

const t = (key: string, values?: Record<string, string | number>) =>
  key === 'cloudSync.convergent.conflict.secretSet'
    ? 'SECRET_SET'
    : `${key}${values?.count === undefined ? '' : `:${values.count}`}`;

test('uninitialized migration preview shows conflict choices and disables confirmation', () => {
  const preview: ConvergentMigrationPreview = {
    schemaVersion: 2,
    canInitialize: false,
    entityCounts: { hosts: 1 },
    settingsLeafCount: 0,
    conflictCount: 1,
    conflicts: [{
      address: { kind: 'entity-field', collection: 'hosts', entityId: 'host-1', field: 'label' },
      candidates: ['Left', 'Right'].map((value, index) => ({
        dot: { deviceId: value, counter: 1 },
        hlc: { wallTime: index + 1, logical: 0 },
        tombstone: false,
        value,
        selected: index === 0,
      })),
    }],
    shrinkFindings: [],
    providers: [],
    oldClientCompatibility: 'materialized-v1-snapshot',
    blockedReasons: ['The convergent state contains unresolved field conflicts'],
  };
  const renderPreview = (value: ConvergentMigrationPreview) => renderToStaticMarkup(
    <ConvergentSyncPanel
      t={t}
      resolvedLocale="en"
      config={{ enabled: false, initialized: false }}
      preview={value}
      busy={false}
      error={null}
      conflicts={[]}
      onToggle={() => {}}
      onConfirmMigration={() => {}}
      onCancelMigration={() => {}}
      onResolveConflict={() => {}}
      onDowngrade={() => {}}
    />,
  );
  const markup = renderPreview(preview);
  assert.match(markup, /cloudSync\.convergent\.conflicts\.title:1/);
  assert.match(markup, /hosts\/host-1/);
  assert.equal((markup.match(/cloudSync\.convergent\.conflict\.choose/g) ?? []).length, 2);
  assert.match(markup, /<button[^>]*disabled=""[^>]*>cloudSync\.convergent\.preview\.confirm<\/button>/);

  const resolvedMarkup = renderPreview({
    ...preview, conflicts: [], conflictCount: 0, blockedReasons: [], canInitialize: true,
  });
  assert.doesNotMatch(resolvedMarkup, /cloudSync\.convergent\.conflict\.choose/);
  assert.doesNotMatch(resolvedMarkup, /<button[^>]*disabled=""[^>]*>cloudSync\.convergent\.preview\.confirm<\/button>/);
});

test('secret conflict candidates never render their value', () => {
  const markup = renderToStaticMarkup(
    <ConvergentSyncPanel
      t={t}
      resolvedLocale="en"
      config={{ enabled: true, initialized: true }}
      preview={null}
      busy={false}
      error={null}
      conflicts={[{
        address: { kind: 'entity-field', collection: 'keys', entityId: 'key-1', field: 'privateKey' },
        candidates: [{
          dot: { deviceId: 'device-a', counter: 1 },
          hlc: { wallTime: 1, logical: 0 },
          tombstone: false,
          value: 'PRIVATE-CONTENT-MUST-NOT-RENDER',
          selected: true,
        }],
      }]}
      onToggle={() => {}}
      onConfirmMigration={() => {}}
      onCancelMigration={() => {}}
      onResolveConflict={() => {}}
      onDowngrade={() => {}}
    />,
  );

  assert.equal(markup.includes('PRIVATE-CONTENT-MUST-NOT-RENDER'), false);
  assert.equal(markup.includes('SECRET_SET'), true);
  assert.match(
    markup,
    /data-testid="convergent-sync-icon"[^>]*class="[^"]*h-9[^"]*w-9[^"]*self-start/,
  );
});

test('secret fields nested inside array candidates never reach rendered markup', () => {
  const markup = renderToStaticMarkup(
    <ConvergentSyncPanel
      t={t}
      resolvedLocale="en"
      config={{ enabled: true, initialized: true }}
      preview={null}
      busy={false}
      error={null}
      conflicts={[{
        address: { kind: 'setting', path: ['ai', 'providers'] },
        candidates: [{
          dot: { deviceId: 'device-a', counter: 1 },
          hlc: { wallTime: 1, logical: 0 },
          tombstone: false,
          value: [{
            id: 'provider-1',
            name: 'Private provider',
            credentials: { apiKey: 'NESTED-API-KEY-MUST-NOT-RENDER' },
          }],
          selected: true,
        }],
      }]}
      onToggle={() => {}}
      onConfirmMigration={() => {}}
      onCancelMigration={() => {}}
      onResolveConflict={() => {}}
      onDowngrade={() => {}}
    />,
  );

  assert.equal(markup.includes('NESTED-API-KEY-MUST-NOT-RENDER'), false);
  assert.equal(markup.includes('SECRET_SET'), true);
});
