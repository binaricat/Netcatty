import assert from "node:assert/strict";
import { test } from "node:test";
import type { Terminal as XTerm } from "@xterm/xterm";
import { deferScrollRestoreDuringSynchronizedOutput } from "./terminalHelpers";

const flushMacroTask = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

type RenderListener = () => void;

const createTerm = (
  synchronizedOutputMode: boolean,
  renderListeners: RenderListener[],
): XTerm =>
  ({
    modes: { synchronizedOutputMode },
    onRender: (listener: RenderListener) => {
      renderListeners.push(listener);
      return {
        dispose: () => {
          const index = renderListeners.indexOf(listener);
          if (index !== -1) renderListeners.splice(index, 1);
        },
      };
    },
  }) as unknown as XTerm;

test("runs the restore immediately when synchronized output is inactive", () => {
  const renderListeners: RenderListener[] = [];
  const term = createTerm(false, renderListeners);
  let restored = 0;

  deferScrollRestoreDuringSynchronizedOutput(term, () => {
    restored += 1;
  });

  assert.equal(restored, 1);
  assert.equal(renderListeners.length, 0);
});

test("defers the restore until a render after synchronized output ends", async () => {
  const renderListeners: RenderListener[] = [];
  const term = createTerm(true, renderListeners);
  let restored = 0;

  deferScrollRestoreDuringSynchronizedOutput(term, () => {
    restored += 1;
  });

  assert.equal(restored, 0);
  assert.equal(renderListeners.length, 1);

  // A render while the mode is still active must not run the restore.
  renderListeners[0]();
  await flushMacroTask();
  assert.equal(restored, 0);
  assert.equal(renderListeners.length, 1);

  // The first render after the mode ends schedules the restore in a
  // subsequent task (after xterm's internal viewport render handler) and
  // unwinds the listener.
  (term.modes as { synchronizedOutputMode: boolean }).synchronizedOutputMode = false;
  renderListeners[0]();
  assert.equal(restored, 0);
  assert.equal(renderListeners.length, 0);
  await flushMacroTask();
  assert.equal(restored, 1);
});

test("coalesces consecutive deferred restores so only the earliest runs", async () => {
  const renderListeners: RenderListener[] = [];
  const term = createTerm(true, renderListeners);
  const restored: number[] = [];

  // First fit captures the pre-reflow reading row (target 1).
  assert.equal(
    deferScrollRestoreDuringSynchronizedOutput(term, () => {
      restored.push(1);
    }),
    true,
  );
  assert.equal(renderListeners.length, 1);

  // A second fit before the mode ends must not register an independent
  // restore that would overwrite the pre-reflow target.
  assert.equal(
    deferScrollRestoreDuringSynchronizedOutput(term, () => {
      restored.push(2);
    }),
    false,
  );
  assert.equal(renderListeners.length, 1);

  (term.modes as { synchronizedOutputMode: boolean }).synchronizedOutputMode = false;
  renderListeners[0]();
  await flushMacroTask();
  assert.deepEqual(restored, [1]);

  // The pending slot is freed once the restore runs, so a later deferral
  // registers a fresh listener.
  (term.modes as { synchronizedOutputMode: boolean }).synchronizedOutputMode = true;
  deferScrollRestoreDuringSynchronizedOutput(term, () => {
    restored.push(3);
  });
  assert.equal(renderListeners.length, 1);
  (term.modes as { synchronizedOutputMode: boolean }).synchronizedOutputMode = false;
  renderListeners[0]();
  await flushMacroTask();
  assert.deepEqual(restored, [1, 3]);
});
