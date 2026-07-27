import React from "react";
import { ExternalLink, RefreshCw, RotateCcw } from "lucide-react";
import { useI18n } from "../../../../application/i18n/I18nProvider";
import { Button } from "../../../ui/button";
import { cn } from "../../../../lib/utils";
import type { AgentPathInfo } from "./types";

export const AntigravityCliCard: React.FC<{
  pathInfo: AgentPathInfo | null;
  isResolvingPath: boolean;
  customPath: string;
  onCustomPathChange: (path: string) => void;
  onOpenInstallGuide: () => void;
  onRecheckPath: () => void;
  onResetPath: () => void;
}> = ({
  pathInfo,
  isResolvingPath,
  customPath,
  onCustomPathChange,
  onOpenInstallGuide,
  onRecheckPath,
  onResetPath,
}) => {
  const { t } = useI18n();
  const found = Boolean(pathInfo?.available && pathInfo.path);
  const installed = Boolean(pathInfo?.installed && pathInfo.path);
  const status = isResolvingPath
    ? t("ai.antigravity.detecting")
    : found
      ? t("ai.antigravity.detected")
      : installed
        ? t("ai.antigravity.upgradeStatus")
        : t("ai.antigravity.notFound");

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <p className="min-w-0 text-xs text-muted-foreground leading-5">
          {t("ai.antigravity.description")}
        </p>
        <span className={cn(
          "text-xs font-medium shrink-0",
          isResolvingPath ? "text-muted-foreground" : found ? "text-emerald-500" : "text-amber-500",
        )}>
          {status}
        </span>
      </div>

      {found || installed ? (
        <div className="space-y-1.5 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">{t("ai.antigravity.path")}</span>
            <span className="font-mono text-foreground truncate">{pathInfo?.path}</span>
            {pathInfo?.version ? (
              <>
                <span className="text-muted-foreground">|</span>
                <span className="text-muted-foreground">{pathInfo.version}</span>
              </>
            ) : null}
          </div>
          {found ? <p className="text-muted-foreground">{t("ai.antigravity.loginHint")}</p> : null}
          {found ? <p className="text-muted-foreground">{t("ai.antigravity.confirmHint")}</p> : null}
        </div>
      ) : null}

      {!found && installed && !isResolvingPath ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-amber-500">{t("ai.antigravity.upgradeRequired")}</p>
          <Button variant="outline" size="sm" onClick={onOpenInstallGuide}>
            <ExternalLink size={14} className="mr-1.5" />
            {t("ai.antigravity.installGuide")}
          </Button>
        </div>
      ) : null}

      {!found && !installed && !isResolvingPath ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-amber-500">{t("ai.antigravity.notFoundHint")}</p>
          <Button variant="outline" size="sm" onClick={onOpenInstallGuide}>
            <ExternalLink size={14} className="mr-1.5" />
            {t("ai.antigravity.installGuide")}
          </Button>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={customPath}
          onChange={(event) => onCustomPathChange(event.target.value)}
          placeholder={t("ai.antigravity.customPathPlaceholder")}
          className="flex-1 h-8 rounded-md border border-input bg-background px-3 text-sm font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <Button variant="outline" size="sm" onClick={onRecheckPath} disabled={isResolvingPath}>
          <RefreshCw size={14} className="mr-1.5" />
          {t("ai.antigravity.check")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onResetPath} disabled={!customPath.trim()}>
          <RotateCcw size={14} className="mr-1.5" />
          {t("ai.antigravity.resetPath")}
        </Button>
      </div>
    </div>
  );
};
