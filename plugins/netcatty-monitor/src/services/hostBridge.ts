import type { JsonValue, PluginContext, VaultHostMetadata } from '@netcatty/plugin-sdk';
import type { MonitorHostRef, MonitorProbeResult } from '../domain/types';

export interface HostProbeOptions {
  hostBindingToken: string;
  protocol?: 'rdp' | 'vnc' | 'ssh';
  port?: number;
  timeoutMs?: number;
}

export interface HostExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated?: boolean;
  durationMs?: number;
  latencyMs: number | null;
  responseLatencyMs: number | null;
}

export interface HostExecOptions {
  hostBindingToken: string;
  command: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ResolvedHostBinding {
  hostBindingToken: string;
  status: 'available' | 'missing' | 'revoked';
  host?: MonitorHostRef;
}

export const MONITOR_WORKBENCH_VIEW_ID = 'com.binaricat.netcatty-monitor.workbench';

export interface ViewBadgePayload {
  count: number;
  tone: 'default' | 'info' | 'warning' | 'danger';
  tooltip?: string;
}

export interface MonitorHostBridge {
  readonly supportsHostExec: boolean;
  readonly supportsHostProbe: boolean;
  selectHosts(title: string): Promise<MonitorHostRef[]>;
  resolveHostBindings(tokens: readonly string[]): Promise<ResolvedHostBinding[]>;
  revokeHostBinding(token: string): Promise<boolean>;
  execHostCommand(options: HostExecOptions): Promise<HostExecResult>;
  probeHost(options: HostProbeOptions): Promise<MonitorProbeResult>;
  openHostSession(host: MonitorHostRef, mode: 'terminal' | 'sftp' | 'remoteDesktop'): Promise<boolean>;
  setViewBadge(badge: ViewBadgePayload | null): Promise<void>;
  confirmAction(options: { title: string; message?: string; confirmLabel?: string; destructive?: boolean }): Promise<boolean | null>;
  copyText(text: string, title: string): Promise<boolean>;
  saveJsonSnapshot(defaultName: string, payload: unknown): Promise<boolean>;
  saveMarkdownReport(defaultName: string, markdown: string): Promise<boolean>;
  loadStorage<T extends JsonValue>(key: string): Promise<T | undefined>;
  saveStorage(key: string, value: JsonValue): Promise<void>;
}

function mapVaultMetadata(token: string, meta: VaultHostMetadata | undefined): MonitorHostRef {
  const label = meta?.label?.trim() || meta?.hostname?.trim() || token.slice(0, 12);
  return {
    hostId: token,
    hostBindingToken: token,
    label,
    hostname: meta?.hostname,
    port: meta?.port,
    username: meta?.username,
    protocol: meta?.protocol ?? 'ssh',
    group: meta?.group,
    tags: Array.isArray(meta?.tags) ? [...meta.tags] : [],
    notes: meta?.notes,
    os: meta?.os,
  };
}

export function createMonitorHostBridge(context: PluginContext): MonitorHostBridge {
  return {
    get supportsHostExec() {
      return typeof context.vault.execHostCommand === 'function';
    },

    get supportsHostProbe() {
      return typeof context.vault.probeHost === 'function';
    },

    async selectHosts(title: string): Promise<MonitorHostRef[]> {
      const res = await context.vault.selectHosts({
        title,
        durable: true,
      });
      if (res.cancelled) return [];
      const hosts: MonitorHostRef[] = [];
      for (const item of res.hosts) {
        const token = item.hostBindingToken || item.target.handle;
        if (!token) continue;
        hosts.push(mapVaultMetadata(token, item.metadata));
      }
      return hosts;
    },

    async resolveHostBindings(tokens: readonly string[]): Promise<ResolvedHostBinding[]> {
      const unique = [...new Set(tokens.filter((t) => typeof t === 'string' && t.length > 0))].slice(0, 100);
      if (unique.length === 0 || typeof context.vault.resolveHostBindings !== 'function') return [];
      try {
        const res = await context.vault.resolveHostBindings({ hostBindingTokens: unique });
        return res.hosts.map((item) => ({
          hostBindingToken: item.hostBindingToken,
          status: item.status,
          host: item.status === 'available' ? mapVaultMetadata(item.hostBindingToken, item.metadata) : undefined,
        }));
      } catch (err) {
        context.logger.warn('Failed to resolve host bindings', { error: String(err) });
        return [];
      }
    },

    async revokeHostBinding(token: string): Promise<boolean> {
      if (!token || typeof context.vault.revokeHostBinding !== 'function') return false;
      try {
        const res = await context.vault.revokeHostBinding(token);
        return Boolean(res.revoked);
      } catch {
        return false;
      }
    },

    async execHostCommand(options: HostExecOptions): Promise<HostExecResult> {
      const res = await context.vault.execHostCommand({
        hostBindingToken: options.hostBindingToken,
        command: options.command,
        timeoutMs: options.timeoutMs ?? 10_000,
        maxOutputBytes: options.maxOutputBytes ?? 256 * 1024,
      });
      return {
        stdout: res.stdout,
        stderr: res.stderr,
        exitCode: res.exitCode,
        truncated: res.truncated,
        durationMs: res.durationMs,
        latencyMs: typeof res.latencyMs === 'number' && Number.isFinite(res.latencyMs) ? res.latencyMs : null,
        responseLatencyMs:
          typeof res.responseLatencyMs === 'number' && Number.isFinite(res.responseLatencyMs)
            ? res.responseLatencyMs
            : null,
      };
    },

    async probeHost(options: HostProbeOptions): Promise<MonitorProbeResult> {
      const res = await context.vault.probeHost({
        hostBindingToken: options.hostBindingToken,
        ...(options.protocol ? { protocol: options.protocol } : {}),
        ...(typeof options.port === 'number' ? { port: options.port } : {}),
        timeoutMs: options.timeoutMs ?? 5_000,
      });
      return {
        reachable: Boolean(res.reachable),
        protocol: res.protocol,
        port: res.port,
        rttMs: typeof res.rttMs === 'number' && Number.isFinite(res.rttMs) ? res.rttMs : null,
        bannerVerified: Boolean(res.bannerVerified),
        ...(res.bannerDetail ? { bannerDetail: res.bannerDetail } : {}),
        ...(res.error ? { error: res.error } : {}),
        checkedAt: res.checkedAt,
      };
    },

    async openHostSession(host: MonitorHostRef, mode: 'terminal' | 'sftp' | 'remoteDesktop'): Promise<boolean> {
      const token = host.hostBindingToken || host.hostId;
      try {
        const res = await context.vault.requestConnect({
          hostBindingToken: token,
          mode,
        });
        return !res.cancelled;
      } catch (err) {
        context.logger.warn('Failed to open host session', { mode, host: host.label, error: String(err) });
        return false;
      }
    },

    async setViewBadge(badge: ViewBadgePayload | null): Promise<void> {
      if (typeof context.views.setBadge !== 'function') return;
      try {
        if (!badge || badge.count <= 0) {
          await context.views.setBadge(MONITOR_WORKBENCH_VIEW_ID, null);
        } else {
          await context.views.setBadge({
            viewId: MONITOR_WORKBENCH_VIEW_ID,
            count: Math.min(999, Math.max(0, Math.trunc(badge.count))),
            tone: badge.tone,
            ...(badge.tooltip ? { tooltip: badge.tooltip.slice(0, 160) } : {}),
          });
        }
      } catch (err) {
        context.logger.debug('View badge update unavailable', { error: String(err) });
      }
    },

    async confirmAction(options: {
      title: string;
      message?: string;
      confirmLabel?: string;
      destructive?: boolean;
    }): Promise<boolean | null> {
      const uiAny = context.ui as unknown as {
        confirm?: (params: {
          title: string;
          message?: string;
          confirmLabel?: string;
          destructive?: boolean;
        }) => Promise<boolean>;
      };
      if (typeof uiAny.confirm !== 'function') return null;
      try {
        return Boolean(await uiAny.confirm(options));
      } catch {
        return null;
      }
    },

    async copyText(text: string, title: string): Promise<boolean> {
      try {
        return await context.clipboard.writeText(text, title);
      } catch {
        return false;
      }
    },

    async saveJsonSnapshot(defaultName: string, payload: unknown): Promise<boolean> {
      try {
        const res = await context.ui.saveFile({
          title: 'Export Monitor Snapshot',
          defaultName,
          filters: [{ name: 'JSON', extensions: ['json'] }],
          data: JSON.stringify(payload, null, 2),
          encoding: 'utf8',
        });
        return !res.cancelled;
      } catch {
        return false;
      }
    },

    async saveMarkdownReport(defaultName: string, markdown: string): Promise<boolean> {
      try {
        const res = await context.ui.saveFile({
          title: 'Export Diagnostics Report (Markdown)',
          defaultName,
          filters: [{ name: 'Markdown', extensions: ['md'] }],
          data: markdown,
          encoding: 'utf8',
        });
        return !res.cancelled;
      } catch {
        return false;
      }
    },

    async loadStorage<T extends JsonValue>(key: string): Promise<T | undefined> {
      try {
        return await context.storage.get<T>(key);
      } catch {
        return undefined;
      }
    },

    async saveStorage(key: string, value: JsonValue): Promise<void> {
      try {
        await context.storage.set(key, value);
      } catch (err) {
        context.logger.warn('Failed to persist monitor storage key', { key, error: String(err) });
      }
    },
  };
}
