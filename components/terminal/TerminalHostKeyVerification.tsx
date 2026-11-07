import { AlertTriangle, Fingerprint } from 'lucide-react';
import React from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { HostKeyInfo } from '../../domain/hostKey';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { TerminalConnectionLogList } from './TerminalConnectionProgress';

export type { HostKeyInfo } from '../../domain/hostKey';

export interface TerminalHostKeyVerificationProps {
    hostKeyInfo: HostKeyInfo;
    showLogs: boolean;
    progressLogs: string[];
    onClose: () => void;
    onContinue: () => void;
    onAddAndContinue: () => void;
}

export const TerminalHostKeyVerification: React.FC<TerminalHostKeyVerificationProps> = ({
    hostKeyInfo,
    showLogs,
    progressLogs,
    onClose,
    onContinue,
    onAddAndContinue,
}) => {
    const { t } = useI18n();
    const isChanged = hostKeyInfo.status === 'changed';
    const Icon = isChanged ? AlertTriangle : Fingerprint;

    return (
        <div data-host-security-surface="" className="space-y-3 animate-in fade-in-0 slide-in-from-bottom-1 duration-200">
            <div
                className={cn(
                    "rounded-xl border px-3 py-2.5",
                    isChanged
                        ? "border-destructive/25 bg-destructive/8"
                        : "border-amber-500/20 bg-amber-500/8",
                )}
            >
                <div className="flex items-start gap-2.5">
                    <div
                        className={cn(
                            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
                            isChanged
                                ? "bg-destructive/15 text-destructive"
                                : "bg-amber-500/15 text-amber-400",
                        )}
                    >
                        <Icon size={15} />
                    </div>
                    <div className="min-w-0 flex-1 space-y-1">
                        <div
                            className={cn(
                                "text-sm font-semibold",
                                isChanged ? "text-destructive" : "text-amber-400",
                            )}
                        >
                            {isChanged
                                ? t('terminal.hostKey.changedTitle')
                                : t('terminal.hostKey.unknownTitle')}
                        </div>
                        <p className="text-xs leading-5 text-muted-foreground">
                            {isChanged
                                ? t('terminal.hostKey.changedDescription', { host: hostKeyInfo.hostname })
                                : t('terminal.hostKey.unknownDescription', { host: hostKeyInfo.hostname })}
                        </p>
                    </div>
                </div>
            </div>

            <div className="space-y-2">
                <div className="text-[11px] text-muted-foreground">
                    {t('terminal.hostKey.fingerprintLabel', { keyType: hostKeyInfo.keyType })}
                </div>
                <div className="rounded-lg border border-border/50 bg-background/45 p-3">
                    <code className="block break-all font-mono text-xs leading-5 text-foreground/90">
                        {hostKeyInfo.fingerprint}
                    </code>
                </div>
                {isChanged && hostKeyInfo.knownFingerprint && (
                    <div className="rounded-lg border border-destructive/25 bg-destructive/8 p-3">
                        <div className="mb-1 text-[11px] font-medium text-destructive">
                            {t('terminal.hostKey.savedFingerprintLabel')}
                        </div>
                        <code className="block break-all font-mono text-xs leading-5 text-foreground/90">
                            {hostKeyInfo.knownFingerprint}
                        </code>
                    </div>
                )}
                <p className="text-xs leading-5 text-muted-foreground">
                    {isChanged
                        ? t('terminal.hostKey.changedHint')
                        : t('terminal.hostKey.unknownHint')}
                </p>
            </div>

            {showLogs && (
                <TerminalConnectionLogList progressLogs={progressLogs} />
            )}

            <div className="flex justify-end gap-2 pt-1">
                <Button variant="ghost" size="sm" className="h-7 px-3 text-[11px]" onClick={onClose}>
                    {t('common.close')}
                </Button>
                <Button variant="outline" size="sm" className="h-7 px-3 text-[11px]" onClick={onContinue}>
                    {t('common.continue')}
                </Button>
                <Button size="sm" className="h-7 px-3 text-[11px]" onClick={onAddAndContinue}>
                    {isChanged
                        ? t('terminal.hostKey.updateAndContinue')
                        : t('terminal.hostKey.addAndContinue')}
                </Button>
            </div>
        </div>
    );
};

export default TerminalHostKeyVerification;
