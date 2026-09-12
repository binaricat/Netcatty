import assert from "node:assert/strict";
import test from "node:test";

import { disconnectSftpPaneAfterConfirmation } from "./hooks/useSftpViewPaneActions.ts";

test("host switching waits for the previous SFTP disconnect to finish", async () => {
  let releaseDisconnect: (() => void) | undefined;
  let settled = false;
  const result = disconnectSftpPaneAfterConfirmation({
    confirmClose: async () => true,
    disconnect: async () => new Promise<void>((resolve) => {
      releaseDisconnect = resolve;
    }),
  }).then((value) => {
    settled = true;
    return value;
  });

  await Promise.resolve();
  assert.equal(settled, false);
  releaseDisconnect?.();
  assert.equal(await result, true);
});

test("a cancelled editor prompt never disconnects the current SFTP pane", async () => {
  let disconnects = 0;
  const result = await disconnectSftpPaneAfterConfirmation({
    confirmClose: async () => false,
    disconnect: async () => {
      disconnects += 1;
    },
  });

  assert.equal(result, false);
  assert.equal(disconnects, 0);
});
