import { STORAGE_KEY_REMOTE_DESKTOP_SHARED_FOLDERS } from '../config/storageKeys';
import { localStorageAdapter } from '../persistence/localStorageAdapter';

export const MIN_RDPDR_SHARED_DRIVE_DEVICE_ID = 10;

export interface RemoteDesktopSharedFolder {
  id: string;
  deviceId: number;
  name: string;
  path: string;
  readOnly: boolean;
}

export interface AddRemoteDesktopSharedFolderInput {
  name?: string;
  path: string;
  readOnly?: boolean;
}

export interface AddRemoteDesktopSharedFolderResult {
  folders: RemoteDesktopSharedFolder[];
  added: RemoteDesktopSharedFolder | null;
  duplicate?: boolean;
}

type StoredSharedFoldersMap = Record<string, RemoteDesktopSharedFolder[]>;

function hasLocalStorage(): boolean {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    return Boolean(storage && typeof storage.getItem === 'function');
  } catch {
    return false;
  }
}

function normalizeFolderPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return '';
  if (trimmed === '/' || /^[A-Za-z]:\\?$/.test(trimmed)) return trimmed;
  return trimmed.replace(/[\\/]+$/, '');
}

function sanitizeShareName(rawName: string | undefined, folderPath: string): string {
  const candidate = (rawName ?? '').trim();
  const base = candidate || folderPath.split(/[\\/]/).filter(Boolean).pop() || 'Shared';
  let stripped = '';
  for (const ch of base) {
    const code = ch.charCodeAt(0);
    stripped += code < 0x20 ? '_' : ch;
  }
  const cleaned = stripped
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  const truncated = cleaned.slice(0, 48).trim();
  return truncated || 'Shared';
}

function isValidStoredFolder(value: unknown): value is RemoteDesktopSharedFolder {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.id === 'string'
    && rec.id.trim().length > 0
    && typeof rec.deviceId === 'number'
    && Number.isInteger(rec.deviceId)
    && rec.deviceId >= MIN_RDPDR_SHARED_DRIVE_DEVICE_ID
    && typeof rec.name === 'string'
    && rec.name.trim().length > 0
    && typeof rec.path === 'string'
    && rec.path.trim().length > 0
    && typeof rec.readOnly === 'boolean'
  );
}

function readAllSharedFoldersMap(): StoredSharedFoldersMap {
  if (!hasLocalStorage()) return {};
  const raw = localStorageAdapter.read<unknown>(STORAGE_KEY_REMOTE_DESKTOP_SHARED_FOLDERS);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: StoredSharedFoldersMap = {};
  for (const [hostId, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!hostId || !Array.isArray(list)) continue;
    const seenIds = new Set<number>();
    const valid: RemoteDesktopSharedFolder[] = [];
    for (const item of list) {
      if (!isValidStoredFolder(item)) continue;
      if (seenIds.has(item.deviceId)) continue;
      seenIds.add(item.deviceId);
      valid.push({
        id: item.id,
        deviceId: item.deviceId,
        name: sanitizeShareName(item.name, item.path),
        path: normalizeFolderPath(item.path),
        readOnly: Boolean(item.readOnly),
      });
    }
    if (valid.length > 0) {
      result[hostId] = valid;
    }
  }
  return result;
}

function writeAllSharedFoldersMap(map: StoredSharedFoldersMap): void {
  if (!hasLocalStorage()) return;
  try {
    if (Object.keys(map).length === 0) {
      localStorageAdapter.remove(STORAGE_KEY_REMOTE_DESKTOP_SHARED_FOLDERS);
      return;
    }
    localStorageAdapter.write(STORAGE_KEY_REMOTE_DESKTOP_SHARED_FOLDERS, map);
  } catch {
    // Never let local storage failures break remote desktop sessions.
  }
}

/**
 * Allocate the next available unique RDPDR drive deviceId (>= 10, avoiding the
 * default printer deviceId = 2 and reserved low IDs).
 */
export function allocateNextSharedDriveDeviceId(
  existing: readonly Pick<RemoteDesktopSharedFolder, 'deviceId'>[],
): number {
  const used = new Set<number>();
  for (const item of existing) {
    if (typeof item.deviceId === 'number' && Number.isInteger(item.deviceId)) {
      used.add(item.deviceId);
    }
  }
  let candidate = MIN_RDPDR_SHARED_DRIVE_DEVICE_ID;
  while (used.has(candidate)) {
    candidate += 1;
  }
  return candidate;
}

/**
 * Load device-local shared folders configured for a given RDP host.
 */
