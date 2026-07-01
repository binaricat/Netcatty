/**
 * Proxy Configuration Sub-Panel
 * Panel for configuring HTTP/SOCKS5/ProxyCommand proxy settings
 */
import { Globe, KeyRound, SquareTerminal, Trash2 } from 'lucide-react';
import React, { useCallback, useMemo } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import {
    formatProxyConfigEndpoint,
    formatProxyConfigType,
    hasIncompleteProxyIdentity,
    hasMissingProxyIdentity,
    hasUnreadableProxyCredential,
    isProxyCommandConfig,
    isValidProxyPort,
} from '../../domain/proxyProfiles';
import { Identity, ProxyConfig, ProxyProfile } from '../../types';
import { AsidePanel, AsidePanelContent, type AsidePanelLayout, type AsidePanelResizeProps } from '../ui/aside-panel';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

export interface ProxyPanelProps {
    proxyConfig?: ProxyConfig;
    proxyProfiles?: ProxyProfile[];
    identities?: Identity[];
    selectedProxyProfileId?: string;
    onUpdateProxy: (field: keyof ProxyConfig, value: ProxyConfig[keyof ProxyConfig]) => void;
    onSelectProxyProfile?: (profileId: string | undefined) => void;
    onClearProxy: () => void;
    onBack: () => void;
    onCancel: () => void;
    layout?: AsidePanelLayout;
}

export type ProxyPanelPropsWithResize = ProxyPanelProps & AsidePanelResizeProps;

