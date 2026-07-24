/**
 * Settings Page - Standalone settings window content
 * This component is rendered in a separate Electron window
 */
import { AppWindow, Cloud, FileType, HardDrive, Keyboard, Palette, Puzzle, Sparkles, TerminalSquare, X } from "lucide-react";
import React, { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSettingsState } from "../application/state/useSettingsState";
import { useAISettingsState } from "../application/state/useAISettingsState";
import { useAvailableFonts } from "../application/state/fontStore";
import { usePortForwardingState } from "../application/state/usePortForwardingState";
import { useVaultState } from "../application/state/useVaultState";
import { useWindowControls } from "../application/state/useWindowControls";
import { useUpdateCheck } from "../application/state/useUpdateCheck";
import { I18nProvider, useI18n } from "../application/i18n/I18nProvider";
import { sanitizePortForwardingRulesForSync } from "../application/syncPayload";
import { toast } from "./ui/toast";
import { SettingsTabContent } from "./settings/settings-ui";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { LazyLoadBoundary } from "./ui/lazy-load-boundary";
import { ExternalMcpApprovalsHost } from "./ai/ExternalMcpApprovalsHost";
import { useExternalMcpGrantPersister } from "./ai/useExternalMcpGrantPersister";
import { setupMcpApprovalBridge } from "../infrastructure/ai/shared/approvalGate";
import { usePluginContributions } from "../application/state/usePluginContributions";
import { PluginContributionHost } from "./plugins/PluginContributionHost";

const LazySettingsApplicationTab = lazy(() => import("./SettingsApplicationTab"));
const LazySettingsAppearanceTab = lazy(() => import("./settings/tabs/SettingsAppearanceTab"));
const LazySettingsFileAssociationsTab = lazy(() => import("./settings/tabs/SettingsFileAssociationsTab"));
const LazySettingsShortcutsTab = lazy(() => import("./settings/tabs/SettingsShortcutsTab"));
const LazySettingsAITab = lazy(() => import("./settings/tabs/SettingsAITab"));
const LazySettingsSyncTab = lazy(() => import("./settings/tabs/SettingsSyncTab"));
const LazySettingsTerminalTab = lazy(() => import("./settings/tabs/SettingsTerminalTab"));
const LazySettingsSystemTab = lazy(() => import("./settings/tabs/SettingsSystemTab"));
const LazySettingsPluginsTab = lazy(() => import("./settings/tabs/SettingsPluginsTab"));

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

type AITabErrorBoundaryProps = { children: React.ReactNode };
type AITabErrorBoundaryState = { error: Error | null };

class AITabErrorBoundary extends React.Component<
  AITabErrorBoundaryProps,
  AITabErrorBoundaryState
> {
  declare props: Readonly<AITabErrorBoundaryProps>;
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, color: "#f87171", fontFamily: "monospace", whiteSpace: "pre-wrap" }}>
          <h3 style={{ marginBottom: 8 }}>AI Settings Error</h3>
          <div>{this.state.error.message}</div>
          <div style={{ marginTop: 8, fontSize: 12, color: "#888" }}>{this.state.error.stack}</div>
        </div>
      );
    }
    return this.props.children;
  }
}

type SettingsState = ReturnType<typeof useSettingsState>;

const settingsTabTriggerClassName =
    "w-full justify-start gap-2 px-3 py-2 text-sm data-[state=active]:bg-background hover:bg-background/60 rounded-md transition-colors overflow-hidden";
const settingsTabIconClassName = "shrink-0";
const settingsTabLabelClassName = "min-w-0 truncate";

const SettingsTabLoading = ({ value }: { value: string }) => (
    <SettingsTabContent value={value}>
        <div className="netcatty-lazy-fade-in min-h-[320px]" aria-hidden="true" />
    </SettingsTabContent>
);

const SettingsTabLoadError = ({ value, error }: { value: string; error?: Error }) => (
    <SettingsTabContent value={value}>
        <div className="flex min-h-[320px] flex-col items-start justify-center gap-3 text-sm text-muted-foreground">
            <div className="font-medium text-foreground">This settings tab could not load.</div>
            {error?.message && (
                <div className="max-w-md text-xs font-mono text-destructive/90 break-words">
                    {error.message}
                </div>
            )}
            <button
                type="button"
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                onClick={() => window.location.reload()}
            >
                Reload
            </button>
        </div>
    </SettingsTabContent>
);

