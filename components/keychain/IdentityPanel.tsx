/**
 * Identity Panel - Create/Edit identity
 */

import { Eye,EyeOff,Key,Plus,Shield,User,X } from 'lucide-react';
import React,{ useMemo,useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { Identity,SSHKey } from '../../types';
import { Button } from '../ui/button';
import { Combobox } from '../ui/combobox';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Popover,PopoverContent,PopoverTrigger } from '../ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

interface IdentityPanelProps {
    draftIdentity: Partial<Identity>;
    setDraftIdentity: (identity: Partial<Identity>) => void;
    keys: SSHKey[];
    showPassphrase: boolean;
    setShowPassphrase: (show: boolean) => void;
    isNew: boolean;
    onSave: () => void;
}

export const IdentityPanel: React.FC<IdentityPanelProps> = ({
    draftIdentity,
    setDraftIdentity,
    keys,
    showPassphrase,
    setShowPassphrase,
    isNew,
    onSave,
}) => {
    const { t } = useI18n();

    type CredentialType = 'key' | 'certificate' | null;
    const [credentialPopoverOpen, setCredentialPopoverOpen] = useState(false);
    const [selectedCredentialType, setSelectedCredentialType] = useState<CredentialType>(null);

    const selectedKey = useMemo(() => {
        if (!draftIdentity.keyId) return undefined;
        return keys.find(k => k.id === draftIdentity.keyId);
    }, [draftIdentity.keyId, keys]);

    const keysByCategory = useMemo(() => {
        return {
            key: keys.filter(k => k.category === 'key' && !k.certificate),
            certificate: keys.filter(k => k.category === 'certificate' || !!k.certificate),
        };
    }, [keys]);

    const clearSelectedKey = () => {
        setDraftIdentity({
            ...draftIdentity,
            keyId: undefined,
            authMethod: 'password',
        });
        setSelectedCredentialType(null);
        setCredentialPopoverOpen(false);
    };

    const setSelectedKeyId = (keyId: string, kind: Exclude<CredentialType, null>) => {
        setDraftIdentity({
            ...draftIdentity,
            keyId: keyId || undefined,
            authMethod: kind === 'certificate' ? 'certificate' : 'key',
        });
        setSelectedCredentialType(null);
        setCredentialPopoverOpen(false);
    };

    return (
        <>
            <div className="flex items-center gap-3 mb-4">
                <div className="h-10 w-10 rounded-lg bg-green-500/15 text-green-500 flex items-center justify-center">
                    <User size={20} />
                </div>
                <Input
                    value={draftIdentity.label || ''}
                    onChange={e => setDraftIdentity({ ...draftIdentity, label: e.target.value })}
                    placeholder={t('keychain.field.label')}
                    className="flex-1"
                />
            </div>

            <div className="space-y-2">
                <Label>{t('keychain.identity.usernameRequired')}</Label>
                <div className="relative">
                    <User size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={draftIdentity.username || ''}
                        onChange={e => setDraftIdentity({ ...draftIdentity, username: e.target.value })}
                        placeholder={t('terminal.auth.username')}
                        className="pl-9"
                    />
                </div>
            </div>

            <div className="space-y-2">
                <Label>{t('terminal.auth.passwordLabel')}</Label>
                <div className="relative">
                    <Input
                        type={showPassphrase ? 'text' : 'password'}
                        value={draftIdentity.password || ''}
                        onChange={e => setDraftIdentity({ ...draftIdentity, password: e.target.value })}
                        placeholder={t('terminal.auth.password.placeholder')}
                        className="pr-10"
                    />
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8"
                        onClick={() => setShowPassphrase(!showPassphrase)}
                    >
                        {showPassphrase ? <EyeOff size={14} /> : <Eye size={14} />}
                    </Button>
                </div>
            </div>

            {/* Selected credential display */}
            {draftIdentity.keyId && (
                <div className="flex items-center gap-2 p-2 rounded-md bg-secondary/50 border border-border/60">
                    {draftIdentity.authMethod === 'certificate' ? (
                        <Shield size={14} className="text-primary" />
                    ) : (
                        <Key size={14} className="text-primary" />
                    )}
                    <span className="text-sm flex-1 truncate">
                        {selectedKey?.label || t('hostDetails.credential.missing')}
                    </span>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6"
                                onClick={clearSelectedKey}
                            >
                                <X size={12} />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('common.clear')}</TooltipContent>
                    </Tooltip>
                </div>
            )}

            {/* Credential type selection with inline popover */}
            {!draftIdentity.keyId && !selectedCredentialType && (
                <Popover open={credentialPopoverOpen} onOpenChange={setCredentialPopoverOpen}>
                    <PopoverTrigger asChild>
                        <button
                            type="button"
                            className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
                        >
                            <Plus size={12} />
                            <span>{t('hostDetails.credential.keyCertificate')}</span>
                        </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[200px] p-1" align="start" sideOffset={4}>
                        <div className="space-y-0.5">
                            <button
                                type="button"
                                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-secondary/80 transition-colors text-left"
                                onClick={() => {
                                    setSelectedCredentialType('key');
                                    setCredentialPopoverOpen(false);
                                }}
                            >
                                <Key size={16} className="text-muted-foreground" />
                                <span className="text-sm font-medium">{t('hostDetails.credential.key')}</span>
                            </button>

                            <button
                                type="button"
                                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-secondary/80 transition-colors text-left"
                                onClick={() => {
                                    setSelectedCredentialType('certificate');
                                    setCredentialPopoverOpen(false);
                                }}
                            >
                                <Shield size={16} className="text-muted-foreground" />
                                <span className="text-sm font-medium">
                                    {t('hostDetails.credential.certificate')}
                                </span>
                            </button>
                        </div>
                    </PopoverContent>
                </Popover>
            )}

            {/* Key selection combobox - appears after selecting "Key" type */}
            {selectedCredentialType === 'key' && !draftIdentity.keyId && (
                <div className="flex items-center gap-1">
                    <Combobox
                        options={keysByCategory.key.map(k => ({
                            value: k.id,
                            label: k.label,
                            sublabel: `${k.type}${k.keySize ? ` ${k.keySize}` : ''}`,
                            icon: <Key size={14} className="text-muted-foreground" />,
                        }))}
                        value={draftIdentity.keyId}
                        onValueChange={(val) => setSelectedKeyId(val, 'key')}
                        placeholder={t('hostDetails.keys.search')}
                        emptyText={t('hostDetails.keys.empty')}
                        icon={<Key size={14} className="text-muted-foreground" />}
                        className="flex-1"
                    />
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 shrink-0"
                                onClick={() => setSelectedCredentialType(null)}
                            >
                                <X size={14} />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('common.cancel')}</TooltipContent>
                    </Tooltip>
                </div>
            )}

            {/* Certificate selection combobox */}
            {selectedCredentialType === 'certificate' && !draftIdentity.keyId && (
                <div className="flex items-center gap-1">
                    <Combobox
                        options={keysByCategory.certificate.map(k => ({
                            value: k.id,
                            label: k.label,
                            icon: <Shield size={14} className="text-muted-foreground" />,
                        }))}
                        value={draftIdentity.keyId}
                        onValueChange={(val) => setSelectedKeyId(val, 'certificate')}
                        placeholder={t('hostDetails.certs.search')}
                        emptyText={t('hostDetails.certs.empty')}
                        icon={<Shield size={14} className="text-muted-foreground" />}
                        className="flex-1"
                    />
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 shrink-0"
                                onClick={() => setSelectedCredentialType(null)}
                            >
                                <X size={14} />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('common.cancel')}</TooltipContent>
                    </Tooltip>
                </div>
            )}

            <Button
                className="w-full h-11"
                onClick={onSave}
                disabled={!draftIdentity.label?.trim() || !draftIdentity.username?.trim()}
            >
                {isNew ? t('keychain.identity.save') : t('keychain.identity.update')}
            </Button>
        </>
    );
};
