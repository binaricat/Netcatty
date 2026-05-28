/**
 * CloudSyncSettings - End-to-End Encrypted Cloud Sync UI
 * 
 * Handles:
 * - Master key setup (gatekeeper screen)
 * - Provider connections (GitHub, Google, OneDrive)
 * - Sync status and conflict resolution
 */

import React, { useState, useCallback } from 'react';
import {
    AlertTriangle,
    Check,
    Cloud,
    CloudOff,
    Copy,
    Download,
    ExternalLink,
    Eye,
    EyeOff,
    Github,
    Loader2,
    RefreshCw,
    Settings,
    Shield,
    ShieldCheck,
    X,
} from 'lucide-react';


import { useI18n } from '../../application/i18n/I18nProvider';
import { useCloudSync } from '../../application/state/useCloudSync';


import { type CloudProvider, type ConflictInfo } from '../../domain/sync';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { toast } from '../ui/toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

// ============================================================================
// Provider Icons
// ============================================================================

export const GoogleDriveIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
        <path d="M7.71 3.5L1.15 15l3.43 6 6.55-11.5L7.71 3.5zm1.73 0l6.55 11.5H23L16.45 3.5H9.44zM8 15l-3.43 6h13.72l3.43-6H8z" />
    </svg>
);

export const OneDriveIcon: React.FC<{ className?: string }> = ({ className }) => (
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

export const Toggle: React.FC<ToggleProps> = ({ checked, onChange, disabled }) => (
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

export const StatusDot: React.FC<StatusDotProps> = ({ status, className }) => {
    if (status === 'connecting') {
        return <Loader2 className={cn('w-3.5 h-3.5 animate-spin text-muted-foreground', className)} />;
    }

    const colors = {
        connected: 'bg-green-500',
        syncing: 'bg-blue-500 animate-pulse',
        error: 'bg-red-500',
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

export const GatekeeperScreen: React.FC<GatekeeperScreenProps> = ({ onSetupComplete }) => {
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
    onCancelConnect?: () => void;
    onDisconnect: () => void;
    onSync: () => void;
    extraActions?: React.ReactNode;
}

export const ProviderCard: React.FC<ProviderCardProps> = ({
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
    onCancelConnect,
    onDisconnect,
    onSync,
    extraActions,
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
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <p className="text-xs text-red-500 truncate mt-1 max-w-[360px] cursor-help">
                                {error}
                            </p>
                        </TooltipTrigger>
                        <TooltipContent>{error}</TooltipContent>
                    </Tooltip>
                ) : (
                    <p className="text-xs text-muted-foreground mt-1">
                        {isConnecting ? t('cloudSync.provider.connecting') : t('cloudSync.provider.notConnected')}
                    </p>
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
                        {extraActions}
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
                ) : isConnecting && onCancelConnect ? (
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={onCancelConnect}
                        className="gap-1 min-w-[136px] justify-center"
                    >
                        <X size={14} />
                        {t('common.cancel')}
                    </Button>
                ) : (
                    <Button
                        size="sm"
                        onClick={() => { onConnect(); }}
                        className="gap-1 min-w-[136px] justify-center"
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

export const GitHubDeviceFlowModal: React.FC<GitHubDeviceFlowModalProps> = ({
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
                        onClick={() => window.open(verificationUri, "_blank", "noopener,noreferrer")}
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

export const ConflictModal: React.FC<ConflictModalProps> = ({
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