const SettingsLazyTab = ({ children, value }: { children: React.ReactNode; value: string }) => (
    <LazyLoadBoundary
        name="Settings tab"
        resetKey={value}
        fallback={(error) => <SettingsTabLoadError value={value} error={error} />}
    >
        <Suspense fallback={<SettingsTabLoading value={value} />}>
            {children}
        </Suspense>
    </LazyLoadBoundary>
);

type TerminalTabSettingsProps = Pick<
    SettingsState,
    | 'terminalThemeId'
    | 'setTerminalThemeId'
    | 'resolvedTheme'
    | 'followAppTerminalTheme'
    | 'setFollowAppTerminalTheme'
    | 'terminalThemeDarkId'
    | 'setTerminalThemeDarkId'
    | 'terminalThemeLightId'
    | 'setTerminalThemeLightId'
    | 'lightUiThemeId'
    | 'darkUiThemeId'
    | 'terminalFontFamilyId'
    | 'setTerminalFontFamilyId'
    | 'terminalFontSize'
    | 'setTerminalFontSize'
    | 'terminalSettings'
    | 'updateTerminalSetting'
    | 'terminalSidePanelAutoOpen'
    | 'setTerminalSidePanelAutoOpen'
    | 'terminalSidePanelAutoOpenTab'
    | 'setTerminalSidePanelAutoOpenTab'
    | 'workspaceFocusStyle'
    | 'setWorkspaceFocusStyle'
>;

const SettingsTerminalTabContainer = React.memo<TerminalTabSettingsProps>(function SettingsTerminalTabContainer({
    terminalThemeId,
    setTerminalThemeId,
    resolvedTheme,
    followAppTerminalTheme,
    setFollowAppTerminalTheme,
    terminalThemeDarkId,
    setTerminalThemeDarkId,
    terminalThemeLightId,
    setTerminalThemeLightId,
    lightUiThemeId,
    darkUiThemeId,
    terminalFontFamilyId,
    setTerminalFontFamilyId,
    terminalFontSize,
    setTerminalFontSize,
    terminalSettings,
    updateTerminalSetting,
    terminalSidePanelAutoOpen,
    setTerminalSidePanelAutoOpen,
    terminalSidePanelAutoOpenTab,
    setTerminalSidePanelAutoOpenTab,
    workspaceFocusStyle,
    setWorkspaceFocusStyle,
}) {
    const availableFonts = useAvailableFonts();

    return (
        <LazySettingsTerminalTab
            terminalThemeId={terminalThemeId}
            setTerminalThemeId={setTerminalThemeId}
            resolvedTheme={resolvedTheme}
            followAppTerminalTheme={followAppTerminalTheme}
            setFollowAppTerminalTheme={setFollowAppTerminalTheme}
            terminalThemeDarkId={terminalThemeDarkId}
            setTerminalThemeDarkId={setTerminalThemeDarkId}
            terminalThemeLightId={terminalThemeLightId}
            setTerminalThemeLightId={setTerminalThemeLightId}
            lightUiThemeId={lightUiThemeId}
            darkUiThemeId={darkUiThemeId}
            terminalFontFamilyId={terminalFontFamilyId}
            setTerminalFontFamilyId={setTerminalFontFamilyId}
            terminalFontSize={terminalFontSize}
            setTerminalFontSize={setTerminalFontSize}
            terminalSettings={terminalSettings}
            updateTerminalSetting={updateTerminalSetting}
            terminalSidePanelAutoOpen={terminalSidePanelAutoOpen}
            setTerminalSidePanelAutoOpen={setTerminalSidePanelAutoOpen}
            terminalSidePanelAutoOpenTab={terminalSidePanelAutoOpenTab}
            setTerminalSidePanelAutoOpenTab={setTerminalSidePanelAutoOpenTab}
            availableFonts={availableFonts}
            workspaceFocusStyle={workspaceFocusStyle}
            setWorkspaceFocusStyle={setWorkspaceFocusStyle}
        />
    );
});

