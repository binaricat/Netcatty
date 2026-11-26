import { STORAGE_KEY_KNOWN_REMOTE_DESKTOP_CERTS } from '../../infrastructure/config/storageKeys';
import type { RemoteDesktopProtocol } from '../../domain/remoteDesktop';

// Mirrors LOCAL_STORAGE_ADAPTER_CHANGED_EVENT from infrastructure/persistence/localStorageAdapter.ts
// without violating the component -> infrastructure/persistence lint boundary.
const LOCAL_STORAGE_CHANGED_EVENT = 'netcatty:local-storage-adapter-changed';

function dispatchKnownCertsChanged(): void {
  try {
    const target = globalThis as typeof globalThis & {
      dispatchEvent?: (event: Event) => boolean;
      CustomEvent?: typeof CustomEvent;
    };
    if (typeof target.dispatchEvent !== 'function' || typeof target.CustomEvent !== 'function') {
      return;
    }
    target.dispatchEvent(
      new target.CustomEvent<{ key: string }>(LOCAL_STORAGE_CHANGED_EVENT, {
        detail: { key: STORAGE_KEY_KNOWN_REMOTE_DESKTOP_CERTS },
      }),
    );
  } catch {
    // Ignore environments without CustomEvent/dispatchEvent support
  }
}

