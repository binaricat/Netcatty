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
    Key,
    ShieldCheck,
} from 'lucide-react';
import { useCloudSync } from '../application/state/useCloudSync';
import {
    withRestoreBarrier,
} from '../application/localVaultBackups';
import { useI18n } from '../application/i18n/I18nProvider';
import {
    findSyncPayloadEncryptedCredentialPaths,
} from '../domain/credentials';
import { isProviderReadyForSync, type CloudProvider, type SyncPayload, type SyncResult, type WebDAVAuthType, type WebDAVConfig, type S3Config } from '../domain/sync';
import type { ShrinkFinding } from '../domain/syncGuards';
import { SyncBlockedBanner } from './sync/SyncBlockedBanner';
import { Button } from './ui/button';
import { toast } from './ui/toast';

// ============================================================================
import { GatekeeperScreen, StatusDot } from './cloud-sync/CloudSyncControls';
import { LocalBackupsPanel } from './cloud-sync/CloudSyncLocalBackupsPanel';
import { CloudSyncDialogs } from './cloud-sync/CloudSyncDialogs';
import { CloudSyncDashboardTabs } from './cloud-sync/CloudSyncDashboardTabs';
interface SyncDashboardProps {
    onBuildPayload: () => SyncPayload;
    onApplyPayload: (payload: SyncPayload) => void | Promise<void>;
    onApplyLocalPayload?: (payload: SyncPayload) => void | Promise<void>;
    onClearLocalData?: () => void;
}

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

            <CloudSyncDashboardTabs
                activeTab={activeTab}
                setActiveTab={setActiveTab}
                t={t}
                sync={sync}
                resolvedLocale={resolvedLocale}
                localBackupsRef={localBackupsRef}
                isConnectDisabled={isConnectDisabled}
                handleConnectGitHub={handleConnectGitHub}
                handleConnectGoogle={handleConnectGoogle}
                handleConnectOneDrive={handleConnectOneDrive}
                openWebdavDialog={openWebdavDialog}
                openS3Dialog={openS3Dialog}
                handleOpenHistory={handleOpenHistory}
                handleSync={handleSync}
                onApplyPayload={onApplyPayload}
                onApplyLocalPayload={onApplyLocalPayload}
                setShowClearLocalDialog={setShowClearLocalDialog}
            />

            <CloudSyncDialogs
                t={t}
                sync={sync}
                showGitHubModal={showGitHubModal}
                gitHubUserCode={gitHubUserCode}
                gitHubVerificationUri={gitHubVerificationUri}
                isPollingGitHub={isPollingGitHub}
                activeGitHubAttemptIdRef={activeGitHubAttemptIdRef}
                setShowGitHubModal={setShowGitHubModal}
                setIsPollingGitHub={setIsPollingGitHub}
                endPendingConnect={endPendingConnect}
                showConflictModal={showConflictModal}
                setShowConflictModal={setShowConflictModal}
                handleResolveConflict={handleResolveConflict}
                showHistoryModal={showHistoryModal}
                setShowHistoryModal={setShowHistoryModal}
                historyError={historyError}
                historyLoading={historyLoading}
                historyPreview={historyPreview}
                setHistoryPreview={setHistoryPreview}
                historyPreviewLoading={historyPreviewLoading}
                historyRevisions={historyRevisions}
                handlePreviewRevision={handlePreviewRevision}
                handleRestoreRevision={handleRestoreRevision}
                showWebdavDialog={showWebdavDialog}
                setShowWebdavDialog={setShowWebdavDialog}
                webdavEndpoint={webdavEndpoint}
                setWebdavEndpoint={setWebdavEndpoint}
                webdavAuthType={webdavAuthType}
                setWebdavAuthType={setWebdavAuthType}
                webdavUsername={webdavUsername}
                setWebdavUsername={setWebdavUsername}
                webdavPassword={webdavPassword}
                setWebdavPassword={setWebdavPassword}
                webdavToken={webdavToken}
                setWebdavToken={setWebdavToken}
                showWebdavSecret={showWebdavSecret}
                setShowWebdavSecret={setShowWebdavSecret}
                webdavAllowInsecure={webdavAllowInsecure}
                setWebdavAllowInsecure={setWebdavAllowInsecure}
                webdavError={webdavError}
                webdavErrorDetail={webdavErrorDetail}
                isSavingWebdav={isSavingWebdav}
                handleSaveWebdav={handleSaveWebdav}
                showS3Dialog={showS3Dialog}
                setShowS3Dialog={setShowS3Dialog}
                s3Endpoint={s3Endpoint}
                setS3Endpoint={setS3Endpoint}
                s3Region={s3Region}
                setS3Region={setS3Region}
                s3Bucket={s3Bucket}
                setS3Bucket={setS3Bucket}
                s3AccessKeyId={s3AccessKeyId}
                setS3AccessKeyId={setS3AccessKeyId}
                s3SecretAccessKey={s3SecretAccessKey}
                setS3SecretAccessKey={setS3SecretAccessKey}
                s3SessionToken={s3SessionToken}
                setS3SessionToken={setS3SessionToken}
                s3Prefix={s3Prefix}
                setS3Prefix={setS3Prefix}
                s3ForcePathStyle={s3ForcePathStyle}
                setS3ForcePathStyle={setS3ForcePathStyle}
                showS3Secret={showS3Secret}
                setShowS3Secret={setShowS3Secret}
                s3Error={s3Error}
                s3ErrorDetail={s3ErrorDetail}
                isSavingS3={isSavingS3}
                handleSaveS3={handleSaveS3}
                showChangeKeyDialog={showChangeKeyDialog}
                setShowChangeKeyDialog={setShowChangeKeyDialog}
                currentMasterKey={currentMasterKey}
                setCurrentMasterKey={setCurrentMasterKey}
                newMasterKey={newMasterKey}
                setNewMasterKey={setNewMasterKey}
                confirmNewMasterKey={confirmNewMasterKey}
                setConfirmNewMasterKey={setConfirmNewMasterKey}
                showMasterKey={showMasterKey}
                setShowMasterKey={setShowMasterKey}
                changeKeyError={changeKeyError}
                setChangeKeyError={setChangeKeyError}
                isChangingKey={isChangingKey}
                setIsChangingKey={setIsChangingKey}
                showUnlockDialog={showUnlockDialog}
                setShowUnlockDialog={setShowUnlockDialog}
                unlockMasterKey={unlockMasterKey}
                setUnlockMasterKey={setUnlockMasterKey}
                showUnlockMasterKey={showUnlockMasterKey}
                setShowUnlockMasterKey={setShowUnlockMasterKey}
                unlockError={unlockError}
                setUnlockError={setUnlockError}
                isUnlocking={isUnlocking}
                setIsUnlocking={setIsUnlocking}
                showClearLocalDialog={showClearLocalDialog}
                setShowClearLocalDialog={setShowClearLocalDialog}
                onBuildPayload={onBuildPayload}
                onApplyPayload={onApplyPayload}
                onClearLocalData={onClearLocalData}
                ensureSyncablePayload={ensureSyncablePayload}
                showForcePushConfirm={showForcePushConfirm}
                setShowForcePushConfirm={setShowForcePushConfirm}
                blockedFinding={blockedFinding}
                setBlockedFinding={setBlockedFinding}
            />
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
