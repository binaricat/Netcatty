/**
 * Generate Key Panel - Standard SSH Key generation form
 */

import { Eye, EyeOff } from 'lucide-react';
import React from 'react';
import { cn } from '../../lib/utils';
import { KeyType, SSHKey } from '../../types';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

interface GenerateStandardPanelProps {
    draftKey: Partial<SSHKey>;
    setDraftKey: (key: Partial<SSHKey>) => void;
    showPassphrase: boolean;
    setShowPassphrase: (show: boolean) => void;
    isGenerating: boolean;
    onGenerate: () => void;
}

export const GenerateStandardPanel: React.FC<GenerateStandardPanelProps> = ({
    draftKey,
    setDraftKey,
    showPassphrase,
    setShowPassphrase,
    isGenerating,
    onGenerate,
}) => {
    return (
        <>
            <div className="space-y-2">
                <Label>Label</Label>
                <Input
                    value={draftKey.label || ''}
                    onChange={e => setDraftKey({ ...draftKey, label: e.target.value })}
                    placeholder="My SSH Key"
                />
            </div>

            <div className="space-y-2">
                <Label>Key type</Label>
                <div className="flex gap-2">
                    {(['ED25519', 'ECDSA', 'RSA'] as KeyType[]).map((t) => (
                        <Button
                            key={t}
                            variant={draftKey.type === t ? 'secondary' : 'ghost'}
                            className={cn(
                                "flex-1 h-10",
                                draftKey.type === t && "bg-primary/15 text-primary"
                            )}
                            onClick={() => {
                                // Set default keySize based on type
                                const defaultSize = t === 'ED25519' ? undefined : (t === 'RSA' ? 4096 : 256);
                                setDraftKey({ ...draftKey, type: t, keySize: defaultSize });
                            }}
                        >
                            {t}
                        </Button>
                    ))}
                </div>
            </div>

            {/* Key Size selector - only for RSA and ECDSA */}
            {(draftKey.type === 'RSA' || draftKey.type === 'ECDSA') && (
                <div className="space-y-2">
                    <Label>Key size</Label>
                    <div className="flex gap-2">
                        {(draftKey.type === 'RSA'
                            ? [4096, 2048, 1024]
                            : [256, 384, 521]
                        ).map((size) => (
                            <Button
                                key={size}
                                variant={draftKey.keySize === size ? 'secondary' : 'ghost'}
                                className={cn(
                                    "flex-1 h-10",
                                    draftKey.keySize === size && "bg-primary/15 text-primary"
                                )}
                                onClick={() => setDraftKey({ ...draftKey, keySize: size })}
                            >
                                {draftKey.type === 'RSA' ? `${size} bits` : `P-${size}`}
                            </Button>
                        ))}
                    </div>
                </div>
            )}

            <div className="space-y-2">
                <Label>Passphrase</Label>
                <div className="relative">
                    <Input
                        type={showPassphrase ? 'text' : 'password'}
                        value={draftKey.passphrase || ''}
                        onChange={e => setDraftKey({ ...draftKey, passphrase: e.target.value })}
                        placeholder="Optional passphrase"
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

            <div className="flex items-center gap-2">
                <input
                    type="checkbox"
                    id="savePassphrase"
                    checked={draftKey.savePassphrase || false}
                    onChange={e => setDraftKey({ ...draftKey, savePassphrase: e.target.checked })}
                    className="h-4 w-4 rounded border-border"
                />
                <Label htmlFor="savePassphrase" className="text-sm font-normal cursor-pointer">
                    Save passphrase
                </Label>
            </div>

            <Button
                className="w-full h-11"
                onClick={onGenerate}
                disabled={isGenerating || !draftKey.label?.trim()}
            >
                {isGenerating ? (
                    <div className="h-4 w-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                ) : (
                    'Generate & save'
                )}
            </Button>
        </>
    );
};
