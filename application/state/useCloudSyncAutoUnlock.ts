import { useEffect, useState } from 'react';

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
// Dedupe attempts per manager (not per hook instance): every consumer of the
// same manager observes the same events, and without sharing they would each
// run the expensive PBKDF2 derivation inside manager.unlock.
const attemptedAttemptByManager = new WeakMap<AutoUnlockManager, string | null>();
// Mounted consumers register a retry trigger here so an attempt can be handed
// off when its owner unmounts (see the cleanup below).
const retryListenersByManager = new WeakMap<AutoUnlockManager, Set<() => void>>();

/** Retry a locked peer window when the setting window finishes sharing its key. */
export function useCloudSyncAutoUnlock(input: {
  securityState: string;
  masterKeyIdentity: string | null;
  manager: AutoUnlockManager;
  bridge: AutoUnlockBridge | null | undefined;
}) {
  const { securityState, masterKeyIdentity, manager, bridge } = input;
  const [passwordRevision, setPasswordRevision] = useState(0);

  useEffect(() => bridge?.onCloudSyncSessionPasswordAvailable?.(() => {
    setPasswordRevision(value => value + 1);
  }), [bridge]);

  useEffect(() => {
    if (!masterKeyIdentity) return;
    const attempt = JSON.stringify([masterKeyIdentity, passwordRevision]);
    if (securityState === 'UNLOCKED') {
      unlockedIdentityByManager.set(manager, masterKeyIdentity);
      attemptedAttemptByManager.set(manager, attempt);
      return;
    }
    if (securityState !== 'LOCKED') return;
    // Once this key has been unlocked, a later lock is intentional. A peer
    // sharing its password must not undo it, regardless of notification order.
    if (unlockedIdentityByManager.get(manager) === masterKeyIdentity) return;
    // Register before the dedup check: a consumer that only observes an
    // in-flight attempt must still be reachable for an ownership handoff.
    let listeners = retryListenersByManager.get(manager);
    if (!listeners) {
      listeners = new Set();
      retryListenersByManager.set(manager, listeners);
    }
    const notifyRetry = () => setPasswordRevision(value => value + 1);
    listeners.add(notifyRetry);
    if (attemptedAttemptByManager.get(manager) === attempt) {
      return () => listeners.delete(notifyRetry);
    }
    attemptedAttemptByManager.set(manager, attempt);
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
      listeners.delete(notifyRetry);
      // React StrictMode can immediately remount the same effect.
      if (awaitingPassword && attemptedAttemptByManager.get(manager) === attempt) {
        attemptedAttemptByManager.set(manager, null);
        // Hand the attempt off: this consumer's in-flight password request is
        // discarded as cancelled, but other mounted consumers already returned
        // at the dedup check above, so they must be nudged to retry.
        for (const notify of listeners) notify();
      }
    };
  }, [securityState, masterKeyIdentity, manager, bridge, passwordRevision]);
}
