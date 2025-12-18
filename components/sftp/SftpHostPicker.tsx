/**
 * SFTP Host Picker Dialog
 */

import { Monitor, Search } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { Host } from '../../types';
import { DistroAvatar } from '../DistroAvatar';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';

interface SftpHostPickerProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    hosts: Host[];
    side: 'left' | 'right';
    hostSearch: string;
    onHostSearchChange: (search: string) => void;
    onSelectLocal: () => void;
    onSelectHost: (host: Host) => void;
}

export const SftpHostPicker: React.FC<SftpHostPickerProps> = ({
    open,
    onOpenChange,
    hosts,
    side,
    hostSearch,
    onHostSearchChange,
    onSelectLocal,
    onSelectHost,
}) => {
    const { t } = useI18n();
    const inputRef = useRef<HTMLInputElement>(null);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const filteredHosts = useMemo(() => {
        const term = hostSearch.trim().toLowerCase();
        return hosts.filter(h =>
            !term ||
            h.label.toLowerCase().includes(term) ||
            h.hostname.toLowerCase().includes(term)
        ).sort((a, b) => a.label.localeCompare(b.label));
    }, [hosts, hostSearch]);
    const sideLabel = side === 'left' ? t('common.left') : t('common.right');
    const items = useMemo(() => {
        return [{ type: 'local' as const, id: 'local' }].concat(
            filteredHosts.map((host) => ({ type: 'host' as const, id: host.id, host }))
        );
    }, [filteredHosts]);

    useEffect(() => {
        if (open) {
            setSelectedIndex(0);
            setTimeout(() => inputRef.current?.focus(), 50);
        }
    }, [open]);

    useEffect(() => {
        if (!open) return;
        setSelectedIndex(0);
    }, [hostSearch, open]);

    const handleSelect = (item: typeof items[number]) => {
        if (item.type === 'local') {
            onSelectLocal();
        } else {
            onSelectHost(item.host);
        }
        onOpenChange(false);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedIndex((prev) => Math.min(prev + 1, items.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedIndex((prev) => Math.max(prev - 1, 0));
        } else if (e.key === 'Enter' && items.length > 0) {
            e.preventDefault();
            handleSelect(items[selectedIndex]);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg p-0 overflow-hidden gap-0">
                <DialogHeader className="sr-only">
                    <DialogTitle>{t('sftp.picker.title')}</DialogTitle>
                    <DialogDescription>
                        {t('sftp.picker.desc', { side: side === 'left' ? t('common.left') : t('common.right') })}
                    </DialogDescription>
                </DialogHeader>
                <div className="flex items-center gap-3 px-4 py-3 pr-12 border-b border-border">
                    <Search size={16} className="text-muted-foreground" />
                    <Input
                        ref={inputRef}
                        value={hostSearch}
                        onChange={e => onHostSearchChange(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={t('sftp.picker.searchPlaceholder')}
                        className="flex-1 h-8 border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 px-0 text-sm"
                    />
                    <span className="ml-auto mr-1 text-[11px] text-muted-foreground bg-muted px-2 py-0.5 rounded whitespace-nowrap">
                        {sideLabel}
                    </span>
                </div>

                <ScrollArea className="max-h-[360px]">
                    <div className="py-2">
                        <div className="px-4 py-1.5">
                            <span className="text-xs font-medium text-muted-foreground">
                                {t('sftp.picker.local.badge')}
                            </span>
                        </div>
                        <div
                            className={`flex items-center justify-between px-4 py-2.5 cursor-pointer transition-colors ${selectedIndex === 0 ? 'bg-primary/15' : 'hover:bg-muted/50'
                                }`}
                            onClick={() => handleSelect(items[0])}
                            onMouseEnter={() => setSelectedIndex(0)}
                        >
                            <div className="flex items-center gap-3 min-w-0">
                                <div className="h-6 w-6 rounded-md bg-primary/10 border border-primary/30 flex items-center justify-center text-primary">
                                    <Monitor size={14} />
                                </div>
                                <div className="min-w-0">
                                    <div className="text-sm font-medium truncate">{t('sftp.picker.local.title')}</div>
                                    <div className="text-xs text-muted-foreground truncate">{t('sftp.picker.local.desc')}</div>
                                </div>
                            </div>
                            <span className="text-[11px] text-muted-foreground">
                                {t('sftp.picker.local.badge')}
                            </span>
                        </div>

                        <div className="px-4 pt-3 pb-1.5">
                            <span className="text-xs font-medium text-muted-foreground">
                                {t('vault.nav.hosts')}
                            </span>
                        </div>
                        {filteredHosts.length > 0 ? (
                            filteredHosts.map((host, index) => {
                                const itemIndex = index + 1;
                                return (
                                    <div
                                        key={host.id}
                                        className={`flex items-center justify-between px-4 py-2.5 cursor-pointer transition-colors ${selectedIndex === itemIndex ? 'bg-primary/15' : 'hover:bg-muted/50'
                                            }`}
                                        onClick={() => handleSelect(items[itemIndex])}
                                        onMouseEnter={() => setSelectedIndex(itemIndex)}
                                    >
                                        <div className="flex items-center gap-3 min-w-0">
                                            <DistroAvatar host={host} fallback={host.label[0].toUpperCase()} size="sm" />
                                            <div className="min-w-0">
                                                <div className="text-sm font-medium truncate">{host.label}</div>
                                                <div className="text-xs text-muted-foreground truncate">
                                                    {host.username}@{host.hostname}
                                                </div>
                                            </div>
                                        </div>
                                        <span className="text-[11px] text-muted-foreground">SSH</span>
                                    </div>
                                );
                            })
                        ) : (
                            <div className="px-4 py-6 text-xs text-muted-foreground text-center">
                                {t('sftp.picker.noMatch')}
                            </div>
                        )}
                    </div>
                </ScrollArea>
            </DialogContent>
        </Dialog>
    );
};
