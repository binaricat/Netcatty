import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGrantFromApproval,
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

  it('matches host: prefixed session patterns against hostname', () => {
    const rules = [baseRule({ sessionPattern: 'host:prod-*' })];
    const matched = matchPermissionGrant(rules, {
      capabilityId: 'terminal.execute',
      hostname: 'prod-web-01',
      args: { command: 'uptime' },
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

  it('buildGrantFromApproval defaults session pattern from args.sessionId', () => {
    const grant = buildGrantFromApproval('terminal.execute', {
      sessionId: 'ssh-1',
      command: 'systemctl status nginx',
    }, 'chat-1');
    assert.equal(grant.sessionPattern, 'ssh-1');
    assert.equal(grant.commandPattern, 'systemctl status nginx');
  });

  it('patternMatches supports regex literals', () => {
    assert.equal(patternMatches('/^ls\\b/', 'ls -la'), true);
    assert.equal(patternMatches('/^ls\\b/', 'cat file'), false);
  });
});
