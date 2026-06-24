/**
 * Identity Card component for displaying saved identities
 */

import { Pencil,User } from 'lucide-react';
import React from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { cn } from '../../lib/utils';
import { Identity } from '../../types';
import { Button } from '../ui/button';
import { VaultEntityIcon, vaultIdentityIconClass } from '../vault/VaultEntityIcon';

interface IdentityCardProps {
    identity: Identity;
    viewMode: 'grid' | 'list';
    isSelected: boolean;
    reorderProps?: React.HTMLAttributes<HTMLDivElement>;
    onClick: () => void;
}

export const IdentityCard: React.FC<IdentityCardProps> = ({
    identity,
    viewMode,
    isSelected,
    reorderProps,
    onClick,
}) => {
    const { t } = useI18n();

    const hasPassword = !!identity.password;
    const hasKey = !!identity.keyId;
    const keyKind = identity.authMethod === 'certificate' ? 'certificate' : 'key';

    const summary = hasPassword && hasKey
        ? (keyKind === 'certificate'
            ? t('keychain.identity.summary.passwordAndCertificate')
            : t('keychain.identity.summary.passwordAndKey'))
        : hasKey
            ? (keyKind === 'certificate'
                ? t('keychain.identity.summary.certificate')
                : t('keychain.identity.summary.key'))
            : hasPassword
                ? t('keychain.identity.summary.password')
                : t('keychain.identity.summary.none');

    return (
        <div
            {...reorderProps}
            className={cn(
                reorderProps && "vault-drop-indicator-row",
                "group cursor-pointer min-w-0 w-full max-w-full",
                viewMode === 'grid'
                    ? "soft-card elevate rounded-xl h-[68px] px-3 py-2"
                    : "h-14 px-3 py-2 hover:bg-secondary/60 rounded-lg transition-colors",
                isSelected && "ring-2 ring-primary",
                reorderProps?.className,
            )}
            onClick={onClick}
        >
            <div className="flex items-center gap-3 h-full min-w-0">
                <VaultEntityIcon
                    className={vaultIdentityIconClass}
                    icon={<User size={18} />}
                />
                <div className="min-w-0 flex-1 basis-0 overflow-hidden">
                    <div className="block max-w-full truncate text-sm font-semibold">{identity.label || 'Add a label...'}</div>
                    <div className="block max-w-full truncate text-[11px] font-mono text-muted-foreground">
                        {summary}
                    </div>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        onClick={(e) => {
                            e.stopPropagation();
                            onClick();
                        }}
                    >
                        <Pencil size={14} />
                    </Button>
                </div>
            </div>
        </div>
    );
};
