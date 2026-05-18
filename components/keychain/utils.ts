/**
 * Keychain utility functions
 */

import { BadgeCheck, Key } from 'lucide-react';
import React from 'react';
import { logger } from '../../lib/logger';
import { KeyType, SSHKey } from '../../types';

/**
 * Get icon element for key source
 */
export const getKeyIcon = (key: SSHKey): React.ReactElement => {
    if (key.certificate) return React.createElement(BadgeCheck, { size: 16 });
    return React.createElement(Key, { size: 16 });
};

/**
 * Get display text for key type
 */
export const getKeyTypeDisplay = (key: SSHKey, isMac: boolean): string => {
    void isMac;
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
    | { type: 'generate'; keyType: 'standard' }
    | { type: 'import' }
    | { type: 'identity'; identity?: import('../../types').Identity }
    | { type: 'export'; key: SSHKey };

// Filter tab types
export type FilterTab = 'key' | 'certificate';
