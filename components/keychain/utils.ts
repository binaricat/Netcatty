/**
 * Keychain utility functions and WebAuthn/FIDO2 helpers
 */

import { BadgeCheck,Fingerprint,Key,Shield } from 'lucide-react';
import React from 'react';
import { logger } from '../../lib/logger';
import { KeyType,SSHKey } from '../../types';

const textEncoder = new TextEncoder();

const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
};

const bytesToBase64Url = (bytes: Uint8Array): string => {
    return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const base64UrlToBytes = (b64url: string): Uint8Array => {
    if (typeof b64url !== 'string' || !b64url) return new Uint8Array();
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
};

const writeSshString = (value: string | Uint8Array): Uint8Array => {
    const bytes = typeof value === 'string' ? textEncoder.encode(value) : value;
    const out = new Uint8Array(4 + bytes.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, bytes.length, false);
    out.set(bytes, 4);
    return out;
};

const concatBytes = (...parts: Uint8Array[]): Uint8Array => {
    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
};

type BrowserCreateCredentialFn = NonNullable<
    NetcattyBridge['webauthnCreateCredentialInBrowser']
>;

const getRpIdFromLocation = (): string => {
    const hostname = window.location.hostname;
    // In Electron with file:// protocol, hostname is empty
    // Use 'localhost' as default for WebAuthn compatibility
    if (!hostname || hostname === '') {
        return 'localhost';
    }
    // WebAuthn requires a valid RP ID. IP addresses like 127.0.0.1 are not valid RP IDs.
    // Convert loopback addresses to 'localhost' for WebAuthn compatibility.
    if (
        hostname === '127.0.0.1' ||
        hostname === '0.0.0.0' ||
        hostname === '::1' ||
        hostname === '[::1]'
    ) {
        return 'localhost';
    }
    return hostname;
};

const extractRawP256PublicKey = async (credential: PublicKeyCredential): Promise<Uint8Array> => {
    const response = credential.response as AuthenticatorAttestationResponse;

    // Prefer the native getter when available (Chromium implements this)
    const spki = response.getPublicKey?.();
    if (spki && spki.byteLength > 0) {
        try {
            const cryptoKey = await crypto.subtle.importKey(
                'spki',
                spki,
                { name: 'ECDSA', namedCurve: 'P-256' },
                true,
                ['verify'],
            );
            const raw = await crypto.subtle.exportKey('raw', cryptoKey);
            return new Uint8Array(raw);
        } catch (err) {
            logger.warn('Failed to parse getPublicKey() SPKI, falling back', err);
        }
    }

    // Fallback: derive from COSE key inside the attestation object (minimal CBOR)
    const attestationObject = response.attestationObject;
    if (!attestationObject || attestationObject.byteLength === 0) {
        throw new Error('No attestationObject available to extract public key');
    }

    const decodeCbor = (data: Uint8Array): unknown => {
        // Minimal CBOR decoder for the subset we need (maps, byte strings, text strings, ints)
        let offset = 0;
        const readU8 = () => {
            if (offset >= data.length) throw new Error('CBOR: out of range');
            return data[offset++];
        };
        const readN = (n: number) => {
            if (offset + n > data.length) throw new Error('CBOR: out of range');
            const out = data.subarray(offset, offset + n);
            offset += n;
            return out;
        };
        const readUint = (ai: number): number => {
            if (ai < 24) return ai;
            if (ai === 24) return readU8();
            if (ai === 25) {
                const b = readN(2);
                return (b[0] << 8) | b[1];
            }
            if (ai === 26) {
                const b = readN(4);
                return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
            }
            throw new Error('CBOR: unsupported integer size');
        };
        const readItem = (): unknown => {
            const initial = readU8();
            const major = initial >> 5;
            const ai = initial & 0x1f;

            if (major === 0) return readUint(ai);
            if (major === 1) return -1 - readUint(ai);
            if (major === 2) {
                const len = readUint(ai);
                return readN(len);
            }
            if (major === 3) {
                const len = readUint(ai);
                const strBytes = readN(len);
                return new TextDecoder().decode(strBytes);
            }
            if (major === 4) {
                const len = readUint(ai);
                const arr: unknown[] = [];
                for (let i = 0; i < len; i++) arr.push(readItem());
                return arr;
            }
            if (major === 5) {
                const len = readUint(ai);
                const map = new Map<unknown, unknown>();
                for (let i = 0; i < len; i++) {
                    const k = readItem();
                    const v = readItem();
                    map.set(k, v);
                }
                return map;
            }
            throw new Error(`CBOR: unsupported major type ${major}`);
        };

        return readItem();
    };

    const decoded = decodeCbor(new Uint8Array(attestationObject));
    if (!(decoded instanceof Map)) throw new Error('CBOR: attestationObject is not a map');
    const authData = decoded.get('authData');
    if (!(authData instanceof Uint8Array)) throw new Error('CBOR: missing authData bytes');

    // authData: rpIdHash(32) || flags(1) || signCount(4) || attestedCredData...
    const auth = authData;
    if (auth.length < 37) throw new Error('authData too short');
    const flags = auth[32];
    // Attested credential data present?
    if ((flags & 0x40) === 0) throw new Error('authData missing attested credential data');

    let p = 37;
    // aaguid(16)
    p += 16;
    if (p + 2 > auth.length) throw new Error('authData truncated');
    const credIdLen = (auth[p] << 8) | auth[p + 1];
    p += 2;
    p += credIdLen; // credentialId
    if (p >= auth.length) throw new Error('authData missing credentialPublicKey');

    // credentialPublicKey is a CBOR-encoded COSE_Key
    const coseBytes = auth.subarray(p);
    const coseDecoded = decodeCbor(coseBytes);
    if (!(coseDecoded instanceof Map)) throw new Error('COSE key is not a map');
    const x = coseDecoded.get(-2);
    const y = coseDecoded.get(-3);
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) {
        throw new Error('COSE key missing x/y coordinates');
    }
    if (x.length !== 32 || y.length !== 32) throw new Error('Unexpected COSE x/y length');
    const raw = new Uint8Array(65);
    raw[0] = 0x04;
    raw.set(x, 1);
    raw.set(y, 33);
    return raw;
};

