import { Host, Snippet } from '../../domain/models';

export const INITIAL_HOSTS: Host[] = [
  { id: '1', label: 'Production Web', hostname: '10.0.0.12', port: 22, username: 'ubuntu', group: 'AWS/Production', tags: ['prod', 'web'], os: 'linux' },
  { id: '2', label: 'DB Master', hostname: 'db-01.internal', port: 22, username: 'admin', group: 'AWS/Production', tags: ['prod', 'db'], os: 'linux' },
];

export const INITIAL_SNIPPETS: Snippet[] = [
  { id: '1', label: 'Check Disk Space', command: 'df -h', tags: [] },
  { id: '2', label: 'Tail System Log', command: 'tail -f /var/log/syslog', tags: [] },
  { id: '3', label: 'Update Ubuntu', command: 'sudo apt update && sudo apt upgrade -y', tags: [] },
];
