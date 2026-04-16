import React from 'react';
import { AlertTriangle } from 'lucide-react';
import type { ShrinkFinding } from '../../domain/syncGuards';
import { Button } from '../ui/button';
import { useI18n } from '../../application/i18n/I18nProvider';

interface Props {
  finding: Extract<ShrinkFinding, { suspicious: true }>;
  onRestore: () => void;
  onForcePush: () => void;
}

export const SyncBlockedBanner: React.FC<Props> = ({ finding, onRestore, onForcePush }) => {
  const { t } = useI18n();
  const entityLabel = t(`sync.entityType.${finding.entityType}`);
  const percent = finding.baseCount > 0 ? Math.round((finding.lost / finding.baseCount) * 100) : 0;

  const reasonText = finding.reason === 'bulk-shrink'
    ? t('sync.blocked.reason.bulkShrink', {
        lost: finding.lost,
        baseCount: finding.baseCount,
        entityType: entityLabel,
        percent,
      })
    : t('sync.blocked.reason.largeShrink', {
        lost: finding.lost,
        entityType: entityLabel,
      });

  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-4"
    >
      <div className="flex items-center gap-2 font-semibold">
        <AlertTriangle className="h-4 w-4 text-amber-500" />
        <span>{t('sync.blocked.title')}</span>
      </div>
      <p className="text-sm">{reasonText}</p>
      <p className="text-xs opacity-70">{t('sync.blocked.detail')}</p>
      <div className="flex gap-2">
        <Button variant="default" size="sm" onClick={onRestore}>
          {t('sync.blocked.restoreButton')}
        </Button>
        <Button variant="outline" size="sm" onClick={onForcePush}>
          {t('sync.blocked.forcePushButton')}
        </Button>
      </div>
    </div>
  );
};
