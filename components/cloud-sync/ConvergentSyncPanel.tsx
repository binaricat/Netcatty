import React from 'react';
import { AlertTriangle, FlaskConical, RotateCcw, ShieldCheck } from 'lucide-react';

import type {
  ConvergentFieldConflict,
  ConvergentMigrationPreview,
} from '../../domain/sync';
import {
  convergentConflictAddressKey,
  dotKey,
  isConvergentConflictSecret,
} from '../../domain/convergentSync';
import { Button } from '../ui/button';
import { Toggle } from '../settings/settings-ui';

type Translate = (key: string, values?: Record<string, string | number>) => string;

function conflictLabel(conflict: ConvergentFieldConflict, t: Translate): string {
  const { address } = conflict;
  switch (address.kind) {
    case 'entity-presence':
      return `${address.collection}/${address.entityId} · ${t('cloudSync.convergent.field.presence')}`;
    case 'entity-position':
      return `${address.collection}/${address.entityId} · ${t('cloudSync.convergent.field.position')}`;
    case 'entity-field':
      return `${address.collection}/${address.entityId} · ${address.field}`;
    case 'setting':
      return `settings.${address.path.join('.')}`;
    case 'setting-structure':
      return address.paths.map((path) => `settings.${path.join('.')}`).join(' ↔ ');
    case 'string-entry-presence':
      return `${address.collection}/${address.value} · ${t('cloudSync.convergent.field.presence')}`;
    case 'string-entry-position':
      return `${address.collection}/${address.value} · ${t('cloudSync.convergent.field.position')}`;
  }
}

function candidateValue(
  conflict: ConvergentFieldConflict,
  candidate: ConvergentFieldConflict['candidates'][number],
  t: Translate,
): string {
  if (candidate.tombstone) return t('cloudSync.convergent.conflict.empty');
  if (isConvergentConflictSecret(conflict)) {
    return candidate.value == null
      ? t('cloudSync.convergent.conflict.empty')
      : t('cloudSync.convergent.conflict.secretSet');
  }
  const encoded = JSON.stringify(candidate.value);
  if (!encoded) return t('cloudSync.convergent.conflict.empty');
  return encoded.length > 180 ? `${encoded.slice(0, 177)}...` : encoded;
}

export interface ConvergentSyncPanelProps {
  t: Translate;
  resolvedLocale: string | null;
  config: { enabled: boolean; initialized: boolean };
  preview: ConvergentMigrationPreview | null;
  busy: boolean;
  error: string | null;
  conflicts: ConvergentFieldConflict[];
  onToggle: (enabled: boolean) => void | Promise<void>;
  onConfirmMigration: () => void | Promise<void>;
  onCancelMigration: () => void;
  onResolveConflict: (addressKey: string, candidateDot: string) => void | Promise<void>;
  onDowngrade: () => void | Promise<void>;
}

