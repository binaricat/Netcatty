/**
 * SFTP Host Picker Dialog
 */

import { Monitor, Search } from 'lucide-react';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import {
    sftpHostEndpointsEqual,
    type SftpConnectedHostEntry,
} from '../../domain/sftpConnectedHosts';
import { Host } from '../../types';
import { DistroAvatar } from '../DistroAvatar';
import { getQuickSwitcherRowStateClass, shouldUseQuickSwitcherPointerNavigation } from '../QuickSwitcher';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';

interface SftpHostPickerProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    hosts: Host[];
    connectedHosts?: SftpConnectedHostEntry[];
    side: 'left' | 'right';
    hostSearch: string;
    onHostSearchChange: (search: string) => void;
    onSelectLocal: () => void;
    onSelectHost: (host: Host, options?: { sourceSessionId?: string }) => void;
}

const StatusDot: React.FC = () => (
    <span className="h-1.5 w-1.5 rounded-full shrink-0 bg-emerald-500" aria-hidden />
);

function formatHostMeta(host: Host): string {
    const endpoint = host.username ? `${host.username}@${host.hostname}` : host.hostname;
    return host.group ? `${endpoint} · ${host.group}` : endpoint;
}

const SftpHostPickerInner: React.FC<SftpHostPickerProps> = ({
    open,
    onOpenChange,
    hosts,
    connectedHosts = [],
    side,
    hostSearch,
    onHostSearchChange,
    onSelectLocal,
    onSelectHost,
}) => {
    const { t } = useI18n();
    const inputRef = useRef<HTMLInputElement>(null);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [isKeyboardNavigating, setIsKeyboardNavigating] = useState(true);
    const isKeyboardNavigatingRef = useRef(true);
    const term = hostSearch.trim().toLowerCase();

    const filteredConnectedHosts = useMemo(() => {
        return connectedHosts.filter(({ host }) =>
            !term ||
            host.label.toLowerCase().includes(term) ||
            host.hostname.toLowerCase().includes(term) ||
            host.username.toLowerCase().includes(term),
        );
    }, [connectedHosts, term]);

    const connectedByHostId = useMemo(() => {
        const map = new Map<string, SftpConnectedHostEntry>();
        for (const entry of filteredConnectedHosts) {
            map.set(entry.host.id, entry);
        }
        return map;
    }, [filteredConnectedHosts]);

    const filteredHosts = useMemo(() => {
        return hosts.filter((h) => {
            // Filter out serial hosts - SFTP is not supported for serial connections
            if (h.protocol === "serial") return false;
            // Hide a saved host only when Connected already shows the same endpoint.
            // If the vault host was edited after connect, keep both: Live (old) + Saved (new).
            const connected = connectedByHostId.get(h.id);
            if (connected && sftpHostEndpointsEqual(h, connected.host)) return false;
            return !term
                || h.label.toLowerCase().includes(term)
                || h.hostname.toLowerCase().includes(term);
        }).sort((a, b) => a.label.localeCompare(b.label));
    }, [hosts, term, connectedByHostId]);
    const sideLabel = side === 'left' ? t('common.left') : t('common.right');

    type PickerItem =
        | { type: 'local'; id: string }
        | { type: 'connected'; id: string; entry: SftpConnectedHostEntry }
        | { type: 'host'; id: string; host: Host };

    const items = useMemo<PickerItem[]>(() => {
        const localItem: PickerItem = { type: 'local', id: 'local' };
        const connectedItems: PickerItem[] = filteredConnectedHosts.map((entry) => ({
            type: 'connected',
            id: `connected:${entry.sessionId}`,
            entry,
        }));
        const hostItems: PickerItem[] = filteredHosts.map((host) => ({ type: 'host', id: host.id, host }));
        return [localItem, ...connectedItems, ...hostItems];
    }, [filteredConnectedHosts, filteredHosts]);

    useEffect(() => {
        if (!open) return;
        setSelectedIndex(0);
        isKeyboardNavigatingRef.current = true;
        setIsKeyboardNavigating(true);
        const focusTimer = setTimeout(() => inputRef.current?.focus(), 50);
        return () => clearTimeout(focusTimer);
    }, [open]);

    useEffect(() => {
        if (!open) return;
        setSelectedIndex(0);
        isKeyboardNavigatingRef.current = true;
        setIsKeyboardNavigating(true);
    }, [hostSearch, open]);

    useEffect(() => {
        if (!open) return;
        setSelectedIndex((prev) => Math.min(prev, Math.max(items.length - 1, 0)));
    }, [items.length, open]);

    const handleSelect = (item: PickerItem) => {
        if (item.type === 'local') {
            onSelectLocal();
        } else if (item.type === 'connected') {
            onSelectHost(item.entry.host, { sourceSessionId: item.entry.sessionId });
        } else {
            onSelectHost(item.host);
        }
        onOpenChange(false);
    };

    // Match Quick Switcher: pointer movement only leaves keyboard-nav mode.
    // It must not rewrite the keyboard-selected index until the user clicks.
    const handlePointerHover = useCallback((movementX: number, movementY: number) => {
        if (!shouldUseQuickSwitcherPointerNavigation(movementX, movementY)) return;
        if (!isKeyboardNavigatingRef.current) return;
        isKeyboardNavigatingRef.current = false;
        setIsKeyboardNavigating(false);
    }, []);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            isKeyboardNavigatingRef.current = true;
            setIsKeyboardNavigating(true);
            setSelectedIndex((prev) => Math.min(prev + 1, items.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            isKeyboardNavigatingRef.current = true;
            setIsKeyboardNavigating(true);
            setSelectedIndex((prev) => Math.max(prev - 1, 0));
        } else if (e.key === 'Enter' && items.length > 0) {
            e.preventDefault();
            handleSelect(items[selectedIndex]);
        }
    };

    const itemIndexById = useMemo(() => {
        const map = new Map<string, number>();
        items.forEach((item, index) => map.set(item.id, index));
        return map;
    }, [items]);

    const renderHostRow = (
        itemId: string,
        host: Host,
        meta: { showStatus?: boolean } = {},
    ) => {
        const itemIndex = itemIndexById.get(itemId) ?? 0;
        const isSelected = selectedIndex === itemIndex;
        return (
            <div
                key={itemId}
                className={`flex items-center justify-between px-4 py-2.5 cursor-pointer transition-colors ${getQuickSwitcherRowStateClass(isSelected, isKeyboardNavigating)}`}
                onClick={() => handleSelect(items[itemIndex])}
                onMouseMove={(event) => handlePointerHover(event.movementX, event.movementY)}
            >
                <div className="flex items-center gap-3 min-w-0">
                    <DistroAvatar host={host} fallback={host.label.slice(0, 2).toUpperCase()} size="sm" />
                    <div className="flex min-w-0 items-center gap-1.5">
                        {meta.showStatus ? <StatusDot /> : null}
                        <span className="text-sm font-medium truncate">{host.label}</span>
                    </div>
                </div>
                <div className="ml-3 shrink-0 text-[11px] text-muted-foreground truncate max-w-[12rem]">
                    {formatHostMeta(host)}
                </div>
            </div>
        );
    };

    const showHostsEmpty = filteredHosts.length === 0 && filteredConnectedHosts.length === 0;
    const localSelected = selectedIndex === 0;

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
                            className={`flex items-center justify-between px-4 py-2.5 cursor-pointer transition-colors ${getQuickSwitcherRowStateClass(localSelected, isKeyboardNavigating)}`}
                            onClick={() => handleSelect(items[0])}
                            onMouseMove={(event) => handlePointerHover(event.movementX, event.movementY)}
                        >
                            <div className="flex items-center gap-3 min-w-0">
                                <div className="h-6 w-6 rounded flex items-center justify-center text-muted-foreground">
                                    <Monitor size={16} />
                                </div>
                                <span className="text-sm font-medium truncate">{t('sftp.picker.local.title')}</span>
                            </div>
                            <div className="ml-3 shrink-0 text-[11px] text-muted-foreground truncate max-w-[12rem]">
                                {t('sftp.picker.local.desc')}
                            </div>
                        </div>

                        {filteredConnectedHosts.length > 0 && (
                            <>
                                <div className="px-4 pt-3 pb-1.5">
                                    <span className="text-xs font-medium text-muted-foreground">
                                        {t('sftp.picker.connected.section')}
                                    </span>
                                </div>
                                {filteredConnectedHosts.map((entry) =>
                                    renderHostRow(
                                        `connected:${entry.sessionId}`,
                                        entry.host,
                                        { showStatus: true },
                                    ),
                                )}
                            </>
                        )}

                        {(filteredHosts.length > 0 || showHostsEmpty) && (
                          <>
                            <div className="px-4 pt-3 pb-1.5">
                                <span className="text-xs font-medium text-muted-foreground">
                                    {t('vault.nav.hosts')}
                                </span>
                            </div>
                            {filteredHosts.length > 0 ? (
                                filteredHosts.map((host) => renderHostRow(host.id, host))
                            ) : (
                                <div className="px-4 py-6 text-xs text-muted-foreground text-center">
                                    {t('sftp.picker.noMatch')}
                                </div>
                            )}
                          </>
                        )}
                    </div>
                </ScrollArea>
            </DialogContent>
        </Dialog>
    );
};

export const SftpHostPicker = memo(SftpHostPickerInner);
SftpHostPicker.displayName = 'SftpHostPicker';
