import React, { useEffect, useState } from "react";
import { Check, Eye, EyeOff, RefreshCw, RotateCcw } from "lucide-react";
import { useI18n } from "../../../../application/i18n/I18nProvider";
import { decryptField } from "../../../../infrastructure/persistence/secureFieldAdapter";
import { Button } from "../../../ui/button";
import { cn } from "../../../../lib/utils";
import type { AgentPathInfo } from "./types";

export const AntigravitySdkCard: React.FC<{
  pathInfo: AgentPathInfo | null;
  isResolvingPath: boolean;
  customPath: string;
  encryptedApiKey?: string;
  onCustomPathChange: (path: string) => void;
  onRecheckPath: () => void;
  onResetPath: () => void;
  onSaveApiKey: (apiKey: string) => Promise<void>;
}> = ({
  pathInfo,
  isResolvingPath,
  customPath,
  encryptedApiKey,
  onCustomPathChange,
  onRecheckPath,
  onResetPath,
  onSaveApiKey,
}) => {
  const { t } = useI18n();
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [decrypting, setDecrypting] = useState(Boolean(encryptedApiKey));

  useEffect(() => {
    let cancelled = false;
    setSaved(false);
    if (!encryptedApiKey) {
      setApiKey("");
      setDecrypting(false);
      return;
    }
    setDecrypting(true);
    void decryptField(encryptedApiKey)
      .then((value) => { if (!cancelled) setApiKey(value ?? ""); })
      .catch(() => { if (!cancelled) setApiKey(""); })
      .finally(() => { if (!cancelled) setDecrypting(false); });
    return () => { cancelled = true; };
  }, [encryptedApiKey]);

  const installed = Boolean(pathInfo?.sdkReady ?? pathInfo?.available);
  const authenticated = Boolean(encryptedApiKey || pathInfo?.authenticated);
  const status = isResolvingPath
    ? t("ai.antigravity.detecting")
    : installed
      ? t("ai.antigravity.detected")
      : t("ai.antigravity.notFound");

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await onSaveApiKey(apiKey.trim());
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <p className="min-w-0 text-xs text-muted-foreground leading-5">
          {t("ai.antigravity.description")}
        </p>
        <span className={cn(
          "text-xs font-medium shrink-0",
          isResolvingPath ? "text-muted-foreground" : installed ? "text-emerald-500" : "text-amber-500",
        )}>
          {status}
        </span>
      </div>

      {pathInfo?.path ? (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">{t("ai.antigravity.path")}</span>
          <span className="font-mono text-foreground truncate">{pathInfo.path}</span>
          {pathInfo.version ? <span className="text-muted-foreground">{pathInfo.version}</span> : null}
        </div>
      ) : null}

      {!installed && !isResolvingPath ? (
        <p className="text-xs text-amber-500">{t("ai.antigravity.notFoundHint")}</p>
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

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t("ai.antigravity.apiKey")}</label>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <input
              type={showApiKey ? "text" : "password"}
              value={decrypting ? "" : apiKey}
              onChange={(event) => {
                setSaved(false);
                setApiKey(event.target.value);
              }}
              placeholder={authenticated && !encryptedApiKey
                ? t("ai.antigravity.apiKeyPlaceholder.env")
                : t("ai.antigravity.apiKeyPlaceholder")}
              className="w-full h-8 rounded-md border border-input bg-background px-3 pr-9 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <button
              type="button"
              onClick={() => setShowApiKey((value) => !value)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={showApiKey ? t("ai.antigravity.hideApiKey") : t("ai.antigravity.showApiKey")}
            >
              {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <Button variant="outline" size="sm" onClick={() => void save()} disabled={saving || decrypting || (!apiKey.trim() && !encryptedApiKey)}>
            {saved ? <Check size={14} className="mr-1.5" /> : null}
            {saved ? t("ai.antigravity.saved") : t("ai.antigravity.saveApiKey")}
          </Button>
        </div>
      </div>
    </div>
  );
};
