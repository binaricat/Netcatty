import { describePluginPermission } from '@/domain/pluginPermissionDescriptions.cjs';
import { describePluginRuntime } from '@/domain/pluginRuntimePolicy.cjs';
import React, { useRef, useState } from 'react';
import { PluginPermissionPanel } from './PluginPermissionPanel';
import { PluginBrandIcon } from '../../plugins/PluginBrandIcon';
import { PluginAuthorRow } from '../../plugins/PluginAuthorRow';
import { ArrowLeft } from 'lucide-react';
import { usePluginManager } from '../../../application/state/usePluginManager';
import { useI18n } from '../../../application/i18n/I18nProvider';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';

export function PluginPackageDetails({ plugin }: { plugin: NetcattyInstalledPlugin }) {
  const { t, resolvedLocale } = useI18n();
  const manifest = plugin.manifest;
  if (!manifest) return null;
  const permissions = [
    ...(manifest.permissions?.required ?? []).map((value) => ({ value, required: true })),
    ...(manifest.permissions?.optional ?? []).map((value) => ({ value, required: false })),
  ];
  const policy = describePluginRuntime(manifest);
  const runtimeKind = plugin.runtime.kind ?? policy.defaultRuntimeKind;
  const runtimeLabel = runtimeKind === 'utility' ? 'advanced'
    : policy.hasNode ? 'dual' : policy.declaresAdvanced ? 'advancedDeclaration' : 'browser';
  return <div className="space-y-4 border-t border-border/60 pt-4 text-sm">
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
      <dt className="text-muted-foreground">ID</dt><dd className="break-all font-mono">{plugin.id}</dd>
      <dt className="text-muted-foreground">Netcatty</dt><dd>{manifest.engines.netcatty}</dd>
      <dt className="text-muted-foreground">API</dt><dd>{manifest.engines.api}</dd>
      <dt className="text-muted-foreground">SHA-256</dt><dd className="break-all font-mono">{plugin.archiveSha256 ?? '-'}</dd>
    </dl>
    <p className={!policy.browserOnly && !policy.dataOnly ? 'text-destructive' : 'text-muted-foreground'}>{policy.dataOnly ? t('settings.plugins.manager.dataTheme') : t(`settings.plugins.manager.${runtimeLabel}`)}</p>
    <div className="space-y-2">
      <h4 className="font-medium">{t('settings.plugins.manager.permissions')}</h4>
      <p className="text-xs text-muted-foreground">{t('settings.plugins.manager.permissionNote')}</p>
      {permissions.length === 0 && <p className="text-xs text-muted-foreground">{t('settings.plugins.manager.noPermissions')}</p>}
      {permissions.map(({ value, required }, index) => {
        const id = typeof value === 'string' ? value : value.permission;
        const description = describePluginPermission(id, resolvedLocale);
        return <div key={index} className="rounded-md bg-muted/40 p-3">
        <div className="flex justify-between gap-3"><span className="text-sm font-medium">{description.label}</span><span className="text-xs text-muted-foreground">{t(required ? 'settings.plugins.manager.required' : 'settings.plugins.manager.optional')}</span></div>
        <p className="mt-1 text-xs text-muted-foreground">{description.description}</p>
        <code className="mt-1 block break-all text-[10px] text-muted-foreground">{id}</code>
        {description.sensitive && <p className="mt-1 text-xs font-medium text-destructive">{t('settings.plugins.manager.sensitive')}</p>}
        {(typeof value === 'string' || value.resources.length === 0) && <p className="mt-1 text-xs">{t('settings.plugins.manager.unbounded')}</p>}
        {typeof value !== 'string' && <><p className="mt-1 whitespace-pre-wrap break-all text-xs">{value.resources.join('\n')}</p>{value.reason && <p className="mt-1 text-xs text-muted-foreground">{value.reason}</p>}</>}
      </div>; })}
    </div>
    <p className="text-xs text-muted-foreground">{t('settings.plugins.manager.data')}</p>
  </div>;
}

