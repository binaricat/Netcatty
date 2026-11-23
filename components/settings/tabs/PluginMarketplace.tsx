import { createPortal } from 'react-dom';
import { PluginStatus } from './PluginStatus';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../ui/dialog';
import { PluginInfo } from './PluginInfo';
import React, { useRef, useState } from 'react';
import { PluginBrandIcon } from '../../plugins/PluginBrandIcon';
import { PluginAuthorRow } from '../../plugins/PluginAuthorRow';
import { ArrowLeft } from 'lucide-react';
import { useI18n } from '../../../application/i18n/I18nProvider';
import { usePluginCatalog } from '../../../application/state/usePluginCatalog';
import { Input } from '../../ui/input';
import { Button } from '../../ui/button';
import { PluginPackageDetails } from './PluginPackageManager';
import { PluginReadme } from './PluginReadme';

export function PluginMarketplace({ installed = [], toolbarContainer, noVault, source }: { source?: NetcattyPluginSource; noVault?: boolean; installed?: NetcattyInstalledPlugin[]; toolbarContainer?: HTMLElement | null }) {
  const [selected, setSelected] = useState<string | null>(null);
  const catalog = usePluginCatalog(selected, source?.id);
  return <PluginMarketplaceContent catalog={catalog} marketSource={source} installed={installed} selected={selected} onSelect={setSelected} toolbarContainer={toolbarContainer} noVault={noVault} />;
}

