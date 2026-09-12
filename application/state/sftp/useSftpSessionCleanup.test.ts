import assert from "node:assert/strict";
import test, { after } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { useSftpSessionCleanup } from "./useSftpSessionCleanup";

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
after(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment; });

test("cleanup marks the SFTP owner disposed before a late open can register", async () => {
  const sessionsRef = { current: new Map<string, string>() };
  let disposedRef: { current: boolean } | null = null;
  let renderer: ReactTestRenderer | null = null;

  function Probe() {
    disposedRef = useSftpSessionCleanup(sessionsRef);
    return null;
  }

  await act(async () => {
    renderer = create(React.createElement(Probe));
  });
  assert.equal(disposedRef?.current, false);

  await act(async () => renderer?.unmount());
  assert.equal(disposedRef?.current, true);
});
