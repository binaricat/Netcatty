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
import { isPluginHostProtocol } from '../../domain/pluginConnection';
import { Host } from '../../types';
import { DistroAvatar } from '../DistroAvatar';
import { getQuickSwitcherRowStateClass, shouldUseQuickSwitcherPointerNavigation } from '../QuickSwitcher';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import {
    VariableSizeVirtualList,
    type VariableSizeVirtualListHandle,
} from '../ui/VariableSizeVirtualList';
import { clampListIndex, stepListIndex } from '../ui/virtualListMath';

const SFTP_PICKER_ROW_HEIGHT = 44;
const SFTP_PICKER_HEADER_HEIGHT = 32;
const SFTP_PICKER_EMPTY_HEIGHT = 56;

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

type PickerItem =
    | { type: 'local'; id: string }
    | { type: 'connected'; id: string; entry: SftpConnectedHostEntry }
    | { type: 'host'; id: string; host: Host };

type VisualRow =
    | { kind: 'header'; key: string; label: string }
    | { kind: 'item'; key: string; item: PickerItem; itemIndex: number }
    | { kind: 'empty'; key: string; message: string };

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
    const listRef = useRef<VariableSizeVirtualListHandle>(null);
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
            // SFTP is an SSH-specific host capability. Plugin protocols may
            // provide arbitrary transports and cannot be treated as SSH.
            if (h.protocol === "serial" || isPluginHostProtocol(h.protocol)) return false;
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

    const { items, visualRows, itemIndexToVisualIndex } = useMemo(() => {
        const nextItems: PickerItem[] = [];
        const nextVisual: VisualRow[] = [];
        const nextMap = new Map<number, number>();

        const pushHeader = (key: string, label: string) => {
            nextVisual.push({ kind: 'header', key, label });
        };
        const pushItem = (item: PickerItem) => {
            const itemIndex = nextItems.length;
            nextItems.push(item);
            nextMap.set(itemIndex, nextVisual.length);
            nextVisual.push({ kind: 'item', key: item.id, item, itemIndex });
        };

        pushHeader('header:local', t('sftp.picker.local.badge'));
        pushItem({ type: 'local', id: 'local' });

        if (filteredConnectedHosts.length > 0) {
            pushHeader('header:connected', t('sftp.picker.connected.section'));
            for (const entry of filteredConnectedHosts) {
                pushItem({
                    type: 'connected',
                    id: `connected:${entry.sessionId}`,
                    entry,
                });
            }
        }

        // Only show the Hosts section when there are saved hosts to list, or when
        // nothing matched at all (no connected + no saved). Avoid a dangling
        // "Hosts" header after connected-only results hide the saved inventory.
        if (filteredHosts.length > 0) {
            pushHeader('header:hosts', t('vault.nav.hosts'));
            for (const host of filteredHosts) {
                pushItem({ type: 'host', id: host.id, host });
            }
        } else if (filteredConnectedHosts.length === 0) {
            pushHeader('header:hosts', t('vault.nav.hosts'));
            nextVisual.push({
                kind: 'empty',
                key: 'empty:hosts',
                message: t('sftp.picker.noMatch'),
            });
        }

        return {
            items: nextItems,
            visualRows: nextVisual,
            itemIndexToVisualIndex: nextMap,
        };
    }, [filteredConnectedHosts, filteredHosts, t]);

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
        setSelectedIndex((prev) => clampListIndex(prev, items.length));
    }, [items.length, open]);

    useEffect(() => {
        if (!open) return;
        const visualIndex = itemIndexToVisualIndex.get(selectedIndex);
        if (visualIndex === undefined) return;
        listRef.current?.scrollToIndex(visualIndex, 'auto');
    }, [itemIndexToVisualIndex, open, selectedIndex]);

    const handleSelect = useCallback((item: PickerItem) => {
        if (item.type === 'local') {
            onSelectLocal();
        } else if (item.type === 'connected') {
            onSelectHost(item.entry.host, { sourceSessionId: item.entry.sessionId });
        } else {
            onSelectHost(item.host);
        }
        onOpenChange(false);
    }, [onOpenChange, onSelectHost, onSelectLocal]);

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
            setSelectedIndex((prev) => stepListIndex(prev, items.length, 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            isKeyboardNavigatingRef.current = true;
            setIsKeyboardNavigating(true);
            setSelectedIndex((prev) => stepListIndex(prev, items.length, -1));
        } else if (e.key === 'Enter' && items.length > 0) {
            e.preventDefault();
            const item = items[clampListIndex(selectedIndex, items.length)];
            if (!item) return;
            handleSelect(item);
        }
    };

    const getRowHeight = useCallback((row: VisualRow) => {
        if (row.kind === 'header') return SFTP_PICKER_HEADER_HEIGHT;
        if (row.kind === 'empty') return SFTP_PICKER_EMPTY_HEIGHT;
        return SFTP_PICKER_ROW_HEIGHT;
    }, []);

    // Cap at 360px for large inventories, but shrink to content for short lists
    // (Local-only / few hosts) so the dialog does not leave a large blank region.
    const listViewportHeight = useMemo(() => {
        let total = 0;
        for (const row of visualRows) total += getRowHeight(row);
        return Math.min(360, Math.max(total, 1));
    }, [getRowHeight, visualRows]);

    const renderRow = useCallback((row: VisualRow) => {
        if (row.kind === 'header') {
            return (
                <div className="flex h-full items-end px-4 pb-1.5">
                    <span className="text-xs font-medium text-muted-foreground">{row.label}</span>
                </div>
            );
        }
        if (row.kind === 'empty') {
            return (
                <div className="px-4 py-6 text-xs text-muted-foreground text-center">
                    {row.message}
                </div>
            );
        }

        const { item, itemIndex } = row;
        const isSelected = selectedIndex === itemIndex;

        if (item.type === 'local') {
            return (
                <div
                    className={`flex items-center justify-between px-4 py-2.5 cursor-pointer transition-colors ${getQuickSwitcherRowStateClass(isSelected, isKeyboardNavigating)}`}
                    onClick={() => handleSelect(item)}
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
            );
        }

        const host = item.type === 'connected' ? item.entry.host : item.host;
        const showStatus = item.type === 'connected';
        return (
            <div
                className={`flex items-center justify-between px-4 py-2.5 cursor-pointer transition-colors ${getQuickSwitcherRowStateClass(isSelected, isKeyboardNavigating)}`}
                onClick={() => handleSelect(item)}
                onMouseMove={(event) => handlePointerHover(event.movementX, event.movementY)}
            >
                <div className="flex items-center gap-3 min-w-0">
                    <DistroAvatar host={host} fallback={host.label.slice(0, 2).toUpperCase()} size="sm" />
                    <div className="flex min-w-0 items-center gap-1.5">
                        {showStatus ? <StatusDot /> : null}
                        <span className="text-sm font-medium truncate">{host.label}</span>
                    </div>
                </div>
                <div className="ml-3 shrink-0 text-[11px] text-muted-foreground truncate max-w-[12rem]">
                    {formatHostMeta(host)}
                </div>
            </div>
        );
    }, [handlePointerHover, handleSelect, isKeyboardNavigating, selectedIndex, t]);

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

                <div
                    className="max-h-[360px]"
                    style={{ height: listViewportHeight }}
                    data-host-picker-virtual="sftp"
                >
                    <VariableSizeVirtualList<VisualRow>
                        ref={listRef}
                        items={visualRows}
                        getItemHeight={getRowHeight}
                        className="h-full"
                        overscan={8}
                        getItemKey={(row) => row.key}
                        renderItem={renderRow}
                    />
                </div>
            </DialogContent>
        </Dialog>
    );
};

export const SftpHostPicker = memo(SftpHostPickerInner);
SftpHostPicker.displayName = 'SftpHostPicker';
