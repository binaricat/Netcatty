import React, { useRef, useState } from 'react';
import { usePluginSources } from '../../../application/state/usePluginSources';
import { useI18n } from '../../../application/i18n/I18nProvider';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../ui/dialog';
import { PluginMarketplace } from './PluginMarketplace';

export function PluginThirdPartyMarket({ installed, toolbarContainer, noVault }: {
  installed: NetcattyInstalledPlugin[]; toolbarContainer?: HTMLElement | null; noVault?: boolean;
}) {
  const { t } = useI18n();
  const model = usePluginSources();
  const [selected, setSelected] = useState('');
  const [visited, setVisited] = useState<string[]>([]);
  const [managing, setManaging] = useState(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const openManager = (event: React.MouseEvent<HTMLButtonElement>) => { opener.current = event.currentTarget; setManaging(true); };
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [disablePlugins, setDisablePlugins] = useState(false);
  const sources = model.sources.filter((source) => source.kind === 'third-party');
  const source = sources.find((item) => item.id === selected && item.enabled);
  let domain = '';
  try { domain = new URL(address).host; } catch { /* Host validates before saving. */ }
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-3">
      <select aria-label={t('settings.plugins.sources.select')} value={selected} onChange={(event) => { setSelected(event.target.value); setVisited((items) => [...new Set([...items, event.target.value])]); }} className="h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm">
        <option value="">{t('settings.plugins.sources.select')}</option>
        {sources.filter((item) => item.enabled).map((item) => <option key={item.id} value={item.id}>{item.name} — {new URL(item.origin!).hostname}</option>)}
      </select>
      <Button variant="outline" size="sm" onClick={openManager}>{t('settings.plugins.sources.manage')}</Button>
    </div>
    {!source && <div className="py-8 text-center text-sm text-muted-foreground"><p>{t('settings.plugins.sources.empty')}</p><Button className="mt-3" variant="outline" onClick={openManager}>{t('settings.plugins.sources.add')}</Button></div>}
    {/* Keep each visited source mounted to preserve its own selection/search/scroll. */}
    {sources.filter((item) => item.enabled && (item.id === selected || visited.includes(item.id))).map((item) => {
      return <div key={item.id} hidden={item.id !== source?.id}><PluginMarketplace source={item} installed={installed} toolbarContainer={item.id === source?.id ? toolbarContainer : undefined} noVault={noVault} /></div>;
    })}
    <Dialog open={managing} onOpenChange={setManaging}><DialogContent className="max-h-[85vh] overflow-y-auto" onCloseAutoFocus={(event) => { event.preventDefault(); opener.current?.focus(); }}>
      <DialogTitle>{t('settings.plugins.sources.manage')}</DialogTitle><DialogDescription>{t('settings.plugins.sources.risk')}</DialogDescription>
      {model.error && <p role="alert" className="text-sm text-destructive">{model.error}</p>}
      <div className="space-y-3">{sources.map((item) => <div key={item.id} className="space-y-2 rounded-lg bg-muted/30 p-3">
        <Input aria-label={t('settings.plugins.sources.name')} defaultValue={item.name} onBlur={(event) => { if (event.target.value !== item.name) void model.update(item, event.target.value, Boolean(item.enabled)); }} disabled={model.busy} />
        <p className="break-all text-xs text-muted-foreground">{item.origin}</p>
        <div className="flex items-center justify-between"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(item.enabled)} disabled={model.busy} onChange={(event) => void model.update(item, item.name, event.target.checked)} />{t('settings.plugins.manager.enabled')}</label><Button variant="ghost" size="sm" disabled={model.busy} onClick={() => { setRemoving(item.id); setDisablePlugins(false); }}>{t('settings.plugins.sources.remove')}</Button></div>
        {removing === item.id && <div className="space-y-2 text-sm"><p>{t('settings.plugins.sources.removeNote')}</p><label className="flex items-center gap-2"><input type="checkbox" checked={disablePlugins} onChange={(event) => setDisablePlugins(event.target.checked)} />{t('settings.plugins.sources.disablePlugins')}</label><Button size="sm" variant="destructive" disabled={model.busy} onClick={() => void model.remove(item.id, disablePlugins).then((ok) => { if (ok) setRemoving(null); })}>{t('settings.plugins.sources.remove')}</Button></div>}
      </div>)}</div>
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (accepted) void model.add(name, address).then((ok) => { if (ok) { setName(''); setAddress(''); setAccepted(false); } }); }}>
        <Input required value={name} onChange={(event) => setName(event.target.value)} placeholder={t('settings.plugins.sources.name')} aria-label={t('settings.plugins.sources.name')} />
        <Input required type="url" value={address} onChange={(event) => { setAddress(event.target.value); setAccepted(false); }} placeholder="https://plugins.example.com" aria-label={t('settings.plugins.sources.address')} />
        {domain && <p className="break-all text-sm font-medium">{domain}</p>}
        <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />{t('settings.plugins.sources.accept')}</label>
        <Button type="submit" disabled={model.busy || !accepted}>{t('settings.plugins.sources.add')}</Button>
      </form>
    </DialogContent></Dialog>
  </div>;
}