export function loadRemoteDesktopSharedFolders(hostId: string): RemoteDesktopSharedFolder[] {
  if (!hostId) return [];
  const map = readAllSharedFoldersMap();
  return map[hostId] ? [...map[hostId]] : [];
}

/**
 * Persist device-local shared folders for a given RDP host.
 */
export function saveRemoteDesktopSharedFolders(
  hostId: string,
  folders: readonly RemoteDesktopSharedFolder[],
): RemoteDesktopSharedFolder[] {
  if (!hostId) return [];
  const map = readAllSharedFoldersMap();
  const normalized: RemoteDesktopSharedFolder[] = [];
  const usedDeviceIds = new Set<number>();
  const usedPaths = new Set<string>();

  for (const folder of folders) {
    const cleanPath = normalizeFolderPath(folder.path);
    if (!cleanPath || usedPaths.has(cleanPath)) continue;
    usedPaths.add(cleanPath);
    let deviceId = Number.isInteger(folder.deviceId) && folder.deviceId >= MIN_RDPDR_SHARED_DRIVE_DEVICE_ID
      ? folder.deviceId
      : allocateNextSharedDriveDeviceId(normalized);
    while (usedDeviceIds.has(deviceId)) {
      deviceId += 1;
    }
    usedDeviceIds.add(deviceId);
    normalized.push({
      id: folder.id?.trim() || `rdpdr-${deviceId}-${Date.now().toString(36)}`,
      deviceId,
      name: sanitizeShareName(folder.name, cleanPath),
      path: cleanPath,
      readOnly: Boolean(folder.readOnly),
    });
  }

  if (normalized.length === 0) {
    delete map[hostId];
  } else {
    map[hostId] = normalized;
  }
  writeAllSharedFoldersMap(map);
  return normalized;
}

/**
 * Add a local folder mapping for an RDP host, assigning a unique deviceId >= 10.
 * Duplicate normalized paths are ignored cleanly.
 */
export function addRemoteDesktopSharedFolder(
  hostId: string,
  input: AddRemoteDesktopSharedFolderInput,
): AddRemoteDesktopSharedFolderResult {
  const existing = loadRemoteDesktopSharedFolders(hostId);
  const cleanPath = normalizeFolderPath(input.path);
  if (!hostId || !cleanPath) {
    return { folders: existing, added: null };
  }
  if (existing.some((item) => normalizeFolderPath(item.path) === cleanPath)) {
    return { folders: existing, added: null, duplicate: true };
  }
  const deviceId = allocateNextSharedDriveDeviceId(existing);
  const baseName = sanitizeShareName(input.name, cleanPath);
  const existingNames = new Set(existing.map((f) => f.name.toLowerCase()));
  let uniqueName = baseName;
  let suffix = 2;
  while (existingNames.has(uniqueName.toLowerCase())) {
    uniqueName = `${baseName.slice(0, 44)}_${suffix}`;
    suffix += 1;
  }

  const entry: RemoteDesktopSharedFolder = {
    id: `rdpdr-${deviceId}-${Date.now().toString(36)}`,
    deviceId,
    name: uniqueName,
    path: cleanPath,
    readOnly: Boolean(input.readOnly),
  };
  const next = saveRemoteDesktopSharedFolders(hostId, [...existing, entry]);
  return { folders: next, added: entry };
}

/**
 * Remove a shared folder mapping by `id` or `deviceId`.
 */
export function removeRemoteDesktopSharedFolder(
  hostId: string,
  folderIdOrDeviceId: string | number,
): RemoteDesktopSharedFolder[] {
  const existing = loadRemoteDesktopSharedFolders(hostId);
  const next = existing.filter((item) => (
    typeof folderIdOrDeviceId === 'number'
      ? item.deviceId !== folderIdOrDeviceId
      : item.id !== folderIdOrDeviceId
  ));
  return saveRemoteDesktopSharedFolders(hostId, next);
}

/**
 * Update mutable properties (`readOnly` / `name`) on an existing shared folder.
 */
export function updateRemoteDesktopSharedFolder(
  hostId: string,
  folderId: string,
  patch: Partial<Pick<RemoteDesktopSharedFolder, 'name' | 'readOnly'>>,
): RemoteDesktopSharedFolder[] {
  const existing = loadRemoteDesktopSharedFolders(hostId);
  const next = existing.map((item) => {
    if (item.id !== folderId) return item;
    return {
      ...item,
      ...(patch.name !== undefined ? { name: sanitizeShareName(patch.name, item.path) } : {}),
      ...(patch.readOnly !== undefined ? { readOnly: Boolean(patch.readOnly) } : {}),
    };
  });
  return saveRemoteDesktopSharedFolders(hostId, next);
}
