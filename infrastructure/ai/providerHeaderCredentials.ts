import { decryptFieldResult, encryptField } from '../persistence/secureFieldAdapter';

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
