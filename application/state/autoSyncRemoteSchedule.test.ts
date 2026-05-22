import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getRuntimeRemoteCheckIntervalMs,
  shouldRunRuntimeRemoteCheck,
} from './autoSyncRemoteSchedule';

test("runtime remote checks wait for the startup check to finish", () => {
  assert.equal(
    shouldRunRuntimeRemoteCheck({
      hasAnyConnectedProvider: true,
      autoSyncEnabled: true,
      isUnlocked: true,
      startupRemoteCheckDone: false,
      isSyncing: false,
      isSyncRunning: false,
      remoteCheckInFlight: false,
      now: 10_000,
      lastRemoteCheckAt: null,
      minIntervalMs: 30_000,
    }),
    false,
  );
});

test("runtime remote checks run immediately after startup gate opens", () => {
  assert.equal(
    shouldRunRuntimeRemoteCheck({
      hasAnyConnectedProvider: true,
      autoSyncEnabled: true,
      isUnlocked: true,
      startupRemoteCheckDone: true,
      isSyncing: false,
      isSyncRunning: false,
      remoteCheckInFlight: false,
      now: 10_000,
      lastRemoteCheckAt: null,
      minIntervalMs: 30_000,
    }),
    true,
  );
});

test("runtime remote checks respect the minimum interval", () => {
  const common = {
    hasAnyConnectedProvider: true,
    autoSyncEnabled: true,
    isUnlocked: true,
    startupRemoteCheckDone: true,
    isSyncing: false,
    isSyncRunning: false,
    remoteCheckInFlight: false,
    minIntervalMs: 30_000,
  };

  assert.equal(
    shouldRunRuntimeRemoteCheck({
      ...common,
      now: 35_000,
      lastRemoteCheckAt: 10_000,
    }),
    false,
  );
  assert.equal(
    shouldRunRuntimeRemoteCheck({
      ...common,
      now: 40_000,
      lastRemoteCheckAt: 10_000,
    }),
    true,
  );
});

test("forced runtime remote checks bypass only the interval gate", () => {
  const common = {
    hasAnyConnectedProvider: true,
    autoSyncEnabled: true,
    isUnlocked: true,
    startupRemoteCheckDone: true,
    isSyncing: false,
    isSyncRunning: false,
    remoteCheckInFlight: false,
    minIntervalMs: 30_000,
    force: true,
  };

  assert.equal(
    shouldRunRuntimeRemoteCheck({
      ...common,
      now: 35_000,
      lastRemoteCheckAt: 10_000,
    }),
    true,
  );
  assert.equal(
    shouldRunRuntimeRemoteCheck({
      ...common,
      isSyncing: true,
      now: 35_000,
      lastRemoteCheckAt: 10_000,
    }),
    false,
  );
});

test("configured auto-sync intervals map to bounded remote recheck intervals", () => {
  assert.equal(getRuntimeRemoteCheckIntervalMs(1), 30_000);
  assert.equal(getRuntimeRemoteCheckIntervalMs(10), 300_000);
  assert.equal(getRuntimeRemoteCheckIntervalMs(120), 300_000);
});
