import type { RuntimeAppLockState } from "../../application/state/useAppLockRuntime";

type UnlockResult =
  | { ok: true }
  | { ok: false; error: "empty" | "incorrect" };

type HarnessOptions = {
  runtimeState: RuntimeAppLockState;
  unlockPassword?: string;
  systemUnlockStatus?: {
    supported: boolean;
    available: boolean;
    enabled: boolean;
    platform: "darwin" | "win32" | "unsupported";
    label: "Touch ID" | "Windows Hello" | null;
    reason: string | null;
  };
  systemUnlockResult?: { ok: true } | { ok: false; error: "disabled" | "not-locked" | "unsupported" | "unavailable" | "cancelled" | "failed" };
};

const TEST_PASSWORD_VERIFIER = {
  version: 1 as const,
  algorithm: "PBKDF2-SHA256" as const,
  iterations: 210000,
  salt: "AAAAAAAAAAAAAAAAAAAAAA==",
  hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

function cloneRuntimeState(input: RuntimeAppLockState): RuntimeAppLockState {
  return {
    ...input,
  };
}

export function createAppLockBridgeHarness(options: HarnessOptions) {
  let runtimeState = cloneRuntimeState(options.runtimeState);
  let nextVersion = runtimeState.version + 1;
  let unlockPassword = options.unlockPassword ?? "secret";
  const runtimeListeners = new Set<(state: RuntimeAppLockState) => void>();
  const reopenListeners = new Set<() => void>();
  const rendererReadyCalls: number[] = [];
  const unlockAttempts: string[] = [];
  const activityReports: number[] = [];
  let systemUnlockStatus = options.systemUnlockStatus ?? {
    supported: false,
    available: false,
    enabled: false,
    platform: "unsupported" as const,
    label: null,
    reason: null,
  };
  let systemUnlockResult = options.systemUnlockResult ?? { ok: true as const };
  let systemUnlockCount = 0;
  let resetCount = 0;
  const resetAttempts: string[] = [];
  let runtimeFetchCount = 0;

  const emitRuntimeState = () => {
    const snapshot = cloneRuntimeState(runtimeState);
    for (const listener of runtimeListeners) {
      listener(snapshot);
    }
  };

  const setRuntimeState = (nextState: Partial<RuntimeAppLockState>, { notify = true } = {}) => {
    runtimeState = {
      ...runtimeState,
      ...nextState,
      version: nextVersion++,
    };
    if (notify) emitRuntimeState();
  };

  const bridge: NetcattyBridge = {
    getAppLockRuntimeState: async () => {
      runtimeFetchCount += 1;
      return cloneRuntimeState(runtimeState);
    },
    onAppLockRuntimeStateChanged: (listener) => {
      runtimeListeners.add(listener);
      return () => runtimeListeners.delete(listener);
    },
    requestAppLockUnlock: async (password) => {
      unlockAttempts.push(password);
      if (!password) return { ok: false, error: "empty" } satisfies UnlockResult;
      if (password !== unlockPassword) return { ok: false, error: "incorrect" } satisfies UnlockResult;
      setRuntimeState({
        initialized: true,
        locked: false,
        reason: null,
        lastUnlockedAt: Date.now(),
        lastActivityAt: Date.now(),
      });
      return { ok: true } satisfies UnlockResult;
    },
    requestAppLockReset: async (currentPassword) => {
      resetCount += 1;
      resetAttempts.push(currentPassword);
      if (!currentPassword) return { ok: false, error: "empty-current" };
      if (currentPassword !== unlockPassword) return { ok: false, error: "incorrect" };
      setRuntimeState({
        initialized: true,
        locked: false,
        reason: null,
        lastUnlockedAt: Date.now(),
        lastActivityAt: Date.now(),
      });
      return {
        enabled: false,
        timeoutMinutes: 15,
        systemUnlockEnabled: false,
        systemUnlockAutoPromptEnabled: false,
        passwordVerifier: null,
      };
    },
    getAppLockSystemUnlockStatus: async () => ({ ...systemUnlockStatus }),
    setAppLockSystemUnlockEnabled: async (input) => {
      systemUnlockStatus = {
        ...systemUnlockStatus,
        enabled: input.enabled,
      };
      return {
        enabled: true,
        timeoutMinutes: 15,
        systemUnlockEnabled: input.enabled,
        systemUnlockAutoPromptEnabled: input.enabled && input.autoPromptEnabled === true,
        passwordVerifier: TEST_PASSWORD_VERIFIER,
      };
    },
    requestAppLockSystemUnlock: async () => {
      systemUnlockCount += 1;
      if (!systemUnlockResult.ok) return systemUnlockResult;
      setRuntimeState({
        initialized: true,
        locked: false,
        reason: null,
        lastUnlockedAt: Date.now(),
        lastActivityAt: Date.now(),
      });
      return { ok: true };
    },
    setAppLockRuntimeLocked: async (reason) => {
      setRuntimeState({
        initialized: true,
        locked: true,
        reason,
        lastLockedAt: Date.now(),
      });
      return cloneRuntimeState(runtimeState);
    },
    reportAppLockActivity: async () => {
      activityReports.push(Date.now());
      setRuntimeState({
        lastActivityAt: Date.now(),
      }, { notify: false });
      return cloneRuntimeState(runtimeState);
    },
    onAppLockReopen: (listener) => {
      reopenListeners.add(listener);
      return () => reopenListeners.delete(listener);
    },
    rendererReady: () => {
      rendererReadyCalls.push(Date.now());
    },
  };

  return {
    bridge,
    getRuntimeState() {
      return cloneRuntimeState(runtimeState);
    },
    getRuntimeFetchCount() {
      return runtimeFetchCount;
    },
    setRuntimeState,
    setUnlockPassword(nextPassword: string) {
      unlockPassword = nextPassword;
    },
    emitReopen() {
      for (const listener of reopenListeners) {
        listener();
      }
    },
    getUnlockAttempts() {
      return [...unlockAttempts];
    },
    getRendererReadyCallCount() {
      return rendererReadyCalls.length;
    },
    getActivityReportCount() {
      return activityReports.length;
    },
    getResetCount() {
      return resetCount;
    },
    getResetAttempts() {
      return [...resetAttempts];
    },
    getSystemUnlockCount() {
      return systemUnlockCount;
    },
    setSystemUnlockResult(nextResult: typeof systemUnlockResult) {
      systemUnlockResult = nextResult;
    },
    setSystemUnlockStatus(nextStatus: typeof systemUnlockStatus) {
      systemUnlockStatus = nextStatus;
    },
  };
}