const SettingsAITabContainer: React.FC = () => {
    const aiState = useAISettingsState();

    return (
        <AITabErrorBoundary>
            <LazySettingsAITab
                providers={aiState.providers}
                addProvider={aiState.addProvider}
                updateProvider={aiState.updateProvider}
                removeProvider={aiState.removeProvider}
                activeProviderId={aiState.activeProviderId}
                setActiveProviderId={aiState.setActiveProviderId}
                activeModelId={aiState.activeModelId}
                setActiveModelId={aiState.setActiveModelId}
                globalPermissionMode={aiState.globalPermissionMode}
                setGlobalPermissionMode={aiState.setGlobalPermissionMode}
                toolIntegrationMode={aiState.toolIntegrationMode}
                setToolIntegrationMode={aiState.setToolIntegrationMode}
                externalAgents={aiState.externalAgents}
                setExternalAgents={aiState.setExternalAgents}
                defaultAgentId={aiState.defaultAgentId}
                setDefaultAgentId={aiState.setDefaultAgentId}
                commandBlocklist={aiState.commandBlocklist}
                setCommandBlocklist={aiState.setCommandBlocklist}
                commandTimeout={aiState.commandTimeout}
                setCommandTimeout={aiState.setCommandTimeout}
                maxIterations={aiState.maxIterations}
                setMaxIterations={aiState.setMaxIterations}
                webSearchConfig={aiState.webSearchConfig}
                setWebSearchConfig={aiState.setWebSearchConfig}
                quickMessages={aiState.quickMessages}
                setQuickMessages={aiState.setQuickMessages}
                showTerminalSelectionAIAction={aiState.showTerminalSelectionAIAction}
                setShowTerminalSelectionAIAction={aiState.setShowTerminalSelectionAIAction}
            />
        </AITabErrorBoundary>
    );
};

const SettingsSyncTabWithVault: React.FC<{ onSettingsApplied?: () => void }> = ({ onSettingsApplied }) => {
    const {
        hosts,
        keys,
        identities,
        proxyProfiles,
        snippets,
        customGroups,
        snippetPackages,
        notes,
        noteGroups,
        knownHosts,
        groupConfigs,
        importDataFromString,
        clearVaultData,
    } = useVaultState();

    const { rules: portForwardingRules, importRules: importPortForwardingRules } = usePortForwardingState();

    // Strip transient runtime fields before passing to sync
    const portForwardingRulesForSync = useMemo(
        () => sanitizePortForwardingRulesForSync(portForwardingRules) ?? [],
        [portForwardingRules],
    );

    const vault = useMemo(
        () => ({
            hosts,
            keys,
            identities,
            proxyProfiles,
            snippets,
            customGroups,
            snippetPackages,
            notes,
            noteGroups,
            knownHosts,
            groupConfigs,
        }),
        [
            hosts,
            keys,
            identities,
            proxyProfiles,
            snippets,
            customGroups,
            snippetPackages,
            notes,
            noteGroups,
            knownHosts,
            groupConfigs,
        ],
    );

    return (
        <LazySettingsSyncTab
            vault={vault}
            portForwardingRules={portForwardingRulesForSync}
            importDataFromString={importDataFromString}
            importPortForwardingRules={importPortForwardingRules}
            clearVaultData={clearVaultData}
            onSettingsApplied={onSettingsApplied}
        />
    );
};

