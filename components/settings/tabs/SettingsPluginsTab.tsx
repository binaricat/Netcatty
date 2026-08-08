import { FolderOpen } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';

import { normalizePluginKeyboardEvent } from '../../../application/state/pluginKeybindings';
import { usePluginContributions } from '../../../application/state/usePluginContributions';
import { useI18n } from '../../../application/i18n/I18nProvider';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { SettingsAnchor, SettingsTabContent } from '../settings-ui';
import { requestOpenPluginView } from '../../plugins/PluginContributionHost';
import { parsePluginStructuredSettingValue } from './pluginSettingValues';
import { PluginStructuredSettingEditor } from './PluginStructuredSettingEditor';
import { useAvailableFonts } from '../../../application/state/fontStore';
import { TerminalFontSelect } from '../TerminalFontSelect';
import {
  resolvePluginSettingScopeSelection,
  usePluginSettingScopeCatalog,
} from '../../../application/state/usePluginSettingScopeCatalog';
import { PluginContributionIcon } from '../../plugins/PluginContributionIcon';

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
      return (
        <input
          aria-label={setting.label}
          type="checkbox"
          checked={Boolean(value)}
          disabled={saving}
          onChange={(event) => { setValue(event.target.checked); void save(event.target.checked); }}
          className="h-4 w-4 accent-primary"
        />
      );
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

  return (
    <div className="rounded-lg border border-border/70 bg-background p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <label className="text-sm font-medium">{setting.label}</label>
          {setting.description && (
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">{setting.description}</p>
          )}
          <p className="mt-1 font-mono text-[10px] text-muted-foreground">{setting.id} · {setting.scope}</p>
        </div>
        {setting.restartRequired && <span className="rounded bg-amber-500/15 px-2 py-1 text-[10px] text-amber-700 dark:text-amber-300">{t('settings.plugins.restartRequired')}</span>}
      </div>
      {control}
      <div className="flex items-center gap-2">
        {!setting.required && setting.scopeId != null && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              setError(null);
              void resetSetting(pluginId, setting.id, setting.scopeId ?? undefined)
                .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
                .finally(() => setSaving(false));
            }}
          >
            {t('common.reset')}
          </Button>
        )}
        {saving && <span className="text-xs text-muted-foreground">{t('settings.plugins.saving')}</span>}
        {setting.secret && setting.configured && <span className="text-xs text-emerald-600">{t('settings.plugins.storedSecurely')}</span>}
        {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
      </div>
    </div>
  );
}

export default function SettingsPluginsTab() {
  const { t } = useI18n();
  const availableFonts = useAvailableFonts();
  const scopeCatalog = usePluginSettingScopeCatalog();
  const [scopeIds, setScopeIds] = useState<Partial<Record<NetcattyPluginSettingScopeKind, string>>>({});
  useEffect(() => {
    setScopeIds((current) => resolvePluginSettingScopeSelection(scopeCatalog, current));
  }, [scopeCatalog]);
  const query = useMemo<NetcattyPluginContributionQuery>(() => ({
    context: { 'netcatty.surface': 'settings' },
    scopeIds,
  }), [scopeIds]);
  const contributions = usePluginContributions(query);
  const contextualScopes = useMemo(() => new Set(contributions.snapshot.plugins
    .flatMap((plugin) => plugin.settings.map((setting) => setting.scope))
    .filter((scope): scope is NetcattyPluginSettingScopeKind => scope !== 'application')),
  [contributions.snapshot.plugins]);
  const hasVisibleContributions = contributions.snapshot.plugins.some((plugin) => (
    plugin.settings.some((setting) => setting.visible)
    || plugin.views.some((view) => view.visible && view.location === 'settings')
  ));

  return (
    <SettingsTabContent value="plugins">
      <SettingsAnchor anchorId="plugins-root" className="mx-auto w-full max-w-3xl space-y-6 px-8 py-8">
        <div>
          <h2 className="text-xl font-semibold">{t('settings.plugins.title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('settings.plugins.description')}</p>
        </div>
        {contextualScopes.size > 0 && (
          <section className="grid gap-3 rounded-lg border border-border/70 bg-muted/10 p-4 sm:grid-cols-2" aria-label={t('settings.plugins.scopeTargets')}>
            {[...contextualScopes].map((kind) => (
              <label key={kind} className="space-y-1 text-xs font-medium">
                <span>{t('settings.plugins.scopeTarget').replace('{scope}', kind)}</span>
                <select
                  value={scopeIds[kind] ?? ''}
                  onChange={(event) => setScopeIds((current) => ({ ...current, [kind]: event.target.value || undefined }))}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm font-normal"
                >
                  {!scopeCatalog[kind].length && <option value="">{t('settings.plugins.noScopeTargets')}</option>}
                  {scopeCatalog[kind].map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                </select>
              </label>
            ))}
          </section>
        )}
        {contributions.loading && <p className="text-sm text-muted-foreground">{t('settings.plugins.loading')}</p>}
        {contributions.error && <p role="alert" className="text-sm text-destructive">{contributions.error.message}</p>}
        {contributions.snapshot.plugins.map((plugin) => {
          const settings = plugin.settings.filter((setting) => setting.visible);
          const views = plugin.views.filter((view) => view.visible && view.location === 'settings');
          if (!settings.length && !views.length) return null;
          return (
            <section key={plugin.id} className="space-y-3" aria-labelledby={`plugin-settings-${plugin.id}`}>
              <div>
                <h3 id={`plugin-settings-${plugin.id}`} className="text-base font-semibold">{plugin.displayName}</h3>
                {plugin.description && <p className="text-xs text-muted-foreground">{plugin.description}</p>}
              </div>
              {settings.map((setting) => (
                <PluginSettingField
                  key={setting.id}
                  pluginId={plugin.id}
                  setting={setting}
                  updateSetting={contributions.updateSetting}
                  resetSetting={contributions.resetSetting}
                  selectSettingPath={contributions.selectSettingPath}
                  availableFonts={availableFonts}
                />
              ))}
              {views.map((view) => (
                <div key={view.id} className="flex items-center justify-between rounded-lg border border-border/70 bg-background p-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <PluginContributionIcon pluginId={plugin.id} icon={view.icon} size={18} className="shrink-0" />
                    <div className="min-w-0">
                    <div className="text-sm font-medium">{view.title}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">{view.id}</div>
                    </div>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => requestOpenPluginView({
                    viewId: view.id,
                    context: { 'netcatty.surface': 'settings' },
                  })}>{t('common.open')}</Button>
                </div>
              ))}
            </section>
          );
        })}
        {!contributions.loading && contributions.available && !hasVisibleContributions && (
          <p className="text-sm text-muted-foreground">{t('settings.plugins.empty')}</p>
        )}
      </SettingsAnchor>
    </SettingsTabContent>
  );
}
