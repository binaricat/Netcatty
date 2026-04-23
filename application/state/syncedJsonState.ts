export interface SyncedJsonStateTracker {
  incomingSignature: string | null;
  localVersion: number;
  broadcastedLocalVersion: number;
}

export const createSyncedJsonStateTracker = (): SyncedJsonStateTracker => ({
  incomingSignature: null,
  localVersion: 0,
  broadcastedLocalVersion: 0,
});

export const recordLocalSyncedJsonStateChange = (
  tracker: SyncedJsonStateTracker,
  prevSignature: string,
  nextSignature: string,
): SyncedJsonStateTracker => {
  if (prevSignature === nextSignature) {
    return tracker;
  }

  return {
    ...tracker,
    localVersion: tracker.localVersion + 1,
  };
};

export const recordIncomingSyncedJsonStateChange = (
  tracker: SyncedJsonStateTracker,
  prevSignature: string,
  nextSignature: string,
): SyncedJsonStateTracker => {
  if (prevSignature === nextSignature) {
    return tracker;
  }

  return {
    ...tracker,
    incomingSignature: nextSignature,
  };
};

export const finalizeSyncedJsonStateBroadcast = (
  tracker: SyncedJsonStateTracker,
  currentSignature: string,
): { nextTracker: SyncedJsonStateTracker; shouldBroadcast: boolean } => {
  const hasPendingUnbroadcastLocalChanges =
    tracker.localVersion !== tracker.broadcastedLocalVersion;

  if (tracker.incomingSignature === currentSignature && !hasPendingUnbroadcastLocalChanges) {
    return {
      nextTracker: {
        ...tracker,
        incomingSignature: null,
      },
      shouldBroadcast: false,
    };
  }

  return {
    nextTracker: {
      incomingSignature: null,
      localVersion: tracker.localVersion,
      broadcastedLocalVersion: tracker.localVersion,
    },
    shouldBroadcast: true,
  };
};
