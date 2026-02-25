/**
 * Host Chain Sub-Panel
 * Panel for configuring SSH jump host chain
 */
import { ArrowDown,Plus,X } from 'lucide-react';
import React from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { Host, HostChainConnectionMode } from '../../types';
import { DistroAvatar } from '../DistroAvatar';
import { AsidePanel } from '../ui/aside-panel';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { ScrollArea } from '../ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

export interface ChainPanelProps {
    formLabel: string;
    formHostname: string;
    form: Host;
    chainedHosts: Host[];
    availableHostsForChain: Host[];
    connectionMode: HostChainConnectionMode;
    onAddHost: (hostId: string) => void;
    onRemoveHost: (index: number) => void;
    onConnectionModeChange: (mode: HostChainConnectionMode) => void;
    onClearChain: () => void;
    onBack: () => void;
    onCancel: () => void;
}

export const ChainPanel: React.FC<ChainPanelProps> = ({
    formLabel,
    formHostname,
    form,
    chainedHosts,
    availableHostsForChain,
    connectionMode,
    onAddHost,
    onRemoveHost,
    onConnectionModeChange,
    onClearChain,
    onBack,
    onCancel,
}) => {
    const { t } = useI18n();
    return (
        <AsidePanel
            open={true}
            onClose={onCancel}
            title={t('hostDetails.chain.title')}
            showBackButton={true}
            onBack={onBack}
            actions={
                <Button size="sm" onClick={onBack}>
                    {t('common.save')}
                </Button>
            }
        >
            <ScrollArea className="flex-1">
                <div className="p-4 space-y-4">
                    <Card className="p-3 space-y-3 bg-card border-border/80">
                        <p className="text-xs text-muted-foreground">
                            {t('hostDetails.chain.desc', { host: formLabel || formHostname })}
                        </p>
                        <Button className="w-full h-10" onClick={() => { }}>
                            <Plus size={14} className="mr-2" /> {t('hostDetails.chain.addHost')}
                        </Button>
                    </Card>

                    <Card className="p-3 space-y-2 bg-card border-border/80">
                        <p className="text-xs font-semibold text-muted-foreground">
                            {t("hostDetails.chain.mode")}
                        </p>
                        <Select
                            value={connectionMode}
                            onValueChange={(value) => onConnectionModeChange(value as HostChainConnectionMode)}
                        >
                            <SelectTrigger className="h-9">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="proxy-tunnel">
                                    {t("hostDetails.chain.mode.proxyTunnel")}
                                </SelectItem>
                                <SelectItem value="relay-shell">
                                    {t("hostDetails.chain.mode.relayShell")}
                                </SelectItem>
                            </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                            {connectionMode === "relay-shell"
                                ? t("hostDetails.chain.mode.relayShell.desc")
                                : t("hostDetails.chain.mode.proxyTunnel.desc")}
                        </p>
                    </Card>

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
                                    <span className="text-sm font-medium flex-1">{host.label || host.hostname}</span>
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
                            <div className="space-y-1">
                                {availableHostsForChain.map((host) => (
                                    <button
                                        key={host.id}
                                        className="w-full flex items-center gap-2 p-2 rounded-md hover:bg-secondary transition-colors text-left"
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
