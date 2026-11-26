import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendRemoteDesktopAuditEntry,
  clearRemoteDesktopAuditEntries,
  exportRemoteDesktopAuditJson,
  listRemoteDesktopAuditEntries,
  MAX_REMOTE_DESKTOP_AUDIT_ENTRIES,
  resetRemoteDesktopAuditLogForTests,
  subscribeRemoteDesktopAuditLog,
} from './remoteDesktopAuditLog';

describe('remoteDesktopAuditLog', () => {
  beforeEach(() => {
    resetRemoteDesktopAuditLogForTests();
  });

  it('appends, lists newest-first, filters by session, exports JSON, and notifies subscribers', () => {
    let notifications = 0;
    const unsub = subscribeRemoteDesktopAuditLog(() => {
      notifications += 1;
    });

    appendRemoteDesktopAuditEntry({
      sessionId: 'rdp-1',
      protocol: 'rdp',
      hostLabel: 'win-prod',
      hostname: '10.0.0.10',
      actionCount: 2,
      completedActions: 2,
      summary: 'Click (100, 200) -> Type "[REDACTED]"',
      actions: [
        { type: 'click', x: 100, y: 200 },
        { type: 'type', text: 'sk-live-secret1234567890' },
      ],
      outcome: 'ok',
      durationMs: 120,
      timestamp: 1000,
    });

    appendRemoteDesktopAuditEntry({
      sessionId: 'vnc-2',
      protocol: 'vnc',
      hostLabel: 'ubuntu',
      actionCount: 1,
      completedActions: 0,
      summary: 'Press Alt+F4',
      actions: [{ type: 'key', key: 'Alt+F4' }],
      highRiskChords: ['Alt+F4'],
      outcome: 'preempted',
      errorCode: 'USER_PREEMPTED',
      timestamp: 2000,
    });

    assert.equal(notifications, 2);

    const all = listRemoteDesktopAuditEntries();
    assert.equal(all.length, 2);
    assert.equal(all[0].sessionId, 'vnc-2');
    assert.equal(all[1].sessionId, 'rdp-1');
    // Secret-like typed text must be redacted in persisted action payload too
    assert.deepEqual(all[1].actions[1], { type: 'type', text: '[REDACTED]' });

    const rdpOnly = listRemoteDesktopAuditEntries('rdp-1');
    assert.equal(rdpOnly.length, 1);
    assert.equal(rdpOnly[0].hostLabel, 'win-prod');

    const exported = JSON.parse(exportRemoteDesktopAuditJson('rdp-1')) as {
      version: number;
      sessionId: string;
      entries: Array<{ sessionId: string }>;
    };
    assert.equal(exported.version, 1);
    assert.equal(exported.sessionId, 'rdp-1');
    assert.equal(exported.entries.length, 1);

    const removedOne = clearRemoteDesktopAuditEntries('rdp-1');
    assert.equal(removedOne, 1);
    assert.equal(listRemoteDesktopAuditEntries().length, 1);
    assert.equal(listRemoteDesktopAuditEntries('rdp-1').length, 0);

    const removedRest = clearRemoteDesktopAuditEntries();
    assert.equal(removedRest, 1);
    assert.equal(listRemoteDesktopAuditEntries().length, 0);

    unsub();
  });

  it('enforces the 500-entry ring buffer cap by evicting oldest entries', () => {
    const total = MAX_REMOTE_DESKTOP_AUDIT_ENTRIES + 25;
    for (let i = 0; i < total; i += 1) {
      appendRemoteDesktopAuditEntry({
        id: `entry-${i}`,
        sessionId: 'rdp-ring',
        actionCount: 1,
        completedActions: 1,
        summary: `Wait ${i}ms`,
        actions: [{ type: 'wait', ms: 50 }],
        outcome: 'ok',
        timestamp: 1000 + i,
      });
    }

    const entries = listRemoteDesktopAuditEntries('rdp-ring');
    assert.equal(entries.length, MAX_REMOTE_DESKTOP_AUDIT_ENTRIES);
    // Newest first
    assert.equal(entries[0].id, `entry-${total - 1}`);
    assert.equal(entries[entries.length - 1].id, 'entry-25');
  });
});
