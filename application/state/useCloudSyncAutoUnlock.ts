import { useEffect, useRef, useState } from 'react';

interface AutoUnlockManager {
  unlock(password: string): Promise<boolean>;
}
interface AutoUnlockBridge {
  cloudSyncGetSessionPassword?(): Promise<string | null>;
  onCloudSyncSessionPasswordAvailable?(callback: () => void): () => void;
}

// A renderer can mount several consumers of the same manager. Remember the
// unlocked key across consumer unmounts so reopening settings cannot undo a lock.
const unlockedIdentityByManager = new WeakMap<AutoUnlockManager, string>();

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
      unlockedIdentityByManager.set(manager, masterKeyIdentity);
      attemptedRef.current = attempt;
      return;
    }
    if (securityState !== 'LOCKED') return;
    // Once this key has been unlocked, a later lock is intentional. A peer
    // sharing its password must not undo it, regardless of notification order.
    if (unlockedIdentityByManager.get(manager) === masterKeyIdentity) return;
    if (attemptedRef.current === attempt) return;
    attemptedRef.current = attempt;
    let cancelled = false;
    let awaitingPassword = true;
    void (async () => {
      try {
        const password = await bridge?.cloudSyncGetSessionPassword?.();
        awaitingPassword = false;
        if (cancelled || !password) return;
        // A failed attempt must not clear the shared password: the config and
        // the password travel over unordered channels (localStorage vs IPC),
        // so this attempt may have raced a master-key rotation and the
        // password may match the config that is still in flight. The attempt
        // is deduped per [identity, revision], so keeping the password lets
        // the arriving config trigger a retry instead of stranding the vault.
        await manager.unlock(password);
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
