import React, { type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { AlertTriangle, Cloud, Database, Download, History, Key, Loader2, ShieldCheck, Trash2 } from 'lucide-react';
import type { CloudProvider, ConflictResolution, SyncPayload, WebDAVAuthType } from '../../domain/sync';
import type { ShrinkFinding } from '../../domain/syncGuards';
import type { useCloudSync } from '../../application/state/useCloudSync';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { toast } from '../ui/toast';
import { ConflictModal, GitHubDeviceFlowModal } from './CloudSyncControls';

type SyncController = ReturnType<typeof useCloudSync>;
type TextValues = Record<string, string | number>;
type Translate = (key: string, values?: TextValues) => string;
type StringSetter = Dispatch<SetStateAction<string>>;
type BooleanSetter = Dispatch<SetStateAction<boolean>>;

type HistoryPreview = {
  sha: string;
  payload: SyncPayload;
  preview: {
    hostCount: number;
    keyCount: number;
    snippetCount: number;
    identityCount: number;
    portForwardingRuleCount: number;
  };
  deviceName?: string;
  version?: number;
} | null;

interface CloudSyncDialogsProps {
  t: Translate;
  sync: SyncController;
  showGitHubModal: boolean;
  gitHubUserCode: string;
  gitHubVerificationUri: string;
  isPollingGitHub: boolean;
  activeGitHubAttemptIdRef: MutableRefObject<number | null>;
  setShowGitHubModal: BooleanSetter;
  setIsPollingGitHub: BooleanSetter;
  endPendingConnect: (provider: CloudProvider) => void;
  showConflictModal: boolean;
  setShowConflictModal: BooleanSetter;
  handleResolveConflict: (resolution: ConflictResolution) => Promise<void>;
  showHistoryModal: boolean;
  setShowHistoryModal: BooleanSetter;
  historyError: string | null;
  historyLoading: boolean;
  historyPreview: HistoryPreview;
  setHistoryPreview: Dispatch<SetStateAction<HistoryPreview>>;
  historyPreviewLoading: boolean;
  historyRevisions: Array<{ version: string; date: Date }>;
  handlePreviewRevision: (sha: string) => Promise<void>;
  handleRestoreRevision: () => Promise<void>;
  showWebdavDialog: boolean;
  setShowWebdavDialog: BooleanSetter;
  webdavEndpoint: string;
  setWebdavEndpoint: StringSetter;
  webdavAuthType: WebDAVAuthType;
  setWebdavAuthType: Dispatch<SetStateAction<WebDAVAuthType>>;
  webdavUsername: string;
  setWebdavUsername: StringSetter;
  webdavPassword: string;
  setWebdavPassword: StringSetter;
  webdavToken: string;
  setWebdavToken: StringSetter;
  showWebdavSecret: boolean;
  setShowWebdavSecret: BooleanSetter;
  webdavAllowInsecure: boolean;
  setWebdavAllowInsecure: BooleanSetter;
  webdavError: string | null;
  webdavErrorDetail: string | null;
  isSavingWebdav: boolean;
  handleSaveWebdav: () => Promise<void>;
  showS3Dialog: boolean;
  setShowS3Dialog: BooleanSetter;
  s3Endpoint: string;
  setS3Endpoint: StringSetter;
  s3Region: string;
  setS3Region: StringSetter;
  s3Bucket: string;
  setS3Bucket: StringSetter;
  s3AccessKeyId: string;
  setS3AccessKeyId: StringSetter;
  s3SecretAccessKey: string;
  setS3SecretAccessKey: StringSetter;
  s3SessionToken: string;
  setS3SessionToken: StringSetter;
  s3Prefix: string;
  setS3Prefix: StringSetter;
  s3ForcePathStyle: boolean;
  setS3ForcePathStyle: BooleanSetter;
  showS3Secret: boolean;
  setShowS3Secret: BooleanSetter;
  s3Error: string | null;
  s3ErrorDetail: string | null;
  isSavingS3: boolean;
  handleSaveS3: () => Promise<void>;
  showChangeKeyDialog: boolean;
  setShowChangeKeyDialog: BooleanSetter;
  currentMasterKey: string;
  setCurrentMasterKey: StringSetter;
  newMasterKey: string;
  setNewMasterKey: StringSetter;
  confirmNewMasterKey: string;
  setConfirmNewMasterKey: StringSetter;
  showMasterKey: boolean;
  setShowMasterKey: BooleanSetter;
  changeKeyError: string | null;
  setChangeKeyError: Dispatch<SetStateAction<string | null>>;
  isChangingKey: boolean;
  setIsChangingKey: BooleanSetter;
  showUnlockDialog: boolean;
  setShowUnlockDialog: BooleanSetter;
  unlockMasterKey: string;
  setUnlockMasterKey: StringSetter;
  showUnlockMasterKey: boolean;
  setShowUnlockMasterKey: BooleanSetter;
  unlockError: string | null;
  setUnlockError: Dispatch<SetStateAction<string | null>>;
  isUnlocking: boolean;
  setIsUnlocking: BooleanSetter;
  showClearLocalDialog: boolean;
  setShowClearLocalDialog: BooleanSetter;
  onBuildPayload: () => SyncPayload;
  onApplyPayload: (payload: SyncPayload) => void | Promise<void>;
  onClearLocalData?: () => void;
  ensureSyncablePayload: (payload: SyncPayload) => boolean;
  showForcePushConfirm: boolean;
  setShowForcePushConfirm: BooleanSetter;
  blockedFinding: Extract<ShrinkFinding, { suspicious: true }> | null;
  setBlockedFinding: Dispatch<SetStateAction<Extract<ShrinkFinding, { suspicious: true }> | null>>;
}

export const CloudSyncDialogs: React.FC<CloudSyncDialogsProps> = ({
  t,
  sync,
  showGitHubModal,
  gitHubUserCode,
  gitHubVerificationUri,
  isPollingGitHub,
  activeGitHubAttemptIdRef,
  setShowGitHubModal,
  setIsPollingGitHub,
  endPendingConnect,
  showConflictModal,
  setShowConflictModal,
  handleResolveConflict,
  showHistoryModal,
  setShowHistoryModal,
  historyError,
  historyLoading,
  historyPreview,
  setHistoryPreview,
  historyPreviewLoading,
  historyRevisions,
  handlePreviewRevision,
  handleRestoreRevision,
  showWebdavDialog,
  setShowWebdavDialog,
  webdavEndpoint,
  setWebdavEndpoint,
  webdavAuthType,
  setWebdavAuthType,
  webdavUsername,
  setWebdavUsername,
  webdavPassword,
  setWebdavPassword,
  webdavToken,
  setWebdavToken,
  showWebdavSecret,
  setShowWebdavSecret,
  webdavAllowInsecure,
  setWebdavAllowInsecure,
  webdavError,
  webdavErrorDetail,
  isSavingWebdav,
  handleSaveWebdav,
  showS3Dialog,
  setShowS3Dialog,
  s3Endpoint,
  setS3Endpoint,
  s3Region,
  setS3Region,
  s3Bucket,
  setS3Bucket,
  s3AccessKeyId,
  setS3AccessKeyId,
  s3SecretAccessKey,
  setS3SecretAccessKey,
  s3SessionToken,
  setS3SessionToken,
  s3Prefix,
  setS3Prefix,
  s3ForcePathStyle,
  setS3ForcePathStyle,
  showS3Secret,
  setShowS3Secret,
  s3Error,
  s3ErrorDetail,
  isSavingS3,
  handleSaveS3,
  showChangeKeyDialog,
  setShowChangeKeyDialog,
  currentMasterKey,
  setCurrentMasterKey,
  newMasterKey,
  setNewMasterKey,
  confirmNewMasterKey,
  setConfirmNewMasterKey,
  showMasterKey,
  setShowMasterKey,
  changeKeyError,
  setChangeKeyError,
  isChangingKey,
  setIsChangingKey,
  showUnlockDialog,
  setShowUnlockDialog,
  unlockMasterKey,
  setUnlockMasterKey,
  showUnlockMasterKey,
  setShowUnlockMasterKey,
  unlockError,
  setUnlockError,
  isUnlocking,
  setIsUnlocking,
  showClearLocalDialog,
  setShowClearLocalDialog,
  onBuildPayload,
  onApplyPayload,
  onClearLocalData,
  ensureSyncablePayload,
  showForcePushConfirm,
  setShowForcePushConfirm,
  blockedFinding,
  setBlockedFinding
}) => (
  <>
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
  </>
);
