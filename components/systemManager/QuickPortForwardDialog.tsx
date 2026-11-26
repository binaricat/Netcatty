import { ArrowRight, Loader2 } from 'lucide-react';
import React, { memo, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { PortForwardingRule } from '../../domain/models';
import {
  DEFAULT_QUICK_FORWARD_BIND_ADDRESS,
  formatHostPort,
  resolveForwardRemoteHost,
  validateQuickForwardInput,
} from '../../domain/systemManager/portForwardQuick';
import type { ListeningPortInfo } from '../../domain/systemManager/types';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

const BIND_ADDRESS_PRESETS = ['127.0.0.1', '0.0.0.0'] as const;

export interface QuickPortForwardDialogProps {
  open: boolean;
  port: ListeningPortInfo | null;
  hostLabel?: string;
  initialLocalPort: number;
  initialBindAddress: string;
  rules: readonly PortForwardingRule[];
  excludeRuleId?: string;
  busy?: boolean;
  error?: string | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: { localPort: number; bindAddress: string }) => void;
}

export const QuickPortForwardDialog = memo(function QuickPortForwardDialog({
  open,
  port,
  hostLabel,
  initialLocalPort,
  initialBindAddress,
  rules,
  excludeRuleId,
  busy = false,
  error,
  onOpenChange,
  onSubmit,
}: QuickPortForwardDialogProps) {
  const { t } = useI18n();
  const [localPortText, setLocalPortText] = useState(String(initialLocalPort));
  const [bindAddressText, setBindAddressText] = useState(initialBindAddress);
  const [localError, setLocalError] = useState<string | null>(null);
  const localPortInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setLocalPortText(String(initialLocalPort));
    setBindAddressText(initialBindAddress || DEFAULT_QUICK_FORWARD_BIND_ADDRESS);
    setLocalError(null);
  }, [initialBindAddress, initialLocalPort, open, port?.id]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      const input = localPortInputRef.current;
      input?.focus();
      input?.select();
    }, 50);
    return () => window.clearTimeout(timer);
  }, [open, port?.id]);

  if (!port) return null;

  const remoteHost = resolveForwardRemoteHost(port);
  const remoteEndpoint = formatHostPort(remoteHost, port.port);
  const previewBind = bindAddressText.trim() || DEFAULT_QUICK_FORWARD_BIND_ADDRESS;
  const parsedPreviewPort = Number(localPortText.trim());
  const localPreviewEndpoint = Number.isInteger(parsedPreviewPort) && parsedPreviewPort >= 1 && parsedPreviewPort <= 65535
    ? formatHostPort(previewBind, parsedPreviewPort)
    : `${previewBind}:${localPortText.trim() || '?'}`;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const validation = validateQuickForwardInput({
      localPortText,
      bindAddressText,
      rules,
      excludeRuleId,
    });
    if ('error' in validation) {
      if (validation.error.code === 'invalidPort') {
        setLocalError(t('systemManager.ports.forwardInvalidPort'));
      } else if (validation.error.code === 'invalidBindAddress') {
        setLocalError(t('systemManager.ports.forwardInvalidBindAddress'));
      } else {
        setLocalError(
          t('systemManager.ports.forwardPortInUse', {
            port: String(localPortText.trim()),
            label: validation.error.conflictRule.label,
          }),
        );
      }
      return;
    }
    setLocalError(null);
    onSubmit({
      localPort: validation.localPort,
      bindAddress: validation.bindAddress,
    });
  };

  const displayError = localError || error;
  const trimmedBind = bindAddressText.trim();

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!busy || nextOpen) onOpenChange(nextOpen); }}>
      <DialogContent className="sm:max-w-[380px]">
        <DialogHeader>
          <DialogTitle>{t('systemManager.ports.forwardTitle')}</DialogTitle>
          <DialogDescription>
            {hostLabel
              ? t('systemManager.ports.forwardDescWithHost', { host: hostLabel })
              : t('systemManager.ports.forwardDesc')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2.5 space-y-1">
            <div className="flex items-center gap-2 font-mono text-xs text-foreground">
              <span className="truncate">{localPreviewEndpoint}</span>
              <ArrowRight size={12} className="shrink-0 text-muted-foreground" />
              <span className="truncate text-primary">{remoteEndpoint}</span>
            </div>
            <div className="text-[11px] text-muted-foreground truncate">
              {port.processName
                ? `${port.processName}${port.pid != null ? ` · PID ${port.pid}` : ''} · ${port.protocol.toUpperCase()}`
                : `${port.protocol.toUpperCase()}${port.pid != null ? ` · PID ${port.pid}` : ''}`}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="quick-forward-local-port" className="text-xs">
              {t('systemManager.ports.forwardLocalPort')}
            </Label>
            <Input
              id="quick-forward-local-port"
              ref={localPortInputRef}
              type="number"
              min={1}
              max={65535}
              inputMode="numeric"
              value={localPortText}
              onChange={(event) => {
                setLocalPortText(event.target.value);
                if (localError) setLocalError(null);
              }}
              placeholder={String(initialLocalPort)}
              className="h-9 font-mono text-sm"
              disabled={busy}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="quick-forward-bind-address" className="text-xs">
                {t('systemManager.ports.forwardBindAddress')}
              </Label>
              <div className="flex items-center gap-1">
                {BIND_ADDRESS_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setBindAddressText(preset);
                      if (localError) setLocalError(null);
                    }}
                    className={cn(
                      'px-1.5 py-0.5 rounded font-mono text-[10px] transition-colors disabled:opacity-40',
                      trimmedBind === preset
                        ? 'bg-muted text-foreground font-medium'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
                    )}
                  >
                    {preset}
                  </button>
                ))}
              </div>
            </div>
            <Input
              id="quick-forward-bind-address"
              value={bindAddressText}
              onChange={(event) => {
                setBindAddressText(event.target.value);
                if (localError) setLocalError(null);
              }}
              placeholder={DEFAULT_QUICK_FORWARD_BIND_ADDRESS}
              className="h-9 font-mono text-sm"
              spellCheck={false}
              disabled={busy}
            />
          </div>

          {displayError && (
            <p className="text-xs text-destructive break-words" role="alert">
              {displayError}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={busy || !localPortText.trim()}
            >
              {busy ? (
                <>
                  <Loader2 size={14} className="mr-1.5 animate-spin" />
                  {t('systemManager.ports.forwarding')}
                </>
              ) : (
                t('systemManager.ports.forwardAction')
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
});