function readRawStorage(key: string): unknown {
  if (typeof globalThis === 'undefined' || !('localStorage' in globalThis)) return null;
  try {
    const raw = globalThis.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeRawStorage(key: string, value: unknown): void {
  if (typeof globalThis === 'undefined' || !('localStorage' in globalThis)) return;
  try {
    globalThis.localStorage.setItem(key, JSON.stringify(value));
    dispatchKnownCertsChanged();
  } catch {
    // Ignore quota / private mode storage errors
  }
}

export interface KnownRemoteDesktopCertRecord {
  fingerprintSha256: string;
  subject?: string;
  issuer?: string;
  validFrom?: string;
  validTo?: string;
  trustedAt: number;
  lastSeenAt: number;
}

export interface KnownRemoteDesktopCertEntry extends KnownRemoteDesktopCertRecord {
  key: string;
  protocol: RemoteDesktopProtocol;
  host: string;
  port: number;
}

export type RemoteDesktopCertMap = Record<string, KnownRemoteDesktopCertRecord>;

export type RemoteDesktopCertVerificationResult =
  | { status: 'trusted'; previousFingerprint: string }
  | { status: 'first-seen'; previousFingerprint: null }
  | { status: 'changed'; previousFingerprint: string };

/**
 * Normalize a SHA-256 certificate fingerprint into canonical uppercase
 * colon-separated hex (e.g. `AA:BB:CC:...`) so comparisons are format-invariant.
 */
export function normalizeCertFingerprint(fingerprint: string): string {
  const cleaned = fingerprint
    .trim()
    .replace(/^sha-?256:/i, '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toUpperCase();
  if (!cleaned) return '';
  if (cleaned.length % 2 === 0) {
    const pairs: string[] = [];
    for (let i = 0; i < cleaned.length; i += 2) {
      pairs.push(cleaned.slice(i, i + 2));
    }
    return pairs.join(':');
  }
  return cleaned;
}

export function getRemoteDesktopCertKey(
  protocol: RemoteDesktopProtocol,
  host: string,
  port: number,
): string {
  const normalizedHost = host.trim().toLowerCase();
  const normalizedPort = Number.isInteger(port) && port > 0 ? port : (protocol === 'rdp' ? 3389 : 5900);
  return `${protocol}:${normalizedHost}:${normalizedPort}`;
}

/**
 * Parse a `protocol:host:port` key into structured fields safely, preserving
 * colons inside IPv6 literals (e.g. `rdp:::1:3389` or `rdp:[fe80::1]:3389`).
 */
export function parseRemoteDesktopCertKey(
  key: string,
): { protocol: RemoteDesktopProtocol; host: string; port: number } | null {
  if (typeof key !== 'string') return null;
  const firstColon = key.indexOf(':');
  const lastColon = key.lastIndexOf(':');
  if (firstColon <= 0 || lastColon <= firstColon + 1 || lastColon >= key.length - 1) {
    return null;
  }
  const rawProtocol = key.slice(0, firstColon).toLowerCase();
  if (rawProtocol !== 'rdp' && rawProtocol !== 'vnc') {
    return null;
  }
  const host = key.slice(firstColon + 1, lastColon).trim();
  if (!host) return null;
  const portStr = key.slice(lastColon + 1);
  if (!/^\d{1,5}$/.test(portStr)) return null;
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    protocol: rawProtocol,
    host,
    port,
  };
}

export function readKnownRemoteDesktopCerts(): RemoteDesktopCertMap {
  const raw = readRawStorage(STORAGE_KEY_KNOWN_REMOTE_DESKTOP_CERTS);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const result: RemoteDesktopCertMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const rec = value as Record<string, unknown>;
    if (typeof rec.fingerprintSha256 !== 'string') continue;
    const normalizedFp = normalizeCertFingerprint(rec.fingerprintSha256);
    if (!normalizedFp) continue;
    result[key] = {
      fingerprintSha256: normalizedFp,
      ...(typeof rec.subject === 'string' && rec.subject ? { subject: rec.subject } : {}),
      ...(typeof rec.issuer === 'string' && rec.issuer ? { issuer: rec.issuer } : {}),
      ...(typeof rec.validFrom === 'string' && rec.validFrom ? { validFrom: rec.validFrom } : {}),
      ...(typeof rec.validTo === 'string' && rec.validTo ? { validTo: rec.validTo } : {}),
      trustedAt: typeof rec.trustedAt === 'number' && Number.isFinite(rec.trustedAt) ? rec.trustedAt : 0,
      lastSeenAt: typeof rec.lastSeenAt === 'number' && Number.isFinite(rec.lastSeenAt) ? rec.lastSeenAt : 0,
    };
  }
  return result;
}

function writeKnownRemoteDesktopCerts(map: RemoteDesktopCertMap): void {
  writeRawStorage(STORAGE_KEY_KNOWN_REMOTE_DESKTOP_CERTS, map);
}

export function listKnownRemoteDesktopCerts(): KnownRemoteDesktopCertEntry[] {
  const all = readKnownRemoteDesktopCerts();
  const entries: KnownRemoteDesktopCertEntry[] = [];
  for (const [key, record] of Object.entries(all)) {
    const parsed = parseRemoteDesktopCertKey(key);
    if (!parsed) continue;
    entries.push({
      key,
      protocol: parsed.protocol,
      host: parsed.host,
      port: parsed.port,
      ...record,
    });
  }
  entries.sort((a, b) => (b.trustedAt - a.trustedAt) || a.host.localeCompare(b.host));
  return entries;
}

export function getKnownRemoteDesktopCert(
  protocol: RemoteDesktopProtocol,
  host: string,
  port: number,
): KnownRemoteDesktopCertRecord | null {
  const key = getRemoteDesktopCertKey(protocol, host, port);
  const all = readKnownRemoteDesktopCerts();
  return all[key] ?? null;
}

export function getKnownRemoteDesktopFingerprints(
  protocol: RemoteDesktopProtocol,
  host: string,
  port: number,
): string[] {
  const existing = getKnownRemoteDesktopCert(protocol, host, port);
  return existing ? [existing.fingerprintSha256] : [];
}

export function verifyKnownRemoteDesktopCert(
  protocol: RemoteDesktopProtocol,
  host: string,
  port: number,
  fingerprintSha256: string,
): RemoteDesktopCertVerificationResult {
  const normalizedIncoming = normalizeCertFingerprint(fingerprintSha256);
  const existing = getKnownRemoteDesktopCert(protocol, host, port);
  if (!existing) {
    return { status: 'first-seen', previousFingerprint: null };
  }
  if (normalizedIncoming && existing.fingerprintSha256 === normalizedIncoming) {
    return { status: 'trusted', previousFingerprint: existing.fingerprintSha256 };
  }
  return { status: 'changed', previousFingerprint: existing.fingerprintSha256 };
}

export function trustKnownRemoteDesktopCert(
  protocol: RemoteDesktopProtocol,
  host: string,
  port: number,
  info: {
    fingerprintSha256: string;
    subject?: string;
    issuer?: string;
    validFrom?: string;
    validTo?: string;
  },
  now = Date.now(),
): KnownRemoteDesktopCertRecord | null {
  const normalizedFp = normalizeCertFingerprint(info.fingerprintSha256);
  if (!normalizedFp) return null;
  const key = getRemoteDesktopCertKey(protocol, host, port);
  const all = readKnownRemoteDesktopCerts();
  const prev = all[key];
  const sameFingerprint = Boolean(prev && prev.fingerprintSha256 === normalizedFp);
  const subject = info.subject || (sameFingerprint ? prev?.subject : undefined);
  const issuer = info.issuer || (sameFingerprint ? prev?.issuer : undefined);
  const validFrom = info.validFrom || (sameFingerprint ? prev?.validFrom : undefined);
  const validTo = info.validTo || (sameFingerprint ? prev?.validTo : undefined);
  const record: KnownRemoteDesktopCertRecord = {
    fingerprintSha256: normalizedFp,
    ...(subject ? { subject } : {}),
    ...(issuer ? { issuer } : {}),
    ...(validFrom ? { validFrom } : {}),
    ...(validTo ? { validTo } : {}),
    trustedAt: sameFingerprint && prev ? prev.trustedAt : now,
    lastSeenAt: now,
  };
  all[key] = record;
  writeKnownRemoteDesktopCerts(all);
  return record;
}

export function removeKnownRemoteDesktopCert(
  protocol: RemoteDesktopProtocol,
  host: string,
  port: number,
): boolean {
  const key = getRemoteDesktopCertKey(protocol, host, port);
  return removeKnownRemoteDesktopCertByKey(key);
}

export function removeKnownRemoteDesktopCertByKey(key: string): boolean {
  const all = readKnownRemoteDesktopCerts();
  if (!(key in all)) return false;
  delete all[key];
  writeKnownRemoteDesktopCerts(all);
  return true;
}

export function clearAllKnownRemoteDesktopCerts(): number {
  const all = readKnownRemoteDesktopCerts();
  const count = Object.keys(all).length;
  if (count === 0) return 0;
  writeKnownRemoteDesktopCerts({});
  return count;
}

export function subscribeKnownRemoteDesktopCerts(listener: () => void): () => void {
  const target = globalThis as typeof globalThis & {
    addEventListener?: (type: string, listener: EventListener) => void;
    removeEventListener?: (type: string, listener: EventListener) => void;
  };
  if (typeof target.addEventListener !== 'function' || typeof target.removeEventListener !== 'function') {
    return () => {};
  }

  const handleStorage: EventListener = (event) => {
    const storageEvent = event as StorageEvent;
    if (storageEvent.key === STORAGE_KEY_KNOWN_REMOTE_DESKTOP_CERTS || storageEvent.key === null) {
      listener();
    }
  };

  const handleAdapterChanged: EventListener = (event) => {
    const detail = (event as CustomEvent<{ key?: string }>).detail;
    if (!detail?.key || detail.key === STORAGE_KEY_KNOWN_REMOTE_DESKTOP_CERTS) {
      listener();
    }
  };

  target.addEventListener('storage', handleStorage);
  target.addEventListener(LOCAL_STORAGE_CHANGED_EVENT, handleAdapterChanged);

  return () => {
    target.removeEventListener?.('storage', handleStorage);
    target.removeEventListener?.(LOCAL_STORAGE_CHANGED_EVENT, handleAdapterChanged);
  };
}
