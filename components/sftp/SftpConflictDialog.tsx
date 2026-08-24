/**
 * SFTP Conflict Resolution Dialog
 */

import { AlertCircle, AlertTriangle } from 'lucide-react';
import React, { memo, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { canReplaceSftpConflict, getSftpConflictTypeKey } from '../../domain/sftpConflict';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import type { FileConflictAction } from '../../domain/models';

interface ConflictItem {
    transferId: string;
    fileName: string;
    sourcePath: string;
    targetPath: string;
    isDirectory: boolean;
    existingType?: 'file' | 'directory' | 'symlink';
    applyToAllCount?: number;
    existingSize: number;
    newSize: number;
    existingModified: number;
    newModified: number;
}

export const canReplaceConflict = (conflict: Pick<ConflictItem, 'isDirectory' | 'existingType'>): boolean => {
    return canReplaceSftpConflict(conflict.isDirectory, conflict.existingType);
};

export const getSftpConflictDialogPresentation = (
    conflict: Pick<ConflictItem, 'isDirectory' | 'existingType'>,
) => {
    const isDestructiveDirectoryReplace = conflict.isDirectory && conflict.existingType === 'directory';
    const descriptionKey = !conflict.isDirectory
        ? 'sftp.conflict.desc'
        : conflict.existingType === 'file'
            ? 'sftp.conflict.folderFileDesc'
            : conflict.existingType === 'symlink'
                ? 'sftp.conflict.folderSymlinkDesc'
                : conflict.existingType === 'directory'
                    ? 'sftp.conflict.folderDesc'
                    : 'sftp.conflict.folderUnknownDesc';

    return {
        titleKey: conflict.isDirectory ? 'sftp.conflict.folderTitle' : 'sftp.conflict.title',
        descriptionKey,
        showFileMetadata: !conflict.isDirectory,
        showDirectoryReplaceWarning: isDestructiveDirectoryReplace,
        mergeVariant: isDestructiveDirectoryReplace ? 'default' : 'outline',
        replaceVariant: isDestructiveDirectoryReplace ? 'outline' : 'default',
    } as const;
};

const getConflictTypeKey = (conflict: Pick<ConflictItem, 'isDirectory' | 'existingType'>): string =>
    getSftpConflictTypeKey(conflict.isDirectory, conflict.existingType);

interface SftpConflictDialogProps {
    conflicts: ConflictItem[];
    onResolve: (conflictId: string, action: FileConflictAction, applyToAll?: boolean) => void;
    formatFileSize: (size: number) => string;
}

interface ConflictFileSummaryProps {
    title: string;
    sizeLabel: string;
    modifiedLabel: string;
    size: string;
    modified: string;
}

const ConflictFileSummary: React.FC<ConflictFileSummaryProps> = ({
    title,
    sizeLabel,
    modifiedLabel,
    size,
    modified,
}) => (
    <div className="rounded-md border border-border/60 bg-secondary/25 px-4 py-3">
        <div className="mb-3 flex items-center justify-between gap-3">
            <div className="text-sm font-medium text-foreground">
                {title}
            </div>
        </div>
        <dl className="space-y-2 text-sm">
            <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3">
                <dt className="text-muted-foreground">{sizeLabel}</dt>
                <dd className="min-w-0 text-foreground">{size}</dd>
            </div>
            <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3">
                <dt className="text-muted-foreground">{modifiedLabel}</dt>
                <dd className="min-w-0 break-words leading-relaxed text-foreground">{modified}</dd>
            </div>
        </dl>
    </div>
);

const SftpConflictDialogInner: React.FC<SftpConflictDialogProps> = ({ conflicts, onResolve, formatFileSize }) => {
    const { t } = useI18n();
    const [applyToAll, setApplyToAll] = useState(false);
    const duplicateButtonRef = useRef<HTMLButtonElement>(null);
    const mergeButtonRef = useRef<HTMLButtonElement>(null);
    const replaceButtonRef = useRef<HTMLButtonElement>(null);
    const previousConflictIdRef = useRef<string | undefined>(undefined);
    const descriptionId = React.useId();
    const directoryWarningId = React.useId();
    const conflict = conflicts[0]; // Handle first conflict
    const currentCanMerge = conflict?.isDirectory === true && conflict.existingType === 'directory';
    const currentCanReplace = conflict ? canReplaceConflict(conflict) : false;

    useEffect(() => {
        const currentConflictId = conflict?.transferId;
        const previousConflictId = previousConflictIdRef.current;
        previousConflictIdRef.current = currentConflictId;
        if (!currentConflictId || !previousConflictId || currentConflictId === previousConflictId) return;

        const nextAction = currentCanMerge
            ? mergeButtonRef.current
            : currentCanReplace
                ? replaceButtonRef.current
                : duplicateButtonRef.current;
        if (!nextAction) return;

        // If the previously focused action disappears or becomes disabled,
        // Radix may restore focus to the first button after this effect. Focus
        // on the next frame so the current conflict's safe action wins.
        if (typeof globalThis.requestAnimationFrame === 'function') {
            const frame = globalThis.requestAnimationFrame(() => nextAction.focus());
            return () => globalThis.cancelAnimationFrame(frame);
        }
        const timer = globalThis.setTimeout(() => nextAction.focus(), 0);
        return () => globalThis.clearTimeout(timer);
    }, [conflict?.transferId, currentCanMerge, currentCanReplace]);

    if (!conflict) return null;

    const formatDate = (timestamp: number) => {
        return new Date(timestamp).toLocaleString();
    };

    const sameTypeConflictCount = Math.max(
        conflict.applyToAllCount ?? 1,
        conflicts.filter((item) => getConflictTypeKey(item) === getConflictTypeKey(conflict)).length,
    );
    const canMerge = currentCanMerge;
    const canReplace = currentCanReplace;
    const presentation = getSftpConflictDialogPresentation(conflict);
    const describedBy = presentation.showDirectoryReplaceWarning
        ? `${descriptionId} ${directoryWarningId}`
        : descriptionId;

    const handleAction = (action: FileConflictAction) => {
        onResolve(conflict.transferId, action, applyToAll);
        setApplyToAll(false);
    };

    return (
        <Dialog open={!!conflict} onOpenChange={() => handleAction('skip')}>
            <DialogContent
                className="gap-5 p-5 sm:max-w-[640px] sm:p-6"
                aria-describedby={describedBy}
            >
                <DialogHeader className="space-y-2 pr-8">
                    <DialogTitle className="flex items-center gap-3 text-xl leading-tight">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/70 text-muted-foreground">
                            <AlertCircle className="h-5 w-5" />
                        </span>
                        {t(presentation.titleKey)}
                    </DialogTitle>
                    <div id={descriptionId}>
                        <DialogDescription className="text-[15px] leading-6">
                            {t(presentation.descriptionKey)}
                        </DialogDescription>
                    </div>
                </DialogHeader>

                <div className="space-y-4">
                    <div className="rounded-md border border-border/60 bg-muted/25 px-4 py-3 text-sm leading-6">
                        <div className="min-w-0 break-words">
                            <span className="font-medium text-foreground">{conflict.fileName}</span>
                            <span className="ml-1 text-muted-foreground">{t('sftp.conflict.alreadyExistsSuffix')}</span>
                        </div>
                    </div>

                    {presentation.showFileMetadata && (
                        <div className="space-y-3">
                            <ConflictFileSummary
                                title={t('sftp.conflict.existingFile')}
                                sizeLabel={t('sftp.conflict.size')}
                                modifiedLabel={t('sftp.conflict.modified')}
                                size={formatFileSize(conflict.existingSize)}
                                modified={formatDate(conflict.existingModified)}
                            />
                            <ConflictFileSummary
                                title={t('sftp.conflict.newFile')}
                                sizeLabel={t('sftp.conflict.size')}
                                modifiedLabel={t('sftp.conflict.modified')}
                                size={formatFileSize(conflict.newSize)}
                                modified={formatDate(conflict.newModified)}
                            />
                        </div>
                    )}

                    {presentation.showDirectoryReplaceWarning && (
                        <div
                            id={directoryWarningId}
                            className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm leading-6"
                        >
                            <div className="flex items-start gap-2 text-foreground">
                                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                                <p>{t('sftp.conflict.folderMergeHint')}</p>
                            </div>
                            <p className="pl-6 font-medium text-destructive">
                                {t('sftp.conflict.folderReplaceWarning')}
                            </p>
                        </div>
                    )}

                    {sameTypeConflictCount > 1 && (
                        <label className="flex cursor-pointer items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                            <input
                                type="checkbox"
                                checked={applyToAll}
                                onChange={(e) => setApplyToAll(e.target.checked)}
                                className="rounded border-border"
                            />
                            {t('sftp.conflict.applyToAll', { count: sameTypeConflictCount })}
                        </label>
                    )}
                </div>

                <DialogFooter className="flex flex-wrap gap-2 sm:flex-nowrap sm:items-center sm:justify-end sm:space-x-0">
                    <Button
                        variant="outline"
                        onClick={() => handleAction('stop')}
                        className="min-w-24 shrink-0 border-border/70 text-muted-foreground hover:text-destructive sm:mr-auto"
                    >
                        {t('sftp.conflict.action.stop')}
                    </Button>
                    <Button
                        variant="outline"
                        onClick={() => handleAction('skip')}
                        className="min-w-24 shrink-0"
                    >
                        {t('sftp.conflict.action.skip')}
                    </Button>
                    <Button
                        ref={duplicateButtonRef}
                        variant="outline"
                        onClick={() => handleAction('duplicate')}
                        className="min-w-24 shrink-0"
                    >
                        {t('sftp.conflict.action.duplicate')}
                    </Button>
                    {conflict.isDirectory && (
                        <Button
                            ref={mergeButtonRef}
                            variant={presentation.mergeVariant}
                            onClick={() => handleAction('merge')}
                            disabled={!canMerge}
                            autoFocus={presentation.showDirectoryReplaceWarning}
                            className="min-w-24 shrink-0"
                        >
                            {t('sftp.conflict.action.merge')}
                        </Button>
                    )}
                    {canReplace && (
                        <Button
                            ref={replaceButtonRef}
                            variant={presentation.replaceVariant}
                            onClick={() => handleAction('replace')}
                            className={presentation.showDirectoryReplaceWarning
                                ? 'min-w-28 shrink-0 border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive'
                                : 'min-w-28 shrink-0'}
                        >
                            {t('sftp.conflict.action.replace')}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export const SftpConflictDialog = memo(SftpConflictDialogInner);
SftpConflictDialog.displayName = 'SftpConflictDialog';
