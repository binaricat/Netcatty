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
    onClick: () => void;
}

export const IdentityCard: React.FC<IdentityCardProps> = ({
    identity,
    viewMode,
    isSelected,
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
            className={cn(
                "group cursor-pointer",
                viewMode === 'grid'
                    ? "soft-card elevate rounded-xl h-[68px] px-3 py-2"
                    : "h-14 px-3 py-2 hover:bg-secondary/60 rounded-lg transition-colors",
                isSelected && "ring-2 ring-primary"
            )}
            onClick={onClick}
        >
            <div className="flex items-center gap-3 h-full">
                <VaultEntityIcon
                    className={vaultIdentityIconClass}
                    icon={<User size={18} />}
                />
                <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold truncate">{identity.label || 'Add a label...'}</div>
                    <div className="text-[11px] font-mono text-muted-foreground truncate">
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
