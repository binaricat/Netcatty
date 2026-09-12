import assert from "node:assert/strict";
import test, { after } from "node:test";
import React, { Suspense } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { useSftpBrowseConnectionLifecycle } from "./useSftpBrowseConnectionLifecycle";

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
after(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment; });

test("an uncommitted hidden render cannot invalidate live browse connections", async () => {
  const never = new Promise<void>(() => {});
  let lifecycleRef: ReturnType<typeof useSftpBrowseConnectionLifecycle> | null = null;
  let renderer: ReactTestRenderer | null = null;

  function Probe({ interactive }: { interactive: boolean }) {
    const nextRef = useSftpBrowseConnectionLifecycle(interactive);
    if (!interactive) throw never;
    lifecycleRef = nextRef;
    return null;
  }

  await act(async () => {
    renderer = create(React.createElement(
      Suspense,
      { fallback: null },
      React.createElement(Probe, { interactive: true }),
    ));
  });
  assert.deepEqual(lifecycleRef!.current, { generation: 0, interactive: true });

  await act(async () => {
    renderer!.update(React.createElement(
      Suspense,
      { fallback: null },
      React.createElement(Probe, { interactive: false }),
    ));
  });

  assert.deepEqual(lifecycleRef!.current, { generation: 0, interactive: true });
  act(() => renderer!.unmount());
});
