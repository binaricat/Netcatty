import {
  SDK_SESSION_ID_PREFIX as SHARED_SDK_SESSION_ID_PREFIX,
  encodeSdkSessionIdentity as encodeSharedSdkSessionIdentity,
  normalizeCursorAuthMode as normalizeSharedCursorAuthMode,
  normalizeCursorCliMode as normalizeSharedCursorCliMode,
  normalizeSdkRuntime as normalizeSharedSdkRuntime,
  parseSdkSessionIdentity as parseSharedSdkSessionIdentity,
} from "@/domain/sdkSessionIdentity.shared.cjs";

export const SDK_SESSION_ID_PREFIX = SHARED_SDK_SESSION_ID_PREFIX;

export type CursorAuthModeIdentity = 'api-key' | 'cli-login';
export type CursorCliModeIdentity = 'ask' | 'agent';
/** Codex dual runtime + Grok dual runtime. */
export type SdkRuntimeIdentity = 'sdk' | 'app-server' | 'acp' | 'streaming-json';

export interface SdkSessionIdentityPayload {
  v: 1;
  id: string;
  backend: string;
  binPath: string;
  runtime?: SdkRuntimeIdentity;
  authMode?: CursorAuthModeIdentity;
  cliMode?: CursorCliModeIdentity;
}

export function normalizeCursorAuthMode(
  authMode: string | undefined | null,
): CursorAuthModeIdentity | undefined {
  return normalizeSharedCursorAuthMode(authMode);
}

export function normalizeCursorCliMode(
  cliMode: string | undefined | null,
): CursorCliModeIdentity | undefined {
  return normalizeSharedCursorCliMode(cliMode);
}

export function normalizeSdkRuntime(
  runtime: string | undefined | null,
): SdkRuntimeIdentity {
  return normalizeSharedSdkRuntime(runtime);
}

export function encodeSdkSessionIdentity(
  sessionId: string,
  sdkBackend?: string,
  binPath?: string,
  runtime: string = 'sdk',
  authMode?: string,
  cliMode?: string,
): string {
  return encodeSharedSdkSessionIdentity(sessionId, sdkBackend, binPath, runtime, authMode, cliMode);
}

export function parseSdkSessionIdentity(value: string | undefined | null): SdkSessionIdentityPayload | null {
  return parseSharedSdkSessionIdentity(value);
}
