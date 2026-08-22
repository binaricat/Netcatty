/**
 * Keychain utility functions
 */

import { BadgeCheck, Key } from 'lucide-react';
import React from 'react';
import { detectFidoSshKeyType } from '../../domain/fidoSsh';
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
 * Resolve vault KeyType from imported key material.
 *
 * Always prefer material detection over the import form's seeded default
 * (`openImport` seeds `type: "ED25519"`). Real OpenSSH sk private PEMs only
 * expose sk-* algorithms after base64 decode — handled by detectFidoSshKeyType.
 */
export const resolveImportedKeyType = (args: {
    privateKey: string;
    publicKey?: string;
}): KeyType => {
    const fidoType = detectFidoSshKeyType({
        publicKey: args.publicKey,
        privateKey: args.privateKey,
    });
    if (fidoType) return fidoType;

    const pkLower = args.privateKey.toLowerCase();
    if (pkLower.includes('rsa')) return 'RSA';
    if (pkLower.includes('ecdsa') || pkLower.includes('ec ')) return 'ECDSA';
    if (pkLower.includes('ed25519')) return 'ED25519';
    return 'ED25519';
};

/**
 * Detect key type from private key content (file drop / paste helpers).
 */
export const detectKeyType = (privateKey: string): KeyType =>
    resolveImportedKeyType({ privateKey });

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

interface IdentitySectionVisibilityOptions {
    identityCount: number;
    filteredIdentityCount: number;
    filteredKeyCount: number;
    search: string;
}

/** Show identities whenever any exist; while searching, keep the section if it matches or nothing matches. */
export const shouldShowIdentitySection = ({
    identityCount,
    filteredIdentityCount,
    filteredKeyCount,
    search,
}: IdentitySectionVisibilityOptions): boolean => {
    if (identityCount === 0) return false;
    if (!search.trim()) return true;

    return filteredIdentityCount > 0 || filteredKeyCount === 0;
};

/**
 * Show keys when any match (or exist while browsing). Hide the empty-key CTA when
 * identities alone already fill the page - including identity-only vaults.
 */
export const shouldShowKeySection = ({
    identityCount,
    filteredKeyCount,
}: Pick<
    IdentitySectionVisibilityOptions,
    'identityCount' | 'filteredKeyCount' | 'search'
>): boolean => {
    return filteredKeyCount > 0 || identityCount === 0;
};

export const shouldShowSearchNoResults = (
    search: string,
    filteredItemCount: number,
    totalItemCount: number,
): boolean => Boolean(search.trim()) && totalItemCount > 0 && filteredItemCount === 0;
