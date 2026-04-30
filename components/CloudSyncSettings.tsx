/**
 * CloudSyncSettings - End-to-End Encrypted Cloud Sync UI
 * 
 * Handles:
 * - Master key setup (gatekeeper screen)
 * - Provider connections (GitHub, Google, OneDrive)
 * - Sync status and conflict resolution
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
    AlertTriangle,
    Check,
    Cloud,
    CloudOff,
    Copy,
    Download,
    Database,
    ExternalLink,
    FolderOpen,
    Eye,
    EyeOff,
    Github,
    Key,
    Loader2,
    History,
    RefreshCw,
    Settings,
    Server,
    Shield,
    ShieldCheck,
    Trash2,
    X,
} from 'lucide-react';
import { useCloudSync } from '../application/state/useCloudSync';
import { useLocalVaultBackups } from '../application/state/useLocalVaultBackups';
import {
    MAX_LOCAL_VAULT_BACKUP_MAX_COUNT,
    MIN_LOCAL_VAULT_BACKUP_MAX_COUNT,
    withRestoreBarrier,
} from '../application/localVaultBackups';
import { useI18n } from '../application/i18n/I18nProvider';
import {
    findSyncPayloadEncryptedCredentialPaths,
} from '../domain/credentials';
import { isProviderReadyForSync, type CloudProvider, type ConflictInfo, type SyncPayload, type SyncResult, type WebDAVAuthType, type WebDAVConfig, type S3Config } from '../domain/sync';
import type { ShrinkFinding } from '../domain/syncGuards';
import { SyncBlockedBanner } from './sync/SyncBlockedBanner';
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
    onCancelConnect?: () => void;
    onDisconnect: () => void;
    onSync: () => void;
    extraActions?: React.ReactNode;
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
                    <p
                        className="text-xs text-red-500 truncate mt-1 max-w-[360px] cursor-help"
                        title={error}
                    >
                        {error}
                    </p>
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
    onApplyPayload: (payload: SyncPayload) => void | Promise<void>;
    onApplyLocalPayload?: (payload: SyncPayload) => void | Promise<void>;
    onClearLocalData?: () => void;
}

interface LocalBackupsPanelProps {
    onApplyPayload: (payload: SyncPayload) => void | Promise<void>;
    /**
     * When true, the panel hides the Restore button entirely — e.g. while the
     * master key has not been configured yet, a restore would land credentials
     * on disk in plaintext (I3). Listing is still allowed so users can see that
     * their history exists.
     */
    restoreDisabledReason?: 'no-master-key' | null;
}

