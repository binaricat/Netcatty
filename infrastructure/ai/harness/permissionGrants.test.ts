import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGrantFromApproval,
  buildGrantsFromApproval,
  listGrantableCapabilityIds,
  matchPermissionGrant,
  patternMatches,
  type PermissionGrantRule,
} from './permissionGrants';

const baseRule = (overrides: Partial<PermissionGrantRule>): PermissionGrantRule => ({
  id: 'grant-1',
  capabilityId: 'terminal.execute',
  sessionPattern: 'session-a',
  createdAt: Date.now(),
  ...overrides,
});

describe('permissionGrants', () => {
  it('matches wildcard session and command patterns', () => {
    const rules = [baseRule({ sessionPattern: '*', commandPattern: 'ls *' })];
    const matched = matchPermissionGrant(rules, {
      capabilityId: 'terminal.execute',
      sessionId: 'any-session',
      args: { command: 'ls -la /tmp' },
    });
    assert.ok(matched);
  });

  it('ignores sessionPattern and matches globally by capability and command', () => {
    const rules = [baseRule({ sessionPattern: 'old-session-uuid', commandPattern: 'ls *' })];
    const matched = matchPermissionGrant(rules, {
      capabilityId: 'terminal.execute',
      sessionId: 'different-session',
      args: { command: 'ls -la /tmp' },
    });
    assert.ok(matched);
  });

  it('does not match a different capability', () => {
    const rules = [baseRule({ sessionPattern: '*' })];
    const matched = matchPermissionGrant(rules, {
      capabilityId: 'terminal.start',
      sessionId: 'session-a',
      args: { command: 'make' },
    });
    assert.equal(matched, null);
  });

  it('buildGrantFromApproval uses global scope and OpenCode-style command prefix patterns', () => {
    const grant = buildGrantFromApproval('terminal.execute', {
      sessionId: 'ssh-1',
      command: 'systemctl status nginx',
    }, 'chat-1');
    assert.equal(grant.sessionPattern, '*');
    assert.equal(grant.commandPattern, 'systemctl status *');
  });

  it('buildGrantsFromApproval emits one rule per chained command segment', () => {
    const grants = buildGrantsFromApproval('terminal.execute', {
      sessionId: 'ssh-1',
      command: 'cd /tmp && lscpu',
    }, 'chat-1');
    assert.equal(grants.length, 1);
    assert.equal(grants[0]?.commandPattern, 'lscpu *');
  });

  it('OpenCode wildcard allows optional args after prefix', () => {
    assert.equal(patternMatches('lscpu *', 'lscpu'), true);
    assert.equal(patternMatches('lscpu *', 'lscpu -e'), true);
    assert.equal(patternMatches('git checkout *', 'git checkout main'), true);
    assert.equal(patternMatches('git checkout *', 'git commit'), false);
  });

  it('lists grantable capability ids from catalog policy', () => {
    const ids = listGrantableCapabilityIds();
    assert.ok(ids.includes('terminal.execute'));
    assert.ok(ids.includes('sftp.write'));
    assert.ok(!ids.includes('terminal.poll'));
  });

  it('patternMatches supports regex literals', () => {
    assert.equal(patternMatches('/^ls\\b/', 'ls -la'), true);
    assert.equal(patternMatches('/^ls\\b/', 'cat file'), false);
  });
});
