import React, { memo, useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import {
  buildContainerInspectView,
  buildImageInspectView,
} from '../../domain/systemManager/inspectView';
import { cn } from '../../lib/utils';

function InspectRow({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  if (!value) return null;
  return (
    <div className="flex gap-2 text-[10px] leading-relaxed">
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <span className={cn('flex-1 min-w-0 break-all text-foreground/90', mono && 'font-mono')}>
        {value}
      </span>
    </div>
  );
}

function InspectList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="text-[10px] leading-relaxed">
      <div className="text-muted-foreground mb-0.5">{label}</div>
      <div className="space-y-0.5 font-mono">
        {items.map((item, index) => (
          <div key={index} className="break-all text-foreground/90">{item}</div>
        ))}
      </div>
    </div>
  );
}

interface DockerInspectViewProps {
  kind: 'container' | 'image';
  data: Record<string, unknown>;
  onClose: () => void;
}

/** Structured rendering of docker inspect output, with a raw-JSON fallback toggle. */
export const DockerInspectView = memo(function DockerInspectView({
  kind,
  data,
  onClose,
}: DockerInspectViewProps) {
  const { t } = useI18n();
  const [showRaw, setShowRaw] = useState(false);

  const container = useMemo(
    () => (kind === 'container' ? buildContainerInspectView(data) : null),
    [kind, data],
  );
  const image = useMemo(
    () => (kind === 'image' ? buildImageInspectView(data) : null),
    [kind, data],
  );

  return (
    <div className="border-b border-border/40 bg-muted/20 px-3 py-2" data-section="docker-inspect">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-[11px] font-medium">
          {kind === 'container' ? t('systemManager.docker.inspect') : t('systemManager.docker.imageInspect')}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowRaw((v) => !v)}
            className="text-[10px] text-muted-foreground hover:text-foreground"
          >
            {showRaw ? t('systemManager.inspect.hideRaw') : t('systemManager.inspect.showRaw')}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-[10px] text-muted-foreground hover:text-foreground"
          >
            {t('systemManager.common.dismiss')}
          </button>
        </div>
      </div>

      {showRaw ? (
        <pre className="font-mono text-[10px] text-muted-foreground overflow-auto max-h-48 whitespace-pre-wrap break-all leading-relaxed">
          {JSON.stringify(data, null, 2)}
        </pre>
      ) : container ? (
        <div className="space-y-1.5">
          <InspectRow label="ID" value={container.id} mono />
          <InspectRow label={t('systemManager.inspect.status')} value={container.status} />
          <InspectRow label={t('systemManager.inspect.image')} value={container.image} mono />
          <InspectRow label={t('systemManager.inspect.created')} value={container.createdAt} />
          <InspectRow label={t('systemManager.inspect.started')} value={container.startedAt} />
          <InspectRow label={t('systemManager.inspect.restartPolicy')} value={container.restartPolicy} />
          <InspectRow label={t('systemManager.inspect.command')} value={container.command} mono />
          <InspectList label={t('systemManager.inspect.ports')} items={container.ports} />
          <InspectList label={t('systemManager.inspect.networks')} items={container.networks} />
          <InspectList label={t('systemManager.inspect.mounts')} items={container.mounts} />
          <InspectList label={t('systemManager.inspect.env')} items={container.env} />
          <InspectList label={t('systemManager.inspect.labels')} items={container.labels} />
        </div>
      ) : image ? (
        <div className="space-y-1.5">
          <InspectRow label="ID" value={image.id} mono />
          <InspectRow label={t('systemManager.inspect.size')} value={image.size} />
          <InspectRow label={t('systemManager.inspect.platform')} value={image.platform} mono />
          <InspectRow label={t('systemManager.inspect.created')} value={image.createdAt} />
          <InspectRow label="Entrypoint" value={image.entrypoint} mono />
          <InspectRow label="CMD" value={image.cmd} mono />
          <InspectRow label={t('systemManager.inspect.workdir')} value={image.workdir} mono />
          <InspectList label={t('systemManager.inspect.tags')} items={image.tags} />
          <InspectList label={t('systemManager.inspect.digests')} items={image.digests} />
          <InspectList label={t('systemManager.inspect.exposedPorts')} items={image.exposedPorts} />
          <InspectList label={t('systemManager.inspect.env')} items={image.env} />
          <InspectList label={t('systemManager.inspect.labels')} items={image.labels} />
        </div>
      ) : null}
    </div>
  );
});
