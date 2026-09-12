import React, { useEffect, useState } from "react";
import { Check, Eye, EyeOff, RefreshCw } from "lucide-react";
import { useI18n } from "../../../../application/i18n/I18nProvider";
import { decryptField } from "../../../../infrastructure/persistence/secureFieldAdapter";
import type { CursorAuthMode } from "../../../../infrastructure/ai/types";
import { Button } from "../../../ui/button";
import { cn } from "../../../../lib/utils";
import { isCursorRuntimeInstalled, type AgentPathInfo } from "./types";

export const CursorSdkCard: React.FC<{
  pathInfo: AgentPathInfo | null;
  isResolvingPath: boolean;
  encryptedApiKey?: string;
  authMode: CursorAuthMode;
  onAuthModeChange: (mode: CursorAuthMode) => void;
  onSaveApiKey: (apiKey: string) => Promise<void>;
  onRecheckPath: () => void;
}> = ({
  pathInfo,
  isResolvingPath,
  encryptedApiKey,
  authMode,
  onAuthModeChange,
  onSaveApiKey,
  onRecheckPath,
}) => {
  const { t } = useI18n();
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSaved(false);
    if (!encryptedApiKey) {
      setApiKeyDraft("");
      return;
    }
    setIsDecrypting(true);
    decryptField(encryptedApiKey)
      .then((value) => {
        if (!cancelled) setApiKeyDraft(value ?? "");
      })
      .catch(() => {
        if (!cancelled) setApiKeyDraft("");
      })
      .finally(() => {
        if (!cancelled) setIsDecrypting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [encryptedApiKey]);

  const installed = isCursorRuntimeInstalled(pathInfo);
  const hasStoredApiKey = Boolean(encryptedApiKey);
  const usesEnvApiKey = pathInfo?.authSource === "CURSOR_API_KEY" || (
    pathInfo?.apiKeyOk && !hasStoredApiKey && pathInfo?.authSource !== "settings"
  );
  // CLI login is only proven by the dedicated probe — never generic `authenticated`
  // (which is also true for env/settings API keys).
  const hasCliLogin = Boolean(
    pathInfo?.cliLoginOk || pathInfo?.authSource === "cli-login",
  );
  const hasAnyApiKey = hasStoredApiKey || Boolean(pathInfo?.apiKeyOk) || usesEnvApiKey
    || pathInfo?.authSource === "settings"
    || pathInfo?.authSource === "CURSOR_API_KEY";
  const isApiKeyMode = authMode === "api-key";
  const isCliMode = authMode === "cli-login";
  const available = isCliMode
    ? hasCliLogin
    : (hasAnyApiKey && Boolean(pathInfo?.sdkInstalled ?? true));
  const canSave = isApiKeyMode && !isSaving && !isDecrypting && (Boolean(apiKeyDraft.trim()) || hasStoredApiKey);

  const installStatus = isResolvingPath
    ? t("ai.cursor.detecting")
    : installed
      ? t("ai.cursor.installed")
      : t("ai.cursor.notInstalled");

  const authStatus = isCliMode
    ? hasCliLogin
      ? (pathInfo?.cliEmail
        ? t("ai.cursor.cliLoginAs", { email: pathInfo.cliEmail })
        : t("ai.cursor.cliLoginOk"))
      : t("ai.cursor.cliLoginMissing")
    : hasAnyApiKey
      ? usesEnvApiKey && !hasStoredApiKey
        ? t("ai.cursor.apiKeyFromEnv")
        : t("ai.cursor.apiKeyConfigured")
      : t("ai.cursor.apiKeyMissing");

  const installStatusClassName = isResolvingPath
    ? "text-muted-foreground"
    : installed
      ? "text-emerald-500"
      : "text-amber-500";
  const authStatusClassName = isCliMode
    ? (hasCliLogin ? "text-emerald-500" : "text-amber-500")
    : (hasAnyApiKey ? "text-emerald-500" : "text-amber-500");

  const handleSave = async () => {
    if (!isApiKeyMode) return;
    setIsSaving(true);
    setSaved(false);
    try {
      await onSaveApiKey(apiKeyDraft.trim());
      setSaved(true);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex gap-1 rounded-md border border-border/60 p-0.5 bg-muted/30">
        <button
          type="button"
          onClick={() => onAuthModeChange("cli-login")}
          className={cn(
            "flex-1 h-7 rounded text-xs font-medium transition-colors",
            isCliMode ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t("ai.cursor.modeCli")}
        </button>
        <button
          type="button"
          onClick={() => onAuthModeChange("api-key")}
          className={cn(
            "flex-1 h-7 rounded text-xs font-medium transition-colors",
            isApiKeyMode ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t("ai.cursor.modeApiKey")}
        </button>
      </div>

      <p className="text-[11px] text-muted-foreground leading-4">
        {isCliMode ? t("ai.cursor.modeCliHint") : t("ai.cursor.modeApiKeyHint")}
      </p>

      <div className="grid gap-2 text-xs">
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">{t("ai.cursor.installStatus")}</span>
          <span className={cn("font-medium", installStatusClassName)}>{installStatus}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">
            {isCliMode ? t("ai.cursor.cliLoginStatus") : t("ai.cursor.apiKeyStatus")}
          </span>
          <span className={cn("font-medium truncate max-w-[60%] text-right", authStatusClassName)}>
            {authStatus}
          </span>
        </div>
      </div>

      {!available && (
        <p className="text-xs text-amber-500">
          {isCliMode
            ? t("ai.cursor.cliLoginHint")
            : (Boolean(pathInfo?.sdkInstalled) || installed)
              ? t("ai.cursor.notFoundHint")
              : t("ai.cursor.notInstalledHint")}
        </p>
      )}

      {isApiKeyMode ? (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">{t("ai.cursor.apiKey")}</label>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <input
                type={showApiKey ? "text" : "password"}
                value={isDecrypting ? "" : apiKeyDraft}
                onChange={(event) => {
                  setSaved(false);
                  setApiKeyDraft(event.target.value);
                }}
                placeholder={
                  isDecrypting
                    ? t("ai.providers.apiKey.decrypting")
                    : usesEnvApiKey && !hasStoredApiKey
                      ? t("ai.cursor.apiKeyPlaceholder.env")
                      : t("ai.cursor.apiKeyPlaceholder")
                }
                disabled={isDecrypting}
                className="w-full h-8 rounded-md border border-input bg-background px-3 pr-9 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => setShowApiKey((value) => !value)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showApiKey ? t("ai.cursor.hideApiKey") : t("ai.cursor.showApiKey")}
              >
                {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <Button variant="outline" size="sm" onClick={handleSave} disabled={!canSave}>
              {saved ? <Check size={14} className="mr-1.5" /> : null}
              {saved ? t("ai.cursor.saved") : t("ai.cursor.saveApiKey")}
            </Button>
            <Button variant="outline" size="sm" onClick={onRecheckPath} disabled={isResolvingPath}>
              <RefreshCw size={14} className="mr-1.5" />
              {t("ai.cursor.check")}
            </Button>
          </div>
          {usesEnvApiKey && !hasStoredApiKey ? (
            <p className="text-[11px] text-muted-foreground leading-4">
              {t("ai.cursor.apiKeyEnvHint")}
            </p>
          ) : null}
          {usesEnvApiKey && hasStoredApiKey ? (
            <p className="text-[11px] text-muted-foreground leading-4">
              {t("ai.cursor.apiKeyOverrideHint")}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={onRecheckPath} disabled={isResolvingPath}>
            <RefreshCw size={14} className="mr-1.5" />
            {t("ai.cursor.check")}
          </Button>
        </div>
      )}
    </div>
  );
};
