/**
 * CloudSyncSettings - End-to-End Encrypted Cloud Sync UI
 * 
 * Handles:
 * - Master key setup (gatekeeper screen)
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
    Download,
    Database,
    ExternalLink,
    Eye,
    EyeOff,
    Github,
    HardDrive,
    Key,
    Loader2,
    RefreshCw,
    Settings,
    Server,
    Shield,
    ShieldCheck,
    Trash2,
    X,
} from 'lucide-react';
import { useCloudSync } from '../application/state/useCloudSync';
import { useI18n } from '../application/i18n/I18nProvider';
import type { CloudProvider, ConflictInfo, SyncPayload, WebDAVAuthType, WebDAVConfig, S3Config, SMBConfig } from '../domain/sync';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
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
    const { t } = useI18n();
    const { setupMasterKey } = useCloudSync();
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [acknowledged, setAcknowledged] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const passwordStrength = React.useMemo(() => {
        if (password.length < 8) return { level: 0, text: t('cloudSync.passwordStrength.tooShort') };
        let score = 0;
        if (password.length >= 12) score++;
        if (/[A-Z]/.test(password)) score++;
        if (/[a-z]/.test(password)) score++;
        if (/[0-9]/.test(password)) score++;
        if (/[^A-Za-z0-9]/.test(password)) score++;

        if (score <= 2) return { level: 1, text: t('cloudSync.passwordStrength.weak') };
        if (score <= 3) return { level: 2, text: t('cloudSync.passwordStrength.moderate') };
        if (score <= 4) return { level: 3, text: t('cloudSync.passwordStrength.strong') };
        return { level: 4, text: t('cloudSync.passwordStrength.veryStrong') };
    }, [password, t]);

    const canSubmit = password.length >= 8 && password === confirmPassword && acknowledged;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!canSubmit) return;

        setIsLoading(true);
        setError(null);

        try {
            await setupMasterKey(password, confirmPassword);
            toast.success(t('cloudSync.gate.enabledToast'));
            onSetupComplete();
        } catch (err) {
            setError(err instanceof Error ? err.message : t('cloudSync.gate.setupFailed'));
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
            <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mb-6">
                <Shield className="w-10 h-10 text-primary" />
            </div>

            <h2 className="text-xl font-semibold mb-2">{t('cloudSync.gate.title')}</h2>
            <p className="text-sm text-muted-foreground max-w-md mb-8">
                {t('cloudSync.gate.desc')}
            </p>

            <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
                <div className="space-y-2">
                    <Label className="text-left block">{t('cloudSync.gate.masterKey')}</Label>
                    <div className="relative">
                        <Input
                            type={showPassword ? 'text' : 'password'}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder={t('cloudSync.gate.placeholder')}
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
                    <Label className="text-left block">{t('cloudSync.gate.confirmMasterKey')}</Label>
                    <Input
                        type={showPassword ? 'text' : 'password'}
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder={t('cloudSync.gate.confirmPlaceholder')}
                    />
                    {confirmPassword && password !== confirmPassword && (
                        <p className="text-xs text-red-500 text-left">{t('cloudSync.gate.mismatch')}</p>
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
                        {t('cloudSync.gate.warning')}
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
                    {t('cloudSync.gate.enableVault')}
                </Button>
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
    isConnecting?: boolean;
    account?: { name?: string; email?: string; avatarUrl?: string };
    lastSync?: number;
    error?: string;
    disabled?: boolean; // Disable connect button when another provider is connected
    onEdit?: () => void;
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
    isConnecting,
    account,
    lastSync,
    error,
    disabled,
    onEdit,
    onConnect,
    onDisconnect,
    onSync,
}) => {
    const { t } = useI18n();
    const formatLastSync = (timestamp?: number): string => {
        if (!timestamp) return t('cloudSync.lastSync.never');
        const date = new Date(timestamp);
        const now = new Date();
        const diff = now.getTime() - date.getTime();

        if (diff < 60000) return t('cloudSync.lastSync.justNow');
        if (diff < 3600000) return t('cloudSync.lastSync.minutesAgo', { minutes: Math.floor(diff / 60000) });

        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    const status = error
        ? 'error'
        : isSyncing
            ? 'syncing'
            : isConnected
                ? 'connected'
                : isConnecting
                    ? 'connecting'
                    : 'disconnected';

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
                                referrerPolicy="no-referrer"
                                crossOrigin="anonymous"
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
                    <p
                        className="text-xs text-red-500 truncate mt-1 max-w-[360px] cursor-help"
                        title={error}
                    >
                        {error}
                    </p>
                ) : (
                    <p className="text-xs text-muted-foreground mt-1">{t('cloudSync.provider.notConnected')}</p>
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
                            {t('cloudSync.provider.sync')}
                        </Button>
                        {onEdit && (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={onEdit}
                                className="gap-1"
                            >
                                <Settings size={14} />
                                {t('action.edit')}
                            </Button>
                        )}
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
                    <Button
                        size="sm"
                        onClick={() => { console.log('[ProviderCard] Connect clicked'); onConnect(); }}
                        className="gap-1"
                        disabled={disabled || isConnecting}
                    >
                        {isConnecting ? <Loader2 size={14} className="animate-spin" /> : <Cloud size={14} />}
                        {isConnecting ? t('cloudSync.provider.connecting') : t('cloudSync.provider.connect')}
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
    const { t } = useI18n();
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

                    <h3 className="text-lg font-semibold mb-2">{t('cloudSync.githubFlow.title')}</h3>
                    <p className="text-sm text-muted-foreground mb-6">
                        {t('cloudSync.githubFlow.desc')}
                    </p>

                    <div className="bg-muted rounded-lg p-4 mb-4">
                        <div className="font-mono text-2xl font-bold tracking-widest mb-2">
                            {userCode}
                        </div>
                        <Button size="sm" variant="ghost" onClick={copyCode} className="gap-2">
                            {copied ? <Check size={14} /> : <Copy size={14} />}
                            {copied ? t('cloudSync.githubFlow.copied') : t('cloudSync.githubFlow.copyCode')}
                        </Button>
                    </div>

                    <Button
                        onClick={() => window.open(verificationUri, '_blank')}
                        className="w-full gap-2 mb-4"
                    >
                        <ExternalLink size={14} />
                        {t('cloudSync.githubFlow.openGitHub')}
                    </Button>

                    {isPolling && (
                        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                            <Loader2 size={14} className="animate-spin" />
                            {t('cloudSync.githubFlow.waiting')}
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
    open: boolean;
    conflict: ConflictInfo | null;
    onResolve: (resolution: 'USE_LOCAL' | 'USE_REMOTE') => void;
    onClose: () => void;
}

const ConflictModal: React.FC<ConflictModalProps> = ({
    open,
    conflict,
    onResolve,
    onClose,
}) => {
    const { t, resolvedLocale } = useI18n();

    if (!open || !conflict) return null;

    const formatDate = (timestamp: number) => {
        return new Date(timestamp).toLocaleString(resolvedLocale || undefined);
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
                        <h3 className="text-lg font-semibold">{t('cloudSync.conflict.title')}</h3>
                        <p className="text-sm text-muted-foreground">
                            {t('cloudSync.conflict.desc')}
                        </p>
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-4 mb-6">
                    <div className="p-4 rounded-lg border bg-muted/30">
                        <div className="text-xs font-medium text-muted-foreground mb-2">{t('cloudSync.conflict.local')}</div>
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
                        <div className="text-xs font-medium text-muted-foreground mb-2">{t('cloudSync.conflict.cloud')}</div>
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

                <div className="flex flex-col gap-2">
                    <Button
                        variant="outline"
                        className="w-full gap-2"
                        onClick={() => onResolve('USE_LOCAL')}
                    >
                        <Cloud size={14} />
                        {t('cloudSync.conflict.keepLocal')}
                    </Button>
                    <Button
                        className="w-full gap-2"
                        onClick={() => onResolve('USE_REMOTE')}
                    >
                        <Download size={14} />
                        {t('cloudSync.conflict.useCloud')}
                    </Button>
                </div>
            </div>
        </div>
    );
};

// ============================================================================
// Main Dashboard (UNLOCKED state)
// ============================================================================

interface SyncDashboardProps {
    onBuildPayload: () => SyncPayload;
    onApplyPayload: (payload: SyncPayload) => void;
    onClearLocalData?: () => void;
}

export const SyncDashboard: React.FC<SyncDashboardProps> = ({
    onBuildPayload,
    onApplyPayload,
    onClearLocalData,
}) => {
    const { t, resolvedLocale } = useI18n();
    const sync = useCloudSync();

    const normalizeEndpoint = (value: string): string => {
        const trimmed = value.trim();
        if (!trimmed) return trimmed;
        if (!/^https?:\/\//i.test(trimmed)) {
            return `https://${trimmed}`;
        }
        return trimmed;
    };

    const buildErrorDetails = (
        error: unknown,
        context: Record<string, string | number | boolean | null | undefined>,
    ): string | null => {
        const lines: string[] = [];
        Object.entries(context).forEach(([key, value]) => {
            if (value === undefined || value === null || value === '') return;
            lines.push(`${key}: ${value}`);
        });

        if (error instanceof Error) {
            const err = error as Error & {
                cause?: unknown;
                code?: unknown;
                status?: unknown;
                statusText?: unknown;
            };
            if (err.code) lines.push(`code: ${String(err.code)}`);
            if (err.status) lines.push(`status: ${String(err.status)}`);
            if (err.statusText) lines.push(`statusText: ${String(err.statusText)}`);
            if (err.cause) {
                if (typeof err.cause === 'object') {
                    try {
                        lines.push(`cause: ${JSON.stringify(err.cause, null, 2)}`);
                    } catch {
                        lines.push(`cause: ${String(err.cause)}`);
                    }
                } else {
                    lines.push(`cause: ${String(err.cause)}`);
                }
            }
            if (!lines.length && err.stack) lines.push(err.stack);
        } else if (error) {
            lines.push(`error: ${String(error)}`);
        }

        return lines.length ? lines.join('\n') : null;
    };

    const getNetworkErrorMessage = (error: unknown, fallback: string): string => {
        if (!(error instanceof Error)) return fallback;
        const message = error.message || fallback;
        if (message.includes('UND_ERR_CONNECT_TIMEOUT') || message.includes('Connect Timeout')) {
            return t('cloudSync.connect.github.timeout');
        }
        if (message.toLowerCase().includes('fetch failed')) {
            return t('cloudSync.connect.github.networkError');
        }
        return message;
    };

    const disconnectOtherProviders = async (current: CloudProvider) => {
        const providers: CloudProvider[] = ['github', 'google', 'onedrive', 'webdav', 's3'];
        const isActive = (status: string) => status === 'connected' || status === 'syncing';
        for (const provider of providers) {
            if (provider === current) continue;
            if (isActive(sync.providers[provider].status)) {
                await sync.disconnectProvider(provider);
            }
        }
    };

    // Debug: log provider states
    console.log('[SyncDashboard] Provider states:', {
        github: sync.providers.github.status,
        google: sync.providers.google.status,
        onedrive: sync.providers.onedrive.status,
        webdav: sync.providers.webdav.status,
        s3: sync.providers.s3.status,
    });

    // GitHub Device Flow state
    const [showGitHubModal, setShowGitHubModal] = useState(false);
    const [gitHubUserCode, setGitHubUserCode] = useState('');
    const [gitHubVerificationUri, setGitHubVerificationUri] = useState('');
    const [isPollingGitHub, setIsPollingGitHub] = useState(false);

    // Conflict modal
    const [showConflictModal, setShowConflictModal] = useState(false);

    // Change master key dialog
    const [showChangeKeyDialog, setShowChangeKeyDialog] = useState(false);
    const [currentMasterKey, setCurrentMasterKey] = useState('');
    const [newMasterKey, setNewMasterKey] = useState('');
    const [confirmNewMasterKey, setConfirmNewMasterKey] = useState('');
    const [showMasterKey, setShowMasterKey] = useState(false);
    const [isChangingKey, setIsChangingKey] = useState(false);
    const [changeKeyError, setChangeKeyError] = useState<string | null>(null);

    // One-time unlock prompt (for existing users before password is persisted)
    const [showUnlockDialog, setShowUnlockDialog] = useState(false);
    const [unlockMasterKey, setUnlockMasterKey] = useState('');
    const [showUnlockMasterKey, setShowUnlockMasterKey] = useState(false);
    const [isUnlocking, setIsUnlocking] = useState(false);
    const [unlockError, setUnlockError] = useState<string | null>(null);

    // WebDAV dialog state
    const [showWebdavDialog, setShowWebdavDialog] = useState(false);
    const [webdavEndpoint, setWebdavEndpoint] = useState('');
    const [webdavAuthType, setWebdavAuthType] = useState<WebDAVAuthType>('basic');
    const [webdavUsername, setWebdavUsername] = useState('');
    const [webdavPassword, setWebdavPassword] = useState('');
    const [webdavToken, setWebdavToken] = useState('');
    const [showWebdavSecret, setShowWebdavSecret] = useState(false);
    const [webdavError, setWebdavError] = useState<string | null>(null);
    const [webdavErrorDetail, setWebdavErrorDetail] = useState<string | null>(null);
    const [isSavingWebdav, setIsSavingWebdav] = useState(false);

    // S3 dialog state
    const [showS3Dialog, setShowS3Dialog] = useState(false);
    const [s3Endpoint, setS3Endpoint] = useState('');
    const [s3Region, setS3Region] = useState('');
    const [s3Bucket, setS3Bucket] = useState('');
    const [s3AccessKeyId, setS3AccessKeyId] = useState('');
    const [s3SecretAccessKey, setS3SecretAccessKey] = useState('');
    const [s3SessionToken, setS3SessionToken] = useState('');
    const [s3Prefix, setS3Prefix] = useState('');
    const [s3ForcePathStyle, setS3ForcePathStyle] = useState(true);
    const [showS3Secret, setShowS3Secret] = useState(false);
    const [s3Error, setS3Error] = useState<string | null>(null);
    const [s3ErrorDetail, setS3ErrorDetail] = useState<string | null>(null);
    const [isSavingS3, setIsSavingS3] = useState(false);

    // SMB dialog state
    const [showSmbDialog, setShowSmbDialog] = useState(false);
    const [smbShare, setSmbShare] = useState('');
    const [smbUsername, setSmbUsername] = useState('');
    const [smbPassword, setSmbPassword] = useState('');
    const [smbDomain, setSmbDomain] = useState('');
    const [smbPort, setSmbPort] = useState('');
    const [showSmbSecret, setShowSmbSecret] = useState(false);
    const [smbError, setSmbError] = useState<string | null>(null);
    const [smbErrorDetail, setSmbErrorDetail] = useState<string | null>(null);
    const [isSavingSmb, setIsSavingSmb] = useState(false);

    // Clear local data dialog
    const [showClearLocalDialog, setShowClearLocalDialog] = useState(false);

    // Handle conflict detection
    useEffect(() => {
        if (sync.currentConflict) {
            setShowConflictModal(true);
        }
    }, [sync.currentConflict]);

    // If we have a master key but we're still locked (e.g. older installs),
    // prompt once and persist the password via safeStorage.
    useEffect(() => {
        if (sync.securityState !== 'LOCKED') {
            setShowUnlockDialog(false);
            return;
        }
        if (!sync.hasAnyConnectedProvider && !sync.autoSyncEnabled) {
            return;
        }

        const t = setTimeout(() => setShowUnlockDialog(true), 500);
        return () => clearTimeout(t);
    }, [sync.securityState, sync.hasAnyConnectedProvider, sync.autoSyncEnabled]);

    // Connect GitHub (disconnect others first - single provider only)
    const handleConnectGitHub = async () => {
        console.log('[CloudSync] handleConnectGitHub called');
        try {
            await disconnectOtherProviders('github');
            console.log('[CloudSync] Calling sync.connectGitHub()...');
            const deviceFlow = await sync.connectGitHub();
            console.log('[CloudSync] Device flow received:', deviceFlow.userCode);
            setGitHubUserCode(deviceFlow.userCode);
            setGitHubVerificationUri(deviceFlow.verificationUri);
            setShowGitHubModal(true);
            setIsPollingGitHub(true);

            await sync.completeGitHubAuth(
                deviceFlow.deviceCode,
                deviceFlow.interval,
                deviceFlow.expiresAt,
                () => { } // onPending callback
            );

            setIsPollingGitHub(false);
            setShowGitHubModal(false);
            toast.success(t('cloudSync.connect.github.success'));
        } catch (error) {
            setIsPollingGitHub(false);
            const message = getNetworkErrorMessage(error, t('common.unknownError'));
            toast.error(message, t('cloudSync.connect.github.failedTitle'));
        }
    };

    // Connect Google (disconnect others first - single provider only)
    const handleConnectGoogle = async () => {
        try {
            await disconnectOtherProviders('google');
            await sync.connectGoogle();
            // Note: Auth flow is handled automatically by oauthBridge
            toast.info(t('cloudSync.connect.browserContinue'));
        } catch (error) {
            toast.error(
                error instanceof Error ? error.message : t('common.unknownError'),
                t('cloudSync.connect.google.failedTitle'),
            );
        }
    };

    // Connect OneDrive (disconnect others first - single provider only)
    const handleConnectOneDrive = async () => {
        try {
            await disconnectOtherProviders('onedrive');
            await sync.connectOneDrive();
            // Note: Auth flow is handled automatically by oauthBridge
            toast.info(t('cloudSync.connect.browserContinue'));
        } catch (error) {
            toast.error(
                error instanceof Error ? error.message : t('common.unknownError'),
                t('cloudSync.connect.onedrive.failedTitle'),
            );
        }
    };

    const openWebdavDialog = () => {
        const config = sync.providers.webdav.config as WebDAVConfig | undefined;
        setWebdavEndpoint(config?.endpoint || '');
        setWebdavAuthType(config?.authType || 'basic');
        setWebdavUsername(config?.username || '');
        setWebdavPassword(config?.password || '');
        setWebdavToken(config?.token || '');
        setShowWebdavSecret(false);
        setWebdavError(null);
        setWebdavErrorDetail(null);
        setShowWebdavDialog(true);
    };

    const openS3Dialog = () => {
        const config = sync.providers.s3.config as S3Config | undefined;
        setS3Endpoint(config?.endpoint || '');
        setS3Region(config?.region || '');
        setS3Bucket(config?.bucket || '');
        setS3AccessKeyId(config?.accessKeyId || '');
        setS3SecretAccessKey(config?.secretAccessKey || '');
        setS3SessionToken(config?.sessionToken || '');
        setS3Prefix(config?.prefix || '');
        setS3ForcePathStyle(config?.forcePathStyle ?? true);
        setShowS3Secret(false);
        setS3Error(null);
        setS3ErrorDetail(null);
        setShowS3Dialog(true);
    };

    const openSmbDialog = () => {
        const config = sync.providers.smb.config as SMBConfig | undefined;
        setSmbShare(config?.share || '');
        setSmbUsername(config?.username || '');
        setSmbPassword(config?.password || '');
        setSmbDomain(config?.domain || '');
        setSmbPort(config?.port?.toString() || '');
        setShowSmbSecret(false);
        setSmbError(null);
        setSmbErrorDetail(null);
        setShowSmbDialog(true);
    };

    const handleSaveWebdav = async () => {
        const endpoint = normalizeEndpoint(webdavEndpoint);
        if (!endpoint) {
            setWebdavError(t('cloudSync.webdav.validation.endpoint'));
            setWebdavErrorDetail(null);
            return;
        }

        if (webdavAuthType === 'token') {
            if (!webdavToken.trim()) {
                setWebdavError(t('cloudSync.webdav.validation.token'));
                setWebdavErrorDetail(null);
                return;
            }
        } else {
            if (!webdavUsername.trim() || !webdavPassword) {
                setWebdavError(t('cloudSync.webdav.validation.credentials'));
                setWebdavErrorDetail(null);
                return;
            }
        }

        const config: WebDAVConfig = {
            endpoint,
            authType: webdavAuthType,
            username: webdavAuthType === 'token' ? undefined : webdavUsername.trim(),
            password: webdavAuthType === 'token' ? undefined : webdavPassword,
            token: webdavAuthType === 'token' ? webdavToken.trim() : undefined,
        };

        setIsSavingWebdav(true);
        setWebdavError(null);
        setWebdavErrorDetail(null);
        try {
            await disconnectOtherProviders('webdav');
            await sync.connectWebDAV(config);
            toast.success(t('cloudSync.connect.webdav.success'));
            setShowWebdavDialog(false);
        } catch (error) {
            const message = error instanceof Error ? error.message : t('common.unknownError');
            setWebdavError(message);
            setWebdavErrorDetail(buildErrorDetails(error, { endpoint, authType: webdavAuthType }));
            toast.error(message, t('cloudSync.connect.webdav.failedTitle'));
        } finally {
            setIsSavingWebdav(false);
        }
    };

    const handleSaveS3 = async () => {
        const endpoint = normalizeEndpoint(s3Endpoint);
        if (!endpoint || !s3Region.trim() || !s3Bucket.trim() || !s3AccessKeyId.trim() || !s3SecretAccessKey) {
            setS3Error(t('cloudSync.s3.validation.required'));
            setS3ErrorDetail(null);
            return;
        }

        const config: S3Config = {
            endpoint,
            region: s3Region.trim(),
            bucket: s3Bucket.trim(),
            accessKeyId: s3AccessKeyId.trim(),
            secretAccessKey: s3SecretAccessKey,
            sessionToken: s3SessionToken.trim() ? s3SessionToken.trim() : undefined,
            prefix: s3Prefix.trim() ? s3Prefix.trim() : undefined,
            forcePathStyle: s3ForcePathStyle,
        };

        setIsSavingS3(true);
        setS3Error(null);
        setS3ErrorDetail(null);
        try {
            await disconnectOtherProviders('s3');
            await sync.connectS3(config);
            toast.success(t('cloudSync.connect.s3.success'));
            setShowS3Dialog(false);
        } catch (error) {
            const message = error instanceof Error ? error.message : t('common.unknownError');
            setS3Error(message);
            setS3ErrorDetail(
                buildErrorDetails(error, {
                    endpoint,
                    region: s3Region.trim(),
                    bucket: s3Bucket.trim(),
                    forcePathStyle: s3ForcePathStyle,
                }),
            );
            toast.error(message, t('cloudSync.connect.s3.failedTitle'));
        } finally {
            setIsSavingS3(false);
        }
    };

    const handleSaveSmb = async () => {
        if (!smbShare.trim()) {
            setSmbError(t('cloudSync.smb.validation.share'));
            setSmbErrorDetail(null);
            return;
        }

        // Validate port if provided
        let parsedPort: number | undefined;
        if (smbPort.trim()) {
            const portNum = parseInt(smbPort.trim(), 10);
            if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
                setSmbError(t('cloudSync.smb.validation.port'));
                setSmbErrorDetail(null);
                return;
            }
            parsedPort = portNum;
        }

        const config: SMBConfig = {
            share: smbShare.trim(),
            username: smbUsername.trim() || undefined,
            password: smbPassword || undefined,
            domain: smbDomain.trim() || undefined,
            port: parsedPort,
        };

        setIsSavingSmb(true);
        setSmbError(null);
        setSmbErrorDetail(null);
        try {
            await disconnectOtherProviders('smb');
            await sync.connectSMB(config);
            toast.success(t('cloudSync.connect.smb.success'));
            setShowSmbDialog(false);
        } catch (error) {
            const message = error instanceof Error ? error.message : t('common.unknownError');
            setSmbError(message);
            setSmbErrorDetail(
                buildErrorDetails(error, {
                    share: smbShare.trim(),
                    domain: smbDomain.trim() || null,
                }),
            );
            toast.error(message, t('cloudSync.connect.smb.failedTitle'));
        } finally {
            setIsSavingSmb(false);
        }
    };

    // Sync to provider
    const handleSync = async (provider: CloudProvider) => {
        try {
            const payload = onBuildPayload();
            const result = await sync.syncToProvider(provider, payload);

            if (result.success) {
                toast.success(t('cloudSync.sync.success', { provider }));
            } else if (result.conflictDetected) {
                // Conflict modal will show automatically
            } else {
                toast.error(result.error || t('cloudSync.sync.failed'), t('cloudSync.sync.failedTitle'));
            }
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t('common.unknownError'), t('cloudSync.sync.errorTitle'));
        }
    };

    // Resolve conflict
    const handleResolveConflict = async (resolution: 'USE_LOCAL' | 'USE_REMOTE') => {
        try {
            const payload = await sync.resolveConflict(resolution);
            if (payload && resolution === 'USE_REMOTE') {
                onApplyPayload(payload);
                toast.success(t('cloudSync.resolve.downloaded'));
            } else if (resolution === 'USE_LOCAL') {
                // Re-sync with local data
                const localPayload = onBuildPayload();
                await sync.syncNow(localPayload);
                toast.success(t('cloudSync.resolve.uploaded'));
            }
            setShowConflictModal(false);
        } catch (error) {
            toast.error(
                error instanceof Error ? error.message : t('common.unknownError'),
                t('cloudSync.resolve.failedTitle'),
            );
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
                            <span className="font-medium">
                                {sync.isUnlocked ? t('cloudSync.header.vaultReady') : t('cloudSync.header.preparingVault')}
                            </span>
                            <StatusDot status={sync.isUnlocked ? 'connected' : 'connecting'} />
                        </div>
                        <span className="text-xs text-muted-foreground">
                            {t('cloudSync.header.providersConnected', { count: sync.connectedProviderCount })}
                        </span>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1"
                        onClick={() => {
                            setChangeKeyError(null);
                            setCurrentMasterKey('');
                            setNewMasterKey('');
                            setConfirmNewMasterKey('');
                            setShowMasterKey(false);
                            setShowChangeKeyDialog(true);
                        }}
                    >
                        <Key size={14} />
                        {t('cloudSync.changeKey')}
                    </Button>
                </div>
            </div>

            <Tabs defaultValue="providers" className="space-y-4">
                <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="providers">{t('cloudSync.providers.title')}</TabsTrigger>
                    <TabsTrigger value="status">{t('cloudSync.status.title')}</TabsTrigger>
                </TabsList>

                <TabsContent value="providers" className="space-y-3">
                    <ProviderCard
                        provider="github"
                        name="GitHub Gist"
                        icon={<Github size={24} />}
                    isConnected={sync.providers.github.status === 'connected' || sync.providers.github.status === 'syncing'}
                    isSyncing={sync.providers.github.status === 'syncing'}
                    isConnecting={sync.providers.github.status === 'connecting'}
                    account={sync.providers.github.account}
                    lastSync={sync.providers.github.lastSync}
                    error={sync.providers.github.error}
                    disabled={sync.hasAnyConnectedProvider && sync.providers.github.status !== 'connected' && sync.providers.github.status !== 'syncing'}
                        onConnect={handleConnectGitHub}
                        onDisconnect={() => sync.disconnectProvider('github')}
                        onSync={() => handleSync('github')}
                    />

                    <ProviderCard
                        provider="google"
                        name="Google Drive"
                        icon={<GoogleDriveIcon className="w-6 h-6" />}
                    isConnected={sync.providers.google.status === 'connected' || sync.providers.google.status === 'syncing'}
                    isSyncing={sync.providers.google.status === 'syncing'}
                    isConnecting={sync.providers.google.status === 'connecting'}
                    account={sync.providers.google.account}
                    lastSync={sync.providers.google.lastSync}
                    error={sync.providers.google.error}
                    disabled={sync.hasAnyConnectedProvider && sync.providers.google.status !== 'connected' && sync.providers.google.status !== 'syncing'}
                        onConnect={handleConnectGoogle}
                        onDisconnect={() => sync.disconnectProvider('google')}
                        onSync={() => handleSync('google')}
                    />

                    <ProviderCard
                        provider="onedrive"
                        name="Microsoft OneDrive"
                        icon={<OneDriveIcon className="w-6 h-6" />}
                    isConnected={sync.providers.onedrive.status === 'connected' || sync.providers.onedrive.status === 'syncing'}
                    isSyncing={sync.providers.onedrive.status === 'syncing'}
                    isConnecting={sync.providers.onedrive.status === 'connecting'}
                    account={sync.providers.onedrive.account}
                    lastSync={sync.providers.onedrive.lastSync}
                    error={sync.providers.onedrive.error}
                    disabled={sync.hasAnyConnectedProvider && sync.providers.onedrive.status !== 'connected' && sync.providers.onedrive.status !== 'syncing'}
                        onConnect={handleConnectOneDrive}
                        onDisconnect={() => sync.disconnectProvider('onedrive')}
                        onSync={() => handleSync('onedrive')}
                    />

                    <ProviderCard
                        provider="webdav"
                        name={t('cloudSync.provider.webdav')}
                        icon={<Server size={24} />}
                    isConnected={sync.providers.webdav.status === 'connected' || sync.providers.webdav.status === 'syncing'}
                    isSyncing={sync.providers.webdav.status === 'syncing'}
                    isConnecting={sync.providers.webdav.status === 'connecting'}
                    account={sync.providers.webdav.account}
                    lastSync={sync.providers.webdav.lastSync}
                    error={sync.providers.webdav.error}
                    disabled={sync.hasAnyConnectedProvider && sync.providers.webdav.status !== 'connected' && sync.providers.webdav.status !== 'syncing'}
                        onEdit={openWebdavDialog}
                        onConnect={openWebdavDialog}
                        onDisconnect={() => sync.disconnectProvider('webdav')}
                        onSync={() => handleSync('webdav')}
                    />

                    <ProviderCard
                        provider="s3"
                        name={t('cloudSync.provider.s3')}
                        icon={<Database size={24} />}
                    isConnected={sync.providers.s3.status === 'connected' || sync.providers.s3.status === 'syncing'}
                    isSyncing={sync.providers.s3.status === 'syncing'}
                    isConnecting={sync.providers.s3.status === 'connecting'}
                    account={sync.providers.s3.account}
                    lastSync={sync.providers.s3.lastSync}
                    error={sync.providers.s3.error}
                    disabled={sync.hasAnyConnectedProvider && sync.providers.s3.status !== 'connected' && sync.providers.s3.status !== 'syncing'}
                        onEdit={openS3Dialog}
                        onConnect={openS3Dialog}
                        onDisconnect={() => sync.disconnectProvider('s3')}
                        onSync={() => handleSync('s3')}
                    />

                    <ProviderCard
                        provider="smb"
                        name={t('cloudSync.provider.smb')}
                        icon={<HardDrive size={24} />}
                    isConnected={sync.providers.smb.status === 'connected' || sync.providers.smb.status === 'syncing'}
                    isSyncing={sync.providers.smb.status === 'syncing'}
                    isConnecting={sync.providers.smb.status === 'connecting'}
                    account={sync.providers.smb.account}
                    lastSync={sync.providers.smb.lastSync}
                    error={sync.providers.smb.error}
                    disabled={sync.hasAnyConnectedProvider && sync.providers.smb.status !== 'connected' && sync.providers.smb.status !== 'syncing'}
                        onEdit={openSmbDialog}
                        onConnect={openSmbDialog}
                        onDisconnect={() => sync.disconnectProvider('smb')}
                        onSync={() => handleSync('smb')}
                    />
                </TabsContent>

                <TabsContent value="status" className="space-y-4">
                    <div className="p-4 rounded-lg border bg-card">
                        <div className="flex items-center justify-between">
                            <div>
                                <div className="text-sm font-medium">{t('cloudSync.autoSync.title')}</div>
                                <div className="text-xs text-muted-foreground">
                                    {t('cloudSync.autoSync.desc')}
                                </div>
                            </div>
                            <Toggle
                                checked={sync.autoSyncEnabled}
                                onChange={(enabled) => sync.setAutoSync(enabled)}
                                disabled={!sync.hasAnyConnectedProvider}
                            />
                        </div>
                    </div>

                    {sync.hasAnyConnectedProvider && (
                        <div className="space-y-3">
                            {/* Version Info Cards */}
                            <div className="grid grid-cols-2 gap-3">
                                <div className="p-3 rounded-lg border bg-card">
                                    <div className="text-xs text-muted-foreground mb-1">{t('cloudSync.status.localVersion')}</div>
                                    <div className="text-lg font-semibold">v{sync.localVersion}</div>
                                    <div className="text-xs text-muted-foreground">
                                        {sync.localUpdatedAt
                                            ? new Date(sync.localUpdatedAt).toLocaleString(resolvedLocale || undefined)
                                            : t('cloudSync.lastSync.never')}
                                    </div>
                                </div>
                                <div className="p-3 rounded-lg border bg-card">
                                    <div className="text-xs text-muted-foreground mb-1">{t('cloudSync.status.remoteVersion')}</div>
                                    <div className="text-lg font-semibold">v{sync.remoteVersion}</div>
                                    <div className="text-xs text-muted-foreground">
                                        {sync.remoteUpdatedAt
                                            ? new Date(sync.remoteUpdatedAt).toLocaleString(resolvedLocale || undefined)
                                            : t('cloudSync.lastSync.never')}
                                    </div>
                                </div>
                            </div>

                            {/* Sync History */}
                            {sync.syncHistory.length > 0 && (
                                <div className="rounded-lg border bg-card">
                                    <div className="px-3 py-2 border-b border-border/60">
                                        <div className="text-sm font-medium">{t('cloudSync.history.title')}</div>
                                    </div>
                                    <div className="max-h-48 overflow-y-auto">
                                        {sync.syncHistory.slice(0, 10).map((entry) => (
                                            <div key={entry.id} className="px-3 py-2 flex items-center gap-2 border-b border-border/30 last:border-b-0">
                                                <div className={cn(
                                                    "w-2 h-2 rounded-full shrink-0",
                                                    entry.success ? "bg-green-500" : "bg-red-500"
                                                )} />
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-xs font-medium capitalize">
                                                            {entry.action === 'upload'
                                                                ? t('cloudSync.history.upload')
                                                                : entry.action === 'download'
                                                                    ? t('cloudSync.history.download')
                                                                    : t('cloudSync.history.resolved')}
                                                        </span>
                                                        <span className="text-xs text-muted-foreground">
                                                            v{entry.localVersion}
                                                        </span>
                                                    </div>
                                                    <div className="text-[10px] text-muted-foreground truncate">
                                                        {new Date(entry.timestamp).toLocaleString(resolvedLocale || undefined)}
                                                        {entry.deviceName && ` · ${entry.deviceName}`}
                                                    </div>
                                                </div>
                                                {entry.error && (
                                                    <span className="text-xs text-red-500 truncate max-w-24" title={entry.error}>
                                                        {t('cloudSync.history.error')}
                                                    </span>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Clear Local Data */}
                    <div className="p-4 rounded-lg border border-destructive/30 bg-destructive/5">
                        <div className="flex items-center justify-between">
                            <div>
                                <div className="text-sm font-medium">{t('cloudSync.clearLocal.title')}</div>
                                <div className="text-xs text-muted-foreground">
                                    {t('cloudSync.clearLocal.desc')}
                                </div>
                            </div>
                            <Button
                                variant="destructive"
                                size="sm"
                                onClick={() => setShowClearLocalDialog(true)}
                            >
                                <Trash2 size={14} className="mr-1" />
                                {t('cloudSync.clearLocal.button')}
                            </Button>
                        </div>
                    </div>
                </TabsContent>
            </Tabs>

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
                open={showConflictModal}
                conflict={sync.currentConflict}
                onResolve={handleResolveConflict}
                onClose={() => setShowConflictModal(false)}
            />

            <Dialog open={showWebdavDialog} onOpenChange={setShowWebdavDialog}>
                <DialogContent className="sm:max-w-[460px] max-h-[80vh] overflow-y-auto z-[70]">
                    <DialogHeader>
                        <DialogTitle>{t('cloudSync.webdav.title')}</DialogTitle>
                        <DialogDescription>{t('cloudSync.webdav.desc')}</DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label>{t('cloudSync.webdav.endpoint')}</Label>
                            <Input
                                value={webdavEndpoint}
                                onChange={(e) => setWebdavEndpoint(e.target.value)}
                                placeholder="https://dav.example.com/remote.php/webdav/"
                            />
                        </div>

                        <div className="space-y-2">
                            <Label>{t('cloudSync.webdav.authType')}</Label>
                            <Select value={webdavAuthType} onValueChange={(value) => setWebdavAuthType(value as WebDAVAuthType)}>
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="basic">{t('cloudSync.webdav.auth.basic')}</SelectItem>
                                    <SelectItem value="digest">{t('cloudSync.webdav.auth.digest')}</SelectItem>
                                    <SelectItem value="token">{t('cloudSync.webdav.auth.token')}</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>

                        {webdavAuthType !== 'token' ? (
                            <>
                                <div className="space-y-2">
                                    <Label>{t('cloudSync.webdav.username')}</Label>
                                    <Input
                                        value={webdavUsername}
                                        onChange={(e) => setWebdavUsername(e.target.value)}
                                        autoComplete="username"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label>{t('cloudSync.webdav.password')}</Label>
                                    <Input
                                        type={showWebdavSecret ? 'text' : 'password'}
                                        value={webdavPassword}
                                        onChange={(e) => setWebdavPassword(e.target.value)}
                                        autoComplete="current-password"
                                    />
                                </div>
                            </>
                        ) : (
                            <div className="space-y-2">
                                <Label>{t('cloudSync.webdav.token')}</Label>
                                <Input
                                    type={showWebdavSecret ? 'text' : 'password'}
                                    value={webdavToken}
                                    onChange={(e) => setWebdavToken(e.target.value)}
                                />
                            </div>
                        )}

                        <label className="flex items-center gap-2 text-sm text-muted-foreground select-none">
                            <input
                                type="checkbox"
                                checked={showWebdavSecret}
                                onChange={(e) => setShowWebdavSecret(e.target.checked)}
                                className="accent-primary"
                            />
                            {t('cloudSync.webdav.showSecret')}
                        </label>

                        {webdavError && (
                            <p className="text-sm text-red-500">{webdavError}</p>
                        )}
                        {webdavErrorDetail && (
                            <pre className="text-xs text-red-400 whitespace-pre-wrap rounded-md border border-red-500/30 bg-red-500/10 p-2">
                                {webdavErrorDetail}
                            </pre>
                        )}
                    </div>

                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setShowWebdavDialog(false)}
                            disabled={isSavingWebdav}
                        >
                            {t('common.cancel')}
                        </Button>
                        <Button
                            onClick={handleSaveWebdav}
                            disabled={isSavingWebdav}
                            className="gap-2"
                        >
                            {isSavingWebdav ? <Loader2 size={16} className="animate-spin" /> : <Cloud size={16} />}
                            {t('common.save')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={showS3Dialog} onOpenChange={setShowS3Dialog}>
                <DialogContent className="sm:max-w-[520px] max-h-[80vh] overflow-y-auto z-[70]">
                    <DialogHeader>
                        <DialogTitle>{t('cloudSync.s3.title')}</DialogTitle>
                        <DialogDescription>{t('cloudSync.s3.desc')}</DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label>{t('cloudSync.s3.endpoint')}</Label>
                            <Input
                                value={s3Endpoint}
                                onChange={(e) => setS3Endpoint(e.target.value)}
                                placeholder="https://s3.example.com"
                            />
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-2">
                                <Label>{t('cloudSync.s3.region')}</Label>
                                <Input
                                    value={s3Region}
                                    onChange={(e) => setS3Region(e.target.value)}
                                    placeholder="us-east-1"
                                />
                            </div>
                            <div className="space-y-2">
                                <Label>{t('cloudSync.s3.bucket')}</Label>
                                <Input
                                    value={s3Bucket}
                                    onChange={(e) => setS3Bucket(e.target.value)}
                                    placeholder="netcatty-backups"
                                />
                            </div>
                        </div>

                        <div className="space-y-2">
                            <Label>{t('cloudSync.s3.accessKeyId')}</Label>
                            <Input
                                value={s3AccessKeyId}
                                onChange={(e) => setS3AccessKeyId(e.target.value)}
                                autoComplete="off"
                            />
                        </div>

                        <div className="space-y-2">
                            <Label>{t('cloudSync.s3.secretAccessKey')}</Label>
                            <Input
                                type={showS3Secret ? 'text' : 'password'}
                                value={s3SecretAccessKey}
                                onChange={(e) => setS3SecretAccessKey(e.target.value)}
                                autoComplete="off"
                            />
                        </div>

                        <div className="space-y-2">
                            <Label>{t('cloudSync.s3.sessionToken')}</Label>
                            <Input
                                type={showS3Secret ? 'text' : 'password'}
                                value={s3SessionToken}
                                onChange={(e) => setS3SessionToken(e.target.value)}
                                autoComplete="off"
                            />
                        </div>

                        <div className="space-y-2">
                            <Label>{t('cloudSync.s3.prefix')}</Label>
                            <Input
                                value={s3Prefix}
                                onChange={(e) => setS3Prefix(e.target.value)}
                                placeholder="backups/netcatty"
                            />
                        </div>

                        <label className="flex items-center gap-2 text-sm text-muted-foreground select-none">
                            <input
                                type="checkbox"
                                checked={s3ForcePathStyle}
                                onChange={(e) => setS3ForcePathStyle(e.target.checked)}
                                className="accent-primary"
                            />
                            {t('cloudSync.s3.forcePathStyle')}
                        </label>

                        <label className="flex items-center gap-2 text-sm text-muted-foreground select-none">
                            <input
                                type="checkbox"
                                checked={showS3Secret}
                                onChange={(e) => setShowS3Secret(e.target.checked)}
                                className="accent-primary"
                            />
                            {t('cloudSync.s3.showSecret')}
                        </label>

                        {s3Error && (
                            <p className="text-sm text-red-500">{s3Error}</p>
                        )}
                        {s3ErrorDetail && (
                            <pre className="text-xs text-red-400 whitespace-pre-wrap rounded-md border border-red-500/30 bg-red-500/10 p-2">
                                {s3ErrorDetail}
                            </pre>
                        )}
                    </div>

                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setShowS3Dialog(false)}
                            disabled={isSavingS3}
                        >
                            {t('common.cancel')}
                        </Button>
                        <Button
                            onClick={handleSaveS3}
                            disabled={isSavingS3}
                            className="gap-2"
                        >
                            {isSavingS3 ? <Loader2 size={16} className="animate-spin" /> : <Database size={16} />}
                            {t('common.save')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={showSmbDialog} onOpenChange={setShowSmbDialog}>
                <DialogContent className="sm:max-w-[460px] max-h-[80vh] overflow-y-auto z-[70]">
                    <DialogHeader>
                        <DialogTitle>{t('cloudSync.smb.title')}</DialogTitle>
                        <DialogDescription>{t('cloudSync.smb.desc')}</DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label>{t('cloudSync.smb.share')}</Label>
                            <Input
                                value={smbShare}
                                onChange={(e) => setSmbShare(e.target.value)}
                                placeholder="//server/share or smb://server/share"
                            />
                        </div>

                        <div className="space-y-2">
                            <Label>{t('cloudSync.smb.username')}</Label>
                            <Input
                                value={smbUsername}
                                onChange={(e) => setSmbUsername(e.target.value)}
                                autoComplete="username"
                            />
                        </div>

                        <div className="space-y-2">
                            <Label>{t('cloudSync.smb.password')}</Label>
                            <Input
                                type={showSmbSecret ? 'text' : 'password'}
                                value={smbPassword}
                                onChange={(e) => setSmbPassword(e.target.value)}
                                autoComplete="current-password"
                            />
                        </div>

                        <div className="space-y-2">
                            <Label>{t('cloudSync.smb.domain')}</Label>
                            <Input
                                value={smbDomain}
                                onChange={(e) => setSmbDomain(e.target.value)}
                                placeholder={t('cloudSync.smb.domainPlaceholder')}
                            />
                        </div>

                        <div className="space-y-2">
                            <Label>{t('cloudSync.smb.port')}</Label>
                            <Input
                                type="number"
                                value={smbPort}
                                onChange={(e) => setSmbPort(e.target.value)}
                                placeholder="445"
                            />
                        </div>

                        <label className="flex items-center gap-2 text-sm text-muted-foreground select-none">
                            <input
                                type="checkbox"
                                checked={showSmbSecret}
                                onChange={(e) => setShowSmbSecret(e.target.checked)}
                                className="accent-primary"
                            />
                            {t('cloudSync.smb.showSecret')}
                        </label>

                        {smbError && (
                            <p className="text-sm text-red-500">{smbError}</p>
                        )}
                        {smbErrorDetail && (
                            <pre className="text-xs text-red-400 whitespace-pre-wrap rounded-md border border-red-500/30 bg-red-500/10 p-2">
                                {smbErrorDetail}
                            </pre>
                        )}
                    </div>

                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setShowSmbDialog(false)}
                            disabled={isSavingSmb}
                        >
                            {t('common.cancel')}
                        </Button>
                        <Button
                            onClick={handleSaveSmb}
                            disabled={isSavingSmb}
                            className="gap-2"
                        >
                            {isSavingSmb ? <Loader2 size={16} className="animate-spin" /> : <HardDrive size={16} />}
                            {t('common.save')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={showChangeKeyDialog} onOpenChange={setShowChangeKeyDialog}>
                <DialogContent className="sm:max-w-[420px]">
                    <DialogHeader>
                        <DialogTitle>{t('cloudSync.changeKey.title')}</DialogTitle>
                        <DialogDescription>
                            {t('cloudSync.changeKey.desc')}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label>{t('cloudSync.changeKey.current')}</Label>
                            <Input
                                type={showMasterKey ? 'text' : 'password'}
                                value={currentMasterKey}
                                onChange={(e) => setCurrentMasterKey(e.target.value)}
                                placeholder={t('cloudSync.changeKey.currentPlaceholder')}
                                autoFocus
                            />
                        </div>

                        <div className="space-y-2">
                            <Label>{t('cloudSync.changeKey.new')}</Label>
                            <Input
                                type={showMasterKey ? 'text' : 'password'}
                                value={newMasterKey}
                                onChange={(e) => setNewMasterKey(e.target.value)}
                                placeholder={t('cloudSync.changeKey.newPlaceholder')}
                            />
                        </div>

                        <div className="space-y-2">
                            <Label>{t('cloudSync.changeKey.confirmNew')}</Label>
                            <Input
                                type={showMasterKey ? 'text' : 'password'}
                                value={confirmNewMasterKey}
                                onChange={(e) => setConfirmNewMasterKey(e.target.value)}
                                placeholder={t('cloudSync.changeKey.confirmPlaceholder')}
                            />
                        </div>

                        <label className="flex items-center gap-2 text-sm text-muted-foreground select-none">
                            <input
                                type="checkbox"
                                checked={showMasterKey}
                                onChange={(e) => setShowMasterKey(e.target.checked)}
                                className="accent-primary"
                            />
                            {t('cloudSync.changeKey.showKeys')}
                        </label>

                        {changeKeyError && (
                            <p className="text-sm text-red-500">{changeKeyError}</p>
                        )}
                    </div>

                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setShowChangeKeyDialog(false)}
                            disabled={isChangingKey}
                        >
                            {t('common.cancel')}
                        </Button>
                        <Button
                            onClick={async () => {
                                setChangeKeyError(null);
                                if (!currentMasterKey || !newMasterKey || !confirmNewMasterKey) {
                                    setChangeKeyError(t('cloudSync.changeKey.fillAll'));
                                    return;
                                }
                                if (newMasterKey.length < 8) {
                                    setChangeKeyError(t('cloudSync.changeKey.minLength'));
                                    return;
                                }
                                if (newMasterKey !== confirmNewMasterKey) {
                                    setChangeKeyError(t('cloudSync.changeKey.notMatch'));
                                    return;
                                }

                                setIsChangingKey(true);
                                try {
                                    const ok = await sync.changeMasterKey(currentMasterKey, newMasterKey);
                                    if (!ok) {
                                        setChangeKeyError(t('cloudSync.changeKey.incorrectCurrent'));
                                        return;
                                    }

                                    if (sync.hasAnyConnectedProvider) {
                                        const payload = onBuildPayload();
                                        await sync.syncNow(payload);
                                    }

                                    toast.success(t('cloudSync.changeKey.updatedToast'));
                                    setShowChangeKeyDialog(false);
                                } catch (error) {
                                    setChangeKeyError(error instanceof Error ? error.message : t('cloudSync.changeKey.failed'));
                                } finally {
                                    setIsChangingKey(false);
                                }
                            }}
                            disabled={isChangingKey}
                            className="gap-2"
                        >
                            {isChangingKey ? <Loader2 size={16} className="animate-spin" /> : <Key size={16} />}
                            {t('cloudSync.changeKey.updateButton')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={showUnlockDialog} onOpenChange={setShowUnlockDialog}>
                <DialogContent className="sm:max-w-[420px]">
                    <DialogHeader>
                        <DialogTitle>{t('cloudSync.unlock.title')}</DialogTitle>
                        <DialogDescription>
                            {t('cloudSync.unlock.desc')}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label>{t('cloudSync.unlock.masterKey')}</Label>
                            <Input
                                type={showUnlockMasterKey ? 'text' : 'password'}
                                value={unlockMasterKey}
                                onChange={(e) => setUnlockMasterKey(e.target.value)}
                                placeholder={t('cloudSync.unlock.placeholder')}
                                autoFocus
                            />
                        </div>

                        <label className="flex items-center gap-2 text-sm text-muted-foreground select-none">
                            <input
                                type="checkbox"
                                checked={showUnlockMasterKey}
                                onChange={(e) => setShowUnlockMasterKey(e.target.checked)}
                                className="accent-primary"
                            />
                            {t('cloudSync.unlock.showKey')}
                        </label>

                        {unlockError && (
                            <p className="text-sm text-red-500">{unlockError}</p>
                        )}
                    </div>

                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setShowUnlockDialog(false)}
                            disabled={isUnlocking}
                        >
                            {t('cloudSync.unlock.notNow')}
                        </Button>
                        <Button
                            onClick={async () => {
                                setUnlockError(null);
                                if (!unlockMasterKey) {
                                    setUnlockError(t('cloudSync.unlock.empty'));
                                    return;
                                }
                                setIsUnlocking(true);
                                try {
                                    const ok = await sync.unlock(unlockMasterKey);
                                    if (!ok) {
                                        setUnlockError(t('cloudSync.unlock.incorrect'));
                                        return;
                                    }
                                    toast.success(t('cloudSync.unlock.readyToast'));
                                    setShowUnlockDialog(false);
                                    setUnlockMasterKey('');
                                } catch (error) {
                                    setUnlockError(error instanceof Error ? error.message : t('cloudSync.unlock.failed'));
                                } finally {
                                    setIsUnlocking(false);
                                }
                            }}
                            disabled={isUnlocking}
                            className="gap-2"
                        >
                            {isUnlocking ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
                            {t('cloudSync.unlock.unlockButton')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Clear Local Data Confirmation Dialog */}
            <Dialog open={showClearLocalDialog} onOpenChange={setShowClearLocalDialog}>
                <DialogContent className="sm:max-w-[400px] z-[70]">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2 text-destructive">
                            <AlertTriangle size={20} />
                            {t('cloudSync.clearLocal.dialog.title')}
                        </DialogTitle>
                        <DialogDescription>
                            {t('cloudSync.clearLocal.dialog.desc')}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="gap-2 sm:gap-0">
                        <Button
                            variant="outline"
                            onClick={() => setShowClearLocalDialog(false)}
                        >
                            {t('cloudSync.clearLocal.dialog.cancel')}
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={() => {
                                onClearLocalData?.();
                                sync.resetLocalVersion();
                                setShowClearLocalDialog(false);
                                toast.success(t('cloudSync.clearLocal.toast.desc'), t('cloudSync.clearLocal.toast.title'));
                            }}
                        >
                            <Trash2 size={14} className="mr-1" />
                            {t('cloudSync.clearLocal.dialog.confirm')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
};

// ============================================================================
// Main Export - CloudSyncSettings
// ============================================================================

interface CloudSyncSettingsProps {
    onBuildPayload: () => SyncPayload;
    onApplyPayload: (payload: SyncPayload) => void;
    onClearLocalData?: () => void;
}

export const CloudSyncSettings: React.FC<CloudSyncSettingsProps> = (props) => {
    const { securityState } = useCloudSync();
    
    // Simplified UX: once a master key is configured, we auto-unlock via safeStorage
    // so users don't have to manage a separate LOCKED screen.
    if (securityState === 'NO_KEY') {
        return <GatekeeperScreen onSetupComplete={() => { }} />;
    }

    return <SyncDashboard {...props} />;
};

export default CloudSyncSettings;
