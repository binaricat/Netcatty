import React, { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Eye, EyeOff, Upload, RotateCcw, X } from "lucide-react";
import type { ProviderConfig, ProviderAdvancedParams, ProviderStyle } from "../../../../infrastructure/ai/types";
import { PROVIDER_PRESETS, resolveProviderStyle } from "../../../../infrastructure/ai/types";
import { encryptField, decryptField } from "../../../../infrastructure/persistence/secureFieldAdapter";
import { useI18n } from "../../../../application/i18n/I18nProvider";
import { Button } from "../../../ui/button";
import { cn } from "../../../../lib/utils";
import type { BuiltinProviderIcon } from "./types";
import { BUILTIN_PROVIDER_ICONS } from "./types";
import type { ProviderFormState } from "./types";
import { ModelSelector } from "./ModelSelector";
import { ProviderIconBadge } from "./ProviderIconBadge";

const ICON_PIXEL_SIZE = 64;
const ICON_WEBP_QUALITY = 0.85;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

async function compressIconFileToDataUrl(file: File): Promise<string> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("Image too large; please use an image under 5 MB.");
  }
  const sourceUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Failed to decode image"));
    el.src = sourceUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = ICON_PIXEL_SIZE;
  canvas.height = ICON_PIXEL_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.clearRect(0, 0, ICON_PIXEL_SIZE, ICON_PIXEL_SIZE);
  const scale = Math.min(ICON_PIXEL_SIZE / img.width, ICON_PIXEL_SIZE / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, (ICON_PIXEL_SIZE - w) / 2, (ICON_PIXEL_SIZE - h) / 2, w, h);
  return canvas.toDataURL("image/webp", ICON_WEBP_QUALITY);
}

const STYLE_OPTIONS: ReadonlyArray<ProviderStyle> = ["anthropic", "openai", "google"];

