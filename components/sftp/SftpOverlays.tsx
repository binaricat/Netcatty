import React, { lazy, Suspense } from "react";
import type { Host, SftpFileEntry } from "../../types";
import type { FileOpenerType, SystemAppInfo } from "../../lib/sftpFileUtils";
import type { useSftpState } from "../../application/state/useSftpState";
import type { HotkeyScheme, KeyBinding } from "../../domain/models";
import type { TransferTask } from "../../types";
import FileOpenerDialog from "../FileOpenerDialog";
import type { TextEditorModalSnapshot } from "../TextEditorModal";
import { TerminalHostKeyVerification } from "../terminal/TerminalHostKeyVerification";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { LazyLoadBoundary } from "../ui/lazy-load-boundary";
import { SftpConflictDialog } from "./SftpConflictDialog";
import { SftpHostPicker } from "./SftpHostPicker";
import { SftpPermissionsDialog } from "./SftpPermissionsDialog";
import { SftpTransferQueue } from "./SftpTransferQueue";

const LazyTextEditorModal = lazy(() => import("../TextEditorModal"));

type SftpState = ReturnType<typeof useSftpState>;

const TextEditorModalLoading: React.FC<{
  open: boolean;
  fileName: string;
  onClose: () => void;
}> = ({ open, fileName, onClose }) => (
  <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
    <DialogContent className="max-w-5xl h-[85vh] flex flex-col p-0 gap-0 overflow-hidden">
      <DialogTitle className="sr-only">{fileName || "Text editor"}</DialogTitle>
      <div className="netcatty-lazy-fade-in h-full min-h-0" aria-hidden="true" />
    </DialogContent>
  </Dialog>
);

const TextEditorModalUnavailable: React.FC<{
  open: boolean;
  fileName: string;
  onClose: () => void;
}> = ({ open, fileName, onClose }) => (
  <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
    <DialogContent className="max-w-md">
      <DialogTitle>Text editor could not load.</DialogTitle>
      <div className="text-sm text-muted-foreground">
        {fileName ? `${fileName} cannot be opened until the editor reloads.` : "The editor needs to reload before it can open this file."}
      </div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          onClick={onClose}
        >
          Close
        </button>
        <button
          type="button"
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      </div>
    </DialogContent>
  </Dialog>
);

interface SftpOverlaysProps {
  hosts: Host[];
  sftp: SftpState;
  visibleTransfers: SftpState["transfers"];
  showTransferQueue?: boolean;
  canRevealTransferTarget?: (task: TransferTask) => boolean;
  onRevealTransferTarget?: (task: TransferTask) => void | Promise<void>;
  canCopyTransferTargetPath?: (task: TransferTask) => boolean;
  onCopyTransferTargetPath?: (task: TransferTask) => void | Promise<void>;
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
  onRequestTerminalFocus?: () => void;
}

export const SftpOverlays: React.FC<SftpOverlaysProps> = React.memo(({
  hosts,
  sftp,
  visibleTransfers,
  showTransferQueue = true,
  canRevealTransferTarget,
  onRevealTransferTarget,
  canCopyTransferTargetPath,
  onCopyTransferTargetPath,
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
  onRequestTerminalFocus,
}) => {
  const textEditorFileName = textEditorTarget?.file.name || "";
  const closeTextEditor = () => {
    setShowTextEditor(false);
    setTextEditorTarget(null);
    setTextEditorContent("");
    onRequestTerminalFocus?.();
  };

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
        <SftpTransferQueue
          sftp={sftp}
          visibleTransfers={visibleTransfers}
          allTransfers={sftp.transfers}
          canRevealTransferTarget={canRevealTransferTarget}
          onRevealTransferTarget={onRevealTransferTarget}
          canCopyTransferTargetPath={canCopyTransferTargetPath}
          onCopyTransferTargetPath={onCopyTransferTargetPath}
        />
      )}

      <SftpConflictDialog
        conflicts={sftp.conflicts}
        onResolve={sftp.resolveConflict}
        formatFileSize={sftp.formatFileSize}
      />

      <Dialog
        open={!!sftp.hostKeyVerification}
        onOpenChange={(open) => {
          if (!open) sftp.rejectHostKeyVerification();
        }}
      >
        <DialogContent className="max-w-lg" hideCloseButton>
          <DialogTitle className="sr-only">Confirm host key</DialogTitle>
          {sftp.hostKeyVerification && (
            <TerminalHostKeyVerification
              hostKeyInfo={sftp.hostKeyVerification.hostKeyInfo}
              showLogs={sftp.hostKeyVerification.progressLogs.length > 0}
              progressLogs={sftp.hostKeyVerification.progressLogs}
              onClose={sftp.rejectHostKeyVerification}
              onContinue={sftp.acceptHostKeyVerification}
              onAddAndContinue={sftp.acceptAndSaveHostKeyVerification}
            />
          )}
        </DialogContent>
      </Dialog>

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
      {showTextEditor && (
        <LazyLoadBoundary
          name="Text editor"
          resetKey={textEditorTarget?.fullPath || "text-editor"}
          fallback={
            <TextEditorModalUnavailable
              open={showTextEditor}
              fileName={textEditorFileName}
              onClose={closeTextEditor}
            />
          }
        >
          <Suspense
            fallback={
              <TextEditorModalLoading
                open={showTextEditor}
                fileName={textEditorFileName}
                onClose={closeTextEditor}
              />
            }
          >
            <LazyTextEditorModal
              open={showTextEditor}
              onClose={closeTextEditor}
              fileName={textEditorFileName}
              initialContent={textEditorContent}
              onSave={handleSaveTextFile}
              editorWordWrap={editorWordWrap}
              onToggleWordWrap={() => setEditorWordWrap(!editorWordWrap)}
              hotkeyScheme={hotkeyScheme}
              keyBindings={keyBindings}
              onPromoteToTab={onPromoteToTab}
            />
          </Suspense>
        </LazyLoadBoundary>
      )}

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
