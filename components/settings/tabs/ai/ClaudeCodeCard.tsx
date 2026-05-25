import React from "react";
import { RefreshCw } from "lucide-react";
import { useI18n } from "../../../../application/i18n/I18nProvider";
import { Button } from "../../../ui/button";
import { cn } from "../../../../lib/utils";
import type { AgentPathInfo } from "./types";
import { ProviderIconBadge } from "./ProviderIconBadge";

export const ClaudeCodeCard: React.FC<{
  pathInfo: AgentPathInfo | null;
  isResolvingPath: boolean;
  customPath: string;
  onCustomPathChange: (path: string) => void;
  onRecheckPath: () => void;
  configDir: string;
  onConfigDirChange: (value: string) => void;
  envText: string;
  onEnvTextChange: (value: string) => void;
}> = ({
  pathInfo,
  isResolvingPath,
  customPath,
  onCustomPathChange,
  onRecheckPath,
  configDir,
  onConfigDirChange,
  envText,
  onEnvTextChange,
}) => {
  const { t } = useI18n();
  const found = pathInfo?.available;

  const statusText = isResolvingPath
    ? t('ai.claude.detecting')
    : found
      ? t('ai.claude.detected')
      : t('ai.claude.notFound');

  const statusClassName = isResolvingPath
    ? "text-muted-foreground"
    : found
      ? "text-emerald-500"
      : "text-amber-500";

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ProviderIconBadge providerId="claude" size="sm" />
            <span className="text-sm font-medium">{t('ai.claude.title')}</span>
          </div>
          <p className="text-xs text-muted-foreground mt-2 leading-5">
            {t('ai.claude.description')}
          </p>
        </div>
        <div className={cn("text-xs font-medium shrink-0", statusClassName)}>
          {statusText}
        </div>
      </div>

      {/* Path detection info */}
      {found ? (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">{t('ai.claude.path')}</span>
          <span className="font-mono text-foreground truncate">{pathInfo.path}</span>
          {pathInfo.version && (
            <>
              <span className="text-muted-foreground">|</span>
              <span className="text-muted-foreground">{pathInfo.version}</span>
            </>
          )}
        </div>
      ) : !isResolvingPath ? (
        <div className="space-y-2">
          <p className="text-xs text-amber-500">
            {t('ai.claude.notFoundHint')}
          </p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={customPath}
              onChange={(e) => onCustomPathChange(e.target.value)}
              placeholder={t('ai.claude.customPathPlaceholder')}
              className="flex-1 h-8 rounded-md border border-input bg-background px-3 text-sm font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <Button variant="outline" size="sm" onClick={onRecheckPath} disabled={!customPath.trim()}>
              <RefreshCw size={14} className="mr-1.5" />
              {t('ai.claude.check')}
            </Button>
          </div>
        </div>
      ) : null}

      {/* Authentication & config (optional) */}
      <div className="space-y-3 border-t border-border/60 pt-3">
        <div className="text-xs font-medium text-muted-foreground">
          {t('ai.claude.configSection')}
        </div>
        <div className="space-y-1.5">
          <label htmlFor="claude-config-dir" className="text-xs text-muted-foreground">{t('ai.claude.configDir')}</label>
          <input
            id="claude-config-dir"
            type="text"
            value={configDir}
            onChange={(e) => onConfigDirChange(e.target.value)}
            placeholder={t('ai.claude.configDir.placeholder')}
            className="w-full h-8 rounded-md border border-input bg-background px-3 text-sm font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <p className="text-[11px] text-muted-foreground leading-4">{t('ai.claude.configDir.hint')}</p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="claude-env-vars" className="text-xs text-muted-foreground">{t('ai.claude.envVars')}</label>
          <textarea
            id="claude-env-vars"
            value={envText}
            onChange={(e) => onEnvTextChange(e.target.value)}
            placeholder={t('ai.claude.envVars.placeholder')}
            rows={3}
            spellCheck={false}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
          />
          <p className="text-[11px] text-muted-foreground leading-4">{t('ai.claude.envVars.hint')}</p>
        </div>
      </div>
    </div>
  );
};
