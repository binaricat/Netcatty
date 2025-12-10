import React, { useState, useMemo, useCallback } from 'react';
import {
  Lock,
  Key,
  User,
  Eye,
  EyeOff,
  ChevronDown,
  Globe,
  Terminal as TerminalIcon,
  Plus,
  ArrowLeft,
} from 'lucide-react';
import { Host, SSHKey, KnownHost, ProxyConfig, HostChainConfig, EnvVar } from '../types';
import { DistroAvatar } from './DistroAvatar';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { ScrollArea } from './ui/scroll-area';
import { cn } from '../lib/utils';
import {
  AsidePanel,
  AsidePanelContent,
  AsidePanelFooter,
} from './ui/aside-panel';

// Protocol types supported for quick connect
type Protocol = 'ssh' | 'mosh' | 'telnet';

// Wizard steps
type WizardStep = 'protocol' | 'username' | 'knownhost' | 'auth';

interface QuickConnectTarget {
  hostname: string;
  username?: string;
  port?: number;
}

interface QuickConnectWizardProps {
  open: boolean;
  target: QuickConnectTarget;
  keys: SSHKey[];
  knownHosts: KnownHost[];
  onConnect: (host: Host) => void;
  onSaveHost?: (host: Host) => void;
  onAddKey?: () => void;
  onClose: () => void;
}

// Parse user@host:port format
export function parseQuickConnectInput(input: string): QuickConnectTarget | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Pattern: [user@]hostname[:port]
  // Hostname can be IP (v4 or v6) or domain name
  const regex = /^(?:([^@]+)@)?([^\s:]+|\[[^\]]+\])(?::(\d+))?$/;
  const match = trimmed.match(regex);
  if (!match) return null;

  const [, username, hostname, portStr] = match;
  
  // Validate hostname looks like an IP or domain
  const ipv4Regex = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  const ipv6Regex = /^\[?[a-fA-F0-9:]+\]?$/;
  const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?)*$/;
  
  if (!ipv4Regex.test(hostname) && !ipv6Regex.test(hostname) && !domainRegex.test(hostname)) {
    return null;
  }

  const port = portStr ? parseInt(portStr, 10) : undefined;
  if (port !== undefined && (isNaN(port) || port < 1 || port > 65535)) {
    return null;
  }

  return {
    hostname: hostname.replace(/^\[|\]$/g, ''), // Remove IPv6 brackets
    username: username || undefined,
    port,
  };
}

// Check if input looks like a quick connect address
export function isQuickConnectInput(input: string): boolean {
  return parseQuickConnectInput(input) !== null;
}

