/**
 * Host Chain Sub-Panel
 * Panel for configuring SSH jump host chain
 */
import { ArrowDown,Plus,Search,X } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { Host } from '../../types';
import { DistroAvatar } from '../DistroAvatar';
import { AsidePanel, type AsidePanelLayout } from '../ui/aside-panel';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';

export interface ChainPanelProps {
    formLabel: string;
    formHostname: string;
    form: Host;
    chainedHosts: Host[];
    availableHostsForChain: Host[];
    onAddHost: (hostId: string) => void;
    onRemoveHost: (index: number) => void;
    onClearChain: () => void;
    onBack: () => void;
    onCancel: () => void;
    layout?: AsidePanelLayout;
}

export const ChainPanel: React.FC<ChainPanelProps> = ({
    formLabel,
    formHostname,
    form,
    chainedHosts,
    availableHostsForChain,
    onAddHost,
    onRemoveHost,
    onClearChain,
    onBack,
    onCancel,
    layout = 'overlay',
}) => {
    const { t } = useI18n();
    const [searchQuery, setSearchQuery] = useState('');
    const filteredHosts = useMemo(() => {
        if (!searchQuery.trim()) return availableHostsForChain;
        const q = searchQuery.toLowerCase();
        return availableHostsForChain.filter(
            (host) => host.label.toLowerCase().includes(q) || host.hostname.toLowerCase().includes(q)
        );
    }, [availableHostsForChain, searchQuery]);
    return (
        <AsidePanel
            open={true}
            onClose={onCancel}
            title={t('hostDetails.chain.title')}
            showBackButton={true}
            onBack={onBack}
            layout={layout}
            actions={
                <Button size="sm" onClick={onBack}>
                    {t('common.save')}
                </Button>
            }
        >
            <ScrollArea className="flex-1">
                <div className="p-4 space-y-4 w-0 min-w-full">
                    {/* Chain visualization */}
                    <div className="space-y-2">
                        {chainedHosts.map((host, index) => (
                            <React.Fragment key={host.id}>
                                {index > 0 && (
                                    <div className="flex justify-center py-1">
                                        <ArrowDown size={16} className="text-muted-foreground" />
                                    </div>
                                )}
                                <div className="flex items-center gap-2 p-2 rounded-lg border border-border/60 bg-card">
                                    <DistroAvatar host={host} fallback={host.label.slice(0, 2).toUpperCase()} className="h-8 w-8" />
                                    <span className="text-sm font-medium flex-1 min-w-0 truncate">{host.label || host.hostname}</span>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-6 w-6 text-muted-foreground hover:text-destructive"
                                        onClick={() => onRemoveHost(index)}
                                    >
                                        <X size={14} />
                                    </Button>
                                </div>
                            </React.Fragment>
                        ))}

                        {chainedHosts.length > 0 && (
                            <div className="flex justify-center py-1">
                                <ArrowDown size={16} className="text-muted-foreground" />
                            </div>
                        )}

                        {/* Target host (current) */}
                        <div className="flex items-center gap-2 p-2 rounded-lg border border-border/60 bg-card">
                            <DistroAvatar
                                host={form}
                                fallback={formLabel?.slice(0, 2).toUpperCase() || formHostname?.slice(0, 2).toUpperCase() || "H"}
                                className="h-8 w-8"
                            />
                            <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium truncate">{formLabel || formHostname || t('hostDetails.chain.target')}</div>
                                <div className="text-xs text-muted-foreground">{t('hostDetails.chain.target')}</div>
                            </div>
                        </div>
                    </div>

                    {/* Available hosts to add */}
                    {availableHostsForChain.length > 0 && (
                        <Card className="p-3 bg-card border-border/80">
                            <p className="text-xs font-semibold text-muted-foreground mb-2">{t('hostDetails.chain.availableHosts')}</p>
                            <div className="relative mb-2">
                                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                                <Input
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    placeholder={t('common.searchPlaceholder')}
                                    className="h-8 pl-8 text-sm"
                                />
                            </div>
                            <div className="space-y-1">
                                {filteredHosts.map((host) => (
                                    <button
                                        key={host.id}
                                        className="w-full flex items-center gap-2 p-2 rounded-md hover:bg-secondary transition-colors text-left overflow-hidden"
                                        onClick={() => onAddHost(host.id)}
                                    >
                                        <DistroAvatar host={host} fallback={host.label.slice(0, 2).toUpperCase()} className="h-8 w-8" />
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-medium truncate">{host.label}</div>
                                            <div className="text-xs text-muted-foreground truncate">{host.hostname}</div>
                                        </div>
                                        <Plus size={14} className="text-muted-foreground" />
                                    </button>
                                ))}
                            </div>
                        </Card>
                    )}

                    {chainedHosts.length > 0 && (
                        <Button variant="ghost" className="w-full h-10 text-destructive" onClick={onClearChain}>
                            {t('hostDetails.chain.clear')}
                        </Button>
                    )}
                </div>
            </ScrollArea>
        </AsidePanel>
    );
};

export default ChainPanel;
