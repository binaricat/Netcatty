import React from "react";
import { Pencil, Trash2 } from "lucide-react";
import type { ProviderConfig } from "../../../../infrastructure/ai/types";
import { useI18n } from "../../../../application/i18n/I18nProvider";
import { Toggle } from "../../settings-ui";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../ui/tooltip";
import { cn } from "../../../../lib/utils";
import { ProviderIconBadge } from "./ProviderIconBadge";
import { ProviderConfigForm } from "./ProviderConfigForm";

export const ProviderCard: React.FC<{
  provider: ProviderConfig;
  isActive: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  onEdit: () => void;
  onRemove: () => void;
  onUpdate: (updates: Partial<ProviderConfig>) => void;
  isEditing: boolean;
  onCancelEdit: () => void;
}> = ({ provider, isActive, onToggleEnabled, onEdit, onRemove, onUpdate, isEditing, onCancelEdit }) => {
  const { t } = useI18n();
  const hasApiKey = !!provider.apiKey;

  return (
    <div
      className={cn(
        "rounded-lg border p-4 transition-colors",
        isActive ? "border-primary/50 bg-primary/5" : "border-border/60 bg-muted/20",
      )}
    >
      <div className="flex items-center gap-3">
        {/* Provider icon */}
        <ProviderIconBadge providerId={provider.providerId} />

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{provider.name}</span>
            {isActive && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/20 text-primary font-medium">
                {t('ai.providers.active')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span
              className={cn(
                "text-xs",
                hasApiKey ? "text-emerald-500" : "text-muted-foreground",
              )}
            >
              {hasApiKey ? t('ai.providers.apiKeyConfigured') : t('ai.providers.noApiKey')}
            </span>
            {provider.defaultModel && (
              <>
                <span className="text-muted-foreground text-xs">|</span>
                <span className="text-xs text-muted-foreground truncate">{provider.defaultModel}</span>
              </>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onEdit}
                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <Pencil size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t('ai.providers.configure')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onRemove}
                className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
              >
                <Trash2 size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t('ai.providers.remove')}</TooltipContent>
          </Tooltip>
          <Toggle checked={provider.enabled} onChange={onToggleEnabled} />
        </div>
      </div>

      {/* Expandable config form */}
      {isEditing && (
        <ProviderConfigForm
          provider={provider}
          onSave={(updates) => {
            onUpdate(updates);
            onCancelEdit();
          }}
          onCancel={onCancelEdit}
        />
      )}
    </div>
  );
};
