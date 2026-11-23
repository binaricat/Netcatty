import { useState } from 'react';
import { Github } from 'lucide-react';
import { usePluginGitHubInstall } from '../../../application/state/usePluginGitHubInstall';
import { useI18n } from '../../../application/i18n/I18nProvider';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../../ui/dialog';
import { PluginPackageDetails } from './PluginPackageManager';
import { describePluginGitHubInstallError } from '../../../domain/pluginGitHubInstallError';

export function PluginGitHubInstall({ disabled, onInstalled }: { disabled: boolean; onInstalled: () => Promise<unknown> }) {
  const { t, resolvedLocale } = useI18n();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [accepted, setAccepted] = useState(false);
  const flow = usePluginGitHubInstall(async () => { await onInstalled(); setOpen(false); });
  const preview = flow.preview;
  const error = flow.error ? describePluginGitHubInstallError(flow.error) : null;
  return <Dialog open={open} onOpenChange={(next) => {
    if (flow.busy) return;
    setOpen(next); flow.reset(); setAccepted(false); setInput('');
  }}>
    <DialogTrigger asChild><Button variant="outline" size="sm" disabled={disabled}><Github size={14} className="mr-2" />{t('settings.plugins.github.install')}</Button></DialogTrigger>
    <DialogContent hideCloseButton={flow.busy} className="app-no-drag max-h-[85dvh] overflow-y-auto sm:max-w-xl" data-plugin-github-install="">
      <DialogHeader>
        <DialogTitle>{t('settings.plugins.github.install')}</DialogTitle>
        <DialogDescription>{t('settings.plugins.github.description')}</DialogDescription>
      </DialogHeader>
      <form className="space-y-4" aria-busy={flow.busy} onSubmit={(event) => { event.preventDefault(); if (!flow.busy && input.trim() && !preview) void flow.prepare(input); }}>
        <label className="block space-y-2 text-sm"><span>{t('settings.plugins.github.repository')}</span>
          <Input autoFocus value={input} disabled={flow.busy || Boolean(preview)} maxLength={512} placeholder="https://github.com/owner/repo" onChange={(event) => setInput(event.target.value)} />
        </label>
        <p className="text-xs text-muted-foreground">{t('settings.plugins.github.formats')}</p>
        {flow.busy && <p role="status" className="text-sm text-muted-foreground">{t('settings.plugins.github.busy')}</p>}
        {error && <div role="alert" className="break-words text-sm text-destructive">
          <p>{t(error.key, error.values)}</p>
          {error.details && <details className="mt-2 text-xs"><summary>{t('settings.plugins.github.error.details')}</summary><p className="whitespace-pre-wrap">{error.details}</p></details>}
        </div>}
        {preview && <div className="space-y-3" data-plugin-github-preview="">
          <p className="break-words text-sm font-medium">{preview.manifest.name} · {preview.manifest.version}</p>
          <div className="break-all rounded-md bg-muted/40 p-3 text-xs">
            <p>{preview.source.origin}</p><p>{preview.source.tag} · {preview.source.commit}</p>
            <p>{preview.assetName} · {preview.size.toLocaleString(resolvedLocale)} B</p>
          </div>
          <p className="text-xs text-muted-foreground">{t('settings.plugins.github.review')}</p>
          <PluginPackageDetails plugin={{ id: preview.manifest.id, enabled: false, activeVersion: preview.manifest.version, manifest: preview.manifest,
            archiveSha256: preview.archiveSha256, runtime: { status: 'stopped', kind: null, lastError: null, quarantinedAt: null } }} />
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={accepted} disabled={flow.busy} onChange={(event) => setAccepted(event.target.checked)} className="mt-1" />{t('settings.plugins.github.accept')}</label>
        </div>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={flow.busy} onClick={() => { if (preview) { flow.reset(); setAccepted(false); } else setOpen(false); }}>{t(preview ? 'common.back' : 'common.cancel')}</Button>
          {preview ? <Button type="button" disabled={flow.busy || !accepted} onClick={() => { setAccepted(false); void flow.install(); }}>{t('settings.plugins.github.confirm')}</Button>
            : <Button type="submit" disabled={flow.busy || !input.trim()}>{t('settings.plugins.github.download')}</Button>}
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
