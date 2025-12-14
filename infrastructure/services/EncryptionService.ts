/**
 * EncryptionService - Zero-Knowledge Encryption for Cloud Sync
 * 
 * Implements AES-256-GCM encryption with PBKDF2 key derivation.
 * All encryption/decryption happens client-side; cloud providers never see plaintext.
 * 
 * Security Model:
 * - Master password → PBKDF2 (600k iterations) → AES-256 key
 * - Each sync file has unique IV and salt
 * - Key verification via hash comparison (not by storing the key)
 */

import {
  SYNC_CONSTANTS,
  type EncryptionResult,
  type DecryptionInput,
  type MasterKeyConfig,
  type UnlockedMasterKey,
  type SyncedFile,
  type SyncFileMeta,
  type SyncPayload,
} from '../../domain/sync';

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Convert Uint8Array to ArrayBuffer for Web Crypto API compatibility
 * TypeScript 5.x requires explicit conversion from Uint8Array<ArrayBufferLike> to BufferSource
 */
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

/**
 * Convert ArrayBuffer to Base64 string
 */
export const arrayBufferToBase64 = (buffer: ArrayBuffer | Uint8Array): string => {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

/**
 * Convert Base64 string to Uint8Array
 */
export const base64ToUint8Array = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

/**
 * Generate cryptographically secure random bytes
 */
export const generateRandomBytes = (length: number): Uint8Array => {
  return crypto.getRandomValues(new Uint8Array(length));
};

/**
 * Compute SHA-256 hash of data
 */
export const sha256 = async (data: Uint8Array): Promise<Uint8Array> => {
  const hashBuffer = await crypto.subtle.digest('SHA-256', toArrayBuffer(data));
  return new Uint8Array(hashBuffer);
};

/**
 * Convert string to Uint8Array using UTF-8 encoding
 */
const stringToBytes = (str: string): Uint8Array => {
  return new TextEncoder().encode(str);
};

/**
 * Convert Uint8Array to string using UTF-8 decoding
 */
const bytesToString = (bytes: Uint8Array): string => {
  return new TextDecoder().decode(bytes);
};

// ============================================================================
// Key Derivation
// ============================================================================

/**
 * Derive an AES-256 key from password using PBKDF2
 * 
 * @param password - User's master password
 * @param salt - Random salt (32 bytes recommended)
 * @param iterations - PBKDF2 iterations (600000 recommended)
 * @returns CryptoKey suitable for AES-256-GCM operations
 */
export const deriveKey = async (
  password: string,
  salt: Uint8Array,
  iterations: number = SYNC_CONSTANTS.PBKDF2_ITERATIONS
): Promise<CryptoKey> => {
  // Import password as key material
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(stringToBytes(password)),
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  );

  // Derive AES key using PBKDF2
  const derivedKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: toArrayBuffer(salt),
      iterations: iterations,
      hash: SYNC_CONSTANTS.PBKDF2_HASH,
    },
    passwordKey,
    {
      name: 'AES-GCM',
      length: SYNC_CONSTANTS.AES_KEY_LENGTH,
    },
    true, // extractable for verification
    ['encrypt', 'decrypt']
  );

  return derivedKey;
};

/**
 * Export CryptoKey to raw bytes for verification purposes
 */
export const exportKey = async (key: CryptoKey): Promise<Uint8Array> => {
  const exported = await crypto.subtle.exportKey('raw', key);
  return new Uint8Array(exported);
};

/**
 * Create a verification hash from derived key
 * Used to verify correct password without storing the key
 */
export const createVerificationHash = async (derivedKey: CryptoKey): Promise<string> => {
  const keyBytes = await exportKey(derivedKey);
  const hash = await sha256(keyBytes);
  return arrayBufferToBase64(hash);
};

/**
 * Verify that a password produces the expected verification hash
 */
export const verifyPassword = async (
  password: string,
  config: MasterKeyConfig
): Promise<boolean> => {
  try {
    const salt = base64ToUint8Array(config.salt);
    const derivedKey = await deriveKey(
      password,
      salt,
      config.kdfIterations || SYNC_CONSTANTS.PBKDF2_ITERATIONS
    );
    const hash = await createVerificationHash(derivedKey);
    return hash === config.verificationHash;
  } catch {
    return false;
  }
};

// ============================================================================
// Encryption / Decryption
// ============================================================================

/**
 * Encrypt plaintext using AES-256-GCM
 * 
 * @param plaintext - Data to encrypt (as string)
 * @param key - AES-256 CryptoKey
 * @param salt - Salt used for key derivation (stored in result)
 * @returns Encrypted data with IV
 */
