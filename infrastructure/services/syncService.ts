import { Host, SSHKey, Snippet } from '../../domain/models';

interface BackupData {
  hosts: Host[];
  keys: SSHKey[];
  snippets: Snippet[];
  customGroups: string[];
  timestamp: number;
  version: number;
}

export const syncToGist = async (token: string, gistId: string | undefined, data: Omit<BackupData, 'timestamp' | 'version'>): Promise<string> => {
  const payload = {
    description: "netcatty SSH Config Backup",
    public: false,
    files: {
      "nebula-config.json": {
        content: JSON.stringify({ ...data, timestamp: Date.now(), version: 1 }, null, 2)
      }
    }
  };

  const url = gistId 
    ? `https://api.github.com/gists/${gistId}` 
    : `https://api.github.com/gists`;

  const method = gistId ? 'PATCH' : 'POST';

  const response = await fetch(url, {
    method,
    headers: {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Failed to sync: ${response.statusText}`);
  }

  const result = await response.json();
  return result.id;
};

export const loadFromGist = async (token: string, gistId: string): Promise<BackupData> => {
  const response = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load: ${response.statusText}`);
  }

  const result = await response.json();
  const file = result.files["nebula-config.json"];

  if (!file || !file.content) {
    throw new Error("Invalid Gist format: nebula-config.json not found");
  }

  return JSON.parse(file.content);
};
