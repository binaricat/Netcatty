import assert from "node:assert/strict";
import { test } from "node:test";
import type { Terminal as XTerm } from "@xterm/xterm";
import {
  cancelPendingSynchronizedRestore,
  deferScrollRestoreDuringSynchronizedOutput,
} from "./terminalHelpers";

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

test("coalesces fits that race the scheduled restore frame", async () => {
  const renderListeners: RenderListener[] = [];
  const term = createTerm(true, renderListeners);
  const restored: number[] = [];

  assert.equal(
    deferScrollRestoreDuringSynchronizedOutput(term, () => {
      restored.push(1);
    }),
    true,
  );

  // The mode ends and the restore is scheduled for a subsequent frame, but
  // the pending slot must stay occupied through that frame.
  (term.modes as { synchronizedOutputMode: boolean }).synchronizedOutputMode = false;
  renderListeners[0]();
  assert.equal(restored.length, 0);

  // A fit racing between the render and the scheduled frame must be dropped:
  // running its restore immediately would let its programmatic scroll trip
  // the retained scroll tracker into canceling the original restore.
  assert.equal(
    deferScrollRestoreDuringSynchronizedOutput(term, () => {
      restored.push(2);
    }),
    false,
  );

  await flushMacroTask();
  assert.deepEqual(restored, [1]);

  // The slot is freed once the scheduled restore runs.
  assert.equal(
    deferScrollRestoreDuringSynchronizedOutput(term, () => {
      restored.push(3);
    }),
    true,
  );
  assert.deepEqual(restored, [1, 3]);
});

test("cancelPendingSynchronizedRestore drops the pending restore without running it", async () => {
  const renderListeners: RenderListener[] = [];
  const term = createTerm(true, renderListeners);
  let restored = 0;

  deferScrollRestoreDuringSynchronizedOutput(term, () => {
    restored += 1;
  });
  assert.equal(renderListeners.length, 1);

  // Cancelling frees the pending slot and unwinds the render listener
  // without running the restore — the caller replaced it (e.g. the active
  // buffer changed while the mode was still on).
  cancelPendingSynchronizedRestore(term);
  assert.equal(renderListeners.length, 0);

  (term.modes as { synchronizedOutputMode: boolean }).synchronizedOutputMode = false;
  await flushMacroTask();
  assert.equal(restored, 0);

  // The freed slot accepts a new restore even after the mode ended.
  deferScrollRestoreDuringSynchronizedOutput(term, () => {
    restored += 1;
  });
  assert.equal(restored, 1);

  // Cancelling without a pending restore is a no-op.
  cancelPendingSynchronizedRestore(term);
});

test("cancelPendingSynchronizedRestore also cancels a restore waiting for its scheduled frame", async () => {
  const renderListeners: RenderListener[] = [];
  const term = createTerm(true, renderListeners);
  let restored = 0;

  deferScrollRestoreDuringSynchronizedOutput(term, () => {
    restored += 1;
  });

  // Schedule the restore (mode ended, render observed).
  (term.modes as { synchronizedOutputMode: boolean }).synchronizedOutputMode = false;
  renderListeners[0]();

  cancelPendingSynchronizedRestore(term);
  await flushMacroTask();
  assert.equal(restored, 0);
});
