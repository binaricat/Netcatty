import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import React from 'react';
import { act, create } from 'react-test-renderer';

import { CONNECTION_PROGRESS_CAP } from './connectionProgress';
import { useAnimatedConnectionProgress, useConnectionCountdownSeconds } from './connectionTicker';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function renderHookValue<P>(useValue: (props: P) => number, initialProps: P) {
  const result = { current: Number.NaN, renders: 0 };
  function Probe(props: P) {
    result.current = useValue(props);
    result.renders += 1;
    return null;
  }
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(React.createElement(Probe as React.FC<P>, initialProps as P & React.Attributes));
  });
  return {
    result,
    rerender(props: P) {
      act(() => {
        renderer.update(React.createElement(Probe as React.FC<P>, props as P & React.Attributes));
      });
    },
    unmount() {
      act(() => renderer.unmount());
    },
  };
}

test('animated connection progress advances only while animating and follows the base', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const hook = renderHookValue(
      ({ base, animating }: { base: number; animating: boolean }) => useAnimatedConnectionProgress(base, animating),
      { base: 5, animating: false },
    );
    act(() => mock.timers.tick(1000));
    assert.equal(hook.result.current, 5, 'no animation while the timeout is not running');

    hook.rerender({ base: 5, animating: true });
    act(() => mock.timers.tick(200));
    const afterOneTick = hook.result.current;
    assert.ok(afterOneTick > 5);
    act(() => mock.timers.tick(10_000));
    assert.ok(hook.result.current <= CONNECTION_PROGRESS_CAP);

    // A hop event raises the base above the animation: adopt it.
    hook.rerender({ base: 100, animating: false });
    assert.equal(hook.result.current, 100);

    // A new attempt restarts from a lower base.
    hook.rerender({ base: 5, animating: true });
    assert.equal(hook.result.current, 5);
    hook.unmount();
  } finally {
    mock.timers.reset();
  }
});

test('connection countdown ticks from the deadline and freezes when the timer stops', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  try {
    const hook = renderHookValue(
      ({ deadlineAt }: { deadlineAt: number | null }) => useConnectionCountdownSeconds(deadlineAt, 30),
      { deadlineAt: null },
    );
    assert.equal(hook.result.current, 30, 'initial seconds before a deadline exists');

    hook.rerender({ deadlineAt: 1_000_000 + 20_000 });
    assert.equal(hook.result.current, 20);
    act(() => mock.timers.tick(3000));
    assert.equal(hook.result.current, 17);

    hook.rerender({ deadlineAt: null });
    act(() => mock.timers.tick(5000));
    assert.equal(hook.result.current, 17, 'stopped timer keeps the last value');
    hook.unmount();
  } finally {
    mock.timers.reset();
  }
});
