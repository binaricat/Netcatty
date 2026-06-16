/**
 * SFTP Conflict Resolution Dialog
 */

import { AlertCircle } from 'lucide-react';
import React, { memo, useState } from 'react';
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
    const conflict = conflicts[0]; // Handle first conflict

    if (!conflict) return null;

    const formatDate = (timestamp: number) => {
        return new Date(timestamp).toLocaleString();
    };

    const sameTypeConflictCount = Math.max(
        conflict.applyToAllCount ?? 1,
        conflicts.filter((item) => getConflictTypeKey(item) === getConflictTypeKey(conflict)).length,
    );
    const canMerge = conflict.isDirectory && conflict.existingType === 'directory';
    const canReplace = canReplaceConflict(conflict);

    const handleAction = (action: FileConflictAction) => {
        onResolve(conflict.transferId, action, applyToAll);
        setApplyToAll(false);
    };

    return (
        <Dialog open={!!conflict} onOpenChange={() => handleAction('skip')}>
            <DialogContent className="gap-5 p-5 sm:max-w-[520px] sm:p-6">
                <DialogHeader className="space-y-2 pr-8">
                    <DialogTitle className="flex items-center gap-3 text-xl leading-tight">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/70 text-muted-foreground">
                            <AlertCircle className="h-5 w-5" />
                        </span>
                        {t('sftp.conflict.title')}
                    </DialogTitle>
                    <DialogDescription className="text-[15px] leading-6">
                        {t('sftp.conflict.desc')}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                    <div className="rounded-md border border-border/60 bg-muted/25 px-4 py-3 text-sm leading-6">
                        <div className="min-w-0 break-words">
                            <span className="font-medium text-foreground">{conflict.fileName}</span>
                            <span className="ml-1 text-muted-foreground">{t('sftp.conflict.alreadyExistsSuffix')}</span>
                        </div>
                    </div>

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

                <DialogFooter className="flex flex-wrap gap-2 sm:items-center sm:justify-end sm:space-x-0">
                    <Button
                        variant="outline"
                        onClick={() => handleAction('stop')}
                        className="min-w-24 border-border/70 text-muted-foreground hover:text-destructive sm:mr-auto"
                    >
                        {t('sftp.conflict.action.stop')}
                    </Button>
                    <Button
                        variant="outline"
                        onClick={() => handleAction('skip')}
                        className="min-w-24"
                    >
                        {t('sftp.conflict.action.skip')}
                    </Button>
                    <Button
                        variant="outline"
                        onClick={() => handleAction('duplicate')}
                        className="min-w-24"
                    >
                        {t('sftp.conflict.action.duplicate')}
                    </Button>
                    {conflict.isDirectory && (
                        <Button
                            variant="outline"
                            onClick={() => handleAction('merge')}
                            disabled={!canMerge}
                            className="min-w-24"
                        >
                            {t('sftp.conflict.action.merge')}
                        </Button>
                    )}
                    {canReplace && (
                        <Button
                            variant="default"
                            onClick={() => handleAction('replace')}
                            className="min-w-28"
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
