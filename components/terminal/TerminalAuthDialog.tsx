/**
 * Terminal Authentication Dialog
 * Displays auth form with password/key selection for SSH connection
 */
import { AlertCircle, BadgeCheck, ChevronDown, Eye, EyeOff, Fingerprint, Key, Lock } from 'lucide-react';
import React from 'react';
import { cn } from '../../lib/utils';
import { SSHKey } from '../../types';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

export type TerminalAuthMethod = 'password' | 'key' | 'certificate';

export interface TerminalAuthDialogProps {
    authMethod: TerminalAuthMethod;
    setAuthMethod: (method: TerminalAuthMethod) => void;
    authUsername: string;
    setAuthUsername: (username: string) => void;
    authPassword: string;
    setAuthPassword: (password: string) => void;
    authKeyId: string | null;
    setAuthKeyId: (keyId: string | null) => void;
    authPassphrase: string;
    setAuthPassphrase: (passphrase: string) => void;
    showAuthPassphrase: boolean;
    setShowAuthPassphrase: (show: boolean) => void;
    showAuthPassword: boolean;
    setShowAuthPassword: (show: boolean) => void;
    authRetryMessage: string | null;
    keys: SSHKey[];
    onSubmit: () => void;
    onSubmitWithoutSave?: () => void;
    onCancel: () => void;
    isValid: boolean;
}