const SettingsPageContent: React.FC<{ settings: SettingsState }> = ({ settings }) => {
    const { t } = useI18n();
    const { notifyRendererReady, closeSettingsWindow, onWindowCommandCloseRequested } = useWindowControls();
    const { updateState, checkNow, installUpdate, openReleasePage, startDownload, isUpdateDemoMode } = useUpdateCheck({
        autoUpdateEnabled: settings.autoUpdateEnabled,
        // Install blocked by unsaved editors in the main window — surface a toast
        // here so a click from the Settings window isn't a silent no-op (#1215).
        onNeedsSave: () => toast.warning(t('update.needsSave.message'), t('update.needsSave.title')),
    });
    const [activeTab, setActiveTab] = useState("application");
    const [mountedTabs, setMountedTabs] = useState(() => new Set(["application"]));
    const { available: pluginRuntimeAvailable } = usePluginContributions();

    useEffect(() => {
        notifyRendererReady();
    }, [notifyRendererReady]);

    useEffect(() => {
        return setupMcpApprovalBridge();
    }, []);

    useExternalMcpGrantPersister();

    useEffect(() => {
        const unsubscribe = onWindowCommandCloseRequested(() => {
            void closeSettingsWindow();
        });
        return () => unsubscribe?.();
    }, [closeSettingsWindow, onWindowCommandCloseRequested]);

    useEffect(() => {
        setMountedTabs((prev) => {
            if (prev.has(activeTab)) return prev;
            const next = new Set(prev);
            next.add(activeTab);
            return next;
        });
    }, [activeTab]);

    const handleClose = useCallback(() => {
        closeSettingsWindow();
    }, [closeSettingsWindow]);

    return (
        <>
        <div className="settings-window h-screen flex flex-col bg-background text-foreground font-sans">
            <div className="shrink-0 border-b border-border app-drag">
                <div className="flex items-center justify-between px-4 pt-3">
                    {isMac && <div className="h-6" />}
                </div>
                <div className="flex items-center justify-between px-4 py-2">
                    <h1 className="text-lg font-semibold">{t("settings.title")}</h1>
                    {!isMac && (
                        // No tooltip: on Windows the primary-colored tooltip sits in a
                        // drag titlebar region, can stick open, and blocks the real X.
                        <button
                            type="button"
                            onClick={handleClose}
                            aria-label={t("common.close")}
                            className="app-no-drag w-8 h-8 flex items-center justify-center rounded-md hover:bg-destructive/20 hover:text-destructive transition-colors text-muted-foreground"
                        >
                            <X size={16} />
                        </button>
                    )}
                </div>
            </div>

            <Tabs
                value={activeTab}
                onValueChange={setActiveTab}
                orientation="vertical"
                className="flex-1 flex overflow-hidden"
            >
                <div className="w-56 border-r border-border flex flex-col shrink-0 px-3 py-3">
                    <TabsList className="flex flex-col h-auto bg-transparent gap-1 p-0 justify-start">
                        <TabsTrigger
                            value="application"
                            className={settingsTabTriggerClassName}
                        >
                            <AppWindow size={14} className={settingsTabIconClassName} />
                            <span className={settingsTabLabelClassName}>{t("settings.tab.application")}</span>
                        </TabsTrigger>
                        {pluginRuntimeAvailable && (
                            <TabsTrigger value="plugins" className={settingsTabTriggerClassName}>
                                <Puzzle size={14} className={settingsTabIconClassName} />
                                <span className={settingsTabLabelClassName}>{t("settings.tab.plugins")}</span>
                            </TabsTrigger>
                        )}
                        <TabsTrigger
                            value="appearance"
                            className={settingsTabTriggerClassName}
                        >
                            <Palette size={14} className={settingsTabIconClassName} />
                            <span className={settingsTabLabelClassName}>{t("settings.tab.appearance")}</span>
                        </TabsTrigger>
                        <TabsTrigger
                            value="terminal"
                            className={settingsTabTriggerClassName}
                        >
                            <TerminalSquare size={14} className={settingsTabIconClassName} />
                            <span className={settingsTabLabelClassName}>{t("settings.tab.terminal")}</span>
                        </TabsTrigger>
                        <TabsTrigger
                            value="shortcuts"
                            className={settingsTabTriggerClassName}
                        >
                            <Keyboard size={14} className={settingsTabIconClassName} />
                            <span className={settingsTabLabelClassName}>{t("settings.tab.shortcuts")}</span>
                        </TabsTrigger>
                        <TabsTrigger
                            value="file-associations"
                            className={settingsTabTriggerClassName}
                        >
                            <FileType size={14} className={settingsTabIconClassName} />
                            <span className={settingsTabLabelClassName}>{t("settings.tab.sftpFileAssociations")}</span>
                        </TabsTrigger>
                        <TabsTrigger
                            value="ai"
                            className={settingsTabTriggerClassName}
                        >
                            <Sparkles size={14} className={settingsTabIconClassName} />
                            <span className={settingsTabLabelClassName}>AI</span>
                        </TabsTrigger>
                        <TabsTrigger
                            value="sync"
                            className={settingsTabTriggerClassName}
                        >
                            <Cloud size={14} className={settingsTabIconClassName} />
                            <span className={settingsTabLabelClassName}>{t("settings.tab.syncCloud")}</span>
                        </TabsTrigger>
                        <TabsTrigger
                            value="system"
                            className={settingsTabTriggerClassName}
                        >
                            <HardDrive size={14} className={settingsTabIconClassName} />
                            <span className={settingsTabLabelClassName}>{t("settings.tab.system")}</span>
                        </TabsTrigger>
                    </TabsList>
                </div>

                <div className="flex-1 h-full flex flex-col min-h-0 bg-muted/10">
                    {mountedTabs.has("application") && (
                        <SettingsLazyTab value="application">
                            <LazySettingsApplicationTab
                                updateState={updateState}
                                checkNow={checkNow}
                                openReleasePage={openReleasePage}
                                installUpdate={installUpdate}
                                startDownload={startDownload}
                                isUpdateDemoMode={isUpdateDemoMode}
                            />
                        </SettingsLazyTab>
                    )}

                    {mountedTabs.has("appearance") && (
                        <SettingsLazyTab value="appearance">
                            <LazySettingsAppearanceTab
                                theme={settings.theme}
                                resolvedTheme={settings.resolvedTheme}
                                setTheme={settings.setTheme}
                                lightUiThemeId={settings.lightUiThemeId}
                                setLightUiThemeId={settings.setLightUiThemeId}
                                darkUiThemeId={settings.darkUiThemeId}
                                setDarkUiThemeId={settings.setDarkUiThemeId}
                                accentMode={settings.accentMode}
                                setAccentMode={settings.setAccentMode}
                                customAccent={settings.customAccent}
                                setCustomAccent={settings.setCustomAccent}
                                uiFontFamilyId={settings.uiFontFamilyId}
                                setUiFontFamilyId={settings.setUiFontFamilyId}
                                uiLanguage={settings.uiLanguage}
                                setUiLanguage={settings.setUiLanguage}
                                customCSS={settings.customCSS}
                                setCustomCSS={settings.setCustomCSS}
                                showRecentHosts={settings.showRecentHosts}
                                setShowRecentHosts={settings.setShowRecentHosts}
                                hostClickBehavior={settings.hostClickBehavior}
                                setHostClickBehavior={settings.setHostClickBehavior}
                                showOnlyUngroupedHostsInRoot={settings.showOnlyUngroupedHostsInRoot}
                                setShowOnlyUngroupedHostsInRoot={settings.setShowOnlyUngroupedHostsInRoot}
                                showSftpTab={settings.showSftpTab}
                                setShowSftpTab={settings.setShowSftpTab}
                                showHostTreeSidebar={settings.showHostTreeSidebar}
                                setShowHostTreeSidebar={settings.setShowHostTreeSidebar}
                                windowOpacity={settings.windowOpacity}
                                setWindowOpacity={settings.setWindowOpacity}
                                appIconVariant={settings.appIconVariant}
                                setAppIconVariant={settings.setAppIconVariant}
                            />
                        </SettingsLazyTab>
                    )}

                    {mountedTabs.has("terminal") && (
                        <SettingsLazyTab value="terminal">
                            <SettingsTerminalTabContainer
                                terminalThemeId={settings.terminalThemeId}
                                setTerminalThemeId={settings.setTerminalThemeId}
                                resolvedTheme={settings.resolvedTheme}
                                followAppTerminalTheme={settings.followAppTerminalTheme}
                                setFollowAppTerminalTheme={settings.setFollowAppTerminalTheme}
                                terminalThemeDarkId={settings.terminalThemeDarkId}
                                setTerminalThemeDarkId={settings.setTerminalThemeDarkId}
                                terminalThemeLightId={settings.terminalThemeLightId}
                                setTerminalThemeLightId={settings.setTerminalThemeLightId}
                                lightUiThemeId={settings.lightUiThemeId}
                                darkUiThemeId={settings.darkUiThemeId}
                                terminalFontFamilyId={settings.terminalFontFamilyId}
                                setTerminalFontFamilyId={settings.setTerminalFontFamilyId}
                                terminalFontSize={settings.terminalFontSize}
                                setTerminalFontSize={settings.setTerminalFontSize}
                                terminalSettings={settings.terminalSettings}
                                updateTerminalSetting={settings.updateTerminalSetting}
                                terminalSidePanelAutoOpen={settings.terminalSidePanelAutoOpen}
                                setTerminalSidePanelAutoOpen={settings.setTerminalSidePanelAutoOpen}
                                terminalSidePanelAutoOpenTab={settings.terminalSidePanelAutoOpenTab}
                                setTerminalSidePanelAutoOpenTab={settings.setTerminalSidePanelAutoOpenTab}
                                workspaceFocusStyle={settings.workspaceFocusStyle}
                                setWorkspaceFocusStyle={settings.setWorkspaceFocusStyle}
                            />
                        </SettingsLazyTab>
                    )}

                    {mountedTabs.has("shortcuts") && (
                        <SettingsLazyTab value="shortcuts">
                            <LazySettingsShortcutsTab
                                hotkeyScheme={settings.hotkeyScheme}
                                setHotkeyScheme={settings.setHotkeyScheme}
                                shellOnlyTabNumberShortcuts={settings.shellOnlyTabNumberShortcuts}
                                setShellOnlyTabNumberShortcuts={settings.setShellOnlyTabNumberShortcuts}
                                disableTerminalFontZoom={settings.disableTerminalFontZoom}
                                setDisableTerminalFontZoom={settings.setDisableTerminalFontZoom}
                                keyBindings={settings.keyBindings}
                                updateKeyBinding={settings.updateKeyBinding}
                                resetKeyBinding={settings.resetKeyBinding}
                                resetAllKeyBindings={settings.resetAllKeyBindings}
                                setIsHotkeyRecording={settings.setIsHotkeyRecording}
                            />
                        </SettingsLazyTab>
                    )}

                    {mountedTabs.has("file-associations") && (
                        <SettingsLazyTab value="file-associations">
                            <LazySettingsFileAssociationsTab />
                        </SettingsLazyTab>
                    )}

                    {mountedTabs.has("ai") && (
                        <SettingsLazyTab value="ai">
                            <SettingsAITabContainer />
                        </SettingsLazyTab>
                    )}

                    {mountedTabs.has("sync") && (
                        <SettingsLazyTab value="sync">
                            <SettingsSyncTabWithVault onSettingsApplied={settings.rehydrateAllFromStorage} />
                        </SettingsLazyTab>
                    )}

                    {mountedTabs.has("system") && (
                        <SettingsLazyTab value="system">
                            <LazySettingsSystemTab
                                sessionLogsEnabled={settings.sessionLogsEnabled}
                                setSessionLogsEnabled={settings.setSessionLogsEnabled}
                                sessionLogsDir={settings.sessionLogsDir}
                                setSessionLogsDir={settings.setSessionLogsDir}
                                sessionLogsFormat={settings.sessionLogsFormat}
                                setSessionLogsFormat={settings.setSessionLogsFormat}
                                sessionLogsTimestampsEnabled={settings.sessionLogsTimestampsEnabled}
                                setSessionLogsTimestampsEnabled={settings.setSessionLogsTimestampsEnabled}
                                sshDebugLogsEnabled={settings.sshDebugLogsEnabled}
                                setSshDebugLogsEnabled={settings.setSshDebugLogsEnabled}
                                sshDeepLinkEnabled={settings.sshDeepLinkEnabled}
                                setSshDeepLinkEnabled={settings.setSshDeepLinkEnabled}
                                jmsDeepLinkEnabled={settings.jmsDeepLinkEnabled}
                                setJmsDeepLinkEnabled={settings.setJmsDeepLinkEnabled}
                                restorePreviousSession={settings.restorePreviousSession}
                                setRestorePreviousSession={settings.setRestorePreviousSession}
                                restoreTerminalCwd={settings.restoreTerminalCwd}
                                setRestoreTerminalCwd={settings.setRestoreTerminalCwd}
                                toggleWindowHotkey={settings.toggleWindowHotkey}
                                setToggleWindowHotkey={settings.setToggleWindowHotkey}
                                closeToTray={settings.closeToTray}
                                setCloseToTray={settings.setCloseToTray}
                                httpNetworkProxy={settings.httpNetworkProxy}
                                setHttpNetworkProxy={settings.setHttpNetworkProxy}
                                hotkeyRegistrationError={settings.hotkeyRegistrationError}
                                globalHotkeyEnabled={settings.globalHotkeyEnabled}
                                setGlobalHotkeyEnabled={settings.setGlobalHotkeyEnabled}
                                autoUpdateEnabled={settings.autoUpdateEnabled}
                                setAutoUpdateEnabled={settings.setAutoUpdateEnabled}
                                updateState={updateState}
                                checkNow={checkNow}
                                installUpdate={installUpdate}
                                openReleasePage={openReleasePage}
                                startDownload={startDownload}
                            />
                        </SettingsLazyTab>
                    )}
                    {mountedTabs.has("plugins") && pluginRuntimeAvailable && (
                        <SettingsLazyTab value="plugins">
                            <LazySettingsPluginsTab />
                        </SettingsLazyTab>
                    )}
                </div>
            </Tabs>
        </div>
        <ExternalMcpApprovalsHost />
        <PluginContributionHost locale={settings.uiLanguage} theme={settings.resolvedTheme} />
        </>
    );
};

export default function SettingsPage() {
    const settings = useSettingsState();

    return (
        <I18nProvider locale={settings.uiLanguage}>
            <SettingsPageContent settings={settings} />
        </I18nProvider>
    );
}
