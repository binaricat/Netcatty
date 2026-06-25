import { ChevronRight } from 'lucide-react';
import React from 'react';
import { useI18n } from '../../../application/i18n/I18nProvider';
import { cn } from '../../../lib/utils';
import type { VaultToolArtifact } from './vaultToolArtifact';
import { navigateVaultArtifact, useVaultArtifactNavigation } from './VaultArtifactNavigationContext';
import { VaultArtifactIcon } from './vaultArtifactPresentation';

interface VaultArtifactCardProps {
  artifact: VaultToolArtifact;
  toolName?: string;
  className?: string;
}

function getArtifactPresentation(
  artifact: VaultToolArtifact,
  t: (key: string, values?: Record<string, unknown>) => string,
): {
  title: string;
  subtitle?: string;
  clickable: boolean;
} {
  switch (artifact.kind) {
    case 'vault.note':
      return {
        title: artifact.title,
        subtitle: artifact.group ?? t('ai.chat.artifact.noteFallback'),
        clickable: true,
      };
    case 'vault.host':
      return {
        title: artifact.label,
        subtitle: artifact.port
          ? `${artifact.hostname}:${artifact.port}`
          : artifact.hostname,
        clickable: true,
      };
    case 'vault.hosts.batch': {
      const preview = artifact.preview
        .slice(0, 2)
        .map((host) => host.label || host.hostname)
        .filter(Boolean)
        .join(', ');
      return {
        title: artifact.dryRun
          ? t('ai.chat.artifact.hostsPreview', { count: artifact.addedCount })
          : t('ai.chat.artifact.hostsAdded', { count: artifact.addedCount }),
        subtitle: preview || t('ai.chat.artifact.openHosts'),
        clickable: true,
      };
    }
    case 'vault.summary':
      return {
        title: artifact.section === 'notes'
          ? t('ai.chat.artifact.notesSummary', { count: artifact.count })
          : t('ai.chat.artifact.hostsSummary', { count: artifact.count }),
        subtitle: artifact.section === 'notes'
          ? t('ai.chat.artifact.openNotes')
          : t('ai.chat.artifact.openHosts'),
        clickable: true,
      };
    case 'error':
      return {
        title: t('ai.chat.artifact.failed'),
        subtitle: artifact.message,
        clickable: false,
      };
    default:
      return {
        title: '',
        clickable: false,
      };
  }
}

export const VaultArtifactCard: React.FC<VaultArtifactCardProps> = ({
  artifact,
  toolName,
  className,
}) => {
  const { t } = useI18n();
  const navigation = useVaultArtifactNavigation();
  const presentation = getArtifactPresentation(artifact, t);

  const handleClick = () => {
    if (!presentation.clickable || !navigation) return;
    navigateVaultArtifact(artifact, navigation);
  };

  const content = (
    <>
      <VaultArtifactIcon artifact={artifact} toolName={toolName} />
      <div className="min-w-0 flex-1 text-left">
        <div className="truncate text-[12px] font-medium text-foreground/85">
          {presentation.title}
        </div>
        {presentation.subtitle && (
          <div className="truncate text-[11px] text-muted-foreground/60">
            {presentation.subtitle}
          </div>
        )}
      </div>
      {presentation.clickable && (
        <ChevronRight size={12} className="shrink-0 text-muted-foreground/40" />
      )}
    </>
  );

  if (!presentation.clickable) {
    return (
      <div className={cn('flex items-center gap-2 px-1 py-0.5', className)}>
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md border border-border/25 bg-muted/10 px-2.5 py-2',
        'text-left transition-colors hover:bg-muted/20',
        className,
      )}
    >
      {content}
    </button>
  );
};
