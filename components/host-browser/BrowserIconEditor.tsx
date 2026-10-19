import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, Globe, ImagePlus, Loader2, Pipette, Type, Upload, X } from 'lucide-react';
import { HostBrowserIconError } from '../../domain/hostBrowser';
import { useI18n } from '../../application/i18n/I18nProvider';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

export interface BrowserIconSelection {
  mode: 'website' | 'text' | 'image';
  glyph: string;
  color: string;
  image: string | null;
}

const COLORS = ['#247969', '#2563eb', '#7c3aed', '#c026d3', '#e11d48', '#ea580c', '#ca8a04', '#64748b'];
const MODES = [{ value: 'website', Icon: Globe }, { value: 'text', Icon: Type }, { value: 'image', Icon: ImagePlus }] as const;

export function BrowserIconEditor({ value, onChange, readIcon, onBusyChange, allowWebsite = true }: {
  value: BrowserIconSelection;
  onChange: (changes: Partial<BrowserIconSelection>) => void;
  readIcon: (file: File) => Promise<string | null>;
  onBusyChange: (busy: boolean) => void;
  allowWebsite?: boolean;
}) {
  const { t } = useI18n();
  const inputId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const readRevision = useRef(0);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [filename, setFilename] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => { readRevision.current++; }, []);

  const selectFile = async (file?: File) => {
    if (!file) return;
    const revision = ++readRevision.current;
    setError(null); setBusy(true); onBusyChange(true);
    try {
      const image = await readIcon(file);
      if (revision !== readRevision.current) return;
      if (!image) throw new HostBrowserIconError('decode');
      onChange({ image }); setFilename(file.name);
    } catch (reason) {
      if (revision === readRevision.current) {
        const key = reason instanceof HostBrowserIconError ? reason.reason : 'decode';
        setError(t(`terminal.browser.iconError.${key}`));
      }
    } finally {
      if (revision === readRevision.current) { setBusy(false); onBusyChange(false); }
    }
  };

  return <div className="space-y-3" data-section="browser-icon-editor">
    <div className="grid grid-flow-col auto-cols-fr gap-1 rounded-md bg-muted/50 p-1" role="group" aria-label={t('terminal.browser.icon')}>
      {MODES.filter((mode) => allowWebsite || mode.value !== 'website').map(({ value: mode, Icon }) => <button
        key={mode} type="button" aria-pressed={value.mode === mode} disabled={busy}
        className={cn('flex min-w-0 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50',
          value.mode === mode ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
        onClick={() => { onChange({ mode }); setError(null); }}>
        <Icon size={13} className="shrink-0" /><span className="truncate">{t(`terminal.browser.${mode}`)}</span>
      </button>)}
    </div>
    {value.mode === 'website' && <p className="text-xs leading-relaxed text-muted-foreground">{t('terminal.browser.websiteIconHint')}</p>}
    {value.mode === 'text' && <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Input id={inputId} aria-label={t('terminal.browser.iconText')} className="h-9 w-20 shrink-0 text-center text-base" maxLength={4} value={value.glyph}
          onChange={(event) => onChange({ glyph: event.target.value })} placeholder="A" />
        <Label htmlFor={inputId} className="text-xs font-normal leading-relaxed text-muted-foreground">{t('terminal.browser.iconTextHint')}</Label>
      </div>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('terminal.browser.color')}>
        {COLORS.map((color) => <button key={color} type="button" aria-label={t('terminal.browser.selectColor', { color })} aria-pressed={value.color.toLowerCase() === color}
          className={cn('grid h-6 w-6 place-items-center rounded-full border-2 border-background transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', value.color.toLowerCase() === color && 'ring-1 ring-foreground/40')}
          style={{ backgroundColor: color }} onClick={() => onChange({ color })}>
          {value.color.toLowerCase() === color && <Check size={12} className="text-white" />}
        </button>)}
        <label className="relative grid h-6 w-6 cursor-pointer place-items-center rounded-full border border-border text-muted-foreground hover:text-foreground focus-within:ring-1 focus-within:ring-ring" title={t('terminal.browser.customColor')}>
          <Pipette size={12} /><input aria-label={t('terminal.browser.customColor')} type="color" className="absolute inset-0 h-full w-full cursor-pointer opacity-0" value={value.color} onChange={(event) => onChange({ color: event.target.value })} />
        </label>
      </div>
    </div>}
    {value.mode === 'image' && <div className="space-y-2" onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(event) => { event.preventDefault(); setDragging(false); if (!busy) void selectFile(event.dataTransfer.files[0]); }}>
      <input ref={fileInput} type="file" className="hidden" aria-label={t('terminal.browser.chooseImage')}
        accept="image/png,image/jpeg,image/webp,image/gif,image/x-icon,image/vnd.microsoft.icon"
        onChange={(event) => { void selectFile(event.target.files?.[0]); event.target.value = ''; }} />
      {value.image ? <div className={cn('flex min-w-0 items-center gap-3 rounded-lg border border-border/60 bg-muted/20 p-3', dragging && 'border-primary bg-primary/5')}>
        <div className="grid h-12 w-12 shrink-0 place-items-center rounded-md border border-border/40 bg-background p-1.5"><img src={value.image} alt={t('terminal.browser.iconPreview')} className="h-full w-full rounded-[20%] object-contain" /></div>
        <div className="min-w-0 flex-1"><p className="truncate text-xs font-medium" title={filename}>{filename || t('terminal.browser.savedImage')}</p><Button type="button" variant="link" size="sm" className="h-auto px-0 py-1 text-xs" disabled={busy} onClick={() => fileInput.current?.click()}>{busy ? t('terminal.browser.processingImage') : t('terminal.browser.replaceImage')}</Button></div>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-muted-foreground" disabled={busy} aria-label={t('terminal.browser.removeImage')} onClick={() => { onChange({ image: null }); setFilename(''); setError(null); }}><X size={14} /></Button>
      </div> : <button type="button" disabled={busy} className={cn('flex w-full flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-muted/15 px-4 py-5 text-center transition-colors hover:border-primary/50 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring', dragging && 'border-primary bg-primary/5')}
        onClick={() => fileInput.current?.click()}>
        <span className="grid h-8 w-8 place-items-center rounded-full bg-secondary/70 text-muted-foreground">{busy ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}</span>
        <span className="text-xs font-medium">{t(busy ? 'terminal.browser.processingImage' : 'terminal.browser.uploadImage')}</span>
        <span className="text-[11px] leading-relaxed text-muted-foreground">{t('terminal.browser.dropImage')}</span>
      </button>}
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t('terminal.browser.imageHint')}</p>
    </div>}
    {error && <p role="alert" className="text-xs leading-relaxed text-destructive">{error}</p>}
  </div>;
}
