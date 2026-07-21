import assert from 'node:assert/strict';
import test from 'node:test';
import type { Host } from '../../types';
import {
  buildWorkSurfaceHostEditorKey,
  saveWorkSurfaceHostDraft,
  shouldCloseDeletedWorkSurfaceHost,
  type WorkSurfaceHostEditorTarget,
} from './useWorkSurfaceHostEditor';

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

test('editor keys separate new requests and edit targets', () => {
  assert.equal(
    buildWorkSurfaceHostEditorKey({ mode: 'edit', openedHost: host(), requestId: 1 }),
    'edit:host-1:1',
  );
  assert.equal(
    buildWorkSurfaceHostEditorKey({ mode: 'new', defaultGroup: 'prod', requestId: 2 }),
    'new:prod:2',
  );
});

test('saving an edited host updates in place and preserves a concurrent display setting', () => {
  const opened = host({ showLineTimestamps: false });
  const latest = host({ showLineTimestamps: true });
  const draft = host({ label: 'web-2', showLineTimestamps: false });

  assert.deepEqual(
    saveWorkSurfaceHostDraft(
      [latest],
      { mode: 'edit', openedHost: opened, requestId: 1 },
      draft,
    ),
    [host({ label: 'web-2', showLineTimestamps: true })],
  );
});

test('saving a new host appends it', () => {
  const created = host({ id: 'host-2' });

  assert.deepEqual(
    saveWorkSurfaceHostDraft(
      [host()],
      { mode: 'new', defaultGroup: null, requestId: 1 },
      created,
    ),
    [host(), created],
  );
});

test('an edit target closes after external deletion and cannot be recreated', () => {
  const target: WorkSurfaceHostEditorTarget = {
    mode: 'edit',
    openedHost: host(),
    requestId: 1,
  };

  assert.equal(shouldCloseDeletedWorkSurfaceHost([], target), true);
  assert.equal(saveWorkSurfaceHostDraft([], target, host({ label: 'stale' })), null);
});
