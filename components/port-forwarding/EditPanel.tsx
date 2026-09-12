/**
 * Port Forwarding Edit Panel
 * Form for editing an existing port forwarding rule
 */
import { ChevronDown,Copy,Trash2 } from 'lucide-react';
import React from 'react';
import { isPortForwardingAutoReconnectEnabled } from '../../domain/portForwardingReconnect';
import { useI18n } from '../../application/i18n/I18nProvider';
import { Host,PortForwardingRule } from '../../domain/models';
import { DistroAvatar } from '../DistroAvatar';
import { TrafficDiagram } from '../TrafficDiagram';
import {
    AsideActionMenu,
    AsideActionMenuItem,
    AsidePanel,
    AsidePanelContent,
    AsidePanelFooter,
    type AsidePanelLayout,
    type AsidePanelResizeProps,
} from '../ui/aside-panel';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';

export interface EditPanelProps extends AsidePanelResizeProps {
    rule: PortForwardingRule;
    draft: Partial<PortForwardingRule>;
    hosts: Host[];
    onDraftChange: (updates: Partial<PortForwardingRule>) => void;
    onSave: () => void;
    onClose: () => void;
    onDuplicate: () => void;
    onDelete: () => void;
    onOpenHostSelector: () => void;
    layout?: AsidePanelLayout;
}

export const EditPanel: React.FC<EditPanelProps> = ({
    rule,
    draft,
    hosts,
    onDraftChange,
    onSave,
    onClose,
    onDuplicate,
    onDelete,
    onOpenHostSelector,
    layout = 'inline',
    resizable = false,
    persistWidthStorageKey,
    resizeAriaLabel,
}) => {
    const { t } = useI18n();
    const selectedHost = hosts.find(h => h.id === draft.hostId);

    return (
        <AsidePanel
            open={true}
            onClose={onClose}
            title={t('pf.wizard.editTitle')}
            width="w-[360px]"
            layout={layout}
            resizable={resizable}
            persistWidthStorageKey={persistWidthStorageKey}
            resizeAriaLabel={resizeAriaLabel}
            actions={
                <AsideActionMenu>
                    <AsideActionMenuItem
                        icon={<Copy size={14} />}
                        onClick={onDuplicate}
                    >
                        {t('action.duplicate')}
                    </AsideActionMenuItem>
                    <AsideActionMenuItem
                        icon={<Trash2 size={14} />}
                        variant="destructive"
                        onClick={onDelete}
                    >
                        {t('action.delete')}
                    </AsideActionMenuItem>
                </AsideActionMenu>
            }
        >
            <AsidePanelContent>
                {/* Traffic Diagram */}
                <div className="-my-1">
                    <TrafficDiagram type={draft.type || rule.type} isAnimating={true} />
                </div>

                {/* Label */}
                <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">{t('field.label')}</Label>
                    <Input
                        placeholder={t('pf.form.labelPlaceholder')}
                        className="h-10"
                        value={draft.label || ''}
                        onChange={e => onDraftChange({ label: e.target.value })}
                    />
                </div>

                {/* Local Port */}
                <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">{t('pf.wizard.localConfig.localPort')}</Label>
                    <Input
                        type="number"
                        placeholder={t('pf.wizard.placeholders.portExample', { port: 8080 })}
                        className="h-10"
                        value={draft.localPort || ''}
                        onChange={e => onDraftChange({ localPort: parseInt(e.target.value) || undefined })}
                    />
                </div>

                {/* Bind Address */}
                <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">{t('pf.wizard.bindAddress')}</Label>
                    <Input
                        placeholder="127.0.0.1"
                        className="h-10"
                        value={draft.bindAddress || ''}
                        onChange={e => onDraftChange({ bindAddress: e.target.value })}
                    />
                </div>

                {/* Intermediate Host - for all types */}
                <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">{t('pf.form.intermediateHost')}</Label>
                    <Button
                        variant="secondary"
                        className="w-full h-10 justify-between"
                        onClick={onOpenHostSelector}
                    >
                        {selectedHost ? (
                            <div className="flex items-center gap-2">
                                <DistroAvatar
                                    host={selectedHost}
                                    fallback={selectedHost.os[0].toUpperCase()}
                                    size="tree"
                                />
                                <span>{selectedHost.label}</span>
                            </div>
                        ) : (
                            <span className="text-muted-foreground">{t('common.selectAHost')}</span>
                        )}
                        <ChevronDown size={14} />
                    </Button>
                </div>

                {/* Destination - for local/remote only */}
                {(draft.type === 'local' || draft.type === 'remote') && (
                    <>
                        <div className="space-y-1">
                            <Label className="text-[10px] text-muted-foreground">{t('pf.wizard.destination.address')}</Label>
                            <Input
                                placeholder={t('pf.wizard.destination.addressPlaceholder')}
                                className="h-10"
                                value={draft.remoteHost || ''}
                                onChange={e => onDraftChange({ remoteHost: e.target.value })}
                            />
                        </div>

                        <div className="space-y-1">
                            <Label className="text-[10px] text-muted-foreground">{t('pf.wizard.destination.port')}</Label>
                            <Input
                                type="number"
                                placeholder={t('pf.wizard.placeholders.portExample', { port: 3306 })}
                                className="h-10"
                                value={draft.remotePort || ''}
                                onChange={e => onDraftChange({ remotePort: parseInt(e.target.value) || undefined })}
                            />
                        </div>
                    </>
                )}

                {/* Auto Start Toggle */}
                <div className="flex items-center justify-between py-2">
                    <div className="space-y-0.5">
                        <Label className="text-sm font-medium">{t('pf.form.autoStart')}</Label>
                        <p className="text-[10px] text-muted-foreground">{t('pf.form.autoStartDesc')}</p>
                    </div>
                    <Switch
                        checked={draft.autoStart ?? false}
                        onCheckedChange={checked => onDraftChange({ autoStart: checked })}
                    />
                </div>

                {/* Auto Reconnect Toggle */}
                <div className="flex items-center justify-between py-2">
                    <div className="space-y-0.5">
                        <Label className="text-sm font-medium">{t('pf.form.autoReconnect')}</Label>
                        <p className="text-[10px] text-muted-foreground">{t('pf.form.autoReconnectDesc')}</p>
                    </div>
                    <Switch
                        checked={isPortForwardingAutoReconnectEnabled(draft)}
                        onCheckedChange={checked => onDraftChange({ autoReconnect: checked })}
                    />
                </div>
            </AsidePanelContent>
            <AsidePanelFooter className="space-y-2">
                <Button
                    className="w-full h-10"
                    onClick={onSave}
                >
                    {t('common.saveChanges')}
                </Button>
                <Button
                    variant="ghost"
                    className="w-full h-10 text-muted-foreground hover:text-foreground hover:bg-foreground/5"
                    onClick={onClose}
                >
                    {t('common.cancel')}
                </Button>
            </AsidePanelFooter>
        </AsidePanel>
    );
};

export default EditPanel;
