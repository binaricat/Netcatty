import React, { useCallback, useRef, useState } from 'react';
import { Download, Plus, Upload, X } from 'lucide-react';
import { useI18n } from '../../../../application/i18n/I18nProvider';
import { Button } from '../../../ui/button';
import { SettingCard, SettingsSection } from '../../settings-ui';
import type { PermissionGrantRule } from '../../../../infrastructure/ai/harness/permissionGrants';
import { createPermissionGrantId } from '../../../../infrastructure/ai/harness/permissionGrants';

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

  const handleAdd = useCallback(() => {
    addGrant({
      id: createPermissionGrantId(),
      capabilityId: 'terminal.execute',
      sessionPattern: '*',
      createdAt: Date.now(),
    });
  }, [addGrant]);

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
      <SettingCard padded className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium">{t('ai.safety.grants.heading')}</p>
            <p className="text-xs text-muted-foreground">{t('ai.safety.grants.description')}</p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button variant="outline" size="sm" className="text-xs" onClick={handleExport}>
              <Download size={14} className="mr-1" />
              {t('ai.safety.grants.export')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
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

        <div className="space-y-2">
          {grants.length === 0 && (
            <p className="text-xs text-muted-foreground">{t('ai.safety.grants.empty')}</p>
          )}
          {grants.map((grant) => (
            <div key={grant.id} className="rounded-md border border-border/40 p-3 space-y-2">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <label className="space-y-1">
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
                    {t('ai.safety.grants.capability')}
                  </span>
                  <input
                    type="text"
                    value={grant.capabilityId}
                    onChange={(e) => updateGrant(grant.id, { capabilityId: e.target.value })}
                    className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs font-mono"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
                    {t('ai.safety.grants.sessionPattern')}
                  </span>
                  <input
                    type="text"
                    value={grant.sessionPattern}
                    onChange={(e) => updateGrant(grant.id, { sessionPattern: e.target.value })}
                    className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs font-mono"
                    placeholder="*"
                  />
                </label>
                <label className="space-y-1 md:col-span-2">
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
                    {t('ai.safety.grants.commandPattern')}
                  </span>
                  <input
                    type="text"
                    value={grant.commandPattern ?? ''}
                    onChange={(e) => updateGrant(grant.id, {
                      commandPattern: e.target.value.trim() || undefined,
                    })}
                    className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs font-mono"
                    placeholder="ls *"
                  />
                </label>
                <label className="space-y-1 md:col-span-2">
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
                    {t('ai.safety.grants.note')}
                  </span>
                  <input
                    type="text"
                    value={grant.note ?? ''}
                    onChange={(e) => updateGrant(grant.id, { note: e.target.value.trim() || undefined })}
                    className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs"
                  />
                </label>
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => removeGrant(grant.id)}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive transition-colors"
                >
                  <X size={12} />
                  {t('ai.safety.grants.remove')}
                </button>
              </div>
            </div>
          ))}
        </div>

        <Button variant="outline" size="sm" className="text-xs" onClick={handleAdd}>
          <Plus size={14} className="mr-1" />
          {t('ai.safety.grants.add')}
        </Button>
      </SettingCard>
    </SettingsSection>
  );
};
