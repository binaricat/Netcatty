/* eslint-disable no-undef */
function createPathValidationApi(ctx) {
  with (ctx) {
    function getDefaultShell() {
      return getDefaultLocalShell();
    }
    
    /**
     * Validate a path - check if it exists and whether it's a file or directory
     * @param {object} event - IPC event
     * @param {object} payload - Contains { path: string, type?: 'file' | 'directory' | 'any' }
     * @returns {{ exists: boolean, isFile: boolean, isDirectory: boolean, isExecutable: boolean }}
     *
     * `isExecutable` mirrors isExecutableFile(): POSIX requires the file mode
     * to have an execute bit; Win32 treats any regular file as executable
     * (NTFS lacks POSIX bits — extension/PATHEXT decides at spawn time).
     * Existing callers ignore the new field; consumers that need exec
     * semantics (e.g. Mosh client path) read it explicitly.
     */
    function statIsExecutable(stat) {
      if (!stat || !stat.isFile()) return false;
      if (process.platform === "win32") return true;
      return (stat.mode & 0o111) !== 0;
    }
    
    function validatePath(event, payload) {
      const targetPath = payload?.path;
      const type = payload?.type || 'any';
      if (!targetPath) {
        return { exists: false, isFile: false, isDirectory: false, isExecutable: false };
      }
    
      try {
        // Resolve path (handle ~, etc.)
        let resolvedPath = expandHomePath(targetPath);
        resolvedPath = path.resolve(resolvedPath);
    
        if (fs.existsSync(resolvedPath)) {
          const stat = fs.statSync(resolvedPath);
          return {
            exists: true,
            isFile: stat.isFile(),
            isDirectory: stat.isDirectory(),
            isExecutable: statIsExecutable(stat),
          };
        }
    
        // If type is 'file' and path doesn't exist, try to resolve via PATH (for executables like cmd.exe, powershell.exe)
        if (type === 'file') {
          const resolvedExecutable = findExecutable(targetPath);
          // findExecutable returns the original name if not found, so check if it actually resolves to a real path
          if (resolvedExecutable !== targetPath && fs.existsSync(resolvedExecutable)) {
            const stat = fs.statSync(resolvedExecutable);
            return {
              exists: true,
              isFile: stat.isFile(),
              isDirectory: stat.isDirectory(),
              isExecutable: statIsExecutable(stat),
            };
          }
          // Also try with .exe extension on Windows if not already present
          if (process.platform === 'win32' && !targetPath.toLowerCase().endsWith('.exe')) {
            const withExe = findExecutable(targetPath + '.exe');
            if (withExe !== targetPath + '.exe' && fs.existsSync(withExe)) {
              const stat = fs.statSync(withExe);
              return {
                exists: true,
                isFile: stat.isFile(),
                isDirectory: stat.isDirectory(),
                isExecutable: statIsExecutable(stat),
              };
            }
          }
        }
    
        return { exists: false, isFile: false, isDirectory: false, isExecutable: false };
      } catch (err) {
        console.warn(`[Terminal] Error validating path "${targetPath}":`, err.message);
        return { exists: false, isFile: false, isDirectory: false, isExecutable: false };
      }
    }

    return { getDefaultShell, validatePath };
  }
}

module.exports = { createPathValidationApi };
