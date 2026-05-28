import React, { useEffect, useState } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import { useI18n } from "../../../../application/i18n/I18nProvider";
import { Button } from "../../../ui/button";
import { cn } from "../../../../lib/utils";
import type { AgentPathInfo } from "./types";
import { ProviderIconBadge } from "./ProviderIconBadge";
import { parseEnvLines, serializeEnvLines } from "./codebuddyConfigEnv";

const INTERNET_ENV_OPTIONS = [
  { value: "", labelKey: "ai.codebuddy.internetEnv.default" },
  { value: "internal", labelKey: "ai.codebuddy.internetEnv.internal" },
  { value: "ioa", labelKey: "ai.codebuddy.internetEnv.ioa" },
] as const;

export const CodebuddyCard: React.FC<{
  pathInfo: AgentPathInfo | null;
  isResolvingPath: boolean;
  customPath: string;
  onCustomPathChange: (path: string) => void;
  onRecheckPath: () => void;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  internetEnv: string;
  onInternetEnvChange: (value: string) => void;
  envText: string;
  onEnvTextChange: (value: string) => void;
}> = ({
  pathInfo,
  isResolvingPath,
  customPath,
  onCustomPathChange,
  onRecheckPath,
  apiKey,
  onApiKeyChange,
  internetEnv,
  onInternetEnvChange,
  envText,
  onEnvTextChange,
}) => {
  const { t } = useI18n();
  const found = pathInfo?.available;
  // Collapsed by default; auto-expand when the user already has config so it
  // isn't hidden. Local UI state — not persisted.
  const [configOpen, setConfigOpen] = useState(
    () => Boolean(apiKey.trim() || internetEnv.trim() || envText.trim()),
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
    ? t('ai.codebuddy.detecting')
    : found
      ? t('ai.codebuddy.detected')
      : t('ai.codebuddy.notFound');

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
            <ProviderIconBadge providerId="codebuddy" size="sm" />
            <span className="text-sm font-medium">{t('ai.codebuddy.title')}</span>
          </div>
          <p className="text-xs text-muted-foreground mt-2 leading-5">
            {t('ai.codebuddy.description')}
          </p>
        </div>
        <div className={cn("text-xs font-medium shrink-0", statusClassName)}>
          {statusText}
        </div>
      </div>

      {/* Path detection info */}
      {found ? (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">{t('ai.codebuddy.path')}</span>
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
            {t('ai.codebuddy.notFoundHint')}
          </p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={customPath}
              onChange={(e) => onCustomPathChange(e.target.value)}
              placeholder={t('ai.codebuddy.customPathPlaceholder')}
              className="flex-1 h-8 rounded-md border border-input bg-background px-3 text-sm font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <Button variant="outline" size="sm" onClick={onRecheckPath} disabled={!customPath.trim()}>
              <RefreshCw size={14} className="mr-1.5" />
              {t('ai.codebuddy.check')}
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
            {t('ai.codebuddy.configSection')}
          </span>
          <ChevronDown
            size={14}
            className={cn("text-muted-foreground transition-transform", configOpen && "rotate-180")}
          />
        </button>
        {configOpen && (
          <div className="space-y-3 mt-3">
            <div className="space-y-1.5">
              <label htmlFor="codebuddy-api-key" className="text-xs text-muted-foreground">{t('ai.codebuddy.apiKey')}</label>
              <input
                id="codebuddy-api-key"
                type="password"
                value={apiKey}
                onChange={(e) => onApiKeyChange(e.target.value)}
                placeholder={t('ai.codebuddy.apiKey.placeholder')}
                className="w-full h-8 rounded-md border border-input bg-background px-3 text-sm font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <p className="text-[11px] text-muted-foreground leading-4">{t('ai.codebuddy.apiKey.hint')}</p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="codebuddy-internet-env" className="text-xs text-muted-foreground">{t('ai.codebuddy.internetEnv')}</label>
              <select
                id="codebuddy-internet-env"
                value={internetEnv}
                onChange={(e) => onInternetEnvChange(e.target.value)}
                className="w-full h-8 rounded-md border border-input bg-background px-3 text-sm font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {INTERNET_ENV_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{t(opt.labelKey)}</option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground leading-4">{t('ai.codebuddy.internetEnv.hint')}</p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="codebuddy-env-vars" className="text-xs text-muted-foreground">{t('ai.codebuddy.envVars')}</label>
              <textarea
                id="codebuddy-env-vars"
                value={envDraft}
                onChange={(e) => { setEnvDraft(e.target.value); onEnvTextChange(e.target.value); }}
                placeholder={t('ai.codebuddy.envVars.placeholder')}
                rows={3}
                spellCheck={false}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
              />
              <p className="text-[11px] text-muted-foreground leading-4">{t('ai.codebuddy.envVars.hint')}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
