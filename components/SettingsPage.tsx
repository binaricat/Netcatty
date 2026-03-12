/**
 * Settings Page - Standalone settings window content
 * This component is rendered in a separate Electron window
 */
import { AppWindow, Cloud, FileType, HardDrive, Keyboard, Palette, TerminalSquare, X } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useSettingsState } from "../application/state/useSettingsState";
import { usePortForwardingState } from "../application/state/usePortForwardingState";
import { useVaultState } from "../application/state/useVaultState";
import { useWindowControls } from "../application/state/useWindowControls";
import { useUpdateCheck } from "../application/state/useUpdateCheck";
import { I18nProvider, useI18n } from "../application/i18n/I18nProvider";
import SettingsApplicationTab from "./SettingsApplicationTab";
import SettingsAppearanceTab from "./settings/tabs/SettingsAppearanceTab";
import SettingsFileAssociationsTab from "./settings/tabs/SettingsFileAssociationsTab";
import SettingsShortcutsTab from "./settings/tabs/SettingsShortcutsTab";
import SettingsTerminalTab from "./settings/tabs/SettingsTerminalTab";
import SettingsSystemTab from "./settings/tabs/SettingsSystemTab";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import type { TerminalFont } from "../infrastructure/config/fonts";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

type SettingsState = ReturnType<typeof useSettingsState> & {
    availableFonts: TerminalFont[];
};

const SettingsSyncTab = React.lazy(() => import("./settings/tabs/SettingsSyncTab"));

const SettingsSyncTabWithVault: React.FC = () => {
    const {
        hosts,
        keys,
        identities,
        snippets,
        customGroups,
        snippetPackages,
        knownHosts,
        importDataFromString,
        clearVaultData,
    } = useVaultState();

    const { rules: portForwardingRules, importRules: importPortForwardingRules } = usePortForwardingState();

    // Strip transient runtime fields before passing to sync
    const portForwardingRulesForSync = useMemo(
        () =>
            portForwardingRules.map((rule) => ({
                ...rule,
                status: "inactive" as const,
                error: undefined,
                lastUsedAt: undefined,
            })),
        [portForwardingRules],
    );

    const vault = useMemo(
        () => ({ hosts, keys, identities, snippets, customGroups, snippetPackages, knownHosts }),
        [hosts, keys, identities, snippets, customGroups, snippetPackages, knownHosts],
    );

    return (
        <SettingsSyncTab
            vault={vault}
            portForwardingRules={portForwardingRulesForSync}
            importDataFromString={importDataFromString}
            importPortForwardingRules={importPortForwardingRules}
            clearVaultData={clearVaultData}
        />
    );
};

