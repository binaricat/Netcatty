import { Host } from './models';

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
  if (v.includes('red hat') || v.includes('rhel')) return 'redhat';
  if (v.includes('oracle')) return 'oracle';
  if (v.includes('kali')) return 'kali';
  return '';
};

export const sanitizeHost = (host: Host): Host => {
  const cleanHostname = (host.hostname || '').split(/\s+/)[0];
  const cleanDistro = normalizeDistroId(host.distro);
  return { ...host, hostname: cleanHostname, distro: cleanDistro };
};
