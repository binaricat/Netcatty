/**
 * Key Card component for displaying SSH keys in grid/list view
 */

import { Copy,ExternalLink,Pencil,Trash2 } from 'lucide-react';
import React from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { cn } from '../../lib/utils';
import { SSHKey } from '../../types';
import { Button } from '../ui/button';
import {
    VaultEntityIcon,
    vaultCertificateIconClass,
    vaultKeyIconClass,
} from '../vault/VaultEntityIcon';
import {
ContextMenu,
ContextMenuContent,
ContextMenuItem,
ContextMenuSeparator,
ContextMenuTrigger,
} from '../ui/context-menu';
import { getKeyIcon,getKeyTypeDisplay } from './utils';

interface KeyCardProps {
    keyItem: SSHKey;
    viewMode: 'grid' | 'list';
    isSelected: boolean;
    isMac: boolean;
    onClick: () => void;
    onEdit: () => void;
    onExport: () => void;
    onCopyPublicKey: () => void;
    onDelete: () => void;
}

export const KeyCard: React.FC<KeyCardProps> = ({
    keyItem,
    viewMode,
    isSelected,
    isMac,
    onClick,
    onEdit,
    onExport,
    onCopyPublicKey,
    onDelete,
}) => {
    const { t } = useI18n();
    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>
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
                            className={keyItem.certificate
                              ? vaultCertificateIconClass
                              : vaultKeyIconClass}
                            icon={getKeyIcon(keyItem)}
                        />
                        <div className="min-w-0 flex-1">
                            <div className="text-sm font-semibold truncate">{keyItem.label}</div>
                            <div className="text-[11px] font-mono text-muted-foreground truncate">
                                Type {getKeyTypeDisplay(keyItem, isMac)}
                            </div>
                        </div>
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                            <Button
                                size="icon"
                                variant="ghost"
                                className="h-8 w-8"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onEdit();
                                }}
                            >
                                <Pencil size={14} />
                            </Button>
                        </div>
                    </div>
                </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
                <ContextMenuItem onClick={onCopyPublicKey} disabled={!keyItem.publicKey}>
                    <Copy size={14} className="mr-2" />
                    {t("action.copyPublicKey")}
                </ContextMenuItem>
                <ContextMenuItem onClick={onExport}>
                    <ExternalLink size={14} className="mr-2" />
                    {t("action.keyExport")}
                </ContextMenuItem>
                <ContextMenuItem onClick={onEdit}>
                    <Pencil size={14} className="mr-2" />
                    {t("action.edit")}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
                    <Trash2 size={14} className="mr-2" />
                    {t("action.delete")}
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    );
};
