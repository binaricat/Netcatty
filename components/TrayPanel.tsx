import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "./ui/button";
import { useSessionState } from "../application/state/useSessionState";
import { usePortForwardingState } from "../application/state/usePortForwardingState";
import { useVaultState } from "../application/state/useVaultState";
import { toast } from "./ui/toast";
import { cn } from "../lib/utils";
import { useI18n } from "../application/i18n/I18nProvider";
import { I18nProvider } from "../application/i18n/I18nProvider";
import { useSettingsState } from "../application/state/useSettingsState";
import { useTrayPanelBackend } from "../application/state/useTrayPanelBackend";
import { useActiveTabId } from "../application/state/activeTabStore";
import { resolveGroupDefaults, applyGroupDefaults } from "../domain/groupConfig";
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
};

// Collapsible workspace group component
const WorkspaceGroup: React.FC<{
  workspaceId: string;
  title: string;
  sessions: TraySession[];
  activeTabId: string | null;
  jumpToSession: (sessionId: string) => Promise<void>;
  t: (key: string) => string;
}> = ({ workspaceId, title, sessions, activeTabId, jumpToSession, t }) => {
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
            <button
              key={s.id}
              title={s.hostLabel || s.label}
              onClick={() => {
                // Jump to session (using session id)
                void jumpToSession(s.id);
              }}
              className={cn(
                "w-full text-left px-2 py-1 rounded hover:bg-muted flex items-center justify-between text-sm",
                s.status === "connected" ? "" : "text-muted-foreground",
                activeTabId === s.id ? "bg-muted/60" : "",
              )}
            >
              <span className="flex items-center gap-2 min-w-0">
                <StatusDot
                  status={s.status === "connected" ? "success" : s.status === "connecting" ? "warning" : "error"}
                  spinning={s.status === "connecting"}
                />
                <span className="truncate">{s.hostLabel || s.label}</span>
              </span>
              <span className="ml-2 text-xs text-muted-foreground">{t(`tray.status.${s.status}`)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const TrayPanelContent: React.FC = () => {
  const { t } = useI18n();
  const {
    hideTrayPanel,
    openMainWindow,
    quitApp,
    jumpToSession,
    onTrayPanelCloseRequest,
    onTrayPanelRefresh,
    onTrayPanelMenuData,
  } = useTrayPanelBackend();

  const { hosts, keys, identities, groupConfigs } = useVaultState();
  useSessionState();
  const { rules: portForwardingRules, startTunnel, stopTunnel } = usePortForwardingState();
  const activeTabId = useActiveTabId();

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
    <div id="tray-panel-root" className="w-full h-full bg-background/95 supports-[backdrop-filter]:backdrop-blur-sm border border-border/60 rounded-lg shadow-lg overflow-hidden flex flex-col">
      <div className="px-3 py-2 border-b border-border/60 flex items-center justify-between app-no-drag">
        <div className="flex items-center gap-2">
          <AppLogo className="w-5 h-5" />
          <span className="text-sm font-medium">Netcatty</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
            onClick={handleOpenMain}
            title={t("tray.openMainWindow")}
          >
            <Maximize2 size={14} />
          </button>
          <button
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
            onClick={handleClose}
            title="Close"
          >
            <X size={14} />
          </button>
        </div>
      </div>

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
                    t={t}
                  />
                ))}
                {/* Solo sessions */}
                {soloSessions.map((s) => (
                  <button
                    key={s.id}
                    title={s.hostLabel || s.label}
                    onClick={() => {
                      void jumpToSession(s.id);
                    }}
                    className={cn(
                      "w-full text-left px-2 py-1.5 rounded hover:bg-muted flex items-center justify-between",
                      s.status === "connected" ? "" : "text-muted-foreground",
                      activeTabId === s.id ? "bg-muted" : "",
                    )}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <StatusDot
                        status={s.status === "connected" ? "success" : s.status === "connecting" ? "warning" : "error"}
                        spinning={s.status === "connecting"}
                      />
                      <span className="truncate">{s.hostLabel || s.label}</span>
                    </span>
                    <span className="ml-2 text-xs text-muted-foreground">{t(`tray.status.${s.status}`)}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })()}

        {activeSession && (
          <div>
            <div className="px-2 py-1 text-xs text-muted-foreground">Current</div>
            <Button
              variant="ghost"
              className="w-full justify-start px-2 h-8"
              title={activeSession.hostLabel || activeSession.label}
              onClick={() => {
                void jumpToSession(activeSession.id);
              }}
            >
              <span className="truncate">{activeSession.hostLabel || activeSession.label}</span>
            </Button>
          </div>
        )}

        {portForwardingRules.length > 0 && (
          <div>
            <div className="px-2 py-1 text-xs text-muted-foreground">{t("tray.portForwarding")}</div>
            <div className="space-y-1">
              {portForwardingRules.map((rule) => {
                const isConnecting = rule.status === "connecting";
                const isActive = rule.status === "active";
                const label = rule.label || (rule.type === "dynamic"
                  ? `SOCKS:${rule.localPort}`
                  : `${rule.localPort} → ${rule.remoteHost}:${rule.remotePort}`);

                return (
                  <button
                    key={rule.id}
                    disabled={isConnecting}
                    title={label}
                    onClick={() => {
                      const rawHost = rule.hostId ? hosts.find((h) => h.id === rule.hostId) : undefined;
                      if (!rawHost) {
                        toast.error(t("pf.error.hostNotFound"));
                        return;
                      }
                      if (isActive) {
                        void stopTunnel(rule.id);
                      } else {
                        const host = rawHost.group
                          ? applyGroupDefaults(rawHost, resolveGroupDefaults(rawHost.group, groupConfigs))
                          : rawHost;
                        void startTunnel(rule, host, hosts, keys, identities, (status, error) => {
                          if (status === "error" && error) toast.error(error);
                        }, rule.autoStart);
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
  );
};

const TrayPanel: React.FC = () => {
  const settings = useSettingsState();
  return (
    <I18nProvider locale={settings.uiLanguage}>
      <TrayPanelContent />
    </I18nProvider>
  );
};

export default TrayPanel;
