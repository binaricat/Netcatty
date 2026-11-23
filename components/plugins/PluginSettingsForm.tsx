import React, { useEffect, useState } from 'react';
import { FolderOpen, RotateCcw } from 'lucide-react';
import { normalizePluginKeyboardEvent } from '../../application/state/pluginKeybindings';
import { usePluginContributions } from '../../application/state/usePluginContributions';
import { useI18n } from '../../application/i18n/I18nProvider';
import { useAvailableFonts } from '../../application/state/fontStore';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Toggle } from '../settings/settings-ui';
import { parsePluginStructuredSettingValue } from '../settings/tabs/pluginSettingValues';
import { PluginStructuredSettingEditor } from '../settings/tabs/PluginStructuredSettingEditor';
import { TerminalFontSelect } from '../settings/TerminalFontSelect';

export function PluginSettingField({
  pluginId,
  setting,
  updateSetting,
  resetSetting,
  selectSettingPath,
  availableFonts,
}: {
  pluginId: string;
  setting: NetcattyPluginSettingContribution;
  updateSetting: ReturnType<typeof usePluginContributions>['updateSetting'];
  resetSetting: ReturnType<typeof usePluginContributions>['resetSetting'];
  selectSettingPath: ReturnType<typeof usePluginContributions>['selectSettingPath'];
  availableFonts: ReturnType<typeof useAvailableFonts>;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState<unknown>(setting.secret ? '' : setting.value ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const itemLabel = (key: 'settings.plugins.moveItemUp' | 'settings.plugins.moveItemDown', index: number) => (
    t(key).replace('{label}', setting.label).replace('{index}', String(index + 1))
  );

  useEffect(() => {
    setValue(setting.secret ? '' : setting.value ?? '');
  }, [setting.secret, setting.value]);

  const save = async (nextValue: unknown) => {
    setSaving(true);
    setError(null);
    try {
      await updateSetting(pluginId, setting.id, nextValue, setting.scopeId ?? undefined);
      if (setting.secret) setValue('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const control = (() => {
    if (setting.scopeId == null) {
      return <div className="text-xs text-muted-foreground">{t('settings.plugins.scopeContext').replace('{scope}', setting.scope)}</div>;
    }
    if (setting.control === 'switch') {
      return <Toggle ariaLabel={setting.label} checked={Boolean(value)} disabled={saving}
        onChange={(next) => { setValue(next); void save(next); }} />;
    }
    if (setting.control === 'radio') {
      return (
        <fieldset className="space-y-2" disabled={saving}>
          <legend className="sr-only">{setting.label}</legend>
          {setting.options?.map((option) => (
            <label key={option.value} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name={setting.id}
                value={option.value}
                checked={value === option.value}
                onChange={() => { setValue(option.value); void save(option.value); }}
                className="mt-0.5 accent-primary"
              />
              <span>{option.label}{option.description && <span className="block text-xs text-muted-foreground">{option.description}</span>}</span>
            </label>
          ))}
        </fieldset>
      );
    }
    if (setting.control === 'select') {
      return (
        <select
          aria-label={setting.label}
          value={String(value)}
          disabled={saving}
          onChange={(event) => { setValue(event.target.value); void save(event.target.value); }}
          className="h-9 min-w-52 rounded-md border border-input bg-background px-3 text-sm"
        >
          {setting.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      );
    }
    if (setting.control === 'multiselect') {
      const selected = Array.isArray(value) ? value.map(String) : [];
      return (
        <select
          aria-label={setting.label}
          multiple
          value={selected}
          disabled={saving}
          onChange={(event) => {
            const next = [...event.currentTarget.selectedOptions].map((option) => option.value);
            setValue(next);
            void save(next);
          }}
          className="min-h-24 min-w-52 rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          {setting.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      );
    }
    if (setting.control === 'textarea') {
      return (
        <textarea
          aria-label={setting.label}
          value={String(value)}
          placeholder={setting.placeholder}
          disabled={saving}
          onChange={(event) => setValue(event.target.value)}
          onBlur={(event) => void save(event.currentTarget.value)}
          className="min-h-24 w-full max-w-xl rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
      );
    }
    if (setting.control === 'number' || setting.control === 'slider') {
      return (
        <Input
          aria-label={setting.label}
          type={setting.control === 'slider' ? 'range' : 'number'}
          value={typeof value === 'number' ? value : Number(value) || 0}
          min={setting.minimum}
          max={setting.maximum}
          step={setting.step}
          disabled={saving}
          onChange={(event) => setValue(Number(event.target.value))}
          onBlur={(event) => void save(Number(event.currentTarget.value))}
          className="max-w-sm"
        />
      );
    }
    if (setting.control === 'list' || setting.control === 'table') {
      return (
        <PluginStructuredSettingEditor
          setting={setting}
          value={typeof value === 'string' ? parsePluginStructuredSettingValue(value) : value}
          disabled={saving}
          onChange={setValue}
          onCommit={(next) => void save(next)}
          labels={{
            add: t('settings.plugins.addItem'),
            remove: t('settings.plugins.removeItem'),
            moveUp: (index) => itemLabel('settings.plugins.moveItemUp', index),
            moveDown: (index) => itemLabel('settings.plugins.moveItemDown', index),
          }}
        />
      );
    }
    if (setting.control === 'font') {
      return (
        <TerminalFontSelect
          value={String(value)}
          fonts={availableFonts}
          disabled={saving}
          onChange={(next) => { setValue(next); void save(next); }}
          className="w-full max-w-xl"
          ariaLabel={setting.label}
        />
      );
    }
    if (setting.control === 'file' || setting.control === 'directory') {
      return (
        <div className="flex max-w-xl gap-2">
          <Input aria-label={setting.label} value={String(value)} readOnly disabled={saving} className="min-w-0 flex-1" />
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={() => void selectSettingPath(setting.control as 'file' | 'directory', setting.label, String(value || '')).then((selected) => {
              if (!selected) return;
              setValue(selected);
              void save(selected);
            }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))}
          >
            <FolderOpen size={14} className="mr-2" /> {t('settings.plugins.browse')}
          </Button>
        </div>
      );
    }
    if (setting.control === 'keybinding') {
      return (
        <Input
          aria-label={setting.label}
          value={String(value)}
          placeholder={setting.placeholder ?? t('settings.plugins.pressKeybinding')}
          readOnly
          disabled={saving}
          onKeyDown={(event) => {
            event.preventDefault();
            const key = normalizePluginKeyboardEvent(event.nativeEvent);
            if (!key) return;
            setValue(key);
            void save(key);
          }}
          className="max-w-xl"
        />
      );
    }
    return (
      <Input
        aria-label={setting.label}
        type={setting.secret || setting.control === 'password' ? 'password' : setting.control === 'color' ? 'color' : 'text'}
        value={String(value)}
        placeholder={setting.secret && setting.configured ? t('settings.plugins.configuredReplacement') : setting.placeholder}
        disabled={saving}
        onChange={(event) => setValue(event.target.value)}
        onBlur={(event) => {
          const next = event.currentTarget.value;
          if (!setting.secret || next.length > 0) void save(next);
        }}
        className="max-w-xl"
      />
    );
  })();

  const expanded = ['textarea', 'list', 'table', 'radio', 'multiselect'].includes(setting.control);
  const reset = !setting.required && setting.scopeId != null && <Button
    type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-muted-foreground"
    title={t('common.reset')} aria-label={t('common.reset')} disabled={saving}
    onClick={() => {
      setSaving(true); setError(null);
      void resetSetting(pluginId, setting.id, setting.scopeId ?? undefined)
        .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setSaving(false));
    }}><RotateCcw size={14} /></Button>;
  return <div className="space-y-2 py-3" data-plugin-setting={setting.id}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0 flex-1 basis-40">
        <div className="text-sm font-medium">{setting.label}</div>
        {setting.description && <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">{setting.description}</p>}
        {setting.restartRequired && <span className="text-xs text-amber-700 dark:text-amber-300">{t('settings.plugins.restartRequired')}</span>}
      </div>
      <div className="flex max-w-full items-center justify-end gap-2">
        {!expanded && <div className={setting.control === 'switch' ? 'shrink-0' : 'w-56 max-w-full'}>{control}</div>}
        {reset}
      </div>
    </div>
    {expanded && control}
    {(saving || (setting.secret && setting.configured) || error) && <div className="flex flex-wrap items-center gap-2">
      {saving && <span role="status" className="text-xs text-muted-foreground">{t('settings.plugins.saving')}</span>}
      {setting.secret && setting.configured && <span className="text-xs text-emerald-600">{t('settings.plugins.storedSecurely')}</span>}
      {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
    </div>}
  </div>;
}


export function PluginSettingGroups({ settings, ...props }: Omit<Parameters<typeof PluginSettingField>[0], 'setting'> & {
  settings: ReadonlyArray<NetcattyPluginSettingContribution>;
}) {
  const groups = new Map<string, NetcattyPluginSettingContribution[]>();
  for (const setting of settings) {
    if (!setting.visible) continue;
    const group = setting.group ?? '';
    groups.set(group, [...(groups.get(group) ?? []), setting]);
  }
  return <>{[...groups].map(([group, fields]) => <div key={group} className="space-y-3">
    {group && <h4 className="pt-2 text-sm font-medium text-muted-foreground">{group}</h4>}
    <div className="divide-y divide-border/50 rounded-xl bg-muted/30 px-4">
      {fields.map((setting) => <PluginSettingField key={setting.id} {...props} setting={setting} />)}
    </div>
  </div>)}</>;
}

