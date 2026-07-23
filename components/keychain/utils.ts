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

interface IdentitySectionVisibilityOptions {
    activeFilter: FilterTab;
    identityCount: number;
    filteredIdentityCount: number;
    filteredKeyCount: number;
    preferredSection?: 'key' | 'identity' | null;
    search: string;
}

export const resolvePreferredKeySection = (
    preferredSection: 'key' | 'identity' | null,
    identityCount: number,
): 'key' | 'identity' => identityCount === 0
    ? 'key'
    : (preferredSection ?? 'identity');

export const shouldShowIdentitySection = ({
    activeFilter,
    identityCount,
    filteredIdentityCount,
    filteredKeyCount,
    preferredSection = null,
    search,
}: IdentitySectionVisibilityOptions): boolean => {
    if (activeFilter !== 'key' || identityCount === 0) return false;
    if (!search.trim()) return resolvePreferredKeySection(preferredSection, identityCount) === 'identity';

    return filteredIdentityCount > 0 || filteredKeyCount === 0;
};

export const shouldShowKeySection = ({
    activeFilter,
    identityCount,
    filteredKeyCount,
    preferredSection = null,
    search,
}: Pick<
    IdentitySectionVisibilityOptions,
    'activeFilter' | 'identityCount' | 'filteredKeyCount' | 'preferredSection' | 'search'
>): boolean => {
    if (activeFilter !== 'key' || identityCount === 0) return true;
    if (!search.trim()) return resolvePreferredKeySection(preferredSection, identityCount) === 'key';

    return filteredKeyCount > 0;
};

export const shouldShowSearchNoResults = (
    search: string,
    filteredItemCount: number,
    totalItemCount: number,
): boolean => Boolean(search.trim()) && totalItemCount > 0 && filteredItemCount === 0;
