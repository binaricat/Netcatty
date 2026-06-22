import React from "react";
import { RefreshCw, RotateCcw } from "lucide-react";
import { useI18n } from "../../../../application/i18n/I18nProvider";
import { Button } from "../../../ui/button";
import { cn } from "../../../../lib/utils";
import type { AgentPathInfo } from "./types";

export const CopilotCliCard: React.FC<{
  pathInfo: AgentPathInfo | null;
  isResolvingPath: boolean;
  customPath: string;
  onCustomPathChange: (path: string) => void;
  onRecheckPath: () => void;
  onResetPath?: () => void;
  i18nPrefix?: "ai.copilot" | "ai.cursor";
  allowEmptyCheck?: boolean;
  showCustomPathInput?: boolean;
}> = ({
  pathInfo,
  isResolvingPath,
  customPath,
  onCustomPathChange,
  onRecheckPath,
  onResetPath,
  i18nPrefix = "ai.copilot",
  allowEmptyCheck = false,
  showCustomPathInput = true,
}) => {
  const { t } = useI18n();
  const found = pathInfo?.available;

  const statusText = isResolvingPath
    ? t(`${i18nPrefix}.detecting`)
    : found
      ? t(`${i18nPrefix}.detected`)
      : t(`${i18nPrefix}.notFound`);

  const statusClassName = isResolvingPath
    ? "text-muted-foreground"
    : found
      ? "text-emerald-500"
      : "text-amber-500";

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <p className="min-w-0 text-xs text-muted-foreground leading-5">
          {t(`${i18nPrefix}.description`)}
        </p>
        <div className={cn("text-xs font-medium shrink-0", statusClassName)}>
          {statusText}
        </div>
      </div>

      {found && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">{t(`${i18nPrefix}.path`)}</span>
          <span className="font-mono text-foreground truncate">{pathInfo.path}</span>
          {pathInfo.version && (
            <>
              <span className="text-muted-foreground">|</span>
              <span className="text-muted-foreground">{pathInfo.version}</span>
            </>
          )}
        </div>
      )}

      {!isResolvingPath && (
        <div className="space-y-2">
          {!found && (
            <p className="text-xs text-amber-500">
              {t(`${i18nPrefix}.notFoundHint`)}
            </p>
          )}
          <div className={cn("flex items-center gap-2", showCustomPathInput ? "" : "justify-end")}>
            {showCustomPathInput && (
              <input
                type="text"
                value={customPath}
                onChange={(e) => onCustomPathChange(e.target.value)}
                placeholder={t(`${i18nPrefix}.customPathPlaceholder`)}
                className="flex-1 h-8 rounded-md border border-input bg-background px-3 text-sm font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            )}
            <Button variant="outline" size="sm" onClick={onRecheckPath} disabled={!allowEmptyCheck && !customPath.trim()}>
              <RefreshCw size={14} className="mr-1.5" />
              {t(`${i18nPrefix}.check`)}
            </Button>
            {showCustomPathInput && onResetPath && (
              <Button variant="ghost" size="sm" onClick={onResetPath} disabled={!customPath.trim()}>
                <RotateCcw size={14} className="mr-1.5" />
                {t(`${i18nPrefix}.resetPath`)}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
