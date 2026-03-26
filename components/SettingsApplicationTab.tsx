import React, { useEffect, useMemo, useState } from "react";
import { ArrowUpCircle, Bug, Check, Github, Loader2, MessageCircle, Newspaper, RefreshCcw } from "lucide-react";
import AppLogo from "./AppLogo";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import { useApplicationBackend } from "../application/state/useApplicationBackend";
import type { UpdateState, UseUpdateCheckResult } from "../application/state/useUpdateCheck";
import { useI18n } from "../application/i18n/I18nProvider";
import { SettingsTabContent } from "./settings/settings-ui";
import { toast } from "./ui/toast";

type AppInfo = {
  name: string;
  version: string;
  platform?: string;
};

const REPO_URL = "https://github.com/binaricat/Netcatty";

const buildIssueUrl = (appInfo: AppInfo) => {
  const title = "Bug: ";
  const bodyLines = [
    "## Describe the problem",
    "",
    "## Steps to reproduce",
    "1.",
    "",
    "## Expected behavior",
    "",
    "## Actual behavior",
    "",
    "## Environment",
    `- App: ${appInfo.name} ${appInfo.version}`,
    `- Platform: ${appInfo.platform || "unknown"}`,
    `- UA: ${typeof navigator !== "undefined" ? navigator.userAgent : "unknown"}`,
  ];
  const params = new URLSearchParams({
    title,
    body: bodyLines.join("\n"),
  });
  return `${REPO_URL}/issues/new?${params.toString()}`;
};

const ActionRow: React.FC<{
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onClick: () => void;
}> = ({ icon, title, subtitle, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      "w-full flex items-center gap-3 rounded-lg px-3 py-3 text-left",
      "hover:bg-muted/50 transition-colors"
    )}
  >
    <div className="shrink-0 text-muted-foreground">{icon}</div>
    <div className="min-w-0">
      <div className="text-sm font-medium leading-tight">{title}</div>
      <div className="text-xs text-muted-foreground mt-0.5 truncate">{subtitle}</div>
    </div>
  </button>
);

interface SettingsApplicationTabProps {
  updateState: UpdateState;
  checkNow: UseUpdateCheckResult['checkNow'];
  openReleasePage: UseUpdateCheckResult['openReleasePage'];
  installUpdate: UseUpdateCheckResult['installUpdate'];
  startDownload: UseUpdateCheckResult['startDownload'];
  isUpdateDemoMode: boolean;
}

export default function SettingsApplicationTab({ updateState, checkNow, openReleasePage, installUpdate, startDownload, isUpdateDemoMode }: SettingsApplicationTabProps) {
  const { t } = useI18n();
  const { openExternal, getApplicationInfo } = useApplicationBackend();
  const [appInfo, setAppInfo] = useState<AppInfo>({ name: "Netcatty", version: "" });
  const [lastCheckResult, setLastCheckResult] = useState<'none' | 'available' | 'upToDate'>('none');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const info = await getApplicationInfo();
        if (!cancelled && info?.name && typeof info?.version === "string") {
          setAppInfo(info);
        }
      } catch {
        // Ignore: running in browser/dev without Electron bridge
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [getApplicationInfo]);

  const handleCheckForUpdates = async () => {
    // In demo mode, allow checking even for dev builds
    if (!isUpdateDemoMode && (!appInfo.version || appInfo.version === '0.0.0')) {
      // Dev build - just open releases page
      openReleasePage();
      return;
    }

    setLastCheckResult('none');

    const result = await checkNow();

    if (result?.hasUpdate && result.latestRelease) {
      setLastCheckResult('available');
      toast.info(
        t('update.available.message', { version: result.latestRelease.version }),
        t('update.available.title')
      );
      // Don't auto-open the release page here — checkNow() already triggers
      // electron-updater on supported platforms, and the Settings > System tab
      // shows a "Manual Download" link on unsupported platforms.
    } else if (result) {
      setLastCheckResult('upToDate');
      toast.success(
        t('update.upToDate.message', { version: appInfo.version }),
        t('update.upToDate.title')
      );
    }

    // Reset the result after 3 seconds
    setTimeout(() => setLastCheckResult('none'), 3000);
  };

  const issueUrl = useMemo(() => buildIssueUrl(appInfo), [appInfo]);
  const releasesUrl = `${REPO_URL}/releases`;
  const discussionsUrl = `${REPO_URL}/discussions`;

  return (
    <SettingsTabContent value="application">
      <div className="flex flex-col lg:flex-row gap-10 lg:gap-14">
        <div className="lg:w-[320px] shrink-0">
          <div className="flex items-center gap-4">
            <AppLogo className="w-16 h-16" />
            <div>
              <div className="text-3xl font-semibold leading-none">{appInfo.name}</div>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-sm text-muted-foreground">
                  {appInfo.version ? appInfo.version : " "}
                </span>
                {/* Update badge - reflects auto-download state */}
                {updateState.latestRelease && (updateState.hasUpdate || updateState.autoDownloadStatus === 'downloading' || updateState.autoDownloadStatus === 'ready') && (
                  <button
                    onClick={() => updateState.autoDownloadStatus === 'ready' ? installUpdate() : updateState.autoDownloadStatus === 'downloading' ? undefined : startDownload()}
                    className={cn(
                      "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium",
                      updateState.autoDownloadStatus === 'ready'
                        ? "bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300 hover:bg-green-200 dark:hover:bg-green-800"
                        : "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-800",
                      "transition-colors cursor-pointer"
                    )}
                  >
                    <ArrowUpCircle size={12} />
                    v{updateState.latestRelease.version}{' '}
                    {updateState.autoDownloadStatus === 'ready'
                      ? t('update.restartNow')
                      : updateState.autoDownloadStatus === 'downloading'
                        ? `${updateState.downloadPercent}%`
                        : t('update.downloadNow')}
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="mt-6">
            <Button
              variant="secondary"
              className="gap-2"
              onClick={() => void handleCheckForUpdates()}
              disabled={updateState.isChecking || updateState.manualCheckStatus === 'checking' || updateState.autoDownloadStatus === 'downloading' || updateState.autoDownloadStatus === 'ready'}
            >
              {updateState.isChecking ? (
                <Loader2 size={16} className="animate-spin" />
              ) : lastCheckResult === 'upToDate' ? (
                <Check size={16} />
              ) : (
                <RefreshCcw size={16} />
              )}
              {updateState.isChecking
                ? t("update.checking")
                : t("settings.application.checkUpdates")
              }
            </Button>
          </div>
        </div>

        <div className="flex-1">
          <div className="space-y-2">
            <ActionRow
              icon={<Bug size={18} />}
              title={t("settings.application.reportProblem")}
              subtitle={t("settings.application.reportProblem.subtitle")}
              onClick={() => void openExternal(issueUrl)}
            />
            <ActionRow
              icon={<MessageCircle size={18} />}
              title={t("settings.application.community")}
              subtitle={t("settings.application.community.subtitle")}
              onClick={() => void openExternal(discussionsUrl)}
            />
            <ActionRow
              icon={<Github size={18} />}
              title="GitHub"
              subtitle={t("settings.application.github.subtitle")}
              onClick={() => void openExternal(REPO_URL)}
            />
            <ActionRow
              icon={<Newspaper size={18} />}
              title={t("settings.application.whatsNew")}
              subtitle={t("settings.application.whatsNew.subtitle")}
              onClick={() => void openExternal(releasesUrl)}
            />
          </div>
        </div>
      </div>
    </SettingsTabContent>
  );
}
