import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Globe, Eye, EyeOff } from "lucide-react";
import type { WebSearchConfig, WebSearchProviderId } from "../../../../infrastructure/ai/types";
import { WEB_SEARCH_PROVIDER_PRESETS } from "../../../../infrastructure/ai/types";
import { encryptField, decryptField } from "../../../../infrastructure/persistence/secureFieldAdapter";
import { useI18n } from "../../../../application/i18n/I18nProvider";
import { Select, SettingRow } from "../../settings-ui";

const SEARCH_ICON_PATHS: Record<WebSearchProviderId, string> = {
  tavily: "/ai/search/tavily.svg",
  exa: "/ai/search/exa.png",
  bocha: "/ai/search/bocha.webp",
  zhipu: "/ai/search/zhipu.png",
  searxng: "/ai/search/searxng.svg",
};

const SearchProviderIcon: React.FC<{ providerId: WebSearchProviderId }> = ({ providerId }) => (
  <img
    src={SEARCH_ICON_PATHS[providerId]}
    alt=""
    className="w-4 h-4 shrink-0"
  />
);

const PROVIDER_OPTIONS: Array<{ value: WebSearchProviderId; label: string; icon: React.ReactNode }> = Object.entries(
  WEB_SEARCH_PROVIDER_PRESETS,
).map(([id, preset]) => ({
  value: id as WebSearchProviderId,
  label: preset.name,
  icon: <SearchProviderIcon providerId={id as WebSearchProviderId} />,
}));

export const WebSearchSettings: React.FC<{
  webSearchConfig: WebSearchConfig | null;
  setWebSearchConfig: (config: WebSearchConfig | null) => void;
}> = ({ webSearchConfig, setWebSearchConfig }) => {
  const { t } = useI18n();
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [isDecrypting, setIsDecrypting] = useState(false);

  const config = useMemo(() => webSearchConfig ?? {
    providerId: "tavily" as WebSearchProviderId,
    enabled: false,
    maxResults: 5,
  }, [webSearchConfig]);

  // Ref to always read the latest config in async callbacks (avoids stale closure)
  const configRef = useRef(config);
  configRef.current = config;

  const preset = WEB_SEARCH_PROVIDER_PRESETS[config.providerId];

  // Decrypt API key on mount or when provider changes (with cancellation guard)
  const decryptSeqRef = useRef(0);
  useEffect(() => {
    if (config.apiKey) {
      const seq = ++decryptSeqRef.current;
      setIsDecrypting(true);
      decryptField(config.apiKey)
        .then((decrypted) => {
          if (decryptSeqRef.current === seq) setApiKeyInput(decrypted ?? "");
        })
        .catch(() => {
          if (decryptSeqRef.current === seq) setApiKeyInput(config.apiKey ?? "");
        })
        .finally(() => {
          if (decryptSeqRef.current === seq) setIsDecrypting(false);
        });
    } else {
      decryptSeqRef.current++;
      setApiKeyInput("");
      setIsDecrypting(false);
    }
  }, [config.apiKey, config.providerId]);

  const updateConfig = useCallback(
    (updates: Partial<WebSearchConfig>) => {
      setWebSearchConfig({ ...configRef.current, ...updates });
    },
    [setWebSearchConfig],
  );

  const handleProviderChange = useCallback(
    (val: string) => {
      const providerId = val as WebSearchProviderId;
      const newPreset = WEB_SEARCH_PROVIDER_PRESETS[providerId];
      setWebSearchConfig({
        ...configRef.current,
        providerId,
        apiKey: undefined,
        apiHost: newPreset.defaultApiHost || undefined,
      });
      setApiKeyInput("");
    },
    [setWebSearchConfig],
  );

  // Sequence counter for blur saves — prevents out-of-order encryption results
  const blurSeqRef = useRef(0);
  const handleApiKeyBlur = useCallback(async () => {
    if (!apiKeyInput.trim()) {
      blurSeqRef.current++;
      updateConfig({ apiKey: undefined });
      return;
    }
    const seq = ++blurSeqRef.current;
    const providerAtBlur = configRef.current.providerId;
    const encrypted = await encryptField(apiKeyInput.trim());
    // Only apply if this is still the latest blur and provider hasn't changed
    if (blurSeqRef.current === seq && configRef.current.providerId === providerAtBlur) {
      updateConfig({ apiKey: encrypted });
    }
  }, [apiKeyInput, updateConfig]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Globe size={18} className="text-muted-foreground" />
        <h3 className="text-base font-medium">{t("ai.webSearch.title")}</h3>
      </div>

      <div className="bg-muted/30 rounded-lg p-4 space-y-1">
        {/* Enable/Disable */}
        <SettingRow
          label={t("ai.webSearch.enable")}
          description={t("ai.webSearch.enable.description")}
        >
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(e) => updateConfig({ enabled: e.target.checked })}
              className="sr-only peer"
            />
            <div className="w-9 h-5 bg-muted-foreground/20 peer-focus-visible:ring-2 peer-focus-visible:ring-ring rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border after:border-gray-300 after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary" />
          </label>
        </SettingRow>

        {/* Provider */}
        <SettingRow
          label={t("ai.webSearch.provider")}
          description={t("ai.webSearch.provider.description")}
        >
          <Select
            value={config.providerId}
            options={PROVIDER_OPTIONS}
            onChange={handleProviderChange}
            className="w-48"
          />
        </SettingRow>

        {/* API Key (hidden for SearXNG) */}
        {preset.requiresApiKey && (
          <SettingRow
            label={t("ai.webSearch.apiKey")}
            description={t("ai.webSearch.apiKey.description")}
          >
            <div className="flex items-center gap-1.5">
              <input
                type={showApiKey ? "text" : "password"}
                value={isDecrypting ? "" : apiKeyInput}
                placeholder={isDecrypting ? t("ai.providers.apiKey.decrypting") : t("ai.webSearch.apiKey.placeholder")}
                onChange={(e) => setApiKeyInput(e.target.value)}
                onBlur={() => void handleApiKeyBlur()}
                className="w-64 h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                disabled={isDecrypting}
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                className="p-1.5 rounded hover:bg-muted text-muted-foreground"
              >
                {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </SettingRow>
        )}

        {/* API Host */}
        <SettingRow
          label={t("ai.webSearch.apiHost")}
          description={
            config.providerId === "searxng"
              ? t("ai.webSearch.apiHost.searxngDescription")
              : t("ai.webSearch.apiHost.description")
          }
        >
          <input
            type="text"
            value={config.apiHost ?? preset.defaultApiHost}
            onChange={(e) => updateConfig({ apiHost: e.target.value || undefined })}
            placeholder={preset.defaultApiHost || "https://..."}
            className="w-64 h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </SettingRow>

        {/* Max Results */}
        <SettingRow
          label={t("ai.webSearch.maxResults")}
          description={t("ai.webSearch.maxResults.description")}
        >
          <input
            type="number"
            value={config.maxResults ?? 5}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              if (!isNaN(val) && val >= 1 && val <= 20) {
                updateConfig({ maxResults: val });
              }
            }}
            min={1}
            max={20}
            className="w-20 h-9 rounded-md border border-input bg-background px-3 text-sm text-right focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </SettingRow>
      </div>
    </div>
  );
};
