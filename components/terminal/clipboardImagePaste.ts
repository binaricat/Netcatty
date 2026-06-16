const REMOTE_CLIPBOARD_IMAGE_DIR = ".netcatty-paste-images";

type ClipboardImageFile = {
  path: string;
  name: string;
  mediaType: string;
  size?: number;
};

type RemoteClipboardImageBridge = Pick<
  NetcattyBridge,
  "readClipboardImage" | "openSftpForSession" | "startStreamTransfer"
> & Pick<Partial<NetcattyBridge>, "closeSftp" | "deleteTempFile">;

type TerminalLike = {
  focus?: () => void;
};

type HandleRemoteClipboardImagePasteOptions = {
  bridge?: RemoteClipboardImageBridge;
  createTransferId?: () => string;
  getRemoteCwd: () => Promise<string | null | undefined>;
  scrollToBottomAfterProgrammaticInput?: (data: string) => void;
  sessionId: string | null | undefined;
  terminalBackend: {
    writeToSession: (sessionId: string, data: string, options?: { automated?: boolean }) => void;
  };
  term?: TerminalLike | null;
};

const shellSafePathPattern = /^[A-Za-z0-9_./~:@%+=,-]+$/;

export function sanitizeRemoteClipboardImageName(name: string): string {
  const fallback = "netcatty-paste.png";
  const trimmed = name.trim() || fallback;
  const sanitized = trimmed
    .replace(/[\0/\\]/g, "_")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return sanitized || fallback;
}

export function buildRemoteClipboardImagePath(cwd: string | null | undefined, fileName: string): string {
  const safeFileName = sanitizeRemoteClipboardImageName(fileName);
  const normalizedCwd = typeof cwd === "string" ? cwd.trim() : "";
  if (!normalizedCwd) return "";
  const base = normalizedCwd.replace(/\/+$/g, "") || "/";

  if (base === "/") {
    return `/${REMOTE_CLIPBOARD_IMAGE_DIR}/${safeFileName}`;
  }

  return `${base}/${REMOTE_CLIPBOARD_IMAGE_DIR}/${safeFileName}`;
}

export function quoteRemotePathForShell(remotePath: string): string {
  if (shellSafePathPattern.test(remotePath)) return remotePath;
  return `'${remotePath.replace(/'/g, "'\\''")}'`;
}

function defaultTransferId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `clipboard-image-${uuid}` : `clipboard-image-${Date.now()}`;
}

export async function handleRemoteClipboardImagePaste({
  bridge,
  createTransferId = defaultTransferId,
  getRemoteCwd,
  scrollToBottomAfterProgrammaticInput,
  sessionId,
  terminalBackend,
  term,
}: HandleRemoteClipboardImagePasteOptions): Promise<boolean> {
  if (!sessionId) return false;
  if (!bridge?.readClipboardImage || !bridge.openSftpForSession || !bridge.startStreamTransfer) {
    return false;
  }

  const image: ClipboardImageFile | null = await bridge.readClipboardImage();
  if (!image?.path || !image.name) return false;

  let sftpId: string | undefined;
  try {
    const remoteCwd = await getRemoteCwd();
    const targetPath = buildRemoteClipboardImagePath(remoteCwd, image.name);
    if (!targetPath) return false;
    const transferId = createTransferId();

    sftpId = await bridge.openSftpForSession(sessionId);
    const transferResult = await bridge.startStreamTransfer({
      transferId,
      sourcePath: image.path,
      targetPath,
      sourceType: "local",
      targetType: "sftp",
      targetSftpId: sftpId,
      totalBytes: image.size,
    });
    if (!transferResult || transferResult.error) return false;

    const pastedPath = quoteRemotePathForShell(targetPath);
    terminalBackend.writeToSession(sessionId, pastedPath);
    scrollToBottomAfterProgrammaticInput?.(pastedPath);
    term?.focus?.();
    return true;
  } finally {
    if (sftpId && bridge.closeSftp) {
      await bridge.closeSftp(sftpId).catch(() => undefined);
    }
    if (bridge.deleteTempFile) {
      await bridge.deleteTempFile(image.path).catch(() => undefined);
    }
  }
}
