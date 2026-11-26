import {
  AlertCircle,
  CheckCircle2,
  ChevronsUpDown,
  Hand,
  Keyboard,
  Monitor,
  MonitorCog,
  MousePointerClick,
  Move,
  ScanSearch,
  Timer,
} from 'lucide-react';
import React from 'react';
import { useI18n } from '../../../application/i18n/I18nProvider';
import { getCapturedRemoteDesktopFrame } from '../../../infrastructure/remoteDesktop/remoteDesktopSnapshotRegistry';
import { cn } from '../../../lib/utils';
import type {
  RemoteDesktopActionVisualKind,
  RemoteDesktopToolArtifact,
} from './remoteDesktopToolArtifact';

interface RemoteDesktopArtifactCardProps extends React.HTMLAttributes<HTMLDivElement> {
  artifact: RemoteDesktopToolArtifact;
  onOpenImagePreview?: (src: string, name: string) => void;
  className?: string;
}

const ACTION_ICON_SIZE = 16;

const ACTION_VISUAL_STYLES: Record<RemoteDesktopActionVisualKind, { wrapper: string; icon: string }> = {
  click: { wrapper: 'bg-violet-500/12', icon: 'text-violet-400' },
  drag: { wrapper: 'bg-violet-500/12', icon: 'text-violet-400' },
  scroll: { wrapper: 'bg-cyan-500/12', icon: 'text-cyan-400' },
  keyboard: { wrapper: 'bg-amber-500/12', icon: 'text-amber-400' },
  wait: { wrapper: 'bg-muted/30', icon: 'text-muted-foreground/70' },
  mixed: { wrapper: 'bg-violet-500/12', icon: 'text-violet-400' },
};

function renderActionIcon(kind: RemoteDesktopActionVisualKind): React.ReactNode {
  const iconClass = ACTION_VISUAL_STYLES[kind].icon;
  switch (kind) {
    case 'click':
      return <MousePointerClick size={ACTION_ICON_SIZE} className={iconClass} />;
    case 'drag':
      return <Move size={ACTION_ICON_SIZE} className={iconClass} />;
    case 'scroll':
      return <ChevronsUpDown size={ACTION_ICON_SIZE} className={iconClass} />;
    case 'keyboard':
      return <Keyboard size={ACTION_ICON_SIZE} className={iconClass} />;
    case 'wait':
      return <Timer size={ACTION_ICON_SIZE} className={iconClass} />;
    case 'mixed':
      return <MonitorCog size={ACTION_ICON_SIZE} className={iconClass} />;
  }
}

function resolveCachedFramePreview(captureId?: string): { thumbSrc: string; fullSrc: string } | null {
  if (!captureId) return null;
  const frame = getCapturedRemoteDesktopFrame(captureId);
  if (!frame || !frame.base64Data) return null;
  const fullSrc = `data:${frame.mediaType};base64,${frame.base64Data}`;
  const thumbSrc = frame.previewDataUrl || fullSrc;
  return { thumbSrc, fullSrc };
}

