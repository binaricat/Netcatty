import React from 'react';
import { AlertTriangle, ShieldCheck, ShieldX, Info } from 'lucide-react';
import { Host, KnownHost } from '../types';
import { DistroAvatar } from './DistroAvatar';
import { Button } from './ui/button';
import { cn } from '../lib/utils';

export interface HostKeyInfo {
  hostname: string;
  port: number;
  keyType: string; // ssh-rsa, ssh-ed25519, ecdsa-sha2-nistp256, etc.
  fingerprint: string; // SHA256 fingerprint
  publicKey?: string; // Full public key
}

interface KnownHostConfirmDialogProps {
  host: Host;
  hostKeyInfo: HostKeyInfo;
  onClose: () => void;
  onContinue: () => void; // Continue without adding to known hosts
  onAddAndContinue: () => void; // Add to known hosts and continue
}

const KnownHostConfirmDialog: React.FC<KnownHostConfirmDialogProps> = ({
  host,
  hostKeyInfo,
  onClose,
  onContinue,
  onAddAndContinue,
}) => {
  return (
    <div className="flex flex-col items-center justify-center h-full p-8 max-w-2xl mx-auto">
      {/* Header with host info */}
      <div className="flex items-center gap-3 mb-6">
        <DistroAvatar host={host} fallback={host.label.slice(0, 2).toUpperCase()} className="h-12 w-12" />
        <div>
          <h2 className="text-base font-semibold">{host.label}</h2>
          <p className="text-xs text-muted-foreground font-mono">
            SSH {host.hostname}:{host.port || 22}
          </p>
        </div>
        <Button variant="outline" size="sm" className="ml-4">
          Show logs
        </Button>
      </div>

      {/* Progress indicator */}
      <div className="flex items-center gap-3 w-full max-w-md mb-8">
        <div className="h-8 w-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center">
          <div className="h-2 w-2 rounded-full bg-primary-foreground" />
        </div>
        <div className="flex-1 h-0.5 bg-primary" />
        <div className="h-8 w-8 rounded-full bg-primary/20 border-2 border-primary text-primary flex items-center justify-center">
          <ShieldCheck size={14} />
        </div>
        <div className="flex-1 h-0.5 bg-muted" />
        <div className="h-8 w-8 rounded-full bg-muted text-muted-foreground flex items-center justify-center text-xs font-mono">
          {'>_'}
        </div>
      </div>

      {/* Warning message */}
      <div className="text-center mb-6">
        <h3 className="text-lg font-semibold text-amber-500 mb-2">
          Are you sure you want to connect?
        </h3>
        <p className="text-sm text-muted-foreground">
          The authenticity of <span className="font-mono font-medium text-foreground">{hostKeyInfo.hostname}</span> can not be established.
        </p>
      </div>

      {/* Fingerprint info */}
      <div className="w-full max-w-md space-y-3 mb-8">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{hostKeyInfo.keyType} fingerprint is SHA256:</span>
        </div>
        <div className="bg-secondary/80 rounded-lg p-3 border border-border/60">
          <code className="text-sm font-mono text-foreground break-all">
            {hostKeyInfo.fingerprint}
          </code>
        </div>
        <p className="text-sm text-muted-foreground">
          Do you want to add it to the list of known hosts?
        </p>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-3">
        <Button
          variant="secondary"
          className="min-w-[100px]"
          onClick={onClose}
        >
          Close
        </Button>
        <Button
          variant="outline"
          className="min-w-[100px]"
          onClick={onContinue}
        >
          Continue
        </Button>
        <Button
          className="min-w-[140px]"
          onClick={onAddAndContinue}
        >
          Add and continue
        </Button>
      </div>
    </div>
  );
};

export default KnownHostConfirmDialog;
