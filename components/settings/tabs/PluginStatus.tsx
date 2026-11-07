import React from 'react';
import { useI18n } from '../../../application/i18n/I18nProvider';
import { Button } from '../../ui/button';
import { PluginInfo } from './PluginInfo';

export function PluginStatus({ noVault, offlineError, retry, sourceKind }: { sourceKind?: NetcattyPluginSource['kind']; noVault?: boolean; offlineError?: string | null; retry?: () => void }) {
  const { t } = useI18n();
  const count = Number(Boolean(noVault)) + Number(Boolean(offlineError));
  const explanation = <>{noVault && <p>{t('settings.plugins.manager.noVault')}</p>}{offlineError && <><p>{t(sourceKind === 'third-party' ? 'settings.plugins.sources.offline' : 'settings.plugins.market.offline')}</p><p className="break-words">{offlineError}</p></>}</>;
  const label = count ? `${t('settings.plugins.info')} · ${t('settings.plugins.status', { count })}` : t('settings.plugins.info');
  const help = <><p>{t('settings.plugins.manager.preview')}</p><p>{t(sourceKind === 'third-party' ? 'settings.plugins.sources.note' : 'settings.plugins.market.note')}</p></>;
  const preview = <>{count > 0 && <p>{t('settings.plugins.status', { count })}</p>}{explanation}{help}</>;
  return <PluginInfo label={label} badgeCount={count} previewContent={preview}>{explanation}{offlineError && retry && <Button variant="outline" size="sm" onClick={retry}>{t('settings.plugins.market.retry')}</Button>}{count > 0 && <hr className="border-border/60" />}{help}</PluginInfo>;
}