export const encrypt = async (
  plaintext: string,
  key: CryptoKey,
  salt: Uint8Array
): Promise<EncryptionResult> => {
  // Generate random IV
  const iv = generateRandomBytes(SYNC_CONSTANTS.GCM_IV_LENGTH);

  // Encrypt
  const ciphertextBuffer = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(iv),
      tagLength: SYNC_CONSTANTS.GCM_TAG_LENGTH,
    },
    key,
    toArrayBuffer(stringToBytes(plaintext))
  );

  return {
    ciphertext: new Uint8Array(ciphertextBuffer),
    iv: iv,
    salt: salt,
    algorithm: 'AES-256-GCM',
    kdf: 'PBKDF2',
    kdfIterations: SYNC_CONSTANTS.PBKDF2_ITERATIONS,
  };
};

/**
 * Decrypt ciphertext using AES-256-GCM
 * 
 * @param input - Encrypted data with IV
 * @param key - AES-256 CryptoKey
 * @returns Decrypted plaintext
 */
export const decrypt = async (
  input: DecryptionInput,
  key: CryptoKey
): Promise<string> => {
  const plaintextBuffer = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(input.iv),
      tagLength: SYNC_CONSTANTS.GCM_TAG_LENGTH,
    },
    key,
    toArrayBuffer(input.ciphertext)
  );

  return bytesToString(new Uint8Array(plaintextBuffer));
};

// ============================================================================
// High-Level Encryption API
// ============================================================================

/**
 * Encrypt a sync payload to create a SyncedFile
 * 
 * @param payload - Data to encrypt
 * @param password - Master password
 * @param deviceId - Device identifier
 * @param appVersion - App version string
 * @returns Complete SyncedFile ready for upload
 */
export const encryptPayload = async (
  payload: SyncPayload,
  password: string,
  deviceId: string,
  deviceName: string,
  appVersion: string,
  existingVersion?: number
): Promise<SyncedFile> => {
  // Generate new salt for each encryption
  const salt = generateRandomBytes(SYNC_CONSTANTS.SALT_LENGTH);
  
  // Derive key from password
  const key = await deriveKey(password, salt);
  
  // Encrypt the payload
  const plaintext = JSON.stringify(payload);
  const encrypted = await encrypt(plaintext, key, salt);
  
  // Create metadata
  const meta: SyncFileMeta = {
    version: (existingVersion || 0) + 1,
    updatedAt: Date.now(),
    deviceId: deviceId,
    deviceName: deviceName,
    appVersion: appVersion,
    iv: arrayBufferToBase64(encrypted.iv),
    salt: arrayBufferToBase64(encrypted.salt),
    algorithm: 'AES-256-GCM',
    kdf: 'PBKDF2',
    kdfIterations: SYNC_CONSTANTS.PBKDF2_ITERATIONS,
  };

  return {
    meta,
    payload: arrayBufferToBase64(encrypted.ciphertext),
  };
};

/**
 * Decrypt a SyncedFile to retrieve the payload
 * 
 * @param syncedFile - Encrypted file from cloud
 * @param password - Master password
 * @returns Decrypted payload
 */
export const decryptPayload = async (
  syncedFile: SyncedFile,
  password: string
): Promise<SyncPayload> => {
  const { meta, payload } = syncedFile;
  
  // Decode Base64 values
  const salt = base64ToUint8Array(meta.salt);
  const iv = base64ToUint8Array(meta.iv);
  const ciphertext = base64ToUint8Array(payload);
  
  // Derive key from password
  const key = await deriveKey(
    password,
    salt,
    meta.kdfIterations || SYNC_CONSTANTS.PBKDF2_ITERATIONS
  );
  
  // Decrypt
  const decrypted = await decrypt(
    { ciphertext, iv, salt, kdf: meta.kdf, kdfIterations: meta.kdfIterations },
    key
  );
  
  return JSON.parse(decrypted) as SyncPayload;
};

/**
 * Verify a SyncedFile can be decrypted with given password
 * Does not return the payload, just validates the password
 */
export const verifySyncedFile = async (
  syncedFile: SyncedFile,
  password: string
): Promise<boolean> => {
  try {
    await decryptPayload(syncedFile, password);
    return true;
  } catch {
    return false;
  }
};

// ============================================================================
// Master Key Management
// ============================================================================

/**
 * Create a new master key configuration
 * 
 * @param password - User's master password
 * @returns Configuration to store (contains verification hash, not the key)
 */