const QuickConnectWizard: React.FC<QuickConnectWizardProps> = ({
  open,
  target,
  keys,
  knownHosts,
  onConnect,
  onSaveHost,
  onAddKey,
  onClose,
}) => {
  // Wizard state
  const [step, setStep] = useState<WizardStep>('protocol');
  const [protocol, setProtocol] = useState<Protocol>('ssh');
  const [username, setUsername] = useState(target.username || '');
  const [port, setPort] = useState<number>(target.port || 22);
  const [moshServerPath, setMoshServerPath] = useState('');
  const [showLogs, setShowLogs] = useState(false);
  
  // Known host verification state
  const [knownHostInfo, setKnownHostInfo] = useState<{
    keyType: string;
    fingerprint: string;
  } | null>(null);
  
  // Auth state
  const [authMethod, setAuthMethod] = useState<'password' | 'key'>('password');
  const [password, setPassword] = useState('');
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [saveCredentials, setSaveCredentials] = useState(true);
  
  // Check if host is in known hosts
  const existingKnownHost = useMemo(() => {
    return knownHosts.find(kh => 
      kh.hostname === target.hostname && 
      (kh.port === port || (!kh.port && port === 22))
    );
  }, [knownHosts, target.hostname, port]);

  // Reset state when target changes
  React.useEffect(() => {
    if (open) {
      setStep('protocol');
      setProtocol('ssh');
      setUsername(target.username || '');
      setPort(target.port || 22);
      setPassword('');
      setSelectedKeyId(null);
      setShowPassword(false);
      setKnownHostInfo(null);
    }
  }, [open, target]);

  // Get default port for protocol
  const getDefaultPort = (proto: Protocol) => {
    switch (proto) {
      case 'ssh': return 22;
      case 'mosh': return 22;
      case 'telnet': return 23;
      default: return 22;
    }
  };

  // Handle protocol selection
  const handleProtocolSelect = (proto: Protocol) => {
    setProtocol(proto);
    // Update port to default for protocol if unchanged
    if (port === getDefaultPort(protocol)) {
      setPort(getDefaultPort(proto));
    }
  };

  // Navigate to next step
  const handleContinue = () => {
    switch (step) {
      case 'protocol':
        // If no username provided yet, go to username step
        if (!target.username && !username) {
          setStep('username');
        } else {
          // Skip to auth step (known host check happens during connection)
          setStep('auth');
        }
        break;
      case 'username':
        setStep('auth');
        break;
      case 'knownhost':
        setStep('auth');
        break;
      case 'auth':
        handleConnect();
        break;
    }
  };

  // Navigate back
  const handleBack = () => {
    switch (step) {
      case 'username':
        setStep('protocol');
        break;
      case 'knownhost':
        if (!target.username) {
          setStep('username');
        } else {
          setStep('protocol');
        }
        break;
      case 'auth':
        if (!target.username && !username) {
          setStep('username');
        } else {
          setStep('protocol');
        }
        break;
    }
  };

  // Create host and connect
  const handleConnect = () => {
    const effectiveUsername = username || target.username || 'root';
    const effectivePort = port || getDefaultPort(protocol);
    
    const tempHost: Host = {
      id: `quick-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      label: `${target.hostname}`,
      hostname: target.hostname,
      port: effectivePort,
      username: effectiveUsername,
      group: '',
      tags: [],
      os: 'linux',
      protocol: protocol === 'mosh' ? 'ssh' : protocol,
      authMethod: authMethod,
      password: authMethod === 'password' ? password : undefined,
      identityFileId: authMethod === 'key' ? selectedKeyId || undefined : undefined,
      moshEnabled: protocol === 'mosh',
    };

    // Save host if requested
    if (saveCredentials && onSaveHost) {
      onSaveHost(tempHost);
    }

    onConnect(tempHost);
    onClose();
  };

  // Check if can proceed
  const canProceed = useMemo(() => {
    switch (step) {
      case 'protocol':
        return true;
      case 'username':
        return username.trim().length > 0;
      case 'knownhost':
        return true;
      case 'auth':
        if (authMethod === 'password') {
          return password.trim().length > 0;
        }
        return !!selectedKeyId;
    }
  }, [step, username, authMethod, password, selectedKeyId]);

  // Render protocol selection step
  const renderProtocolStep = () => (
    <div className="space-y-4">
      <h3 className="text-base font-semibold">Choose protocol</h3>
      <div className="space-y-3">
        {/* SSH */}
        <button
          className={cn(
            "w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 transition-all text-left",
            protocol === 'ssh'
              ? "border-primary bg-primary/5"
              : "border-border/60 hover:border-border hover:bg-secondary/50"
          )}
          onClick={() => handleProtocolSelect('ssh')}
        >
          <div className="flex items-center gap-3">
            <div className={cn(
              "h-10 w-10 rounded-lg flex items-center justify-center",
              protocol === 'ssh' ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
            )}>
              <TerminalIcon size={18} />
            </div>
            <div>
              <div className="font-medium">SSH</div>
              <div className="text-xs text-muted-foreground font-mono">
                ssh {target.hostname}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">port:</span>
            <Input
              type="number"
              value={protocol === 'ssh' ? port : 22}
              onChange={(e) => {
                setPort(parseInt(e.target.value) || 22);
                setProtocol('ssh');
              }}
              onClick={(e) => e.stopPropagation()}
              className="w-16 h-7 text-xs text-center"
              min={1}
              max={65535}
            />
          </div>
        </button>

        {/* Mosh */}
        <button
          className={cn(
            "w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 transition-all text-left",
            protocol === 'mosh'
              ? "border-primary bg-primary/5"
              : "border-border/60 hover:border-border hover:bg-secondary/50"
          )}
          onClick={() => handleProtocolSelect('mosh')}
        >
          <div className="flex items-center gap-3">
            <div className={cn(
              "h-10 w-10 rounded-lg flex items-center justify-center",
              protocol === 'mosh' ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
            )}>
              <Globe size={18} />
            </div>
            <div>
              <div className="font-medium">Mosh</div>
              <div className="text-xs text-muted-foreground font-mono">
                mosh {target.hostname}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">port:</span>
            <Input
              type="number"
              value={protocol === 'mosh' ? port : 22}
              onChange={(e) => {
                setPort(parseInt(e.target.value) || 22);
                setProtocol('mosh');
              }}
              onClick={(e) => e.stopPropagation()}
              className="w-16 h-7 text-xs text-center"
              min={1}
              max={65535}
            />
            <Input
              type="text"
              value={moshServerPath}
              onChange={(e) => setMoshServerPath(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              placeholder="mosh --server=/path/server host"
              className="w-40 h-7 text-xs"
            />
          </div>
        </button>

        {/* Telnet */}
        <button
          className={cn(
            "w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 transition-all text-left",
            protocol === 'telnet'
              ? "border-primary bg-primary/5"
              : "border-border/60 hover:border-border hover:bg-secondary/50"
          )}
          onClick={() => handleProtocolSelect('telnet')}
        >
          <div className="flex items-center gap-3">
            <div className={cn(
              "h-10 w-10 rounded-lg flex items-center justify-center",
              protocol === 'telnet' ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
            )}>
              <TerminalIcon size={18} />
            </div>
            <div>
              <div className="font-medium">Telnet</div>
              <div className="text-xs text-muted-foreground font-mono">
                telnet {target.hostname}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">port:</span>
            <Input
              type="number"
              value={protocol === 'telnet' ? port : 23}
              onChange={(e) => {
                setPort(parseInt(e.target.value) || 23);
                setProtocol('telnet');
              }}
              onClick={(e) => e.stopPropagation()}
              className="w-16 h-7 text-xs text-center"
              min={1}
              max={65535}
            />
          </div>
        </button>
      </div>
    </div>
  );

  // Render username step
  const renderUsernameStep = () => (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="quick-username">Username</Label>
        <Input
          id="quick-username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="root"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter' && username.trim()) {
              handleContinue();
            }
          }}
        />
      </div>
    </div>
  );

  // Render known host verification step
  const renderKnownHostStep = () => (
    <div className="space-y-4">
      <h3 className="text-base font-semibold text-amber-600 dark:text-amber-500">
        Are you sure you want to connect?
      </h3>
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>The authenticity of {target.hostname} can not be established.</p>
        {knownHostInfo && (
          <>
            <p className="font-medium text-foreground">
              {knownHostInfo.keyType} fingerprint is SHA256:
            </p>
            <p className="font-mono text-xs bg-muted p-2 rounded break-all">
              {knownHostInfo.fingerprint}
            </p>
          </>
        )}
        <p>Do you want to add it to the list of known hosts?</p>
      </div>
    </div>
  );

  // Render auth step
  const renderAuthStep = () => (
    <div className="space-y-4">
      {/* Auth method tabs */}
      <div className="flex gap-1 p-1 bg-secondary/80 rounded-lg border border-border/60">
        <button
          className={cn(
            "flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all",
            authMethod === 'password'
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground hover:bg-secondary"
          )}
          onClick={() => setAuthMethod('password')}
        >
          <Lock size={14} />
          Password
        </button>
        <button
          className={cn(
            "flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all",
            authMethod === 'key'
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground hover:bg-secondary"
          )}
          onClick={() => setAuthMethod('key')}
        >
          <Key size={14} />
          Public Key
        </button>
      </div>

      {/* Password field */}
      {authMethod === 'password' && (
        <div className="space-y-2">
          <Label htmlFor="quick-password">Password:</Label>
          <div className="relative">
            <Input
              id="quick-password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              className="pr-10"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && password.trim()) {
                  handleConnect();
                }
              }}
            />
            <button
              type="button"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setShowPassword(!showPassword)}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>
      )}

      {/* Key selection */}
      {authMethod === 'key' && (
        <div className="space-y-2">
          {keys.filter(k => k.category === 'key').length === 0 ? (
            <div className="text-sm text-muted-foreground p-3 border border-dashed border-border/60 rounded-lg text-center">
              No keys available. Add keys in the Keychain section.
            </div>
          ) : (
            <ScrollArea className="max-h-48">
              <div className="space-y-2">
                {keys.filter(k => k.category === 'key').map((key) => (
                  <button
                    key={key.id}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors text-left",
                      selectedKeyId === key.id
                        ? "border-primary bg-primary/5"
                        : "border-border/50 hover:bg-secondary/50"
                    )}
                    onClick={() => setSelectedKeyId(key.id)}
                  >
                    <div className={cn(
                      "h-8 w-8 rounded-lg flex items-center justify-center",
                      key.source === 'biometric' ? "bg-purple-500/20 text-purple-500" : "bg-primary/20 text-primary"
                    )}>
                      <Key size={14} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{key.label}</div>
                      <div className="text-xs text-muted-foreground">Type {key.type}</div>
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
          )}
          
          {onAddKey && (
            <Button
              variant="outline"
              size="sm"
              className="w-full mt-2"
              onClick={onAddKey}
            >
              <Plus size={14} className="mr-2" />
              Add key
            </Button>
          )}
        </div>
      )}
    </div>
  );

  // Get step title
  const getStepTitle = () => {
    switch (step) {
      case 'protocol': return target.hostname;
      case 'username': return target.hostname;
      case 'knownhost': return target.hostname;
      case 'auth': return target.hostname;
    }
  };

  // Get step subtitle
  const getStepSubtitle = () => {
    const effectiveUsername = username || target.username || '';
    switch (step) {
      case 'protocol': return target.hostname;
      case 'username': return `${protocol.toUpperCase()} ${target.hostname}:${port}`;
      case 'knownhost': return `${protocol.toUpperCase()} ${effectiveUsername}@${target.hostname}:${port}`;
      case 'auth': return `${protocol.toUpperCase()} ${target.hostname}:${port}`;
    }
  };

  // Render progress indicator
  const renderProgressIndicator = () => {
    const steps: WizardStep[] = target.username 
      ? ['protocol', 'auth'] 
      : ['protocol', 'username', 'auth'];
    const currentIndex = steps.indexOf(step);
    
    return (
      <div className="flex items-center gap-3 py-3">
        <div className={cn(
          "h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0",
          currentIndex >= 0 ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
        )}>
          <TerminalIcon size={14} />
        </div>
        <div className="flex-1 h-0.5 bg-muted" />
        {!target.username && (
          <>
            <div className={cn(
              "h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0",
              currentIndex >= 1 ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
            )}>
              <User size={14} />
            </div>
            <div className="flex-1 h-0.5 bg-muted" />
          </>
        )}
        <div className={cn(
          "h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0",
          step === 'auth' ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
        )}>
          {authMethod === 'password' ? <Lock size={14} /> : <Key size={14} />}
        </div>
        <div className="flex-1 h-0.5 bg-muted" />
        <div className="h-8 w-8 rounded-full bg-muted text-muted-foreground flex items-center justify-center text-xs font-mono">
          {'>_'}
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-[560px] max-w-[90vw] bg-background border border-border/60 rounded-2xl shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200">
        {/* Header */}
        <div className="px-6 py-5 border-b border-border/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-xl bg-primary/15 text-primary flex items-center justify-center">
                <TerminalIcon size={22} />
              </div>
              <div>
                <h2 className="text-base font-semibold">{getStepTitle()}</h2>
                <p className="text-xs text-muted-foreground font-mono">
                  {getStepSubtitle()}
                </p>
              </div>
            </div>
            {(step === 'auth' || (step === 'knownhost' && !knownHostInfo)) && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={() => setShowLogs(!showLogs)}
              >
                {showLogs ? 'Hide logs' : 'Show logs'}
              </Button>
            )}
          </div>
        </div>

        {/* Progress indicator */}
        <div className="px-6">
          {renderProgressIndicator()}
        </div>

        {/* Content */}
        <div className="px-6 py-4">
          {step === 'protocol' && renderProtocolStep()}
          {step === 'username' && renderUsernameStep()}
          {step === 'knownhost' && renderKnownHostStep()}
          {step === 'auth' && renderAuthStep()}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border/50 flex items-center justify-between">
          <Button 
            variant="secondary" 
            onClick={step === 'protocol' ? onClose : handleBack}
          >
            {step === 'protocol' ? 'Close' : (
              <>
                <ArrowLeft size={14} className="mr-2" />
                Back
              </>
            )}
          </Button>
          
          {step === 'knownhost' ? (
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={handleContinue}>
                Continue
              </Button>
              <Button onClick={() => {
                // Add to known hosts then continue
                handleContinue();
              }}>
                Add and continue
              </Button>
            </div>
          ) : step === 'auth' ? (
            <div className="flex items-center gap-2">
              {onAddKey && authMethod === 'key' && keys.filter(k => k.category === 'key').length === 0 && (
                <Button variant="secondary" onClick={onAddKey}>
                  Add key
                </Button>
              )}
              <Button
                disabled={!canProceed}
                onClick={handleConnect}
              >
                Continue & Save
                <ChevronDown size={14} className="ml-2" />
              </Button>
            </div>
          ) : (
            <Button onClick={handleContinue} disabled={!canProceed}>
              Continue
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

export default QuickConnectWizard;
