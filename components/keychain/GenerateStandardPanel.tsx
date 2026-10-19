/** Standard and hardware-backed SSH key generation. */
import { Eye, EyeOff, Loader2, Usb } from 'lucide-react';
import React from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { KeyType, SSHKey } from '../../types';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '../ui/select';
import { Switch } from '../ui/switch';

interface GenerateStandardPanelProps {
    draftKey: Partial<SSHKey> & { resident?: boolean; verifyRequired?: boolean };
    setDraftKey: (key: Partial<SSHKey> & { resident?: boolean; verifyRequired?: boolean }) => void;
    showPassphrase: boolean;
    setShowPassphrase: (show: boolean) => void;
    isGenerating: boolean;
    onGenerate: () => void;
}

export const GenerateStandardPanel: React.FC<GenerateStandardPanelProps> = ({
    draftKey, setDraftKey, showPassphrase, setShowPassphrase, isGenerating, onGenerate,
}) => {
    const { t } = useI18n();
    const isFido = draftKey.type === 'ED25519-SK' || draftKey.type === 'ECDSA-SK';
    const selectType = (value: string) => {
        const type = value as KeyType;
        setDraftKey({ ...draftKey, type, keySize: type === 'RSA' ? 4096 : type === 'ECDSA' ? 256 : undefined });
    };

    return (
        <div className="space-y-5" data-section="keychain-generate-form">
            <div className="space-y-2">
                <Label htmlFor="generate-key-label">{t('keychain.field.label')}</Label>
                <Input id="generate-key-label" value={draftKey.label || ''}
                    onChange={e => setDraftKey({ ...draftKey, label: e.target.value })}
                    placeholder={t('keychain.generate.labelPlaceholder')} disabled={isGenerating} />
            </div>

            <div className="space-y-2">
                <Label htmlFor="generate-key-type">{t('keychain.generate.keyType')}</Label>
                <Select value={draftKey.type || 'ED25519'} onValueChange={selectType} disabled={isGenerating}>
                    <SelectTrigger id="generate-key-type"><SelectValue /></SelectTrigger>
                    <SelectContent>
                        <SelectGroup>
                            <SelectLabel>{t('keychain.generate.standardKeys')}</SelectLabel>
                            {['ED25519', 'ECDSA', 'RSA'].map(type => <SelectItem key={type} value={type}>{type}</SelectItem>)}
                        </SelectGroup>
                        <SelectSeparator />
                        <SelectGroup>
                            <SelectLabel>{t('keychain.generate.securityKeys')}</SelectLabel>
                            <SelectItem value="ED25519-SK">ED25519-SK</SelectItem>
                            <SelectItem value="ECDSA-SK">ECDSA-SK</SelectItem>
                        </SelectGroup>
                    </SelectContent>
                </Select>
            </div>

            {(draftKey.type === 'RSA' || draftKey.type === 'ECDSA') && (
                <div className="space-y-2 fido-field-stage" key="key-size">
                    <Label htmlFor="generate-key-size">{t('keychain.generate.keySize')}</Label>
                    <Select value={String(draftKey.keySize || (draftKey.type === 'RSA' ? 4096 : 256))}
                        onValueChange={value => setDraftKey({ ...draftKey, keySize: Number(value) })} disabled={isGenerating}>
                        <SelectTrigger id="generate-key-size"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            {(draftKey.type === 'RSA' ? [4096, 2048, 1024] : [256, 384, 521]).map(size => (
                                <SelectItem key={size} value={String(size)}>{draftKey.type === 'RSA' ? `${size} bits` : `P-${size}`}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            )}

            {isFido ? (
                <div key="hardware" className="fido-field-stage fido-key-options space-y-4">
                    <div className="flex gap-2.5 rounded-lg bg-muted/40 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
                        <Usb size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
                        <p>{t('keychain.generate.fidoHint')}</p>
                    </div>
                    <div className="divide-y divide-border/50 border-y border-border/50">
                        <div className="flex items-center justify-between gap-4 py-3.5">
                            <div className="min-w-0 space-y-1">
                                <Label id="fido-resident-label" className="text-sm font-medium">{t('keychain.generate.resident')}</Label>
                                <p id="fido-resident-description" className="text-xs leading-relaxed text-muted-foreground">{t('keychain.generate.residentDesc')}</p>
                            </div>
                            <Switch id="fido-resident" checked={!!draftKey.resident} disabled={isGenerating}
                                aria-labelledby="fido-resident-label" aria-describedby="fido-resident-description"
                                onCheckedChange={resident => setDraftKey({ ...draftKey, resident })} />
                        </div>
                        <div className="flex items-center justify-between gap-4 py-3.5">
                            <div className="min-w-0 space-y-1">
                                <Label id="fido-verify-label" className="text-sm font-medium">{t('keychain.generate.verifyRequired')}</Label>
                                <p id="fido-verify-description" className="text-xs leading-relaxed text-muted-foreground">{t('keychain.generate.verifyRequiredDesc')}</p>
                            </div>
                            <Switch id="fido-verify-required" checked={!!draftKey.verifyRequired} disabled={isGenerating}
                                aria-labelledby="fido-verify-label" aria-describedby="fido-verify-description"
                                onCheckedChange={verifyRequired => setDraftKey({ ...draftKey, verifyRequired })} />
                        </div>
                    </div>
                </div>
            ) : (
                <div key="software" className="fido-field-stage space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="generate-key-passphrase">{t('terminal.auth.passphrase')}</Label>
                        <div className="relative">
                            <Input id="generate-key-passphrase" type={showPassphrase ? 'text' : 'password'}
                                value={draftKey.passphrase || ''} disabled={isGenerating}
                                onChange={e => setDraftKey({ ...draftKey, passphrase: e.target.value })}
                                placeholder={t('keychain.generate.passphrasePlaceholder')} className="pr-10" />
                            <Button type="button" variant="ghost" size="icon" disabled={isGenerating}
                                aria-label={t(showPassphrase ? 'hostDetails.password.hide' : 'hostDetails.password.show')}
                                className="absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2 text-muted-foreground"
                                onClick={() => setShowPassphrase(!showPassphrase)}>
                                {showPassphrase ? <EyeOff size={15} /> : <Eye size={15} />}
                            </Button>
                        </div>
                    </div>
                    <div className="flex items-center justify-between gap-4">
                        <Label id="generate-save-passphrase">{t('keychain.generate.savePassphrase')}</Label>
                        <Switch checked={!!draftKey.savePassphrase} disabled={isGenerating}
                            aria-labelledby="generate-save-passphrase"
                            onCheckedChange={savePassphrase => setDraftKey({ ...draftKey, savePassphrase })} />
                    </div>
                </div>
            )}

            <Button className="h-10 w-full gap-2" onClick={onGenerate} disabled={isGenerating || !draftKey.label?.trim()}>
                {isGenerating && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                {t(isGenerating ? 'keychain.generate.generating' : 'keychain.generate.generateSave')}
            </Button>
        </div>
    );
};
