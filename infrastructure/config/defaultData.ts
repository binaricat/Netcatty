import { Host, Snippet } from '../../domain/models';

export const INITIAL_HOSTS: Host[] = [];

export const INITIAL_SNIPPETS: Snippet[] = [
  { id: '1', label: 'Check Disk Space', command: 'df -h', tags: [] },
  { id: '2', label: 'Tail System Log', command: 'tail -f /var/log/syslog', tags: [] },
  { id: '3', label: 'Update Ubuntu', command: 'sudo apt update && sudo apt upgrade -y', tags: [] },
];
