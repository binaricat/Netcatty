import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { act, create } from "react-test-renderer";

import {
  SCRIPT_OVERLAY_TOP_COMPACT_PX,
  SCRIPT_OVERLAY_TOP_DEFAULT_PX,
  SCRIPT_OVERLAY_FINISHED_DISMISS_DELAY_MS,
  ScriptExecutionOverlay,
} from "./ScriptExecutionOverlay.tsx";
import { installDomEnvironment } from "../test-support/renderReactDom.tsx";
import type { ScriptRun } from "@/types/global/netcatty-bridge-script.d.ts";

const completedRun: ScriptRun = {
  runId: "completed-run",
  sessionId: "session-1",
  status: "completed",
  startedAt: 0,
  endedAt: 1_000,
  logs: [],
};

test("script overlay sits lower under the full host toolbar than under compact chrome", () => {
  assert.equal(SCRIPT_OVERLAY_TOP_DEFAULT_PX, 34);
  assert.equal(SCRIPT_OVERLAY_TOP_COMPACT_PX, 8);
  assert.ok(SCRIPT_OVERLAY_TOP_COMPACT_PX < SCRIPT_OVERLAY_TOP_DEFAULT_PX);
});

test("script overlay covers compact speed-dial full-width instead of reserving a right gutter", () => {
  const overlaySource = readFileSync(
    fileURLToPath(new URL("./ScriptExecutionOverlay.tsx", import.meta.url)),
    "utf8",
  );
  const terminalSource = readFileSync(
    fileURLToPath(new URL("../Terminal.tsx", import.meta.url)),
    "utf8",
  );

  assert.match(overlaySource, /compactTopChrome/);
  assert.match(overlaySource, /left-2 right-2/);
  assert.match(overlaySource, /z-40/);
  assert.doesNotMatch(overlaySource, /right-10/);
  assert.match(overlaySource, /SCRIPT_OVERLAY_TOP_COMPACT_PX/);
  assert.match(
    terminalSource,
    /compactTopChrome=\{terminalSettings\?\.showHostInfoBar === false\}/,
  );
});

test("script overlay dismisses a completed run after five seconds", () => {
  const dom = installDomEnvironment();
  mock.timers.enable({ apis: ["setTimeout"] });
  let dismissCount = 0;
  let renderer: ReturnType<typeof create> | undefined;

  const renderOverlay = (onDismiss: () => void) => React.createElement(ScriptExecutionOverlay, {
    run: completedRun,
    onPause: () => {},
    onResume: () => {},
    onStop: () => {},
    onDismiss,
  });

  try {
    act(() => {
      renderer = create(renderOverlay(() => { dismissCount += 1; }));
    });

    mock.timers.tick(SCRIPT_OVERLAY_FINISHED_DISMISS_DELAY_MS - 1_000);
    assert.equal(dismissCount, 0);

    // Script run broadcasts replace the callback without changing this run.
    act(() => {
      renderer?.update(renderOverlay(() => { dismissCount += 1; }));
    });

    mock.timers.tick(999);
    assert.equal(dismissCount, 0);

    mock.timers.tick(1);
    assert.equal(dismissCount, 1);
  } finally {
    act(() => {
      renderer?.unmount();
    });
    mock.timers.reset();
    dom.cleanup();
  }
});
