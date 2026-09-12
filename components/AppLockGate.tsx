import React, { useEffect, useRef, useState } from 'react';

import { I18nProvider } from '../application/i18n/I18nProvider';
import { useAppLockBridge } from '../application/state/useAppLockBridge';
import { type AppLockReason, useAppLockState } from '../application/state/useAppLockState';
import { useSettingsState } from '../application/state/useSettingsState';
import { ToastProvider } from './ui/toast';
import { TooltipProvider } from './ui/tooltip';
import { AppLockOverlay } from './AppLockOverlay';

type SettingsState = ReturnType<typeof useSettingsState>;
type AppLockState = ReturnType<typeof useAppLockState>;

export interface AppLockGateRenderContext {
  settings: SettingsState;
  appLock: AppLockState;
}

interface AppLockGateProps {
  children: (ctx: AppLockGateRenderContext) => React.ReactNode;
  notifyRendererReady?: boolean;
  /**
   * Mount route children immediately (even before app-lock init / while locked).
   * Terminal popups need this so their one-shot config IPC listeners register
   * before main's post-loadURL send is only held in preload pending state —
   * AppLockGate otherwise withholds children until async lock state resolves.
   */
  forceRenderChildren?: boolean;
  settingsOptions?: Parameters<typeof useSettingsState>[0];
}

interface AppLockGateDeps {
  useSettingsState: typeof useSettingsState;
  useAppLockState: typeof useAppLockState;
  useAppLockBridge: typeof useAppLockBridge;
}

/**
 * Withhold first content mount while the gate is locked for any reason
 * (startup / idle / background / manual). A new renderer that reports ready
 * before unlock would let main deliver ssh:// deep links into App handlers and
 * start connections behind the lock overlay. Once children have mounted (e.g.
 * idle re-lock after use), keep them mounted under the overlay.
 */
export function shouldRenderAppLockGateChildren(input: {
  initialized: boolean;
  locked: boolean;
  lockReason: AppLockReason | null;
  hasRenderedChildren: boolean;
  forceRenderChildren?: boolean;
}): boolean {
  if (input.forceRenderChildren) return true;
  if (!input.initialized && !input.hasRenderedChildren) return false;
  if (input.locked && !input.hasRenderedChildren) return false;
  return true;
}

/**
 * Deep-link delivery waits on rendererReady. Only mark the renderer ready once
 * app children are allowed to mount, so unlock (not the 15s readiness timeout)
 * is what unblocks pending ssh:// links after a locked first paint.
 */
export function shouldNotifyAppLockGateRendererReady(input: {
  notifyRendererReady: boolean;
  renderChildren: boolean;
}): boolean {
  return input.notifyRendererReady && input.renderChildren;
}

/** Queue external actions (e.g. ssh:// deep links) while the app lock is held. */
export function shouldDeferExternalActionWhileAppLocked(input: {
  locked: boolean;
}): boolean {
  return input.locked === true;
}

export function createAppLockGate(deps: AppLockGateDeps): React.FC<AppLockGateProps> {
  const AppLockGateImpl: React.FC<AppLockGateProps> = ({
    children,
    notifyRendererReady = true,
    forceRenderChildren = false,
    settingsOptions,
  }) => {
    const settings = deps.useSettingsState(settingsOptions);
    const appLock = deps.useAppLockState(settings.appLockSettings);
    const {
      notifyRendererReady: notifyAppLockRendererReady,
      onAppLockReopen,
    } = deps.useAppLockBridge();
    const hasRenderedChildrenRef = useRef(false);
    const [reopenSignal, setReopenSignal] = useState(0);
    const renderChildren = shouldRenderAppLockGateChildren({
      initialized: appLock.initialized,
      locked: appLock.locked,
      lockReason: appLock.lockReason,
      hasRenderedChildren: hasRenderedChildrenRef.current,
      forceRenderChildren,
    });
    if (renderChildren) {
      hasRenderedChildrenRef.current = true;
    }
    const shouldNotifyRendererReady = shouldNotifyAppLockGateRendererReady({
      notifyRendererReady,
      renderChildren,
    });

    useEffect(() => {
      try {
        const splash = document.getElementById('splash');
        if (splash) {
          splash.classList.add('fade-out');
          setTimeout(() => splash.remove(), 200);
        }
        if (shouldNotifyRendererReady) {
          notifyAppLockRendererReady();
        }
      } catch {
        // ignore
      }
    }, [notifyAppLockRendererReady, shouldNotifyRendererReady]);

    useEffect(() => {
      const unsubscribe = onAppLockReopen(() => {
        setReopenSignal((current) => current + 1);
        void appLock.resync?.();
      });
      return () => unsubscribe?.();
    }, [appLock, onAppLockReopen]);

    useEffect(() => {
      const handleVisibilityOrFocus = () => {
        void appLock.resync?.();
      };
      window.addEventListener('focus', handleVisibilityOrFocus);
      document.addEventListener('visibilitychange', handleVisibilityOrFocus);
      return () => {
        window.removeEventListener('focus', handleVisibilityOrFocus);
        document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
      };
    }, [appLock]);

    // When re-locked after first mount, children stay mounted under the overlay.
    // Mark them inert so pointer/keyboard/AT cannot reach underlying controls
    // (sessions, editors, side panels) while the lock screen is up.
    const lockedBackground = appLock.locked === true;

    return (
      <I18nProvider locale={settings.uiLanguage}>
        <ToastProvider>
          <TooltipProvider delayDuration={300}>
            {renderChildren ? (
              <div
                // React 19 supports the HTML inert attribute; when true, the
                // subtree is non-interactive and removed from sequential focus.
                inert={lockedBackground ? true : undefined}
                aria-hidden={lockedBackground || undefined}
                className={lockedBackground ? 'h-full pointer-events-none' : 'h-full'}
                data-app-lock-background={lockedBackground ? 'locked' : 'unlocked'}
              >
                {children({ settings, appLock })}
              </div>
            ) : null}
            <AppLockOverlay
              locked={appLock.locked}
              reason={appLock.lockReason}
              onUnlock={appLock.unlock}
              systemUnlockStatus={appLock.systemUnlockStatus}
              onSystemUnlock={appLock.unlockWithSystemAuth}
              onResetAppLock={appLock.reset}
              autoPromptSystemUnlock={settings.appLockSettings.systemUnlockAutoPromptEnabled}
              reopenSignal={reopenSignal}
            />
          </TooltipProvider>
        </ToastProvider>
      </I18nProvider>
    );
  };

  return AppLockGateImpl;
}

export const AppLockGate = createAppLockGate({
  useSettingsState,
  useAppLockState,
  useAppLockBridge,
});
