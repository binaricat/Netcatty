export const SDK_SESSION_ID_PREFIX = 'netcatty-sdk-session:';

export interface SdkSessionIdentityPayload {
  v: 1;
  id: string;
  backend: string;
  binPath: string;
}

export function encodeSdkSessionIdentity(
  sessionId: string,
  sdkBackend?: string,
  binPath?: string,
): string {
  if (!sessionId || !sdkBackend) return sessionId;
  const payload: SdkSessionIdentityPayload = {
    v: 1,
    id: sessionId,
    backend: sdkBackend,
    binPath: binPath || '',
  };
  return `${SDK_SESSION_ID_PREFIX}${encodeURIComponent(JSON.stringify(payload))}`;
}

export function parseSdkSessionIdentity(value: string | undefined | null): SdkSessionIdentityPayload | null {
  const raw = String(value || '').trim();
  if (!raw.startsWith(SDK_SESSION_ID_PREFIX)) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(raw.slice(SDK_SESSION_ID_PREFIX.length))) as SdkSessionIdentityPayload;
    if (parsed?.v !== 1 || !parsed.id || !parsed.backend) return null;
    return parsed;
  } catch {
    return null;
  }
}