export function PluginPackageManager({ manager, onSelectionChange, initialSelectedId }: { initialSelectedId?: string | null; manager: ReturnType<typeof usePluginManager>; onSelectionChange?: (id: string | null) => void }) {
  const { t, resolvedLocale } = useI18n();
  const [selected, setSelected] = useState<string | null>(initialSelectedId ?? null);
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const rootRef = useRef<HTMLElement>(null);
  const scrollTop = useRef(0);
  const lastSelection = useRef<string | null>(null);
  const selectedPlugin = manager.plugins.find((plugin) => plugin.id === selected);
  const nameOf = (plugin: NetcattyInstalledPlugin) => typeof plugin.manifest?.displayName === 'string' ? plugin.manifest.displayName : plugin.manifest?.displayName?.[resolvedLocale] ?? plugin.manifest?.displayName?.en ?? plugin.manifest?.name ?? plugin.id;
  const descriptionOf = (plugin: NetcattyInstalledPlugin) => {
    const value = plugin.manifest?.description;
    return typeof value === 'string' ? value : value?.[resolvedLocale] ?? value?.en ?? '';
  };
  const choose = (id: string | null) => {
    const pane = rootRef.current?.closest<HTMLElement>('[data-settings-scroll-pane]');
    if (id) { scrollTop.current = pane?.scrollTop ?? 0; lastSelection.current = id; }
    setSelected(id); setRemoving(null); onSelectionChange?.(id);
    requestAnimationFrame(() => {
      if (pane) pane.scrollTop = id ? 0 : scrollTop.current;
      if (id) rootRef.current?.querySelector<HTMLElement>('[data-plugin-detail]')?.focus({ preventScroll: true });
      else Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('[data-plugin-card]') ?? []).find((button) => button.dataset.pluginCard === lastSelection.current)?.focus({ preventScroll: true });
    });
  };
  const visible = selectedPlugin ? [selectedPlugin] : manager.plugins.filter((plugin) => (!sourceFilter || (plugin.source?.id ?? 'local') === sourceFilter) && [nameOf(plugin), plugin.manifest?.publisher, plugin.manifest?.description, plugin.id].some((value) => JSON.stringify(value ?? '').toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
  const [removing, setRemoving] = useState<string | null>(null);
  const [clearSource, setClearSource] = useState(false);
  if (!manager.available) return null;
  return <section ref={rootRef} className="space-y-4" aria-label={t('settings.plugins.manager.installed')}>
    {selectedPlugin && <Button variant="ghost" size="sm" onClick={() => choose(null)}><ArrowLeft size={14} className="mr-2" />{t('settings.plugins.manager.installed')}</Button>}
    {!selectedPlugin && manager.plugins.length > 0 && <select aria-label={t('settings.plugins.sources.source')} value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm"><option value="">{t('settings.plugins.sources.all')}</option>{[...new Map(manager.plugins.map((plugin) => [plugin.source?.id ?? 'local', plugin.source])).entries()].map(([id, source]) => <option key={id} value={id}>{source?.origin ?? t('settings.plugins.sources.local')}</option>)}</select>}
    {!selectedPlugin && manager.plugins.length > 0 && <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('settings.plugins.market.search')} aria-label={t('settings.plugins.market.search')} />}
    {!selectedPlugin && manager.plugins.length > 0 && visible.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">{t('settings.plugins.market.noResults')}</p>}
    {manager.error && <p role="alert" className="text-sm text-destructive">{manager.error}</p>}
    {!manager.plugins.length && <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{t('settings.plugins.manager.empty')}</div>}
    <div className={selectedPlugin ? 'space-y-4' : 'grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-3'}>
    {visible.map((plugin) => <article key={plugin.id} data-plugin-detail={selectedPlugin ? true : undefined} tabIndex={selectedPlugin ? -1 : undefined} aria-label={nameOf(plugin)} className={`min-w-0 rounded-lg focus:outline-none ${selectedPlugin ? 'space-y-4' : 'plugin-card flex min-h-[200px] flex-col gap-3 bg-card p-4'}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center"><PluginBrandIcon plugin={plugin} size={32} /></div>
        <button type="button" data-plugin-card={plugin.id} className="min-w-0 flex-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-expanded={selected === plugin.id} onClick={() => choose(selected === plugin.id ? null : plugin.id)}>
          <div className="break-words text-sm font-medium">{nameOf(plugin)}</div>

        </button>
        <Button variant="ghost" size="sm" type="button"
          className={`h-7 shrink-0 rounded-full border-0 px-3 text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${manager.statusKnown !== false && plugin.enabled ? 'bg-primary/10 hover:bg-primary/15' : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground'}`}
          style={manager.statusKnown !== false && plugin.enabled ? { color: 'color-mix(in srgb, hsl(var(--primary)) 40%, hsl(var(--foreground)))' } : undefined}
          aria-pressed={manager.statusKnown === false ? undefined : plugin.enabled} aria-busy={manager.busy}
          aria-label={`${t(manager.statusKnown === false ? 'settings.plugins.permissions.statusUnknown' : plugin.enabled ? 'settings.plugins.manager.disable' : 'settings.plugins.manager.enable')} ${plugin.manifest?.name ?? plugin.id}`}
          title={t(manager.statusKnown === false ? 'settings.plugins.permissions.statusUnknown' : plugin.enabled ? 'settings.plugins.manager.disable' : 'settings.plugins.manager.enable')}
          disabled={manager.busy || manager.statusKnown === false} onClick={() => void manager.setEnabled(plugin.id, !plugin.enabled)}>
          {t(manager.statusKnown === false ? 'settings.plugins.permissions.statusUnknown' : plugin.enabled ? 'settings.plugins.manager.enabled' : 'settings.plugins.manager.disabled')}
        </Button>
      </div>
      <p className="break-all text-xs text-muted-foreground">{t('settings.plugins.sources.source')}: {t(plugin.source?.kind === 'official' ? 'settings.plugins.sources.official' : plugin.source?.kind === 'third-party' ? 'settings.plugins.sources.thirdparty' : 'settings.plugins.sources.local')}{plugin.source?.origin ? ` · ${plugin.source.origin}` : ''}</p>
      {plugin.manifest?.publisher && <PluginAuthorRow plugin={plugin} />}
      <p className={`break-words text-sm leading-5 text-muted-foreground ${selectedPlugin ? 'whitespace-pre-wrap' : 'line-clamp-3'}`}>{descriptionOf(plugin) || t('settings.plugins.manager.noDescription')}</p>
      {!selectedPlugin ? <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">
        <p className="break-words text-xs text-muted-foreground">{plugin.activeVersion}{plugin.manifest?.license ? ` · ${plugin.manifest.license}` : ''}</p>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => choose(plugin.id)} aria-label={`${t('settings.plugins.manager.details')} ${nameOf(plugin)}`}>{t('settings.plugins.manager.details')}</Button>
      </div> : <p className="text-xs text-muted-foreground">{plugin.activeVersion}{plugin.manifest?.license ? ` · ${plugin.manifest.license}` : ''}</p>}
      {plugin.runtime.lastError && <p role="status" className="break-words text-xs text-destructive">{t('settings.plugins.manager.lastError')}: {plugin.runtime.lastError}</p>}
      {selected === plugin.id && <>
        <PluginPackageDetails plugin={plugin} />
        <PluginPermissionPanel key={plugin.id} pluginId={plugin.id} onChanged={async () => { await manager.refresh(); }} />
        {removing === plugin.id ? <div className="space-y-2 rounded-lg border border-destructive/30 p-3">
          <p className="text-xs">{t('settings.plugins.manager.removeNote')}</p>
          <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={clearSource} onChange={(event) => setClearSource(event.target.checked)} />{t('settings.plugins.sources.clearPrivate')}</label>
          <Button variant="destructive" size="sm" disabled={manager.busy} onClick={() => { void manager.uninstall(plugin.id, clearSource); setRemoving(null); }}>{t('settings.plugins.manager.remove')}</Button>
          <Button variant="ghost" size="sm" onClick={() => setRemoving(null)}>{t('common.cancel')}</Button>
        </div> : <Button variant="ghost" size="sm" disabled={manager.busy} onClick={() => { setClearSource(false); setRemoving(plugin.id); }}>{t('settings.plugins.manager.remove')}</Button>}
      </>}
    </article>)}
    </div>
  </section>;
}
