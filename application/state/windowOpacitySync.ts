import {
  DEFAULT_WINDOW_OPACITY,
  clampWindowOpacity,
} from './settingsStateDefaults';

export { DEFAULT_WINDOW_OPACITY, clampWindowOpacity };

export type WindowOpacityMutationSource = 'local' | 'incoming';

export type WindowOpacityRecord = {
  opacity: number;
  version: number;
};

/**
 * Parse persisted / IPC window-opacity payloads.
 * Accepts legacy plain numbers ("0.85") and versioned records.
 */
export function parseWindowOpacityRecord(raw: unknown): WindowOpacityRecord {
  if (typeof raw === 'number' || typeof raw === 'string') {
    const trimmed = typeof raw === 'string' ? raw.trim() : raw;
    // Prefer JSON object payloads written by serializeWindowOpacityRecord.
    if (typeof trimmed === 'string' && trimmed.startsWith('{')) {
      try {
        return parseWindowOpacityRecord(JSON.parse(trimmed));
      } catch {
        // fall through to Number()
      }
    }
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber)) {
      return { opacity: clampWindowOpacity(asNumber), version: 0 };
    }
  }

  if (raw && typeof raw === 'object') {
    const record = raw as { opacity?: unknown; version?: unknown };
    const opacity = clampWindowOpacity(record.opacity);
    const version = Number(record.version);
    return {
      opacity,
      version: Number.isFinite(version) && version > 0 ? Math.floor(version) : 0,
    };
  }

  return { opacity: DEFAULT_WINDOW_OPACITY, version: 0 };
}

export function serializeWindowOpacityRecord(record: WindowOpacityRecord): string {
  return JSON.stringify({
    opacity: clampWindowOpacity(record.opacity),
    version: Math.max(0, Math.floor(record.version) || 0),
  });
}

/**
 * Incoming peer updates must not clobber a newer local/drag revision.
 * Equal versions are treated as already-applied (no state thrash).
 */
export function shouldApplyWindowOpacityRecord(
  current: WindowOpacityRecord,
  incoming: WindowOpacityRecord,
): boolean {
  if (incoming.version > current.version) return true;
  if (incoming.version < current.version) return false;
  // Same version: only apply when the opacity itself differs and both are
  // legacy/unversioned (version 0), so first-load plain strings still sync.
  if (incoming.version === 0 && current.version === 0) {
    return incoming.opacity !== current.opacity;
  }
  return false;
}

/**
 * Decide whether a window-opacity state change should be rebroadcast to peer
 * windows. Incoming IPC/storage updates must not notify again — otherwise a
 * fast slider drag in the settings window ping-pongs with the main window and
 * the controlled range input oscillates (see #2018).
 */
export function shouldBroadcastWindowOpacityChange(
  mutationSource: WindowOpacityMutationSource,
  persistMounted: boolean,
): { shouldBroadcast: boolean; nextSource: WindowOpacityMutationSource } {
  if (mutationSource === 'incoming') {
    return { shouldBroadcast: false, nextSource: 'local' };
  }
  return { shouldBroadcast: persistMounted, nextSource: 'local' };
}
