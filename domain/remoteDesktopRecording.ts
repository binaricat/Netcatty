import type {
  ConnectionLog,
  RemoteDesktopRecordingClip,
  RemoteDesktopSessionEvent,
  RemoteDesktopSessionMetadata,
} from './models/history';

export const MAX_REMOTE_DESKTOP_RECORDING_CLIPS_PER_LOG = 50;
export const MAX_REMOTE_DESKTOP_SESSION_EVENTS = 100;
export const MAX_REMOTE_DESKTOP_EVENT_SUMMARY_CHARS = 200;
export const MAX_REMOTE_DESKTOP_EVENT_DETAIL_CHARS = 240;

let nextSessionEventSeq = 0;

function trimBoundedText(value: string | undefined, maxLen: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.trim();
  if (!cleaned) return undefined;
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxLen - 1))}\u2026`;
}

/**
 * Normalize a ConnectionLog's recordings into an ordered list of clips
 * (oldest first), transparently upgrading legacy single-`recordingId` logs.
 */
export function getConnectionLogRecordingClips(
  log: Pick<
    ConnectionLog,
    | 'recordings'
    | 'recordingId'
    | 'recordingMimeType'
    | 'recordingDurationMs'
    | 'recordingBytes'
    | 'recordingHasAudio'
    | 'startTime'
    | 'endTime'
  >,
): RemoteDesktopRecordingClip[] {
  if (Array.isArray(log.recordings) && log.recordings.length > 0) {
    const seen = new Set<string>();
    const valid: RemoteDesktopRecordingClip[] = [];
    for (const clip of log.recordings) {
      if (!clip || typeof clip.id !== 'string' || !clip.id || seen.has(clip.id)) continue;
      seen.add(clip.id);
      valid.push(clip);
    }
    if (valid.length > 0) return valid;
  }

  if (typeof log.recordingId === 'string' && log.recordingId.length > 0) {
    const durationMs = typeof log.recordingDurationMs === 'number' && Number.isFinite(log.recordingDurationMs)
      ? Math.max(0, log.recordingDurationMs)
      : 0;
    const endedAt = typeof log.endTime === 'number' && Number.isFinite(log.endTime)
      ? log.endTime
      : log.startTime + durationMs;
    const startedAt = durationMs > 0 ? Math.max(log.startTime, endedAt - durationMs) : log.startTime;
    return [
      {
        id: log.recordingId,
        startedAt,
        endedAt,
        durationMs,
        bytes: typeof log.recordingBytes === 'number' && Number.isFinite(log.recordingBytes)
          ? Math.max(0, log.recordingBytes)
          : 0,
        mimeType: log.recordingMimeType || 'video/webm',
        hasAudio: Boolean(log.recordingHasAudio),
      },
    ];
  }

  return [];
}

/**
 * Return all local media UUIDs referenced by a ConnectionLog (video clips +
 * optional unrecorded session thumbnail). Used for cascade delete and GC.
 */
export function getConnectionLogMediaIds(
  log: Pick<
    ConnectionLog,
    'recordings' | 'recordingId' | 'remoteDesktopMeta'
  >,
): string[] {
  const ids = new Set<string>();
  if (Array.isArray(log.recordings)) {
    for (const clip of log.recordings) {
      if (clip && typeof clip.id === 'string' && clip.id.length > 0) {
        ids.add(clip.id);
      }
    }
  }
  if (typeof log.recordingId === 'string' && log.recordingId.length > 0) {
    ids.add(log.recordingId);
  }
  const thumbId = log.remoteDesktopMeta?.thumbnailId;
  if (typeof thumbId === 'string' && thumbId.length > 0) {
    ids.add(thumbId);
  }
  return Array.from(ids);
}

export interface ConnectionLogRecordingSummary {
  clipCount: number;
  totalDurationMs: number;
  totalBytes: number;
  hasAudio: boolean;
  primaryClip: RemoteDesktopRecordingClip | null;
}

export function getConnectionLogRecordingSummary(
  log: Pick<
    ConnectionLog,
    | 'recordings'
    | 'recordingId'
    | 'recordingMimeType'
    | 'recordingDurationMs'
    | 'recordingBytes'
    | 'recordingHasAudio'
    | 'startTime'
    | 'endTime'
  >,
): ConnectionLogRecordingSummary {
  const clips = getConnectionLogRecordingClips(log);
  if (clips.length === 0) {
    return {
      clipCount: 0,
      totalDurationMs: 0,
      totalBytes: 0,
      hasAudio: false,
      primaryClip: null,
    };
  }
  let totalDurationMs = 0;
  let totalBytes = 0;
  let hasAudio = false;
  for (const clip of clips) {
    totalDurationMs += Math.max(0, Number(clip.durationMs) || 0);
    totalBytes += Math.max(0, Number(clip.bytes) || 0);
    if (clip.hasAudio) hasAudio = true;
  }
  return {
    clipCount: clips.length,
    totalDurationMs,
    totalBytes,
    hasAudio,
    primaryClip: clips[clips.length - 1] ?? null,
  };
}

function buildLegacyMirrorFields(clips: RemoteDesktopRecordingClip[]): Partial<ConnectionLog> {
  if (clips.length === 0) {
    return {
      recordings: undefined,
      recordingId: undefined,
      recordingMimeType: undefined,
      recordingDurationMs: undefined,
      recordingBytes: undefined,
      recordingHasAudio: undefined,
    };
  }
  const latest = clips[clips.length - 1];
  let totalDurationMs = 0;
  let totalBytes = 0;
  let hasAudio = false;
  for (const clip of clips) {
    totalDurationMs += Math.max(0, clip.durationMs);
    totalBytes += Math.max(0, clip.bytes);
    if (clip.hasAudio) hasAudio = true;
  }
  return {
    recordings: clips,
    recordingId: latest.id,
    recordingMimeType: latest.mimeType,
    recordingDurationMs: totalDurationMs,
    recordingBytes: totalBytes,
    recordingHasAudio: hasAudio,
  };
}

/**
 * Append a newly finalized recording clip to a ConnectionLog without losing
 * earlier clips recorded in the same session.
 */
export function buildAppendRecordingClipUpdate(
  log: ConnectionLog,
  clip: RemoteDesktopRecordingClip,
  options?: { stampEndTime?: number },
): Partial<ConnectionLog> {
  const existing = getConnectionLogRecordingClips(log).filter((item) => item.id !== clip.id);
  const nextClips = [...existing, clip].slice(-MAX_REMOTE_DESKTOP_RECORDING_CLIPS_PER_LOG);
  return {
    ...buildLegacyMirrorFields(nextClips),
    ...(typeof options?.stampEndTime === 'number' ? { endTime: options.stampEndTime } : {}),
  };
}

/**
 * Remove a single recording clip from a ConnectionLog and keep legacy mirror
 * fields consistent with any remaining clips.
 */
export function buildRemoveRecordingClipUpdate(
  log: ConnectionLog,
  clipId: string,
): Partial<ConnectionLog> {
  const remaining = getConnectionLogRecordingClips(log).filter((clip) => clip.id !== clipId);
  return buildLegacyMirrorFields(remaining);
}

/**
 * Clear non-protected recording clips (and optional unrecorded thumbnail) from
 * a ConnectionLog after Settings -> Clear All Recordings.
 */
export function buildClearRecordingsUpdate(
  log: ConnectionLog,
  protectedIds: ReadonlySet<string>,
): Partial<ConnectionLog> | null {
  const existingClips = getConnectionLogRecordingClips(log);
  const keptClips = existingClips.filter((clip) => protectedIds.has(clip.id));
  const thumbId = log.remoteDesktopMeta?.thumbnailId;
  const shouldClearThumb = Boolean(thumbId && !protectedIds.has(thumbId));

  if (keptClips.length === existingClips.length && !shouldClearThumb) {
    return null;
  }

  const updates: Partial<ConnectionLog> = {
    ...buildLegacyMirrorFields(keptClips),
  };

  if (shouldClearThumb && log.remoteDesktopMeta) {
    const { thumbnailId: _removed, ...restMeta } = log.remoteDesktopMeta;
    updates.remoteDesktopMeta = Object.keys(restMeta).length > 0 ? restMeta : undefined;
  }

  return updates;
}

/**
 * Append a structured event to a ConnectionLog's bounded timeline.
 */
export function appendRemoteDesktopSessionEvent(
  existing: readonly RemoteDesktopSessionEvent[] | undefined,
  event: Omit<RemoteDesktopSessionEvent, 'id'> & { id?: string },
): RemoteDesktopSessionEvent[] {
  const list = Array.isArray(existing) ? existing.slice() : [];
  const summary = trimBoundedText(event.summary, MAX_REMOTE_DESKTOP_EVENT_SUMMARY_CHARS);
  if (!summary) return list;
  const detail = trimBoundedText(event.detail, MAX_REMOTE_DESKTOP_EVENT_DETAIL_CHARS);
  const safeTimestamp = Number.isFinite(event.timestamp) ? event.timestamp : Date.now();
  nextSessionEventSeq += 1;
  const nextEvent: RemoteDesktopSessionEvent = {
    id: event.id || `rdev-${safeTimestamp.toString(36)}-${nextSessionEventSeq}`,
    timestamp: safeTimestamp,
    kind: event.kind,
    summary,
    ...(detail ? { detail } : {}),
  };
  list.push(nextEvent);
  if (list.length > MAX_REMOTE_DESKTOP_SESSION_EVENTS) {
    return list.slice(list.length - MAX_REMOTE_DESKTOP_SESSION_EVENTS);
  }
  return list;
}

export function mergeRemoteDesktopSessionMetadata(
  existing: RemoteDesktopSessionMetadata | undefined,
  patch: Partial<RemoteDesktopSessionMetadata>,
): RemoteDesktopSessionMetadata {
  const next: RemoteDesktopSessionMetadata = { ...(existing ?? {}) };
  if (patch.resolution && patch.resolution.width > 0 && patch.resolution.height > 0) {
    next.resolution = {
      width: Math.round(patch.resolution.width),
      height: Math.round(patch.resolution.height),
    };
  }
  if (typeof patch.securityLabel === 'string' && patch.securityLabel.trim()) {
    next.securityLabel = patch.securityLabel.trim();
  }
  if (typeof patch.tunneled === 'boolean') {
    next.tunneled = patch.tunneled;
  }
  if (typeof patch.monitorCount === 'number' && Number.isFinite(patch.monitorCount) && patch.monitorCount > 0) {
    next.monitorCount = Math.round(patch.monitorCount);
  }
  if (typeof patch.disconnectReason === 'string' && patch.disconnectReason.trim()) {
    next.disconnectReason = trimBoundedText(patch.disconnectReason, MAX_REMOTE_DESKTOP_EVENT_DETAIL_CHARS);
  }
  if (typeof patch.thumbnailId === 'string' && patch.thumbnailId.trim()) {
    next.thumbnailId = patch.thumbnailId.trim();
  }
  return next;
}

/**
 * Given a recording clip and an event timestamp, compute the video seek offset
 * in seconds if the event occurred during the clip (with configurable tolerance).
 */
export function resolveVideoSeekSecondsForEvent(
  clip: Pick<RemoteDesktopRecordingClip, 'startedAt' | 'endedAt' | 'durationMs'>,
  eventTimestamp: number,
  toleranceMs = 1000,
): number | null {
  if (!Number.isFinite(eventTimestamp) || !Number.isFinite(clip.startedAt)) return null;
  const effectiveDurationMs = clip.durationMs > 0
    ? clip.durationMs
    : Math.max(0, (clip.endedAt || clip.startedAt) - clip.startedAt);
  const clipEnd = Math.max(clip.endedAt || 0, clip.startedAt + effectiveDurationMs);
  if (eventTimestamp < clip.startedAt - toleranceMs || eventTimestamp > clipEnd + toleranceMs) {
    return null;
  }
  const clampedOffsetMs = Math.max(0, Math.min(effectiveDurationMs, eventTimestamp - clip.startedAt));
  return clampedOffsetMs / 1000;
}

/**
 * Find the recording clip and seek offset (seconds) covering a given event
 * timestamp, preferring exact in-range matches over boundary tolerance matches.
 */
export function findRecordingSeekTargetForEvent(
  clips: readonly RemoteDesktopRecordingClip[],
  eventTimestamp: number,
): { clipId: string; offsetSeconds: number } | null {
  for (const clip of clips) {
    const exactOffset = resolveVideoSeekSecondsForEvent(clip, eventTimestamp, 0);
    if (exactOffset !== null) {
      return { clipId: clip.id, offsetSeconds: exactOffset };
    }
  }
  for (const clip of clips) {
    const tolerantOffset = resolveVideoSeekSecondsForEvent(clip, eventTimestamp, 1000);
    if (tolerantOffset !== null) {
      return { clipId: clip.id, offsetSeconds: tolerantOffset };
    }
  }
  return null;
}
