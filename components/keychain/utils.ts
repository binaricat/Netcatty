/**
 * Keychain utility functions
 */

import { BadgeCheck, Fingerprint, Key } from 'lucide-react';
import React from 'react';
import { logger } from '../../lib/logger';
import { KeyType, SSHKey } from '../../types';

/**
 * Generate mock key pair (for fallback when Electron backend is unavailable)
 */
export const generateMockKeyPair = (type: KeyType, label: string, keySize?: number): { privateKey: string; publicKey: string } => {
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

/**
 * Get icon element for key source
 */
export const getKeyIcon = (key: SSHKey): React.ReactElement => {
    if (key.source === 'biometric') return React.createElement(Fingerprint, { size: 16 });
    if (key.certificate) return React.createElement(BadgeCheck, { size: 16 });
    return React.createElement(Key, { size: 16 });
};

/**
 * Get display text for key type
 */
export const getKeyTypeDisplay = (key: SSHKey, isMac: boolean): string => {
    if (key.source === 'biometric') return isMac ? 'Touch ID' : 'Windows Hello';
    return key.type;
};

/**
 * Detect key type from private key content
 */
export const detectKeyType = (privateKey: string): KeyType => {
    const pk = privateKey.toLowerCase();
    if (pk.includes('rsa')) return 'RSA';
    if (pk.includes('ecdsa') || pk.includes('ec ')) return 'ECDSA';
    return 'ED25519';
};

/**
 * Copy text to clipboard
 */
export const copyToClipboard = async (text: string): Promise<boolean> => {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (err) {
        logger.error('Failed to copy to clipboard:', err);
        return false;
    }
};

/**
 * Check if running on macOS
 */
export const isMacOS = (): boolean => {
    return navigator.platform.toLowerCase().includes('mac') ||
        navigator.userAgent.toLowerCase().includes('mac');
};

// Panel modes type
export type PanelMode =
    | { type: 'closed' }
    | { type: 'view'; key: SSHKey }
    | { type: 'edit'; key: SSHKey }
    | { type: 'generate'; keyType: 'standard' | 'biometric' }
    | { type: 'import' }
    | { type: 'identity'; identity?: import('../../types').Identity }
    | { type: 'export'; key: SSHKey };

// Filter tab types
export type FilterTab = 'key' | 'certificate' | 'biometric';
