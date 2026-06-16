import { Copy, Minus, Square, Unplug, X } from 'lucide-react';
import React, { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { I18nProvider, useI18n } from '../application/i18n/I18nProvider';
import { canReuseTerminalConnection } from '../application/state/terminalConnectionReuse';
import { useSettingsState } from '../application/state/useSettingsState';
import { useTerminalPopupWindow } from '../application/state/useTerminalPopupWindow';
import { useVaultState } from '../application/state/useVaultState';
import { useWindowControls } from '../application/state/useWindowControls';
import { shouldCloseTerminalPopupOnExit } from '../application/state/resolveTerminalSessionExitIntent';
import { upsertKnownHost } from '../domain/knownHosts';
import type { TerminalPopupPayload } from '../domain/systemManager/types';
import type { TerminalTheme } from '../domain/models';
import type { Host, KnownHost } from '../types';
import { getEffectiveKnownHosts } from '../infrastructure/syncHelpers';
import { cn } from '../lib/utils';

const Terminal = lazy(() => import('./Terminal'));

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const POPUP_STARTUP_REVEAL_EXTRA_DELAY_MS = 900;
const POPUP_STARTUP_REVEAL_MIN_DELAY_MS = 1500;
const POPUP_STARTUP_REVEAL_MAX_DELAY_MS = 12000;

type PopupThemeVars = React.CSSProperties & Record<string, string>;

const buildPopupThemeVars = (theme: TerminalTheme): PopupThemeVars => {
  const { colors } = theme;
  return {
    '--terminal-popup-bg': colors.background,
    '--terminal-popup-fg': colors.foreground,
    '--terminal-popup-muted': colors.foreground,
    '--terminal-popup-accent': colors.cursor,
    '--terminal-popup-control-hover': `color-mix(in srgb, ${colors.foreground} 10%, transparent)`,
  };
};

function TerminalPopupWindowControls({ mac, onClose }: { mac: boolean; onClose: () => void }) {
  const { minimize, maximize, isMaximized: fetchIsMaximized } = useWindowControls();
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchIsMaximized().then((value) => {
      if (!cancelled) setIsWindowMaximized(!!value);
    });
    const handleResize = () => {
      void fetchIsMaximized().then((value) => setIsWindowMaximized(!!value));
    };
    window.addEventListener('resize', handleResize);
    return () => {
      cancelled = true;
      window.removeEventListener('resize', handleResize);
    };
  }, [fetchIsMaximized]);

  const handleMaximize = async () => {
    const value = await maximize();
    setIsWindowMaximized(!!value);
  };

  if (mac) return null;

  const buttonClass =
    'app-no-drag flex h-10 w-11 items-center justify-center text-[color:var(--terminal-popup-muted)] transition-colors hover:bg-[color:var(--terminal-popup-control-hover)] hover:text-[color:var(--terminal-popup-fg)]';

  return (
    <div className="app-no-drag ml-auto flex h-10 shrink-0 items-center">
      <button type="button" onClick={() => void minimize()} className={buttonClass} aria-label="Minimize">
        <Minus size={15} />
      </button>
      <button type="button" onClick={() => void handleMaximize()} className={buttonClass} aria-label={isWindowMaximized ? 'Restore' : 'Maximize'}>
        {isWindowMaximized ? <Copy size={14} /> : <Square size={13} />}
      </button>
      <button
        type="button"
        onClick={onClose}
        className="app-no-drag flex h-10 w-11 items-center justify-center text-[color:var(--terminal-popup-fg)] opacity-80 transition-colors hover:bg-[color:var(--terminal-popup-control-hover)] hover:opacity-100"
        aria-label="Close"
      >
        <X size={16} />
      </button>
    </div>
  );
}

function TerminalPopupSpinner() {
  return (
    <div className="h-full flex-1 flex items-center justify-center bg-[color:var(--terminal-popup-bg)] text-[color:var(--terminal-popup-fg)]">
      <svg
        width="28"
        height="28"
        viewBox="0 0 28 28"
        aria-label="Loading"
        className="opacity-80"
      >
        <circle
          cx="14"
          cy="14"
          r="11"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          opacity="0.18"
        />
        <path
          d="M25 14a11 11 0 0 0-11-11"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="2"
        >
          <animateTransform
            attributeName="transform"
            dur="0.75s"
            from="0 14 14"
            repeatCount="indefinite"
            to="360 14 14"
            type="rotate"
          />
        </path>
      </svg>
    </div>
  );
}