// The browser owns only presentation state; installation and README policy stay in the existing hook.
export function PluginMarketplaceContent({ catalog, installed, selected, onSelect, toolbarContainer, noVault, marketSource }: {
  marketSource?: NetcattyPluginSource;
  noVault?: boolean;
  toolbarContainer?: HTMLElement | null;
  catalog: ReturnType<typeof usePluginCatalog>;
  installed: NetcattyInstalledPlugin[];
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [confirmInstall, setConfirmInstall] = useState(false);
  const [clearPreviousSource, setClearPreviousSource] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLHeadingElement>(null);
  const installButtonRef = useRef<HTMLButtonElement>(null);
  const lastSelection = useRef<string | null>(null);
  const pageScroll = useRef(0);
  const entry = catalog.entries.find((item) => item.id === selected);
  const filtered = filterPluginCatalog(catalog.entries, search);
  const sourceId = marketSource?.id ?? 'official';
  const sameSource = (plugin: NetcattyInstalledPlugin) => (plugin.source?.id ?? 'local') === sourceId;
  const installedEntry = installed.find((item) => item.id === entry?.id && sameSource(item));
  const conflictingInstall = installed.find((item) => item.id === entry?.id && !sameSource(item));
  const choose = (id: string) => {
    const pane = listRef.current?.closest<HTMLElement>('[data-settings-scroll-pane]');
    pageScroll.current = pane?.scrollTop ?? 0;
    lastSelection.current = id;
    onSelect(id);
    requestAnimationFrame(() => {
      if (pane) pane.scrollTop = 0;
      detailRef.current?.focus({ preventScroll: true });
    });
  };
  const back = () => {
    onSelect(null);
    requestAnimationFrame(() => {
      if (listRef.current) {
        const pane = listRef.current.closest('[data-settings-scroll-pane]');
        if (pane) pane.scrollTop = pageScroll.current;
        const button = Array.from(listRef.current.querySelectorAll<HTMLButtonElement>('[data-plugin-id]'))
          .find((item) => item.dataset.pluginId === lastSelection.current);
        button?.focus({ preventScroll: true });
      }
    });
  };
  const refresh = !entry && <Button variant="outline" size="sm" disabled={catalog.listStatus === 'loading'} onClick={catalog.retryList}>{t('common.refresh')}</Button>;
  return <section className="plugin-marketplace space-y-4" aria-label={t('settings.plugins.market.title')}>
    {toolbarContainer ? createPortal(<><PluginStatus sourceKind={marketSource?.kind} noVault={noVault} offlineError={catalog.listError} retry={catalog.retryList} />{refresh}</>, toolbarContainer) : <div className="flex items-center gap-2"><PluginStatus sourceKind={marketSource?.kind} noVault={noVault} offlineError={catalog.listError} retry={catalog.retryList} />{refresh}</div>}
    {catalog.error && <p role="alert" className="text-xs text-destructive">{catalog.error}</p>}
    <div className="plugin-marketplace-browser">
      {!entry && <div className="plugin-marketplace-catalog space-y-3" ref={listRef}>
        <div className="flex items-center gap-3"><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('settings.plugins.market.search')} aria-label={t('settings.plugins.market.search')} />
        {catalog.listStatus === 'ready' && <p className="shrink-0 text-xs text-muted-foreground" aria-live="polite">{t('settings.plugins.market.results', { count: filtered.length })}</p>}</div>
        {catalog.listStatus === 'ready' && catalog.entries.length > 0 && filtered.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{t('settings.plugins.market.noResults')}</p>}
        {catalog.listStatus === 'loading' && <p className="text-xs text-muted-foreground">{t('settings.plugins.loading')}</p>}
        {catalog.listStatus === 'error' && <div role="alert" className="space-y-2 text-xs text-destructive"><p>{catalog.listError}</p><Button variant="outline" size="sm" onClick={catalog.retryList}>{t('settings.plugins.market.retry')}</Button></div>}
        {catalog.listStatus === 'ready' && catalog.entries.length === 0 && <p className="text-xs text-muted-foreground">{t('settings.plugins.market.empty')}</p>}
        <div className="plugin-marketplace-grid">{filtered.map((item) => {
          const isInstalled = installed.some((plugin) => plugin.id === item.id && sameSource(plugin));
          return <button key={item.id} type="button" data-plugin-id={item.id} aria-current={selected === item.id ? 'true' : undefined} onClick={() => choose(item.id)}
            className="plugin-card min-w-0 flex min-h-[200px] flex-col gap-3 rounded-lg bg-card p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <div className="flex items-center gap-3"><span className="flex h-8 w-8 shrink-0 items-center justify-center"><PluginBrandIcon entry={item} size={32} className="text-muted-foreground" /></span><span className="min-w-0 break-words text-sm font-semibold leading-5">{item.name}</span></div>
            <PluginAuthorRow entry={item} sourceId={sourceId} />
            <p className="line-clamp-3 break-words text-sm leading-5 text-muted-foreground">{item.description}</p>
            <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-muted-foreground"><span>{item.version} · {item.license}</span><span className="text-foreground">{t('settings.plugins.manager.details')}</span></div>
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">{isInstalled && <span className="rounded bg-muted px-2 py-0.5 text-foreground">{t('settings.plugins.market.installed')}</span>}{!item.artifact && <span className="rounded bg-muted/40 px-2 py-0.5">{t('settings.plugins.market.sourceBadge')}</span>}</div>
          </button>;
        })}</div>
      </div>}
      {entry && <article key={entry.id} aria-label={entry.name} className="plugin-marketplace-detail mx-auto w-full max-w-[920px] min-w-0 space-y-6 focus:outline-none">
        <Button variant="ghost" size="sm" onClick={back}><ArrowLeft size={14} className="mr-2" />{t('settings.plugins.market.back')}</Button>
        <div className="space-y-2"><div className="flex items-center gap-3"><PluginBrandIcon entry={entry} size={48} /><h4 ref={detailRef} tabIndex={-1} className="break-words text-xl font-semibold focus:outline-none">{entry.name}</h4></div><PluginAuthorRow entry={entry} sourceId={sourceId} /><p className="text-xs text-muted-foreground">{entry.version} · {entry.license}</p>
          {installedEntry && <p className="text-xs text-muted-foreground">{t('settings.plugins.market.installed')} · {installedEntry.activeVersion} · {t(installedEntry.enabled ? 'settings.plugins.manager.enabled' : 'settings.plugins.manager.disabled')}</p>}
        </div>
        {installedEntry?.runtime?.lastError && <p role="status" className="break-words text-xs text-destructive">{t('settings.plugins.manager.lastError')}: {installedEntry.runtime.lastError}</p>}
        <p className="text-sm leading-6 text-muted-foreground">{entry.description}</p>
        <a className="block break-all text-xs text-primary underline underline-offset-4" href={`https://github.com/${entry.repository}/tree/${entry.commit}`} target="_blank" rel="noopener noreferrer">{entry.repository} @ {entry.commit.slice(0, 12)}</a>
        {conflictingInstall && <p role="status" className="text-xs text-muted-foreground">{t('settings.plugins.sources.conflict')} {conflictingInstall.source?.origin ?? t('settings.plugins.sources.local')}</p>}
        {entry.artifact ? <div className="space-y-2"><p className="text-xs text-muted-foreground">{t('settings.plugins.market.installNote')}</p>{catalog.listError && <p role="status" className="text-xs text-muted-foreground">{t('settings.plugins.market.offlineShort')}</p>}<Button ref={installButtonRef} size="sm" disabled={catalog.busy || Boolean(catalog.listError) || Boolean(conflictingInstall)} onClick={() => { if (marketSource?.kind === 'third-party' || (catalog.sourceBinding && catalog.sourceBinding.id !== (marketSource?.id ?? 'official'))) { setClearPreviousSource(false); setConfirmInstall(true); } else void catalog.install(entry.id); }}>{t('settings.plugins.market.install')}</Button></div> : <div className="flex items-center gap-1 text-xs text-muted-foreground"><span>{t('settings.plugins.market.sourceBadge')}</span><PluginInfo label={t('settings.plugins.market.sourceBadge')}>{t(marketSource?.kind === 'third-party' ? 'settings.plugins.sources.sourceOnly' : 'settings.plugins.market.sourceOnly')}</PluginInfo></div>}
        <section><h4 className="mb-3 text-sm font-semibold">{t('settings.plugins.market.manifest')}</h4><PluginPackageDetails plugin={{ id: entry.id, activeVersion: entry.version, enabled: false, manifest: entry.manifest, archiveSha256: entry.artifact?.sha256, runtime: { status: 'stopped', kind: null, lastError: null, quarantinedAt: null } }} /></section>
        <div className="min-w-0 border-t pt-4"><div className="flex items-center gap-1"><h4 className="text-sm font-semibold">README</h4><PluginInfo label={t('settings.plugins.market.readmeInfo')}>{t('settings.plugins.market.readmeNote')}</PluginInfo></div>{catalog.readmeStatus === 'loading' && <p className="mt-3 text-xs text-muted-foreground">{t('settings.plugins.loading')}</p>}
          {catalog.readmeStatus === 'error' && <div role="alert" className="mt-3 space-y-2 text-xs text-destructive"><p>{catalog.readmeError}</p><Button variant="outline" size="sm" onClick={catalog.retryReadme}>{t('settings.plugins.market.retry')}</Button></div>}
          {catalog.readmeStatus === 'ready' && (catalog.readme?.trim() ? <PluginReadme markdown={catalog.readme} images={catalog.readmeImages} /> : <p className="mt-3 text-xs text-muted-foreground">{t('settings.plugins.market.emptyReadme')}</p>)}
        </div>
      </article>}
    </div>
    <Dialog open={confirmInstall && Boolean(entry)} onOpenChange={setConfirmInstall}><DialogContent className="max-h-[85vh] overflow-y-auto" onCloseAutoFocus={(event) => { event.preventDefault(); installButtonRef.current?.focus(); }}>
      <DialogTitle>{t('settings.plugins.sources.installConfirm')}</DialogTitle><DialogDescription>{t('settings.plugins.sources.risk')}</DialogDescription>
      <p className="break-all text-sm font-medium">{marketSource?.origin}</p>
      {entry && <PluginPackageDetails plugin={{ id: entry.id, activeVersion: entry.version, enabled: false, manifest: entry.manifest, source: marketSource, archiveSha256: entry.artifact?.sha256, runtime: { status: 'stopped', kind: null, lastError: null, quarantinedAt: null } }} />}
      {catalog.sourceBinding && catalog.sourceBinding.id !== (marketSource?.id ?? 'official') && <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={clearPreviousSource} onChange={(event) => setClearPreviousSource(event.target.checked)} />{t('settings.plugins.sources.clearPrivate')}<span className="break-all">{catalog.sourceBinding.origin ?? t('settings.plugins.sources.local')}</span></label>}
      <Button disabled={catalog.busy || Boolean(catalog.listError) || Boolean(catalog.sourceBinding && catalog.sourceBinding.id !== (marketSource?.id ?? 'official') && !clearPreviousSource)} onClick={() => { if (entry) void catalog.install(entry.id, marketSource?.id, clearPreviousSource).then(() => setConfirmInstall(false)); }}>{t('settings.plugins.market.install')}</Button>
    </DialogContent></Dialog>
  </section>;
}

export function filterPluginCatalog(entries: NetcattyPluginCatalogEntry[], query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return entries.filter((entry) => `${entry.name} ${entry.author} ${entry.description}`.toLocaleLowerCase().includes(needle));
}
