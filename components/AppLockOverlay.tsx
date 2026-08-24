import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Fingerprint, KeyRound, Loader2, LockKeyhole } from 'lucide-react';

import { useI18n } from '../application/i18n/I18nProvider';
import type {
  AppLockReason,
  AppLockSystemUnlockResult,
  AppLockSystemUnlockStatus,
  AppLockUnlockResult,
} from '../application/state/useAppLockState';
import { AppLogo } from './AppLogo';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

const RESET_REVEAL_CLICK_COUNT = 5;
const RESET_REVEAL_WINDOW_MS = 1500;
export const APP_LOCK_AUTO_PROMPT_DELAY_MS = 1200;

function isWindowInteractive(): boolean {
  return typeof document === 'undefined'
    || (
      document.visibilityState !== 'hidden'
      && (typeof document.hasFocus !== 'function' || document.hasFocus())
    );
}

interface AppLockOverlayProps {
  locked: boolean;
  reason: AppLockReason | null;
  onUnlock: (password: string) => Promise<AppLockUnlockResult>;
  systemUnlockStatus?: AppLockSystemUnlockStatus;
  onSystemUnlock?: () => Promise<AppLockSystemUnlockResult>;
  onResetAppLock: (currentPassword: string) => Promise<void>;
  autoPromptSystemUnlock?: boolean;
  reopenSignal?: number;
}

export function getAppLockErrorMessageKey(error: AppLockUnlockResult['error'] | null): string | null {
  switch (error) {
    case 'empty':
      return 'appLock.error.emptyPassword';
    case 'incorrect':
      return 'appLock.error.incorrectPassword';
    default:
      return null;
  }
}

