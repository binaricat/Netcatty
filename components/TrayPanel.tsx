import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "./ui/button";
import { useSessionState } from "../application/state/useSessionState";
import { usePortForwardingState } from "../application/state/usePortForwardingState";
import { useVaultState } from "../application/state/useVaultState";
import { toast } from "./ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { cn } from "../lib/utils";
import { useI18n } from "../application/i18n/I18nProvider";
import { I18nProvider } from "../application/i18n/I18nProvider";
import { useSettingsState } from "../application/state/useSettingsState";
import { useTrayPanelBackend } from "../application/state/useTrayPanelBackend";
import { useActiveTabId } from "../application/state/activeTabStore";
import { resolveGroupDefaults, applyGroupDefaults } from "../domain/groupConfig";
import { materializeHostProxyProfile } from "../domain/proxyProfiles";
import { upsertKnownHost } from "../domain/knownHosts";
import type { Host, KnownHost } from "../domain/models";
import { getEffectiveKnownHosts } from "../infrastructure/syncHelpers";
import { PortForwardHostKeyTrayPrompt } from "./port-forwarding";
import { X, Maximize2, ChevronRight, ChevronDown, Power } from "lucide-react";
import { AppLogo } from "./AppLogo";

const StatusDot: React.FC<{ status: "success" | "warning" | "error" | "neutral"; spinning?: boolean }> = ({
  status,
  spinning,
}) => {
  const color =
    status === "success"
      ? "bg-emerald-500"
      : status === "warning"
        ? "bg-amber-500"
        : status === "error"
          ? "bg-rose-500"
          : "bg-zinc-500";

  return (
    <span
      className={cn(
        "inline-block h-2 w-2 rounded-full",
        color,
        spinning ? "animate-spin" : "",
      )}
    />
  );
};

// Session type for workspace grouping
type TraySession = {
  id: string;
  label: string;
  hostLabel: string;
  status: "connecting" | "connected" | "disconnected";
  workspaceId?: string;
  workspaceTitle?: string;
  /** Mirrors TerminalSession.hiddenFromTabs; marks AI-opened silent sessions. */
  aiHidden?: boolean;
};

// Collapsible workspace group component
const WorkspaceGroup: React.FC<{
  workspaceId: string;
  title: string;
  sessions: TraySession[];
  activeTabId: string | null;
  jumpToSession: (sessionId: string) => Promise<void>;
  onCloseSession: (sessionId: string) => void;
  t: (key: string) => string;
}> = ({ workspaceId, title, sessions, activeTabId, jumpToSession, onCloseSession, t }) => {
  const [expanded, setExpanded] = useState(true);
  const isAnyActive = sessions.some((s) => s.id === activeTabId) || activeTabId === workspaceId;

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn(
          "w-full text-left px-2 py-1.5 rounded hover:bg-muted flex items-center gap-1",
          isAnyActive ? "bg-muted" : "",
        )}
      >
        {expanded ? <ChevronDown size={14} className="text-muted-foreground" /> : <ChevronRight size={14} className="text-muted-foreground" />}
        <span className="font-medium truncate">{title}</span>
        <span className="ml-auto text-xs text-muted-foreground">{sessions.length}</span>
      </button>
      {expanded && (
        <div className="ml-4 mt-0.5 space-y-0.5">
          {sessions.map((s) => (
            <Tooltip key={s.id}>
              <TooltipTrigger asChild>
                <div
                  className={cn(
                    "group w-full rounded hover:bg-muted flex items-center justify-between text-sm",
                    s.status === "connected" ? "" : "text-muted-foreground",
                    activeTabId === s.id ? "bg-muted/60" : "",
                  )}
                >
                  <button
                    onClick={() => {
                      // Jump to session (using session id)
                      void jumpToSession(s.id);
                    }}
                    className="flex-1 min-w-0 text-left px-2 py-1 flex items-center justify-between gap-1"
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <StatusDot
                        status={s.status === "connected" ? "success" : s.status === "connecting" ? "warning" : "error"}
                        spinning={s.status === "connecting"}
                      />
                      <span className="truncate">{s.hostLabel || s.label}</span>
                      {s.aiHidden && (
                        <span className="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium leading-none bg-muted text-muted-foreground">
                          AI
                        </span>
                      )}
                    </span>
                    <span className="ml-2 text-xs text-muted-foreground">{t(`tray.status.${s.status}`)}</span>
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseSession(s.id);
                    }}
                    className="shrink-0 mr-1 h-6 w-6 rounded inline-flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 hover:bg-destructive/10 hover:text-destructive text-muted-foreground transition-opacity focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    aria-label={t("tray.closeSession")}
                  >
                    <X size={12} />
                  </button>
                </div>
              </TooltipTrigger>
              <TooltipContent>{s.hostLabel || s.label}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      )}
    </div>
  );
};

