const ELECTRON_INVOKE_PREFIX = /^error invoking remote method '[^']+': error:\s*/i;

/** ssh2 / Node / SCP absence kinds. Must not search the whole message: paths are user-controlled. */
const ABSENCE_KIND = /^(?:enoent|no such file(?: or directory)?|no_such_file|ssh_fx_no_such_file)(?:\b|:|$)/;

const unwrapStatErrorMessage = (message: string): string =>
  message.replace(ELECTRON_INVOKE_PREFIX, "").trim();

/** True absence only — ENOTSUP / unknown inspection must not map to "no conflict". */
export const isMissingStatError = (error: unknown): boolean => {
  const code = (error as { code?: string | number } | null)?.code;
  if (
    code === 2
    || code === "ENOENT"
    || code === "NO_SUCH_FILE"
    || code === "SSH_FX_NO_SUCH_FILE"
  ) {
    return true;
  }

  const message = String((error as { message?: string } | null)?.message || "")
    .trim()
    .toLowerCase();
  if (!message) return false;

  // ssh2 StatusCodeError is "No such file". ipcRenderer.invoke strips `code`
  // and wraps it as:
  // Error invoking remote method 'netcatty:sftp:lstat': Error: No such file
  return ABSENCE_KIND.test(unwrapStatErrorMessage(message));
};