export const TerminalAuthDialog: React.FC<TerminalAuthDialogProps> = ({
    authMethod,
    setAuthMethod,
    authUsername,
    setAuthUsername,
    authPassword,
    setAuthPassword,
    authKeyId,
    setAuthKeyId,
    authPassphrase,
    setAuthPassphrase,
    showAuthPassphrase,
    setShowAuthPassphrase,
    showAuthPassword,
    setShowAuthPassword,
    authRetryMessage,
    keys,
    onSubmit,
    onSubmitWithoutSave,
    onCancel,
    isValid,
}) => {
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && isValid) {
            onSubmit();
        }
    };

    // Show all keys (both regular keys and certificates) in the single key picker.
    const selectableKeys = React.useMemo(
        () => keys.filter((k) => k.category === 'key' || Boolean(k.certificate?.trim())),
        [keys],
    );

    const [keyDropdownOpen, setKeyDropdownOpen] = React.useState(false);

    const selectedKey = authKeyId ? keys.find((k) => k.id === authKeyId) : null;

    return (
        <>
            {/* Auth method tabs */}
            <div className="flex gap-1 p-1 bg-secondary/80 rounded-lg border border-border/60">
                <button
                    className={cn(
                        "flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all",
                        authMethod === 'password'
                            ? "bg-primary text-primary-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                    )}
                    onClick={() => setAuthMethod('password')}
                >
                    <Lock size={14} />
                    Password
                </button>
                <button
                    className={cn(
                        "flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all",
                        authMethod === 'key' || authMethod === 'certificate'
                            ? "bg-primary text-primary-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                    )}
                    onClick={() => setAuthMethod('key')}
                >
                    <Key size={14} />
                    SSH Key
                </button>
            </div>

            {/* Auth retry error message */}
            {authRetryMessage && (
                <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm flex items-center gap-2">
                    <AlertCircle size={16} />
                    {authRetryMessage}
                </div>
            )}

            <div className="space-y-3">
                <div className="space-y-2">
                    <Label htmlFor="auth-username">Username</Label>
                    <Input
                        id="auth-username"
                        value={authUsername}
                        onChange={(e) => setAuthUsername(e.target.value)}
                        placeholder="root"
                    />
                </div>

                {authMethod === 'password' ? (
                    <div className="space-y-2">
                        <Label htmlFor="auth-password">Password</Label>
                        <div className="relative">
                            <Input
                                id="auth-password"
                                type={showAuthPassword ? 'text' : 'password'}
                                value={authPassword}
                                onChange={(e) => setAuthPassword(e.target.value)}
                                placeholder="Enter password"
                                className={cn("pr-10", authRetryMessage && "border-destructive/50")}
                                autoFocus={!!authRetryMessage}
                                onKeyDown={handleKeyDown}
                            />
                            <button
                                type="button"
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                onClick={() => setShowAuthPassword(!showAuthPassword)}
                            >
                                {showAuthPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                            </button>
                        </div>
                    </div>
                ) : (
                    <>
                        <div className="space-y-2">
                            <Label>Select Key</Label>
                            {selectableKeys.length === 0 ? (
                                <div className="text-sm text-muted-foreground p-3 border border-dashed border-border/60 rounded-lg text-center">
                                    No keys available. Add keys in the Keychain section.
                                </div>
                            ) : (
                                <Popover open={keyDropdownOpen} onOpenChange={setKeyDropdownOpen}>
                                    <PopoverTrigger asChild>
                                        <button
                                            className={cn(
                                                "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors text-left",
                                                selectedKey
                                                    ? "border-primary bg-primary/5"
                                                    : "border-border/50 hover:bg-secondary/50"
                                            )}
                                        >
                                            {selectedKey ? (
                                                <>
                                                    <div className={cn(
                                                        "h-8 w-8 rounded-lg flex items-center justify-center shrink-0",
                                                        selectedKey.certificate?.trim()
                                                            ? "bg-emerald-500/20 text-emerald-500"
                                                            : selectedKey.source === 'biometric'
                                                                ? "bg-amber-500/20 text-amber-500"
                                                                : "bg-primary/20 text-primary"
                                                    )}>
                                                        {selectedKey.certificate?.trim()
                                                            ? <BadgeCheck size={14} />
                                                            : selectedKey.source === 'biometric'
                                                                ? <Fingerprint size={14} />
                                                                : <Key size={14} />}
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="text-sm font-medium truncate">{selectedKey.label}</div>
                                                        <div className="text-xs text-muted-foreground">
                                                            {selectedKey.certificate?.trim() ? 'Certificate' : selectedKey.type}
                                                            {selectedKey.source === 'biometric' && ' · Passkey'}
                                                        </div>
                                                    </div>
                                                </>
                                            ) : (
                                                <span className="text-sm text-muted-foreground">Select a key...</span>
                                            )}
                                            <ChevronDown size={16} className="text-muted-foreground shrink-0 ml-auto" />
                                        </button>
                                    </PopoverTrigger>
                                    <PopoverContent className="p-1" align="start" style={{ width: 'var(--radix-popover-trigger-width)' }}>
                                        <div className="max-h-60 overflow-y-auto">
                                            {selectableKeys.map((key) => (
                                                <button
                                                    key={key.id}
                                                    className={cn(
                                                        "w-full flex items-center gap-3 px-3 py-2 rounded-md transition-colors text-left",
                                                        authKeyId === key.id
                                                            ? "bg-primary/10 text-primary"
                                                            : "hover:bg-secondary/80"
                                                    )}
                                                    onClick={() => {
                                                        setAuthKeyId(key.id);
                                                        setAuthMethod(key.certificate?.trim() ? 'certificate' : 'key');
                                                        setAuthPassphrase(key.passphrase || '');
                                                        setKeyDropdownOpen(false);
                                                    }}
                                                >
                                                    <div className={cn(
                                                        "h-7 w-7 rounded-md flex items-center justify-center shrink-0",
                                                        key.certificate?.trim()
                                                            ? "bg-emerald-500/20 text-emerald-500"
                                                            : key.source === 'biometric'
                                                                ? "bg-amber-500/20 text-amber-500"
                                                                : "bg-primary/20 text-primary"
                                                    )}>
                                                        {key.certificate?.trim()
                                                            ? <BadgeCheck size={12} />
                                                            : key.source === 'biometric'
                                                                ? <Fingerprint size={12} />
                                                                : <Key size={12} />}
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="text-sm font-medium truncate">{key.label}</div>
                                                        <div className="text-xs text-muted-foreground">
                                                            {key.certificate?.trim() ? 'Certificate' : key.type}
                                                            {key.source === 'biometric' && ' · Passkey'}
                                                        </div>
                                                    </div>
                                                </button>
                                            ))}
                                        </div>
                                    </PopoverContent>
                                </Popover>
                            )}
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="auth-passphrase">Passphrase</Label>
                            <div className="relative">
                                <Input
                                    id="auth-passphrase"
                                    type={showAuthPassphrase ? 'text' : 'password'}
                                    value={authPassphrase}
                                    onChange={(e) => setAuthPassphrase(e.target.value)}
                                    placeholder="Optional passphrase for the selected private key"
                                    className="pr-10"
                                    disabled={!selectedKey}
                                    onKeyDown={handleKeyDown}
                                />
                                <button
                                    type="button"
                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground disabled:opacity-50"
                                    onClick={() => setShowAuthPassphrase(!showAuthPassphrase)}
                                    disabled={!selectedKey}
                                >
                                    {showAuthPassphrase ? <EyeOff size={16} /> : <Eye size={16} />}
                                </button>
                            </div>
                        </div>
                    </>
                )}
            </div>

            <div className="flex items-center justify-between pt-2">
                <Button variant="secondary" onClick={onCancel}>
                    Close
                </Button>
                <div className="flex items-center gap-2">
                    <Popover>
                        <PopoverTrigger asChild>
                            <Button disabled={!isValid} onClick={onSubmit}>
                                Continue & Save
                                <ChevronDown size={14} className="ml-2" />
                            </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-40 p-1 z-50" align="end">
                            <button
                                className="w-full px-3 py-2 text-sm text-left hover:bg-secondary rounded-md"
                                onClick={onSubmitWithoutSave ?? onSubmit}
                                disabled={!isValid}
                            >
                                Continue
                            </button>
                        </PopoverContent>
                    </Popover>
                </div>
            </div>
        </>
    );
};

export default TerminalAuthDialog;