export const ProviderConfigForm: React.FC<{
  provider: ProviderConfig;
  onSave: (updates: Partial<ProviderConfig>) => void;
  onCancel: () => void;
}> = ({ provider, onSave, onCancel }) => {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [form, setForm] = useState<ProviderFormState>({
    name: provider.name ?? PROVIDER_PRESETS[provider.providerId]?.name ?? "",
    apiKey: "",
    baseURL: provider.baseURL ?? PROVIDER_PRESETS[provider.providerId]?.defaultBaseURL ?? "",
    defaultModel: provider.defaultModel ?? "",
    skipTLSVerify: provider.skipTLSVerify ?? false,
    advancedParams: provider.advancedParams ?? {},
    style: provider.style ?? "",
    iconId: provider.iconId ?? "",
    iconDataUrl: provider.iconDataUrl ?? "",
  });
  const [showApiKey, setShowApiKey] = useState(false);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [iconError, setIconError] = useState<string | null>(null);

  const preset = PROVIDER_PRESETS[provider.providerId];
  const resolvedStyle: ProviderStyle = form.style || resolveProviderStyle({ providerId: provider.providerId });
  const previewProvider: Pick<ProviderConfig, "providerId" | "name" | "iconId" | "iconDataUrl"> = {
    providerId: provider.providerId,
    name: form.name,
    iconId: form.iconId || undefined,
    iconDataUrl: form.iconDataUrl || undefined,
  };

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

  const [advancedParamRaw, setAdvancedParamRaw] = useState<Record<string, string>>({});
  const handleAdvancedParam = useCallback((key: keyof ProviderAdvancedParams, raw: string) => {
    setAdvancedParamRaw((prev) => ({ ...prev, [key]: raw }));
    setForm((prev) => {
      const next = { ...prev.advancedParams };
      if (raw.trim() === "" || raw.trim() === "-") {
        delete next[key];
      } else {
        const num = Number(raw);
        if (!Number.isNaN(num)) {
          next[key] = num;
        }
      }
      return { ...prev, advancedParams: next };
    });
  }, []);

  const handleIconFileSelect = useCallback(async (file: File | null) => {
    setIconError(null);
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      setIconError(t("ai.providers.icon.errorType"));
      return;
    }
    try {
      const dataUrl = await compressIconFileToDataUrl(file);
      setForm((prev) => ({ ...prev, iconDataUrl: dataUrl, iconId: "" }));
    } catch (err) {
      setIconError(err instanceof Error ? err.message : String(err));
    }
  }, [t]);

  const handlePickBuiltin = useCallback((icon: BuiltinProviderIcon) => {
    setIconError(null);
    setForm((prev) => ({ ...prev, iconId: icon.id, iconDataUrl: "", name: icon.name }));
  }, []);

  const handleResetIcon = useCallback(() => {
    setIconError(null);
    setForm((prev) => ({ ...prev, iconId: "", iconDataUrl: "" }));
  }, []);

  const handleSave = useCallback(async () => {
    const cleanedParams: ProviderAdvancedParams = {};
    const ap = form.advancedParams;
    if (ap.maxTokens != null && Number.isFinite(ap.maxTokens) && ap.maxTokens > 0) cleanedParams.maxTokens = Math.max(1, Math.round(ap.maxTokens));
    if (ap.temperature != null) cleanedParams.temperature = Math.min(2, Math.max(0, ap.temperature));
    if (ap.topP != null) cleanedParams.topP = Math.min(1, Math.max(0, ap.topP));
    if (ap.frequencyPenalty != null) cleanedParams.frequencyPenalty = Math.min(2, Math.max(-2, ap.frequencyPenalty));
    if (ap.presencePenalty != null) cleanedParams.presencePenalty = Math.min(2, Math.max(-2, ap.presencePenalty));

    const trimmedName = form.name.trim();
    const defaultName = PROVIDER_PRESETS[provider.providerId]?.name ?? "";

    const updates: Partial<ProviderConfig> = {
      name: trimmedName || defaultName,
      baseURL: form.baseURL || undefined,
      defaultModel: form.defaultModel || undefined,
      skipTLSVerify: form.skipTLSVerify || undefined,
      advancedParams: Object.keys(cleanedParams).length > 0 ? cleanedParams : undefined,
      style: form.style || undefined,
      iconId: form.iconId || undefined,
      iconDataUrl: form.iconDataUrl || undefined,
    };

    // Encrypt API key before saving
    if (form.apiKey) {
      updates.apiKey = await encryptField(form.apiKey);
    } else {
      updates.apiKey = undefined;
    }

    onSave(updates);
  }, [form, onSave, provider.providerId]);

  return (
    <div className="mt-3 space-y-3 border-t border-border/40 pt-3">
      {/* Display: icon + name */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('ai.providers.name')}</label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowIconPicker((v) => !v)}
            className="shrink-0"
            aria-label={t('ai.providers.icon.change')}
            title={t('ai.providers.icon.change')}
          >
            <ProviderIconBadge provider={previewProvider} />
          </button>
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
            placeholder={t('ai.providers.name.placeholder')}
            className="flex-1 h-8 rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
        {showIconPicker && (
          <div className="rounded-md border border-border/50 bg-muted/20 p-2 space-y-2">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-1.5">
              {BUILTIN_PROVIDER_ICONS.map((icon) => {
                const isSelected = form.iconId === icon.id && !form.iconDataUrl;
                return (
                  <button
                    key={icon.id}
                    type="button"
                    onClick={() => (isSelected ? handleResetIcon() : handlePickBuiltin(icon))}
                    title={icon.label}
                    aria-label={icon.label}
                    aria-pressed={isSelected}
                    className={cn(
                      "flex items-center gap-2 px-2 py-1.5 rounded-md border text-left transition-colors min-w-0",
                      isSelected
                        ? "border-primary/70 bg-primary/15"
                        : "border-transparent hover:border-border hover:bg-muted/40",
                    )}
                  >
                    <ProviderIconBadge
                      provider={{ providerId: provider.providerId, name: icon.label, iconId: icon.id }}
                      size="md"
                    />
                    <span className="text-xs text-foreground/85 truncate">{icon.label}</span>
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2 pt-2 border-t border-border/40">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => void handleIconFileSelect(e.target.files?.[0] ?? null)}
              />
              <Button variant="ghost" size="sm" onClick={() => fileInputRef.current?.click()}>
                <Upload size={12} className="mr-1.5" />
                {t('ai.providers.icon.upload')}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleResetIcon}>
                <RotateCcw size={12} className="mr-1.5" />
                {t('ai.providers.icon.reset')}
              </Button>
              {form.iconDataUrl && (
                <span className="text-[10px] text-muted-foreground">{t('ai.providers.icon.uploadedNote')}</span>
              )}
              <div className="ml-auto" />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowIconPicker(false)}
                aria-label={t('ai.providers.icon.close')}
                title={t('ai.providers.icon.close')}
              >
                <X size={12} className="mr-1.5" />
                {t('ai.providers.icon.close')}
              </Button>
            </div>
            {iconError && <p className="text-[11px] text-destructive">{iconError}</p>}
          </div>
        )}
      </div>

      {/* Provider style */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('ai.providers.style')}</label>
        <div className="flex items-center gap-1.5">
          {STYLE_OPTIONS.map((style) => {
            const isSelected = resolvedStyle === style;
            const isInherited = !form.style && isSelected;
            return (
              <button
                key={style}
                type="button"
                onClick={() => setForm((prev) => ({ ...prev, style: prev.style === style ? "" : style }))}
                className={cn(
                  "h-7 px-2.5 rounded-md text-xs border transition-colors",
                  isSelected
                    ? "border-primary/70 bg-primary/15 text-foreground"
                    : "border-border/50 bg-background text-muted-foreground hover:text-foreground hover:bg-muted/40",
                )}
                aria-pressed={isSelected}
              >
                {t(`ai.providers.style.${style}`)}
                {isInherited && (
                  <span className="ml-1 text-[9px] text-muted-foreground/70">({t('ai.providers.style.inherited')})</span>
                )}
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-muted-foreground/70">{t('ai.providers.style.help')}</p>
      </div>

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
          style={resolvedStyle}
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

      {/* Advanced Parameters */}
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          {showAdvanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {t('ai.providers.advancedParams')}
        </button>
        {showAdvanced && (
          <div className="space-y-2.5 pl-1 border-l-2 border-border/40 ml-1">
            <p className="text-[11px] text-muted-foreground/70 pl-3">{t('ai.providers.advancedParams.hint')}</p>
            {/* max_tokens */}
            <div className="space-y-1 pl-3">
              <label className="text-xs text-muted-foreground">max_tokens</label>
              <input
                type="number"
                min={1}
                step={1}
                value={advancedParamRaw.maxTokens ?? (form.advancedParams.maxTokens != null ? String(form.advancedParams.maxTokens) : "")}
                onChange={(e) => handleAdvancedParam("maxTokens", e.target.value)}
                placeholder={t('ai.providers.advancedParams.maxTokens.placeholder')}
                className="w-full h-8 rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            {/* temperature */}
            <div className="space-y-1 pl-3">
              <label className="text-xs text-muted-foreground">temperature <span className="text-muted-foreground/50">(0–2)</span></label>
              <input
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={advancedParamRaw.temperature ?? (form.advancedParams.temperature != null ? String(form.advancedParams.temperature) : "")}
                onChange={(e) => handleAdvancedParam("temperature", e.target.value)}
                placeholder={t('ai.providers.advancedParams.default')}
                className="w-full h-8 rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            {/* top_p */}
            <div className="space-y-1 pl-3">
              <label className="text-xs text-muted-foreground">top_p <span className="text-muted-foreground/50">(0–1)</span></label>
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={advancedParamRaw.topP ?? (form.advancedParams.topP != null ? String(form.advancedParams.topP) : "")}
                onChange={(e) => handleAdvancedParam("topP", e.target.value)}
                placeholder={t('ai.providers.advancedParams.default')}
                className="w-full h-8 rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            {/* frequency_penalty */}
            <div className="space-y-1 pl-3">
              <label className="text-xs text-muted-foreground">frequency_penalty <span className="text-muted-foreground/50">(-2–2)</span></label>
              <input
                type="number"
                min={-2}
                max={2}
                step={0.1}
                value={advancedParamRaw.frequencyPenalty ?? (form.advancedParams.frequencyPenalty != null ? String(form.advancedParams.frequencyPenalty) : "")}
                onChange={(e) => handleAdvancedParam("frequencyPenalty", e.target.value)}
                placeholder={t('ai.providers.advancedParams.default')}
                className="w-full h-8 rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            {/* presence_penalty */}
            <div className="space-y-1 pl-3">
              <label className="text-xs text-muted-foreground">presence_penalty <span className="text-muted-foreground/50">(-2–2)</span></label>
              <input
                type="number"
                min={-2}
                max={2}
                step={0.1}
                value={advancedParamRaw.presencePenalty ?? (form.advancedParams.presencePenalty != null ? String(form.advancedParams.presencePenalty) : "")}
                onChange={(e) => handleAdvancedParam("presencePenalty", e.target.value)}
                placeholder={t('ai.providers.advancedParams.default')}
                className="w-full h-8 rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
          </div>
        )}
      </div>

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
