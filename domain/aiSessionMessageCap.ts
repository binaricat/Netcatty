/**
 * User-configurable per-session AI chat message cap.
 *
 * Storage moved to IndexedDB (issue #4123), so the tight cap that defended the
 * shared 2 MB localStorage budget no longer drives retention. The cap now only
 * bounds per-record size, cloud-sync payload and UI rendering, so users may
 * raise it; it still stays bounded to keep those costs predictable.
 */

export const DEFAULT_AI_SESSION_MESSAGE_CAP = 200;
export const MIN_AI_SESSION_MESSAGE_CAP = 50;
export const MAX_AI_SESSION_MESSAGE_CAP = 2000;

export function normalizeAiSessionMessageCap(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_AI_SESSION_MESSAGE_CAP;
  return Math.min(
    MAX_AI_SESSION_MESSAGE_CAP,
    Math.max(MIN_AI_SESSION_MESSAGE_CAP, Math.round(numeric)),
  );
}