interface TrayPanelContentProps {
  terminalSettings?: { verifyHostKeys: boolean; keepaliveInterval: number; keepaliveCountMax: number };
}

const TrayPanelContent: React.FC<TrayPanelContentProps> = ({ terminalSettings }) => {
  const { t } = useI18n();
  const {
    hideTrayPanel,
    openMainWindow,
    quitApp,
    jumpToSession,
    closeSessionFromTrayPanel,
    onTrayPanelCloseRequest,
    onTrayPanelRefresh,
    onTrayPanelMenuData,
  } = useTrayPanelBackend();

  const { hosts, keys, identities, proxyProfiles, groupConfigs, knownHosts, updateKnownHosts } = useVaultState();
  // TrayPanel runs in its own BrowserWindow, so this hook's session state is
  // independent from (and typically empty compared to) the main App's — it's
  // used here only for its storage-sync side effects, never for closeSession.
  useSessionState({ persistSessionRestore: false });
  const {
    rules: portForwardingRules,
    startTunnel,
    stopTunnel,
    hasRuntimeTunnel,
  } = usePortForwardingState();
  const activeTabId = useActiveTabId();
  const proxyProfileIdSet = useMemo(
    () => new Set(proxyProfiles.map((profile) => profile.id)),
    [proxyProfiles],
  );
  const effectiveKnownHosts = useMemo(
    () => getEffectiveKnownHosts(knownHosts) ?? [],
    [knownHosts],
  );
  const handleAddKnownHost = useCallback((knownHost: KnownHost) => {
    updateKnownHosts(upsertKnownHost(effectiveKnownHosts, knownHost));
  }, [effectiveKnownHosts, updateKnownHosts]);

  const handleCloseSession = useCallback((sessionId: string) => {
    // Forwarded to the main window's App-owned closeSession, which is the
    // instance that actually owns `sessions` and republishes tray menu data.
    void closeSessionFromTrayPanel(sessionId);
  }, [closeSessionFromTrayPanel]);

  const [traySessions, setTraySessions] = useState<TraySession[]>([]);

  const jumpableSessions = useMemo(
    () => traySessions.filter((s) => s.status === "connected" || s.status === "connecting"),
    [traySessions],
  );

  const activeSession = useMemo(() => {
    if (!activeTabId) return null;
    return traySessions.find((s) => s.id === activeTabId) || null;
  }, [activeTabId, traySessions]);

  useEffect(() => {
    const unsubscribe = onTrayPanelMenuData?.((data) => {
      setTraySessions(data.sessions || []);
    });
    return () => unsubscribe?.();
  }, [onTrayPanelMenuData]);

  useEffect(() => {
    const unsubscribe = onTrayPanelRefresh?.(() => {
      try {
        window.dispatchEvent(new Event("storage"));
      } catch {
        // ignore
      }
    });
    return () => unsubscribe?.();
  }, [onTrayPanelRefresh]);

  const handleClose = useCallback(() => {
    void hideTrayPanel();
  }, [hideTrayPanel]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleClose]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (document.body && !document.body.contains(target)) return;
      // Ignore clicks on interactive elements inside the panel.
      if (target instanceof HTMLElement && target.closest("button,a,input,select,textarea,[role='button']")) {
        return;
      }
      if (
        target instanceof HTMLElement &&
        target.closest("[data-port-forward-host-key-dialog='true'],[data-port-forward-host-key-tray-prompt='true'],.port-forward-host-key-dialog-layer")
      ) {
        return;
      }
      // Clicking on background should close panel
      const root = document.getElementById("tray-panel-root");
      if (root && !root.contains(target)) {
        handleClose();
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [handleClose]);

  useEffect(() => {
    const unsubscribe = onTrayPanelCloseRequest(() => {
      handleClose();
    });
    return () => unsubscribe?.();
  }, [handleClose, onTrayPanelCloseRequest]);

  const handleOpenMain = useCallback(() => {
    void openMainWindow();
  }, [openMainWindow]);

  const handleQuit = useCallback(() => {
    void quitApp();
  }, [quitApp]);

  return (
    <>
      <div id="tray-panel-root" className="w-full h-full bg-background/95 supports-[backdrop-filter]:backdrop-blur-sm border border-border/60 rounded-lg shadow-lg overflow-hidden flex flex-col">
      <div className="px-3 py-2 border-b border-border/60 flex items-center justify-between app-no-drag">
        <div className="flex items-center gap-2">
          <AppLogo className="w-5 h-5" />
          <span className="text-sm font-medium">Netcatty</span>
        </div>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                onClick={handleOpenMain}
              >
                <Maximize2 size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t("tray.openMainWindow")}</TooltipContent>
          </Tooltip>
          <button
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
            onClick={handleClose}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <PortForwardHostKeyTrayPrompt onAddKnownHost={handleAddKnownHost} />

      <div className="p-2 space-y-3 text-sm flex-1 overflow-y-auto min-h-0">
        {jumpableSessions.length > 0 && (() => {
          // Group sessions by workspace
          const workspaceGroups = new Map<string, { title: string; sessions: typeof jumpableSessions }>();
          const soloSessions: typeof jumpableSessions = [];

          jumpableSessions.forEach((s) => {
            if (s.workspaceId) {
              const existing = workspaceGroups.get(s.workspaceId);
              if (existing) {
                existing.sessions.push(s);
              } else {
                workspaceGroups.set(s.workspaceId, {
                  title: s.workspaceTitle || "Workspace",
                  sessions: [s],
                });
              }
            } else {
              soloSessions.push(s);
            }
          });

          return (
            <div>
              <div className="px-2 py-1 text-xs text-muted-foreground">{t("tray.sessions")}</div>
              <div className="space-y-1">
                {/* Workspace groups */}
                {Array.from(workspaceGroups.entries()).map(([wsId, group]) => (
                  <WorkspaceGroup
                    key={wsId}
                    workspaceId={wsId}
                    title={group.title}
                    sessions={group.sessions}
                    activeTabId={activeTabId}
                    jumpToSession={jumpToSession}
                    onCloseSession={handleCloseSession}
                    t={t}
                  />
                ))}
                {/* Solo sessions */}
                {soloSessions.map((s) => (
                  <Tooltip key={s.id}>
                    <TooltipTrigger asChild>
                      <div
                        className={cn(
                          "group w-full rounded hover:bg-muted flex items-center justify-between",
                          s.status === "connected" ? "" : "text-muted-foreground",
                          activeTabId === s.id ? "bg-muted" : "",
                        )}
                      >
                        <button
                          onClick={() => {
                            void jumpToSession(s.id);
                          }}
                          className="flex-1 min-w-0 text-left px-2 py-1.5 flex items-center justify-between gap-1"
                        >
                          <span className="flex items-center gap-2 min-w-0">
                            <StatusDot
                              status={s.status === "connected" ? "success" : s.status === "connecting" ? "warning" : "error"}
                              spinning={s.status === "connecting"}
                            />
                            <span className="truncate">{s.hostLabel || s.label}</span>
                            {s.aiHidden && (
                              <span className="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium leading-none bg-muted text-muted-foreground">
                                AI
                              </span>
                            )}
                          </span>
                          <span className="ml-2 text-xs text-muted-foreground">{t(`tray.status.${s.status}`)}</span>
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCloseSession(s.id);
                          }}
                          className="shrink-0 mr-1.5 h-6 w-6 rounded inline-flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 hover:bg-destructive/10 hover:text-destructive text-muted-foreground transition-opacity focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          aria-label={t("tray.closeSession")}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>{s.hostLabel || s.label}</TooltipContent>
                  </Tooltip>
                ))}
              </div>
            </div>
          );
        })()}

        {activeSession && (
          <div>
            <div className="px-2 py-1 text-xs text-muted-foreground">Current</div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  className="w-full justify-start px-2 h-8"
                  onClick={() => {
                    void jumpToSession(activeSession.id);
                  }}
                >
                  <span className="truncate">{activeSession.hostLabel || activeSession.label}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>{activeSession.hostLabel || activeSession.label}</TooltipContent>
            </Tooltip>
          </div>
        )}

        {portForwardingRules.length > 0 && (
          <div>
            <div className="px-2 py-1 text-xs text-muted-foreground">{t("tray.portForwarding")}</div>
            <div className="space-y-1">
              {portForwardingRules.map((rule) => {
                const isConnecting = rule.status === "connecting";
                const isActive = rule.status === "active";
                const isStoppable = isConnecting || isActive || hasRuntimeTunnel(rule.id);
                const label = rule.label || (rule.type === "dynamic"
                  ? `SOCKS:${rule.localPort}`
                  : `${rule.localPort} → ${rule.remoteHost}:${rule.remotePort}`);

                return (
                  <Tooltip key={rule.id}>
                    <TooltipTrigger asChild>
                      <button
                        disabled={isConnecting}
                        onClick={() => {
                          const rawHost = rule.hostId ? hosts.find((h) => h.id === rule.hostId) : undefined;
                          if (!rawHost) {
                            toast.error(t("pf.error.hostNotFound"));
                            return;
                          }
                          if (isStoppable) {
                            void stopTunnel(rule.id).then((result) => {
                              if (!result.success && result.error) toast.error(result.error);
                            });
                          } else {
                            const resolveEffectiveHost = (host: Host) => {
                              const withGroupDefaults = host.group
                                ? applyGroupDefaults(host, resolveGroupDefaults(host.group, groupConfigs, { validProxyProfileIds: proxyProfileIdSet }), { validProxyProfileIds: proxyProfileIdSet })
                                : applyGroupDefaults(host, {}, { validProxyProfileIds: proxyProfileIdSet });
                              return materializeHostProxyProfile(withGroupDefaults, proxyProfiles);
                            };
                            const host = resolveEffectiveHost(rawHost);
                            void startTunnel(rule, host, hosts.map(resolveEffectiveHost), keys, identities, (status, error) => {
                              if (status === "error" && error) toast.error(error);
                            }, rule.autoStart, terminalSettings, effectiveKnownHosts);
                          }
                        }}
                        className={cn(
                          "w-full text-left px-2 py-1.5 rounded hover:bg-muted flex items-center justify-between",
                          isConnecting ? "opacity-60" : "",
                        )}
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          <StatusDot
                            status={
                              rule.status === "active"
                                ? "success"
                                : rule.status === "connecting"
                                  ? "warning"
                                  : rule.status === "error"
                                    ? "error"
                                    : "neutral"
                            }
                            spinning={rule.status === "connecting"}
                          />
                          <span className="truncate">{label}</span>
                        </span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {t(`tray.status.${rule.status}`)}
                        </span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{label}</TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </div>
        )}

        {/* Empty state - show when nothing is active */}
        {jumpableSessions.length === 0 && portForwardingRules.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <span className="text-2xl mb-2">😴</span>
            <span className="text-sm text-muted-foreground">{t("tray.empty.title")}</span>
            <span className="text-xs text-muted-foreground/60 mt-1">{t("tray.empty.subtitle")}</span>
          </div>
        )}
      </div>

      {/* Quit button at the bottom */}
      <div className="px-3 py-2 border-t border-border/60">
        <button
          className="w-full text-left px-2 py-1.5 rounded hover:bg-destructive/10 flex items-center gap-2 text-sm text-muted-foreground hover:text-destructive transition-colors"
          onClick={handleQuit}
        >
          <Power size={14} />
          <span>{t("tray.quit")}</span>
        </button>
      </div>
      </div>
    </>
  );
};

const TrayPanel: React.FC = () => {
  const settings = useSettingsState();
  return (
    <I18nProvider locale={settings.uiLanguage}>
      <TrayPanelContent terminalSettings={settings.terminalSettings} />
    </I18nProvider>
  );
};

export default TrayPanel;
