import React, { useEffect } from 'react';

import { initializeFonts } from './application/state/fontStore';
import { initializeUIFonts } from './application/state/uiFontStore';
import { useSettingsChromeStore } from './application/state/settingsChromeStore';
import { I18nProvider } from './application/i18n/I18nProvider';
import type { useSettingsState } from './application/state/useSettingsState';
import type { useAppLockState } from './application/state/useAppLockState';
import { ToastProvider } from './components/ui/toast';
import { TooltipProvider } from './components/ui/tooltip';
import { ScriptAutomationRoot } from './components/scripts/ScriptAutomationRoot';
import { ExternalMcpApprovalsHost } from './components/ai/ExternalMcpApprovalsHost';
import { PluginAuthenticationHost } from './components/plugins/PluginAuthenticationHost';
import { useExternalMcpGrantPersister } from './components/ai/useExternalMcpGrantPersister';
import { setupMcpApprovalBridge } from './infrastructure/ai/shared/approvalGate';
import { setupCodexAppServerInteractionBridge } from './infrastructure/ai/shared/codexAppServerInteractions';
import { AppShell } from './application/app/AppShell';
import { AppLocalStateProvider } from './application/app/AppLocalState';
import { AppSideEffects } from './application/app/AppSideEffects';
import { SessionPublisher } from './application/app/publishers/SessionPublisher';
import { SettingsPublisher } from './application/app/publishers/SettingsPublisher';
import { VaultPublisher } from './application/app/publishers/VaultPublisher';
import { AppLockRuntimePublisher } from './application/app/publishers/AppLockRuntimePublisher';

// Initialize fonts eagerly at app startup
initializeFonts();
initializeUIFonts();

type SettingsState = ReturnType<typeof useSettingsState>;
type AppLockState = ReturnType<typeof useAppLockState>;

/**
 * Bridges the locale out of settings chrome without pulling App into a
 * settings-subscribing mega component.
 */
function SettingsI18nProvider({ children }: { children: React.ReactNode }) {
  const { uiLanguage } = useSettingsChromeStore();
  return <I18nProvider locale={uiLanguage}>{children}</I18nProvider>;
}

/**
 * Thin coordinator: no vault/session/settings React subscriptions and no
 * domain bag construction. Publishers own mega hooks; Host islands build
 * shell bags; AppSideEffects owns reactive effects + local UI publishing.
 */
function App() {
  return (
    <AppLocalStateProvider>
      <AppSideEffects />
      <AppShell />
    </AppLocalStateProvider>
  );
}

/**
 * `AppLockGate` (index.tsx) owns `useSettingsState` / `useAppLockState` so the
 * lock overlay can render before app children mount, and it owns the
 * splash-removal + rendererReady signal (deep links must wait for unlock).
 * App forwards the gate's settings instance into SettingsPublisher so the
 * runtime slot/context still publish a single settings runtime.
 */
function AppWithProviders({ settings, appLock }: { settings: SettingsState; appLock: AppLockState }) {
  const isPeerSessionWindow = typeof window !== 'undefined' && window.location.hash.startsWith('#/session-window');

  useEffect(() => {
    return setupMcpApprovalBridge();
  }, []);

  useEffect(() => {
    return setupCodexAppServerInteractionBridge();
  }, []);

  useExternalMcpGrantPersister();

  return (
    <SettingsPublisher settings={settings}>
      <AppLockRuntimePublisher appLock={appLock} appLockEnabled={settings.appLockSettings.enabled}>
        <SettingsI18nProvider>
          <ToastProvider>
            <TooltipProvider delayDuration={300}>
              <ScriptAutomationRoot />
              <ExternalMcpApprovalsHost />
              <PluginAuthenticationHost />
              <VaultPublisher>
                <SessionPublisher persistSessionRestore={!isPeerSessionWindow}>
                  <App />
                </SessionPublisher>
              </VaultPublisher>
            </TooltipProvider>
          </ToastProvider>
        </SettingsI18nProvider>
      </AppLockRuntimePublisher>
    </SettingsPublisher>
  );
}

export default AppWithProviders;
