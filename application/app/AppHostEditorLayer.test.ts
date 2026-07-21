import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { GroupConfig, Host } from '../../types';
import {
  collectWorkSurfaceHostGroups,
  collectWorkSurfaceHostTags,
  getAppHostEditorLayerStyle,
  resolveWorkSurfaceHostEditorKind,
} from './AppHostEditorLayer';

const host = (overrides: Partial<Host> = {}): Host => ({
  id: 'host-1',
  label: 'web',
  hostname: '10.0.0.1',
  username: 'root',
  port: 22,
  protocol: 'ssh',
  tags: [],
  os: 'linux',
  createdAt: 1,
  ...overrides,
});

test('serial targets use the serial editor', () => {
  assert.equal(
    resolveWorkSurfaceHostEditorKind({
      mode: 'edit',
      openedHost: host({ protocol: 'serial' }),
      requestId: 1,
    }),
    'serial',
  );
});

test('new and ssh targets use the standard editor', () => {
  assert.equal(
    resolveWorkSurfaceHostEditorKind({ mode: 'new', defaultGroup: null, requestId: 1 }),
    'standard',
  );
  assert.equal(
    resolveWorkSurfaceHostEditorKind({ mode: 'edit', openedHost: host(), requestId: 2 }),
    'standard',
  );
});

test('editor collections include configured, saved, custom, and ancestor groups', () => {
  assert.deepEqual(
    collectWorkSurfaceHostGroups(
      [host({ group: 'prod/web' })],
      ['manual'],
      [{ path: 'prod' } as GroupConfig],
    ),
    ['manual', 'prod', 'prod/web'],
  );
});

test('editor tags are unique and sorted', () => {
  assert.deepEqual(
    collectWorkSurfaceHostTags([
      host({ tags: ['prod', 'blue'] }),
      host({ id: 'host-2', tags: ['blue'] }),
    ]),
    ['blue', 'prod'],
  );
});

test('editor overlay leaves the work surface interactive outside the panel', () => {
  const source = readFileSync(new URL('./AppHostEditorLayer.tsx', import.meta.url), 'utf8');

  assert.match(source, /pointer-events-none absolute inset-0 z-40/);
  assert.match(source, /\[&>\*\]:pointer-events-auto/);
  assert.equal((source.match(/className="pointer-events-auto"/g) ?? []).length, 2);
  assert.equal((source.match(/layout="overlay"/g) ?? []).length, 2);
});

test('editor host panels share vault resize width persistence', () => {
  const source = readFileSync(new URL('./AppHostEditorLayer.tsx', import.meta.url), 'utf8');

  assert.match(source, /STORAGE_KEY_VAULT_HOST_PANEL_WIDTH/);
  assert.match(source, /resizable:\s*true/);
  assert.match(source, /\{\.\.\.hostPanelResizeProps\}/);
  assert.equal((source.match(/\{\.\.\.hostPanelResizeProps\}/g) ?? []).length, 2);
});

test('editor stays mounted while another app surface is active', () => {
  assert.deepEqual(getAppHostEditorLayerStyle(false), {
    display: 'none',
    pointerEvents: 'none',
  });
  assert.deepEqual(getAppHostEditorLayerStyle(true), {
    display: undefined,
    pointerEvents: undefined,
  });

  const source = readFileSync(new URL('./AppHostEditorLayer.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /!surfaceVisible\) return null/);
  assert.match(source, /style=\{getAppHostEditorLayerStyle\(surfaceVisible\)\}/);
  assert.match(source, /ref=\{setPortalContainer\}/);
  assert.match(source, /<PortalContainerProvider container=\{portalContainer\}>/);
});

test('AppView composes host-tree actions with the work-surface editor', () => {
  const source = readFileSync(new URL('./AppView.tsx', import.meta.url), 'utf8');

  assert.match(source, /useWorkSurfaceHostEditor/);
  assert.match(source, /<AppHostEditorLayer/);
  assert.match(source, /onNewHost=\{workSurfaceHostEditor\.openNew\}/);
  assert.match(source, /onEditHost=\{workSurfaceHostEditor\.openEdit\}/);
  assert.match(source, /terminal\.layer\.hostTree\.hostSavedNextConnection/);
});
