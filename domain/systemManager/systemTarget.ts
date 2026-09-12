import { classifyDistroId, resolveHostOs } from '../host';
import type { Host } from '../models/connection';
import type { TerminalSession } from '../../types';
import type { SessionCapabilities, SystemManagerSubTab } from './types';

export function isNetworkDeviceTarget(host: Host | null | undefined): boolean {
  if (host?.deviceType === 'network') return true;
  return classifyDistroId(host?.distro) === 'network-device';
}

export function isDefiniteLinuxTarget(
  host: Host | null | undefined,
  capabilities: SessionCapabilities | undefined,
  _session: TerminalSession | null | undefined,
): boolean {
  if (capabilities?.targetOs && capabilities.targetOs !== 'unknown') return capabilities.targetOs === 'linux';
  if (isNetworkDeviceTarget(host)) return false;
  if (resolveHostOs(host) === 'linux') return true;
  return false;
}

export function shouldShowProcessesTab(
  host: Host | null | undefined,
  capabilities: SessionCapabilities | undefined,
): boolean {
  // Network appliances often lack a usable process table; only show after OS probe confirms.
  if (isNetworkDeviceTarget(host)) {
    const os = capabilities?.targetOs;
    return os === 'linux' || os === 'darwin' || os === 'win32';
  }
  return true;
}

export function shouldShowTmuxTab(
  host: Host | null | undefined,
  capabilities: SessionCapabilities | undefined,
  session: TerminalSession | null | undefined,
): boolean {
  // Network appliances: detect-first only — do not guess from a Linux-like probe.
  if (isNetworkDeviceTarget(host)) return capabilities?.hasTmux === true;
  if (isDefiniteLinuxTarget(host, capabilities, session)) return true;
  if (capabilities?.targetOs === 'darwin') return true;
  if (resolveHostOs(host) === 'macos') return true;
  return false;
}

export function shouldShowDockerTab(
  host: Host | null | undefined,
  capabilities: SessionCapabilities | undefined,
  session: TerminalSession | null | undefined,
): boolean {
  if (capabilities?.hasDocker === true) return true;
  // Network appliances: never show Docker from an OS guess alone.
  if (isNetworkDeviceTarget(host)) return false;
  return isDefiniteLinuxTarget(host, capabilities, session);
}

/** GPU tab only appears after nvidia-smi / npu-smi is actually detected. */
export function shouldShowGpuTab(
  capabilities: SessionCapabilities | undefined,
): boolean {
  return capabilities?.hasNvidiaSmi === true || capabilities?.hasNpuSmi === true;
}

/** Ports tab only appears after a collector binary is detected (same detect-first model as GPU). */
export function shouldShowPortsTab(
  capabilities: SessionCapabilities | undefined,
): boolean {
  return (
    capabilities?.hasSs === true
    || capabilities?.hasNetstat === true
    || capabilities?.hasLsof === true
  );
}

/** Destructive port/service actions stay off for network appliances. */
export function allowSystemManagerMutations(
  host: Host | null | undefined,
): boolean {
  return !isNetworkDeviceTarget(host);
}

/** Services tab only appears after systemctl is detected. */
export function shouldShowServicesTab(
  capabilities: SessionCapabilities | undefined,
): boolean {
  return capabilities?.hasSystemctl === true;
}

export function shouldCollectServerStats(
  host: Host | null | undefined,
  capabilities: SessionCapabilities | undefined,
  _session: TerminalSession | null | undefined,
): boolean {
  const detectedDeviceClass = classifyDistroId(host?.distro);
  if (isNetworkDeviceTarget(host) || detectedDeviceClass === 'network-device') return false;
  if (capabilities?.targetOs && capabilities.targetOs !== 'unknown') {
    return capabilities.targetOs === 'linux' || capabilities.targetOs === 'darwin';
  }
  if (resolveHostOs(host) === 'linux' || resolveHostOs(host) === 'macos') return true;
  return false;
}

export function buildSystemManagerTabs(
  host: Host | null | undefined,
  capabilities: SessionCapabilities | undefined,
  session: TerminalSession | null | undefined,
): SystemManagerSubTab[] {
  const tabs: SystemManagerSubTab[] = ['overview'];
  if (shouldShowProcessesTab(host, capabilities)) tabs.push('processes');
  if (shouldShowPortsTab(capabilities)) tabs.push('ports');
  if (shouldShowServicesTab(capabilities)) tabs.push('services');
  if (shouldShowTmuxTab(host, capabilities, session)) tabs.push('tmux');
  if (shouldShowDockerTab(host, capabilities, session)) tabs.push('docker');
  if (shouldShowGpuTab(capabilities)) tabs.push('gpu');
  return tabs;
}
