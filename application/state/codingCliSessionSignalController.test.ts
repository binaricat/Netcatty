import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { CodingCliProviderId } from '../../domain/codingCliProviders';
import type { DynamicTabTitleMode } from '../../domain/models';
import {
  createCodingCliSessionSignalController,
  type CodingCliSessionSignalController,
  useCodingCliSessionSignals,
} from './codingCliSessionSignalController';

test('connected sessions stop every icon mutation while dynamic titles are off and resume when enabled', () => {
  let mode: DynamicTabTitleMode = 'agent';
  const session: { id: string; codingCliProviderId?: CodingCliProviderId } = {
    id: 'session-1',
    codingCliProviderId: 'claude',
  };
  const providerUpdates: Array<CodingCliProviderId | null> = [];
  const controller = createCodingCliSessionSignalController({
    getDynamicTabTitleMode: () => mode,
    getSession: (sessionId) => sessionId === session.id ? session : undefined,
    onUpdateSessionCodingCliProvider: (_sessionId, providerId) => {
      providerUpdates.push(providerId);
      session.codingCliProviderId = providerId ?? undefined;
    },
  });

  mode = 'off';
  controller.handleTerminalOutput(session.id, 'Welcome to Claude Code');
  controller.handleCommandSubmitted(session.id, 'opencode');
  controller.handleTerminalTitleChange(session.id, null);
  controller.handleTerminalTitleChange(session.id, 'root@host:~/project');
  controller.handleTerminalTitleChange(session.id, 'OpenAI Codex');

  assert.deepEqual(providerUpdates, []);
  assert.equal(session.codingCliProviderId, 'claude');

  mode = 'agent';
  controller.handleTerminalTitleChange(session.id, 'root@host:~/project');
  controller.handleCommandSubmitted(session.id, 'opencode');

  assert.deepEqual(providerUpdates, [null, 'opencode']);
  assert.equal(session.codingCliProviderId, 'opencode');
});

test('output scanning paused by the setting can detect a real banner after re-enable', () => {
  let mode: DynamicTabTitleMode = 'off';
  const session: { id: string; codingCliProviderId?: CodingCliProviderId } = { id: 'session-1' };
  const providerUpdates: Array<CodingCliProviderId | null> = [];
  const controller = createCodingCliSessionSignalController({
    getDynamicTabTitleMode: () => mode,
    getSession: () => session,
    onUpdateSessionCodingCliProvider: (_sessionId, providerId) => {
      providerUpdates.push(providerId);
      session.codingCliProviderId = providerId ?? undefined;
    },
  });

  controller.handleTerminalOutput(session.id, 'Welcome to Claude Code');
  assert.deepEqual(providerUpdates, []);

  mode = 'agent';
  controller.handleTerminalOutput(session.id, 'Welcome to Claude Code');
  assert.deepEqual(providerUpdates, ['claude']);
});

test('mode changes discard partial and exhausted output scanner state', () => {
  let mode: DynamicTabTitleMode = 'agent';
  const session: { id: string; codingCliProviderId?: CodingCliProviderId } = { id: 'session-1' };
  const providerUpdates: Array<CodingCliProviderId | null> = [];
  const controller = createCodingCliSessionSignalController({
    getDynamicTabTitleMode: () => mode,
    getSession: () => session,
    onUpdateSessionCodingCliProvider: (_sessionId, providerId) => {
      providerUpdates.push(providerId);
      session.codingCliProviderId = providerId ?? undefined;
    },
  });

  controller.handleTerminalOutput(session.id, 'Welcome to Claude ');
  mode = 'off';
  controller.handleDynamicTabTitleModeChange(mode);
  controller.handleTerminalOutput(session.id, 'ignored while disabled');
  mode = 'agent';
  controller.handleDynamicTabTitleModeChange(mode);
  controller.handleTerminalOutput(session.id, 'Code');
  assert.deepEqual(providerUpdates, []);

  controller.handleTerminalOutput(session.id, 'x'.repeat(16384));
  mode = 'off';
  controller.handleTerminalOutput(session.id, 'ignored while disabled');
  mode = 'agent';
  controller.handleTerminalOutput(session.id, 'Welcome to Claude Code');
  assert.deepEqual(providerUpdates, ['claude']);
});

