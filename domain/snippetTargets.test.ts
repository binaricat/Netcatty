import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getRunnableHostsForSnippet,
  snippetAppliesToHost,
  snippetAppliesToOutputTrigger,
  snippetHasRunTargets,
} from './snippetTargets.ts';
import type { Host, Snippet } from './models';

const baseSnippet: Snippet = {
  id: 's1',
  label: 'test',
  command: 'echo hi',
  package: '',
};

const hosts: Host[] = [
  {
    id: 'host-a',
    label: 'A',
    hostname: 'a.example',
    username: 'root',
    os: 'linux',
    protocol: 'ssh',
  },
  {
    id: 'host-b',
    label: 'B',
    hostname: 'b.example',
    username: 'root',
    os: 'linux',
    protocol: 'serial',
  },
];

test('snippetAppliesToHost returns false when targets are empty', () => {
  assert.equal(snippetAppliesToHost(baseSnippet, 'host-a'), false);
  assert.equal(snippetAppliesToHost({ ...baseSnippet, targets: [] }, 'host-a'), false);
});

test('snippetAppliesToHost matches only listed hosts', () => {
  const snippet = { ...baseSnippet, targets: ['host-a', 'host-b'] };
  assert.equal(snippetAppliesToHost(snippet, 'host-a'), true);
  assert.equal(snippetAppliesToHost(snippet, 'host-c'), false);
  assert.equal(snippetAppliesToHost(snippet, undefined), false);
});

test('snippetAppliesToHost matches all hosts when targetsAllHosts is set', () => {
  const snippet = { ...baseSnippet, targetsAllHosts: true };
  assert.equal(snippetAppliesToHost(snippet, 'host-a'), true);
  assert.equal(snippetAppliesToHost(snippet, 'host-c'), true);
  assert.equal(snippetAppliesToHost(snippet, undefined), false);
});

test('snippetHasRunTargets requires explicit scope', () => {
  assert.equal(snippetHasRunTargets(baseSnippet), false);
  assert.equal(snippetHasRunTargets({ ...baseSnippet, targets: ['host-a'] }), true);
  assert.equal(snippetHasRunTargets({ ...baseSnippet, targetsAllHosts: true }), true);
});

test('snippetAppliesToOutputTrigger applies to current session when targets are unset', () => {
  const snippet = { ...baseSnippet, trigger: 'onConnect' as const };
  assert.equal(snippetAppliesToOutputTrigger(snippet, 'host-a'), false);

  const output = { ...baseSnippet, trigger: 'onOutput' as const };
  assert.equal(snippetAppliesToOutputTrigger(output, 'host-a'), true);
  assert.equal(snippetAppliesToOutputTrigger(output, undefined), false);
});

test('snippetAppliesToOutputTrigger respects explicit host targets', () => {
  const output = {
    ...baseSnippet,
    trigger: 'onOutput' as const,
    targets: ['host-a'],
  };
  assert.equal(snippetAppliesToOutputTrigger(output, 'host-a'), true);
  assert.equal(snippetAppliesToOutputTrigger(output, 'host-b'), false);
});

test('getRunnableHostsForSnippet excludes serial hosts and respects scope', () => {
  assert.deepEqual(
    getRunnableHostsForSnippet({ ...baseSnippet, targets: ['host-a', 'host-b'] }, hosts),
    [hosts[0]],
  );
  assert.deepEqual(
    getRunnableHostsForSnippet({ ...baseSnippet, targetsAllHosts: true }, hosts),
    [hosts[0]],
  );
  assert.deepEqual(getRunnableHostsForSnippet(baseSnippet, hosts), []);
});
