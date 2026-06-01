/**
 * View Key Panel - Display SSH key details
 */

import { Check, Copy, Info } from 'lucide-react';
import React, { useCallback, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { SSHKey } from '../../types';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { copyToClipboard } from './utils';

interface ViewKeyPanelProps {
    keyItem: SSHKey;
    onExport: () => void;
}

export const ViewKeyPanel: React.FC<ViewKeyPanelProps> = ({
    keyItem,
    onExport,
}) => {
    const { t } = useI18n();
    const [copied, setCopied] = useState(false);

    const handleCopyPublicKey = useCallback(async () => {
        const ok = await copyToClipboard(keyItem.publicKey || '');
        if (!ok) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }, [keyItem.publicKey]);

    return (
        <>
            <div className="space-y-2">
                <Label className="text-muted-foreground">{t('keychain.field.label')}</Label>
                <p className="text-sm">{keyItem.label}</p>
            </div>

            {keyItem.publicKey && (
                <div className="space-y-2">
                    <Label className="text-muted-foreground">{t('keychain.field.publicKey')}</Label>
                    <div className="flex rounded-lg border border-border/80 bg-card overflow-hidden">
                        <div className="flex-1 min-w-0 p-3 font-mono text-xs break-all max-h-32 overflow-y-auto">
                            {keyItem.publicKey}
                        </div>
                        <div className="shrink-0 flex flex-col border-l border-border/60 p-1">
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-7 w-7"
                                        onClick={() => void handleCopyPublicKey()}
                                        aria-label={
                                            copied
                                                ? t('cloudSync.githubFlow.copied')
                                                : t('action.copyPublicKey')
                                        }
                                    >
                                        {copied ? <Check size={12} /> : <Copy size={12} />}
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent side="left">
                                    {copied
                                        ? t('cloudSync.githubFlow.copied')
                                        : t('action.copyPublicKey')}
                                </TooltipContent>
                            </Tooltip>
                        </div>
                    </div>
                </div>
            )}

            <div className="space-y-1">
                <Label className="text-muted-foreground">{t('field.type')}</Label>
                <p className="text-sm">{keyItem.type}</p>
            </div>

            {/* Key Export section */}
            <div className="pt-4 mt-4 border-t border-border/60">
                <div className="flex items-center gap-2 mb-3">
                    <span className="text-sm font-medium">{t('keychain.export.title')}</span>
                    <div className="h-4 w-4 rounded-full bg-muted flex items-center justify-center">
                        <Info size={10} className="text-muted-foreground" />
                    </div>
                </div>
                <Button className="w-full h-11" onClick={onExport}>
                    {t('keychain.export.exportToHost')}
                </Button>
            </div>
        </>
    );
};
