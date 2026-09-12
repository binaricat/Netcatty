import React from 'react';
import { Plus, X } from 'lucide-react';
import { useI18n } from '../../../../application/i18n/I18nProvider';
import type { HeaderRow } from '../../../../infrastructure/ai/providerHeaderCredentials';
import { Button } from '../../../ui/button';

export function ProviderHeadersEditor({ rows, onChange, disabled }: {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const inputClass = 'min-w-0 flex-1 h-8 rounded-md border border-input bg-background px-2 text-xs disabled:opacity-50';
  return <fieldset disabled={disabled} className="space-y-2">
    <legend className="text-xs font-medium text-muted-foreground">{t('ai.providers.headers')}</legend>
    <p className="text-[11px] text-muted-foreground">{t('ai.providers.headers.help')}</p>
    {rows.map((row, index) => <div key={index} className="flex items-center gap-2">
      <input aria-label={t('ai.providers.headers.name')} placeholder="X-Header" className={inputClass}
        value={row.name} onChange={(e) => onChange(rows.map((item, i) => i === index ? { ...item, name: e.target.value } : item))} />
      <input type="password" autoComplete="off" aria-label={t('ai.providers.headers.value')}
        placeholder={t('ai.providers.headers.value')} className={inputClass}
        value={row.value} onChange={(e) => onChange(rows.map((item, i) => i === index ? { ...item, value: e.target.value } : item))} />
      <Button type="button" variant="ghost" size="sm" aria-label={t('ai.providers.headers.remove')}
        onClick={() => onChange(rows.filter((_, i) => i !== index))}><X size={14} /></Button>
    </div>)}
    <Button type="button" variant="outline" size="sm" onClick={() => onChange([...rows, { name: '', value: '' }])}>
      <Plus size={12} className="mr-1.5" />{t('ai.providers.headers.add')}
    </Button>
  </fieldset>;
}
