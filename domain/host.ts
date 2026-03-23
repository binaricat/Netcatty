import { Host } from './models';

export const LINUX_DISTRO_OPTIONS = [
  'linux',
  'ubuntu',
  'debian',
  'centos',
  'rocky',
  'fedora',
  'arch',
  'alpine',
  'amazon',
  'opensuse',
  'redhat',
  'almalinux',
  'oracle',
  'kali',
] as const;

export const normalizeDistroId = (value?: string) => {
  const v = (value || '').toLowerCase().trim();
  if (!v) return '';
  if (v.includes('ubuntu')) return 'ubuntu';
  if (v.includes('debian')) return 'debian';
  if (v.includes('centos')) return 'centos';
  if (v.includes('rocky')) return 'rocky';
  if (v.includes('fedora')) return 'fedora';
  if (v.includes('arch') || v.includes('manjaro')) return 'arch';
  if (v.includes('alpine')) return 'alpine';
  if (v.includes('amzn') || v.includes('amazon') || v.includes('aws')) return 'amazon';
  if (v.includes('opensuse') || v.includes('suse') || v.includes('sles')) return 'opensuse';
  if (v.includes('red hat') || v.includes('redhat') || v.includes('rhel')) return 'redhat';
  if (v.includes('almalinux')) return 'almalinux';
  if (v.includes('oracle')) return 'oracle';
  if (v.includes('kali')) return 'kali';
  if (v === 'linux' || v.includes('linux')) return 'linux';
  return '';
};

export const getEffectiveHostDistro = (
  host?: Pick<Host, 'distro' | 'manualDistro' | 'distroMode'> | null,
) => {
  if (!host) return '';
  const detected = normalizeDistroId(host.distro);
  const manual = normalizeDistroId(host.manualDistro);
  if (host.distroMode === 'manual') return manual || detected;
  if (host.distroMode === 'auto') return detected;
  return detected;
};

/** Format hostname:port for display, wrapping IPv6 addresses in brackets. */
export const formatHostPort = (hostname: string, port?: number | null): string => {
  if (port == null) return hostname;
  const isIPv6 = hostname.includes(':') && !hostname.startsWith('[');
  const display = isIPv6 ? `[${hostname}]` : hostname;
  return `${display}:${port}`;
};

export const sanitizeHost = (host: Host): Host => {
  const cleanHostname = (host.hostname || '').split(/\s+/)[0];
  const cleanDistro = normalizeDistroId(host.distro);
  const cleanManualDistro = normalizeDistroId(host.manualDistro);
  const cleanDistroMode =
    host.distroMode === 'manual'
      ? 'manual'
      : host.distroMode === 'auto'
        ? 'auto'
        : undefined;
  return {
    ...host,
    hostname: cleanHostname,
    distro: cleanDistro,
    distroMode: cleanDistroMode,
    manualDistro: cleanManualDistro || undefined,
  };
};
