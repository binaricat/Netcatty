import React from "react";
import type { KnownHost } from "../../domain/models";
import { usePortForwardHostKeyVerification } from "../../application/state/usePortForwardHostKeyVerification";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { TerminalHostKeyVerification } from "../terminal/TerminalHostKeyVerification";

interface PortForwardHostKeyDialogProps {
  onAddKnownHost?: (knownHost: KnownHost) => void;
}

export const PortForwardHostKeyDialog: React.FC<PortForwardHostKeyDialogProps> = ({
  onAddKnownHost,
}) => {
  const {
    hostKeyVerification,
    rejectHostKeyVerification,
    acceptHostKeyVerification,
    acceptAndSaveHostKeyVerification,
  } = usePortForwardHostKeyVerification(onAddKnownHost);

  return (
    <Dialog
      open={!!hostKeyVerification}
      onOpenChange={(open) => {
        if (!open) rejectHostKeyVerification();
      }}
    >
      <DialogContent
        className="w-[calc(100vw-1.5rem)] max-w-lg rounded-lg"
        overlayClassName="port-forward-host-key-dialog-layer"
        data-port-forward-host-key-dialog="true"
        hideCloseButton
      >
        <DialogTitle className="sr-only">Confirm host key</DialogTitle>
        {hostKeyVerification && (
          <TerminalHostKeyVerification
            hostKeyInfo={hostKeyVerification.hostKeyInfo}
            showLogs={false}
            progressLogs={[]}
            onClose={rejectHostKeyVerification}
            onContinue={acceptHostKeyVerification}
            onAddAndContinue={acceptAndSaveHostKeyVerification}
          />
        )}
      </DialogContent>
    </Dialog>
  );
};
