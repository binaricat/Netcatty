import React, { useState } from 'react';
import {
  Building2,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Unplug,
  User,
} from 'lucide-react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { RemoteDesktopProtocol } from '../../domain/remoteDesktop';
import { splitWindowsUserDomain } from '../../domain/remoteDesktop';
import { cn } from '../../lib/utils';
import { RdpProtocolIcon, VncProtocolIcon } from '../icons/RemoteDesktopIcons';
import { getProtocolBadgeClass } from '../protocolVisuals';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { tr } from './remoteDesktopHelpers';

export interface RemoteDesktopAuthDialogProps {
  protocol: RemoteDesktopProtocol;
  hostLabel: string;
  hostname: string;
  port: number;
  initialUsername: string;
  initialDomain: string;
  errorMessage?: string | null;
  onSubmit: (credentials: { username: string; password: string; domain: string }) => void;
  onCancel: () => void;
}

export const RemoteDesktopAuthDialog: React.FC<RemoteDesktopAuthDialogProps> = ({
  protocol,
  hostLabel,
  hostname,
  port,
  initialUsername,
  initialDomain,
  errorMessage,
  onSubmit,
  onCancel,
}) => {
  const { t } = useI18n();
  const isRdp = protocol === 'rdp';
  const [username, setUsername] = useState(initialUsername);
  const [domain, setDomain] = useState(initialDomain);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showVncUsername, setShowVncUsername] = useState(Boolean(initialUsername));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isRdp) {
      const split = splitWindowsUserDomain(username, domain);
      onSubmit({
        username: split.username,
        domain: split.domain,
        password,
      });
      return;
    }
    onSubmit({
      username: showVncUsername ? username.trim() : '',
      domain: '',
      password,
    });
  };

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={tr(t, 'remoteDesktop.auth.title', 'Authentication Required')}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-xl border border-border/80 bg-card text-card-foreground shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200"
      >
        <div className="flex items-start gap-3 border-b border-border/60 px-5 py-4">
          <div
            className={cn(
              'relative mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
              isRdp ? 'bg-blue-500/12 text-blue-500' : 'bg-teal-500/12 text-teal-500',
            )}
          >
            {isRdp ? <RdpProtocolIcon size={20} /> : <VncProtocolIcon size={20} />}
            <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full border border-card bg-primary text-primary-foreground shadow-xs">
              <KeyRound size={9} />
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <h3 className="text-sm font-semibold leading-5">
                {isRdp
                  ? tr(t, 'remoteDesktop.auth.rdpTitle', 'RDP Credentials')
                  : tr(t, 'remoteDesktop.auth.vncTitle', 'VNC Password')}
              </h3>
              <span
                className={cn(
                  'inline-flex items-center rounded-md border px-1.5 py-0 text-[10px] font-semibold uppercase leading-4',
                  getProtocolBadgeClass(protocol),
                )}
              >
                {protocol}
              </span>
            </div>
            <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={`${hostLabel} (${hostname}:${port})`}>
              {hostLabel} · {hostname}:{port}
            </p>
          </div>
        </div>

        <div className="space-y-3 px-5 py-4">
          {errorMessage && (
            <div className="flex items-center gap-2.5 rounded-xl border border-destructive/25 bg-destructive/8 px-3 py-2.5 text-xs">
              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive">
                <Unplug size={11} />
              </div>
              <div className="min-w-0 leading-4 text-destructive">
                {errorMessage}
              </div>
            </div>
          )}

          {isRdp ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="rd-auth-username" className="inline-flex items-center gap-1.5 text-xs">
                  <User size={12} className="text-muted-foreground" />
                  {tr(t, 'remoteDesktop.auth.username', 'Username')}
                </Label>
                <Input
                  id="rd-auth-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Administrator"
                  autoFocus={!initialUsername}
                  autoComplete="username"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rd-auth-domain" className="inline-flex items-center gap-1.5 text-xs">
                  <Building2 size={12} className="text-muted-foreground" />
                  {tr(t, 'remoteDesktop.auth.domain', 'Domain (optional)')}
                </Label>
                <Input
                  id="rd-auth-domain"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="CORP"
                />
              </div>
            </>
          ) : (
            <div>
              <button
                type="button"
                className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => setShowVncUsername((v) => !v)}
              >
                {showVncUsername ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <User size={12} />
                <span>{tr(t, 'remoteDesktop.auth.vncUsernameToggle', 'Username (for macOS Screen Sharing / VeNCrypt)')}</span>
              </button>
              {showVncUsername && (
                <div className="mt-2 space-y-1.5">
                  <Input
                    id="rd-auth-vnc-username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={tr(t, 'remoteDesktop.auth.username', 'Username')}
                    autoComplete="username"
                  />
                </div>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="rd-auth-password" className="inline-flex items-center gap-1.5 text-xs">
              <Lock size={12} className="text-muted-foreground" />
              {tr(t, 'remoteDesktop.auth.password', 'Password')}
            </Label>
            <div className="relative">
              <Input
                id="rd-auth-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus={!isRdp || Boolean(initialUsername)}
                autoComplete="current-password"
                className={cn('pr-9', errorMessage && 'border-destructive/50')}
              />
              <button
                type="button"
                tabIndex={-1}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowPassword((prev) => !prev)}
              >
                {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          <div className="flex items-center gap-1.5 rounded-lg bg-secondary/45 px-2.5 py-2 text-[11px] text-muted-foreground">
            <Lock size={11} className="shrink-0 text-emerald-500" />
            <span>
              {tr(
                t,
                'remoteDesktop.auth.sessionOnlyHint',
                'Credentials are used only for this session and are not saved to disk.',
              )}
            </span>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/60 px-5 py-3">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            {tr(t, 'common.cancel', 'Cancel')}
          </Button>
          <Button type="submit" size="sm" className="gap-1.5" disabled={isRdp && !username.trim()}>
            <KeyRound size={13} />
            <span>{tr(t, 'remoteDesktop.auth.connect', 'Connect')}</span>
          </Button>
        </div>
      </form>
    </div>
  );
};
