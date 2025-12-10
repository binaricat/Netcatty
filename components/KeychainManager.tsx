import React, { useMemo, useState, useCallback } from 'react';
import { SSHKey, KeyType, KeySource, KeyCategory, Identity, IdentityAuthMethod, Host } from '../types';
import {
    Key,
    Plus,
    Trash2,
    Shield,
    Search,
    LayoutGrid,
    List as ListIcon,
    ChevronDown,
    Fingerprint,
    FileKey,
    BadgeCheck,
    MoreHorizontal,
    ChevronRight,
    Eye,
    EyeOff,
    Copy,
    Download,
    Upload,
    User,
    UserPlus,
    ExternalLink,
    Info,
    Pencil,
} from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Card, CardDescription, CardTitle } from './ui/card';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { ScrollArea } from './ui/scroll-area';
import { cn } from '../lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from './ui/context-menu';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import SelectHostPanel from './SelectHostPanel';
import { toast } from './ui/toast';
import { AsidePanel, AsidePanelContent } from './ui/aside-panel';

// Filter tab types
type FilterTab = 'key' | 'certificate' | 'biometric' | 'fido2';

// Panel modes
type PanelMode =
    | { type: 'closed' }
    | { type: 'view'; key: SSHKey }
    | { type: 'edit'; key: SSHKey }
    | { type: 'generate'; keyType: 'standard' | 'biometric' | 'fido2' }
    | { type: 'import' }
    | { type: 'identity'; identity?: Identity }
    | { type: 'export'; key: SSHKey };

interface KeychainManagerProps {
    keys: SSHKey[];
    identities?: Identity[];
    hosts?: Host[];
    customGroups?: string[];
    onSave: (key: SSHKey) => void;
    onUpdate: (key: SSHKey) => void;
    onDelete: (id: string) => void;
    onSaveIdentity?: (identity: Identity) => void;
    onDeleteIdentity?: (id: string) => void;
    onNewHost?: () => void;
    onSaveHost?: (host: Host) => void;
    onCreateGroup?: (groupPath: string) => void;
}

