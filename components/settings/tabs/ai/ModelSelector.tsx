import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, RefreshCw } from "lucide-react";
import type { AIProviderId } from "../../../../infrastructure/ai/types";
import { useI18n } from "../../../../application/i18n/I18nProvider";
import { Button } from "../../../ui/button";
import { cn } from "../../../../lib/utils";
import type { FetchedModel } from "./types";
import { getFetchBridge } from "./types";

export const ModelSelector: React.FC<{
  value: string;
  onChange: (value: string) => void;
  baseURL: string;
  modelsEndpoint?: string;
  placeholder?: string;
  apiKey?: string;
  providerId?: AIProviderId;
  skipTLSVerify?: boolean;
}> = ({ value, onChange, baseURL, modelsEndpoint, placeholder, apiKey, providerId, skipTLSVerify }) => {
  const { t } = useI18n();
  const [models, setModels] = useState<FetchedModel[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);

  // Ollama runs locally without auth; all other providers need an API key to list models
  const needsApiKey = providerId !== "ollama";
  const canFetch = !!modelsEndpoint && (!needsApiKey || !!apiKey);

  const fetchModels = useCallback(async () => {
    if (!modelsEndpoint) return;
    const bridge = getFetchBridge();
    if (!bridge?.aiFetch) return;

    setIsLoading(true);
    setError(null);
    try {
      // Temporarily allow the provider's host in the backend fetch allowlist
      // so model listing works for URLs not yet synced from the main window.
      if (bridge.aiAllowlistAddHost && baseURL) {
        await bridge.aiAllowlistAddHost(baseURL);
      }
      const url = `${baseURL.replace(/\/+$/, "")}${modelsEndpoint}`;
      const headers: Record<string, string> = {};
      if (apiKey) {
        if (providerId === "anthropic") {
          headers["x-api-key"] = apiKey;
          headers["anthropic-version"] = "2023-06-01";
        } else {
          headers["Authorization"] = `Bearer ${apiKey}`;
        }
      }
      const result = await bridge.aiFetch(url, "GET", headers, undefined, undefined, undefined, undefined, skipTLSVerify);
      if (!result.ok) {
        setError(`Failed to fetch models (${result.error || "unknown error"})`);
        return;
      }
      const parsed = JSON.parse(result.data);
      const list: FetchedModel[] = (parsed.data || parsed.models || []).map((m: { id: string; name?: string }) => ({
        id: m.id,
        name: m.name,
      }));
      list.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
      setModels(list);
      setHasFetched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to parse response");
    } finally {
      setIsLoading(false);
    }
  }, [baseURL, modelsEndpoint, apiKey, providerId, skipTLSVerify]);

  // Auto-fetch when dropdown first opens
  useEffect(() => {
    if (isOpen && canFetch && !hasFetched && !isLoading) {
      void fetchModels();
    }
  }, [isOpen, canFetch, hasFetched, isLoading, fetchModels]);

  // Filter models by current input value (inline autocomplete)
  const suggestions = useMemo(() => {
    if (!hasFetched || models.length === 0) return [];
    if (!value.trim()) return models;
    const q = value.toLowerCase();
    return models.filter((m) =>
      m.id.toLowerCase().includes(q) || (m.name && m.name.toLowerCase().includes(q)),
    );
  }, [models, value, hasFetched]);

  const showSuggestions = isOpen && canFetch;

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <input
            type="text"
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              if (canFetch && hasFetched && !isOpen) setIsOpen(true);
            }}
            onFocus={() => { if (canFetch) setIsOpen(true); }}
            onBlur={() => { setIsOpen(false); }}
            placeholder={placeholder ?? (canFetch ? t('ai.providers.searchModel') : t('ai.providers.defaultModel.placeholder'))}
            className={cn(
              "w-full h-8 rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              canFetch && "pr-8",
            )}
          />
          {canFetch && (
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); setIsOpen(!isOpen); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <ChevronDown size={14} className={cn("transition-transform", isOpen && "rotate-180")} />
            </button>
          )}
        </div>
        {canFetch && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => { setHasFetched(false); void fetchModels(); }}
            disabled={isLoading}
            className="shrink-0 px-2"
            title={t('ai.providers.refreshModels')}
          >
            <RefreshCw size={14} className={isLoading ? "animate-spin" : ""} />
          </Button>
        )}
      </div>

      {/* Suggestions dropdown */}
      {showSuggestions && (
        <div className="absolute top-full left-0 right-0 mt-1 z-[101] rounded-md border border-border bg-popover shadow-md">
          <div className="max-h-60 overflow-y-auto">
            {isLoading ? (
              <div className="px-3 py-3 text-center text-xs text-muted-foreground">
                <RefreshCw size={14} className="animate-spin inline mr-1.5" />
                {t('ai.providers.loadingModels')}
              </div>
            ) : error ? (
              <div className="px-3 py-3 text-center text-xs text-destructive">{error}</div>
            ) : suggestions.length === 0 ? (
              <div className="px-3 py-3 text-center text-xs text-muted-foreground">
                {hasFetched ? t('ai.providers.noMatchingModels') : t('ai.providers.clickToLoadModels')}
              </div>
            ) : (
              suggestions.slice(0, 100).map((m) => (
                <button
                  key={m.id}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onChange(m.id);
                    setIsOpen(false);
                  }}
                  className={cn(
                    "w-full text-left px-3 py-1.5 text-xs hover:bg-accent transition-colors flex items-center justify-between gap-2",
                    m.id === value && "bg-accent",
                  )}
                >
                  <span className="font-mono truncate">{m.id}</span>
                  {m.id === value && <Check size={12} className="text-primary shrink-0" />}
                </button>
              ))
            )}
            {suggestions.length > 100 && (
              <div className="px-3 py-2 text-center text-[10px] text-muted-foreground border-t border-border/40">
                {t('ai.providers.showingModels').replace('{count}', String(suggestions.length))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