const buildOpenSshSkEcdsaPublicKey = (rawP256: Uint8Array, application: string, comment: string): string => {
    // OpenSSH expects uncompressed EC point for nistp256 (65 bytes: 0x04 || X || Y)
    if (rawP256.length !== 65 || rawP256[0] !== 0x04) {
        throw new Error('Invalid P-256 public key encoding');
    }
    const keyType = 'sk-ecdsa-sha2-nistp256@openssh.com';
    const blob = concatBytes(
        writeSshString(keyType),
        writeSshString('nistp256'),
        writeSshString(rawP256),
        writeSshString(application),
    );
    const b64 = bytesToBase64(blob);
    const safeComment = comment.trim() ? comment.trim() : 'netcatty';
    return `${keyType} ${b64} ${safeComment}`;
};

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
 * Create FIDO2 credential for hardware security key (YubiKey, etc.)
 */
export const createFido2Credential = async (label: string): Promise<{
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

        const rpId = getRpIdFromLocation();

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
                    { alg: -7, type: 'public-key' },     // ES256 (ECDSA P-256)
                    { alg: -257, type: 'public-key' },   // RS256 (RSA)
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

        const credentialId = bytesToBase64Url(new Uint8Array(credential.rawId));
        const rawP256 = await extractRawP256PublicKey(credential);
        const publicKey = buildOpenSshSkEcdsaPublicKey(rawP256, rpId, `${label}@fido2`);

        return {
            credentialId,
            publicKey,
            rpId,
        };
    } catch (error) {
        logger.error('FIDO2 credential creation failed:', error);
        throw error;
    }
};

/**
 * Create biometric credential (Windows Hello / Touch ID)
 */