export const createMasterKeyConfig = async (
  password: string
): Promise<MasterKeyConfig> => {
  const salt = generateRandomBytes(SYNC_CONSTANTS.SALT_LENGTH);
  const key = await deriveKey(password, salt);
  const verificationHash = await createVerificationHash(key);

  return {
    verificationHash,
    salt: arrayBufferToBase64(salt),
    kdf: 'PBKDF2',
    kdfIterations: SYNC_CONSTANTS.PBKDF2_ITERATIONS,
    createdAt: Date.now(),
    biometricEnabled: false,
  };
};

/**
 * Unlock the master key and return it for use
 * 
 * @param password - User's master password
 * @param config - Stored master key configuration
 * @returns Unlocked key state (keep in memory only!)
 */
export const unlockMasterKey = async (
  password: string,
  config: MasterKeyConfig
): Promise<UnlockedMasterKey | null> => {
  const isValid = await verifyPassword(password, config);
  if (!isValid) return null;

  const salt = base64ToUint8Array(config.salt);
  const derivedKey = await deriveKey(
    password,
    salt,
    config.kdfIterations || SYNC_CONSTANTS.PBKDF2_ITERATIONS
  );

  return {
    derivedKey,
    salt,
    unlockedAt: Date.now(),
  };
};

/**
 * Change master password
 * Requires re-encrypting all synced data with new password
 * 
 * @param oldPassword - Current master password
 * @param newPassword - New master password
 * @param config - Current master key configuration
 * @returns New configuration, or null if old password is wrong
 */
export const changeMasterPassword = async (
  oldPassword: string,
  newPassword: string,
  config: MasterKeyConfig
): Promise<MasterKeyConfig | null> => {
  // Verify old password first
  const isValid = await verifyPassword(oldPassword, config);
  if (!isValid) return null;

  // Create new configuration with new password
  return createMasterKeyConfig(newPassword);
};

// ============================================================================
// Biometric Key Storage (via Electron safeStorage)
// ============================================================================

/**
 * Encrypt master password for biometric storage
 * Uses a random encryption key stored in safeStorage
 */
export const encryptForBiometric = async (
  password: string
): Promise<{ encrypted: string; key: string }> => {
  const key = generateRandomBytes(32);
  const iv = generateRandomBytes(SYNC_CONSTANTS.GCM_IV_LENGTH);
  
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(key),
    'AES-GCM',
    false,
    ['encrypt']
  );
  
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), tagLength: SYNC_CONSTANTS.GCM_TAG_LENGTH },
    cryptoKey,
    toArrayBuffer(stringToBytes(password))
  );
  
  // Combine IV and ciphertext
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  
  return {
    encrypted: arrayBufferToBase64(combined),
    key: arrayBufferToBase64(key),
  };
};

/**
 * Decrypt master password from biometric storage
 */
export const decryptFromBiometric = async (
  encrypted: string,
  keyBase64: string
): Promise<string> => {
  const combined = base64ToUint8Array(encrypted);
  const key = base64ToUint8Array(keyBase64);
  
  const iv = combined.slice(0, SYNC_CONSTANTS.GCM_IV_LENGTH);
  const ciphertext = combined.slice(SYNC_CONSTANTS.GCM_IV_LENGTH);
  
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(key),
    'AES-GCM',
    false,
    ['decrypt']
  );
  
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), tagLength: SYNC_CONSTANTS.GCM_TAG_LENGTH },
    cryptoKey,
    toArrayBuffer(ciphertext)
  );
  
  return bytesToString(new Uint8Array(plaintext));
};

// ============================================================================
// Export Service Class
// ============================================================================

/**
 * EncryptionService class - stateless encryption operations
 */
export class EncryptionService {
  static deriveKey = deriveKey;
  static encrypt = encrypt;
  static decrypt = decrypt;
  static encryptPayload = encryptPayload;
  static decryptPayload = decryptPayload;
  static createMasterKeyConfig = createMasterKeyConfig;
  static unlockMasterKey = unlockMasterKey;
  static changeMasterPassword = changeMasterPassword;
  static verifyPassword = verifyPassword;
  static createVerificationHash = createVerificationHash;
  static encryptForBiometric = encryptForBiometric;
  static decryptFromBiometric = decryptFromBiometric;
  static generateRandomBytes = generateRandomBytes;
  static arrayBufferToBase64 = arrayBufferToBase64;
  static base64ToUint8Array = base64ToUint8Array;
}

export default EncryptionService;
