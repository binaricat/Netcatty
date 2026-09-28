/**
 * Pure SSH key-type detection for imported keys.
 *
 * Modern OpenSSH private keys ("-----BEGIN OPENSSH PRIVATE KEY-----") store the
 * algorithm name inside the base64 body (RFC 5656 / PROTOCOL.key), so text-only
 * heuristics on the PEM armor misdetect ECDSA keys as ED25519. Decode the base64
 * body and read its public-key algorithm field; fall back to DER OIDs for
 * PKCS#8 / SEC1 PEM bodies, then to the public key's algorithm prefix.
 */

import type { KeyType } from './models';

export interface SshKeyTypeInfo {
    type: KeyType;
    /** RSA: 4096/2048/1024, ECDSA: 521/384/256 */
    keySize?: number;
}

interface CurveInfo {
    name: string;
    keySize: number;
}

const ECDSA_CURVES: CurveInfo[] = [
    { name: 'ecdsa-sha2-nistp256', keySize: 256 },
    { name: 'ecdsa-sha2-nistp384', keySize: 384 },
    { name: 'ecdsa-sha2-nistp521', keySize: 521 },
];

const OPENSSH_ARMOR = 'openssh private key';

// DER OID fragments (id-RSAEncryption 1.2.840.113549.1.1.1, id-ecPublicKey
// 1.2.840.10045.2.1, id-Ed25519 1.3.101.112) as raw byte strings, matched
// against the base64-decoded PEM body.
const RSA_OID = '\u{2a}\u{86}\u{48}\u{86}\u{f7}\u{0d}\u{01}\u{01}\u{01}';
const EC_PUBLIC_KEY_OID = '\u{2a}\u{86}\u{48}\u{ce}\u{3d}\u{02}\u{01}';
const ED25519_OID = '\u{2b}\u{65}\u{70}';

// Named-curve OIDs for id-ecPublicKey parameters (secp256r1/secp384r1/secp521r1).
const EC_CURVE_OIDS: Array<{ oid: string; keySize: number }> = [
    { oid: '\u{2a}\u{86}\u{48}\u{ce}\u{3d}\u{03}\u{01}\u{07}', keySize: 256 },
    { oid: '\u{2b}\u{81}\u{04}\u{00}\u{22}', keySize: 384 },
    { oid: '\u{2b}\u{81}\u{04}\u{00}\u{23}', keySize: 521 },
];

const decodeBase64Body = (pem: string): string | undefined => {
    const body = pem
        .split(/\r?\n/)
        .filter((line) => !line.includes('-----'))
        .join('')
        .replace(/\s+/g, '');
    if (!body) return undefined;
    try {
        return atob(body);
    } catch {
        return undefined;
    }
};

const readSshString = (binary: string, offset: number): { value: string; end: number } | undefined => {
    if (offset + 4 > binary.length) return undefined;
    const length = binary.charCodeAt(offset) * 0x1000000
        + binary.charCodeAt(offset + 1) * 0x10000
        + binary.charCodeAt(offset + 2) * 0x100
        + binary.charCodeAt(offset + 3);
    const end = offset + 4 + length;
    if (end > binary.length) return undefined;
    return { value: binary.slice(offset + 4, end), end };
};

const detectFromOpenSshBody = (binary: string): SshKeyTypeInfo | undefined => {
    const magic = 'openssh-key-v1\0';
    if (!binary.startsWith(magic)) return undefined;
    let offset = magic.length;
    for (let i = 0; i < 3; i++) {
        const field = readSshString(binary, offset); // cipher, KDF, KDF options
        if (!field) return undefined;
        offset = field.end;
    }
    if (offset + 4 > binary.length || binary.slice(offset, offset + 4) === '\0\0\0\0') {
        return undefined; // no public keys
    }
    const publicKey = readSshString(binary, offset + 4);
    const algorithm = publicKey && readSshString(publicKey.value, 0)?.value;
    if (!algorithm) return undefined;
    for (const curve of ECDSA_CURVES) {
        if (algorithm === curve.name) {
            return { type: 'ECDSA', keySize: curve.keySize };
        }
    }
    if (algorithm === 'ssh-ed25519') return { type: 'ED25519' };
    if (algorithm === 'ssh-rsa') return { type: 'RSA' };
    return undefined;
};

const detectFromDerBody = (binary: string): SshKeyTypeInfo | undefined => {
    if (binary.includes(ED25519_OID)) return { type: 'ED25519' };
    if (binary.includes(RSA_OID)) return { type: 'RSA' };
    if (binary.includes(EC_PUBLIC_KEY_OID)) {
        for (const curve of EC_CURVE_OIDS) {
            if (binary.includes(curve.oid)) {
                return { type: 'ECDSA', keySize: curve.keySize };
            }
        }
        return { type: 'ECDSA' };
    }
    return undefined;
};

const detectFromPrivateKey = (privateKey: string): SshKeyTypeInfo | undefined => {
    const pk = privateKey.toLowerCase();

    if (pk.includes(OPENSSH_ARMOR)) {
        const binary = decodeBase64Body(privateKey);
        const fromBlob = binary ? detectFromOpenSshBody(binary) : undefined;
        if (fromBlob) return fromBlob;
    }

    // PKCS#8 / SEC1 PEM bodies have no plaintext algorithm hints; look for DER OIDs.
    if (pk.includes('begin ') && pk.includes('private key')) {
        const binary = decodeBase64Body(privateKey);
        const fromDer = binary ? detectFromDerBody(binary) : undefined;
        if (fromDer) return fromDer;
    }

    // Last-resort plaintext heuristics (legacy PEM armor, PPK comments, ...).
    if (pk.includes('rsa')) return { type: 'RSA' };
    if (pk.includes('ecdsa') || pk.includes('ec ') || pk.includes('ec private')) {
        return { type: 'ECDSA' };
    }
    if (pk.includes('ed25519')) return { type: 'ED25519' };
    return undefined;
};

const detectFromPublicKey = (publicKey: string): SshKeyTypeInfo | undefined => {
    const algorithm = publicKey.trim().split(/\s+/)[0]?.toLowerCase();
    if (!algorithm) return undefined;
    for (const curve of ECDSA_CURVES) {
        if (algorithm.includes(curve.name)) {
            return { type: 'ECDSA', keySize: curve.keySize };
        }
    }
    if (algorithm.includes('ed25519')) return { type: 'ED25519' };
    if (algorithm.includes('rsa')) return { type: 'RSA' };
    return undefined;
};

/**
 * Detect the key type (and key size when known) for an imported SSH key.
 * Private-key evidence wins; the public key is a fallback; defaults to ED25519
 * (ssh-keygen's default) when nothing is recognizable.
 */
export const detectSshKeyType = (
    privateKey?: string | null,
    publicKey?: string | null,
): SshKeyTypeInfo => {
    const fromPrivate = privateKey ? detectFromPrivateKey(privateKey) : undefined;
    if (fromPrivate) return fromPrivate;
    const fromPublic = publicKey ? detectFromPublicKey(publicKey) : undefined;
    return fromPublic ?? { type: 'ED25519' };
};
