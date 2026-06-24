import React from "react";
import { ExternalLink, LogIn, LogOut, RefreshCw, RotateCcw, X } from "lucide-react";
import { useI18n } from "../../../../application/i18n/I18nProvider";
import { Button } from "../../../ui/button";
import { cn } from "../../../../lib/utils";
import type { AgentPathInfo, CodexIntegrationStatus, CodexLoginSession } from "./types";

export const CodexConnectionCard: React.FC<{
  pathInfo: AgentPathInfo | null;
  isResolvingPath: boolean;
  customPath: string;
  onCustomPathChange: (path: string) => void;
  onRecheckPath: () => void;
  onResetPath: () => void;
  integration: CodexIntegrationStatus | null;
  loginSession: CodexLoginSession | null;
  isLoading: boolean;
  hasPendingCustomPath?: boolean;
  error: string | null;
  onRefresh: () => void;
  onConnect: () => void;
  onCancel: () => void;
  onOpenUrl: () => void;
  onLogout: () => void;
}> = ({
  pathInfo,
  isResolvingPath,
  customPath,
  onCustomPathChange,
  onRecheckPath,
  onResetPath,
  integration,
  loginSession,
  isLoading,
  hasPendingCustomPath = false,
  error,
  onRefresh,
  onConnect,
  onCancel,
  onOpenUrl,
  onLogout,
}) => {
  const { t } = useI18n();
  const found = pathInfo?.available;

  const customConfigIncomplete = Boolean(
    integration?.state === "connected_custom_config"
    && integration.customConfig
    && integration.customConfig.envKey
    && !integration.customConfig.envKeyPresent
    && !integration.customConfig.hasHardcodedApiKey,
  );

  const status = isResolvingPath
    ? t('ai.codex.detecting')
    : !found
      ? t('ai.codex.notFound')
      : loginSession?.state === "running"
        ? t('ai.codex.awaitingLogin')
        : integration?.state === "connected_chatgpt"
          ? t('ai.codex.connectedChatGPT')
          : integration?.state === "connected_api_key"
            ? t('ai.codex.connectedApiKey')
            : integration?.state === "connected_custom_config"
              ? customConfigIncomplete
                ? t('ai.codex.customConfigIncomplete')
                : t('ai.codex.connectedCustomConfig')
              : integration?.state === "not_logged_in"
                ? t('ai.codex.notConnected')
                : t('ai.codex.statusUnknown');

  const statusClassName = isResolvingPath
    ? "text-muted-foreground"
    : !found
      ? "text-amber-500"
      : loginSession?.state === "running"
        ? "text-amber-500"
        : customConfigIncomplete
          ? "text-amber-500"
          : integration?.isConnected
            ? "text-emerald-500"
            : "text-muted-foreground";

  const outputText = loginSession?.error
    ? loginSession.error
    : loginSession?.output?.trim()
      ? loginSession.output.trim()
      : integration?.rawOutput?.trim()
        ? integration.rawOutput.trim()
        : "";

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <p className="min-w-0 text-xs text-muted-foreground leading-5">
          {t('ai.codex.description')}
        </p>
        <div className={cn("text-xs font-medium shrink-0", statusClassName)}>
          {status}
        </div>
      </div>

      {found && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">{t('ai.codex.path')}</span>
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
              {t('ai.codex.notFoundHint')}
            </p>
          )}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={customPath}
              onChange={(e) => onCustomPathChange(e.target.value)}
              placeholder={t('ai.codex.customPathPlaceholder')}
              className="flex-1 h-8 rounded-md border border-input bg-background px-3 text-sm font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <Button variant="outline" size="sm" onClick={onRecheckPath} disabled={!customPath.trim()}>
              <RefreshCw size={14} className="mr-1.5" />
              {t('ai.codex.check')}
            </Button>
            <Button variant="ghost" size="sm" onClick={onResetPath} disabled={!customPath.trim()}>
              <RotateCcw size={14} className="mr-1.5" />
              {t('ai.codex.resetPath')}
            </Button>
          </div>
        </div>
      )}

      {/* Connection & login UI -- only when codex is detected */}
      {found && (
        <>
          <div className="border-t border-border/40 pt-3 flex items-center gap-2 flex-wrap">
            {loginSession?.state === "running" ? (
              <>
                <Button variant="default" size="sm" onClick={onOpenUrl} disabled={!loginSession.url}>
                  <ExternalLink size={14} className="mr-1.5" />
                  {t('ai.codex.openLogin')}
                </Button>
                <Button variant="outline" size="sm" onClick={onCancel}>
                  <X size={14} className="mr-1.5" />
                  {t('common.cancel')}
                </Button>
              </>
            ) : integration?.state === "connected_custom_config" ? (
              // Nothing to log out of; config.toml is user-owned state.
              null
            ) : integration?.isConnected ? (
              <Button variant="outline" size="sm" onClick={onLogout} disabled={hasPendingCustomPath}>
                <LogOut size={14} className="mr-1.5" />
                {t('ai.codex.logout')}
              </Button>
            ) : (
              <Button variant="default" size="sm" onClick={onConnect} disabled={hasPendingCustomPath}>
                <LogIn size={14} className="mr-1.5" />
                {t('ai.codex.connectChatGPT')}
              </Button>
            )}

            <Button variant="outline" size="sm" onClick={onRefresh} disabled={isLoading || hasPendingCustomPath}>
              <RefreshCw size={14} className={cn("mr-1.5", isLoading && "animate-spin")} />
              {t('ai.codex.refreshStatus')}
            </Button>
          </div>

          {integration?.state === "connected_custom_config" && integration.customConfig && (
            <>
              <p className="text-xs text-emerald-500">
                {t('ai.codex.customConfigHint').replace(
                  '{provider}',
                  integration.customConfig.displayName || integration.customConfig.providerName,
                )}
              </p>
              {integration.customConfig.envKey && !integration.customConfig.envKeyPresent && !integration.customConfig.hasHardcodedApiKey && (
                <p className="text-xs text-amber-500">
                  {t('ai.codex.customConfigMissingEnvKey').replace(
                    '{envKey}',
                    integration.customConfig.envKey,
                  )}
                </p>
              )}
            </>
          )}
        </>
      )}

      {error && (
        <p className="text-xs text-destructive">
          {error}
        </p>
      )}

      {found && outputText && (
        <pre className="rounded-md border border-border/60 bg-background px-3 py-2 text-[11px] leading-5 text-muted-foreground whitespace-pre-wrap max-h-40 overflow-auto">
          {outputText}
        </pre>
      )}
    </div>
  );
};
