import React, { useState } from 'react';
import {
  AlertTriangle,
  Calendar,
  Check,
  Copy,
  Fingerprint,
  Globe,
  Server,
  Shield,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { cn } from '../../lib/utils';
import { RdpProtocolIcon, VncProtocolIcon } from '../icons/RemoteDesktopIcons';
import { getProtocolBadgeClass } from '../protocolVisuals';
import { Button } from '../ui/button';
import {
  tr,
  type RemoteDesktopCertDecisionValue,
  type RemoteDesktopCertVerifyEvent,
} from './remoteDesktopHelpers';

export interface RemoteDesktopCertDialogProps {
  event: RemoteDesktopCertVerifyEvent;
  previousFingerprint: string | null;
  onDecision: (decision: RemoteDesktopCertDecisionValue) => void;
}

export const RemoteDesktopCertDialog: React.FC<RemoteDesktopCertDialogProps> = ({
  event,
  previousFingerprint,
  onDecision,
}) => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const isChanged = Boolean(previousFingerprint);
  const isRdp = event.protocol === 'rdp';
  const protocolLabel = event.protocol.toUpperCase();

  const handleCopyFingerprint = () => {
    void navigator.clipboard?.writeText(event.fingerprintSha256).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    }).catch(() => {});
  };

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={tr(t, 'remoteDesktop.cert.title', 'Verify TLS Certificate')}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onDecision('reject');
        }
      }}
    >
      <div className="w-full max-w-lg rounded-xl border border-border/80 bg-card text-card-foreground shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200">
        {/* Header with protocol badge & endpoint */}
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                isRdp ? 'bg-blue-500/12 text-blue-500' : 'bg-teal-500/12 text-teal-500',
              )}
            >
              {isRdp ? <RdpProtocolIcon size={17} /> : <VncProtocolIcon size={17} />}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-semibold">{event.host}</span>
                <span
                  className={cn(
                    'inline-flex items-center rounded-md border px-1.5 py-0 text-[10px] font-semibold uppercase leading-4 shrink-0',
                    getProtocolBadgeClass(event.protocol),
                  )}
                >
                  {protocolLabel}
                </span>
              </div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">
                {event.host}:{event.port}
              </div>
            </div>
          </div>
          <div
            className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-2',
              isChanged
                ? 'bg-destructive/15 text-destructive ring-destructive/20'
                : 'bg-amber-500/15 text-amber-500 ring-amber-500/20',
            )}
          >
            {isChanged ? <ShieldAlert size={16} /> : <Fingerprint size={16} />}
          </div>
        </div>

        <div className="space-y-3 px-5 py-4 text-xs">
          {/* Status callout banner (matching TerminalHostKeyVerification aesthetic) */}
          <div
            className={cn(
              'rounded-xl border px-3.5 py-3',
              isChanged
                ? 'border-destructive/30 bg-destructive/8'
                : 'border-amber-500/25 bg-amber-500/8',
            )}
          >
            <div className="flex items-start gap-2.5">
              <div
                className={cn(
                  'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                  isChanged
                    ? 'bg-destructive/15 text-destructive'
                    : 'bg-amber-500/15 text-amber-500',
                )}
              >
                {isChanged ? <AlertTriangle size={15} /> : <ShieldCheck size={15} />}
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <h3
                  className={cn(
                    'text-sm font-semibold leading-5',
                    isChanged ? 'text-destructive' : 'text-amber-600 dark:text-amber-400',
                  )}
                >
                  {isChanged
                    ? tr(t, 'remoteDesktop.cert.changedTitle', 'Certificate Fingerprint Changed')
                    : tr(t, 'remoteDesktop.cert.unknownTitle', 'Verify Remote Desktop Certificate')}
                </h3>
                <p className="text-xs leading-5 text-muted-foreground">
                  {isChanged
                    ? tr(
                        t,
                        'remoteDesktop.cert.changedWarning',
                        'The TLS certificate presented by {{host}}:{{port}} does not match the previously trusted fingerprint. This could indicate a server renewal or a man-in-the-middle attack.',
                        { host: event.host, port: event.port },
                      )
                    : tr(
                        t,
                        'remoteDesktop.cert.firstSeenHint',
                        'First time connecting to {{protocol}} server {{host}}:{{port}}. Verify the SHA-256 certificate fingerprint before sending credentials.',
                        { protocol: protocolLabel, host: event.host, port: event.port },
                      )}
                </p>
              </div>
            </div>
          </div>

          {isChanged && previousFingerprint && (
            <div className="rounded-lg border border-destructive/35 bg-destructive/10 p-3">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-destructive">
                <AlertTriangle size={13} />
                <span>{tr(t, 'remoteDesktop.cert.previousFingerprint', 'Previously Trusted SHA-256')}</span>
              </div>
              <code className="mt-1.5 block break-all font-mono text-[11px] leading-5 text-destructive/90 select-all">
                {previousFingerprint}
              </code>
            </div>
          )}

          {/* Presented SHA-256 fingerprint */}
          <div className="rounded-lg border border-border/70 bg-secondary/45 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                <Fingerprint size={13} className="text-primary" />
                <span>{tr(t, 'remoteDesktop.cert.fingerprint', 'Presented SHA-256 Fingerprint')}</span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-[10px] text-muted-foreground hover:text-foreground"
                onClick={handleCopyFingerprint}
              >
                {copied ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
                <span>{copied ? tr(t, 'common.copied', 'Copied') : tr(t, 'common.copy', 'Copy')}</span>
              </Button>
            </div>
            <code className="mt-1.5 block break-all font-mono text-[11px] leading-5 text-foreground select-all">
              {event.fingerprintSha256}
            </code>
          </div>

          {/* Certificate details */}
          {(event.subject || event.issuer || event.validFrom || event.validTo || event.subjectAltName) && (
            <div className="grid grid-cols-[112px_1fr] gap-x-3 gap-y-2 rounded-lg border border-border/60 bg-background/60 p-3 text-[11px]">
              {event.subject && (
                <>
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <Server size={11} className="shrink-0" />
                    {tr(t, 'remoteDesktop.cert.subject', 'Subject')}
                  </span>
                  <span className="truncate font-mono text-foreground" title={event.subject}>{event.subject}</span>
                </>
              )}
              {event.issuer && (
                <>
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <Shield size={11} className="shrink-0" />
                    {tr(t, 'remoteDesktop.cert.issuer', 'Issuer')}
                  </span>
                  <span className="truncate font-mono text-foreground" title={event.issuer}>{event.issuer}</span>
                </>
              )}
              {(event.validFrom || event.validTo) && (
                <>
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <Calendar size={11} className="shrink-0" />
                    {tr(t, 'remoteDesktop.cert.validity', 'Valid')}
                  </span>
                  <span className="truncate text-foreground">
                    {event.validFrom || '?'} &mdash; {event.validTo || '?'}
                  </span>
                </>
              )}
              {event.subjectAltName && (
                <>
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <Globe size={11} className="shrink-0" />
                    {tr(t, 'remoteDesktop.cert.san', 'Alt Names')}
                  </span>
                  <span className="truncate font-mono text-foreground" title={event.subjectAltName}>
                    {event.subjectAltName}
                  </span>
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/60 px-5 py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onDecision('reject')}
          >
            {tr(t, 'remoteDesktop.cert.reject', 'Reject')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onDecision('accept-once')}
          >
            {tr(t, 'remoteDesktop.cert.acceptOnce', 'Accept Once')}
          </Button>
          <Button
            type="button"
            variant={isChanged ? 'destructive' : 'default'}
            size="sm"
            className="gap-1.5"
            onClick={() => onDecision('accept-always')}
          >
            <ShieldCheck size={13} />
            <span>
              {isChanged
                ? tr(t, 'remoteDesktop.cert.replaceTrust', 'Update & Trust Always')
                : tr(t, 'remoteDesktop.cert.trustAlways', 'Trust Always')}
            </span>
          </Button>
        </div>
      </div>
    </div>
  );
};
