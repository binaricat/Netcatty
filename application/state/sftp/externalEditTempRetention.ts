/**
 * Renderer-side retainers for remote temps opened in external editors.
 * closeSftp deletes those files; forget matching retainers so park/auto-connect
 * checks do not keep treating a deleted temp as active work.
 */
export type ExternalEditTempRetention = {
  remember(sftpId: string, localPath: string): boolean;
  forgetPath(localPath: string): boolean;
  forgetSftp(sftpId: string): boolean;
  clear(): boolean;
  readonly size: number;
};

export function createExternalEditTempRetention(): ExternalEditTempRetention {
  const bySftp = new Map<string, Set<string>>();

  const recount = (): number => {
    let total = 0;
    for (const paths of bySftp.values()) total += paths.size;
    return total;
  };

  return {
    remember(sftpId, localPath) {
      if (!sftpId || !localPath) return false;
      let paths = bySftp.get(sftpId);
      if (!paths) {
        paths = new Set();
        bySftp.set(sftpId, paths);
      }
      if (paths.has(localPath)) return false;
      paths.add(localPath);
      return true;
    },
    forgetPath(localPath) {
      if (!localPath) return false;
      let changed = false;
      for (const [sftpId, paths] of bySftp) {
        if (!paths.delete(localPath)) continue;
        changed = true;
        if (paths.size === 0) bySftp.delete(sftpId);
      }
      return changed;
    },
    forgetSftp(sftpId) {
      if (!sftpId || !bySftp.has(sftpId)) return false;
      bySftp.delete(sftpId);
      return true;
    },
    clear() {
      if (bySftp.size === 0) return false;
      bySftp.clear();
      return true;
    },
    get size() {
      return recount();
    },
  };
}
