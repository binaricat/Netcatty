import React from "react";
import { useI18n } from "../../application/i18n/I18nProvider";
import { useMonitorHostKeyVerification } from "../../application/state/useMonitorHostKeyVerification";
import { toHostKeyInfo } from "../../domain/hostKey";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { TerminalHostKeyVerification } from "../terminal/TerminalHostKeyVerification";
export function MonitorHostKeyDialog() {
  const { t } = useI18n();
  const { request, respond } = useMonitorHostKeyVerification();
  return (
    <Dialog open={!!request} onOpenChange={(open) => !open && respond(false)}>
      <DialogContent hideCloseButton>
        <DialogTitle className="sr-only">
          {t("monitor.confirmHost")}
        </DialogTitle>
        {request && (
          <TerminalHostKeyVerification
            hostKeyInfo={toHostKeyInfo(request)}
            showLogs={false}
            progressLogs={[]}
            onClose={() => respond(false)}
            onContinue={() => respond(true)}
            onAddAndContinue={() => respond(true, true)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
