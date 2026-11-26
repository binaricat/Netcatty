import type { Host, Identity, KnownHost, SSHKey } from '../../types';
import {
  resolveRemoteDesktopConnectionSpec,
  type RemoteDesktopConnectionSpec,
  type RemoteDesktopProtocol,
} from '../../domain/remoteDesktop';
import { generateRdpFileContent } from '../../domain/rdpFileParser';
import { sanitizeCredentialValue } from '../../domain/credentials';
import { resolveBridgeSshAgentAuth, resolveHostAuth } from '../../domain/sshAuth';
import { connectionTotpFields } from '../../domain/totpConfig';
import { hasUsableProxyConfig, resolveProxyConfigAuth } from '../../domain/proxyProfiles';
import {
  getRemoteDesktopBridge,
  type RemoteDesktopBridgeApi,
  type RemoteDesktopCertDecisionValue,
  type RemoteDesktopCertVerifyEvent,
  type RemoteDesktopOpenSystemClientOptions,
  type RemoteDesktopStartOptions,
} from '../../application/state/useSessionState';
import { isPluginHostProtocol } from '../../domain/pluginConnection';
import type {
  RemoteDesktopCaptureRequest,
  RemoteDesktopProviderFrame,
} from '../../infrastructure/remoteDesktop/remoteDesktopSnapshotRegistry';
import { getKnownRemoteDesktopFingerprints } from './knownRemoteDesktopCerts';
import type { RemoteDesktopSpecialKeyId } from './vncKeymap';

export {
  getRemoteDesktopBridge,
  type RemoteDesktopBridgeApi,
  type RemoteDesktopCertDecisionValue,
  type RemoteDesktopCertVerifyEvent,
  type RemoteDesktopOpenSystemClientOptions,
  type RemoteDesktopStartOptions,
};

export type RemoteDesktopDisplayMode = 'dynamic' | 'fit' | 'actual' | 'stretch';
export type RemoteDesktopQualityPreset = 'auto' | 'high' | 'medium' | 'low' | 'lossless';

export interface RemoteDesktopClipboardFileOffer {
  index: number;
  name: string;
  size: number;
  isDirectory?: boolean;
}

export interface RemoteDesktopClipboardTransferState {
  id: string;
  direction: 'upload' | 'download';
  phase: 'staged' | 'transferring' | 'completed' | 'error';
  fileName: string;
  fileCount: number;
  transferredBytes: number;
  totalBytes: number;
  percent: number;
  message: string;
  error?: string;
}

export interface RemoteDesktopCanvasHandle {
  sendSpecialKey: (id: RemoteDesktopSpecialKeyId) => void;
  typeText: (text: string) => void;
  releaseAllInputs: () => void;
  captureScreenshot: () => Promise<Blob | null>;
  captureFrame?: (
    options?: RemoteDesktopCaptureRequest & {
      maxWidth?: number;
      protocol?: 'vnc' | 'rdp';
      hostLabel?: string;
      hostname?: string;
      includePreview?: boolean;
    },
  ) => Promise<RemoteDesktopProviderFrame | null> | RemoteDesktopProviderFrame | null;
  getCanvasRect?: () => DOMRect | null;
  getCaptureStream?: (fps: number, includeAudio?: boolean) => MediaStream | null;
  focusInput?: () => void;
  syncClipboardNow?: () => Promise<void> | void;
  requestRefresh?: () => void;
  downloadRemoteClipboardFile?: (fileIndex: number) => Promise<void>;
  uploadLocalClipboardFiles?: (files: FileList | File[]) => Promise<void>;
}

/**
 * Format a byte count into a compact human-readable label (e.g. `1.4 MB`).
 */
