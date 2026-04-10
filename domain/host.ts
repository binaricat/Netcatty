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

/**
 * Known network-device vendor IDs that Netcatty can detect from the SSH
 * server identification string. When a host is classified as one of these,
 * features that assume a POSIX shell (e.g. the periodic server stats poll)
 * are disabled, because the stats command would either be rejected outright
 * or generate one AAA session log per poll on the remote device.
 */
export const NETWORK_DEVICE_OPTIONS = [
  'cisco',
  'juniper',
  'huawei',
  'hpe',
  'mikrotik',
  'fortinet',
  'paloalto',
  'zyxel',
] as const;

export type NetworkDeviceVendor = typeof NETWORK_DEVICE_OPTIONS[number];

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
  // Network device vendor IDs may arrive here after detection — preserve them.
  if ((NETWORK_DEVICE_OPTIONS as readonly string[]).includes(v)) return v;
  if (v === 'linux' || v.includes('linux')) return 'linux';
  return '';
};

/**
 * Parse the SSH server identification string (the `software` portion of
 * `SSH-<protocol>-<software>\r\n`, exposed by ssh2 as `conn._remoteVer`)
 * and return a normalized network-device vendor ID, or '' if the ident
 * does not match a known vendor.
 *
 * Matching patterns are sourced from the Nmap nmap-service-probes
 * database (match lines beginning with `match ssh m|^SSH-`), cross-
 * referenced with the ssh-audit project's software.py and vendor docs.
 * Only rules whose pattern can be reproduced from those sources are
 * included here.
 *
 * Empty string means "use the fallback linux/macos detection path" —
 * that is what happens for OpenSSH, Dropbear, JUNOS, Cisco NX-OS, and
 * Arista EOS, all of which either are POSIX systems or present as
 * plain `OpenSSH_*` with no distinct vendor marker.
 */
export const detectVendorFromSshVersion = (softwareVersion?: string): '' | NetworkDeviceVendor => {
  const s = (softwareVersion || '').trim();
  if (!s) return '';

  // Cisco family — IOS, IOS XA, Wireless LAN Controller
  if (/^Cisco[-_]/i.test(s)) return 'cisco';
  if (/^CiscoIOS_/i.test(s)) return 'cisco';
  if (/^CISCO_WLC\b/.test(s)) return 'cisco';
  // Note: `IPSSH-*` is used by both Cisco and 3Com devices (per Nmap
  // `match ssh m|^SSH-([\d.]+)-IPSSH-([\d.]+)\|`), so we cannot map it
  // to a specific vendor icon from the banner alone. Users who want a
  // custom icon for such devices can set one via the Host Details
  // manual distro override. The stats-polling gate is still handled
  // correctly via `host.deviceType === 'network'`.

  // Juniper NetScreen firewall (JUNOS itself uses OpenSSH and is caught
  // by the fallback failure-counter path in useServerStats).
  if (/^NetScreen\b/.test(s)) return 'juniper';

  // Huawei VRP and related products
  if (/^HUAWEI[-_]/i.test(s)) return 'huawei';
  if (/^VRP-/i.test(s)) return 'huawei';

  // HPE / H3C — Comware switches, Integrated Lights-Out (iLO), legacy 3Com
  if (/^Comware-/i.test(s)) return 'hpe';
  if (/^3Com\s*OS/i.test(s)) return 'hpe';
  if (/^mpSSH_/i.test(s)) return 'hpe';

  // MikroTik RouterOS
  if (/^ROSSSH\b/.test(s)) return 'mikrotik';

  // Fortinet FortiOS / FortiGate
  if (/^FortiSSH_/i.test(s)) return 'fortinet';

  // Palo Alto Networks PAN-OS
  if (/^PaloAltoNetworks[_-]/i.test(s)) return 'paloalto';

  // ZyXEL ZyWALL
  if (/^Zyxel\s*SSH/i.test(s)) return 'zyxel';

  return '';
};

/**
 * Classify a distro/vendor ID into a high-level device class. Features that
 * assume a POSIX shell (periodic stats polling, /etc/os-release probing, etc.)
 * should only run when this returns `linux-like`.
 */
export type DeviceClass = 'linux-like' | 'network-device' | 'other';

export const classifyDistroId = (distroId?: string): DeviceClass => {
  const v = (distroId || '').toLowerCase().trim();
  if (!v) return 'other';
  if ((NETWORK_DEVICE_OPTIONS as readonly string[]).includes(v)) return 'network-device';
  if ((LINUX_DISTRO_OPTIONS as readonly string[]).includes(v)) return 'linux-like';
  return 'other';
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
