import assert from 'node:assert/strict';
import test from 'node:test';

import { terminalCwdStore } from './terminalCwdStore.ts';

test('terminalCwdStore bumps version only when cwd or provenance changes', () => {
  const versions: number[] = [];
  const unsubscribe = terminalCwdStore.subscribe(() => {
    versions.push(terminalCwdStore.getVersion());
  });

  const baseVersion = terminalCwdStore.getVersion();
  assert.equal(terminalCwdStore.setCwd('s1', '/tmp'), true);
  assert.equal(terminalCwdStore.getCwd('s1'), '/tmp');
  assert.equal(terminalCwdStore.getVersion(), baseVersion + 1);

  assert.equal(terminalCwdStore.setCwd('s1', '/tmp'), false);
  assert.equal(terminalCwdStore.getVersion(), baseVersion + 1);

  assert.equal(terminalCwdStore.setCwd('s1', '/var'), true);
  assert.equal(terminalCwdStore.getCwd('s1'), '/var');

  assert.equal(terminalCwdStore.setCwd('s1', '/var', 'backend-strict'), true);
  assert.equal(terminalCwdStore.getSource('s1'), 'backend-strict');
  assert.equal(terminalCwdStore.setCwd('s1', '/var', 'backend-strict'), false);

  terminalCwdStore.prune(new Set());
  assert.equal(terminalCwdStore.getCwd('s1'), null);

  unsubscribe();
  assert.ok(versions.length >= 2);
});

test('session revisions isolate terminals and retain identical OSC 7 reports without rerendering', () => {
  const a = 'revision-a'; const b = 'revision-b';
  terminalCwdStore.setCwd(a, '/same', 'osc7');
  const revisionA = terminalCwdStore.getSessionRevision(a);
  terminalCwdStore.setCwd(b, '/elsewhere', 'osc7');
  assert.equal(terminalCwdStore.getSessionRevision(a), revisionA);
  const globalVersion = terminalCwdStore.getVersion();
  assert.equal(terminalCwdStore.setCwd(a, '/same', 'osc7'), false);
  assert.ok(terminalCwdStore.getSessionRevision(a) > revisionA);
  assert.equal(terminalCwdStore.getVersion(), globalVersion);
  const revisionB = terminalCwdStore.getSessionRevision(b);
  terminalCwdStore.prune(new Set([b]));
  assert.equal(terminalCwdStore.getSessionRevision(a), 0);
  assert.equal(terminalCwdStore.getSessionRevision(b), revisionB);
  terminalCwdStore.prune(new Set());
});