// Helper to generate mock key pair (in real app, use crypto APIs)
const generateMockKeyPair = (type: KeyType, label: string, keySize?: number): { privateKey: string; publicKey: string } => {
    const typeMap: Record<KeyType, string> = {
        'ED25519': 'ed25519',
        'ECDSA': `ecdsa-sha2-nistp${keySize || 256}`,
        'RSA': 'rsa',
    };

    const randomId = crypto.randomUUID().replace(/-/g, '').substring(0, 32);

    // Generate size-appropriate random data for more realistic keys
    const keyLength = type === 'RSA' ? (keySize || 4096) / 8 : 32;
    const randomData = Array.from(crypto.getRandomValues(new Uint8Array(keyLength)))
        .map(b => b.toString(16).padStart(2, '0')).join('');

    const privateKey = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACB${randomId}AAAEC${randomData.substring(0, 64)}
-----END OPENSSH PRIVATE KEY-----`;

    const publicKey = `ssh-${typeMap[type]} AAAAC3NzaC1lZDI1NTE5AAAAI${randomId.substring(0, 20)} ${label}@netcatty`;

    return { privateKey, publicKey };
};

// FIDO2 hardware key helper (YubiKey, etc.)
const createFido2Credential = async (label: string): Promise<{
    credentialId: string;
    publicKey: string;
    rpId: string;
} | null> => {
    try {
        // Check if WebAuthn is supported
        if (!window.PublicKeyCredential) {
            throw new Error('WebAuthn is not supported in this environment');
        }

        // Check if we're in a secure context
        if (!window.isSecureContext) {
            throw new Error('WebAuthn requires a secure context (HTTPS). Please run the app via localhost or HTTPS.');
        }

        // For FIDO2 hardware keys, we use cross-platform authenticator
        let rpId: string;
        const hostname = window.location.hostname;

        if (!hostname || hostname === '' || hostname === 'localhost' || hostname === '127.0.0.1') {
            rpId = 'localhost';
        } else {
            rpId = hostname;
        }

        const userId = new TextEncoder().encode(crypto.randomUUID());

        const credential = await navigator.credentials.create({
            publicKey: {
                challenge: crypto.getRandomValues(new Uint8Array(32)),
                rp: {
                    name: 'Netcatty SSH Manager',
                    id: rpId,
                },
                user: {
                    id: userId,
                    name: label,
                    displayName: label,
                },
                pubKeyCredParams: [
                    { alg: -7, type: 'public-key' },   // ES256 (ECDSA P-256)
                    { alg: -257, type: 'public-key' }, // RS256 (RSA)
                ],
                authenticatorSelection: {
                    // cross-platform for hardware security keys like YubiKey
                    authenticatorAttachment: 'cross-platform',
                    residentKey: 'discouraged',
                    userVerification: 'preferred',
                },
                timeout: 180000, // 3 minutes
                attestation: 'none',
            },
        }) as PublicKeyCredential;

        if (!credential) {
            return null;
        }

        const response = credential.response as AuthenticatorAttestationResponse;
        const credentialId = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)));
        const publicKeyBytes = new Uint8Array(response.getPublicKey?.() || []);
        const publicKeyBase64 = btoa(String.fromCharCode(...publicKeyBytes));

        // Format as OpenSSH sk-ecdsa key
        const publicKey = `sk-ecdsa-sha2-nistp256@openssh.com AAAAInNrLWVjZHNhLXNoYTItbmlzdHAyNTZAb3BlbnNzaC5jb20${publicKeyBase64.substring(0, 100)} ${label}@fido2`;

        return {
            credentialId,
            publicKey,
            rpId,
        };
    } catch (error) {
        console.error('FIDO2 credential creation failed:', error);
        throw error;
    }
};

// WebAuthn helper for Windows Hello
const createBiometricCredential = async (label: string): Promise<{
    credentialId: string;
    publicKey: string;
    rpId: string;
} | null> => {
    try {
        // Check if WebAuthn is supported
        if (!window.PublicKeyCredential) {
            throw new Error('WebAuthn is not supported in this environment');
        }

        // Check if we're in a secure context (HTTPS or localhost)
        if (!window.isSecureContext) {
            throw new Error('WebAuthn requires a secure context (HTTPS). This feature is not available in the current environment.');
        }

        // Check if platform authenticator is available (Windows Hello, Touch ID, etc.)
        const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
        if (!available) {
            const isMacOS = navigator.platform.toLowerCase().includes('mac') || navigator.userAgent.toLowerCase().includes('mac');
            throw new Error(`No platform authenticator available. Please ensure ${isMacOS ? 'Touch ID' : 'Windows Hello'} is set up in your system settings.`);
        }

        // For Electron apps, we need to handle the rpId carefully
        // The rpId must match the origin's effective domain
        let rpId: string;
        const hostname = window.location.hostname;

        // In Electron file:// protocol or localhost dev server
        if (!hostname || hostname === '' || hostname === 'localhost' || hostname === '127.0.0.1') {
            rpId = 'localhost';
        } else {
            rpId = hostname;
        }

        const userId = new TextEncoder().encode(crypto.randomUUID());

        const credential = await navigator.credentials.create({
            publicKey: {
                challenge: crypto.getRandomValues(new Uint8Array(32)),
                rp: {
                    name: 'Netcatty SSH Manager',
                    id: rpId,
                },
                user: {
                    id: userId,
                    name: label,
                    displayName: label,
                },
                pubKeyCredParams: [
                    { alg: -7, type: 'public-key' },  // ES256 (ECDSA P-256)
                ],
                authenticatorSelection: {
                    authenticatorAttachment: 'platform',
                    residentKey: 'discouraged',
                    userVerification: 'preferred',
                },
                timeout: 180000, // 3 minutes
                attestation: 'none',
            },
        }) as PublicKeyCredential;

        if (!credential) {
            return null;
        }

        const response = credential.response as AuthenticatorAttestationResponse;

        // Convert credential ID to base64
        const credentialId = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)));

        // Extract public key from attestation (simplified - in production, parse CBOR properly)
        const publicKeyBytes = new Uint8Array(response.getPublicKey?.() || []);
        const publicKeyBase64 = btoa(String.fromCharCode(...publicKeyBytes));

        // Format as OpenSSH sk-ecdsa key
        const publicKey = `sk-ecdsa-sha2-nistp256@openssh.com AAAAInNrLWVjZHNhLXNoYTItbmlzdHAyNTZAb3BlbnNzaC5jb20${publicKeyBase64.substring(0, 100)} ${label}@netcatty`;

        return {
            credentialId,
            publicKey,
            rpId,
        };
    } catch (error) {
        console.error('WebAuthn credential creation failed:', error);
        throw error;
    }
};

const KeychainManager: React.FC<KeychainManagerProps> = ({
    keys,
    identities = [],
    hosts = [],
    customGroups = [],
    onSave,
    onUpdate,
    onDelete,
    onSaveIdentity,
    onDeleteIdentity,
    onNewHost,
    onSaveHost,
    onCreateGroup,
}) => {
    const [activeFilter, setActiveFilter] = useState<FilterTab>('key');
    const [search, setSearch] = useState('');
    const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

    // Panel stack for navigation (supports back navigation)
    const [panelStack, setPanelStack] = useState<PanelMode[]>([]);
    const panel = panelStack.length > 0 ? panelStack[panelStack.length - 1] : { type: 'closed' } as PanelMode;

    const [showHostSelector, setShowHostSelector] = useState(false);
    const [isExporting, setIsExporting] = useState(false);

    // Export panel state
    const [exportLocation, setExportLocation] = useState('.ssh');
    const [exportFilename, setExportFilename] = useState('authorized_keys');
    const [exportHost, setExportHost] = useState<Host | null>(null);
    const [exportAdvancedOpen, setExportAdvancedOpen] = useState(false);
    const [exportScript, setExportScript] = useState(`DIR="$HOME/$1"
FILE="$DIR/$2"
if [ ! -d "$DIR" ]; then
  mkdir -p "$DIR"
  chmod 700 "$DIR"
fi
if [ ! -f "$FILE" ]; then
  touch "$FILE"
  chmod 600 "$FILE"
fi
echo $3 >> "$FILE"`);

    // Detect if running on macOS
    const isMac = useMemo(() => {
        return navigator.platform.toLowerCase().includes('mac') ||
            navigator.userAgent.toLowerCase().includes('mac');
    }, []);

    // Biometric authentication label based on platform
    const biometricLabel = isMac ? 'TOUCH ID' : 'WINDOWS HELLO';

    // Draft state for forms
    const [draftKey, setDraftKey] = useState<Partial<SSHKey>>({});
    const [draftIdentity, setDraftIdentity] = useState<Partial<Identity>>({});
    const [showPassphrase, setShowPassphrase] = useState(false);
    const [isGenerating, setIsGenerating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Filter keys based on active tab and search
    const filteredKeys = useMemo(() => {
        let result = keys;

        // Filter by tab
        switch (activeFilter) {
            case 'key':
                result = result.filter(k => k.source === 'generated' || k.source === 'imported');
                break;
            case 'certificate':
                result = result.filter(k => k.category === 'certificate' || k.certificate);
                break;
            case 'biometric':
                result = result.filter(k => k.source === 'biometric');
                break;
            case 'fido2':
                result = result.filter(k => k.source === 'fido2');
                break;
        }

        // Filter by search
        if (search.trim()) {
            const s = search.toLowerCase();
            result = result.filter(k =>
                k.label.toLowerCase().includes(s) ||
                k.type.toLowerCase().includes(s) ||
                k.publicKey?.toLowerCase().includes(s)
            );
        }

        return result;
    }, [keys, activeFilter, search]);

    // Filter identities based on search
    const filteredIdentities = useMemo(() => {
        if (!search.trim()) return identities;
        const s = search.toLowerCase();
        return identities.filter(i =>
            i.label.toLowerCase().includes(s) ||
            i.username.toLowerCase().includes(s)
        );
    }, [identities, search]);

    // Push a new panel onto the stack
    const pushPanel = useCallback((newPanel: PanelMode) => {
        setPanelStack(prev => [...prev, newPanel]);
        setError(null);
    }, []);

    // Pop the top panel from the stack (go back)
    const popPanel = useCallback(() => {
        setPanelStack(prev => {
            if (prev.length <= 1) {
                // Last panel, close everything
                setDraftKey({});
                setDraftIdentity({});
                setError(null);
                setShowPassphrase(false);
                setExportHost(null);
                setExportAdvancedOpen(false);
                return [];
            }
            return prev.slice(0, -1);
        });
    }, []);

    // Close all panels
    const closePanel = useCallback(() => {
        setPanelStack([]);
        setDraftKey({});
        setDraftIdentity({});
        setError(null);
        setShowPassphrase(false);
        setExportHost(null);
        setExportAdvancedOpen(false);
    }, []);

    // Open panel for viewing key (replaces stack with single panel)
    const openKeyView = useCallback((key: SSHKey) => {
        setPanelStack([{ type: 'view', key }]);
        setDraftKey({ ...key });
        setError(null);
    }, []);

    // Open panel for exporting key (pushes onto stack)
    const openKeyExport = useCallback((key: SSHKey) => {
        pushPanel({ type: 'export', key });
        setExportHost(null);
        setExportLocation('.ssh');
        setExportFilename('authorized_keys');
    }, [pushPanel]);

    // Open panel for editing key (replaces stack)
    const openKeyEdit = useCallback((key: SSHKey) => {
        setPanelStack([{ type: 'edit', key }]);
        setDraftKey({ ...key });
        setError(null);
    }, []);

    // Copy public key to clipboard
    const copyPublicKey = useCallback(async (key: SSHKey) => {
        if (key.publicKey) {
            try {
                await navigator.clipboard.writeText(key.publicKey);
                // Could add toast notification here
            } catch (err) {
                console.error('Failed to copy public key:', err);
            }
        }
    }, []);

    // Open panel for new identity
    const openNewIdentity = useCallback(() => {
        setPanelStack([{ type: 'identity' }]);
        setDraftIdentity({
            id: '',
            label: '',
            username: '',
            authMethod: 'password',
            created: Date.now(),
        });
        setError(null);
    }, []);

    // Open generate panel
    const openGenerate = useCallback((keyType: 'standard' | 'biometric' | 'fido2') => {
        const defaultType = (keyType === 'biometric' || keyType === 'fido2') ? 'ECDSA' : 'ED25519';
        // Set default keySize based on type: ED25519 doesn't need size, RSA defaults to 4096, ECDSA to 256
        const getDefaultKeySize = (type: string) => {
            if (type === 'ED25519') return undefined;
            if (type === 'RSA') return 4096;
            return 256; // ECDSA
        };

        const getSource = () => {
            if (keyType === 'biometric') return 'biometric';
            if (keyType === 'fido2') return 'fido2';
            return 'generated';
        };

        setPanelStack([{ type: 'generate', keyType }]);
        setDraftKey({
            id: '',
            label: '',
            type: defaultType,
            keySize: getDefaultKeySize(defaultType),
            privateKey: '',
            publicKey: '',
            source: getSource(),
            category: 'key',
            created: Date.now(),
        });
        setError(null);
    }, []);

    // Open import panel
    const openImport = useCallback(() => {
        setPanelStack([{ type: 'import' }]);
        setDraftKey({
            id: '',
            label: '',
            type: 'ED25519',
            privateKey: '',
            publicKey: '',
            source: 'imported',
            category: 'key',
            created: Date.now(),
        });
        setError(null);
    }, []);

    // Handle standard key generation
    const handleGenerateStandard = useCallback(async () => {
        if (!draftKey.label?.trim()) {
            setError('Please enter a label for the key');
            return;
        }

        setIsGenerating(true);
        setError(null);

        try {
            const keyType = draftKey.type as KeyType || 'ED25519';
            const keySize = draftKey.keySize;

            // Use real key generation via Electron backend
            if (window.nebula?.generateKeyPair) {
                const result = await window.nebula.generateKeyPair({
                    type: keyType,
                    bits: keySize,
                    comment: `${draftKey.label.trim()}@netcatty`,
                });

                if (!result.success || !result.privateKey || !result.publicKey) {
                    throw new Error(result.error || 'Failed to generate key pair');
                }

                const newKey: SSHKey = {
                    id: crypto.randomUUID(),
                    label: draftKey.label.trim(),
                    type: keyType,
                    keySize: keyType !== 'ED25519' ? keySize : undefined,
                    privateKey: result.privateKey,
                    publicKey: result.publicKey,
                    passphrase: draftKey.passphrase,
                    savePassphrase: draftKey.savePassphrase,
                    source: 'generated',
                    category: 'key',
                    created: Date.now(),
                };

                onSave(newKey);
                closePanel();
            } else {
                throw new Error('Key generation not available - please ensure the app is running in Electron');
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to generate key');
        } finally {
            setIsGenerating(false);
        }
    }, [draftKey, onSave, closePanel]);

    // Handle biometric key generation (Windows Hello)
    const handleGenerateBiometric = useCallback(async () => {
        if (!draftKey.label?.trim()) {
            setError('Please enter a label for the key');
            return;
        }

        setIsGenerating(true);
        setError(null);

        try {
            const result = await createBiometricCredential(draftKey.label.trim());

            if (!result) {
                throw new Error('Credential creation was cancelled');
            }

            const newKey: SSHKey = {
                id: crypto.randomUUID(),
                label: draftKey.label.trim(),
                type: 'ECDSA',
                privateKey: '', // Biometric keys don't have exportable private keys
                publicKey: result.publicKey,
                credentialId: result.credentialId,
                rpId: result.rpId,
                source: 'biometric',
                category: 'key',
                created: Date.now(),
            };

            onSave(newKey);
            closePanel();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to create biometric credential');
        } finally {
            setIsGenerating(false);
        }
    }, [draftKey, onSave, closePanel]);

    // Handle FIDO2 hardware key registration
    const handleGenerateFido2 = useCallback(async () => {
        if (!draftKey.label?.trim()) {
            setError('Please enter a label for the security key');
            return;
        }

        setIsGenerating(true);
        setError(null);

        try {
            const result = await createFido2Credential(draftKey.label.trim());

            if (!result) {
                throw new Error('Security key registration was cancelled');
            }

            const newKey: SSHKey = {
                id: crypto.randomUUID(),
                label: draftKey.label.trim(),
                type: 'ECDSA',
                privateKey: '', // Hardware keys don't expose private keys
                publicKey: result.publicKey,
                credentialId: result.credentialId,
                rpId: result.rpId,
                source: 'fido2',
                category: 'key',
                created: Date.now(),
            };

            onSave(newKey);
            closePanel();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to register security key');
        } finally {
            setIsGenerating(false);
        }
    }, [draftKey, onSave, closePanel]);

    // Handle key import
    const handleImport = useCallback(() => {
        if (!draftKey.label?.trim() || !draftKey.privateKey?.trim()) {
            setError('Label and private key are required');
            return;
        }

        // Detect key type from private key content
        let detectedType: KeyType = 'ED25519';
        const pk = draftKey.privateKey.toLowerCase();
        if (pk.includes('rsa')) detectedType = 'RSA';
        else if (pk.includes('ecdsa') || pk.includes('ec ')) detectedType = 'ECDSA';
        else if (pk.includes('ed25519')) detectedType = 'ED25519';

        const newKey: SSHKey = {
            id: crypto.randomUUID(),
            label: draftKey.label.trim(),
            type: draftKey.type as KeyType || detectedType,
            privateKey: draftKey.privateKey.trim(),
            publicKey: draftKey.publicKey?.trim() || undefined,
            certificate: draftKey.certificate?.trim() || undefined,
            passphrase: draftKey.passphrase,
            savePassphrase: draftKey.savePassphrase,
            source: 'imported',
            category: draftKey.certificate ? 'certificate' : 'key',
            created: Date.now(),
        };

        onSave(newKey);
        closePanel();
    }, [draftKey, onSave, closePanel]);

    // Handle save identity
    const handleSaveIdentity = useCallback(() => {
        if (!draftIdentity.label?.trim() || !draftIdentity.username?.trim()) {
            setError('Label and username are required');
            return;
        }

        if (!onSaveIdentity) return;

        const newIdentity: Identity = {
            id: draftIdentity.id || crypto.randomUUID(),
            label: draftIdentity.label.trim(),
            username: draftIdentity.username.trim(),
            authMethod: draftIdentity.authMethod || 'password',
            password: draftIdentity.password,
            keyId: draftIdentity.keyId,
            created: draftIdentity.created || Date.now(),
        };

        onSaveIdentity(newIdentity);
        closePanel();
    }, [draftIdentity, onSaveIdentity, closePanel]);

    // Handle delete
    const handleDelete = useCallback((id: string) => {
        onDelete(id);
        if (panel.type === 'view' && panel.key.id === id) {
            closePanel();
        }
    }, [onDelete, panel, closePanel]);

    // Handle delete identity
    const handleDeleteIdentity = useCallback((id: string) => {
        onDeleteIdentity?.(id);
        if (panel.type === 'identity' && panel.identity?.id === id) {
            closePanel();
        }
    }, [onDeleteIdentity, panel, closePanel]);

    // Copy to clipboard
    const copyToClipboard = useCallback((text: string) => {
        navigator.clipboard.writeText(text);
    }, []);

    // Get icon for key source
    const getKeyIcon = (key: SSHKey) => {
        if (key.source === 'biometric') return <Fingerprint size={16} />;
        if (key.source === 'fido2') return <Shield size={16} />;
        if (key.certificate) return <BadgeCheck size={16} />;
        return <Key size={16} />;
    };

    // Get key type display
    const getKeyTypeDisplay = (key: SSHKey) => {
        if (key.source === 'biometric') return isMac ? 'Touch ID' : 'Windows Hello';
        if (key.source === 'fido2') return 'FIDO2';
        return key.type;
    };

    // File input ref for import
    const fileInputRef = React.useRef<HTMLInputElement>(null);

    // Handle file import
    const handleFileImport = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            const content = e.target?.result as string;
            if (content) {
                // Try to detect key type from content
                let detectedType: KeyType = 'ED25519';
                const lc = content.toLowerCase();
                if (lc.includes('rsa')) detectedType = 'RSA';
                else if (lc.includes('ecdsa') || lc.includes('ec private')) detectedType = 'ECDSA';
                else if (lc.includes('ed25519')) detectedType = 'ED25519';

                // Extract label from filename (remove extension)
                const label = file.name.replace(/\.(pem|key|pub|ppk)$/i, '');

                setDraftKey(prev => ({
                    ...prev,
                    privateKey: content,
                    label: prev.label || label,
                    type: detectedType,
                }));
            }
        };
        reader.readAsText(file);

        // Reset input so same file can be selected again
        event.target.value = '';
    }, []);

    // Handle drag and drop
    const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();

        const file = event.dataTransfer.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            const content = e.target?.result as string;
            if (content) {
                let detectedType: KeyType = 'ED25519';
                const lc = content.toLowerCase();
                if (lc.includes('rsa')) detectedType = 'RSA';
                else if (lc.includes('ecdsa') || lc.includes('ec private')) detectedType = 'ECDSA';
                else if (lc.includes('ed25519')) detectedType = 'ED25519';

                const label = file.name.replace(/\.(pem|key|pub|ppk)$/i, '');

                setDraftKey(prev => ({
                    ...prev,
                    privateKey: content,
                    label: prev.label || label,
                    type: detectedType,
                }));
            }
        };
        reader.readAsText(file);
    }, []);

    const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
    }, []);

    return (
        <div className="h-full flex relative">
            {/* Hidden file input */}
            <input
                ref={fileInputRef}
                type="file"
                accept=".pem,.key,.pub,.ppk,*"
                className="hidden"
                onChange={handleFileImport}
            />

            {/* Main Content */}
            <div className={cn(
                "flex-1 overflow-y-auto transition-all duration-200",
                panel.type !== 'closed' && "mr-[380px]"
            )}>
                {/* Toolbar */}
                <div className="flex flex-wrap items-center gap-3 bg-secondary/60 border-b border-border/70 px-3 py-1.5">
                    {/* Filter Tabs */}
                    <div className="flex items-center gap-1">
                        {/* KEY button with split interaction: left=switch view, right=dropdown */}
                        <div className={cn(
                            "flex items-center rounded-md transition-colors",
                            activeFilter === 'key'
                                ? "bg-primary/15"
                                : "hover:bg-accent"
                        )}>
                            <Button
                                size="sm"
                                variant="ghost"
                                className={cn(
                                    "h-8 px-3 gap-2 rounded-r-none hover:bg-transparent",
                                    activeFilter === 'key' && "text-primary"
                                )}
                                onClick={() => setActiveFilter('key')}
                            >
                                <Key size={14} />
                                KEY
                            </Button>
                            <Popover>
                                <PopoverTrigger asChild>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        className={cn(
                                            "h-8 px-1.5 rounded-l-none hover:bg-transparent",
                                            activeFilter === 'key' && "text-primary"
                                        )}
                                    >
                                        <ChevronDown size={12} />
                                    </Button>
                                </PopoverTrigger>
                                <PopoverContent className="w-44 p-1">
                                    <Button
                                        variant="ghost"
                                        className="w-full justify-start gap-2"
                                        onClick={() => openGenerate('standard')}
                                    >
                                        <Plus size={14} /> Generate Key
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        className="w-full justify-start gap-2"
                                        onClick={openImport}
                                    >
                                        <Upload size={14} /> Import Key
                                    </Button>
                                    {onSaveIdentity && (
                                        <Button
                                            variant="ghost"
                                            className="w-full justify-start gap-2"
                                            onClick={openNewIdentity}
                                        >
                                            <UserPlus size={14} /> New Identity
                                        </Button>
                                    )}
                                </PopoverContent>
                            </Popover>
                        </div>

                        {/* CERTIFICATE button with split interaction */}
                        <div className={cn(
                            "flex items-center rounded-md transition-colors",
                            activeFilter === 'certificate'
                                ? "bg-primary/15"
                                : "hover:bg-accent"
                        )}>
                            <Button
                                size="sm"
                                variant="ghost"
                                className={cn(
                                    "h-8 px-3 gap-2 rounded-r-none hover:bg-transparent",
                                    activeFilter === 'certificate' && "text-primary"
                                )}
                                onClick={() => setActiveFilter('certificate')}
                            >
                                <BadgeCheck size={14} />
                                CERTIFICATE
                                <span className="text-[10px] px-1.5 rounded-full bg-muted text-muted-foreground">
                                    {keys.filter(k => k.certificate).length}
                                </span>
                            </Button>
                            <Popover>
                                <PopoverTrigger asChild>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        className={cn(
                                            "h-8 px-1.5 rounded-l-none hover:bg-transparent",
                                            activeFilter === 'certificate' && "text-primary"
                                        )}
                                    >
                                        <ChevronDown size={12} />
                                    </Button>
                                </PopoverTrigger>
                                <PopoverContent className="w-44 p-1">
                                    <Button
                                        variant="ghost"
                                        className="w-full justify-start gap-2"
                                        onClick={openImport}
                                    >
                                        <Upload size={14} /> Import Certificate
                                    </Button>
                                </PopoverContent>
                            </Popover>
                        </div>

                        <Button
                            size="sm"
                            variant={activeFilter === 'biometric' ? "secondary" : "ghost"}
                            className={cn(
                                "h-8 px-3 gap-2",
                                activeFilter === 'biometric' && "bg-primary/15 text-primary"
                            )}
                            onClick={() => setActiveFilter('biometric')}
                        >
                            <Fingerprint size={14} />
                            {biometricLabel}
                        </Button>

                        <Button
                            size="sm"
                            variant={activeFilter === 'fido2' ? "secondary" : "ghost"}
                            className={cn(
                                "h-8 px-3 gap-2",
                                activeFilter === 'fido2' && "bg-primary/15 text-primary"
                            )}
                            onClick={() => setActiveFilter('fido2')}
                        >
                            <Shield size={14} />
                            FIDO2
                        </Button>
                    </div>

                    {/* Search and View Mode - hide search when panel is open */}
                    <div className="ml-auto flex items-center gap-2 min-w-0 flex-shrink">
                        {panel.type === 'closed' && (
                            <div className="relative flex-shrink min-w-[100px]">
                                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                                <Input
                                    value={search}
                                    onChange={e => setSearch(e.target.value)}
                                    placeholder="Search..."
                                    className="h-9 pl-8 w-full"
                                />
                            </div>
                        )}
                        <Popover>
                            <PopoverTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-9 w-9 flex-shrink-0">
                                    {viewMode === 'grid' ? <LayoutGrid size={16} /> : <ListIcon size={16} />}
                                    <ChevronDown size={10} className="ml-0.5" />
                                </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-32 p-1 z-50" align="end">
                                <Button
                                    variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
                                    className="w-full justify-start gap-2 h-9"
                                    onClick={() => setViewMode('grid')}
                                >
                                    <LayoutGrid size={14} /> Grid
                                </Button>
                                <Button
                                    variant={viewMode === 'list' ? 'secondary' : 'ghost'}
                                    className="w-full justify-start gap-2 h-9"
                                    onClick={() => setViewMode('list')}
                                >
                                    <ListIcon size={14} /> List
                                </Button>
                            </PopoverContent>
                        </Popover>
                    </div>
                </div>

                {/* Keys Section */}
                <div className="space-y-3 p-3">
                    <div className="flex items-center justify-between">
                        <h2 className="text-base font-semibold text-muted-foreground">Keys</h2>
                        <span className="text-xs text-muted-foreground">{filteredKeys.length} items</span>
                    </div>

                    {filteredKeys.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
                            <div className="h-16 w-16 rounded-2xl bg-secondary/80 flex items-center justify-center mb-4">
                                <Shield size={32} className="opacity-60" />
                            </div>
                            <h3 className="text-lg font-semibold text-foreground mb-2">
                                {activeFilter === 'biometric' ? `Set up ${isMac ? 'Touch ID' : 'Windows Hello'}` :
                                    activeFilter === 'fido2' ? 'Add a security key' :
                                        'Set up your keys'}
                            </h3>
                            <p className="text-sm text-center max-w-sm mb-4">
                                {activeFilter === 'biometric'
                                    ? `Create biometric SSH keys secured by ${isMac ? 'Touch ID' : 'Windows Hello'} for passwordless authentication.`
                                    : activeFilter === 'fido2'
                                        ? 'Connect a hardware security key (YubiKey, etc.) for enhanced security.'
                                        : 'Import or generate SSH keys for secure authentication.'}
                            </p>
                            {activeFilter === 'biometric' && (
                                <Button onClick={() => openGenerate('biometric')}>
                                    <Fingerprint size={14} className="mr-2" />
                                    Create Biometric Key
                                </Button>
                            )}
                            {activeFilter === 'fido2' && (
                                <Button onClick={() => openGenerate('fido2')}>
                                    <Shield size={14} className="mr-2" />
                                    Register Security Key
                                </Button>
                            )}
                            {(activeFilter === 'key' || activeFilter === 'certificate') && (
                                <div className="flex gap-2">
                                    <Button variant="secondary" onClick={openImport}>
                                        <Upload size={14} className="mr-2" />
                                        Import
                                    </Button>
                                    <Button onClick={() => openGenerate('standard')}>
                                        <Plus size={14} className="mr-2" />
                                        Generate
                                    </Button>
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className={viewMode === 'grid'
                            ? "grid gap-2.5 grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                            : "space-y-2"
                        }>
                            {filteredKeys.map((key) => (
                                <ContextMenu key={key.id}>
                                    <ContextMenuTrigger asChild>
                                        <Card
                                            className={cn(
                                                "group relative overflow-hidden bg-secondary/60 border transition-all cursor-pointer",
                                                "h-[72px] px-3 py-2",
                                                viewMode === 'list' && "w-full",
                                                "border-border/60 shadow-sm hover:shadow-[0_0_0_2px_var(--ring)]",
                                                (panel.type === 'view' && panel.key.id === key.id) && "ring-2 ring-primary",
                                                (panel.type === 'export' && panel.key.id === key.id) && "ring-2 ring-primary"
                                            )}
                                            onClick={() => openKeyView(key)}
                                        >
                                            <div className="flex items-center gap-3 h-full">
                                                <div className={cn(
                                                    "h-9 w-9 rounded-md flex items-center justify-center",
                                                    key.source === 'biometric'
                                                        ? "bg-blue-500/15 text-blue-500"
                                                        : key.source === 'fido2'
                                                            ? "bg-amber-500/15 text-amber-500"
                                                            : "bg-primary/15 text-primary"
                                                )}>
                                                    {getKeyIcon(key)}
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <CardTitle className="text-sm font-semibold truncate">{key.label}</CardTitle>
                                                    <CardDescription className="text-[11px] font-mono text-muted-foreground truncate">
                                                        Type {getKeyTypeDisplay(key)}
                                                    </CardDescription>
                                                </div>
                                                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                    <Button
                                                        size="icon"
                                                        variant="ghost"
                                                        className="h-8 w-8 text-destructive hover:text-destructive"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleDelete(key.id);
                                                        }}
                                                    >
                                                        <Trash2 size={14} />
                                                    </Button>
                                                </div>
                                            </div>
                                        </Card>
                                    </ContextMenuTrigger>
                                    <ContextMenuContent>
                                        <ContextMenuItem
                                            onClick={() => copyPublicKey(key)}
                                            disabled={!key.publicKey}
                                        >
                                            <Copy size={14} className="mr-2" />
                                            Copy Public Key
                                        </ContextMenuItem>
                                        <ContextMenuItem onClick={() => openKeyExport(key)}>
                                            <ExternalLink size={14} className="mr-2" />
                                            Key Export
                                        </ContextMenuItem>
                                        <ContextMenuItem onClick={() => openKeyEdit(key)}>
                                            <Pencil size={14} className="mr-2" />
                                            Edit
                                        </ContextMenuItem>
                                        <ContextMenuSeparator />
                                        <ContextMenuItem
                                            onClick={() => handleDelete(key.id)}
                                            className="text-destructive focus:text-destructive"
                                        >
                                            <Trash2 size={14} className="mr-2" />
                                            Delete
                                        </ContextMenuItem>
                                    </ContextMenuContent>
                                </ContextMenu>
                            ))}
                        </div>
                    )}
                </div>

                {/* Identities Section */}
                {activeFilter === 'key' && filteredIdentities.length > 0 && (
                    <div className="space-y-3 px-3 pb-3">
                        <div className="flex items-center justify-between">
                            <h2 className="text-base font-semibold text-muted-foreground">Identities</h2>
                            <span className="text-xs text-muted-foreground">{filteredIdentities.length} items</span>
                        </div>
                        <div className={viewMode === 'grid'
                            ? "grid gap-2.5 grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                            : "space-y-2"
                        }>
                            {filteredIdentities.map((identity) => (
                                <Card
                                    key={identity.id}
                                    className={cn(
                                        "group relative overflow-hidden bg-secondary/60 border transition-all cursor-pointer",
                                        "h-[72px] px-3 py-2",
                                        viewMode === 'list' && "w-full",
                                        "border-border/60 shadow-sm hover:shadow-[0_0_0_2px_var(--ring)]",
                                        panel.type === 'identity' && panel.identity?.id === identity.id && "ring-2 ring-primary"
                                    )}
                                    onClick={() => {
                                        setPanelStack([{ type: 'identity', identity }]);
                                        setDraftIdentity({ ...identity });
                                    }}
                                >
                                    <div className="flex items-center gap-3 h-full">
                                        <div className="h-9 w-9 rounded-md bg-green-500/15 text-green-500 flex items-center justify-center">
                                            <User size={16} />
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <CardTitle className="text-sm font-semibold truncate">{identity.label || 'Add a label...'}</CardTitle>
                                            <CardDescription className="text-[11px] font-mono text-muted-foreground truncate">
                                                {identity.authMethod === 'password' ? 'Password' :
                                                    identity.authMethod === 'key' ? 'Key' :
                                                        identity.authMethod === 'certificate' ? 'Certificate' :
                                                            'FIDO2'}
                                            </CardDescription>
                                        </div>
                                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                className="h-8 w-8 text-destructive hover:text-destructive"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleDeleteIdentity(identity.id);
                                                }}
                                            >
                                                <Trash2 size={14} />
                                            </Button>
                                        </div>
                                    </div>
                                </Card>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* Slide-out Panel */}
            {panel.type !== 'closed' && (
                <AsidePanel
                    open={true}
                    onClose={closePanel}
                    title={
                        panel.type === 'generate' && panel.keyType === 'biometric' ? 'Generate Biometric Key' :
                            panel.type === 'generate' && panel.keyType === 'standard' ? 'Generate Key' :
                                panel.type === 'generate' && panel.keyType === 'fido2' ? 'Register Security Key' :
                                    panel.type === 'import' ? 'New Key' :
                                        panel.type === 'view' ? (panel.key.source === 'biometric' ? 'Biometric Key' : panel.key.source === 'fido2' ? 'Security Key' : 'Key Details') :
                                            panel.type === 'edit' ? 'Edit Key' :
                                                panel.type === 'identity' ? (panel.identity ? 'Edit Identity' : 'New Identity') :
                                                    panel.type === 'export' ? 'Key Export' : ''
                    }
                    showBackButton={panelStack.length > 1}
                    onBack={popPanel}
                    actions={
                        (panel.type === 'view' || panel.type === 'identity') ? (
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                                <MoreHorizontal size={16} />
                            </Button>
                        ) : undefined
                    }
                >
                    <AsidePanelContent>
                        {/* Error Display */}
                        {error && (
                            <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">
                                {error}
                            </div>
                        )}

                        {/* Generate Biometric Key */}
                        {panel.type === 'generate' && panel.keyType === 'biometric' && (
                            <>
                                {/* Keyboard illustration */}
                                <div className="bg-card border border-border/80 rounded-lg p-3 flex items-center justify-center overflow-hidden">
                                    <div className="text-center w-full">
                                        <div className="flex justify-center items-center gap-0.5 mb-1.5">
                                            {['9', '0', ')', '-', '+', '='].map((k, i) => (
                                                <div key={i} className="w-6 h-6 bg-secondary border border-border/60 rounded text-[10px] flex items-center justify-center flex-shrink-0">
                                                    {k}
                                                </div>
                                            ))}
                                            <div className="w-12 h-6 bg-secondary border border-border/60 rounded text-[9px] flex items-center justify-center flex-shrink-0">
                                                back
                                            </div>
                                            <div className="w-8 h-8 bg-blue-500/20 border border-blue-500/40 rounded-lg flex items-center justify-center ml-1.5 flex-shrink-0">
                                                <Fingerprint size={16} className="text-blue-500" />
                                            </div>
                                        </div>
                                        <div className="flex justify-center gap-0.5">
                                            {['I', 'O', 'P', '[', ']', '{', '}'].map((k, i) => (
                                                <div key={i} className="w-6 h-6 bg-secondary border border-border/60 rounded text-[10px] flex items-center justify-center flex-shrink-0">
                                                    {k}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                </div>

                                <p className="text-sm text-muted-foreground text-center">
                                    Biometric Key based on Secure Enclave Process built-in into your {isMac ? 'mac' : 'system'}. This key is not possible to copy or steal.
                                </p>

                                <div className="space-y-2">
                                    <Label>Label</Label>
                                    <Input
                                        value={draftKey.label || ''}
                                        onChange={e => setDraftKey({ ...draftKey, label: e.target.value })}
                                        placeholder={isMac ? 'Touch ID' : 'Windows Hello'}
                                    />
                                </div>

                                <div className="space-y-1">
                                    <Label className="text-muted-foreground">Type</Label>
                                    <p className="text-sm">ECDSA</p>
                                </div>

                                <div className="space-y-1">
                                    <Label className="text-muted-foreground">Key Size</Label>
                                    <p className="text-sm">256</p>
                                </div>

                                <Button
                                    className="w-full h-11"
                                    onClick={handleGenerateBiometric}
                                    disabled={isGenerating || !draftKey.label?.trim()}
                                >
                                    {isGenerating ? (
                                        <div className="h-4 w-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    ) : (
                                        'Generate'
                                    )}
                                </Button>
                            </>
                        )}

                        {/* Register FIDO2 Hardware Key */}
                        {panel.type === 'generate' && panel.keyType === 'fido2' && (
                            <>
                                {/* Security key illustration */}
                                <div className="bg-card border border-border/80 rounded-lg p-4 flex items-center justify-center">
                                    <div className="text-center">
                                        <div className="flex justify-center mb-3">
                                            <div className="w-20 h-12 bg-gradient-to-b from-zinc-600 to-zinc-800 rounded-lg flex items-center justify-center border border-zinc-500/50 shadow-lg">
                                                <div className="w-4 h-6 bg-amber-500/80 rounded-sm" />
                                            </div>
                                        </div>
                                        <p className="text-xs text-muted-foreground">YubiKey or compatible device</p>
                                    </div>
                                </div>

                                <p className="text-sm text-muted-foreground text-center">
                                    Connect your hardware security key (YubiKey, Titan, etc.) and touch it when prompted. The private key never leaves the device.
                                </p>

                                <div className="space-y-2">
                                    <Label>Label</Label>
                                    <Input
                                        value={draftKey.label || ''}
                                        onChange={e => setDraftKey({ ...draftKey, label: e.target.value })}
                                        placeholder="My YubiKey"
                                    />
                                </div>

                                <div className="space-y-1">
                                    <Label className="text-muted-foreground">Type</Label>
                                    <p className="text-sm">ECDSA (Hardware-backed)</p>
                                </div>

                                <div className="space-y-1">
                                    <Label className="text-muted-foreground">Key Size</Label>
                                    <p className="text-sm">P-256</p>
                                </div>

                                <Button
                                    className="w-full h-11"
                                    onClick={handleGenerateFido2}
                                    disabled={isGenerating || !draftKey.label?.trim()}
                                >
                                    {isGenerating ? (
                                        <div className="h-4 w-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    ) : (
                                        <>
                                            <Shield size={14} className="mr-2" />
                                            Register Security Key
                                        </>
                                    )}
                                </Button>
                            </>
                        )}

                        {/* Generate Standard Key */}
                        {panel.type === 'generate' && panel.keyType === 'standard' && (
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
                                    onClick={handleGenerateStandard}
                                    disabled={isGenerating || !draftKey.label?.trim()}
                                >
                                    {isGenerating ? (
                                        <div className="h-4 w-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    ) : (
                                        'Generate & save'
                                    )}
                                </Button>
                            </>
                        )}

                        {/* Import Key */}
                        {panel.type === 'import' && (
                            <>
                                <div className="space-y-2">
                                    <Label>Label</Label>
                                    <Input
                                        value={draftKey.label || ''}
                                        onChange={e => setDraftKey({ ...draftKey, label: e.target.value })}
                                        placeholder="Key label"
                                    />
                                </div>

                                <div className="space-y-2">
                                    <Label>Private key *</Label>
                                    <Textarea
                                        value={draftKey.privateKey || ''}
                                        onChange={e => setDraftKey({ ...draftKey, privateKey: e.target.value })}
                                        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                                        className="min-h-[120px] font-mono text-xs"
                                    />
                                </div>

                                <div className="space-y-2">
                                    <Label>Public key</Label>
                                    <Textarea
                                        value={draftKey.publicKey || ''}
                                        onChange={e => setDraftKey({ ...draftKey, publicKey: e.target.value })}
                                        placeholder="ssh-ed25519 AAAAC3... user@host"
                                        className="min-h-[80px] font-mono text-xs"
                                    />
                                </div>

                                <div className="space-y-2">
                                    <Label className="flex items-center gap-2">
                                        Certificate
                                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                                            Optional
                                        </span>
                                    </Label>
                                    <Textarea
                                        value={draftKey.certificate || ''}
                                        onChange={e => setDraftKey({ ...draftKey, certificate: e.target.value })}
                                        placeholder="Paste certificate..."
                                        className="min-h-[80px] font-mono text-xs"
                                    />
                                </div>

                                <div
                                    className="border border-dashed border-border/80 rounded-xl p-4 text-center space-y-2 bg-background/60 transition-colors hover:border-primary/50"
                                    onDrop={handleDrop}
                                    onDragOver={handleDragOver}
                                >
                                    <div className="flex items-center justify-center gap-2 text-muted-foreground">
                                        <Upload size={16} />
                                        <span className="text-sm">Drag and drop a private key file to import</span>
                                    </div>
                                    <Button
                                        variant="secondary"
                                        className="w-full"
                                        onClick={() => fileInputRef.current?.click()}
                                    >
                                        Import from key file
                                    </Button>
                                </div>

                                <Button
                                    className="w-full h-11"
                                    onClick={handleImport}
                                    disabled={!draftKey.label?.trim() || !draftKey.privateKey?.trim()}
                                >
                                    Save Key
                                </Button>
                            </>
                        )}

                        {/* View Key */}
                        {panel.type === 'view' && (
                            <>
                                <div className="space-y-2">
                                    <Label className="text-muted-foreground">Label</Label>
                                    <p className="text-sm">{panel.key.label}</p>
                                </div>

                                {panel.key.publicKey && (
                                    <div className="space-y-2">
                                        <Label className="text-muted-foreground">Public Key</Label>
                                        <div className="relative">
                                            <div className="p-3 bg-card border border-border/80 rounded-lg font-mono text-xs break-all max-h-32 overflow-y-auto">
                                                {panel.key.publicKey}
                                            </div>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                className="absolute top-2 right-2 h-7 w-7"
                                                onClick={() => copyToClipboard(panel.key.publicKey || '')}
                                            >
                                                <Copy size={12} />
                                            </Button>
                                        </div>
                                    </div>
                                )}

                                <div className="space-y-1">
                                    <Label className="text-muted-foreground">Type</Label>
                                    <p className="text-sm">{panel.key.type}</p>
                                </div>

                                {panel.key.source === 'biometric' && (
                                    <div className="space-y-1">
                                        <Label className="text-muted-foreground">Key Size</Label>
                                        <p className="text-sm">256</p>
                                    </div>
                                )}

                                {/* Key Export section */}
                                <div className="pt-4 mt-4 border-t border-border/60">
                                    <div className="flex items-center gap-2 mb-3">
                                        <span className="text-sm font-medium">Key export</span>
                                        <div className="h-4 w-4 rounded-full bg-muted flex items-center justify-center">
                                            <Info size={10} className="text-muted-foreground" />
                                        </div>
                                    </div>
                                    <Button
                                        className="w-full h-11"
                                        onClick={() => openKeyExport(panel.key)}
                                    >
                                        Export to host
                                    </Button>
                                </div>
                            </>
                        )}

                        {/* Identity Panel */}
                        {panel.type === 'identity' && (
                            <>
                                <div className="flex items-center gap-3 mb-4">
                                    <div className="h-10 w-10 rounded-lg bg-green-500/15 text-green-500 flex items-center justify-center">
                                        <User size={20} />
                                    </div>
                                    <Input
                                        value={draftIdentity.label || ''}
                                        onChange={e => setDraftIdentity({ ...draftIdentity, label: e.target.value })}
                                        placeholder="Label"
                                        className="flex-1"
                                    />
                                </div>

                                <div className="space-y-2">
                                    <Label>Username *</Label>
                                    <div className="relative">
                                        <User size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                                        <Input
                                            value={draftIdentity.username || ''}
                                            onChange={e => setDraftIdentity({ ...draftIdentity, username: e.target.value })}
                                            placeholder="Username"
                                            className="pl-9"
                                        />
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <Label>Password</Label>
                                    <div className="relative">
                                        <Input
                                            type={showPassphrase ? 'text' : 'password'}
                                            value={draftIdentity.password || ''}
                                            onChange={e => setDraftIdentity({ ...draftIdentity, password: e.target.value })}
                                            placeholder="Password"
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

                                <div className="space-y-2">
                                    <Label>Authentication Method</Label>
                                    <Popover>
                                        <PopoverTrigger asChild>
                                            <Button variant="secondary" className="w-full justify-between h-10">
                                                <span className="flex items-center gap-2">
                                                    {draftIdentity.authMethod === 'key' && <><Key size={14} /> Key</>}
                                                    {draftIdentity.authMethod === 'certificate' && <><BadgeCheck size={14} /> Certificate</>}
                                                    {draftIdentity.authMethod === 'fido2' && <><Shield size={14} /> FIDO2</>}
                                                    {(!draftIdentity.authMethod || draftIdentity.authMethod === 'password') && 'None (Password only)'}
                                                </span>
                                                <ChevronDown size={14} />
                                            </Button>
                                        </PopoverTrigger>
                                        <PopoverContent className="w-56 p-1">
                                            <Button
                                                variant="ghost"
                                                className="w-full justify-start gap-2"
                                                onClick={() => setDraftIdentity({ ...draftIdentity, authMethod: 'key', keyId: undefined })}
                                            >
                                                <Key size={14} /> Key
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                className="w-full justify-start gap-2"
                                                onClick={() => setDraftIdentity({ ...draftIdentity, authMethod: 'certificate', keyId: undefined })}
                                            >
                                                <BadgeCheck size={14} /> Certificate
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                className="w-full justify-start gap-2"
                                                onClick={() => setDraftIdentity({ ...draftIdentity, authMethod: 'fido2', keyId: undefined })}
                                            >
                                                <Shield size={14} /> FIDO2
                                            </Button>
                                        </PopoverContent>
                                    </Popover>
                                </div>

                                {(draftIdentity.authMethod === 'key' || draftIdentity.authMethod === 'certificate') && (
                                    <div className="space-y-2">
                                        <Label>Select {draftIdentity.authMethod === 'key' ? 'Key' : 'Certificate'}</Label>
                                        <select
                                            value={draftIdentity.keyId || ''}
                                            onChange={e => setDraftIdentity({ ...draftIdentity, keyId: e.target.value || undefined })}
                                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                        >
                                            <option value="">Select...</option>
                                            {keys
                                                .filter(k => draftIdentity.authMethod === 'certificate' ? k.certificate : !k.certificate)
                                                .map(k => (
                                                    <option key={k.id} value={k.id}>{k.label}</option>
                                                ))
                                            }
                                        </select>
                                    </div>
                                )}

                                <Button
                                    className="w-full h-11"
                                    onClick={handleSaveIdentity}
                                    disabled={!draftIdentity.label?.trim() || !draftIdentity.username?.trim()}
                                >
                                    {panel.identity ? 'Update Identity' : 'Save Identity'}
                                </Button>
                            </>
                        )}

                        {/* Key Export Panel */}
                        {panel.type === 'export' && !showHostSelector && (
                            <>
                                {/* Key info card */}
                                <div className="flex items-center gap-3 p-3 bg-card border border-border/80 rounded-lg">
                                    <div className={cn(
                                        "h-10 w-10 rounded-md flex items-center justify-center",
                                        panel.key.source === 'biometric'
                                            ? "bg-blue-500/15 text-blue-500"
                                            : panel.key.source === 'fido2'
                                                ? "bg-amber-500/15 text-amber-500"
                                                : "bg-primary/15 text-primary"
                                    )}>
                                        {getKeyIcon(panel.key)}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm font-semibold truncate">{panel.key.label}</p>
                                        <p className="text-xs text-muted-foreground">Type {getKeyTypeDisplay(panel.key)}</p>
                                    </div>
                                </div>

                                {/* Export to field */}
                                <div className="space-y-2">
                                    <div className="flex items-center justify-between">
                                        <Label className="text-muted-foreground">Export to *</Label>
                                        <Button
                                            variant="link"
                                            className="h-auto p-0 text-primary text-sm"
                                            onClick={() => setShowHostSelector(true)}
                                        >
                                            Select Host
                                        </Button>
                                    </div>
                                    <Input
                                        value={exportHost?.label || ''}
                                        readOnly
                                        placeholder="Select a host..."
                                        className="bg-muted/50 cursor-pointer"
                                        onClick={() => setShowHostSelector(true)}
                                    />
                                </div>

                                {/* Location field */}
                                <div className="space-y-2">
                                    <Label className="text-muted-foreground">Location ~ $1 *</Label>
                                    <Input
                                        value={exportLocation}
                                        onChange={e => setExportLocation(e.target.value)}
                                        placeholder=".ssh"
                                    />
                                </div>

                                {/* Filename field */}
                                <div className="space-y-2">
                                    <Label className="text-muted-foreground">Filename ~ $2 *</Label>
                                    <Input
                                        value={exportFilename}
                                        onChange={e => setExportFilename(e.target.value)}
                                        placeholder="authorized_keys"
                                    />
                                </div>

                                {/* Info note */}
                                <div className="flex items-start gap-2 p-3 bg-muted/50 border border-border/60 rounded-lg">
                                    <Info size={14} className="mt-0.5 text-muted-foreground shrink-0" />
                                    <p className="text-xs text-muted-foreground">
                                        Key export currently supports only <span className="font-semibold text-foreground">UNIX</span> systems.
                                        Use <span className="font-semibold text-foreground">Advanced</span> section to customize the export script.
                                    </p>
                                </div>

                                {/* Advanced collapsible */}
                                <Collapsible open={exportAdvancedOpen} onOpenChange={setExportAdvancedOpen}>
                                    <CollapsibleTrigger asChild>
                                        <Button variant="ghost" className="w-full justify-between px-0 h-10 hover:bg-transparent hover:text-current">
                                            <span className="font-medium">Advanced</span>
                                            <ChevronRight size={16} className={cn(
                                                "transition-transform",
                                                exportAdvancedOpen && "rotate-90"
                                            )} />
                                        </Button>
                                    </CollapsibleTrigger>
                                    <CollapsibleContent className="space-y-2 pt-2">
                                        <Label className="text-muted-foreground">Script *</Label>
                                        <Textarea
                                            value={exportScript}
                                            onChange={e => setExportScript(e.target.value)}
                                            className="min-h-[180px] font-mono text-xs"
                                            placeholder="Export script..."
                                        />
                                    </CollapsibleContent>
                                </Collapsible>

                                {/* Export button */}
                                <Button
                                    className="w-full h-11"
                                    disabled={!exportHost || !exportLocation || !exportFilename || isExporting}
                                    onClick={async () => {
                                        if (!exportHost || !panel.key.publicKey) return;

                                        setIsExporting(true);
                                        setError('');

                                        try {
                                            // Check for authentication method - prefer password for key export
                                            // Since we're exporting a key to a host, we need password auth
                                            if (!exportHost.password && !exportHost.identityFileId) {
                                                throw new Error('Host has no saved password or key. Please add password credentials to the host first.');
                                            }

                                            // Get private key for authentication if host uses key auth
                                            const hostPrivateKey = exportHost.identityFileId
                                                ? keys.find(k => k.id === exportHost.identityFileId)?.privateKey
                                                : undefined;

                                            // Escape the public key for shell (single quotes, escape existing quotes)
                                            const escapedPublicKey = panel.key.publicKey.replace(/'/g, "'\\''");

                                            // Build the command by replacing $1, $2, $3
                                            const scriptWithVars = exportScript
                                                .replace(/\$1/g, exportLocation)
                                                .replace(/\$2/g, exportFilename)
                                                .replace(/\$3/g, `'${escapedPublicKey}'`);

                                            // Execute the script directly - SSH exec handles multiline commands
                                            const command = scriptWithVars;

                                            // Execute via SSH
                                            const result = await window.nebula?.execCommand({
                                                hostname: exportHost.hostname,
                                                username: exportHost.username,
                                                port: exportHost.port || 22,
                                                password: exportHost.password,
                                                privateKey: hostPrivateKey,
                                                command,
                                                timeout: 30000,
                                            });

                                            // Check result - code 0, null, or undefined with no stderr is success
                                            const exitCode = result?.code;
                                            const hasError = result?.stderr?.trim();
                                            if (exitCode === 0 || (exitCode == null && !hasError)) {
                                                // Update host to use this key for authentication
                                                if (onSaveHost) {
                                                    const updatedHost: Host = {
                                                        ...exportHost,
                                                        identityFileId: panel.key.id,
                                                        authMethod: 'key',
                                                    };
                                                    onSaveHost(updatedHost);
                                                }
                                                toast.success(`Public key exported and attached to ${exportHost.label}`, 'Export Successful');
                                                closePanel();
                                            } else {
                                                const errorMsg = hasError || result?.stdout?.trim() || `Command exited with code ${exitCode}`;
                                                toast.error(`Failed to export key: ${errorMsg}`, 'Export Failed');
                                            }
                                        } catch (err) {
                                            const message = err instanceof Error ? err.message : String(err);
                                            toast.error(`Export failed: ${message}`, 'Export Failed');
                                        } finally {
                                            setIsExporting(false);
                                        }
                                    }}
                                >
                                    {isExporting ? 'Exporting...' : 'Export and Attach'}
                                </Button>
                            </>
                        )}

                        {/* Edit Key Panel */}
                        {panel.type === 'edit' && (
                            <>
                                <div className="space-y-2">
                                    <Label>Label *</Label>
                                    <Input
                                        value={draftKey.label || ''}
                                        onChange={e => setDraftKey({ ...draftKey, label: e.target.value })}
                                        placeholder="Key label"
                                    />
                                </div>

                                <div className="space-y-2">
                                    <Label className="text-destructive">Private key *</Label>
                                    <Textarea
                                        value={draftKey.privateKey || ''}
                                        onChange={e => setDraftKey({ ...draftKey, privateKey: e.target.value })}
                                        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                                        className="min-h-[180px] font-mono text-xs"
                                    />
                                </div>

                                <div className="space-y-2">
                                    <Label className="text-muted-foreground">Public key</Label>
                                    <Textarea
                                        value={draftKey.publicKey || ''}
                                        onChange={e => setDraftKey({ ...draftKey, publicKey: e.target.value })}
                                        placeholder="ssh-ed25519 AAAA..."
                                        className="min-h-[80px] font-mono text-xs"
                                    />
                                </div>

                                <div className="space-y-2">
                                    <Label className="text-muted-foreground">Certificate</Label>
                                    <Textarea
                                        value={draftKey.certificate || ''}
                                        onChange={e => setDraftKey({ ...draftKey, certificate: e.target.value })}
                                        placeholder="Certificate content (optional)"
                                        className="min-h-[60px] font-mono text-xs"
                                    />
                                </div>

                                {/* Key Export section */}
                                <div className="pt-4 mt-4 border-t border-border/60">
                                    <div className="flex items-center gap-2 mb-3">
                                        <span className="text-sm font-medium">Key export</span>
                                        <div className="h-4 w-4 rounded-full bg-muted flex items-center justify-center">
                                            <Info size={10} className="text-muted-foreground" />
                                        </div>
                                    </div>
                                    <Button
                                        className="w-full h-11"
                                        onClick={() => openKeyExport(panel.key)}
                                    >
                                        Export to host
                                    </Button>
                                </div>

                                {/* Save button */}
                                <Button
                                    className="w-full h-11 mt-4"
                                    disabled={!draftKey.label?.trim() || !draftKey.privateKey?.trim()}
                                    onClick={() => {
                                        if (draftKey.id) {
                                            onUpdate({
                                                ...panel.key,
                                                ...draftKey as SSHKey,
                                            });
                                            closePanel();
                                        }
                                    }}
                                >
                                    Save Changes
                                </Button>
                            </>
                        )}
                    </AsidePanelContent>

                    {/* Host Selector Overlay for Export */}
                    {showHostSelector && panel.type === 'export' && (
                        <SelectHostPanel
                            hosts={hosts}
                            customGroups={customGroups}
                            selectedHostIds={exportHost?.id ? [exportHost.id] : []}
                            multiSelect={false}
                            onSelect={(host) => {
                                setExportHost(host);
                                setShowHostSelector(false);
                            }}
                            onBack={() => setShowHostSelector(false)}
                            onContinue={() => setShowHostSelector(false)}
                            availableKeys={keys}
                            onSaveHost={onSaveHost}
                            onCreateGroup={onCreateGroup}
                        />
                    )}
                </AsidePanel>
            )}
        </div>
    );
};

export default KeychainManager;
