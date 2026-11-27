import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { RemoteDesktopAction } from '../../domain/remoteDesktopActionCodec';
import {
  executeRemoteDesktopActions,
  getRemoteDesktopAiControlState,
  hasRemoteDesktopController,
  isRemoteDesktopAiControlling,
  preemptRemoteDesktopControl,
  registerRemoteDesktopController,
  resetRemoteDesktopControlRegistryForTests,
  subscribeRemoteDesktopActionEvents,
  subscribeRemoteDesktopAiControlState,
  type RemoteDesktopActionEvent,
  type RemoteDesktopAiControlState,
} from './remoteDesktopControlRegistry';
import {
  resetRemoteDesktopSnapshotRegistryForTests,
  setRemoteDesktopAiReadBlocked,
} from './remoteDesktopSnapshotRegistry';

describe('remoteDesktopControlRegistry', () => {
  beforeEach(() => {
    resetRemoteDesktopControlRegistryForTests();
    resetRemoteDesktopSnapshotRegistryForTests();
  });

  it('executes action sequences, tracks aiControlling state, and emits visual action events', async () => {
    const performed: RemoteDesktopAction[] = [];
    const controlStates: RemoteDesktopAiControlState[] = [];
    const actionEvents: RemoteDesktopActionEvent[] = [];

    const unsubState = subscribeRemoteDesktopAiControlState('rdp-1', (s) => controlStates.push(s));
    const unsubEvents = subscribeRemoteDesktopActionEvents('rdp-1', (e) => actionEvents.push(e));
    const unsubCtrl = registerRemoteDesktopController('rdp-1', {
      performAction: async (action) => {
        performed.push(action);
      },
      releaseAllInputs: () => {},
      getState: () => ({
        connected: true,
        viewOnly: false,
        protocol: 'rdp',
        hostLabel: 'win-box',
        hostname: '10.0.0.5',
        desktopWidth: 1920,
        desktopHeight: 1080,
      }),
    });

    assert.equal(hasRemoteDesktopController('rdp-1'), true);
    assert.equal(isRemoteDesktopAiControlling('rdp-1'), false);

    const res = await executeRemoteDesktopActions(
      'rdp-1',
      [
        { type: 'click', x: 500, y: 500 },
        { type: 'type', text: 'whoami' },
        { type: 'key', key: 'Enter' },
      ],
      { chatSessionId: 'chat-1', interActionDelayMs: 0 },
    );

    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.completedActions, 3);
      assert.equal(res.totalActions, 3);
      assert.equal(res.protocol, 'rdp');
    }
    assert.equal(performed.length, 3);
    assert.equal(isRemoteDesktopAiControlling('rdp-1'), false);
    assert.equal(getRemoteDesktopAiControlState('rdp-1').aiControlling, false);

    assert.equal(controlStates[0].aiControlling, true);
    assert.equal(controlStates[0].chatSessionId, 'chat-1');
    assert.equal(controlStates[controlStates.length - 1].aiControlling, false);

    assert.equal(actionEvents.length, 6);
    assert.equal(actionEvents[0].phase, 'start');
    assert.equal(actionEvents[1].phase, 'end');

    unsubState();
    unsubEvents();
    unsubCtrl();
    assert.equal(hasRemoteDesktopController('rdp-1'), false);
  });

  it('rejects immediately on privacy lock, view-only mode, disconnected session, or missing controller', async () => {
    const missing = await executeRemoteDesktopActions('missing', [{ type: 'click', x: 10, y: 10 }]);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, 'UNAVAILABLE');

    let viewOnly = false;
    let connected = true;
    registerRemoteDesktopController('vnc-1', {
      performAction: () => {},
      releaseAllInputs: () => {},
      getState: () => ({
        connected,
        viewOnly,
        protocol: 'vnc',
        desktopWidth: 1280,
        desktopHeight: 720,
      }),
    });

    setRemoteDesktopAiReadBlocked('vnc-1', true);
    const blocked = await executeRemoteDesktopActions('vnc-1', [{ type: 'click', x: 10, y: 10 }]);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.code, 'AI_READ_BLOCKED');
    setRemoteDesktopAiReadBlocked('vnc-1', false);

    viewOnly = true;
    const ro = await executeRemoteDesktopActions('vnc-1', [{ type: 'click', x: 10, y: 10 }]);
    assert.equal(ro.ok, false);
    if (!ro.ok) assert.equal(ro.code, 'SESSION_VIEW_ONLY');
    viewOnly = false;

    connected = false;
    const dc = await executeRemoteDesktopActions('vnc-1', [{ type: 'click', x: 10, y: 10 }]);
    assert.equal(dc.ok, false);
    if (!dc.ok) assert.equal(dc.code, 'SESSION_DISCONNECTED');
  });

  it('stops immediately on user preemption between actions, calls releaseAllInputs, and returns USER_PREEMPTED', async () => {
    let released = 0;
    const executed: string[] = [];

    registerRemoteDesktopController('rdp-preempt', {
      performAction: async (action) => {
        executed.push(action.type);
      },
      releaseAllInputs: () => {
        released += 1;
      },
      getState: () => ({
        connected: true,
        viewOnly: false,
        protocol: 'rdp',
        desktopWidth: 1920,
        desktopHeight: 1080,
      }),
    });

    const unsub = subscribeRemoteDesktopActionEvents('rdp-preempt', (ev) => {
      if (ev.phase === 'end' && ev.index === 0) {
        const didPreempt = preemptRemoteDesktopControl('rdp-preempt', 'pointer');
        assert.equal(didPreempt, true);
      }
    });

    try {
      const res = await executeRemoteDesktopActions(
        'rdp-preempt',
        [
          { type: 'click', x: 100, y: 100 },
          { type: 'type', text: 'should-not-run' },
          { type: 'key', key: 'Enter' },
        ],
        { interActionDelayMs: 0 },
      );

      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.code, 'USER_PREEMPTED');
        assert.equal(res.completedActions, 1);
        assert.equal(res.totalActions, 3);
        assert.equal(res.preemptReason, 'pointer');
      }
      assert.deepEqual(executed, ['click']);
      assert.ok(released >= 1);
      assert.equal(isRemoteDesktopAiControlling('rdp-preempt'), false);
    } finally {
      unsub();
    }
  });

  it('propagates abort signal to in-flight performAction on preemption and does not count aborted action as completed', async () => {
    let sawSignalAborted = false;
    let released = 0;

    registerRemoteDesktopController('rdp-preempt-inflight', {
      performAction: async (_action, options) => {
        assert.ok(options?.signal instanceof AbortSignal);
        preemptRemoteDesktopControl('rdp-preempt-inflight', 'escape');
        sawSignalAborted = Boolean(options?.signal?.aborted);
      },
      releaseAllInputs: () => {
        released += 1;
      },
      getState: () => ({
        connected: true,
        viewOnly: false,
        protocol: 'rdp',
        desktopWidth: 1920,
        desktopHeight: 1080,
      }),
    });

    const res = await executeRemoteDesktopActions(
      'rdp-preempt-inflight',
      [{ type: 'drag', fromX: 10, fromY: 10, toX: 200, toY: 200 }],
      { interActionDelayMs: 0 },
    );

    assert.equal(sawSignalAborted, true);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.code, 'USER_PREEMPTED');
      assert.equal(res.completedActions, 0);
      assert.equal(res.preemptReason, 'escape');
    }
    assert.ok(released >= 1);
  });

  it('wakes up immediately from a wait action on preemption or abortSignal', async () => {
    let released = 0;
    registerRemoteDesktopController('vnc-wait', {
      performAction: () => {},
      releaseAllInputs: () => {
        released += 1;
      },
      getState: () => ({
        connected: true,
        viewOnly: false,
        protocol: 'vnc',
        desktopWidth: 1024,
        desktopHeight: 768,
      }),
    });

    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), 30);

    const start = Date.now();
    const res = await executeRemoteDesktopActions(
      'vnc-wait',
      [{ type: 'wait', ms: 4000 }],
      { abortSignal: abortController.signal, interActionDelayMs: 0 },
    );
    const elapsed = Date.now() - start;

    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.code, 'ABORTED');
      assert.equal(res.completedActions, 0);
    }
    assert.ok(elapsed < 1000, `expected fast abort wakeup, took ${elapsed}ms`);
    assert.ok(released >= 1);
  });
});