function TerminalPopupBlank() {
  return (
    <div className="h-full flex-1 bg-[color:var(--terminal-popup-bg)]" />
  );
}

function TerminalPopupStartupError({
  message,
  closeLabel,
  onClose,
}: {
  message: string;
  closeLabel: string;
  onClose: () => void;
}) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-[color:var(--terminal-popup-bg)] px-6 text-center text-[color:var(--terminal-popup-fg)]">
      <Unplug size={24} className="mb-3 opacity-45" />
      <div className="max-w-[300px] text-xs leading-5 opacity-70">{message}</div>
      <button
        type="button"
        onClick={onClose}
        className="app-no-drag mt-4 h-7 rounded px-3 text-[11px] opacity-70 transition-colors hover:bg-[color:var(--terminal-popup-control-hover)] hover:opacity-100"
      >
        {closeLabel}
      </button>
    </div>
  );
}

function TerminalPopupTitleIcon({ icon }: { icon: TerminalPopupPayload['icon'] }) {
  if (!icon) return null;
  if (icon.kind !== 'image' || !icon.src) return null;
  return (
    <span
      className="pointer-events-none ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px]"
      style={{
        backgroundColor: icon.backgroundColor ?? 'transparent',
      }}
    >
      <img
        src={icon.src}
        alt={icon.alt ?? ''}
        width={11}
        height={11}
        className="max-h-[11px] max-w-[11px] rounded-[2px] object-contain"
        draggable={false}
      />
    </span>
  );
}

/** Fallback when the parent session's host is no longer in the vault (e.g. quick connect). */
function buildHostFromSession(source: TerminalPopupPayload['sourceSession']): Host {
  return {
    id: source.hostId,
    label: source.hostLabel,
    hostname: source.hostname,
    username: source.username,
    port: source.port ?? (source.protocol === 'local' ? undefined : 22),
    protocol: source.protocol === 'local' ? 'local' : 'ssh',
    tags: [],
    os: 'linux',
    moshEnabled: source.moshEnabled,
    etEnabled: source.etEnabled,
    charset: source.charset,
  };
}

