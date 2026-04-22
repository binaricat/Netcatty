import type { SftpFilenameEncoding } from "../../types";

export interface EditorSftpWrite {
  (
    connectionId: string,
    expectedHostId: string,
    filePath: string,
    content: string,
    filenameEncoding?: SftpFilenameEncoding,
  ): Promise<void>;
}

let writer: EditorSftpWrite | null = null;

export const registerEditorSftpWriter = (fn: EditorSftpWrite | null) => {
  writer = fn;
};

export const editorSftpWrite: EditorSftpWrite = async (...args) => {
  if (!writer) {
    throw new Error("SFTP editor bridge not registered — cannot save (no SFTP view mounted)");
  }
  return writer(...args);
};
