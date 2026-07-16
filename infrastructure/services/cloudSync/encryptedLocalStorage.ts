export async function encryptLocalStorageValue(value: unknown, key: CryptoKey): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(value));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  let binary = '';
  const chunkSize = 8192;
  for (let offset = 0; offset < combined.length; offset += chunkSize) {
    binary += String.fromCharCode(...combined.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function decryptLocalStorageValue<T>(
  encoded: string,
  key: CryptoKey,
): Promise<T> {
  const combined = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  if (combined.length <= 12) throw new Error('Encrypted local sync record is truncated');
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(decrypted)) as T;
}
