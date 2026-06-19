import test from 'node:test';
import assert from 'node:assert/strict';

import type { TerminalSession } from '../../types';
import { openInteractiveTerminal } from './openInteractiveTerminal';

const parentSession = (overrides: Partial<TerminalSession> = {}): TerminalSession => ({
  id: 'session-1',
  hostId: 'host-1',
  hostLabel: 'Prod',
  hostname: 'prod.example.com',
  username: 'deploy',
  status: 'connected',
  protocol: 'ssh',
  port: 22,
  ...overrides,
});

test('openInteractiveTerminal opens command popups over SSH even when the source host uses Mosh', async () => {
  const payloads: unknown[] = [];
  const backend = {
    openTerminalPopup: async (payload: unknown) => {
      payloads.push(payload);
      return { success: true };
    },
  };

  await openInteractiveTerminal(
    backend as never,
    parentSession({ moshEnabled: true }),
    'docker: api',
    'docker exec -it abc123 sh',
  );

  assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0], {
    title: 'Prod · docker: api',
    icon: undefined,
    parentSessionId: 'session-1',
    startupCommand: 'docker exec -it abc123 sh',
    sourceSession: {
      ...parentSession({ moshEnabled: true }),
      protocol: 'ssh',
      moshEnabled: false,
      etEnabled: false,
      startupCommand: 'docker exec -it abc123 sh',
      reuseConnectionFromSessionId: undefined,
    },
  });
});

test('openInteractiveTerminal opens command popups over SSH even when the source host uses ET', async () => {
  const payloads: unknown[] = [];
  const backend = {
    openTerminalPopup: async (payload: unknown) => {
      payloads.push(payload);
      return { success: true };
    },
  };

  await openInteractiveTerminal(
    backend as never,
    parentSession({ protocol: 'et' as TerminalSession['protocol'], etEnabled: true }),
    'tmux: api',
    'tmux attach-session -t api',
  );

  const payload = payloads[0] as { sourceSession: TerminalSession };
  assert.equal(payload.sourceSession.protocol, 'ssh');
  assert.equal(payload.sourceSession.moshEnabled, false);
  assert.equal(payload.sourceSession.etEnabled, false);
  assert.equal(payload.sourceSession.reuseConnectionFromSessionId, undefined);
});

test('openInteractiveTerminal keeps SSH connection reuse for ordinary connected SSH parents', async () => {
  const payloads: unknown[] = [];
  const backend = {
    openTerminalPopup: async (payload: unknown) => {
      payloads.push(payload);
      return { success: true };
    },
  };

  await openInteractiveTerminal(
    backend as never,
    parentSession(),
    'logs: api',
    'docker logs -f abc123',
  );

  const payload = payloads[0] as { sourceSession: TerminalSession };
  assert.equal(payload.sourceSession.moshEnabled, false);
  assert.equal(payload.sourceSession.protocol, 'ssh');
  assert.equal(payload.sourceSession.reuseConnectionFromSessionId, 'session-1');
});
