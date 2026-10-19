import type { Host, Identity, KnownHost, SSHKey, TerminalSettings } from '../domain/models';
import { netcattyBridge } from '../infrastructure/services/netcattyBridge';
import { startPortForward } from '../infrastructure/services/portForwardingService';
import { requestHostBrowserPanel } from './state/hostBrowserPanelRequests';
import { isValidHslToken } from './state/settingsStateDefaults';

interface OpenHostBrowserOptions {
  host: Host;
  sessionId?: string;
  hosts: Host[];
  keys: SSHKey[];
  identities: Identity[];
  knownHosts?: KnownHost[];
  terminalSettings?: Pick<TerminalSettings, 'verifyHostKeys' | 'keepaliveInterval' | 'keepaliveCountMax'>;
}

const pendingOpens = new Map<string, Promise<void>>();
const browserThemeTokens = ['background', 'foreground', 'secondary', 'muted', 'muted-foreground', 'border', 'primary', 'primary-foreground'] as const;

export function currentBrowserThemeTokens(element: Element = document.documentElement): Record<string, string> {
  const style = getComputedStyle(element);
  return Object.fromEntries(browserThemeTokens.flatMap((token) => {
    const value = style.getPropertyValue(`--${token}`).trim();
    return isValidHslToken(value) ? [[token, value]] : [];
  }));
}

export async function openHostBrowser(options: OpenHostBrowserOptions): Promise<void> {
  requestHostBrowserPanel({ host: options.host, sessionId: options.sessionId });
}

export async function openHostBrowserPanelUrl(browserId: string, url: string): Promise<void> {
  const bridge = netcattyBridge.get();
  if (!bridge?.openHostBrowserUrl) throw new Error('The host browser is unavailable in this build');
  await bridge.openHostBrowserUrl({ browserId, url });
}

export function mountHostBrowser(options: OpenHostBrowserOptions & { browserId: string }): Promise<void> {
  const { host, hosts, keys, identities, knownHosts, terminalSettings } = options;
  const existing = pendingOpens.get(options.browserId);
  if (existing) return existing;
  const opening = (async () => {
    const bridge = netcattyBridge.get();
    if (!bridge?.setHostBrowserPanelLayout || !bridge.openHostBrowser || !bridge.startPortForward) {
      throw new Error('The host browser is unavailable in this build');
    }
    const local = host.protocol === 'local';
    const result = local ? { success: true, connectionOptions: undefined } : await startPortForward({
        id: `host-browser-${crypto.randomUUID()}`,
        label: `Browser: ${host.label || host.hostname}`,
        type: 'dynamic',
        hostId: host.id,
        localPort: 0,
        bindAddress: '127.0.0.1',
        status: 'inactive',
        createdAt: Date.now(),
    }, host, hosts, keys, identities, () => {}, false, terminalSettings,
    knownHosts, { dedicatedTransport: true, prepareOnly: true });
    if (!result.success || (!local && !result.connectionOptions)) {
      throw new Error(result.error || 'Could not prepare the browser connection');
    }
    await bridge.openHostBrowser({
      browserId: options.browserId,
      embedded: true,
      local,
      hostId: host.id,
      label: host.label || host.hostname,
      theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
      themeTokens: currentBrowserThemeTokens(),
      connectionOptions: result.connectionOptions,
    });
  })();
  pendingOpens.set(options.browserId, opening);
  void opening.finally(() => {
    if (pendingOpens.get(options.browserId) === opening) pendingOpens.delete(options.browserId);
  }).catch(() => {});
  return opening;
}