export const AppLockOverlay: React.FC<AppLockOverlayProps> = ({
  locked,
  reason,
  onUnlock,
  systemUnlockStatus,
  onSystemUnlock,
  onResetAppLock,
  autoPromptSystemUnlock = false,
  reopenSignal = 0,
}) => {
  const { t } = useI18n();
  const passwordRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<AppLockUnlockResult['error'] | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSystemUnlocking, setIsSystemUnlocking] = useState(false);
  const [isAutoPromptPending, setIsAutoPromptPending] = useState(false);
  const [systemUnlockError, setSystemUnlockError] = useState(false);
  const [passwordFallbackRequested, setPasswordFallbackRequested] = useState(false);
  // Value is only read inside functional updates; keep the setter alone.
  const [, setLogoClickCount] = useState(0);
  const [lastLogoClickAt, setLastLogoClickAt] = useState<number | null>(null);
  const [showReset, setShowReset] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [resetError, setResetError] = useState(false);
  const [windowInteractive, setWindowInteractive] = useState(() => isWindowInteractive());
  const lastAutoUnlockPresentationRef = useRef<string | null>(null);
  const autoUnlockTimerRef = useRef<number | null>(null);
  const canUseSystemUnlock = Boolean(
    systemUnlockStatus?.enabled
    && systemUnlockStatus.available
    && systemUnlockStatus.label
    && onSystemUnlock,
  );
  const showPasswordUnlock = !canUseSystemUnlock
    || passwordFallbackRequested
    || systemUnlockError
    || showReset;

  useEffect(() => {
    const updateWindowInteractive = () => {
      setWindowInteractive(isWindowInteractive());
    };

    updateWindowInteractive();
    document.addEventListener('visibilitychange', updateWindowInteractive);
    window.addEventListener('focus', updateWindowInteractive);
    window.addEventListener('blur', updateWindowInteractive);
    return () => {
      document.removeEventListener('visibilitychange', updateWindowInteractive);
      window.removeEventListener('focus', updateWindowInteractive);
      window.removeEventListener('blur', updateWindowInteractive);
    };
  }, []);

  const overlayRootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!locked) {
      if (autoUnlockTimerRef.current !== null) {
        window.clearTimeout(autoUnlockTimerRef.current);
        autoUnlockTimerRef.current = null;
      }
      setPassword('');
      setError(null);
      setIsSubmitting(false);
      setIsSystemUnlocking(false);
      setIsAutoPromptPending(false);
      setSystemUnlockError(false);
      setPasswordFallbackRequested(false);
      setLogoClickCount(0);
      setLastLogoClickAt(null);
      setShowReset(false);
      setIsResetting(false);
      setResetError(false);
      lastAutoUnlockPresentationRef.current = null;
      return;
    }
    if (!showPasswordUnlock) return;
    const timeout = window.setTimeout(() => passwordRef.current?.focus(), 0);
    return () => window.clearTimeout(timeout);
  }, [locked, showPasswordUnlock]);

  useEffect(() => {
    if (!locked || reason !== 'background' || reopenSignal <= 0) return;
    setPasswordFallbackRequested(false);
    setSystemUnlockError(false);
  }, [locked, reason, reopenSignal]);

  // Soft focus trap + stop ALL app-level keydown while locked.
  // inert does not block window capture (shortkey/hotkey recorders) or window
  // bubble (Snippets Ctrl/Cmd+S). Use window capture + stopImmediate so peer
  // window handlers never run, without stopPropagation so the lock password
  // input still receives the event. Document bubble then stops before window
  // bubble listeners (Codex P2 on 81e1f779).
  useEffect(() => {
    if (!locked) return;

    const onWindowCapture = (event: KeyboardEvent) => {
      // Suppress other window-level keydown handlers registered after us.
      event.stopImmediatePropagation();

      if (event.key !== 'Tab') return;
      const root = overlayRootRef.current;
      if (!root) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!active || !root.contains(active)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    // Unconditional: even when focus is on body, window bubble shortcuts must
    // not fire. Runs on document bubble before window bubble.
    const onDocumentBubble = (event: KeyboardEvent) => {
      event.stopPropagation();
    };

    window.addEventListener('keydown', onWindowCapture, true);
    document.addEventListener('keydown', onDocumentBubble, false);
    return () => {
      window.removeEventListener('keydown', onWindowCapture, true);
      document.removeEventListener('keydown', onDocumentBubble, false);
    };
  }, [locked]);

  // Context menus portal at z-index max (2147483647). Hide it while locked so
  // open right-click menus cannot sit above the lock screen (Codex P2).
  useEffect(() => {
    if (!locked) return;
    const portal = document.getElementById('netcatty-context-menu-root');
    if (!portal) return;
    const prev = portal.style.visibility;
    portal.style.visibility = 'hidden';
    portal.style.pointerEvents = 'none';
    return () => {
      portal.style.visibility = prev;
      portal.style.pointerEvents = 'none'; // portal default is none; children re-enable
    };
  }, [locked]);

  const clearAutoUnlockTimer = useCallback(() => {
    if (autoUnlockTimerRef.current !== null) {
      window.clearTimeout(autoUnlockTimerRef.current);
      autoUnlockTimerRef.current = null;
    }
    setIsAutoPromptPending(false);
  }, []);

  const handleSystemUnlock = useCallback(async () => {
    if (isSystemUnlocking || !onSystemUnlock) return;
    clearAutoUnlockTimer();
    setIsSystemUnlocking(true);
    setSystemUnlockError(false);
    try {
      const result = await onSystemUnlock();
      if (!result.ok) {
        setSystemUnlockError(true);
        setPasswordFallbackRequested(true);
      }
    } catch {
      setSystemUnlockError(true);
      setPasswordFallbackRequested(true);
    } finally {
      setIsSystemUnlocking(false);
    }
  }, [clearAutoUnlockTimer, isSystemUnlocking, onSystemUnlock]);

  const requestAutomaticSystemUnlock = useCallback(() => {
    if (isSystemUnlocking || !onSystemUnlock) return false;
    void handleSystemUnlock();
    return true;
  }, [handleSystemUnlock, isSystemUnlocking, onSystemUnlock]);

  useEffect(() => {
    if (!locked) return;
    if (!autoPromptSystemUnlock) return;
    if (!windowInteractive) return;
    if (showReset) return;
    if (isSystemUnlocking) return;
    if (!systemUnlockStatus?.enabled || !systemUnlockStatus.available || !systemUnlockStatus.label) return;
    if (!onSystemUnlock) return;

    const presentationKey = reason === 'background'
      ? `background:${reopenSignal}`
      : `foreground:${reason ?? 'default'}:${locked}`;
    if (reason === 'background' && reopenSignal <= 0) return;
    if (
      passwordFallbackRequested
      && lastAutoUnlockPresentationRef.current === presentationKey
    ) return;
    if (lastAutoUnlockPresentationRef.current === presentationKey) return;
    if (autoUnlockTimerRef.current !== null) return;

    if (passwordFallbackRequested || systemUnlockError) {
      setPasswordFallbackRequested(false);
      setSystemUnlockError(false);
    }
    setIsAutoPromptPending(true);
    const timer = window.setTimeout(() => {
      if (autoUnlockTimerRef.current !== timer) return;
      autoUnlockTimerRef.current = null;
      setIsAutoPromptPending(false);
      if (!requestAutomaticSystemUnlock()) return;
      lastAutoUnlockPresentationRef.current = presentationKey;
    }, APP_LOCK_AUTO_PROMPT_DELAY_MS);
    autoUnlockTimerRef.current = timer;

    return () => {
      if (autoUnlockTimerRef.current !== timer) return;
      window.clearTimeout(timer);
      autoUnlockTimerRef.current = null;
      setIsAutoPromptPending(false);
    };
  }, [
    locked,
    autoPromptSystemUnlock,
    reason,
    reopenSignal,
    windowInteractive,
    onSystemUnlock,
    systemUnlockStatus?.available,
    systemUnlockStatus?.enabled,
    systemUnlockStatus?.label,
    passwordFallbackRequested,
    systemUnlockError,
    showReset,
    isSystemUnlocking,
    requestAutomaticSystemUnlock,
  ]);

  if (!locked) return null;

  const errorKey = getAppLockErrorMessageKey(error);
  const SystemUnlockIcon = systemUnlockStatus?.platform === 'darwin' ? Fingerprint : KeyRound;
  const isSystemButtonLoading = isAutoPromptPending || isSystemUnlocking;

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    const result = await onUnlock(password);
    if (!result.ok) {
      setError(result.error);
      setIsSubmitting(false);
      return;
    }
    setPassword('');
    setIsSubmitting(false);
  };

  const handleLogoClick = () => {
    const now = Date.now();
    setLogoClickCount((current) => {
      const isQuickSequence = lastLogoClickAt !== null && now - lastLogoClickAt <= RESET_REVEAL_WINDOW_MS;
      const nextCount = isQuickSequence ? current + 1 : 1;
      if (nextCount >= RESET_REVEAL_CLICK_COUNT) {
        setShowReset(true);
      }
      return nextCount;
    });
    setLastLogoClickAt(now);
  };

  const handleReset = async () => {
    if (isResetting) return;
    setIsResetting(true);
    setResetError(false);
    try {
      await onResetAppLock(password);
    } catch {
      setResetError(true);
      setIsResetting(false);
    }
  };

  return (
    // Overlay covers the title bar, and is the only chrome on a locked first
    // paint, so the backdrop owns the window drag region.
    <div
      ref={overlayRootRef}
      className="fixed inset-0 flex items-center justify-center bg-background px-6 text-foreground app-drag"
      style={{ zIndex: 2147483647 }}
      role="dialog"
      data-state="open"
      data-app-lock-overlay=""
      aria-modal="true"
      aria-labelledby="app-lock-title"
    >
      <form
        className="flex w-full max-w-[360px] flex-col items-center gap-5 app-no-drag"
        onSubmit={handleSubmit}
      >
        <button
          type="button"
          className="flex h-24 w-24 items-center justify-center border-0 bg-transparent p-0 shadow-none transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-label={t('appLock.logoLabel')}
          data-testid="app-lock-logo-easter-egg"
          onClick={handleLogoClick}
        >
          <AppLogo className="h-full w-full" />
        </button>

        <h1 id="app-lock-title" className="text-center text-xl font-semibold tracking-normal">
          {t('appLock.title')}
        </h1>

        {showPasswordUnlock && (
          <>
            <div className="w-full space-y-2">
              <Label htmlFor="app-lock-password" className="sr-only">
                {t('appLock.passwordLabel')}
              </Label>
              <div className="relative">
                <Input
                  ref={passwordRef}
                  id="app-lock-password"
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  placeholder={t('appLock.passwordPlaceholder')}
                  disabled={isSubmitting}
                  aria-invalid={Boolean(errorKey)}
                  aria-describedby={errorKey ? 'app-lock-error' : undefined}
                  className="pr-12"
                  onChange={(event) => {
                    setPassword(event.target.value);
                    if (error) setError(null);
                  }}
                />
                <span
                  className="pointer-events-none absolute inset-y-px right-px flex w-10 items-center justify-center rounded-r-md bg-muted/30 text-muted-foreground"
                  data-testid="app-lock-password-lock-icon"
                  aria-hidden="true"
                >
                  <LockKeyhole className="h-4 w-4" strokeWidth={2.25} />
                </span>
              </div>
              {errorKey && (
                <p id="app-lock-error" className="text-sm text-destructive">
                  {t(errorKey)}
                </p>
              )}
            </div>

            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? t('appLock.unlocking') : t('appLock.unlock')}
            </Button>
          </>
        )}

        {canUseSystemUnlock && systemUnlockStatus?.label && (
          <div className="w-full space-y-2">
            <Button
              type="button"
              variant={showPasswordUnlock ? 'outline' : 'default'}
              className="w-full"
              disabled={isSystemButtonLoading}
              data-testid="app-lock-system-unlock-button"
              onClick={() => void handleSystemUnlock()}
            >
              {isSystemButtonLoading ? (
                <Loader2
                  className="mr-2 h-4 w-4 animate-spin"
                  data-testid="app-lock-system-unlock-loading"
                  aria-hidden="true"
                />
              ) : (
                <SystemUnlockIcon
                  className="mr-2 h-4 w-4"
                  data-testid={systemUnlockStatus.platform === 'darwin'
                    ? 'app-lock-system-unlock-touch-id-icon'
                    : 'app-lock-system-unlock-windows-icon'}
                  aria-hidden="true"
                />
              )}
              <span aria-live="polite">
                {isAutoPromptPending
                  ? t('appLock.systemUnlock.preparing').replace('{label}', systemUnlockStatus.label)
                  : isSystemUnlocking
                    ? t('appLock.systemUnlock.verifying').replace('{label}', systemUnlockStatus.label)
                    : t('appLock.systemUnlock.unlockWith').replace('{label}', systemUnlockStatus.label)}
              </span>
            </Button>
            {!showPasswordUnlock && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto w-full py-1 text-muted-foreground"
                onClick={() => {
                  lastAutoUnlockPresentationRef.current = reason === 'background'
                    ? `background:${reopenSignal}`
                    : `foreground:${reason ?? 'default'}:${locked}`;
                  clearAutoUnlockTimer();
                  setPasswordFallbackRequested(true);
                  setSystemUnlockError(false);
                }}
              >
                {t('appLock.usePassword')}
              </Button>
            )}
            {systemUnlockError && (
              <p className="text-sm text-destructive">
                {t('appLock.systemUnlock.error')}
              </p>
            )}
          </div>
        )}

        {showReset && (
          <div
            className="w-full rounded-lg border border-border/70 bg-card p-3 text-left shadow-sm"
            role="region"
            aria-live="polite"
          >
            <div className="space-y-1">
              <p className="text-sm font-medium">{t('appLock.reset.title')}</p>
              <p className="text-xs leading-5 text-muted-foreground">
                {t('appLock.reset.description')}
              </p>
            </div>
            {resetError && (
              <p className="mt-2 text-xs text-destructive">
                {t('appLock.reset.error')}
              </p>
            )}
            <div className="mt-3 flex gap-2">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                disabled={isResetting}
                onClick={() => {
                  setShowReset(false);
                  setLogoClickCount(0);
                  setLastLogoClickAt(null);
                  setResetError(false);
                }}
              >
                {t('appLock.reset.cancel')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                className="flex-1"
                disabled={isResetting}
                onClick={handleReset}
              >
                {isResetting ? t('appLock.reset.resetting') : t('appLock.reset.confirm')}
              </Button>
            </div>
          </div>
        )}
      </form>
    </div>
  );
};
