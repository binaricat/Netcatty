import { classifyDistroId, getEffectiveHostDistro, normalizeDistroId } from '../host';
import type { Host } from '../models/connection';
import type { TerminalSession } from '../../types';
import type { SessionCapabilities, SystemManagerSubTab } from './types';

const hasKnownUnsupportedSystemDistro = (host: Host | null | undefined): boolean => {
  const detectedDistro = normalizeDistroId(host?.distro);
  return !!detectedDistro && classifyDistroId(detectedDistro) === 'other';
};

export function isDefiniteLinuxTarget(
  host: Host | null | undefined,
  capabilities: SessionCapabilities | undefined,
  session: TerminalSession | null | undefined,
): boolean {
  if (capabilities?.targetOs === 'linux') return true;
  if (host?.deviceType === 'network') return false;
  if (hasKnownUnsupportedSystemDistro(host)) return false;
  if (host?.os === 'linux') return true;
  if (classifyDistroId(getEffectiveHostDistro(host)) === 'linux-like') return true;
  if (session?.protocol === 'local' && host?.os === 'linux') return true;
  return false;
}

export function shouldShowTmuxTab(
  host: Host | null | undefined,
  capabilities: SessionCapabilities | undefined,
  session: TerminalSession | null | undefined,
): boolean {
  if (isDefiniteLinuxTarget(host, capabilities, session)) return true;
  if (capabilities?.targetOs === 'darwin') return true;
  if (host?.os === 'macos') return true;
  return false;
}

export function shouldShowDockerTab(
  host: Host | null | undefined,
  capabilities: SessionCapabilities | undefined,
  session: TerminalSession | null | undefined,
): boolean {
  if (capabilities?.hasDocker === true) return true;
  return isDefiniteLinuxTarget(host, capabilities, session);
}

export function shouldCollectServerStats(
  host: Host | null | undefined,
  capabilities: SessionCapabilities | undefined,
  session: TerminalSession | null | undefined,
): boolean {
  const detectedDeviceClass = classifyDistroId(host?.distro);
  if (host?.deviceType === 'network' || detectedDeviceClass === 'network-device') return false;
  if (capabilities?.targetOs === 'linux' || capabilities?.targetOs === 'darwin') return true;
  if (hasKnownUnsupportedSystemDistro(host)) return false;
  if (host?.os === 'linux' || host?.os === 'macos') return true;
  if (detectedDeviceClass === 'linux-like') return true;
  if (session?.protocol === 'local' && host?.os === 'linux') return true;
  return false;
}

export function buildSystemManagerTabs(
  host: Host | null | undefined,
  capabilities: SessionCapabilities | undefined,
  session: TerminalSession | null | undefined,
): SystemManagerSubTab[] {
  const tabs: SystemManagerSubTab[] = ['overview', 'processes'];
  if (shouldShowTmuxTab(host, capabilities, session)) tabs.push('tmux');
  if (shouldShowDockerTab(host, capabilities, session)) tabs.push('docker');
  return tabs;
}
