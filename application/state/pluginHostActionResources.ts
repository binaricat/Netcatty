import type { Host } from '../../domain/models';

/** Renderer-local revisions track replacement as well as visible edits. They
 * are never authorization handles; only the main-process authority issues one. */
export class PluginHostActionResources {
  private entries = new Map<string, { host: Host; revision: string }>();

  observe(hosts: readonly Host[]) {
    const next = new Map<string, { host: Host; revision: string }>();
    for (const host of hosts) {
      const existing = this.entries.get(host.id);
      next.set(host.id, existing?.host === host ? existing : { host, revision: crypto.randomUUID() });
    }
    this.entries = next;
  }

  resolve(id: string, expectedRevision: string): Host {
    const entry = this.entries.get(id);
    if (!entry || entry.revision !== expectedRevision) throw new Error('Selected host changed; select it again');
    return entry.host;
  }

  metadata(id: string) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Selected host is unavailable');
    const host = entry.host;
    const osValue = typeof host.os === 'string'
      ? Array.from(host.os).filter((ch) => {
        const code = ch.charCodeAt(0);
        return code >= 0x20 && code !== 0x7f;
      }).join('').slice(0, 128)
      : '';
    const notesValue = typeof host.notes === 'string'
      ? host.notes.split('\0').join('').slice(0, 4096)
      : '';
    return {
      resourceId: host.id, revision: entry.revision,
      label: host.label, hostname: host.hostname, username: host.username,
      ...(host.port === undefined ? {} : { port: host.port }), protocol: host.protocol ?? 'ssh',
      group: host.group ?? '', tags: [...host.tags],
      ...(osValue ? { os: osValue } : {}),
      ...(notesValue ? { notes: notesValue } : {}),
    };
  }
}
