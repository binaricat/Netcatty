/**
 * Generate Biometric Key Panel - Windows Hello / Touch ID
 * 
 * Termius-style biometric key: A standard ED25519 SSH key encrypted with a 
 * random passphrase, which is stored in the OS Secure Storage (Keychain/DPAPI).
 * When used, the OS prompts for biometrics before releasing the passphrase.
 */

import { Fingerprint, ShieldCheck } from 'lucide-react';
import React from 'react';
import { SSHKey } from '../../types';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { isMacOS } from './utils';

interface GenerateBiometricPanelProps {
    draftKey: Partial<SSHKey>;
    setDraftKey: (key: Partial<SSHKey>) => void;
    isGenerating: boolean;
    onGenerate: () => void;
}

export const GenerateBiometricPanel: React.FC<GenerateBiometricPanelProps> = ({
    draftKey,
    setDraftKey,
    isGenerating,
    onGenerate,
}) => {
    const isMac = isMacOS();

    return (
        <>
            {/* Biometric illustration */}
            <div className="bg-card border border-border/80 rounded-lg p-4 flex items-center justify-center overflow-hidden">
                <div className="text-center w-full">
                    <div className="flex justify-center items-center gap-3 mb-2">
                        <div className="w-12 h-12 bg-blue-500/20 border border-blue-500/40 rounded-xl flex items-center justify-center">
                            <Fingerprint size={24} className="text-blue-500" />
                        </div>
                        <div className="text-muted-foreground">+</div>
                        <div className="w-12 h-12 bg-green-500/20 border border-green-500/40 rounded-xl flex items-center justify-center">
                            <ShieldCheck size={24} className="text-green-500" />
                        </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        {isMac ? 'Touch ID' : 'Windows Hello'} + {isMac ? 'Keychain' : 'Credential Manager'}
                    </p>
                </div>
            </div>

            <p className="text-sm text-muted-foreground text-center">
                Standard ED25519 SSH key protected by your {isMac ? 'Mac\'s Keychain' : 'Windows Credential Manager'}.
                {isMac ? ' Touch ID' : ' Windows Hello'} is required to unlock the key.
            </p>

            <div className="space-y-2">
                <Label>Label</Label>
                <Input
                    value={draftKey.label || ''}
                    onChange={e => setDraftKey({ ...draftKey, label: e.target.value })}
                    placeholder={isMac ? 'Touch ID Key' : 'Windows Hello Key'}
                />
            </div>

            <div className="space-y-1">
                <Label className="text-muted-foreground">Type</Label>
                <p className="text-sm">ED25519</p>
            </div>

            <div className="space-y-1">
                <Label className="text-muted-foreground">Protection</Label>
                <p className="text-sm">{isMac ? 'macOS Keychain (Touch ID)' : 'DPAPI + Windows Hello'}</p>
            </div>

            <Button
                className="w-full h-11"
                onClick={onGenerate}
                disabled={isGenerating || !draftKey.label?.trim()}
            >
                {isGenerating ? (
                    <div className="h-4 w-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                ) : (
                    'Generate'
                )}
            </Button>
        </>
    );
};
