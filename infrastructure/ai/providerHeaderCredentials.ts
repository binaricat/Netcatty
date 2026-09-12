import { isEncryptedCredentialPlaceholder } from '../../domain/credentials';
import { decryptFieldResult, encryptField } from '../persistence/secureFieldAdapter';
import type { ProviderConfig } from './types';

export type HeaderRow = { name: string; value: string };

/** Validate before requests as well as saving. HTTP names are case insensitive. */
export function parseProviderHeaderRows(rows: HeaderRow[]): Record<string, string> {
  const entries: [string, string][] = [];
  const names = new Set<string>();
  for (const row of rows) {
    if (!row.name && !row.value) continue;
    const name = row.name.trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)
      || /[^\t\x20-\x7e\x80-\xff]/.test(row.value)
      || names.has(name.toLowerCase())) {
      throw new Error('Invalid or duplicate HTTP header');
    }
    names.add(name.toLowerCase());
    entries.push([name, row.value]);
  }
  return Object.fromEntries(entries);
}

export async function encryptProviderHeaders(headers: Record<string, string>): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(Object.entries(headers).map(async ([name, value]) => {
    if (!value) return [name, value];
    const encrypted = await encryptField(value);
    // Unlike ordinary settings, never fall back to saving header secrets in plaintext.
    if (!encrypted?.startsWith('enc:v1:') || encrypted === value) {
      throw new Error('Secure header storage is unavailable');
    }
    return [name, encrypted];
  })));
}

export async function decryptProviderHeaders(headers: Record<string, string> = {}): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(Object.entries(headers).map(async ([name, value]) => {
    const result = await decryptFieldResult(value);
    if (result.unread) throw new Error('Unable to decrypt custom HTTP headers');
    return [name, result.value ?? ''];
  })));
}

/** True when a stored header value predates encrypted storage (plaintext secret). */
export function hasLegacyPlaintextHeaderValues(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  return Object.values(headers).some((value) => Boolean(value) && !isEncryptedCredentialPlaceholder(value));
}

/**
 * Encrypt only legacy plaintext header values, leaving existing `enc:v1:`
 * ciphertext untouched so it is never double-encrypted.
 */
async function encryptPlaintextHeaderValues(headers: Record<string, string>): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(Object.entries(headers).map(async ([name, value]) => {
    if (!value || isEncryptedCredentialPlaceholder(value)) return [name, value];
    const encrypted = await encryptField(value);
    // Unlike ordinary settings, never fall back to saving header secrets in plaintext.
    if (!encrypted?.startsWith('enc:v1:') || encrypted === value) {
      throw new Error('Secure header storage is unavailable');
    }
    return [name, encrypted];
  })));
}

/**
 * One-time migration for providers saved before custom headers were stored
 * encrypted. Returns updated providers, or `null` when nothing needs
 * rewriting. When secure storage is unavailable the provider is left
 * unchanged so the migration retries on the next load instead of breaking
 * header usage.
 */
export async function migrateLegacyProviderHeaders(
  providers: ProviderConfig[],
): Promise<ProviderConfig[] | null> {
  if (!providers.some((provider) => hasLegacyPlaintextHeaderValues(provider.customHeaders))) return null;
  const next = await Promise.all(providers.map(async (provider) => {
    if (!hasLegacyPlaintextHeaderValues(provider.customHeaders)) return provider;
    try {
      const encrypted = await encryptPlaintextHeaderValues(provider.customHeaders as Record<string, string>);
      return { ...provider, customHeaders: encrypted };
    } catch {
      // Secure storage unavailable — keep the legacy values usable for now.
      return provider;
    }
  }));
  return next.some((provider, index) => provider !== providers[index]) ? next : null;
}
