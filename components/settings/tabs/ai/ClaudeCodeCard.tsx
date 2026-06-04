import React, { useEffect, useState } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import { useI18n } from "../../../../application/i18n/I18nProvider";
import { Button } from "../../../ui/button";
import { cn } from "../../../../lib/utils";
import type { AgentPathInfo } from "./types";
import { ProviderIconBadge } from "./ProviderIconBadge";
import { parseEnvLines, serializeEnvLines } from "./claudeConfigEnv";

export const ClaudeCodeCard: React.FC<{
  pathInfo: AgentPathInfo | null;
  isResolvingPath: boolean;
  customPath: string;
  onCustomPathChange: (path: string) => void;
  onRecheckPath: () => void;
  configDir: string;
  onConfigDirChange: (value: string) => void;
  settingsPath: string;
  onSettingsPathChange: (value: string) => void;
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
  settingsPath,
  onSettingsPathChange,
  envText,
  onEnvTextChange,
}) => {
  const { t } = useI18n();
  const found = pathInfo?.available;
  // Collapsed by default; auto-expand when the user already has config so it
  // isn't hidden. Local UI state — not persisted.
  const [configOpen, setConfigOpen] = useState(
    () => Boolean(configDir.trim() || settingsPath.trim() || envText.trim()),
  );

  // The env editor keeps the raw text the user types. Persisting parses it into
  // a record (dropping incomplete lines), so binding the textarea directly to
  // the persisted value would erase a key the moment it's typed before its "=".
  // Only resync from the persisted value when it changes for some reason other
  // than our own parse→serialize round-trip.
  const [envDraft, setEnvDraft] = useState(envText);
  useEffect(() => {
    setEnvDraft((prev) =>
      serializeEnvLines(parseEnvLines(prev)) === envText ? prev : envText,
    );
  }, [envText]);

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

      {/* Authentication & config (optional, collapsible) */}
      <div className="border-t border-border/60 pt-3">
        <button
          type="button"
          onClick={() => setConfigOpen((v) => !v)}
          aria-expanded={configOpen}
          className="flex w-full items-center justify-between gap-2 text-left"
        >
          <span className="text-xs font-medium text-muted-foreground">
            {t('ai.claude.configSection')}
          </span>
          <ChevronDown
            size={14}
            className={cn("text-muted-foreground transition-transform", configOpen && "rotate-180")}
          />
        </button>
        {configOpen && (
          <div className="space-y-3 mt-3">
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
              <label htmlFor="claude-settings" className="text-xs text-muted-foreground">{t('ai.claude.settings')}</label>
              <input
                id="claude-settings"
                type="text"
                value={settingsPath}
                onChange={(e) => onSettingsPathChange(e.target.value)}
                placeholder={t('ai.claude.settings.placeholder')}
                className="w-full h-8 rounded-md border border-input bg-background px-3 text-sm font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <p className="text-[11px] text-muted-foreground leading-4">{t('ai.claude.settings.hint')}</p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="claude-env-vars" className="text-xs text-muted-foreground">{t('ai.claude.envVars')}</label>
              <textarea
                id="claude-env-vars"
                value={envDraft}
                onChange={(e) => { setEnvDraft(e.target.value); onEnvTextChange(e.target.value); }}
                placeholder={t('ai.claude.envVars.placeholder')}
                rows={3}
                spellCheck={false}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
              />
              <p className="text-[11px] text-muted-foreground leading-4">{t('ai.claude.envVars.hint')}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
