import React, { useCallback, useEffect, useState } from "react";
import { Check, Eye, EyeOff } from "lucide-react";
import type { ProviderConfig } from "../../../../infrastructure/ai/types";
import { PROVIDER_PRESETS } from "../../../../infrastructure/ai/types";
import { encryptField, decryptField } from "../../../../infrastructure/persistence/secureFieldAdapter";
import { useI18n } from "../../../../application/i18n/I18nProvider";
import { Button } from "../../../ui/button";
import type { ProviderFormState } from "./types";
import { ModelSelector } from "./ModelSelector";

export const ProviderConfigForm: React.FC<{
  provider: ProviderConfig;
  onSave: (updates: Partial<ProviderConfig>) => void;
  onCancel: () => void;
}> = ({ provider, onSave, onCancel }) => {
  const { t } = useI18n();
  const [form, setForm] = useState<ProviderFormState>({
    name: provider.name ?? PROVIDER_PRESETS[provider.providerId]?.name ?? "",
    apiKey: "",
    baseURL: provider.baseURL ?? PROVIDER_PRESETS[provider.providerId]?.defaultBaseURL ?? "",
    defaultModel: provider.defaultModel ?? "",
    skipTLSVerify: provider.skipTLSVerify ?? false,
  });
  const isCustom = provider.providerId === "custom";
  const [showApiKey, setShowApiKey] = useState(false);
  const [isDecrypting, setIsDecrypting] = useState(false);

  const preset = PROVIDER_PRESETS[provider.providerId];

  // Decrypt and load existing API key on mount
  useEffect(() => {
    if (provider.apiKey) {
      setIsDecrypting(true);
      decryptField(provider.apiKey)
        .then((decrypted) => {
          setForm((prev) => ({ ...prev, apiKey: decrypted ?? "" }));
        })
        .catch(() => {
          // If decryption fails, show raw value
          setForm((prev) => ({ ...prev, apiKey: provider.apiKey ?? "" }));
        })
        .finally(() => setIsDecrypting(false));
    }
  }, [provider.apiKey]);

  const handleSave = useCallback(async () => {
    const updates: Partial<ProviderConfig> = {
      baseURL: form.baseURL || undefined,
      defaultModel: form.defaultModel || undefined,
      skipTLSVerify: form.skipTLSVerify || undefined,
      ...(isCustom && form.name.trim() ? { name: form.name.trim() } : {}),
    };

    // Encrypt API key before saving
    if (form.apiKey) {
      updates.apiKey = await encryptField(form.apiKey);
    } else {
      updates.apiKey = undefined;
    }

    onSave(updates);
  }, [form, onSave, isCustom]);

  return (
    <div className="mt-3 space-y-3 border-t border-border/40 pt-3">
      {/* Name (custom providers only) */}
      {isCustom && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">{t('ai.providers.name')}</label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
            placeholder={t('ai.providers.name.placeholder')}
            className="w-full h-8 rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
      )}
      {/* API Key */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('ai.providers.apiKey')}</label>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <input
              type={showApiKey ? "text" : "password"}
              value={isDecrypting ? "" : form.apiKey}
              onChange={(e) => setForm((prev) => ({ ...prev, apiKey: e.target.value }))}
              placeholder={isDecrypting ? t('ai.providers.apiKey.decrypting') : t('ai.providers.apiKey.placeholder')}
              disabled={isDecrypting}
              className="w-full h-8 rounded-md border border-input bg-background px-3 pr-9 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => setShowApiKey(!showApiKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>
      </div>

      {/* Base URL */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('ai.providers.baseUrl')}</label>
        <input
          type="text"
          value={form.baseURL}
          onChange={(e) => setForm((prev) => ({ ...prev, baseURL: e.target.value }))}
          placeholder={preset?.defaultBaseURL || "https://"}
          className="w-full h-8 rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>

      {/* Default Model */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('ai.providers.defaultModel')}</label>
        <ModelSelector
          value={form.defaultModel}
          onChange={(val) => setForm((prev) => ({ ...prev, defaultModel: val }))}
          baseURL={form.baseURL || preset?.defaultBaseURL || ""}
          modelsEndpoint={preset?.modelsEndpoint}
          apiKey={form.apiKey}
          providerId={provider.providerId}
          skipTLSVerify={form.skipTLSVerify}
        />
      </div>

      {/* Skip TLS Verification */}
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={form.skipTLSVerify}
          onChange={(e) => setForm((prev) => ({ ...prev, skipTLSVerify: e.target.checked }))}
          className="rounded border-input"
        />
        <span className="text-xs text-muted-foreground">{t('ai.providers.skipTLSVerify')}</span>
      </label>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <Button variant="default" size="sm" onClick={() => void handleSave()}>
          <Check size={14} className="mr-1.5" />
          {t('common.save')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
};
