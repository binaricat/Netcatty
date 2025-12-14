/**
 * CloudSyncSettings - End-to-End Encrypted Cloud Sync UI
 * 
 * Handles:
 * - Master key setup (gatekeeper screen)
 * - Unlock/lock functionality
 * - Provider connections (GitHub, Google, OneDrive)
 * - Sync status and conflict resolution
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  AlertTriangle,
  Check,
  Cloud,
  CloudOff,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Fingerprint,
  Github,
  Key,
  Loader2,
  Lock,
  RefreshCw,
  Shield,
  ShieldCheck,
  Unlock,
  X,
} from 'lucide-react';
import { useCloudSync } from '../application/state/useCloudSync';
import type { CloudProvider, ConflictInfo, SyncPayload } from '../domain/sync';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { toast } from './ui/toast';

// ============================================================================
// Provider Icons
// ============================================================================

const GoogleDriveIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M7.71 3.5L1.15 15l3.43 6 6.55-11.5L7.71 3.5zm1.73 0l6.55 11.5H23L16.45 3.5H9.44zM8 15l-3.43 6h13.72l3.43-6H8z" />
  </svg>
);

const OneDriveIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M10.5 18.5c0 .55-.45 1-1 1h-5c-2.21 0-4-1.79-4-4 0-1.86 1.28-3.41 3-3.86v-.14c0-2.21 1.79-4 4-4 1.1 0 2.1.45 2.82 1.18A5.003 5.003 0 0 1 15 4c2.76 0 5 2.24 5 5 0 .16 0 .32-.02.47A4.5 4.5 0 0 1 24 13.5c0 2.49-2.01 4.5-4.5 4.5h-8c-.55 0-1-.45-1-1s.45-1 1-1h8c1.38 0 2.5-1.12 2.5-2.5s-1.12-2.5-2.5-2.5H19c-.28 0-.5-.22-.5-.5 0-2.21-1.79-4-4-4-1.87 0-3.44 1.28-3.88 3.02-.09.37-.41.63-.79.63-1.66 0-3 1.34-3 3v.5c0 .28-.22.5-.5.5-1.38 0-2.5 1.12-2.5 2.5s1.12 2.5 2.5 2.5h5c.55 0 1 .45 1 1z" />
  </svg>
);

// ============================================================================
// Toggle Component
// ============================================================================

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

const Toggle: React.FC<ToggleProps> = ({ checked, onChange, disabled }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={cn(
      "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
      checked ? "bg-primary" : "bg-input"
    )}
  >
    <span
      className={cn(
        "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform",
        checked ? "translate-x-4" : "translate-x-0"
      )}
    />
  </button>
);

// ============================================================================
// Status Dot Component
// ============================================================================

interface StatusDotProps {
  status: 'connected' | 'syncing' | 'error' | 'disconnected' | 'connecting';
  className?: string;
}

const StatusDot: React.FC<StatusDotProps> = ({ status, className }) => {
  const colors = {
    connected: 'bg-green-500',
    syncing: 'bg-blue-500 animate-pulse',
    error: 'bg-red-500',
    connecting: 'bg-yellow-500 animate-pulse',
    disconnected: 'bg-muted-foreground/50',
  };

  return (
    <span className={cn('inline-block w-2 h-2 rounded-full', colors[status], className)} />
  );
};

// ============================================================================
// Gatekeeper Screen (NO_KEY state)
// ============================================================================

interface GatekeeperScreenProps {
  onSetupComplete: () => void;
}

const GatekeeperScreen: React.FC<GatekeeperScreenProps> = ({ onSetupComplete }) => {
  const { setupMasterKey } = useCloudSync();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const passwordStrength = React.useMemo(() => {
    if (password.length < 8) return { level: 0, text: 'Too short' };
    let score = 0;
    if (password.length >= 12) score++;
    if (/[A-Z]/.test(password)) score++;
    if (/[a-z]/.test(password)) score++;
    if (/[0-9]/.test(password)) score++;
    if (/[^A-Za-z0-9]/.test(password)) score++;
    
    if (score <= 2) return { level: 1, text: 'Weak' };
    if (score <= 3) return { level: 2, text: 'Moderate' };
    if (score <= 4) return { level: 3, text: 'Strong' };
    return { level: 4, text: 'Very Strong' };
  }, [password]);

  const canSubmit = password.length >= 8 && password === confirmPassword && acknowledged;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    setIsLoading(true);
    setError(null);

    try {
      await setupMasterKey(password, confirmPassword);
      toast.success('Encryption vault enabled');
      onSetupComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to setup master key');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
      <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mb-6">
        <Shield className="w-10 h-10 text-primary" />
      </div>
      
      <h2 className="text-xl font-semibold mb-2">End-to-End Encrypted Sync</h2>
      <p className="text-sm text-muted-foreground max-w-md mb-8">
        Your data is encrypted locally before syncing. Cloud providers never see your plaintext data.
        Set a master key to enable secure sync.
      </p>

      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
        <div className="space-y-2">
          <Label className="text-left block">Master Key</Label>
          <div className="relative">
            <Input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter a strong password"
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          {password.length > 0 && (
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1 rounded-full bg-muted overflow-hidden">
                <div
                  className={cn(
                    'h-full transition-all',
                    passwordStrength.level === 1 && 'w-1/4 bg-red-500',
                    passwordStrength.level === 2 && 'w-2/4 bg-yellow-500',
                    passwordStrength.level === 3 && 'w-3/4 bg-green-500',
                    passwordStrength.level === 4 && 'w-full bg-green-600',
                  )}
                />
              </div>
              <span className="text-xs text-muted-foreground">{passwordStrength.text}</span>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <Label className="text-left block">Confirm Master Key</Label>
          <Input
            type={showPassword ? 'text' : 'password'}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Confirm your password"
          />
          {confirmPassword && password !== confirmPassword && (
            <p className="text-xs text-red-500 text-left">Passwords do not match</p>
          )}
        </div>

        <label className="flex items-start gap-3 p-3 rounded-lg border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/50 cursor-pointer text-left">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-0.5 accent-red-500"
          />
          <span className="text-xs text-red-700 dark:text-red-400">
            I understand that if I forget my master key, my data cannot be recovered. 
            There is no password reset.
          </span>
        </label>

        {error && (
          <p className="text-sm text-red-500 text-left">{error}</p>
        )}

        <Button
          type="submit"
          disabled={!canSubmit || isLoading}
          className="w-full gap-2"
        >
          {isLoading ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <ShieldCheck size={16} />
          )}
          Enable Encrypted Vault
        </Button>
      </form>
    </div>
  );
};

// ============================================================================
// Unlock Screen (LOCKED state)
// ============================================================================

interface UnlockScreenProps {
  onUnlock: () => void;
}

const UnlockScreen: React.FC<UnlockScreenProps> = ({ onUnlock }) => {
  const { unlock } = useCloudSync();
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;

    setIsLoading(true);
    setError(null);

    try {
      const success = await unlock(password);
      if (success) {
        onUnlock();
      } else {
        setAttempts(a => a + 1);
        setError('Incorrect master key');
        setPassword('');
      }
    } catch {
      setError('Failed to unlock vault');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
      <div className="w-20 h-20 rounded-full bg-amber-500/10 flex items-center justify-center mb-6">
        <Lock className="w-10 h-10 text-amber-500" />
      </div>
      
      <h2 className="text-xl font-semibold mb-2">Vault Locked</h2>
      <p className="text-sm text-muted-foreground max-w-md mb-8">
        Enter your master key to access cloud sync settings and sync your data.
      </p>

      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
        <div className="space-y-2">
          <Label className="text-left block">Master Key</Label>
          <div className="relative">
            <Input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your master key"
              className="pr-10"
              autoFocus
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-500 text-left">
            {error} {attempts >= 3 && '- Too many attempts'}
          </p>
        )}

        <Button
          type="submit"
          disabled={!password || isLoading}
          className="w-full gap-2"
        >
          {isLoading ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Unlock size={16} />
          )}
          Unlock Vault
        </Button>

        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mx-auto"
        >
          <Fingerprint size={14} />
          Use Touch ID / Face ID
        </button>
      </form>
    </div>
  );
};

// ============================================================================
// Provider Card Component
// ============================================================================

interface ProviderCardProps {
  provider: CloudProvider;
  name: string;
  icon: React.ReactNode;
  isConnected: boolean;
  isSyncing: boolean;
  account?: { name?: string; email?: string; avatarUrl?: string };
  lastSync?: number;
  error?: string;
  onConnect: () => void;
  onDisconnect: () => void;
  onSync: () => void;
}

const ProviderCard: React.FC<ProviderCardProps> = ({
  provider: _provider,
  name,
  icon,
  isConnected,
  isSyncing,
  account,
  lastSync,
  error,
  onConnect,
  onDisconnect,
  onSync,
}) => {
  const formatLastSync = (timestamp?: number): string => {
    if (!timestamp) return 'Never';
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
    
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const status = error ? 'error' : isSyncing ? 'syncing' : isConnected ? 'connected' : 'disconnected';

  return (
    <div className={cn(
      "flex items-center gap-4 p-4 rounded-lg border transition-colors",
      isConnected ? "bg-card" : "bg-muted/30",
      error && "border-red-300 dark:border-red-900"
    )}>
      <div className={cn(
        "w-12 h-12 rounded-lg flex items-center justify-center",
        isConnected ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
      )}>
        {icon}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium">{name}</span>
          <StatusDot status={status} />
        </div>
        
        {isConnected && account ? (
          <div className="flex items-center gap-2 mt-1">
            {account.avatarUrl && (
              <img 
                src={account.avatarUrl} 
                alt="" 
                className="w-4 h-4 rounded-full"
              />
            )}
            <span className="text-xs text-muted-foreground truncate">
              {account.name || account.email}
            </span>
            <span className="text-xs text-muted-foreground">
              · {formatLastSync(lastSync)}
            </span>
          </div>
        ) : error ? (
          <p className="text-xs text-red-500 truncate mt-1">{error}</p>
        ) : (
          <p className="text-xs text-muted-foreground mt-1">Not connected</p>
        )}
      </div>

      <div className="flex items-center gap-2">
        {isConnected ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={onSync}
              disabled={isSyncing}
              className="gap-1"
            >
              {isSyncing ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <RefreshCw size={14} />
              )}
              Sync
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onDisconnect}
              className="text-muted-foreground hover:text-red-500"
            >
              <CloudOff size={14} />
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={onConnect} className="gap-1">
            <Cloud size={14} />
            Connect
          </Button>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// GitHub Device Flow Modal
// ============================================================================

interface GitHubDeviceFlowModalProps {
  isOpen: boolean;
  userCode: string;
  verificationUri: string;
  isPolling: boolean;
  onClose: () => void;
}

const GitHubDeviceFlowModal: React.FC<GitHubDeviceFlowModalProps> = ({
  isOpen,
  userCode,
  verificationUri,
  isPolling,
  onClose,
}) => {
  const [copied, setCopied] = useState(false);

  const copyCode = useCallback(() => {
    navigator.clipboard.writeText(userCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [userCode]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background rounded-lg shadow-xl w-full max-w-md p-6 relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-muted-foreground hover:text-foreground"
        >
          <X size={18} />
        </button>

        <div className="text-center">
          <div className="w-16 h-16 rounded-full bg-[#24292e] flex items-center justify-center mx-auto mb-4">
            <Github className="w-8 h-8 text-white" />
          </div>

          <h3 className="text-lg font-semibold mb-2">Connect to GitHub</h3>
          <p className="text-sm text-muted-foreground mb-6">
            Copy the code below and enter it on GitHub to authorize Netcatty.
          </p>

          <div className="bg-muted rounded-lg p-4 mb-4">
            <div className="font-mono text-2xl font-bold tracking-widest mb-2">
              {userCode}
            </div>
            <Button size="sm" variant="ghost" onClick={copyCode} className="gap-2">
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? 'Copied!' : 'Copy Code'}
            </Button>
          </div>

          <Button 
            onClick={() => window.open(verificationUri, '_blank')}
            className="w-full gap-2 mb-4"
          >
            <ExternalLink size={14} />
            Open GitHub
          </Button>

          {isPolling && (
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 size={14} className="animate-spin" />
              Waiting for authorization...
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Conflict Resolution Modal
// ============================================================================

interface ConflictModalProps {
  conflict: ConflictInfo | null;
  onResolve: (resolution: 'USE_LOCAL' | 'USE_REMOTE') => void;
  onClose: () => void;
}

const ConflictModal: React.FC<ConflictModalProps> = ({
  conflict,
  onResolve,
  onClose,
}) => {
  if (!conflict) return null;

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background rounded-lg shadow-xl w-full max-w-lg p-6 relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-muted-foreground hover:text-foreground"
        >
          <X size={18} />
        </button>

        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-amber-500/10 flex items-center justify-center">
            <AlertTriangle className="w-5 h-5 text-amber-500" />
          </div>
          <div>
            <h3 className="text-lg font-semibold">Version Conflict Detected</h3>
            <p className="text-sm text-muted-foreground">
              Choose which version to keep
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="p-4 rounded-lg border bg-muted/30">
            <div className="text-xs font-medium text-muted-foreground mb-2">LOCAL</div>
            <div className="text-sm font-medium">v{conflict.localVersion}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {formatDate(conflict.localUpdatedAt)}
            </div>
            {conflict.localDeviceName && (
              <div className="text-xs text-muted-foreground">
                {conflict.localDeviceName}
              </div>
            )}
          </div>

          <div className="p-4 rounded-lg border bg-muted/30">
            <div className="text-xs font-medium text-muted-foreground mb-2">CLOUD</div>
            <div className="text-sm font-medium">v{conflict.remoteVersion}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {formatDate(conflict.remoteUpdatedAt)}
            </div>
            {conflict.remoteDeviceName && (
              <div className="text-xs text-muted-foreground">
                {conflict.remoteDeviceName}
              </div>
            )}
          </div>
        </div>

        <div className="flex gap-3">
          <Button
            variant="outline"
            className="flex-1 gap-2"
            onClick={() => onResolve('USE_LOCAL')}
          >
            <Cloud size={14} />
            Overwrite Cloud (Keep Local)
          </Button>
          <Button
            className="flex-1 gap-2"
            onClick={() => onResolve('USE_REMOTE')}
          >
            <Download size={14} />
            Download Cloud (Overwrite Local)
          </Button>
        </div>
      </div>
    </div>
  );
};

// Import the Download icon
import { Download } from 'lucide-react';

// ============================================================================
// Main Dashboard (UNLOCKED state)
// ============================================================================

interface SyncDashboardProps {
  onBuildPayload: () => SyncPayload;
  onApplyPayload: (payload: SyncPayload) => void;
}

export const SyncDashboard: React.FC<SyncDashboardProps> = ({
  onBuildPayload,
  onApplyPayload,
}) => {
  const sync = useCloudSync();
  
  // GitHub Device Flow state
  const [showGitHubModal, setShowGitHubModal] = useState(false);
  const [gitHubUserCode, setGitHubUserCode] = useState('');
  const [gitHubVerificationUri, setGitHubVerificationUri] = useState('');
  const [isPollingGitHub, setIsPollingGitHub] = useState(false);

  // Conflict modal
  const [_showConflictModal, setShowConflictModal] = useState(false);

  // Handle conflict detection
  useEffect(() => {
    if (sync.currentConflict) {
      setShowConflictModal(true);
    }
  }, [sync.currentConflict]);

  // Connect GitHub
  const handleConnectGitHub = async () => {
    try {
      const deviceFlow = await sync.connectGitHub();
      setGitHubUserCode(deviceFlow.userCode);
      setGitHubVerificationUri(deviceFlow.verificationUri);
      setShowGitHubModal(true);
      setIsPollingGitHub(true);

      await sync.completeGitHubAuth(
        deviceFlow.deviceCode,
        deviceFlow.interval,
        deviceFlow.expiresAt,
        () => {} // onPending callback
      );

      setIsPollingGitHub(false);
      setShowGitHubModal(false);
      toast.success('GitHub connected successfully');
    } catch (error) {
      setIsPollingGitHub(false);
      toast.error(error instanceof Error ? error.message : 'Unknown error', 'GitHub connection failed');
    }
  };

  // Connect Google
  const handleConnectGoogle = async () => {
    try {
      const url = await sync.connectGoogle();
      window.open(url, '_blank', 'width=600,height=700');
      toast.info('Complete authorization in browser');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unknown error', 'Google connection failed');
    }
  };

  // Connect OneDrive
  const handleConnectOneDrive = async () => {
    try {
      const url = await sync.connectOneDrive();
      window.open(url, '_blank', 'width=600,height=700');
      toast.info('Complete authorization in browser');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unknown error', 'OneDrive connection failed');
    }
  };

  // Sync to provider
  const handleSync = async (provider: CloudProvider) => {
    try {
      const payload = onBuildPayload();
      const result = await sync.syncToProvider(provider, payload);
      
      if (result.success) {
        toast.success(`Synced to ${provider}`);
      } else if (result.conflictDetected) {
        // Conflict modal will show automatically
      } else {
        toast.error(result.error || 'Sync failed', 'Sync failed');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unknown error', 'Sync error');
    }
  };

  // Resolve conflict
  const handleResolveConflict = async (resolution: 'USE_LOCAL' | 'USE_REMOTE') => {
    try {
      const payload = await sync.resolveConflict(resolution);
      if (payload && resolution === 'USE_REMOTE') {
        onApplyPayload(payload);
        toast.success('Downloaded cloud data');
      } else if (resolution === 'USE_LOCAL') {
        // Re-sync with local data
        const localPayload = onBuildPayload();
        await sync.syncNow(localPayload);
        toast.success('Uploaded local data');
      }
      setShowConflictModal(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unknown error', 'Conflict resolution failed');
    }
  };

  return (
    <div className="space-y-6">
      {/* Header with status */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-green-500/10 flex items-center justify-center">
            <ShieldCheck className="w-5 h-5 text-green-500" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium">Vault Unlocked</span>
              <StatusDot status="connected" />
            </div>
            <span className="text-xs text-muted-foreground">
              {sync.connectedProviderCount} provider(s) connected
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={sync.lock} className="gap-1">
            <Lock size={14} />
            Lock
          </Button>
          <Button variant="ghost" size="sm" className="gap-1">
            <Key size={14} />
            Change Key
          </Button>
        </div>
      </div>

      {/* Provider Cards */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground">Cloud Providers</h3>
        
        <ProviderCard
          provider="github"
          name="GitHub Gist"
          icon={<Github size={24} />}
          isConnected={sync.providers.github.status === 'connected'}
          isSyncing={sync.providers.github.status === 'syncing'}
          account={sync.providers.github.account}
          lastSync={sync.providers.github.lastSync}
          error={sync.providers.github.error}
          onConnect={handleConnectGitHub}
          onDisconnect={() => sync.disconnectProvider('github')}
          onSync={() => handleSync('github')}
        />

        <ProviderCard
          provider="google"
          name="Google Drive"
          icon={<GoogleDriveIcon className="w-6 h-6" />}
          isConnected={sync.providers.google.status === 'connected'}
          isSyncing={sync.providers.google.status === 'syncing'}
          account={sync.providers.google.account}
          lastSync={sync.providers.google.lastSync}
          error={sync.providers.google.error}
          onConnect={handleConnectGoogle}
          onDisconnect={() => sync.disconnectProvider('google')}
          onSync={() => handleSync('google')}
        />

        <ProviderCard
          provider="onedrive"
          name="Microsoft OneDrive"
          icon={<OneDriveIcon className="w-6 h-6" />}
          isConnected={sync.providers.onedrive.status === 'connected'}
          isSyncing={sync.providers.onedrive.status === 'syncing'}
          account={sync.providers.onedrive.account}
          lastSync={sync.providers.onedrive.lastSync}
          error={sync.providers.onedrive.error}
          onConnect={handleConnectOneDrive}
          onDisconnect={() => sync.disconnectProvider('onedrive')}
          onSync={() => handleSync('onedrive')}
        />
      </div>

      {/* Sync All Button */}
      {sync.hasAnyConnectedProvider && (
        <Button
          onClick={async () => {
            const payload = onBuildPayload();
            await sync.syncNow(payload);
          }}
          disabled={sync.isSyncing}
          className="w-full gap-2"
        >
          {sync.isSyncing ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <RefreshCw size={16} />
          )}
          Sync All Connected Providers
        </Button>
      )}

      {/* Auto-sync Settings */}
      <div className="p-4 rounded-lg border bg-card">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">Auto-sync</div>
            <div className="text-xs text-muted-foreground">
              Automatically sync when changes are made
            </div>
          </div>
          <Toggle
            checked={false}
            onChange={(enabled) => sync.setAutoSync(enabled)}
          />
        </div>
      </div>

      {/* Modals */}
      <GitHubDeviceFlowModal
        isOpen={showGitHubModal}
        userCode={gitHubUserCode}
        verificationUri={gitHubVerificationUri}
        isPolling={isPollingGitHub}
        onClose={() => {
          setShowGitHubModal(false);
          setIsPollingGitHub(false);
        }}
      />

      <ConflictModal
        conflict={sync.currentConflict}
        onResolve={handleResolveConflict}
        onClose={() => setShowConflictModal(false)}
      />
    </div>
  );
};

// ============================================================================
// Main Export - CloudSyncSettings
// ============================================================================

interface CloudSyncSettingsProps {
  onBuildPayload: () => SyncPayload;
  onApplyPayload: (payload: SyncPayload) => void;
}

export const CloudSyncSettings: React.FC<CloudSyncSettingsProps> = (props) => {
  const { securityState } = useCloudSync();
  const [justSetup, setJustSetup] = useState(false);

  // Show appropriate screen based on security state
  if (securityState === 'NO_KEY') {
    return <GatekeeperScreen onSetupComplete={() => setJustSetup(true)} />;
  }

  if (securityState === 'LOCKED' && !justSetup) {
    return <UnlockScreen onUnlock={() => {}} />;
  }

  return <SyncDashboard {...props} />;
};

export default CloudSyncSettings;
