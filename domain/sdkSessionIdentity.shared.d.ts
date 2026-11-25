type SharedCursorAuthModeIdentity = "api-key" | "cli-login";
type SharedCursorCliModeIdentity = "ask" | "agent";
type SharedSdkRuntimeIdentity = "sdk" | "app-server" | "acp" | "streaming-json";

interface SharedSdkSessionIdentityPayload {
  v: 1;
  id: string;
  backend: string;
  binPath: string;
  runtime?: SharedSdkRuntimeIdentity;
  authMode?: SharedCursorAuthModeIdentity;
  cliMode?: SharedCursorCliModeIdentity;
}

declare module "./sdkSessionIdentity.shared.cjs" {
  export const SDK_SESSION_ID_PREFIX: string;
  export function normalizeCursorAuthMode(
    authMode: string | undefined | null,
  ): SharedCursorAuthModeIdentity | undefined;
  export function normalizeCursorCliMode(
    cliMode: string | undefined | null,
  ): SharedCursorCliModeIdentity | undefined;
  export function normalizeSdkRuntime(
    runtime: string | undefined | null,
  ): SharedSdkRuntimeIdentity;
  export function encodeSdkSessionIdentity(
    sessionId: string,
    sdkBackend?: string,
    binPath?: string,
    runtime?: string,
    authMode?: string,
    cliMode?: string,
  ): string;
  export function parseSdkSessionIdentity(
    value: string | undefined | null,
  ): SharedSdkSessionIdentityPayload | null;
}

declare module "@/domain/sdkSessionIdentity.shared.cjs" {
  export const SDK_SESSION_ID_PREFIX: string;
  export function normalizeCursorAuthMode(
    authMode: string | undefined | null,
  ): SharedCursorAuthModeIdentity | undefined;
  export function normalizeCursorCliMode(
    cliMode: string | undefined | null,
  ): SharedCursorCliModeIdentity | undefined;
  export function normalizeSdkRuntime(
    runtime: string | undefined | null,
  ): SharedSdkRuntimeIdentity;
  export function encodeSdkSessionIdentity(
    sessionId: string,
    sdkBackend?: string,
    binPath?: string,
    runtime?: string,
    authMode?: string,
    cliMode?: string,
  ): string;
  export function parseSdkSessionIdentity(
    value: string | undefined | null,
  ): SharedSdkSessionIdentityPayload | null;
}