export const ConvergentSyncPanel: React.FC<ConvergentSyncPanelProps> = ({
  t,
  resolvedLocale,
  config,
  preview,
  busy,
  error,
  conflicts,
  onToggle,
  onConfirmMigration,
  onCancelMigration,
  onResolveConflict,
  onDowngrade,
}) => (
  <div className="space-y-4 rounded-lg border bg-card p-4">
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3">
        <div
          data-testid="convergent-sync-icon"
          className="mt-0.5 flex h-9 w-9 shrink-0 self-start items-center justify-center rounded-lg bg-muted text-muted-foreground"
        >
          <FlaskConical size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{t('cloudSync.convergent.title')}</span>
            <span className="inline-flex rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {t('cloudSync.convergent.experimental')}
            </span>
          </div>
          <div className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
            {t('cloudSync.convergent.desc')}
          </div>
        </div>
      </div>
      <Toggle
        checked={config.enabled}
        onChange={onToggle}
        disabled={busy}
        ariaLabel={t('cloudSync.convergent.title')}
      />
    </div>

    {config.initialized && (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <ShieldCheck size={14} className="text-green-500" />
        {config.enabled
          ? t('cloudSync.convergent.active')
          : t('cloudSync.convergent.paused')}
      </div>
    )}

    {preview && (
      <div className="space-y-3 rounded-md bg-muted/40 p-3">
        <div className="text-sm font-semibold">{t('cloudSync.convergent.preview.title')}</div>
        <div className="grid grid-cols-1 gap-2 text-center sm:grid-cols-3">
          <div className="px-3 py-2">
            <div className="text-lg font-semibold tabular-nums">
              {Object.values(preview.entityCounts).reduce((sum, count) => sum + (count ?? 0), 0)}
            </div>
            <div className="text-[10px] text-muted-foreground">{t('cloudSync.convergent.preview.entities')}</div>
          </div>
          <div className="px-3 py-2">
            <div className="text-lg font-semibold tabular-nums">{preview.providers.length}</div>
            <div className="text-[10px] text-muted-foreground">{t('cloudSync.convergent.preview.providers')}</div>
          </div>
          <div className="px-3 py-2">
            <div className="text-lg font-semibold tabular-nums">{preview.conflictCount}</div>
            <div className="text-[10px] text-muted-foreground">{t('cloudSync.convergent.preview.conflicts')}</div>
          </div>
        </div>
        <div className="rounded-md bg-muted/25 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          {t('cloudSync.convergent.preview.compatibility')}
        </div>
        {preview.providers.length > 0 && (
          <div className="divide-y divide-border/40 text-xs">
            {preview.providers.map((provider) => (
              <div key={provider.provider} className="flex items-start justify-between gap-3 px-2 py-1.5">
                <span className="font-medium">{provider.provider}</span>
                <span className="text-right text-muted-foreground">
                  {t(`cloudSync.convergent.preview.status.${provider.status}`)} · {t('cloudSync.convergent.preview.schema')} {provider.schemaVersion}
                  {provider.message ? ` · ${provider.message}` : ''}
                </span>
              </div>
            ))}
          </div>
        )}
        {preview.blockedReasons.length > 0 && (
          <div className="rounded-md bg-destructive/5 p-2 text-xs text-destructive">
            {preview.blockedReasons.join(' · ')}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={onCancelMigration} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={onConfirmMigration} disabled={busy || !preview.canInitialize}>
            {t('cloudSync.convergent.preview.confirm')}
          </Button>
        </div>
      </div>
    )}

    {error && (
      <div className="flex gap-2 rounded-md bg-destructive/5 p-2 text-xs text-destructive">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <span>{error}</span>
      </div>
    )}

    {config.initialized && conflicts.length > 0 && (
      <div className="space-y-2">
        <div className="text-sm font-medium">
          {t('cloudSync.convergent.conflicts.title', { count: conflicts.length })}
        </div>
        <div className="space-y-2">
          {conflicts.map((conflict) => {
            const addressKey = convergentConflictAddressKey(conflict.address);
            return (
              <div key={addressKey} className="space-y-2 rounded-md bg-muted/40 p-3">
                <div className="break-all font-mono text-xs">{conflictLabel(conflict, t)}</div>
                <div className="space-y-1.5">
                  {conflict.candidates.map((candidate) => (
                    <div
                      key={dotKey(candidate.dot)}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-background/60 p-2.5"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium">
                          {candidateValue(conflict, candidate, t)}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {candidate.dot.deviceId} · {new Date(candidate.hlc.wallTime).toLocaleString(resolvedLocale || undefined)}
                          {candidate.selected ? ` · ${t('cloudSync.convergent.conflict.current')}` : ''}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant={candidate.selected ? 'secondary' : 'ghost'}
                        disabled={busy}
                        onClick={() => onResolveConflict(addressKey, dotKey(candidate.dot))}
                      >
                        {t('cloudSync.convergent.conflict.choose')}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    )}

    {config.initialized && (
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <div className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">{t('cloudSync.convergent.downgrade.desc')}</div>
        <Button variant="ghost" size="sm" className="text-destructive" onClick={onDowngrade} disabled={busy}>
          <RotateCcw size={14} className="mr-1" />
          {t('cloudSync.convergent.downgrade.button')}
        </Button>
      </div>
    )}
  </div>
);
