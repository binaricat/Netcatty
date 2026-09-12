import assert from "node:assert/strict";
import test, { after } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { usePendingSftpUploadRebind } from "./usePendingSftpUploadRebind";

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
after(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment; });

test("a repeated drop can share a slow strict connect without losing completion", async () => {
  let resolveConnect!: () => void;
  const sharedConnect = new Promise<void>((resolve) => {
    resolveConnect = resolve;
  });
  let latest: ReturnType<typeof usePendingSftpUploadRebind> | null = null;
  let renderer: ReactTestRenderer | null = null;

  function Probe() {
    latest = usePendingSftpUploadRebind();
    return null;
  }

  await act(async () => {
    renderer = create(React.createElement(Probe));
  });

  act(() => {
    latest!.start({
      requestId: "drop-1",
      previousConnectionId: "old-connection",
      connect: () => sharedConnect,
    });
    latest!.start({
      requestId: "drop-2",
      previousConnectionId: "connecting-connection",
      connect: () => sharedConnect,
    });
    latest!.bindTarget("drop-2", {
      tabId: "new-tab",
      connectionId: "new-connection",
    });
  });

  assert.equal(latest!.startedRequestIdRef.current, "drop-2");
  assert.equal(latest!.settledRequestId, null);
  assert.deepEqual(latest!.barrierRef.current, {
    requestId: "drop-2",
    previousConnectionId: "connecting-connection",
    targetTabId: "new-tab",
    targetConnectionId: "new-connection",
  });

  await act(async () => {
    resolveConnect();
    await sharedConnect;
  });

  assert.equal(latest!.settledRequestId, "drop-2");
  act(() => renderer!.unmount());
});
