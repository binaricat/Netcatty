import React from "react";
import { RefreshCw, RotateCcw } from "lucide-react";
import { useI18n } from "../../../../application/i18n/I18nProvider";
import { Button } from "../../../ui/button";
import { Switch } from "../../../ui/switch";
import { cn } from "../../../../lib/utils";
import type { GrokRuntime } from "../../../../infrastructure/ai/types";
import type { AgentPathInfo } from "./types";

export const CopilotCliCard: React.FC<{
  pathInfo: AgentPathInfo | null;
  isResolvingPath: boolean;
  customPath: string;
  onCustomPathChange: (path: string) => void;
  onRecheckPath: () => void;
  onResetPath?: () => void;
  i18nPrefix?: "ai.copilot" | "ai.cursor" | "ai.opencode" | "ai.grok" | "ai.mimo";
  allowEmptyCheck?: boolean;
  showCustomPathInput?: boolean;
  /** Grok only: ACP (default) vs headless streaming-json. */
  grokRuntime?: GrokRuntime;
  onGrokRuntimeChange?: (runtime: GrokRuntime) => void;
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
  grokRuntime = "acp",
  onGrokRuntimeChange,
}) => {
  const { t } = useI18n();
  const found = pathInfo?.available;
  const showGrokRuntime = i18nPrefix === "ai.grok" && typeof onGrokRuntimeChange === "function";

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

      {showGrokRuntime && found && (
        <div className="border-t border-border/40 pt-3 flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{t("ai.grok.runtime.acp.title")}</span>
              <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                {t("ai.grok.runtime.acp.default")}
              </span>
            </div>
            <p className="text-xs text-muted-foreground leading-5">
              {t("ai.grok.runtime.acp.description")}
            </p>
            {grokRuntime === "streaming-json" && (
              <p className="text-xs text-muted-foreground leading-5">
                {t("ai.grok.runtime.streamingJson.hint")}
              </p>
            )}
          </div>
          <Switch
            checked={grokRuntime === "acp"}
            aria-label={t("ai.grok.runtime.acp.title")}
            onCheckedChange={(checked) =>
              onGrokRuntimeChange?.(checked ? "acp" : "streaming-json")
            }
          />
        </div>
      )}
    </div>
  );
};
