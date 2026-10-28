import React, { useState } from 'react';
import { Globe, HardDrive, Store } from 'lucide-react';
import { usePluginAuthorIdentity } from '../../application/state/usePluginAuthorIdentity';
import { useI18n } from '../../application/i18n/I18nProvider';
import { Badge } from '../ui/badge';

export function PluginAuthorRow({ entry, plugin, sourceId, showSource = false }: {
  entry?: NetcattyPluginCatalogEntry; plugin?: NetcattyInstalledPlugin; sourceId?: string; showSource?: boolean;
}) {
  const { t } = useI18n();
  const { ref, identity } = usePluginAuthorIdentity({ entry, plugin, sourceId });
  const [failed, setFailed] = useState<string | null>(null);
  const author = identity?.author ?? entry?.author ?? plugin?.manifest?.publisher ?? '';
  const imageKey = JSON.stringify([entry?.id, entry?.selectionToken, plugin?.id, plugin?.activeVersion, plugin?.archiveSha256, sourceId, identity?.avatar]);
  const avatar = identity?.avatar;
  const showImage = avatar && avatar.length <= 700_000 && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar) && failed !== imageKey;
  const source = plugin?.source;
  const sourceKey = source?.kind === 'third-party' ? 'thirdparty' : source?.kind === 'official' || source?.kind === 'local' ? source.kind : undefined;
  const sourceLabel = t(sourceKey ? `settings.plugins.sources.short.${sourceKey}` : 'settings.plugins.landing.sourceUnknown');
  const sourceDescription = sourceKey
    ? [t(`settings.plugins.sources.${sourceKey}`), source?.name, source?.origin].filter(Boolean).join(' · ')
    : sourceLabel;
  const SourceIcon = source?.kind === 'local' ? HardDrive : source?.kind === 'official' ? Store : Globe;
  return <div ref={ref} className="flex min-w-0 items-center gap-3 overflow-hidden text-xs text-muted-foreground" data-plugin-author-row>
    {(author || showImage || identity?.officialMaintained === true) && <span data-plugin-author className="inline-flex min-w-0 items-center gap-1.5 overflow-hidden">
      {showImage && <img src={avatar} alt="" width={16} height={16} className="h-4 w-4 shrink-0 rounded-full object-cover" onError={() => setFailed(imageKey)} />}
      {author && <span className="min-w-0 truncate" title={author}>{author}</span>}
      {identity?.officialMaintained === true && <Badge className="shrink-0 whitespace-nowrap border-0 bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-800 hover:bg-amber-500/15 dark:bg-amber-400/15 dark:text-amber-300 dark:hover:bg-amber-400/15"
        title={t('settings.plugins.author.officialMeaning')} data-plugin-official-maintainer>{t('settings.plugins.author.official')}</Badge>}
    </span>}
    {showSource && <span data-plugin-source className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap" title={sourceDescription} aria-label={sourceDescription}>
      <SourceIcon size={12} aria-hidden="true" />{sourceLabel}
    </span>}
  </div>;
}