const LocalBackupsPanel: React.FC<LocalBackupsPanelProps> = ({
    onApplyPayload,
    restoreDisabledReason = null,
}) => {
    const { t, resolvedLocale } = useI18n();
    const {
        backups,
        isLoading,
        maxBackups,
        encryptionAvailable,
        refreshBackups,
        readBackup,
        setMaxBackups,
        openBackupDirectory,
    } = useLocalVaultBackups();
    const [maxBackupsInput, setMaxBackupsInput] = useState(String(maxBackups));
    const [isSavingMaxBackups, setIsSavingMaxBackups] = useState(false);
    const [restoringBackupId, setRestoringBackupId] = useState<string | null>(null);
    // Backup chosen in the list but not yet confirmed. A two-step flow keeps
    // users from wiping their vault with a single accidental click (I2).
    const [pendingRestoreBackup, setPendingRestoreBackup] = useState<
        (typeof backups)[number] | null
    >(null);

    useEffect(() => {
        setMaxBackupsInput(String(maxBackups));
    }, [maxBackups]);

    const formatTimestamp = (timestamp: number) =>
        new Date(timestamp).toLocaleString(resolvedLocale || undefined);

    const getReasonLabel = (reason: 'app_version_change' | 'before_restore') =>
        reason === 'app_version_change'
            ? t('cloudSync.localBackups.reason.appVersionChange')
            : t('cloudSync.localBackups.reason.beforeRestore');

    const handleSaveMaxBackups = async () => {
        // Validate BEFORE calling setMaxBackups, which hands off to the
        // renderer's `sanitizeLocalVaultBackupMaxCount` clamp. Two failure
        // modes must be surfaced rather than silently clamped, because
        // both produce a misleading "saved" toast:
        //
        //   1. Empty / non-numeric input — `Number("")` coerces to 0 and
        //      sanitize clamps to the default (20). A user who meant to
        //      clear the field then re-type would see their retention
        //      silently reset to 20 with a success message.
        //
        //   2. Out-of-range input (e.g. 500) — sanitize clamps to 100 and
        //      still reports success, but the visible error string says
        //      "between 1 and 100", so the user has no idea their value
        //      was changed. Reject explicitly instead.
        //
        // The 1..MAX range check mirrors the main-process `sanitizeMaxCount`
        // in vaultBackupBridge.cjs so renderer and bridge agree.
        const parsed = Number(maxBackupsInput);
        const inRange =
            Number.isFinite(parsed) &&
            parsed >= MIN_LOCAL_VAULT_BACKUP_MAX_COUNT &&
            parsed <= MAX_LOCAL_VAULT_BACKUP_MAX_COUNT;
        if (!inRange || maxBackupsInput.trim() === '') {
            toast.error(
                t('cloudSync.localBackups.maxInvalid'),
                t('sync.toast.errorTitle'),
            );
            return;
        }
        setIsSavingMaxBackups(true);
        try {
            const next = await setMaxBackups(parsed);
            setMaxBackupsInput(String(next));
            toast.success(t('cloudSync.localBackups.maxSaved', { count: String(next) }));
        } catch (error) {
            toast.error(
                error instanceof Error ? error.message : t('common.unknownError'),
                t('sync.toast.errorTitle'),
            );
        } finally {
            setIsSavingMaxBackups(false);
        }
    };

    const handleOpenBackupDirectory = async () => {
        try {
            await openBackupDirectory();
        } catch (error) {
            toast.error(
                error instanceof Error ? error.message : t('common.unknownError'),
                t('sync.toast.errorTitle'),
            );
        }
    };

    const performRestore = async (backupId: string) => {
        setRestoringBackupId(backupId);
        try {
            // Hold the cross-window restore barrier around both the load
            // and the apply so another window's auto-sync cannot push a
            // pre-restore snapshot concurrently. See `withRestoreBarrier`
            // in application/localVaultBackups.ts for the read-side in
            // useAutoSync.
            //
            // In-memory React state refresh is implicit: `onApplyPayload`
            // (supplied by the hosting screen) routes through
            // `applySyncPayload` → `importDataFromString` → store writes
            // → the hook-store listeners in `useVaultState` /
            // `useCustomThemes` / etc. We do NOT explicitly re-pull host
            // lists here because a future refactor that decouples those
            // stores from the apply path would silently break the UI
            // refresh in a way that's only visible after a manual
            // restart. Any change to that chain must either preserve
            // store-listener notification OR add an explicit
            // `rehydrateAllFromStorage` call here — do not assume
            // restore is "just" a payload swap.
            await withRestoreBarrier(async () => {
                const detail = await readBackup(backupId);
                if (!detail) {
                    throw new Error(t('cloudSync.localBackups.restoreMissing'));
                }
                await Promise.resolve(onApplyPayload(detail.payload));
            });
            await refreshBackups();
            toast.success(t('cloudSync.localBackups.restoreSuccess'));
        } catch (error) {
            toast.error(
                error instanceof Error ? error.message : t('common.unknownError'),
                t('cloudSync.localBackups.restoreFailedTitle'),
            );
        } finally {
            setRestoringBackupId(null);
        }
    };

    const restoreAllowed = restoreDisabledReason === null;
    // While encryptionAvailable is still `null` we're mid-probe — render the
    // restore button as disabled so the user never sees a path they can't
    // actually take (I1 surface). Once resolved, `false` hides the panel body
    // via the unavailable banner below.
    const encryptionResolved = encryptionAvailable !== null;
    const encryptionUsable = encryptionAvailable === true;

    // safeStorage probe finished and returned "not available" → disable the
    // panel entirely; the main process refuses to write in this state (I1).
    if (encryptionResolved && !encryptionUsable) {
        return (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-2">
                <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
                    <AlertTriangle size={16} />
                    <span className="text-sm font-medium">
                        {t('cloudSync.localBackups.unavailableTitle')}
                    </span>
                </div>
                <div className="text-xs text-muted-foreground">
                    {t('cloudSync.localBackups.unavailableDesc')}
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <div className="rounded-lg border bg-card p-4">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                    <div className="max-w-lg">
                        <div className="text-sm font-medium">{t('cloudSync.localBackups.retentionTitle')}</div>
                        <div className="text-xs text-muted-foreground mt-1">
                            {t('cloudSync.localBackups.retentionDesc')}
                        </div>
                    </div>
                    <div className="space-y-2 md:min-w-[260px] md:shrink-0">
                        <div className="flex items-end gap-2 md:justify-end">
                            <Input
                                type="number"
                                min={1}
                                max={100}
                                value={maxBackupsInput}
                                onChange={(e) => setMaxBackupsInput(e.target.value)}
                                className="w-28"
                            />
                            <Button
                                variant="outline"
                                onClick={() => void handleSaveMaxBackups()}
                                disabled={isSavingMaxBackups}
                                className="gap-2"
                            >
                                {isSavingMaxBackups && <Loader2 size={14} className="animate-spin" />}
                                {t('common.save')}
                            </Button>
                        </div>
                    </div>
                </div>
            </div>

            {!restoreAllowed && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">
                    <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 mb-1">
                        <AlertTriangle size={14} />
                        <span className="font-medium">
                            {t('cloudSync.localBackups.lockedTitle')}
                        </span>
                    </div>
                    {t('cloudSync.localBackups.lockedDesc')}
                </div>
            )}

            <div className="rounded-lg border bg-card p-4 space-y-4">
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <div className="text-sm font-medium">{t('cloudSync.localBackups.title')}</div>
                        <div className="text-xs text-muted-foreground mt-1">
                            {t('cloudSync.localBackups.desc')}
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void refreshBackups()}
                            disabled={isLoading}
                            className="gap-1"
                        >
                            <RefreshCw size={14} className={cn(isLoading && 'animate-spin')} />
                            {t('settings.system.refresh')}
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleOpenBackupDirectory()}
                            className="gap-1"
                        >
                            <FolderOpen size={14} />
                            {t('settings.system.openFolder')}
                        </Button>
                    </div>
                </div>

                {backups.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border/60 p-4 text-sm text-muted-foreground">
                        {t('cloudSync.localBackups.empty')}
                    </div>
                ) : (
                    <div className="space-y-2">
                        {backups.map((backup) => (
                            <div
                                key={backup.id}
                                className="flex items-center gap-3 rounded-lg border border-border/60 p-3"
                            >
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm font-medium">
                                        {backup.syncDataVersion
                                            ? `v${backup.syncDataVersion}`
                                            : formatTimestamp(backup.createdAt)}
                                    </div>
                                    <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1 flex-wrap">
                                        <span>{getReasonLabel(backup.reason)}</span>
                                        {backup.syncDataVersion && (
                                            <>
                                                <span aria-hidden="true">·</span>
                                                <span>{formatTimestamp(backup.createdAt)}</span>
                                            </>
                                        )}
                                        {backup.sourceAppVersion && backup.targetAppVersion && (
                                            <>
                                                <span aria-hidden="true">·</span>
                                                <span>
                                                    {t('cloudSync.localBackups.versionChange', {
                                                        from: backup.sourceAppVersion,
                                                        to: backup.targetAppVersion,
                                                    })}
                                                </span>
                                            </>
                                        )}
                                    </div>
                                    <div className="text-xs text-muted-foreground mt-1">
                                        {t('cloudSync.localBackups.counts', {
                                            hosts: String(backup.preview.hostCount),
                                            keys: String(backup.preview.keyCount),
                                            snippets: String(backup.preview.snippetCount),
                                        })}
                                    </div>
                                </div>
                                {restoreAllowed && (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => setPendingRestoreBackup(backup)}
                                        // Disable every row while ANY restore is in
                                        // flight. Each restore runs a full
                                        // `applyProtectedSyncPayload` — multiple
                                        // localStorage writes + the apply-in-progress
                                        // sentinel. `withRestoreBarrier` serializes
                                        // across windows but does NOT serialize
                                        // same-window re-entry, so two overlapping
                                        // clicks here would interleave destructive
                                        // writes and the second run's sentinel-clear
                                        // could mask a still-partial first apply.
                                        disabled={restoringBackupId !== null}
                                        className="gap-2"
                                    >
                                        {restoringBackupId === backup.id ? (
                                            <Loader2 size={14} className="animate-spin" />
                                        ) : (
                                            <Download size={14} />
                                        )}
                                        {t('cloudSync.localBackups.restore')}
                                    </Button>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Restore confirmation dialog (I2). Keeps the destructive action
                gated behind an explicit second click, mirroring the clear-local
                dialog elsewhere in this screen. */}
            <Dialog
                open={pendingRestoreBackup !== null}
                onOpenChange={(open) => {
                    if (!open) setPendingRestoreBackup(null);
                }}
            >
                <DialogContent className="sm:max-w-[440px] z-[70]">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2 text-destructive">
                            <AlertTriangle size={20} />
                            {t('cloudSync.localBackups.restoreConfirmTitle')}
                        </DialogTitle>
                        <DialogDescription>
                            {t('cloudSync.localBackups.restoreConfirmDesc')}
                        </DialogDescription>
                    </DialogHeader>
                    {pendingRestoreBackup && (
                        <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs space-y-1">
                            <div className="font-medium">
                                {pendingRestoreBackup.syncDataVersion
                                    ? `v${pendingRestoreBackup.syncDataVersion}`
                                    : formatTimestamp(pendingRestoreBackup.createdAt)}
                            </div>
                            <div className="text-muted-foreground flex items-center gap-1 flex-wrap">
                                <span>{getReasonLabel(pendingRestoreBackup.reason)}</span>
                                {pendingRestoreBackup.syncDataVersion && (
                                    <>
                                        <span aria-hidden="true">·</span>
                                        <span>{formatTimestamp(pendingRestoreBackup.createdAt)}</span>
                                    </>
                                )}
                                {pendingRestoreBackup.sourceAppVersion && pendingRestoreBackup.targetAppVersion && (
                                    <>
                                        <span aria-hidden="true">·</span>
                                        <span>
                                            {t('cloudSync.localBackups.versionChange', {
                                                from: pendingRestoreBackup.sourceAppVersion,
                                                to: pendingRestoreBackup.targetAppVersion,
                                            })}
                                        </span>
                                    </>
                                )}
                            </div>
                            <div className="text-muted-foreground">
                                {t('cloudSync.localBackups.counts', {
                                    hosts: String(pendingRestoreBackup.preview.hostCount),
                                    keys: String(pendingRestoreBackup.preview.keyCount),
                                    snippets: String(pendingRestoreBackup.preview.snippetCount),
                                })}
                            </div>
                        </div>
                    )}
                    <DialogFooter className="gap-2 sm:gap-0">
                        <Button
                            variant="outline"
                            onClick={() => setPendingRestoreBackup(null)}
                            disabled={restoringBackupId !== null}
                        >
                            {t('cloudSync.localBackups.restoreConfirmCancel')}
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={async () => {
                                const target = pendingRestoreBackup;
                                if (!target) return;
                                setPendingRestoreBackup(null);
                                await performRestore(target.id);
                            }}
                            disabled={restoringBackupId !== null}
                            className="gap-2"
                        >
                            {restoringBackupId !== null ? (
                                <Loader2 size={14} className="animate-spin" />
                            ) : (
                                <Download size={14} />
                            )}
                            {t('cloudSync.localBackups.restoreConfirmButton')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
};

const SyncDashboard: React.FC<SyncDashboardProps> = ({
    onBuildPayload,
    onApplyPayload,
    onApplyLocalPayload,
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
        if (sync.pendingBrowserAuthProvider && sync.pendingBrowserAuthProvider !== current) {
            toast.info(t('cloudSync.connect.browserCancelled'));
        }
        sync.cancelOAuthConnect();
        const providers: CloudProvider[] = ['github', 'google', 'onedrive', 'webdav', 's3'];
        for (const provider of providers) {
            if (provider === current) continue;
            if (isProviderReadyForSync(sync.providers[provider])) {
                await sync.disconnectProvider(provider);
            }
        }
    };

    // GitHub Device Flow state
    const [showGitHubModal, setShowGitHubModal] = useState(false);
    const [gitHubUserCode, setGitHubUserCode] = useState('');
    const [gitHubVerificationUri, setGitHubVerificationUri] = useState('');
    const [isPollingGitHub, setIsPollingGitHub] = useState(false);
    const activeGitHubAttemptIdRef = useRef<number | null>(null);

    // Conflict modal
    const [showConflictModal, setShowConflictModal] = useState(false);

    // Gist revision history (#679)
    const [showHistoryModal, setShowHistoryModal] = useState(false);
    const [historyRevisions, setHistoryRevisions] = useState<Array<{ version: string; date: Date }>>([]);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [historyPreview, setHistoryPreview] = useState<{
      sha: string;
      payload: SyncPayload;
      preview: { hostCount: number; keyCount: number; snippetCount: number; identityCount: number; portForwardingRuleCount: number };
      deviceName?: string;
      version?: number;
    } | null>(null);
    const [historyPreviewLoading, setHistoryPreviewLoading] = useState(false);
    const [historyError, setHistoryError] = useState<string | null>(null);
    const [pendingConnectProvider, setPendingConnectProvider] = useState<CloudProvider | null>(null);
    const pendingConnectProviderRef = useRef<CloudProvider | null>(null);

    const hasConnectingProvider = (Object.values(sync.providers) as Array<{ status: string }>).some(
        (provider) => provider.status === 'connecting'
    );

    const isConnectDisabled = (provider: CloudProvider): boolean => {
        if (pendingConnectProvider && pendingConnectProvider !== provider) {
            return true;
        }
        if (pendingConnectProvider === provider) {
            return true;
        }
        if (hasConnectingProvider && sync.providers[provider].status !== 'connecting') {
            return true;
        }
        return sync.hasAnyConnectedProvider && !isProviderReadyForSync(sync.providers[provider]);
    };

    const beginPendingConnect = (provider: CloudProvider): boolean => {
        if (pendingConnectProviderRef.current) {
            return false;
        }
        pendingConnectProviderRef.current = provider;
        setPendingConnectProvider(provider);
        return true;
    };

    const endPendingConnect = (provider: CloudProvider) => {
        if (pendingConnectProviderRef.current !== provider) return;
        pendingConnectProviderRef.current = null;
        setPendingConnectProvider((current) => (current === provider ? null : current));
    };

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
    const [webdavAllowInsecure, setWebdavAllowInsecure] = useState(false);
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

    // Clear local data dialog
    const [showClearLocalDialog, setShowClearLocalDialog] = useState(false);

    // Sync-blocked banner (Task 7) + force-push confirmation modal (Task 8)
    const [blockedFinding, setBlockedFinding] = useState<Extract<ShrinkFinding, { suspicious: true }> | null>(null);
    const [showForcePushConfirm, setShowForcePushConfirm] = useState(false);

    // Ref for scrolling to LocalBackupsPanel when the banner's Restore button is clicked
    const localBackupsRef = useRef<HTMLDivElement>(null);

    // Active tab state — lets the banner's "Restore" button switch to the
    // local-backups tab without a separate DOM query.
    const [activeTab, setActiveTab] = useState<'providers' | 'status'>('providers');

    const ensureSyncablePayload = useCallback(
        (payload: SyncPayload): boolean => {
            const encryptedCredentialPaths = findSyncPayloadEncryptedCredentialPaths(payload);
            if (encryptedCredentialPaths.length === 0) return true;

            toast.error(t('sync.credentialsUnavailable'), t('sync.toast.errorTitle'));
            return false;
        },
        [t],
    );

    // Handle conflict detection
    useEffect(() => {
        if (sync.currentConflict) {
            setShowConflictModal(true);
        }
    }, [sync.currentConflict]);

    // Subscribe to sync events to show/clear the blocked-shrink banner.
    // Destructure the stable useCallback reference so the effect runs once on
    // mount rather than re-subscribing on every render when `sync` object ref changes.
    const { subscribeToEvents, getShrinkBlockedFinding } = sync;

    // Hydrate from current manager state in case a shrink-block happened
    // before this component mounted (e.g., auto-sync ran while the user
    // was on a different tab). Without this, the banner only shows
    // blocks that occur after Settings is open.
    useEffect(() => {
        const existing = getShrinkBlockedFinding();
        if (existing) {
            setBlockedFinding(existing);
        }
    }, [getShrinkBlockedFinding]);

    useEffect(() => {
        const unsub = subscribeToEvents((event) => {
            if (event.type === 'SYNC_BLOCKED_SHRINK') {
                if (event.finding.suspicious) {
                    setBlockedFinding(event.finding);
                }
            } else if (event.type === 'SYNC_BLOCKED_CLEARED') {
                setBlockedFinding(null);
            }
        });
        return unsub;
    }, [subscribeToEvents]);

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
        if (!beginPendingConnect('github')) return;
        const cancelController = new AbortController();
        let authAttemptId: number | null = null;
        try {
            await disconnectOtherProviders('github');
            const deviceFlow = await sync.connectGitHub();
            authAttemptId = deviceFlow.authAttemptId ?? null;
            activeGitHubAttemptIdRef.current = authAttemptId;
            setGitHubUserCode(deviceFlow.userCode);
            setGitHubVerificationUri(deviceFlow.verificationUri);
            setShowGitHubModal(true);
            setIsPollingGitHub(true);

            await sync.completeGitHubAuth(
                deviceFlow.deviceCode,
                deviceFlow.interval,
                deviceFlow.expiresAt,
                () => { }, // onPending callback
                cancelController.signal,
                authAttemptId ?? undefined
            );

            if (activeGitHubAttemptIdRef.current === authAttemptId) {
                activeGitHubAttemptIdRef.current = null;
                setIsPollingGitHub(false);
                setShowGitHubModal(false);
            }
            toast.success(t('cloudSync.connect.github.success'));
        } catch (error) {
            if (activeGitHubAttemptIdRef.current === authAttemptId) {
                activeGitHubAttemptIdRef.current = null;
                setIsPollingGitHub(false);
                setShowGitHubModal(false);
            }
            const message = getNetworkErrorMessage(error, t('common.unknownError'));
            if (!message.toLowerCase().includes('cancelled')) {
                toast.error(message, t('cloudSync.connect.github.failedTitle'));
            }
        } finally {
            cancelController.abort();
            if (activeGitHubAttemptIdRef.current == null) {
                endPendingConnect('github');
            }
        }
    };

    // Connect Google (disconnect others first - single provider only)
    const handleConnectGoogle = async () => {
        if (!beginPendingConnect('google')) return;
        try {
            await disconnectOtherProviders('google');
            await sync.connectGoogle();
            // Note: Auth flow is handled automatically by oauthBridge
            toast.info(t('cloudSync.connect.browserContinue'));
        } catch (error) {
            const msg = error instanceof Error ? error.message : t('common.unknownError');
            // Don't show toast for user-initiated cancellation (popup closed)
            if (!msg.includes('cancelled')) {
                toast.error(msg, t('cloudSync.connect.google.failedTitle'));
            }
        } finally {
            endPendingConnect('google');
        }
    };

    // Connect OneDrive (disconnect others first - single provider only)
    const handleConnectOneDrive = async () => {
        if (!beginPendingConnect('onedrive')) return;
        try {
            await disconnectOtherProviders('onedrive');
            await sync.connectOneDrive();
            // Note: Auth flow is handled automatically by oauthBridge
            toast.info(t('cloudSync.connect.browserContinue'));
        } catch (error) {
            const msg = error instanceof Error ? error.message : t('common.unknownError');
            // Don't show toast for user-initiated cancellation (popup closed)
            if (!msg.includes('cancelled')) {
                toast.error(msg, t('cloudSync.connect.onedrive.failedTitle'));
            }
        } finally {
            endPendingConnect('onedrive');
        }
    };

    const openWebdavDialog = () => {
        if (sync.pendingBrowserAuthProvider) {
            toast.info(t('cloudSync.connect.browserCancelled'));
        }
        sync.cancelOAuthConnect();
        const config = sync.providers.webdav.config as WebDAVConfig | undefined;
        setWebdavEndpoint(config?.endpoint || '');
        setWebdavAuthType(config?.authType || 'basic');
        setWebdavUsername(config?.username || '');
        setWebdavPassword(config?.password || '');
        setWebdavToken(config?.token || '');
        setWebdavAllowInsecure(config?.allowInsecure || false);
        setShowWebdavSecret(false);
        setWebdavError(null);
        setWebdavErrorDetail(null);
        setShowWebdavDialog(true);
    };

    const openS3Dialog = () => {
        if (sync.pendingBrowserAuthProvider) {
            toast.info(t('cloudSync.connect.browserCancelled'));
        }
        sync.cancelOAuthConnect();
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
            allowInsecure: webdavAllowInsecure ? true : undefined,
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

    // Sync to provider
    const handleSync = async (provider: CloudProvider) => {
        try {
            const payload = onBuildPayload();
            if (!ensureSyncablePayload(payload)) return;
            const result = await sync.syncToProvider(provider, payload);

            if (result.success) {
                // Apply merged data if a three-way merge happened
                if (result.mergedPayload && onApplyPayload) {
                    await Promise.resolve(onApplyPayload(result.mergedPayload));
                }
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
                // USE_REMOTE applies cloud data over local — same data-loss
                // shape as a local backup restore, so gate auto-sync in
                // every other window the same way.
                await withRestoreBarrier(async () => {
                    await Promise.resolve(onApplyPayload(payload));
                });
                toast.success(t('cloudSync.resolve.downloaded'));
            } else if (resolution === 'USE_LOCAL') {
                // Re-sync with local data. Hold the same cross-window
                // restore barrier that USE_REMOTE uses: without it, a
                // concurrent auto-sync tick in another window can slip
                // between our conflict resolution and the upload,
                // producing a second upload path with stale state that
                // races against this push. USE_LOCAL doesn't mutate the
                // renderer's in-memory state (no onApplyPayload call), so
                // the barrier is belt-and-suspenders against the other
                // window's push, not ours.
                const localPayload = onBuildPayload();
                if (!ensureSyncablePayload(localPayload)) return;

                let results: Map<CloudProvider, SyncResult> | null = null;
                await withRestoreBarrier(async () => {
                    results = await sync.syncNow(localPayload, { overrideShrink: true });
                });

                if (results) {
                    // Apply any merged payload BEFORE closing the modal so local state
                    // reflects what's now on cloud (in case remote changed during the merge).
                    for (const result of (results as Map<CloudProvider, SyncResult>).values()) {
                        if (result.mergedPayload) {
                            await Promise.resolve(onApplyPayload(result.mergedPayload));
                            break;
                        }
                    }
                    const allOk = Array.from((results as Map<CloudProvider, SyncResult>).values()).every((r) => r.success);
                    if (!allOk) {
                        const firstError = Array.from((results as Map<CloudProvider, SyncResult>).values())
                            .find((r) => !r.success)?.error
                            ?? t('common.unknownError');
                        toast.error(firstError, t('cloudSync.resolve.failedTitle'));
                        return; // KEEP the modal open so user can retry / pick USE_REMOTE
                    }
                }
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

    // -- Gist revision history handlers --

    const handleOpenHistory = async () => {
        setShowHistoryModal(true);
        setHistoryLoading(true);
        setHistoryError(null);
        setHistoryPreview(null);
        setHistoryRevisions([]);
        try {
            const revisions = await sync.getGistRevisionHistory();
            setHistoryRevisions(revisions);
        } catch (err) {
            setHistoryError(err instanceof Error ? err.message : t('common.unknownError'));
        } finally {
            setHistoryLoading(false);
        }
    };

    const handlePreviewRevision = async (sha: string) => {
        setHistoryPreviewLoading(true);
        setHistoryError(null);
        try {
            const result = await sync.downloadGistRevision(sha);
            if (result) {
                setHistoryPreview({
                    sha,
                    payload: result.payload,
                    preview: result.preview,
                    deviceName: result.meta.deviceName,
                    version: result.meta.version,
                });
            } else {
                setHistoryError(t('cloudSync.revisionHistory.revisionNotFound'));
            }
        } catch {
            // Decrypt failures can manifest as various error types:
            // "Decryption failed", OperationError, "unable to authenticate
            // data", AES-GCM tag mismatch, etc. Show the friendly message
            // for any error originating from the decrypt step; network
            // errors would have been caught by the fetch layer already.
            setHistoryError(t('cloudSync.revisionHistory.decryptFailed'));
        } finally {
            setHistoryPreviewLoading(false);
        }
    };

    const handleRestoreRevision = async () => {
        if (!historyPreview) return;
        // Gist revision restore is a destructive "replace local with cloud
        // snapshot" op — same shape as a local backup restore, same
        // cross-window race to block.
        await withRestoreBarrier(async () => {
            await Promise.resolve(onApplyPayload(historyPreview.payload));
        });
        toast.success(t('cloudSync.revisionHistory.restored'));
        setShowHistoryModal(false);
        setHistoryPreview(null);
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

            {blockedFinding && (
                <SyncBlockedBanner
                    finding={blockedFinding}
                    onRestore={() => {
                        setActiveTab('status');
                        requestAnimationFrame(() => {
                            localBackupsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        });
                    }}
                    onForcePush={() => setShowForcePushConfirm(true)}
                />
            )}

            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'providers' | 'status')} className="space-y-4">
                <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="providers">{t('cloudSync.providers.title')}</TabsTrigger>
                    <TabsTrigger value="status">{t('cloudSync.status.title')}</TabsTrigger>
                </TabsList>

                <TabsContent value="providers" className="space-y-3">
                    <ProviderCard
                        provider="github"
                        name="GitHub Gist"
                        icon={<Github size={24} />}
                        isConnected={isProviderReadyForSync(sync.providers.github)}
                        isSyncing={sync.providers.github.status === 'syncing'}
                        isConnecting={sync.providers.github.status === 'connecting'}
                        account={sync.providers.github.account}
                        lastSync={sync.providers.github.lastSync}
                        error={sync.providers.github.error}
                        disabled={isConnectDisabled('github')}
                        onConnect={handleConnectGitHub}
                        onDisconnect={() => sync.disconnectProvider('github')}
                        onSync={() => handleSync('github')}
                        extraActions={
                            isProviderReadyForSync(sync.providers.github) ? (
                                <Button size="sm" variant="ghost" onClick={handleOpenHistory} className="gap-1">
                                    <History size={14} />
                                    {t('cloudSync.revisionHistory.viewButton')}
                                </Button>
                            ) : undefined
                        }
                    />

                    <ProviderCard
                        provider="google"
                        name="Google Drive"
                        icon={<GoogleDriveIcon className="w-6 h-6" />}
                        isConnected={isProviderReadyForSync(sync.providers.google)}
                        isSyncing={sync.providers.google.status === 'syncing'}
                        isConnecting={
                            sync.providers.google.status === 'connecting' ||
                            sync.pendingBrowserAuthProvider === 'google'
                        }
                        account={sync.providers.google.account}
                        lastSync={sync.providers.google.lastSync}
                        error={sync.providers.google.error}
                        disabled={isConnectDisabled('google')}
                        onConnect={handleConnectGoogle}
                        onCancelConnect={sync.cancelOAuthConnect}
                        onDisconnect={() => sync.disconnectProvider('google')}
                        onSync={() => handleSync('google')}
                    />

                    <ProviderCard
                        provider="onedrive"
                        name="Microsoft OneDrive"
                        icon={<OneDriveIcon className="w-6 h-6" />}
                        isConnected={isProviderReadyForSync(sync.providers.onedrive)}
                        isSyncing={sync.providers.onedrive.status === 'syncing'}
                        isConnecting={
                            sync.providers.onedrive.status === 'connecting' ||
                            sync.pendingBrowserAuthProvider === 'onedrive'
                        }
                        account={sync.providers.onedrive.account}
                        lastSync={sync.providers.onedrive.lastSync}
                        error={sync.providers.onedrive.error}
                        disabled={isConnectDisabled('onedrive')}
                        onConnect={handleConnectOneDrive}
                        onCancelConnect={sync.cancelOAuthConnect}
                        onDisconnect={() => sync.disconnectProvider('onedrive')}
                        onSync={() => handleSync('onedrive')}
                    />

                    <ProviderCard
                        provider="webdav"
                        name={t('cloudSync.provider.webdav')}
                        icon={<Server size={24} />}
                        isConnected={isProviderReadyForSync(sync.providers.webdav)}
                        isSyncing={sync.providers.webdav.status === 'syncing'}
                        isConnecting={sync.providers.webdav.status === 'connecting'}
                        account={sync.providers.webdav.account}
                        lastSync={sync.providers.webdav.lastSync}
                        error={sync.providers.webdav.error}
                        disabled={isConnectDisabled('webdav')}
                        onEdit={openWebdavDialog}
                        onConnect={openWebdavDialog}
                        onDisconnect={() => sync.disconnectProvider('webdav')}
                        onSync={() => handleSync('webdav')}
                    />

                    <ProviderCard
                        provider="s3"
                        name={t('cloudSync.provider.s3')}
                        icon={<Database size={24} />}
                        isConnected={isProviderReadyForSync(sync.providers.s3)}
                        isSyncing={sync.providers.s3.status === 'syncing'}
                        isConnecting={sync.providers.s3.status === 'connecting'}
                        account={sync.providers.s3.account}
                        lastSync={sync.providers.s3.lastSync}
                        error={sync.providers.s3.error}
                        disabled={isConnectDisabled('s3')}
                        onEdit={openS3Dialog}
                        onConnect={openS3Dialog}
                        onDisconnect={() => sync.disconnectProvider('s3')}
                        onSync={() => handleSync('s3')}
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

                    <div ref={localBackupsRef}>
                        <LocalBackupsPanel
                            onApplyPayload={onApplyLocalPayload ?? onApplyPayload}
                        />
                    </div>

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
                    activeGitHubAttemptIdRef.current = null;
                    setShowGitHubModal(false);
                    setIsPollingGitHub(false);
                    endPendingConnect('github');
                    sync.cancelOAuthConnect();
                }}
            />

            <ConflictModal
                open={showConflictModal}
                conflict={sync.currentConflict}
                onResolve={handleResolveConflict}
                onClose={() => setShowConflictModal(false)}
            />

            {/* Gist Revision History Modal (#679) */}
            <Dialog open={showHistoryModal} onOpenChange={setShowHistoryModal}>
                <DialogContent className="sm:max-w-[520px] max-h-[80vh] overflow-hidden flex flex-col z-[70]">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <History size={18} />
                            {t('cloudSync.revisionHistory.title')}
                        </DialogTitle>
                        <DialogDescription>{t('cloudSync.revisionHistory.description')}</DialogDescription>
                    </DialogHeader>

                    {historyError && (
                        <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-500">
                            {historyError}
                        </div>
                    )}

                    {historyLoading ? (
                        <div className="flex items-center justify-center py-8">
                            <Loader2 size={24} className="animate-spin text-muted-foreground" />
                        </div>
                    ) : historyPreview ? (
                        // Preview of a selected revision
                        <div className="space-y-4 overflow-y-auto flex-1 min-h-0">
                            <div className="rounded-lg border p-4 space-y-2">
                                <div className="text-sm font-medium">{t('cloudSync.revisionHistory.revisionPreview')}</div>
                                {historyPreview.deviceName && (
                                    <div className="text-xs text-muted-foreground">
                                        {t('cloudSync.revisionHistory.device')}: {historyPreview.deviceName}
                                        {historyPreview.version != null && ` · v${historyPreview.version}`}
                                    </div>
                                )}
                                <div className="grid grid-cols-2 gap-2 text-sm">
                                    <div className="flex justify-between px-2 py-1 bg-muted/30 rounded">
                                        <span className="text-muted-foreground">{t('cloudSync.revisionHistory.hosts')}</span>
                                        <span className="font-medium">{historyPreview.preview.hostCount}</span>
                                    </div>
                                    <div className="flex justify-between px-2 py-1 bg-muted/30 rounded">
                                        <span className="text-muted-foreground">{t('cloudSync.revisionHistory.keys')}</span>
                                        <span className="font-medium">{historyPreview.preview.keyCount}</span>
                                    </div>
                                    <div className="flex justify-between px-2 py-1 bg-muted/30 rounded">
                                        <span className="text-muted-foreground">{t('cloudSync.revisionHistory.snippets')}</span>
                                        <span className="font-medium">{historyPreview.preview.snippetCount}</span>
                                    </div>
                                    <div className="flex justify-between px-2 py-1 bg-muted/30 rounded">
                                        <span className="text-muted-foreground">{t('cloudSync.revisionHistory.identities')}</span>
                                        <span className="font-medium">{historyPreview.preview.identityCount}</span>
                                    </div>
                                </div>
                            </div>
                            <DialogFooter className="gap-2">
                                <Button variant="outline" onClick={() => setHistoryPreview(null)}>
                                    {t('common.back')}
                                </Button>
                                <Button onClick={handleRestoreRevision} className="gap-1">
                                    <Download size={14} />
                                    {t('cloudSync.revisionHistory.restoreButton')}
                                </Button>
                            </DialogFooter>
                        </div>
                    ) : (
                        // Revision list
                        <div className="overflow-y-auto flex-1 min-h-0 -mx-1">
                            {historyRevisions.length === 0 ? (
                                <div className="text-sm text-muted-foreground text-center py-8">
                                    {t('cloudSync.revisionHistory.empty')}
                                </div>
                            ) : (
                                <div className="space-y-1 px-1">
                                    {historyRevisions.map((rev, index) => (
                                        <button
                                            key={rev.version}
                                            onClick={() => handlePreviewRevision(rev.version)}
                                            disabled={historyPreviewLoading}
                                            className={cn(
                                                "w-full flex items-center justify-between p-2.5 rounded-lg text-left text-sm transition-colors",
                                                "hover:bg-accent border border-transparent hover:border-border",
                                                index === 0 && "bg-primary/5 border-primary/20",
                                            )}
                                        >
                                            <div>
                                                <div className="font-medium">
                                                    {index === 0 ? t('cloudSync.revisionHistory.current') : `${t('cloudSync.revisionHistory.revision')} #${historyRevisions.length - index}`}
                                                </div>
                                                <div className="text-xs text-muted-foreground">
                                                    {rev.date.toLocaleString()}
                                                </div>
                                            </div>
                                            <div className="text-xs text-muted-foreground font-mono">
                                                {rev.version.slice(0, 7)}
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {historyPreviewLoading && (
                        <div className="absolute inset-0 bg-background/50 flex items-center justify-center rounded-lg">
                            <Loader2 size={24} className="animate-spin" />
                        </div>
                    )}
                </DialogContent>
            </Dialog>

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

                        <label className="flex items-center gap-2 text-sm text-muted-foreground select-none">
                            <input
                                type="checkbox"
                                checked={webdavAllowInsecure}
                                onChange={(e) => setWebdavAllowInsecure(e.target.checked)}
                                className="accent-primary"
                            />
                            {t('cloudSync.webdav.allowInsecure')}
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

                                let payloadForReencrypt: SyncPayload | null = null;
                                if (sync.hasAnyConnectedProvider) {
                                    const payload = onBuildPayload();
                                    if (!ensureSyncablePayload(payload)) {
                                        setChangeKeyError(t('sync.credentialsUnavailable'));
                                        return;
                                    }
                                    payloadForReencrypt = payload;
                                }

                                setIsChangingKey(true);
                                try {
                                    const ok = await sync.changeMasterKey(currentMasterKey, newMasterKey);
                                    if (!ok) {
                                        setChangeKeyError(t('cloudSync.changeKey.incorrectCurrent'));
                                        return;
                                    }

                                    if (payloadForReencrypt) {
                                        await sync.syncNow(payloadForReencrypt);
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

            {/* Force-push confirmation modal (Task 8) */}
            {showForcePushConfirm && blockedFinding && (
                <Dialog open onOpenChange={(open) => !open && setShowForcePushConfirm(false)}>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>{t('sync.forcePush.title')}</DialogTitle>
                        </DialogHeader>
                        <p className="text-sm">
                            {t('sync.forcePush.body', {
                                lost: blockedFinding.lost,
                                entityType: t(`sync.entityType.${blockedFinding.entityType}`),
                            })}
                        </p>
                        <DialogFooter>
                            <Button variant="outline" onClick={() => setShowForcePushConfirm(false)}>
                                {t('sync.forcePush.cancel')}
                            </Button>
                            <Button
                                variant="destructive"
                                onClick={async () => {
                                    const localPayload = onBuildPayload();
                                    if (!ensureSyncablePayload(localPayload)) {
                                        setShowForcePushConfirm(false);
                                        return;
                                    }
                                    setShowForcePushConfirm(false);
                                    try {
                                        const results = await sync.syncNow(localPayload, { overrideShrink: true });

                                        // Apply any merged payload BEFORE clearing the banner. If a merge happened
                                        // during force-push (remote changed), the merged result is what the cloud
                                        // now has — applying it to local state prevents the next sync from
                                        // re-deleting the remote additions we just merged in.
                                        for (const result of results.values()) {
                                            if (result.mergedPayload) {
                                                await Promise.resolve(onApplyPayload(result.mergedPayload));
                                                break; // All providers share the same merged payload
                                            }
                                        }

                                        const allOk = Array.from(results.values()).every((r) => r.success);
                                        if (allOk) {
                                            setBlockedFinding(null);
                                        } else {
                                            // Surface the failure but KEEP the banner so the user can retry or
                                            // restore. Find the first error string to display.
                                            const firstError = Array.from(results.values())
                                                .find((r) => !r.success)
                                                ?.error ?? t('sync.toast.errorTitle');
                                            toast.error(firstError, t('sync.toast.errorTitle'));
                                        }
                                    } catch (err) {
                                        toast.error(String(err), t('sync.toast.errorTitle'));
                                    }
                                }}
                            >
                                {t('sync.forcePush.confirm')}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            )}
        </div>
    );
};

// ============================================================================
// Main Export - CloudSyncSettings
// ============================================================================

interface CloudSyncSettingsProps {
    onBuildPayload: () => SyncPayload;
    onApplyPayload: (payload: SyncPayload) => void | Promise<void>;
    onApplyLocalPayload?: (payload: SyncPayload) => void | Promise<void>;
    onClearLocalData?: () => void;
}

export const CloudSyncSettings: React.FC<CloudSyncSettingsProps> = (props) => {
    const { securityState } = useCloudSync();

    // Simplified UX: once a master key is configured, we auto-unlock via safeStorage
    // so users don't have to manage a separate LOCKED screen.
    if (securityState === 'NO_KEY') {
        return (
            <div className="space-y-6">
                <GatekeeperScreen onSetupComplete={() => { }} />
                {/* The master key is not configured yet. Expose the backup
                    history for diagnostic purposes but refuse restores: the
                    vault encryption layer can't re-protect the restored
                    credentials until the user finishes master-key setup (I3). */}
                <LocalBackupsPanel
                    onApplyPayload={props.onApplyPayload}
                    restoreDisabledReason="no-master-key"
                />
            </div>
        );
    }

    return <SyncDashboard {...props} />;
};

export default CloudSyncSettings;
