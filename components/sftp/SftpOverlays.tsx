import React from "react";
import type { Host, SftpFileEntry } from "../../types";
import type { FileOpenerType, SystemAppInfo } from "../../lib/sftpFileUtils";
import type { useSftpState } from "../../application/state/useSftpState";
import type { HotkeyScheme, KeyBinding } from "../../domain/models";
import FileOpenerDialog from "../FileOpenerDialog";
import TextEditorModal from "../TextEditorModal";
import type { TextEditorModalSnapshot } from "../TextEditorModal";
import { SftpConflictDialog, SftpHostPicker, SftpPermissionsDialog } from "./index";
import { SftpTransferQueue } from "./SftpTransferQueue";

type SftpState = ReturnType<typeof useSftpState>;

interface SftpOverlaysProps {
  hosts: Host[];
  sftp: SftpState;
  visibleTransfers: SftpState["transfers"];
  showTransferQueue?: boolean;
  showHostPickerLeft: boolean;
  showHostPickerRight: boolean;
  hostSearchLeft: string;
  hostSearchRight: string;
  setShowHostPickerLeft: (open: boolean) => void;
  setShowHostPickerRight: (open: boolean) => void;
  setHostSearchLeft: (value: string) => void;
  setHostSearchRight: (value: string) => void;
  handleHostSelectLeft: (host: Host | "local") => void;
  handleHostSelectRight: (host: Host | "local") => void;
  permissionsState: { file: SftpFileEntry; side: "left" | "right"; fullPath: string } | null;
  setPermissionsState: (state: { file: SftpFileEntry; side: "left" | "right"; fullPath: string } | null) => void;
  showTextEditor: boolean;
  setShowTextEditor: (open: boolean) => void;
  textEditorTarget: { file: SftpFileEntry; side: "left" | "right"; fullPath: string } | null;
  setTextEditorTarget: (target: { file: SftpFileEntry; side: "left" | "right"; fullPath: string } | null) => void;
  textEditorContent: string;
  setTextEditorContent: (content: string) => void;
  handleSaveTextFile: (content: string) => Promise<void>;
  editorWordWrap: boolean;
  setEditorWordWrap: (enabled: boolean) => void;
  hotkeyScheme: HotkeyScheme;
  keyBindings: KeyBinding[];
  showFileOpenerDialog: boolean;
  setShowFileOpenerDialog: (open: boolean) => void;
  fileOpenerTarget: { file: SftpFileEntry; side: "left" | "right"; fullPath: string } | null;
  setFileOpenerTarget: (target: { file: SftpFileEntry; side: "left" | "right"; fullPath: string } | null) => void;
  handleFileOpenerSelect: (openerType: FileOpenerType, setAsDefault: boolean, systemApp?: SystemAppInfo) => void;
  handleSelectSystemApp: (systemApp: { path: string; name: string }) => void;
  onPromoteToTab?: (snapshot: TextEditorModalSnapshot) => void;
}

export const SftpOverlays: React.FC<SftpOverlaysProps> = React.memo(({
  hosts,
  sftp,
  visibleTransfers,
  showTransferQueue = true,
  showHostPickerLeft,
  showHostPickerRight,
  hostSearchLeft,
  hostSearchRight,
  setShowHostPickerLeft,
  setShowHostPickerRight,
  setHostSearchLeft,
  setHostSearchRight,
  handleHostSelectLeft,
  handleHostSelectRight,
  permissionsState,
  setPermissionsState,
  showTextEditor,
  setShowTextEditor,
  textEditorTarget,
  setTextEditorTarget,
  textEditorContent,
  setTextEditorContent,
  handleSaveTextFile,
  editorWordWrap,
  setEditorWordWrap,
  hotkeyScheme,
  keyBindings,
  showFileOpenerDialog,
  setShowFileOpenerDialog,
  fileOpenerTarget,
  setFileOpenerTarget,
  handleFileOpenerSelect,
  handleSelectSystemApp,
  onPromoteToTab,
}) => {
  return (
    <>
      {/* Host pickers for adding new tabs */}
      <SftpHostPicker
        open={showHostPickerLeft}
        onOpenChange={setShowHostPickerLeft}
        hosts={hosts}
        side="left"
        hostSearch={hostSearchLeft}
        onHostSearchChange={setHostSearchLeft}
        onSelectLocal={() => handleHostSelectLeft("local")}
        onSelectHost={handleHostSelectLeft}
      />
      <SftpHostPicker
        open={showHostPickerRight}
        onOpenChange={setShowHostPickerRight}
        hosts={hosts}
        side="right"
        hostSearch={hostSearchRight}
        onHostSearchChange={setHostSearchRight}
        onSelectLocal={() => handleHostSelectRight("local")}
        onSelectHost={handleHostSelectRight}
      />

      {showTransferQueue && (
        <SftpTransferQueue sftp={sftp} visibleTransfers={visibleTransfers} allTransfers={sftp.transfers} />
      )}

      <SftpConflictDialog
        conflicts={sftp.conflicts}
        onResolve={sftp.resolveConflict}
        formatFileSize={sftp.formatFileSize}
      />

      <SftpPermissionsDialog
        open={!!permissionsState}
        onOpenChange={(open) => !open && setPermissionsState(null)}
        file={permissionsState?.file ?? null}
        onSave={(_file, permissions) => {
          if (permissionsState) {
            sftp.changePermissions(
              permissionsState.side,
              permissionsState.fullPath,
              permissions,
            );
          }
          setPermissionsState(null);
        }}
      />

      {/* Text Editor Modal */}
      <TextEditorModal
        open={showTextEditor}
        onClose={() => {
          setShowTextEditor(false);
          setTextEditorTarget(null);
          setTextEditorContent("");
        }}
        fileName={textEditorTarget?.file.name || ""}
        initialContent={textEditorContent}
        onSave={handleSaveTextFile}
        editorWordWrap={editorWordWrap}
        onToggleWordWrap={() => setEditorWordWrap(!editorWordWrap)}
        hotkeyScheme={hotkeyScheme}
        keyBindings={keyBindings}
        onPromoteToTab={onPromoteToTab}
      />

      {/* File Opener Dialog */}
      <FileOpenerDialog
        open={showFileOpenerDialog}
        onClose={() => {
          setShowFileOpenerDialog(false);
          setFileOpenerTarget(null);
        }}
        fileName={fileOpenerTarget?.file.name || ""}
        onSelect={handleFileOpenerSelect}
        onSelectSystemApp={handleSelectSystemApp}
      />
    </>
  );
});