function TerminalPopupPageInner() {
  const { t } = useI18n();
  const { close, setWindowTitle, onPopupConfig } = useTerminalPopupWindow();
  const { notifyRendererReady, onWindowCommandCloseRequested } = useWindowControls();
  const settings = useSettingsState();
  const { isInitialized: vaultInitialized, hosts, keys, identities, knownHosts, snippets, snippetPackages, updateKnownHosts } = useVaultState();
  const [config, setConfig] = useState<TerminalPopupPayload | null>(null);
  const [terminalReady, setTerminalReady] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const sessionId = useMemo(() => crypto.randomUUID(), []);
  const knownHostsRef = React.useRef(knownHosts);
  const effectiveKnownHosts = useMemo(
    () => getEffectiveKnownHosts(knownHosts) ?? [],
    [knownHosts],
  );
  knownHostsRef.current = effectiveKnownHosts;
  const handleAddKnownHost = useCallback((knownHost: KnownHost) => {
    const nextKnownHosts = upsertKnownHost(knownHostsRef.current, knownHost);
    knownHostsRef.current = nextKnownHosts;
    updateKnownHosts(nextKnownHosts);
  }, [updateKnownHosts]);
  const popupThemeVars = useMemo(
    () => buildPopupThemeVars(settings.currentTerminalTheme),
    [settings.currentTerminalTheme],
  );

  useEffect(() => {
    const unsubscribe = onPopupConfig((payload) => {
      setConfig(payload);
      if (payload.title) {
        void setWindowTitle(payload.title);
      }
    });
    // Main delivers the popup payload as soon as the renderer reports ready
    // (and destroys the window if it never does) — so report ready only after
    // the config listener above is registered.
    notifyRendererReady();
    return unsubscribe;
  }, [notifyRendererReady, onPopupConfig, setWindowTitle]);

  useEffect(() => {
    return onWindowCommandCloseRequested(() => {
      void close();
    });
  }, [close, onWindowCommandCloseRequested]);

  const host = useMemo(() => {
    if (!config) return null;
    const vaultHost = hosts.find((h) => h.id === config.sourceSession.hostId);
    return vaultHost ?? buildHostFromSession(config.sourceSession);
  }, [config, hosts]);

  const reuseId = useMemo(() => {
    if (!config) return undefined;
    return canReuseTerminalConnection(config.sourceSession)
      ? config.parentSessionId
      : undefined;
  }, [config]);

  const ready = Boolean(config && host && vaultInitialized);
  const startupRevealDelayMs = useMemo(() => {
    if (!config?.startupCommand) return 0;
    const configuredDelay = settings.terminalSettings?.startupCommandDelayMs;
    const startupDelay = typeof configuredDelay === 'number' && Number.isFinite(configuredDelay)
      ? Math.max(0, configuredDelay)
      : 600;
    return Math.min(
      POPUP_STARTUP_REVEAL_MAX_DELAY_MS,
      Math.max(POPUP_STARTUP_REVEAL_MIN_DELAY_MS, startupDelay + POPUP_STARTUP_REVEAL_EXTRA_DELAY_MS),
    );
  }, [config?.startupCommand, settings.terminalSettings?.startupCommandDelayMs]);
  const revealTerminal = useCallback(() => {
    setTerminalReady(true);
  }, []);

  useEffect(() => {
    setTerminalReady(false);
    setStartupError(null);
  }, [config?.popupId, sessionId]);

  useEffect(() => {
    if (!ready) return undefined;
    const timeout = window.setTimeout(() => setTerminalReady(true), startupRevealDelayMs);
    return () => window.clearTimeout(timeout);
  }, [config?.popupId, ready, startupRevealDelayMs]);

  return (
    <div
      className="h-screen flex flex-col overflow-hidden bg-[color:var(--terminal-popup-bg)] text-[color:var(--terminal-popup-fg)]"
      data-section="terminal-popup"
      style={popupThemeVars}
    >
      <div
        className="app-drag relative shrink-0 h-9 flex items-center bg-[color:var(--terminal-popup-bg)]"
        data-section="terminal-popup-titlebar"
      >
        {isMac && <div className="h-9 w-[92px] shrink-0" />}
        <TerminalPopupTitleIcon icon={config?.icon} />
        <div className={cn(
          'min-w-0 flex-1 pr-3 text-left text-[12px] font-medium text-[color:var(--terminal-popup-fg)] opacity-70',
          config?.icon ? 'pl-1.5' : 'pl-3',
          !isMac && 'pl-4 text-left',
        )}>
          <div className="max-w-full truncate">
            {config?.title ?? ''}
          </div>
        </div>
        {!isMac && <TerminalPopupWindowControls mac={false} onClose={() => void close()} />}
      </div>
      {!ready || !config || !host ? (
        <TerminalPopupSpinner />
      ) : startupError ? (
        <TerminalPopupStartupError
          message={startupError}
          closeLabel={t('common.close')}
          onClose={() => void close()}
        />
      ) : (
        <div className="relative flex-1 min-h-0 flex flex-col bg-[color:var(--terminal-popup-bg)]">
          <Suspense fallback={<TerminalPopupBlank />}>
            <Terminal
              host={host}
              keys={keys}
              identities={identities}
              snippets={snippets}
              snippetPackages={snippetPackages}
              compactToolbar
              lineTimestampsAvailable={false}
              knownHosts={effectiveKnownHosts}
              onAddKnownHost={handleAddKnownHost}
              isVisible
              isFocused
              fontFamilyId={settings.terminalFontFamilyId}
              fontSize={settings.terminalFontSize}
              terminalTheme={settings.currentTerminalTheme}
              followAppTerminalTheme={settings.followAppTerminalTheme}
              accentMode={settings.accentMode}
              customAccent={settings.customAccent}
              terminalSettings={settings.terminalSettings}
              disableTerminalFontZoom={settings.disableTerminalFontZoom}
              sessionId={sessionId}
              startupCommand={config.startupCommand}
              reuseConnectionFromSessionId={reuseId}
              onCloseSession={() => {
                void close();
              }}
              onSessionExit={(_closedSessionId, evt) => {
                if (shouldCloseTerminalPopupOnExit(evt)) {
                  void close();
                  return;
                }
                if (!terminalReady && config.startupCommand) {
                  setStartupError(t('systemManager.popup.startupFailed'));
                }
              }}
              onStatusChange={(_changedSessionId, status) => {
                if (!config.startupCommand && status === 'connected') revealTerminal();
              }}
              onTerminalDataCapture={revealTerminal}
            />
          </Suspense>
          {!terminalReady && (
            <div className="pointer-events-none absolute inset-0 z-10">
              <TerminalPopupSpinner />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function TerminalPopupPage() {
  const settings = useSettingsState();
  return (
    <I18nProvider locale={settings.uiLanguage}>
      <TerminalPopupPageInner />
    </I18nProvider>
  );
}
