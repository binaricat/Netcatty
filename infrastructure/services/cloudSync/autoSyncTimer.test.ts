import assert from "node:assert/strict";
import test from "node:test";
import {
  setAutoSyncImpl,
  startAutoSyncImpl,
  stopAutoSyncImpl,
} from "./syncAllStorageMethods";

test("CloudSyncManager autoSync preferences do not schedule a dead SYNC_STARTED interval", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });

  let emitCalls = 0;
  let stateNotifications = 0;
  let saveCalls = 0;
  let startCalls = 0;
  let stopCalls = 0;

  const manager = {
    state: {
      securityState: "UNLOCKED",
      autoSyncEnabled: false,
      autoSyncInterval: 5,
    },
    saveSyncConfig() {
      saveCalls += 1;
    },
    notifyStateChange() {
      stateNotifications += 1;
    },
    emit() {
      emitCalls += 1;
    },
    startAutoSync() {
      startCalls += 1;
      startAutoSyncImpl.call(this);
    },
    stopAutoSync() {
      stopCalls += 1;
      stopAutoSyncImpl.call(this);
    },
  };

  try {
    setAutoSyncImpl.call(manager, true, 1);
    assert.equal(manager.state.autoSyncEnabled, true);
    assert.equal(manager.state.autoSyncInterval, 1);
    assert.equal(saveCalls, 1);
    assert.equal(stateNotifications, 1);
    assert.equal(startCalls, 1, "startAutoSync remains callable as a compatibility no-op");

    // Advancing 10 minutes must not trigger any dead SYNC_STARTED emission or state churn
    t.mock.timers.tick(10 * 60 * 1000);
    assert.equal(emitCalls, 0);
    assert.equal(stateNotifications, 1);

    setAutoSyncImpl.call(manager, false);
    assert.equal(manager.state.autoSyncEnabled, false);
    assert.equal(stopCalls, 1, "stopAutoSync remains callable as a compatibility no-op");
  } finally {
    t.mock.timers.reset();
  }
});
