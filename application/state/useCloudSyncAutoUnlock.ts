import { useEffect, useRef, useState } from 'react';

interface AutoUnlockManager {
  unlock(password: string): Promise<boolean>;
}
interface AutoUnlockBridge {
  cloudSyncGetSessionPassword?(): Promise<string | null>;
  cloudSyncClearSessionPassword?(): Promise<boolean>;
  onCloudSyncSessionPasswordAvailable?(callback: () => void): () => void;
}

/** Retry a locked peer window when the setting window finishes sharing its key. */
export function useCloudSyncAutoUnlock(input: {
  securityState: string;
  masterKeyIdentity: string | null;
  manager: AutoUnlockManager;
  bridge: AutoUnlockBridge | null | undefined;
}) {
  const { securityState, masterKeyIdentity, manager, bridge } = input;
  const [passwordRevision, setPasswordRevision] = useState(0);
  const attemptedRef = useRef<string | null>(null);

  useEffect(() => bridge?.onCloudSyncSessionPasswordAvailable?.(() => {
    setPasswordRevision(value => value + 1);
  }), [bridge]);

  useEffect(() => {
    if (!masterKeyIdentity) return;
    const attempt = JSON.stringify([masterKeyIdentity, passwordRevision]);
    if (securityState === 'UNLOCKED') {
      attemptedRef.current = attempt;
      return;
    }
    if (securityState !== 'LOCKED') return;
    if (attemptedRef.current === attempt) return;
    attemptedRef.current = attempt;
    let cancelled = false;
    let awaitingPassword = true;
    void (async () => {
      try {
        const password = await bridge?.cloudSyncGetSessionPassword?.();
        awaitingPassword = false;
        if (cancelled || !password) return;
        const ok = await manager.unlock(password);
        if (!cancelled && !ok) {
          await bridge?.cloudSyncClearSessionPassword?.();
        }
      } catch {
        // Explicit sync actions surface errors; keep auto-unlock silent.
      }
    })();
    return () => {
      cancelled = true;
      // React StrictMode can immediately remount the same effect.
      if (awaitingPassword && attemptedRef.current === attempt) attemptedRef.current = null;
    };
  }, [securityState, masterKeyIdentity, manager, bridge, passwordRevision]);
}
