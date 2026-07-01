import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Download, Plus, Trash2, Upload } from 'lucide-react';
import { useI18n } from '../../../../application/i18n/I18nProvider';
import { Button } from '../../../ui/button';
import { SettingCard, SettingsSection } from '../../settings-ui';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../ui/tooltip';
import type { PermissionGrantRule } from '../../../../infrastructure/ai/harness/permissionGrants';
import {
  capabilitySupportsCommandPatternGrant,
  createPermissionGrantId,
  listGrantableCapabilityIds,
} from '../../../../infrastructure/ai/harness/permissionGrants';

const cellInputClass =
  'w-full min-w-0 max-w-full h-7 rounded border border-input bg-background px-2 text-xs font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring overflow-x-auto whitespace-nowrap scrollbar-thin';

const cellSelectClass =
  `${cellInputClass} font-sans truncate pr-6`;

const GrantCellInput: React.FC<{
  value: string;
  placeholder?: string;
  mono?: boolean;
  onChange: (value: string) => void;
}> = ({ value, placeholder, mono = true, onChange }) => (
  <input
    type="text"
    value={value}
    placeholder={placeholder}
    onChange={(e) => onChange(e.target.value)}
    className={mono ? cellInputClass : `${cellInputClass} font-sans whitespace-normal`}
    title={value}
  />
);

const GrantCapabilitySelect: React.FC<{
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}> = ({ value, options, onChange }) => {
  const selectOptions = useMemo(() => {
    if (options.includes(value)) return options;
    return [value, ...options];
  }, [options, value]);

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cellSelectClass}
      title={value}
    >
      {selectOptions.map((capabilityId) => (
        <option key={capabilityId} value={capabilityId}>
          {capabilityId}
        </option>
      ))}
    </select>
  );
};

export const PermissionGrantsSettings: React.FC<{
  grants: PermissionGrantRule[];
  addGrant: (rule: PermissionGrantRule) => void;
  updateGrant: (id: string, updates: Partial<Omit<PermissionGrantRule, 'id' | 'createdAt'>>) => void;
  removeGrant: (id: string) => void;
  importGrants: (raw: unknown, mode?: 'merge' | 'replace') => void;
  exportGrants: () => PermissionGrantRule[];
}> = ({
  grants,
  addGrant,
  updateGrant,
  removeGrant,
  importGrants,
  exportGrants,
}) => {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const grantableCapabilityIds = useMemo(() => listGrantableCapabilityIds(), []);

  const handleAdd = useCallback(() => {
    addGrant({
      id: createPermissionGrantId(),
      capabilityId: grantableCapabilityIds[0] ?? 'terminal.execute',
      sessionPattern: '*',
      createdAt: Date.now(),
    });
  }, [addGrant, grantableCapabilityIds]);

  const handleExport = useCallback(() => {
    const payload = exportGrants();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'netcatty-permission-grants.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }, [exportGrants]);

  const handleImportFile = useCallback(async (file: File) => {
    setImportError(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      importGrants(parsed, 'replace');
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    }
  }, [importGrants]);

  return (
    <SettingsSection title={t('ai.safety.grants.title')}>
      <SettingCard padded className="space-y-3 min-w-0 max-w-full overflow-hidden">
        <div className="space-y-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">{t('ai.safety.grants.heading')}</p>
            <p className="text-xs text-muted-foreground mt-1">{t('ai.safety.grants.description')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleAdd}>
              <Plus size={14} className="mr-1" />
              {t('ai.safety.grants.add')}
            </Button>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleExport}>
              <Download size={14} className="mr-1" />
              {t('ai.safety.grants.export')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={14} className="mr-1" />
              {t('ai.safety.grants.import')}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void handleImportFile(file);
              }}
            />
          </div>
        </div>

        {importError && (
          <p className="text-[11px] text-destructive">{importError}</p>
        )}

        {grants.length === 0 ? (
          <p className="text-xs text-muted-foreground py-6 text-center border border-dashed border-border/50 rounded-lg">
            {t('ai.safety.grants.empty')}
          </p>
        ) : (
          <div className="w-full max-w-full min-w-0 overflow-x-auto overscroll-x-contain rounded-lg border border-border/40 bg-card">
            <table className="w-full max-w-full table-fixed text-sm border-collapse">
              <colgroup>
                <col className="w-[28%]" />
                <col className="w-[42%]" />
                <col className="w-[24%]" />
                <col className="w-[6%]" />
              </colgroup>
              <thead>
                <tr className="bg-muted/50 border-b border-border">
                  <th className="text-left px-2 py-2 text-xs font-medium text-muted-foreground truncate">
                    {t('ai.safety.grants.capability')}
                  </th>
                  <th className="text-left px-2 py-2 text-xs font-medium text-muted-foreground truncate">
                    {t('ai.safety.grants.commandPattern')}
                  </th>
                  <th className="text-left px-2 py-2 text-xs font-medium text-muted-foreground truncate">
                    {t('ai.safety.grants.note')}
                  </th>
                  <th className="px-1 py-2" aria-hidden />
                </tr>
              </thead>
              <tbody>
                {grants.map((grant) => {
                  const supportsCommandPattern = capabilitySupportsCommandPatternGrant(grant.capabilityId);

                  return (
                    <tr
                      key={grant.id}
                      className="border-b border-border/60 last:border-b-0 hover:bg-muted/20"
                    >
                      <td className="px-2 py-2 align-middle max-w-0">
                        <GrantCapabilitySelect
                          value={grant.capabilityId}
                          options={grantableCapabilityIds}
                          onChange={(capabilityId) => {
                            const updates: Partial<Omit<PermissionGrantRule, 'id' | 'createdAt'>> = {
                              capabilityId,
                            };
                            if (!capabilitySupportsCommandPatternGrant(capabilityId)) {
                              updates.commandPattern = undefined;
                            }
                            updateGrant(grant.id, updates);
                          }}
                        />
                      </td>
                      <td className="px-2 py-2 align-middle max-w-0">
                        {supportsCommandPattern ? (
                          <GrantCellInput
                            value={grant.commandPattern ?? ''}
                            placeholder="lscpu *"
                            onChange={(commandPattern) => updateGrant(grant.id, {
                              commandPattern: commandPattern.trim() || undefined,
                            })}
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground px-1">—</span>
                        )}
                      </td>
                      <td className="px-2 py-2 align-middle max-w-0">
                        <GrantCellInput
                          value={grant.note ?? ''}
                          mono={false}
                          onChange={(note) => updateGrant(grant.id, {
                            note: note.trim() || undefined,
                          })}
                        />
                      </td>
                      <td className="px-1 py-2 align-middle text-center">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                              onClick={() => removeGrant(grant.id)}
                            >
                              <Trash2 size={14} />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{t('ai.safety.grants.remove')}</TooltipContent>
                        </Tooltip>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SettingCard>
    </SettingsSection>
  );
};