export function formatTransferBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${Number(value.toFixed(decimals))} ${units[unitIndex]}`;
}

/**
 * Compute aggregate CLIPRDR upload progress across staged files using per-file
 * high-water offsets without producing NaN on 0-byte files.
 */
export function computeClipboardUploadProgress(
  files: ReadonlyArray<{ size: number }>,
  highWaterByIndex: ReadonlyMap<number, number>,
): { transferredBytes: number; totalBytes: number; percent: number } {
  let totalBytes = 0;
  let transferredBytes = 0;
  for (let i = 0; i < files.length; i += 1) {
    const fileSize = Math.max(0, Number(files[i]?.size) || 0);
    totalBytes += fileSize;
    const hw = highWaterByIndex.get(i) ?? 0;
    transferredBytes += Math.max(0, Math.min(fileSize, Number(hw) || 0));
  }
  if (totalBytes <= 0) {
    return {
      transferredBytes: 0,
      totalBytes: 0,
      percent: files.length > 0 && highWaterByIndex.size >= files.length ? 100 : 0,
    };
  }
  const percent = Math.max(0, Math.min(100, Math.round((transferredBytes / totalBytes) * 100)));
  return { transferredBytes, totalBytes, percent };
}

/**
 * Returns true when a remote desktop tab belongs to an SSH/Mosh/ET companion
 * host that supports opening the SFTP side panel.
 */
export function canOpenCompanionRemoteDesktopSftp(
  session: { remoteDesktopCompanion?: boolean },
  host: Pick<Host, 'protocol'>,
): boolean {
  return Boolean(
    session.remoteDesktopCompanion
    && (!host.protocol || host.protocol === 'ssh' || host.protocol === 'mosh' || host.protocol === 'et')
    && !isPluginHostProtocol(host.protocol),
  );
}

/**
 * Format an elapsed recording duration in milliseconds as `MM:SS` (or `HH:MM:SS`).
 */
export function formatRecordingDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor((Number.isFinite(durationMs) ? durationMs : 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Translate a key via Netcatty's `useI18n` `t(key, values)` function,
 * falling back to `fallback` when the locale dictionary lacks that key.
 */
export function tr(
  t: (key: string, values?: Record<string, string | number | boolean | null | undefined>) => string,
  key: string,
  fallback: string,
  values?: Record<string, string | number | boolean | null | undefined>,
): string {
  const translated = t(key, values);
  if (translated === key) {
    if (!values) return fallback;
    return fallback
      .replace(/\{\{(\w+)\}\}/g, (match, k) => (values[k] == null ? match : String(values[k])))
      .replace(/\{(\w+)\}/g, (_match, k) => (values[k] == null ? '' : String(values[k])));
  }
  return translated;
}

/**
 * True when the user presses `Ctrl+Alt+Shift` (either side) as the emergency
 * Keyboard Grab release chord.
 */
export function isRemoteDesktopGrabReleaseChord(
  event: Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'code' | 'key'>,
): boolean {
  if (event.metaKey) return false;
  if (!event.ctrlKey || !event.altKey || !event.shiftKey) return false;
  return (
    event.code === 'ShiftLeft'
    || event.code === 'ShiftRight'
    || event.code === 'ControlLeft'
    || event.code === 'ControlRight'
    || event.code === 'AltLeft'
    || event.code === 'AltRight'
    || event.key === 'Shift'
    || event.key === 'Control'
    || event.key === 'Alt'
  );
}

/**
 * Returns true if the event target is currently inside a remote desktop pane
 * with active Keyboard Grab (`data-remote-desktop-capture="true"`).
 */
export function isTargetInsideRemoteDesktopCapture(
  target: EventTarget | null,
  composedPath?: () => EventTarget[],
): boolean {
  const matches = (node: unknown): boolean => {
    const el = node as { closest?: (sel: string) => unknown } | null;
    return typeof el?.closest === 'function'
      && Boolean(el.closest('[data-remote-desktop-capture="true"]'));
  };
  if (matches(target)) return true;
  if (typeof composedPath === 'function') {
    return composedPath().some(matches);
  }
  return false;
}

function toBridgeProxy(
  host: Host,
  identities: readonly Identity[],
): RemoteDesktopStartOptions['proxy'] | undefined {
  if (!hasUsableProxyConfig(host.proxyConfig)) return undefined;
  const resolved = resolveProxyConfigAuth(host.proxyConfig, [...identities]);
  if (!resolved) return undefined;
  return {
    type: resolved.type,
    host: resolved.host,
    port: resolved.port,
    username: resolved.username,
    password: resolved.password,
    command: resolved.command,
  };
}

export function buildSshJumpHostConfigs(
  chainHosts: readonly Host[] | undefined,
  keys: readonly SSHKey[],
  identities: readonly Identity[],
): Array<Record<string, unknown>> {
  if (!chainHosts?.length) return [];
  return chainHosts.map((jumpHost) => {
    const jumpAuth = resolveHostAuth({
      host: jumpHost,
      keys: [...keys],
      identities: [...identities],
    });
    const jumpKey = jumpAuth.key;
    const jumpPassword = sanitizeCredentialValue(jumpAuth.password);
    const jumpPrivateKey = sanitizeCredentialValue(jumpKey?.privateKey);
    const jumpPassphrase = sanitizeCredentialValue(jumpAuth.passphrase || jumpKey?.passphrase);
    const jumpAgentAuth = resolveBridgeSshAgentAuth(jumpHost, jumpKey, jumpAuth.authMethod);
    const jumpReferenceKeyPath = jumpAuth.authMethod === 'password'
      ? undefined
      : jumpKey?.source === 'reference'
        ? jumpKey.filePath
        : undefined;
    const jumpIdentityFilePaths = jumpAuth.authMethod === 'password'
      ? undefined
      : jumpReferenceKeyPath
        ? [jumpReferenceKeyPath]
        : !jumpAuth.keyId
          ? jumpHost.identityFilePaths
          : undefined;
    return {
      hostname: jumpHost.hostname,
      hostId: jumpHost.id,
      port: jumpHost.port || 22,
      username: jumpAuth.username || 'root',
      authMethod: jumpAuth.authMethod,
      requiresMfa: Boolean(jumpHost.requiresMfa),
      password: jumpPassword,
      ...connectionTotpFields(jumpHost),
      privateKey: jumpPrivateKey,
      certificate: jumpKey?.certificate,
      passphrase: jumpPassphrase,
      keyId: jumpAuth.keyId,
      identityId: jumpHost.identityId,
      label: jumpHost.label,
      proxy: toBridgeProxy(jumpHost, identities),
      identityFilePaths: jumpIdentityFilePaths,
      ...jumpAgentAuth,
      legacyAlgorithms: jumpHost.legacyAlgorithms,
      skipEcdsaHostKey: jumpHost.skipEcdsaHostKey,
      algorithmOverrides: jumpHost.algorithms,
    };
  });
}

export function buildCompanionSshTunnelConfig(
  host: Host,
  chainHosts: readonly Host[] | undefined,
  keys: readonly SSHKey[],
  identities: readonly Identity[],
  knownHosts?: readonly KnownHost[],
): Record<string, unknown> {
  const sshAuth = resolveHostAuth({
    host,
    keys: [...keys],
    identities: [...identities],
  });
  const sshKey = sshAuth.key;
  const sshPassword = sanitizeCredentialValue(sshAuth.password);
  const sshPrivateKey = sanitizeCredentialValue(sshKey?.privateKey);
  const sshPassphrase = sanitizeCredentialValue(sshAuth.passphrase || sshKey?.passphrase);
  const sshAgentAuth = resolveBridgeSshAgentAuth(host, sshKey, sshAuth.authMethod);
  const referenceKeyPath = sshAuth.authMethod === 'password'
    ? undefined
    : sshKey?.source === 'reference'
      ? sshKey.filePath
      : undefined;
  const identityFilePaths = sshAuth.authMethod === 'password'
    ? undefined
    : referenceKeyPath
      ? [referenceKeyPath]
      : !sshAuth.keyId
        ? host.identityFilePaths
        : undefined;

  return {
    hostname: host.hostname,
    port: host.port || 22,
    username: sshAuth.username || 'root',
    authMethod: sshAuth.authMethod,
    password: sshPassword,
    privateKey: sshPrivateKey,
    passphrase: sshPassphrase,
    certificate: sshKey?.certificate,
    keyId: sshAuth.keyId,
    identityId: host.identityId,
    hostId: host.id,
    label: host.label || host.hostname,
    proxy: toBridgeProxy(host, identities),
    jumpHosts: buildSshJumpHostConfigs(chainHosts, keys, identities),
    identityFilePaths,
    ...sshAgentAuth,
    ...connectionTotpFields(host),
    legacyAlgorithms: host.legacyAlgorithms,
    skipEcdsaHostKey: host.skipEcdsaHostKey,
    algorithmOverrides: host.algorithms,
    knownHosts: knownHosts ? (knownHosts as unknown as Array<Record<string, unknown>>) : undefined,
  };
}

export function buildRemoteDesktopStartPayload(args: {
  sessionId: string;
  host: Host;
  spec: RemoteDesktopConnectionSpec;
  credentials: { username: string; password: string; domain: string };
  chainHosts?: readonly Host[];
  keys: readonly SSHKey[];
  identities: readonly Identity[];
  knownHosts?: readonly KnownHost[];
  quality?: RemoteDesktopQualityPreset;
  viewOnly?: boolean;
  securityMode?: RemoteDesktopStartOptions['securityMode'];
  ignoreCertErrors?: boolean;
}): RemoteDesktopStartOptions {
  const {
    sessionId,
    host,
    spec,
    credentials,
    chainHosts,
    keys,
    identities,
    knownHosts,
    quality,
    viewOnly,
    securityMode,
    ignoreCertErrors,
  } = args;

  const knownCertFingerprints = getKnownRemoteDesktopFingerprints(
    spec.protocol,
    spec.hostHostname,
    spec.port,
  );
  const jumpHosts = buildSshJumpHostConfigs(chainHosts, keys, identities);
  const proxy = toBridgeProxy(host, identities);

  return {
    sessionId,
    protocol: spec.protocol,
    hostname: spec.hostname,
    port: spec.port,
    username: credentials.username || undefined,
    password: credentials.password || undefined,
    domain: credentials.domain || undefined,
    hostId: host.id,
    label: spec.label,
    shared: spec.vncConfig?.sharedSession ?? true,
    readOnly: viewOnly ?? spec.vncConfig?.viewOnly ?? false,
    viewOnly: viewOnly ?? spec.vncConfig?.viewOnly ?? false,
    quality: quality ?? 'auto',
    securityMode: securityMode ?? spec.rdpConfig?.securityMode ?? 'auto',
    ignoreCertErrors: ignoreCertErrors ?? spec.rdpConfig?.ignoreCertErrors ?? false,
    knownCertFingerprints,
    expectedCertFingerprint: knownCertFingerprints[0],
    proxy,
    jumpHosts: jumpHosts.length > 0 ? jumpHosts : undefined,
    tunnelViaHostSsh: spec.tunnelViaHostSsh,
    tunnelTargetHost: spec.tunnelViaHostSsh ? spec.tunnelTargetHost : undefined,
    sshTunnelConfig: spec.tunnelViaHostSsh
      ? buildCompanionSshTunnelConfig(host, chainHosts, keys, identities, knownHosts)
      : undefined,
    knownHosts: knownHosts ? (knownHosts as unknown as Array<Record<string, unknown>>) : undefined,
  };
}

export function buildSystemRemoteDesktopPayload(args: {
  host: Host;
  protocol: RemoteDesktopProtocol;
  chainHosts?: readonly Host[];
  keys: readonly SSHKey[];
  identities: readonly Identity[];
  knownHosts?: readonly KnownHost[];
  rawRdpContent?: string;
}): RemoteDesktopOpenSystemClientOptions {
  const { host, protocol, chainHosts, keys, identities, knownHosts, rawRdpContent } = args;
  const spec = resolveRemoteDesktopConnectionSpec(host, protocol, identities);
  const jumpHosts = buildSshJumpHostConfigs(chainHosts, keys, identities);
  const proxy = toBridgeProxy(host, identities);

  const rdpContent = protocol === 'rdp'
    ? (rawRdpContent?.trim() || generateRdpFileContent({
        hostname: spec.hostname,
        port: spec.port,
        username: spec.username || undefined,
        domain: spec.domain || undefined,
        width: spec.rdpConfig?.width,
        height: spec.rdpConfig?.height,
        colorDepth: spec.rdpConfig?.colorDepth,
        resolutionMode: spec.rdpConfig?.resolutionMode,
        audioEnabled: spec.rdpConfig?.audioEnabled,
        clipboardSync: spec.rdpConfig?.clipboardSync,
        securityMode: spec.rdpConfig?.securityMode,
        ignoreCertErrors: spec.rdpConfig?.ignoreCertErrors,
        loadBalanceInfo: spec.rdpConfig?.loadBalanceInfo,
        alternateShell: spec.rdpConfig?.alternateShell,
        shellWorkingDir: spec.rdpConfig?.shellWorkingDir,
        remoteApplicationMode: spec.rdpConfig?.remoteApplicationMode,
        remoteApplicationProgram: spec.rdpConfig?.remoteApplicationProgram,
      }))
    : undefined;

  return {
    protocol,
    hostname: spec.hostname,
    port: spec.port,
    username: spec.username || undefined,
    domain: spec.domain || undefined,
    label: spec.label,
    rdpContent,
    loadBalanceInfo: spec.rdpConfig?.loadBalanceInfo,
    alternateShell: spec.rdpConfig?.alternateShell,
    shellWorkingDir: spec.rdpConfig?.shellWorkingDir,
    audioEnabled: spec.rdpConfig?.audioEnabled,
    clipboardSync: protocol === 'rdp' ? spec.rdpConfig?.clipboardSync : spec.vncConfig?.clipboardSync,
    proxy,
    jumpHosts: jumpHosts.length > 0 ? jumpHosts : undefined,
    tunnelViaHostSsh: spec.tunnelViaHostSsh,
    tunnelTargetHost: spec.tunnelViaHostSsh ? spec.tunnelTargetHost : undefined,
    sshTunnelConfig: spec.tunnelViaHostSsh
      ? buildCompanionSshTunnelConfig(host, chainHosts, keys, identities, knownHosts)
      : undefined,
    knownHosts: knownHosts ? (knownHosts as unknown as Array<Record<string, unknown>>) : undefined,
  };
}