export const createBiometricCredential = async (
    label: string,
    createCredentialInBrowser?: BrowserCreateCredentialFn,
    onBrowserFallback?: () => void,
): Promise<{
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

        const isMacOS_ =
            navigator.platform.toLowerCase().includes('mac') ||
            navigator.userAgent.toLowerCase().includes('mac');

        // IMPORTANT: Do not await anything before navigator.credentials.create().
        // WebAuthn requires a user gesture; awaiting here can drop the transient activation
        // and cause NotAllowedError without showing the Touch ID prompt.
        const platformAvailablePromise: Promise<boolean | undefined> =
            PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
                .catch((e) => {
                    logger.warn('Platform authenticator availability check failed:', e);
                    return undefined;
                });

        const rpId = getRpIdFromLocation();

        // Helper to use browser fallback for WebAuthn
        const tryBrowserFallback = async (): Promise<{
            credentialId: string;
            publicKey: string;
            rpId: string;
        } | null> => {
            if (typeof createCredentialInBrowser !== 'function') {
                return null;
            }
            logger.info('Using browser WebAuthn helper for biometric credential', {
                rpId,
                origin: window.location.origin,
                isSecureContext: window.isSecureContext,
                label,
            });

            const result = await createCredentialInBrowser({
                rpId,
                name: label,
                displayName: label,
                authenticatorAttachment: 'platform',
                userVerification: 'required',
                timeoutMs: 180000,
            });

            if (!result?.credentialId || !result?.attestationObject) {
                throw new Error('WebAuthn browser flow returned no credential');
            }

            const rawIdBytes = base64UrlToBytes(result.credentialId);
            const attestationObjectBytes = base64UrlToBytes(result.attestationObject);
            const clientDataJSONBytes = base64UrlToBytes(result.clientDataJSON);
            const spkiBytes = base64UrlToBytes(result.publicKeySpki);

            const credential = {
                rawId: rawIdBytes.buffer,
                response: {
                    attestationObject: attestationObjectBytes.buffer,
                    clientDataJSON: clientDataJSONBytes.buffer,
                    getPublicKey:
                        spkiBytes.byteLength > 0 ? () => spkiBytes.buffer : undefined,
                },
            } as unknown as PublicKeyCredential;

            const credentialId = result.credentialId;
            const rawP256 = await extractRawP256PublicKey(credential);
            const publicKey = buildOpenSshSkEcdsaPublicKey(rawP256, rpId, `${label}@biometric`);

            return {
                credentialId,
                publicKey,
                rpId,
            };
        };

        // Electron dev: Chromium's embedded WebAuthn prompt for platform authenticators can be unreliable
        // (or appear behind windows). Prefer the browser helper when available to avoid long hangs/timeouts.
        const shouldPreferBrowserHelperInDev =
            typeof createCredentialInBrowser === 'function' && import.meta.env.DEV;

        if (shouldPreferBrowserHelperInDev) {
            onBrowserFallback?.();
            const fallbackResult = await tryBrowserFallback();
            if (fallbackResult) return fallbackResult;
            throw new Error(
                'WebAuthn browser helper is unavailable. Try a packaged build (electron-builder) and ensure your platform authenticator is enabled in system settings.',
            );
        }

        // Best-effort focus/gesture diagnostics. WebAuthn UI can hang if the window isn't focused
        // or if the transient user activation is lost.
        const hasFocusNow = document.hasFocus?.() ?? undefined;
        const userActivationActive =
            typeof navigator.userActivation?.isActive === 'boolean'
                ? navigator.userActivation.isActive
                : undefined;
        const userActivationHasBeenActive =
            typeof navigator.userActivation?.hasBeenActive === 'boolean'
                ? navigator.userActivation.hasBeenActive
                : undefined;
        if (hasFocusNow === false) {
            try {
                window.focus();
            } catch {
                void 0;
            }
        }

        logger.info('Starting biometric credential creation', {
            rpId,
            origin: window.location.origin,
            isSecureContext: window.isSecureContext,
            hasFocus: hasFocusNow,
            userActivationActive,
            userActivationHasBeenActive,
            label,
        });

        const userId = new TextEncoder().encode(crypto.randomUUID());

        let credential: PublicKeyCredential | null = null;
        const pendingWarn = window.setTimeout(() => {
            logger.warn('WebAuthn navigator.credentials.create() still pending', {
                rpId,
                origin: window.location.origin,
                isSecureContext: window.isSecureContext,
                hasFocus: document.hasFocus?.() ?? undefined,
                userActivationActive:
                    typeof navigator.userActivation?.isActive === 'boolean'
                        ? navigator.userActivation.isActive
                        : undefined,
                userActivationHasBeenActive:
                    typeof navigator.userActivation?.hasBeenActive === 'boolean'
                        ? navigator.userActivation.hasBeenActive
                        : undefined,
            });
        }, 1500);
        const abortController = new AbortController();
        const abortTimer = window.setTimeout(() => {
            abortController.abort();
        }, 185000);
        try {
            credential = await navigator.credentials.create({
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
                        { alg: -7, type: 'public-key' },    // ES256 (ECDSA P-256)
                        { alg: -257, type: 'public-key' },  // RS256 (RSA)
                    ],
                    authenticatorSelection: {
                        authenticatorAttachment: 'platform',
                        residentKey: 'discouraged',
                        // Prefer enforcing verification to actually require Touch ID / Windows Hello
                        userVerification: 'required',
                    },
                    timeout: 180000, // 3 minutes
                    attestation: 'none',
                },
                signal: abortController.signal,
            }) as PublicKeyCredential;
        } catch (error) {
            const platformAvailable = await platformAvailablePromise;
            const deviceName = isMacOS_ ? 'Touch ID' : 'Windows Hello';
            const errName =
                error && typeof error === 'object' && 'name' in error
                    ? String((error as { name?: unknown }).name)
                    : '';

            const errMessage =
                error && typeof error === 'object' && 'message' in error
                    ? String((error as { message?: unknown }).message)
                    : '';

            logger.error('Biometric credential creation failed:', {
                error,
                errName,
                errMessage,
                platformAvailable,
                rpId,
                isSecureContext: window.isSecureContext,
                origin: window.location.origin,
            });

            if (errName === 'NotAllowedError') {
                throw new Error(
                    `${deviceName} request was cancelled or timed out. If your laptop lid is closed (clamshell mode) or the sensor is unavailable, open the lid or try FIDO2.`,
                );
            }
            if (errName === 'NotSupportedError') {
                throw new Error(
                    `No platform authenticator available. Please ensure ${deviceName} is set up in your system settings.`,
                );
            }
            if (errName === 'SecurityError') {
                throw new Error(
                    'WebAuthn blocked by security policy. Ensure the app runs in a secure context and the RP ID is valid for this origin.',
                );
            }
            // AbortError on macOS usually means Touch ID prompt didn't appear (unsigned app).
            // Try browser fallback if available.
            if (errName === 'AbortError' && isMacOS_ && typeof createCredentialInBrowser === 'function') {
                logger.info('AbortError detected, falling back to browser WebAuthn helper');
                // Notify caller that we're using browser fallback
                onBrowserFallback?.();
                const fallbackResult = await tryBrowserFallback();
                if (fallbackResult) {
                    return fallbackResult;
                }
                throw new Error(
                    `${deviceName} prompt did not appear. This is usually a macOS/Electron runtime limitation (e.g. unsigned/unpackaged app). Try running a packaged build (electron-builder) and ensure ${deviceName} is enabled in System Settings.`,
                );
            }
            if (errName === 'AbortError') {
                throw new Error(
                    `${deviceName} prompt did not appear. This is usually a macOS/Electron runtime limitation (e.g. unsigned/unpackaged app). Try running a packaged build (electron-builder) and ensure ${deviceName} is enabled in System Settings.`,
                );
            }

            throw error;
        } finally {
            window.clearTimeout(pendingWarn);
            window.clearTimeout(abortTimer);
        }

        if (!credential) {
            return null;
        }

        const credentialId = bytesToBase64Url(new Uint8Array(credential.rawId));
        const rawP256 = await extractRawP256PublicKey(credential);
        const publicKey = buildOpenSshSkEcdsaPublicKey(rawP256, rpId, `${label}@biometric`);

        return {
            credentialId,
            publicKey,
            rpId,
        };
    } catch (error) {
        logger.error('WebAuthn credential creation failed:', error);
        throw error;
    }
};

/**
 * Get icon element for key source
 */
export const getKeyIcon = (key: SSHKey): React.ReactElement => {
    if (key.source === 'biometric') return React.createElement(Fingerprint, { size: 16 });
    if (key.source === 'fido2') return React.createElement(Shield, { size: 16 });
    if (key.certificate) return React.createElement(BadgeCheck, { size: 16 });
    return React.createElement(Key, { size: 16 });
};

/**
 * Get display text for key type
 */
export const getKeyTypeDisplay = (key: SSHKey, isMac: boolean): string => {
    if (key.source === 'biometric') return isMac ? 'Touch ID' : 'Windows Hello';
    if (key.source === 'fido2') return 'FIDO2';
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
    | { type: 'generate'; keyType: 'standard' | 'biometric' | 'fido2' }
    | { type: 'import' }
    | { type: 'identity'; identity?: import('../../types').Identity }
    | { type: 'export'; key: SSHKey };

// Filter tab types
export type FilterTab = 'key' | 'certificate' | 'biometric' | 'fido2';
