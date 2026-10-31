import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { useSystemManagerBackend } from '../../application/state/useSystemManagerBackend';
import { resolveHostAutofillPassword } from '../../domain/sshAuth';
import {
  multiplexerScopeNeedsSudo,
  sortMultiplexerUsers,
} from '../../domain/systemManager/muxUsers';
import type { MultiplexerScope, MultiplexerUser } from '../../domain/systemManager/types';
import type { Host, Identity, SSHKey } from '../../types';
import { SystemPanelPromptDialog } from './SystemPanelPromptDialog';

type Backend = ReturnType<typeof useSystemManagerBackend>;

interface ScopedResult {
  success: boolean;
  error?: string;
  errorCode?: string;
}

interface UseMultiplexerScopeOptions {
  sessionId: string;
  host: Host | null;
  keys: SSHKey[];
  identities?: Identity[];
  onUpdateHost?: (host: Host) => void;
  /** Fallback name for the connection user before the user list loads. */
  fallbackUser?: string;
  isVisible: boolean;
  backend: Backend;
}

/**
 * Shared "which user's sessions" state for the tmux/zellij manager tabs.
 * Selecting another host user runs multiplexer commands through sudo; the
 * saved SSH password is used automatically, and when none is stored a prompt
 * collects it once and persists it onto the host's connection config.
 */
export function useMultiplexerScope({
  sessionId,
  host,
  keys,
  identities,
  onUpdateHost,
  fallbackUser,
  isVisible,
  backend,
}: UseMultiplexerScopeOptions) {
  const { t } = useI18n();
  const [users, setUsers] = useState<MultiplexerUser[]>([]);
  const [currentUser, setCurrentUser] = useState(fallbackUser ?? '');
  const [currentUid, setCurrentUid] = useState<number | null>(null);
  const [selectedUser, setSelectedUser] = useState('');
  const [passwordPrompt, setPasswordPrompt] = useState<{ incorrect: boolean } | null>(null);
  const pendingRetryRef = useRef<((password: string) => void) | null>(null);
  const pendingCancelRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setSelectedUser('');
    setUsers([]);
    setCurrentUser(fallbackUser ?? '');
    setCurrentUid(null);
  }, [fallbackUser, sessionId]);

  useEffect(() => {
    if (!isVisible) return;
    let cancelled = false;
    void backend.listMultiplexerUsers(sessionId).then((result) => {
      if (cancelled || !result.success) return;
      setUsers(result.users ?? []);
      if (result.currentUser) setCurrentUser(result.currentUser);
      if (typeof result.currentUid === 'number') setCurrentUid(result.currentUid);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [backend, isVisible, sessionId]);

  const effectiveUser = selectedUser || currentUser;
  const sortedUsers = useMemo(
    () => sortMultiplexerUsers(users, currentUser),
    [currentUser, users],
  );

  const needsSudo = multiplexerScopeNeedsSudo(effectiveUser, currentUser);

  const resolveSavedPassword = useCallback(
    () => (host ? resolveHostAutofillPassword({ host, keys, identities }) : undefined),
    [host, identities, keys],
  );

  /**
   * Run `fn` scoped to the selected user. When sudo rejects the saved (or
   * absent) password, the user is prompted once; the entered password is
   * saved onto the SSH host config and the call retried.
   */
  const runScoped = useCallback(async <T extends ScopedResult>(
    fn: (scope?: MultiplexerScope) => Promise<T>,
  ): Promise<T> => {
    if (!multiplexerScopeNeedsSudo(effectiveUser, currentUser)) return fn(undefined);
    const targetUid = users.find((u) => u.name === effectiveUser)?.uid;
    // Root reads any user's tmux sockets directly — skip sudo (and its PAM
    // cost / password prompt) entirely.
    const directAsRoot = currentUid === 0 && typeof targetUid === 'number' && targetUid !== 0;
    const buildScope = (password?: string): MultiplexerScope => ({
      user: effectiveUser,
      sudoPassword: password,
      targetUid,
      directAsRoot,
    });
    const result = await fn(buildScope(resolveSavedPassword()));
    if (result.success || (
      result.errorCode !== 'sudoPasswordRequired' && result.errorCode !== 'sudoPasswordIncorrect'
    )) {
      return result;
    }
    // A poll loop must not stack prompts: one pending dialog at a time.
    if (pendingRetryRef.current) return result;
    return new Promise<T>((resolve) => {
      pendingRetryRef.current = (password: string) => {
        if (host && onUpdateHost) {
          onUpdateHost({ ...host, password, savePassword: true });
        }
        void fn(buildScope(password)).then(resolve);
      };
      pendingCancelRef.current = () => resolve(result);
      setPasswordPrompt({ incorrect: result.errorCode === 'sudoPasswordIncorrect' });
    });
  }, [currentUid, currentUser, effectiveUser, host, onUpdateHost, resolveSavedPassword, users]);

  const passwordDialog = (
    <SystemPanelPromptDialog
      open={passwordPrompt !== null}
      title={t('systemManager.mux.sudoPassword.title')}
      description={t('systemManager.mux.sudoPassword.desc', { user: effectiveUser })}
      fields={[{
        id: 'password',
        label: t('systemManager.mux.sudoPassword.field'),
        masked: true,
      }]}
      confirmLabel={t('common.save')}
      error={passwordPrompt?.incorrect ? t('systemManager.mux.sudoPassword.incorrect') : null}
      onOpenChange={(open) => {
        if (open) return;
        setPasswordPrompt(null);
        pendingRetryRef.current = null;
        pendingCancelRef.current?.();
        pendingCancelRef.current = null;
      }}
      onSubmit={(values) => {
        setPasswordPrompt(null);
        const retry = pendingRetryRef.current;
        pendingRetryRef.current = null;
        pendingCancelRef.current = null;
        retry?.(values.password);
      }}
    />
  );

  return {
    users: sortedUsers,
    currentUser,
    /** Selected login user; falls back to the connection user when untouched. */
    selectedUser: effectiveUser,
    setSelectedUser,
    needsSudo,
    runScoped,
    passwordDialog,
  };
}
