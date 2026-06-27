import React, { useCallback, useState } from "react";
import { Plus, X } from "lucide-react";
import type { AIPermissionMode } from "../../../../infrastructure/ai/types";
import { DEFAULT_COMMAND_BLOCKLIST, MAX_COMMAND_TIMEOUT_SECONDS } from "../../../../infrastructure/ai/types";
import { useI18n } from "../../../../application/i18n/I18nProvider";
import { Button } from "../../../ui/button";
import { Select, SettingCard, SettingRow, SettingsSection } from "../../settings-ui";

export const SafetySettings: React.FC<{
  globalPermissionMode: AIPermissionMode;
  setGlobalPermissionMode: (mode: AIPermissionMode) => void;
  commandBlocklist: string[];
  setCommandBlocklist: (value: string[]) => void;
  commandTimeout: number;
  setCommandTimeout: (value: number) => void;
  maxIterations: number;
  setMaxIterations: (value: number) => void;
}> = ({
  globalPermissionMode,
  setGlobalPermissionMode,
  commandBlocklist,
  setCommandBlocklist,
  commandTimeout,
  setCommandTimeout,
  maxIterations,
  setMaxIterations,
}) => {
  const { t } = useI18n();
  const [regexErrors, setRegexErrors] = useState<Record<number, string>>({});

  const validatePattern = useCallback((pattern: string, idx: number): boolean => {
    if (!pattern) {
      setRegexErrors((prev) => {
        const next = { ...prev };
        delete next[idx];
        return next;
      });
      return true;
    }
    try {
      new RegExp(pattern);
      setRegexErrors((prev) => {
        const next = { ...prev };
        delete next[idx];
        return next;
      });
      return true;
    } catch (e) {
      setRegexErrors((prev) => ({
        ...prev,
        [idx]: e instanceof Error ? e.message : String(e),
      }));
      return false;
    }
  }, []);

  const handlePatternChange = useCallback((value: string, idx: number) => {
    const next = [...commandBlocklist];
    next[idx] = value;
    validatePattern(value, idx);
    setCommandBlocklist(next);
  }, [commandBlocklist, setCommandBlocklist, validatePattern]);

  const permissionModeOptions = [
    { value: "observer", label: t('ai.safety.permissionMode.observer') },
    { value: "confirm", label: t('ai.safety.permissionMode.confirm') },
    { value: "auto", label: t('ai.safety.permissionMode.auto') },
  ];

  return (
    <SettingsSection title={t('ai.safety.title')}>
      <div className="flex flex-col gap-4">
        <SettingCard divided>
        <SettingRow
          label={t('ai.safety.permissionMode')}
          description={t('ai.safety.permissionMode.description')}
        >
          <Select
            value={globalPermissionMode}
            options={permissionModeOptions}
            onChange={(val) => setGlobalPermissionMode(val as AIPermissionMode)}
            className="w-64"
          />
        </SettingRow>

        <SettingRow
          label={t('ai.safety.commandTimeout')}
          description={t('ai.safety.commandTimeout.description')}
        >
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={commandTimeout}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val)) setCommandTimeout(val);
              }}
              min={1}
              max={MAX_COMMAND_TIMEOUT_SECONDS}
              className="w-20 h-9 rounded-md border border-input bg-background px-3 text-sm text-right focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <span className="text-xs text-muted-foreground">{t('ai.safety.commandTimeout.unit')}</span>
          </div>
        </SettingRow>

        <SettingRow
          label={t('ai.safety.maxIterations')}
          description={t('ai.safety.maxIterations.description')}
        >
          <input
            type="number"
            value={maxIterations}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              if (!isNaN(val) && val > 0) setMaxIterations(val);
            }}
            min={1}
            max={100}
            className="w-20 h-9 rounded-md border border-input bg-background px-3 text-sm text-right focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </SettingRow>
        </SettingCard>

      {/* Command Blocklist */}
      <SettingCard padded className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">{t('ai.safety.blocklist')}</p>
            <p className="text-xs text-muted-foreground">
              {t('ai.safety.blocklist.description')}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            onClick={() => { setCommandBlocklist([...DEFAULT_COMMAND_BLOCKLIST]); setRegexErrors({}); }}
          >
            {t('ai.safety.blocklist.reset')}
          </Button>
        </div>

        <div className="space-y-1.5">
          {commandBlocklist.map((pattern, idx) => (
            <div key={idx} className="space-y-0.5">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={pattern}
                  onChange={(e) => handlePatternChange(e.target.value, idx)}
                  className={`flex-1 h-8 rounded-md border bg-background px-3 text-xs font-mono focus-visible:outline-none focus-visible:ring-1 ${
                    regexErrors[idx]
                      ? 'border-destructive focus-visible:ring-destructive'
                      : 'border-input focus-visible:ring-ring'
                  }`}
                  placeholder={t('ai.safety.blocklist.placeholder')}
                />
                <button
                  onClick={() => {
                    const next = commandBlocklist.filter((_, i) => i !== idx);
                    setCommandBlocklist(next);
                    setRegexErrors((prev) => {
                      const updated: Record<number, string> = {};
                      for (const [k, v] of Object.entries(prev)) {
                        const ki = Number(k);
                        if (ki < idx) updated[ki] = v as string;
                        else if (ki > idx) updated[ki - 1] = v as string;
                      }
                      return updated;
                    });
                  }}
                  className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                >
                  <X size={14} />
                </button>
              </div>
              {regexErrors[idx] && (
                <p className="text-[11px] text-destructive pl-1">{regexErrors[idx]}</p>
              )}
            </div>
          ))}
        </div>

        <Button
          variant="outline"
          size="sm"
          className="text-xs"
          onClick={() => setCommandBlocklist([...commandBlocklist, ''])}
        >
          <Plus size={14} className="mr-1" />
          {t('ai.safety.blocklist.add')}
        </Button>
      </SettingCard>

        <p className="text-xs text-muted-foreground">
          {t('ai.safety.note')}
        </p>
      </div>
    </SettingsSection>
  );
};