test('switching between enabled modes preserves exhausted output scans', () => {
  let mode: DynamicTabTitleMode = 'agent';
  const session: { id: string; codingCliProviderId?: CodingCliProviderId } = { id: 'session-1' };
  const providerUpdates: Array<CodingCliProviderId | null> = [];
  const controller = createCodingCliSessionSignalController({
    getDynamicTabTitleMode: () => mode,
    getSession: () => session,
    onUpdateSessionCodingCliProvider: (_sessionId, providerId) => {
      providerUpdates.push(providerId);
      session.codingCliProviderId = providerId ?? undefined;
    },
  });

  controller.handleTerminalOutput(session.id, 'x'.repeat(16384));
  mode = 'all';
  controller.handleDynamicTabTitleModeChange(mode);
  controller.handleTerminalOutput(session.id, 'Welcome to Claude Code');
  assert.deepEqual(providerUpdates, []);
});

test('useCodingCliSessionSignals preserves scan state and follows current props', async () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

  type ProbeProps = {
    mode: DynamicTabTitleMode;
    sessionIds: string[];
    session: { id: string; codingCliProviderId?: CodingCliProviderId };
    onProvider: (providerId: CodingCliProviderId | null) => void;
  };
  let controller: CodingCliSessionSignalController | null = null;
  const Probe = (props: ProbeProps) => {
    controller = useCodingCliSessionSignals({
      dynamicTabTitleMode: props.mode,
      sessionIds: props.sessionIds,
      getSession: (sessionId) => sessionId === props.session.id ? props.session : undefined,
      onUpdateSessionCodingCliProvider: (_sessionId, providerId) => props.onProvider(providerId),
    });
    return null;
  };

  const session = { id: 'session-hook' };
  const firstUpdates: Array<CodingCliProviderId | null> = [];
  const latestUpdates: Array<CodingCliProviderId | null> = [];
  let renderer: ReactTestRenderer | null = null;

  try {
    await act(async () => {
      renderer = create(React.createElement(Probe, {
        mode: 'agent',
        sessionIds: [session.id],
        session,
        onProvider: (providerId) => firstUpdates.push(providerId),
      }));
    });
    controller!.handleTerminalOutput(session.id, 'Welcome to Claude ');

    await act(async () => {
      renderer!.update(React.createElement(Probe, {
        mode: 'agent',
        sessionIds: [session.id],
        session,
        onProvider: (providerId) => latestUpdates.push(providerId),
      }));
    });
    controller!.handleTerminalOutput(session.id, 'Code');
    assert.deepEqual(firstUpdates, []);
    assert.deepEqual(latestUpdates, ['claude']);

    session.codingCliProviderId = undefined;
    await act(async () => {
      renderer!.update(React.createElement(Probe, {
        mode: 'off',
        sessionIds: [session.id],
        session,
        onProvider: (providerId) => latestUpdates.push(providerId),
      }));
    });
    controller!.handleCommandSubmitted(session.id, 'opencode');
    assert.deepEqual(latestUpdates, ['claude']);
  } finally {
    await act(async () => renderer?.unmount());
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

test('useCodingCliSessionSignals forgets scans for sessions removed from props', async () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

  const session = { id: 'session-removed' };
  const providerUpdates: Array<CodingCliProviderId | null> = [];
  let sessionIds = [session.id];
  let controller: CodingCliSessionSignalController | null = null;
  const Probe = () => {
    controller = useCodingCliSessionSignals({
      dynamicTabTitleMode: 'agent',
      sessionIds,
      getSession: (sessionId) => sessionIds.includes(sessionId) ? session : undefined,
      onUpdateSessionCodingCliProvider: (_sessionId, providerId) => {
        providerUpdates.push(providerId);
      },
    });
    return null;
  };
  let renderer: ReactTestRenderer | null = null;

  try {
    await act(async () => {
      renderer = create(React.createElement(Probe));
    });
    controller!.handleTerminalOutput(session.id, 'x'.repeat(16384));

    sessionIds = [];
    await act(async () => renderer!.update(React.createElement(Probe)));
    controller!.handleTerminalOutput(session.id, 'Welcome to Claude ');
    sessionIds = [session.id];
    await act(async () => renderer!.update(React.createElement(Probe)));
    controller!.handleTerminalOutput(session.id, 'Code');
    assert.deepEqual(providerUpdates, []);
    controller!.handleTerminalOutput(session.id, '\nWelcome to Claude Code');
    assert.deepEqual(providerUpdates, ['claude']);
  } finally {
    await act(async () => renderer?.unmount());
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});
