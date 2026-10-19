// Shared banner rules for renderer capabilities and headless SSH monitoring.
export const detectVendorFromSshVersion = (softwareVersion) => {
  const s = (softwareVersion || '').trim().replace(/^SSH-(?:2\.0|1\.99)-/i, '');
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
  if (s === '-') return 'huawei';
  if (/^HUAWEI[-_]/i.test(s)) return 'huawei';
  if (/^VRP-/i.test(s)) return 'huawei';

  // H3C / 3Com Comware switches
  if (/^H3C[-_\s]/i.test(s)) return 'h3c';
  if (/^Comware-/i.test(s)) return 'h3c';
  if (/^3Com\s*OS/i.test(s)) return 'h3c';

  // HPE iLO
  if (/^mpSSH_/i.test(s)) return 'hpe';

  // MikroTik RouterOS
  if (/^ROSSSH\b/.test(s)) return 'mikrotik';

  // Fortinet FortiOS / FortiGate
  if (/^FortiSSH_/i.test(s)) return 'fortinet';

  // Palo Alto Networks PAN-OS
  if (/^PaloAltoNetworks[_-]/i.test(s)) return 'paloalto';

  // ZyXEL ZyWALL
  if (/^Zyxel\s*SSH/i.test(s)) return 'zyxel';

  // Ruijie RGOS
  if (/^RGOS_SSH\b/i.test(s)) return 'ruijie';

  return '';
};
