import test from "node:test";
import assert from "node:assert/strict";

import {
  consumePendingDualPaneSftpRequest,
  requestOpenDualPaneSftp,
  resetDualPaneSftpOpenStore,
  subscribeDualPaneSftpOpen,
} from "./sftpDualPaneOpenStore.ts";

test("requestOpenDualPaneSftp stores a pending request when nothing is listening", () => {
  resetDualPaneSftpOpenStore();
  requestOpenDualPaneSftp("host-1");
  assert.deepEqual(consumePendingDualPaneSftpRequest(), { hostId: "host-1", seq: 1 });
  assert.equal(consumePendingDualPaneSftpRequest(), null);
});

test("requestOpenDualPaneSftp delivers live to subscribers instead of queueing", () => {
  resetDualPaneSftpOpenStore();
  const received: string[] = [];
  const unsubscribe = subscribeDualPaneSftpOpen((request) => {
    received.push(request.hostId);
  });
  requestOpenDualPaneSftp("host-2");
  assert.deepEqual(received, ["host-2"]);
  assert.equal(consumePendingDualPaneSftpRequest(), null);
  unsubscribe();
});
