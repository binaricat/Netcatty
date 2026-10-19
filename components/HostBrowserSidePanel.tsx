import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Bookmark, Download, Edit2, Loader2, Plus, RotateCw, Square, Trash2, X } from 'lucide-react';
import { useHostBrowserPanel } from '../application/state/useHostBrowserPanel';
import { useHostBrowserControls } from '../application/state/useHostBrowserControls';
import { useI18n } from '../application/i18n/I18nProvider';
import type { BrowserBookmark } from '../domain/browserBookmark';
import type { HostBrowserTab } from '../domain/hostBrowser';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './ui/context-menu';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { BrowserIcon } from './host-browser/BrowserIcon';
import { BrowserBookmarkEditor } from './host-browser/BrowserBookmarkEditor';
import { BrowserDownloads } from './host-browser/BrowserDownloads';
import { BrowserIconEditor, type BrowserIconSelection } from './host-browser/BrowserIconEditor';

function ToolbarButton({ label, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <Tooltip><TooltipTrigger asChild><button type="button" aria-label={label} {...props} className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-secondary/70 hover:text-foreground disabled:pointer-events-none disabled:opacity-35', props.className)}>{children}</button></TooltipTrigger><TooltipContent side="top">{label}</TooltipContent></Tooltip>;
}

export function HostBrowserSidePanel(props: Parameters<typeof useHostBrowserPanel>[0]) {
  const { elementRef, error: mountError, snapshot, retry, ready } = useHostBrowserPanel(props);
  const browser = useHostBrowserControls(props.browserId, ready && props.isVisible);
  const { t } = useI18n();
  const active = browser.state?.tabs.find((tab) => tab.id === browser.state?.activeTabId);
  const connected = browser.state?.route === 'connected';
  const [address, setAddress] = useState('');
  const addressRef = useRef<HTMLInputElement>(null);
  const lastActive = useRef<string | undefined>(undefined);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [editingBookmark, setEditingBookmark] = useState<Partial<BrowserBookmark> | null>(null);
  const [editingIcon, setEditingIcon] = useState<HostBrowserTab | null>(null);

  useEffect(() => {
    if (lastActive.current !== active?.id || document.activeElement !== addressRef.current) setAddress(active?.url || '');
    lastActive.current = active?.id;
  }, [active?.id, active?.url]);
  useEffect(() => {
    if (!browser.focusAddress) return;
    addressRef.current?.focus(); addressRef.current?.select();
  }, [browser.focusAddress]);
  useEffect(() => { setEditingBookmark(null); setEditingIcon(null); setBookmarksOpen(false); setDownloadsOpen(false); }, [props.browserId]);
  useEffect(() => {
    if (browser.downloadStarted) { setDownloadsOpen(true); setBookmarksOpen(false); }
  }, [browser.downloadStarted]);

  const newBookmark = () => {
    setBookmarksOpen(true);
    setEditingBookmark({ title: active?.url ? active.title || '' : '', url: active?.url || '', scope: 'host', color: '#247969', order: browser.bookmarks.length });
  };
  const navigate = (url: string) => { void browser.command({ type: 'navigate', url }); };
  const error = mountError || browser.error;
  return <div className="relative flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden bg-background text-foreground" data-section="host-browser-root" onKeyDownCapture={(event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (!['l', 't', 'w', 'r'].includes(key)) return;
    event.preventDefault(); event.stopPropagation();
    if (key === 'l') browser.requestAddressFocus();
    if (key === 't') void browser.command({ type: 'new-tab' });
    if (key === 'w') void browser.command({ type: 'close-tab' });
    if (key === 'r') void browser.command({ type: 'reload' });
  }}>
    <div className="shrink-0 border-b border-border/50" data-section="host-browser-controls">
      <div className="flex min-w-0 items-center gap-0.5 px-1.5 pt-1">
        <div role="tablist" aria-label={t('terminal.browser.title')} className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {browser.state?.tabs.map((tab) => <ContextMenu key={tab.id}><ContextMenuTrigger asChild><div role="tab" tabIndex={tab.id === active?.id ? 0 : -1} aria-selected={tab.id === active?.id} draggable
            className={cn('group flex h-7 min-w-[90px] max-w-[200px] flex-1 cursor-default items-center gap-1.5 rounded px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring', tab.id === active?.id ? 'bg-secondary/65 text-foreground' : 'text-muted-foreground hover:bg-secondary/30')}
            onClick={() => void browser.command({ type: 'activate', tabId: tab.id })}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void browser.command({ type: 'activate', tabId: tab.id }); } }}
            onDragStart={(event) => { event.dataTransfer.setData('text/plain', tab.id); event.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
            onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData('text/plain'); if (browser.state?.tabs.some((item) => item.id === id)) void browser.command({ type: 'reorder', tabId: id, beforeTabId: tab.id }); }}>
            {tab.loading ? <Loader2 size={13} className="shrink-0 animate-spin" /> : <BrowserIcon image={tab.iconDataUrl} glyph={tab.iconGlyph} color={tab.iconColor} className="h-3.5 w-3.5" />}
            <span className="min-w-0 flex-1 truncate" title={tab.title || tab.url}>{tab.url ? tab.title || tab.url : t('terminal.browser.newTab')}</span>
            <button type="button" aria-label={t('terminal.browser.closeTab')} className="grid h-4 w-4 shrink-0 place-items-center rounded opacity-60 hover:bg-muted hover:opacity-100" onClick={(event) => { event.stopPropagation(); void browser.command({ type: 'close-tab', tabId: tab.id }); }}><X size={11} /></button>
          </div></ContextMenuTrigger><ContextMenuContent>
            <ContextMenuItem disabled={!tab.url} onClick={() => setEditingIcon(tab)}>{t('terminal.browser.changeIcon')}</ContextMenuItem>
            <ContextMenuItem disabled={!tab.url} onClick={() => void browser.command({ type: 'reset-icon', tabId: tab.id })}>{t('terminal.browser.resetIcon')}</ContextMenuItem>
          </ContextMenuContent></ContextMenu>)}
        </div>
        <ToolbarButton label={t('terminal.browser.newTab')} disabled={!ready} onClick={() => void browser.command({ type: 'new-tab' })}><Plus size={14} /></ToolbarButton>
      </div>
      <div className="flex min-w-0 items-center gap-0.5 px-1.5 py-1">
        <ToolbarButton label={t('terminal.browser.back')} disabled={!connected || !active?.canGoBack} onClick={() => void browser.command({ type: 'back' })}><ArrowLeft size={14} /></ToolbarButton>
        <ToolbarButton label={t('terminal.browser.forward')} disabled={!connected || !active?.canGoForward} onClick={() => void browser.command({ type: 'forward' })}><ArrowRight size={14} /></ToolbarButton>
        <ToolbarButton label={t(active?.loading ? 'terminal.browser.stop' : 'terminal.browser.reload')} disabled={!connected || !active?.url} onClick={() => void browser.command({ type: active?.loading ? 'stop' : 'reload' })}>{active?.loading ? <Square size={12} /> : <RotateCw size={14} />}</ToolbarButton>
        <form className="mx-1 min-w-0 flex-1" onSubmit={(event) => { event.preventDefault(); navigate(address); addressRef.current?.blur(); }}><Input ref={addressRef} aria-label={t('terminal.browser.address')} placeholder={t('terminal.browser.address')} value={address} onChange={(event) => setAddress(event.target.value)} autoComplete="off" spellCheck={false} className="h-7 min-w-0 rounded-md border-border/50 bg-secondary/35 px-2 text-xs" /></form>
        <ToolbarButton label={t('terminal.browser.bookmarks')} aria-pressed={bookmarksOpen} className={bookmarksOpen ? 'bg-secondary/70 text-foreground' : ''} onClick={() => { setBookmarksOpen((value) => !value); setDownloadsOpen(false); }}><Bookmark size={14} /></ToolbarButton>
        <Popover open={downloadsOpen} onOpenChange={setDownloadsOpen}><Tooltip><TooltipTrigger asChild><PopoverTrigger asChild><button type="button" aria-label={t('terminal.browser.downloads')} className="relative grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-secondary/70 hover:text-foreground"><Download size={14} />{browser.downloads.some((item) => ['waiting', 'progressing'].includes(item.status)) && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" />}</button></PopoverTrigger></TooltipTrigger><TooltipContent side="top">{t('terminal.browser.downloads')}</TooltipContent></Tooltip><PopoverContent align="end" className="w-[min(380px,calc(100vw-24px))] p-0"><BrowserDownloads items={browser.downloads} command={browser.downloadCommand} /></PopoverContent></Popover>
      </div>
    </div>
    {error && <div role="status" className="flex shrink-0 items-center gap-2 border-b border-border/50 px-3 py-2 text-xs text-muted-foreground"><span className="min-w-0 flex-1">{error}</span>{mountError ? <Button size="sm" variant="ghost" onClick={retry}>{t('terminal.browser.retry')}</Button> : <button type="button" aria-label={t('common.close')} onClick={browser.dismissError}><X size={13} /></button>}</div>}
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div ref={elementRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden" data-section="host-browser-panel" data-browser-host-id={props.host.id}>
        {snapshot.map((layer, index) => <img key={index} src={layer.image} alt="" aria-hidden="true" draggable={false} className="absolute pointer-events-none select-none" style={{ left: layer.bounds.x, top: layer.bounds.y, width: layer.bounds.width, height: layer.bounds.height }} />)}
        {!connected ? <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-xs text-muted-foreground"><p>{t(browser.state?.route === 'disconnected' ? 'terminal.browser.disconnected' : 'terminal.browser.connecting')}</p>{browser.state?.error && <p>{browser.state.error}</p>}{browser.state?.route === 'disconnected' && <Button size="sm" variant="secondary" onClick={() => void browser.command({ type: 'retry' })}>{t('terminal.browser.retry')}</Button>}</div>
          : !active?.url && <div className="h-full overflow-y-auto p-4"><div className="mb-3 flex items-center justify-between gap-2 text-xs text-muted-foreground"><span>{t('terminal.browser.bookmarks')}</span><Button size="sm" variant="ghost" className="h-7 text-xs" onClick={newBookmark}><Plus size={12} className="mr-1" />{t('terminal.browser.addBookmark')}</Button></div>{!browser.bookmarks.length ? <p className="py-8 text-center text-xs text-muted-foreground">{t('terminal.browser.empty')}</p> : <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-1">{browser.bookmarks.map((item) => <button type="button" key={item.id} title={item.url} className="flex min-w-0 flex-col items-center gap-2 rounded-lg p-3 hover:bg-secondary/50" onClick={() => navigate(item.url)}><BrowserIcon className="h-9 w-9 rounded-lg bg-secondary/60 p-1.5" image={item.iconMode === 'custom' ? item.iconDataUrl : item.siteIconDataUrl} glyph={item.iconMode === 'custom' ? item.icon : item.siteIconGlyph || item.icon} color={item.color} /><span className="w-full truncate text-xs">{item.title}</span></button>)}</div>}</div>}
      </div>
      {bookmarksOpen && <aside className="flex w-[380px] max-w-full shrink-0 flex-col border-l border-border/50 bg-background" aria-label={t('terminal.browser.bookmarks')}>
        <div className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-4 py-3"><span className="truncate text-sm font-semibold">{t(editingBookmark ? editingBookmark.id ? 'terminal.browser.editBookmark' : 'terminal.browser.addBookmark' : 'terminal.browser.bookmarks')}</span><div className="flex items-center gap-1">{!editingBookmark && <ToolbarButton label={t('terminal.browser.addBookmark')} onClick={newBookmark}><Plus size={13} /></ToolbarButton>}<ToolbarButton label={t('common.close')} onClick={() => setBookmarksOpen(false)}><X size={13} /></ToolbarButton></div></div>
        {editingBookmark ? <BrowserBookmarkEditor key={editingBookmark.id || 'new'} initial={editingBookmark} onSave={browser.mutateBookmark} onCancel={() => setEditingBookmark(null)} readIcon={browser.readIcon} /> : <div className="min-h-0 flex-1 overflow-y-auto p-1">{browser.bookmarks.map((item) => <div key={item.id} className="group flex min-w-0 items-center gap-2 rounded-md px-2 py-2 hover:bg-secondary/40"><BrowserIcon className="h-6 w-6 rounded" image={item.iconMode === 'custom' ? item.iconDataUrl : item.siteIconDataUrl} glyph={item.iconMode === 'custom' ? item.icon : item.siteIconGlyph || item.icon} color={item.color} /><button type="button" className="min-w-0 flex-1 text-left" onClick={() => navigate(item.url)}><p className="truncate text-xs">{item.title}</p><p className="truncate text-[11px] text-muted-foreground">{item.url}</p></button><ToolbarButton label={t('common.edit')} onClick={() => setEditingBookmark(item)}><Edit2 size={12} /></ToolbarButton><ToolbarButton label={t('common.delete')} onClick={() => void browser.mutateBookmark(item.id)}><Trash2 size={12} /></ToolbarButton></div>)}</div>}
      </aside>}
    </div>
    {editingIcon && <BrowserTabIconEditor key={editingIcon.id} tab={editingIcon} readIcon={browser.readIcon} onClose={() => setEditingIcon(null)} onSave={async (values) => { const saved = await browser.command({ type: 'set-icon', tabId: editingIcon.id, ...values }); if (saved) setEditingIcon(null); }} />}
  </div>;
}

function BrowserTabIconEditor({ tab, readIcon, onClose, onSave }: { tab: HostBrowserTab; readIcon: (file: File) => Promise<string | null>; onClose: () => void; onSave: (values: { glyph: string; color: string; dataUrl?: string | null }) => Promise<void> }) {
  const { t } = useI18n();
  const [icon, setIcon] = useState<BrowserIconSelection>({ mode: tab.iconDataUrl ? 'image' : 'text', glyph: tab.iconGlyph || '', color: tab.iconColor || '#247969', image: tab.iconDataUrl });
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="max-w-sm">
      <DialogTitle>{t('terminal.browser.changeIcon')}</DialogTitle>
      <form className="space-y-4" onSubmit={async (event) => {
        event.preventDefault(); setSaving(true);
        try { await onSave({ glyph: icon.mode === 'text' ? icon.glyph : '', color: icon.color, dataUrl: icon.mode === 'image' ? icon.image : null }); }
        finally { setSaving(false); }
      }}>
        <div className="flex min-w-0 items-center gap-3">
          <BrowserIcon className="h-12 w-12 rounded-xl border border-border/50 bg-muted/40 p-2.5 [&>span]:text-lg" image={icon.mode === 'image' ? icon.image : null} glyph={icon.mode === 'text' ? icon.glyph : null} color={icon.color} />
          <p className="min-w-0 truncate text-sm font-medium">{tab.title || tab.url}</p>
        </div>
        <BrowserIconEditor value={icon} onChange={(changes) => setIcon((current) => ({ ...current, ...changes }))} readIcon={readIcon} onBusyChange={setReading} allowWebsite={false} />
        <div className="flex justify-end gap-2 border-t border-border/50 pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={saving || reading || (icon.mode === 'image' ? !icon.image : !icon.glyph.trim())}>{t('common.save')}</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}
