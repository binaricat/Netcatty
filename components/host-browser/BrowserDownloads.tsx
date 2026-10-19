import React from 'react';
import { File, FolderOpen, MoreHorizontal, X } from 'lucide-react';
import type { HostBrowserDownload } from '../../domain/hostBrowser';
import type { useHostBrowserControls } from '../../application/state/useHostBrowserControls';
import { useI18n } from '../../application/i18n/I18nProvider';
import { Button } from '../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

function size(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = bytes > 0 ? Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024))) : 0;
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

export function BrowserDownloads({ items, command }: { items: HostBrowserDownload[]; command: ReturnType<typeof useHostBrowserControls>['downloadCommand'] }) {
  const { t } = useI18n();
  return <div className="min-w-0">
    <div className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-2"><div className="min-w-0"><p className="text-xs font-medium">{t('terminal.browser.downloads')}</p><p className="mt-1 text-[11px] text-muted-foreground">{t('terminal.browser.downloadLocation')}</p></div><Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" aria-label={t('terminal.browser.openFolder')} title={t('terminal.browser.openFolder')} onClick={() => void command('open-folder')}><FolderOpen size={14} /></Button></div>
    <div className="max-h-80 overflow-y-auto p-1">
      {!items.length && <p className="px-3 py-8 text-center text-xs text-muted-foreground">{t('terminal.browser.downloadEmpty')}</p>}
      {items.map((item) => {
        const running = item.status === 'waiting' || item.status === 'progressing';
        const canOpen = item.status === 'completed' && !item.missing;
        return <div key={item.id} data-download-id={item.id} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-2 hover:bg-secondary/50">
          <File size={16} className="shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="truncate text-xs" title={item.filename}>{item.filename}</p><p className="mt-0.5 text-[11px] text-muted-foreground">{t(`terminal.browser.${item.missing ? 'missing' : item.status}`)}{item.status === 'progressing' ? ` · ${size(item.received)}${item.total ? ` / ${size(item.total)}` : ''}` : item.status === 'completed' ? ` · ${size(item.total || item.received)}` : ''}</p>
          {item.status === 'progressing' && <div className="mt-1 h-1 overflow-hidden rounded bg-secondary"><div className={`h-full bg-primary${item.total ? '' : ' animate-pulse'}`} style={{ width: `${item.total ? Math.min(100, item.received * 100 / item.total) : 20}%` }} /></div>}</div>
          {running ? <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" aria-label={t('terminal.browser.cancelDownload')} title={t('terminal.browser.cancelDownload')} onClick={() => void command('cancel', item.id)}><X size={13} /></Button>
            : canOpen ? <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" title={t('terminal.browser.reveal')} onClick={() => void command('reveal', item.id)}><FolderOpen size={13} /></Button> : null}
          <Popover><PopoverTrigger asChild><Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" aria-label={t('terminal.browser.more')}><MoreHorizontal size={13} /></Button></PopoverTrigger><PopoverContent align="end" className="w-40 p-1">
            {canOpen && <Button variant="ghost" size="sm" className="w-full justify-start text-xs" onClick={() => void command('open', item.id)}>{t('terminal.browser.openFile')}</Button>}
            {canOpen && <Button variant="ghost" size="sm" className="w-full justify-start text-xs" onClick={() => void command('save-as', item.id)}>{t('terminal.browser.saveAs')}</Button>}
            {canOpen && <Button variant="ghost" size="sm" className="w-full justify-start text-xs" onClick={() => void command('reveal', item.id)}>{t('terminal.browser.reveal')}</Button>}
            {!running && <Button variant="ghost" size="sm" className="w-full justify-start text-xs" onClick={() => void command('remove', item.id)}>{t('terminal.browser.removeDownload')}</Button>}
            {running && <Button variant="ghost" size="sm" className="w-full justify-start text-xs" onClick={() => void command('cancel', item.id)}>{t('terminal.browser.cancelDownload')}</Button>}
          </PopoverContent></Popover>
        </div>;
      })}
    </div>
    {items.some((item) => !['waiting', 'progressing'].includes(item.status)) && <div className="border-t border-border/50 p-1"><Button variant="ghost" size="sm" className="w-full text-xs" onClick={() => void command('clear')}>{t('terminal.browser.clearDownloads')}</Button></div>}
  </div>;
}