export const RemoteDesktopArtifactCard = React.forwardRef<HTMLDivElement, RemoteDesktopArtifactCardProps>(({
  artifact,
  onOpenImagePreview,
  className,
  ...props
}, ref) => {
  const { t } = useI18n();

  if (artifact.kind === 'error') {
    const isPreempted = artifact.code === 'USER_PREEMPTED';
    const errorTitle = isPreempted
      ? t('ai.chat.artifact.rdActionPreempted')
      : artifact.toolKind === 'screen'
        ? t('ai.chat.artifact.rdScreenFailed')
        : t('ai.chat.artifact.rdActionFailed');

    return (
      <div
        {...props}
        ref={ref}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-md border px-2.5 py-2',
          isPreempted
            ? 'border-amber-500/25 bg-amber-500/5'
            : 'border-destructive/25 bg-destructive/5',
          className,
        )}
      >
        <div
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
            isPreempted
              ? 'bg-amber-500/12 text-amber-400'
              : 'bg-destructive/10 text-destructive',
          )}
        >
          {isPreempted ? <Hand size={ACTION_ICON_SIZE} /> : <AlertCircle size={ACTION_ICON_SIZE} />}
        </div>
        <div className="min-w-0 flex-1 text-left">
          <div className="truncate text-[12px] font-medium text-foreground/85">
            {errorTitle}
          </div>
          <div className="truncate text-[11px] text-muted-foreground/60">
            {artifact.message}
          </div>
        </div>
      </div>
    );
  }

  const cachedPreview = resolveCachedFramePreview(artifact.captureId);
  const hostDisplay = artifact.hostLabel || artifact.hostname || artifact.sessionId;
  const protocolBadge = artifact.protocol ? artifact.protocol.toUpperCase() : null;

  if (artifact.kind === 'remoteDesktop.screen') {
    const isCropped = Boolean(artifact.crop);
    const title = isCropped
      ? t('ai.chat.artifact.rdScreenCropped')
      : artifact.grid
        ? t('ai.chat.artifact.rdScreenGrid')
        : t('ai.chat.artifact.rdScreenRead');
    const subtitleParts = [
      hostDisplay,
      protocolBadge,
      `${artifact.width}×${artifact.height}`,
      artifact.crop ? `${artifact.crop.width}×${artifact.crop.height}` : null,
    ].filter(Boolean);

    return (
      <div
        {...props}
        ref={ref}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-md border border-border/25 bg-muted/10 px-2.5 py-2',
          className,
        )}
      >
        <div
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
            isCropped
              ? 'bg-indigo-500/12 text-indigo-400'
              : 'bg-sky-500/12 text-sky-400',
          )}
        >
          {isCropped ? <ScanSearch size={ACTION_ICON_SIZE} /> : <Monitor size={ACTION_ICON_SIZE} />}
        </div>
        <div className="min-w-0 flex-1 text-left">
          <div className="truncate text-[12px] font-medium text-foreground/85">
            {title}
          </div>
          <div className="truncate text-[11px] text-muted-foreground/60">
            {subtitleParts.join(' · ')}
          </div>
        </div>
        {cachedPreview && onOpenImagePreview && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenImagePreview(cachedPreview.fullSrc, `${hostDisplay} (${artifact.width}×${artifact.height})`);
            }}
            className="shrink-0 overflow-hidden rounded border border-border/35 bg-background/40 hover:opacity-85 transition-opacity cursor-pointer"
            title={t('ai.chat.artifact.rdPreviewScreen')}
            aria-label={t('ai.chat.artifact.rdPreviewScreen')}
          >
            <img
              src={cachedPreview.thumbSrc}
              alt={title}
              className="h-7 w-11 object-cover block"
            />
          </button>
        )}
        <CheckCircle2 size={12} className="shrink-0 text-green-400/70" />
      </div>
    );
  }

  const title = artifact.summary || t('ai.chat.artifact.rdActionExecuted', { count: artifact.completedActions });
  const styles = ACTION_VISUAL_STYLES[artifact.actionVisualKind];
  const subtitleParts = [
    hostDisplay,
    protocolBadge,
    artifact.totalActions > 1
      ? t('ai.chat.artifact.rdActionCount', { count: artifact.completedActions })
      : null,
    artifact.durationMs != null ? `${artifact.durationMs}ms` : null,
  ].filter(Boolean);

  return (
    <div
      {...props}
      ref={ref}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md border border-border/25 bg-muted/10 px-2.5 py-2',
        className,
      )}
    >
      <div
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
          styles.wrapper,
        )}
      >
        {renderActionIcon(artifact.actionVisualKind)}
      </div>
      <div className="min-w-0 flex-1 text-left">
        <div className="truncate text-[12px] font-medium text-foreground/85">
          {title}
        </div>
        <div className="truncate text-[11px] text-muted-foreground/60">
          {subtitleParts.join(' · ')}
        </div>
      </div>
      {cachedPreview && onOpenImagePreview && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenImagePreview(cachedPreview.fullSrc, `${hostDisplay} · ${title}`);
          }}
          className="shrink-0 overflow-hidden rounded border border-border/35 bg-background/40 hover:opacity-85 transition-opacity cursor-pointer"
          title={t('ai.chat.artifact.rdPreviewScreen')}
          aria-label={t('ai.chat.artifact.rdPreviewScreen')}
        >
          <img
            src={cachedPreview.thumbSrc}
            alt={title}
            className="h-7 w-11 object-cover block"
          />
        </button>
      )}
      <CheckCircle2 size={12} className="shrink-0 text-green-400/70" />
    </div>
  );
});
RemoteDesktopArtifactCard.displayName = 'RemoteDesktopArtifactCard';
