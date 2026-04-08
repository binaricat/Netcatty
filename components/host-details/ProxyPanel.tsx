/**
 * Proxy Configuration Sub-Panel
 * Panel for configuring HTTP/SOCKS5 proxy settings
 */
import { Check,Trash2 } from 'lucide-react';
import React from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { cn } from '../../lib/utils';
import { ProxyConfig } from '../../types';
import { AsidePanel,AsidePanelContent,type AsidePanelLayout } from '../ui/aside-panel';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';

export interface ProxyPanelProps {
    proxyConfig?: ProxyConfig;
    onUpdateProxy: (field: keyof ProxyConfig, value: string | number) => void;
    onClearProxy: () => void;
    onBack: () => void;
    onCancel: () => void;
    layout?: AsidePanelLayout;
}

export const ProxyPanel: React.FC<ProxyPanelProps> = ({
    proxyConfig,
    onUpdateProxy,
    onClearProxy,
    onBack,
    onCancel,
    layout = 'overlay',
}) => {
    const { t } = useI18n();
    return (
        <AsidePanel
            open={true}
            onClose={onCancel}
            title={t('hostDetails.proxyPanel.title')}
            showBackButton={true}
            onBack={onBack}
            layout={layout}
            actions={
                <Button size="sm" onClick={onBack} disabled={!proxyConfig?.host}>
                    {t('common.save')}
                </Button>
            }
        >
            <AsidePanelContent>
                <Card className="p-3 space-y-3 bg-card border-border/80">
                    <div className="flex items-center justify-between">
                        <p className="text-xs font-semibold">{t('field.type')}</p>
                        <div className="flex gap-2">
                            <Button
                                variant={proxyConfig?.type === 'http' ? "secondary" : "ghost"}
                                size="sm"
                                className={cn("h-8", proxyConfig?.type === 'http' && "bg-primary/15")}
                                onClick={() => onUpdateProxy('type', 'http')}
                            >
                                <Check size={14} className={cn("mr-1", proxyConfig?.type !== 'http' && "opacity-0")} />
                                HTTP
                            </Button>
                            <Button
                                variant={proxyConfig?.type === 'socks5' ? "secondary" : "ghost"}
                                size="sm"
                                className={cn("h-8", proxyConfig?.type === 'socks5' && "bg-primary/15")}
                                onClick={() => onUpdateProxy('type', 'socks5')}
                            >
                                <Check size={14} className={cn("mr-1", proxyConfig?.type !== 'socks5' && "opacity-0")} />
                                SOCKS5
                            </Button>
                        </div>
                    </div>

                    <div className="flex gap-2">
                        <Input
                            placeholder={t('hostDetails.proxyPanel.hostPlaceholder')}
                            value={proxyConfig?.host || ""}
                            onChange={(e) => onUpdateProxy('host', e.target.value)}
                            className="h-10 flex-1"
                        />
                        <div className="flex items-center gap-1">
                            <span className="text-xs text-muted-foreground">{t('hostDetails.port')}</span>
                            <Input
                                type="number"
                                placeholder="3128"
                                value={proxyConfig?.port || ""}
                                onChange={(e) => onUpdateProxy('port', parseInt(e.target.value) || 0)}
                                className="h-10 w-20 text-center"
                            />
                        </div>
                    </div>
                </Card>

                <Card className="p-3 space-y-3 bg-card border-border/80">
                    <div className="flex items-center justify-between">
                        <p className="text-xs font-semibold">{t('hostDetails.proxyPanel.credentials')}</p>
                        <Badge variant="secondary" className="text-xs">{t('common.optional')}</Badge>
                    </div>
                    <Input
                        placeholder={t('hostDetails.proxyPanel.usernamePlaceholder')}
                        value={proxyConfig?.username || ""}
                        onChange={(e) => onUpdateProxy('username', e.target.value)}
                        className="h-10"
                    />
                    <Input
                        placeholder={t('hostDetails.proxyPanel.passwordPlaceholder')}
                        type="password"
                        value={proxyConfig?.password || ""}
                        onChange={(e) => onUpdateProxy('password', e.target.value)}
                        className="h-10"
                    />
                    <Button variant="ghost" size="sm" className="text-primary" onClick={() => { }}>
                        {t('hostDetails.proxyPanel.identities')}
                    </Button>
                </Card>

                {proxyConfig?.host && (
                    <Button variant="ghost" className="w-full h-10 text-destructive" onClick={onClearProxy}>
                        <Trash2 size={14} className="mr-2" /> {t('hostDetails.proxyPanel.remove')}
                    </Button>
                )}
            </AsidePanelContent>
        </AsidePanel>
    );
};

export default ProxyPanel;
