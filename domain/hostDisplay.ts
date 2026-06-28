import type { Host } from './models';

export function hostDisplayTitle(host: Pick<Host, 'label' | 'hostname'>): string {
  return host.label?.trim() || host.hostname;
}