const SettingsPageContent: React.FC<{ settings: SettingsState }> = ({ settings }) => {
    const { t } = useI18n();
    const { notifyRendererReady, closeSettingsWindow } = useWindowControls();
    const { updateState, checkNow, installUpdate, openReleasePage } = useUpdateCheck();
    const [activeTab, setActiveTab] = useState("application");
    const [mountedTabs, setMountedTabs] = useState(() => new Set(["application"]));

    useEffect(() => {
        notifyRendererReady();
    }, [notifyRendererReady]);

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
        <div className="h-screen flex flex-col bg-background text-foreground font-sans">
            <div className="shrink-0 border-b border-border app-drag">
                <div className="flex items-center justify-between px-4 pt-3">
                    {isMac && <div className="h-6" />}
                </div>
                <div className="flex items-center justify-between px-4 py-2">
                    <h1 className="text-lg font-semibold">{t("settings.title")}</h1>
                    {!isMac && (
                        <button
                            onClick={handleClose}
                            className="app-no-drag w-8 h-8 flex items-center justify-center rounded-md hover:bg-destructive/20 hover:text-destructive transition-colors text-muted-foreground"
                            title={t("common.close")}
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
                            className="w-full justify-start gap-2 px-3 py-2 text-sm data-[state=active]:bg-background hover:bg-background/60 rounded-md transition-colors"
                        >
                            <AppWindow size={14} /> {t("settings.tab.application")}
                        </TabsTrigger>
                        <TabsTrigger
                            value="appearance"
                            className="w-full justify-start gap-2 px-3 py-2 text-sm data-[state=active]:bg-background hover:bg-background/60 rounded-md transition-colors"
                        >
                            <Palette size={14} /> {t("settings.tab.appearance")}
                        </TabsTrigger>
                        <TabsTrigger
                            value="terminal"
                            className="w-full justify-start gap-2 px-3 py-2 text-sm data-[state=active]:bg-background hover:bg-background/60 rounded-md transition-colors"
                        >
                            <TerminalSquare size={14} /> {t("settings.tab.terminal")}
                        </TabsTrigger>
                        <TabsTrigger
                            value="shortcuts"
                            className="w-full justify-start gap-2 px-3 py-2 text-sm data-[state=active]:bg-background hover:bg-background/60 rounded-md transition-colors"
                        >
                            <Keyboard size={14} /> {t("settings.tab.shortcuts")}
                        </TabsTrigger>
                        <TabsTrigger
                            value="file-associations"
                            className="w-full justify-start gap-2 px-3 py-2 text-sm data-[state=active]:bg-background hover:bg-background/60 rounded-md transition-colors"
                        >
                            <FileType size={14} /> {t("settings.tab.sftpFileAssociations")}
                        </TabsTrigger>
                        <TabsTrigger
                            value="sync"
                            className="w-full justify-start gap-2 px-3 py-2 text-sm data-[state=active]:bg-background hover:bg-background/60 rounded-md transition-colors"
                        >
                            <Cloud size={14} /> {t("settings.tab.syncCloud")}
                        </TabsTrigger>
                        <TabsTrigger
                            value="system"
                            className="w-full justify-start gap-2 px-3 py-2 text-sm data-[state=active]:bg-background hover:bg-background/60 rounded-md transition-colors"
                        >
                            <HardDrive size={14} /> {t("settings.tab.system")}
                        </TabsTrigger>
                    </TabsList>
                </div>

                <div className="flex-1 h-full flex flex-col min-h-0 bg-muted/10">
                    {mountedTabs.has("application") && (
                        <SettingsApplicationTab
                            updateState={updateState}
                            checkNow={checkNow}
                            openReleasePage={openReleasePage}
                            installUpdate={installUpdate}
                        />
                    )}

                    {mountedTabs.has("appearance") && (
                        <SettingsAppearanceTab
                            theme={settings.theme}
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
                        />
                    )}

                    {mountedTabs.has("terminal") && (
                        <SettingsTerminalTab
                            terminalThemeId={settings.terminalThemeId}
                            setTerminalThemeId={settings.setTerminalThemeId}
                            terminalFontFamilyId={settings.terminalFontFamilyId}
                            setTerminalFontFamilyId={settings.setTerminalFontFamilyId}
                            terminalFontSize={settings.terminalFontSize}
                            setTerminalFontSize={settings.setTerminalFontSize}
                            terminalSettings={settings.terminalSettings}
                            updateTerminalSetting={settings.updateTerminalSetting}
                            availableFonts={settings.availableFonts}
                        />
                    )}

                    {mountedTabs.has("shortcuts") && (
                        <SettingsShortcutsTab
                            hotkeyScheme={settings.hotkeyScheme}
                            setHotkeyScheme={settings.setHotkeyScheme}
                            keyBindings={settings.keyBindings}
                            updateKeyBinding={settings.updateKeyBinding}
                            resetKeyBinding={settings.resetKeyBinding}
                            resetAllKeyBindings={settings.resetAllKeyBindings}
                            setIsHotkeyRecording={settings.setIsHotkeyRecording}
                        />
                    )}

                    {mountedTabs.has("file-associations") && (
                        <SettingsFileAssociationsTab />
                    )}

                    {mountedTabs.has("sync") && (
                        <React.Suspense fallback={null}>
                            <SettingsSyncTabWithVault />
                        </React.Suspense>
                    )}

                    {mountedTabs.has("system") && (
                        <SettingsSystemTab
                            sessionLogsEnabled={settings.sessionLogsEnabled}
                            setSessionLogsEnabled={settings.setSessionLogsEnabled}
                            sessionLogsDir={settings.sessionLogsDir}
                            setSessionLogsDir={settings.setSessionLogsDir}
                            sessionLogsFormat={settings.sessionLogsFormat}
                            setSessionLogsFormat={settings.setSessionLogsFormat}
                            toggleWindowHotkey={settings.toggleWindowHotkey}
                            setToggleWindowHotkey={settings.setToggleWindowHotkey}
                            closeToTray={settings.closeToTray}
                            setCloseToTray={settings.setCloseToTray}
                            hotkeyRegistrationError={settings.hotkeyRegistrationError}
                            updateState={updateState}
                            checkNow={checkNow}
                            installUpdate={installUpdate}
                            openReleasePage={openReleasePage}
                        />
                    )}
                </div>
            </Tabs>
        </div>
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
