import React, { useId, useState } from 'react';
import { Check, Globe, Loader2, Monitor } from 'lucide-react';
import type { BrowserBookmark } from '../../domain/browserBookmark';
import type { HostBrowserBookmark } from '../../domain/hostBrowser';
import { useI18n } from '../../application/i18n/I18nProvider';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { AsidePanelContent, AsidePanelFooter } from '../ui/aside-panel';
import { BrowserIcon } from './BrowserIcon';
import { BrowserIconEditor, type BrowserIconSelection } from './BrowserIconEditor';

export function BrowserBookmarkEditor({ initial, onSave, onCancel, readIcon }: {
  initial: Partial<HostBrowserBookmark>;
  onSave: (bookmark: Partial<BrowserBookmark>) => Promise<boolean>;
  onCancel: () => void;
  readIcon: (file: File) => Promise<string | null>;
}) {
  const { t } = useI18n();
  const id = useId();
  const [draft, setDraft] = useState(initial);
  const [icon, setIcon] = useState<BrowserIconSelection>({
    mode: initial.iconDataUrl ? 'image' : initial.iconMode === 'custom' ? 'text' : 'website',
    glyph: initial.icon || '', color: initial.color || '#247969', image: initial.iconDataUrl || null,
  });
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const invalidIcon = reading || (icon.mode === 'image' && !icon.image);
  const previewImage = icon.mode === 'image' ? icon.image : icon.mode === 'website' ? initial.siteIconDataUrl : null;
  const previewGlyph = icon.mode === 'text' ? icon.glyph || draft.title?.trim().slice(0, 1) : icon.mode === 'website' ? initial.siteIconGlyph : null;
  let addressHint = t('terminal.browser.bookmarkPreviewHint');
  try { if (draft.url) addressHint = new URL(draft.url).host; } catch { /* Keep the hint while an address is being typed. */ }

  return <form className="flex min-h-0 flex-1 flex-col" data-section="browser-bookmark-editor" onSubmit={async (event) => {
    event.preventDefault();
    if (invalidIcon || saving) return;
    setSaving(true);
    try {
      const saved = await onSave({ ...draft, title: draft.title?.trim(), url: draft.url?.trim(),
        color: icon.color, iconMode: icon.mode === 'website' ? 'auto' : 'custom',
        iconDataUrl: icon.mode === 'image' ? icon.image : null, icon: icon.mode === 'text' ? icon.glyph : '' });
      if (saved) onCancel();
    } finally { setSaving(false); }
  }}>
    <AsidePanelContent className="min-h-0">
      <div className="flex min-w-0 items-center gap-3 border-b border-border/40 pb-4" data-section="bookmark-preview">
        <BrowserIcon className="h-12 w-12 rounded-xl border border-border/50 bg-muted/40 p-2.5 [&>span]:text-lg [&>svg]:h-5 [&>svg]:w-5" image={previewImage} glyph={previewGlyph} color={icon.mode === 'website' ? initial.siteIconColor : icon.color} />
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{draft.title?.trim() || t('terminal.browser.untitledBookmark')}</p><p className="mt-1 truncate text-xs text-muted-foreground">{addressHint}</p></div>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-title`} className="text-xs text-muted-foreground">{t('terminal.browser.bookmarkTitle')}</Label>
        <Input id={`${id}-title`} autoFocus required maxLength={120} className="h-9" placeholder={t('terminal.browser.bookmarkTitlePlaceholder')} value={draft.title || ''} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-url`} className="text-xs text-muted-foreground">{t('terminal.browser.websiteAddress')}</Label>
        <Input id={`${id}-url`} required type="url" className="h-9" placeholder="https://example.com" spellCheck={false} autoComplete="off" value={draft.url || ''} onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))} />
      </div>
      <div className="space-y-2.5">
        <p className="text-xs font-medium text-muted-foreground">{t('terminal.browser.icon')}</p>
        <BrowserIconEditor value={icon} onChange={(changes) => setIcon((current) => ({ ...current, ...changes }))} readIcon={readIcon} onBusyChange={setReading} />
      </div>
      <fieldset className="min-w-0 space-y-2.5">
        <legend className="mb-2.5 text-xs font-medium text-muted-foreground">{t('terminal.browser.scope')}</legend>
        {(['host', 'all-hosts'] as const).map((scope) => {
          const selected = (draft.scope || 'host') === scope;
          const Icon = scope === 'host' ? Monitor : Globe;
          return <label key={scope} className={cn('relative flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors focus-within:ring-1 focus-within:ring-ring', selected ? 'border-primary/35 bg-primary/5' : 'border-border/50 hover:bg-muted/30')}>
            <input type="radio" name={`${id}-scope`} value={scope} checked={selected} onChange={() => setDraft((current) => ({ ...current, scope }))} className="sr-only" />
            <Icon size={15} className={cn('shrink-0', selected ? 'text-primary' : 'text-muted-foreground')} />
            <span className="min-w-0 flex-1"><span className="block text-xs font-medium">{t(scope === 'host' ? 'terminal.browser.hostScope' : 'terminal.browser.allScope')}</span><span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">{t(scope === 'host' ? 'terminal.browser.hostScopeHint' : 'terminal.browser.allScopeHint')}</span></span>
            <span className={cn('grid h-4 w-4 shrink-0 place-items-center rounded-full border', selected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40')}>{selected && <Check size={10} />}</span>
          </label>;
        })}
      </fieldset>
    </AsidePanelContent>
    <AsidePanelFooter className="flex justify-end gap-2">
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>{t('common.cancel')}</Button>
      <Button type="submit" size="sm" className="min-w-24" disabled={saving || invalidIcon}>{saving && <Loader2 size={13} className="mr-1.5 animate-spin" />}{t(initial.id ? 'common.save' : 'terminal.browser.addBookmark')}</Button>
    </AsidePanelFooter>
  </form>;
}