export const ProxyPanel: React.FC<ProxyPanelPropsWithResize> = ({
    proxyConfig,
    proxyProfiles = [],
    identities = [],
    selectedProxyProfileId,
    onUpdateProxy,
    onSelectProxyProfile,
    onClearProxy,
    onBack,
    onCancel,
    layout = 'overlay',
    resizable,
    persistWidthStorageKey,
    resizeAriaLabel,
}) => {
    const { t } = useI18n();
    const customValue = '__custom__';
    const selectedProfile = useMemo(
        () => proxyProfiles.find((profile) => profile.id === selectedProxyProfileId),
        [proxyProfiles, selectedProxyProfileId],
    );
    const hasMissingProfile = Boolean(selectedProxyProfileId && !selectedProfile);
    const selectedValue = selectedProfile ? selectedProfile.id : customValue;
    const isUsingProfile = Boolean(selectedProfile);
    const isCommandProxy = isProxyCommandConfig(proxyConfig);
    const hasManualProxyHost = Boolean(proxyConfig?.host?.trim());
    const hasManualProxyCommand = Boolean(proxyConfig?.command?.trim());
    const hasManualProxyValue = isCommandProxy ? hasManualProxyCommand : hasManualProxyHost;
    const hasInvalidManualProxyPort = !isCommandProxy && hasManualProxyHost && !isValidProxyPort(proxyConfig?.port);
    const effectiveProxyConfig = selectedProfile?.config ?? proxyConfig;
    const hasMissingIdentity = hasMissingProxyIdentity(effectiveProxyConfig, identities);
    const hasIncompleteIdentity = hasIncompleteProxyIdentity(effectiveProxyConfig, identities);
    const hasUnreadableIdentity = hasUnreadableProxyCredential(effectiveProxyConfig, identities);
    const hasInvalidIdentity = hasMissingIdentity || hasIncompleteIdentity || hasUnreadableIdentity;
    const canSave = (isUsingProfile && !hasInvalidIdentity) ||
        (!isUsingProfile && hasManualProxyValue && !hasInvalidManualProxyPort && !hasInvalidIdentity);
    const manualCredentialsValue = '__manual_credentials__';
    const missingIdentityValue = '__missing_identity__';
    const selectedIdentity = useMemo(
        () => identities.find((identity) => identity.id === proxyConfig?.identityId),
        [identities, proxyConfig?.identityId],
    );
    const selectedIdentityValue = selectedIdentity?.id || (hasMissingIdentity ? missingIdentityValue : manualCredentialsValue);
    const handleBack = useCallback(() => {
        if (hasInvalidManualProxyPort || hasInvalidIdentity) return;
        onBack();
    }, [hasInvalidManualProxyPort, hasInvalidIdentity, onBack]);

    return (
        <AsidePanel
            open={true}
            onClose={onCancel}
            title={t('hostDetails.proxyPanel.title')}
            showBackButton={true}
            onBack={handleBack}
            layout={layout}
            resizable={resizable}
            persistWidthStorageKey={persistWidthStorageKey}
            resizeAriaLabel={resizeAriaLabel}
            actions={
                <Button size="sm" onClick={handleBack} disabled={!canSave}>
                    {t('common.save')}
                </Button>
            }
        >
            <AsidePanelContent>
                {(proxyProfiles.length > 0 || hasMissingProfile) && onSelectProxyProfile && (
                    <Card className="p-3 space-y-3 bg-card border-border/80">
                        <div className="flex items-center gap-2">
                            <Globe size={14} className="text-muted-foreground" />
                            <p className="text-xs font-semibold">{t('hostDetails.proxyPanel.savedProxy')}</p>
                        </div>
                        <Select
                            value={selectedValue}
                            onValueChange={(value) => onSelectProxyProfile(value === customValue ? undefined : value)}
                        >
                            <SelectTrigger
                                aria-label={t('hostDetails.proxyPanel.savedProxy')}
                                className="h-10"
                            >
                                <SelectValue placeholder={t('hostDetails.proxyPanel.selectSaved')} />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={customValue}>{t('hostDetails.proxyPanel.customProxy')}</SelectItem>
                                {proxyProfiles.map((profile) => (
                                    <SelectItem key={profile.id} value={profile.id}>
                                        {profile.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        {hasMissingProfile && (
                            <div className="min-w-0 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
                                {t('hostDetails.proxyPanel.missingSaved')}
                            </div>
                        )}
                        {selectedProfile && (
                            <div className="min-w-0 rounded-md bg-secondary/50 p-2 text-sm">
                                <div className="flex min-w-0 items-center gap-2">
                                    <Badge variant="secondary" className="text-xs shrink-0">
                                        {formatProxyConfigType(selectedProfile.config)}
                                    </Badge>
                                    <span className="truncate">
                                        {formatProxyConfigEndpoint(selectedProfile.config)}
                                    </span>
                                </div>
                            </div>
                        )}
                        {selectedProfile && hasMissingIdentity && (
                            <div className="min-w-0 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
                                {t('hostDetails.proxyPanel.missingIdentity')}
                            </div>
                        )}
                        {selectedProfile && hasIncompleteIdentity && (
                            <div className="min-w-0 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
                                {t('hostDetails.proxyPanel.incompleteIdentity')}
                            </div>
                        )}
                        {selectedProfile && hasUnreadableIdentity && (
                            <div className="min-w-0 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
                                {t('hostDetails.proxyPanel.unreadableIdentity')}
                            </div>
                        )}
                    </Card>
                )}

                {!isUsingProfile && (
                    <>
                        <Card className="p-3 space-y-3 bg-card border-border/80">
                            <div className="space-y-2">
                                <div className="flex items-center gap-2">
                                    <Globe size={14} className="text-muted-foreground" />
                                    <p className="text-xs font-semibold">{t('field.type')}</p>
                                </div>
                                <Select
                                    value={proxyConfig?.type || 'http'}
                                    onValueChange={(value) => onUpdateProxy('type', value as ProxyConfig['type'])}
                                >
                                    <SelectTrigger aria-label={t('field.type')} className="h-10">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="http">HTTP</SelectItem>
                                        <SelectItem value="socks5">SOCKS5</SelectItem>
                                        <SelectItem value="command">{t('hostDetails.proxyPanel.command')}</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>

                            {isCommandProxy ? (
                                <div className="space-y-2">
                                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                        <SquareTerminal size={14} />
                                        <span>{t('hostDetails.proxyPanel.commandHelp')}</span>
                                    </div>
                                    <Input
                                        aria-label={t('hostDetails.proxyPanel.commandPlaceholder')}
                                        placeholder={t('hostDetails.proxyPanel.commandPlaceholder')}
                                        value={proxyConfig?.command || ""}
                                        onChange={(e) => onUpdateProxy('command', e.target.value)}
                                        className="h-10 font-mono text-xs"
                                    />
                                </div>
                            ) : (
                                <div className="flex gap-2">
                                    <Input
                                        aria-label={t('hostDetails.proxyPanel.hostPlaceholder')}
                                        placeholder={t('hostDetails.proxyPanel.hostPlaceholder')}
                                        value={proxyConfig?.host || ""}
                                        onChange={(e) => onUpdateProxy('host', e.target.value)}
                                        className="h-10 flex-1"
                                    />
                                    <div className="flex items-center gap-1">
                                        <span className="text-xs text-muted-foreground">{t('hostDetails.port')}</span>
                                        <Input
                                            aria-label={t('hostDetails.port')}
                                            type="number"
                                            placeholder="3128"
                                            min={1}
                                            max={65535}
                                            step={1}
                                            value={proxyConfig?.port || ""}
                                            onChange={(e) => onUpdateProxy('port', parseInt(e.target.value) || 0)}
                                            className="h-10 w-20 text-center"
                                        />
                                    </div>
                                </div>
                            )}
                            {hasInvalidManualProxyPort && (
                                <p className="text-xs text-destructive">
                                    {t('proxyProfiles.error.port')}
                                </p>
                            )}
                        </Card>

                        {!isCommandProxy && <Card className="p-3 space-y-3 bg-card border-border/80">
                            <div className="flex items-center justify-between gap-3">
                                <div className="flex items-center gap-2">
                                    <KeyRound size={14} className="text-muted-foreground" />
                                    <p className="text-xs font-semibold">{t('hostDetails.proxyPanel.credentials')}</p>
                                </div>
                                <Badge variant="secondary" className="text-xs">{t('common.optional')}</Badge>
                            </div>
                            {identities.length > 0 && (
                                <div className="space-y-2">
                                    <p className="text-xs text-muted-foreground">
                                        {t('hostDetails.proxyPanel.keychainIdentity')}
                                    </p>
                                    <Select
                                        value={selectedIdentityValue}
                                        onValueChange={(value) => {
                                            if (value === missingIdentityValue) return;
                                            onUpdateProxy(
                                                'identityId',
                                                value === manualCredentialsValue ? undefined : value,
                                            );
                                        }}
                                    >
                                        <SelectTrigger
                                            aria-label={t('hostDetails.proxyPanel.keychainIdentity')}
                                            className="h-10"
                                        >
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value={manualCredentialsValue}>
                                                {t('hostDetails.proxyPanel.manualCredentials')}
                                            </SelectItem>
                                            {hasMissingIdentity && (
                                                <SelectItem value={missingIdentityValue}>
                                                    {t('hostDetails.proxyPanel.missingIdentity')}
                                                </SelectItem>
                                            )}
                                            {identities.map((identity) => (
                                                <SelectItem key={identity.id} value={identity.id}>
                                                    {identity.label}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                            )}
                            {hasMissingIdentity && (
                                <div className="min-w-0 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
                                    {t('hostDetails.proxyPanel.missingIdentity')}
                                </div>
                            )}
                            {hasIncompleteIdentity && (
                                <div className="min-w-0 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
                                    {t('hostDetails.proxyPanel.incompleteIdentity')}
                                </div>
                            )}
                            {hasUnreadableIdentity && (
                                <div className="min-w-0 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
                                    {t('hostDetails.proxyPanel.unreadableIdentity')}
                                </div>
                            )}
                            {selectedIdentity ? (
                                <div className="min-w-0 rounded-md bg-secondary/50 p-2 text-sm">
                                    <div className="flex min-w-0 items-center gap-2">
                                        <Badge variant="secondary" className="text-xs shrink-0">
                                            {t('hostDetails.proxyPanel.keychainIdentity')}
                                        </Badge>
                                        <span className="truncate">
                                            {selectedIdentity.label} - {selectedIdentity.username}
                                        </span>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <Input
                                        aria-label={t('hostDetails.proxyPanel.usernamePlaceholder')}
                                        placeholder={t('hostDetails.proxyPanel.usernamePlaceholder')}
                                        value={proxyConfig?.username || ""}
                                        onChange={(e) => onUpdateProxy('username', e.target.value)}
                                        className="h-10"
                                    />
                                    <Input
                                        aria-label={t('hostDetails.proxyPanel.passwordPlaceholder')}
                                        placeholder={t('hostDetails.proxyPanel.passwordPlaceholder')}
                                        type="password"
                                        value={proxyConfig?.password || ""}
                                        onChange={(e) => onUpdateProxy('password', e.target.value)}
                                        className="h-10"
                                    />
                                </>
                            )}
                        </Card>}
                    </>
                )}

                {(proxyConfig?.host || proxyConfig?.command || selectedProxyProfileId) && (
                    <Button variant="ghost" className="w-full h-10 text-destructive" onClick={onClearProxy}>
                        <Trash2 size={14} className="mr-2" /> {t('hostDetails.proxyPanel.remove')}
                    </Button>
                )}
            </AsidePanelContent>
        </AsidePanel>
    );
};

export default ProxyPanel;
